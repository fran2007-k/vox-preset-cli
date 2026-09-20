#!/usr/bin/env node
'use strict';

/**
 * Simple local web GUI for vox-preset-cli: browse the JSON presets in
 * ../presets, write one to a slot, or dump a slot as a new preset file.
 * Not a full knob-by-knob editor -- that's what the vox-amp-librarian
 * browser app already does well -- but Current Rig does have a couple of
 * direct single-knob live controls (currently just Volume) for quick
 * adjustments without needing a whole preset file.
 *
 * All actual MIDI I/O happens here in Node (via @julusian/midi, same as the
 * CLI) -- the browser page never touches MIDI directly, so there's no
 * WebMIDI permission dance and no extra dependency in the frontend.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const protocol = require('../lib/protocol');
const { openAmpPorts, sendAndAwaitResponse, sendAndAwaitAck } = require('../lib/midi');

const PRESETS_DIR = path.join(__dirname, '..', 'presets');
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = process.env.PORT || 4242;

function listPresetFiles() {
  const files = fs.readdirSync(PRESETS_DIR).filter((f) => f.endsWith('.json'));
  return files.map((file) => {
    try {
      const preset = JSON.parse(fs.readFileSync(path.join(PRESETS_DIR, file), 'utf8'));
      return {
        file,
        programName: preset.programName || '(unnamed)',
        targetSlot: preset.targetSlot || null,
        amplifier: preset.amplifier ? preset.amplifier.model : null,
        pedal1: preset.pedal1 ? `${preset.pedal1.type}${preset.pedal1.enabled ? '' : ' (off)'}` : null,
        pedal2: preset.pedal2 ? `${preset.pedal2.type}${preset.pedal2.enabled ? '' : ' (off)'}` : null,
        reverb: preset.reverb ? `${preset.reverb.type}${preset.reverb.enabled ? '' : ' (off)'}` : null,
      };
    } catch (err) {
      return { file, error: err.message };
    }
  });
}

function checkPorts() {
  const midi = require('@julusian/midi');
  const input = new midi.Input();
  const output = new midi.Output();
  const inNames = [];
  for (let i = 0; i < input.getPortCount(); i++) inNames.push(input.getPortName(i));
  const outNames = [];
  for (let i = 0; i < output.getPortCount(); i++) outNames.push(output.getPortName(i));
  const connected = inNames.some((n) => n.includes('Valvetronix')) && outNames.some((n) => n.includes('Valvetronix'));
  return { connected, inputs: inNames, outputs: outNames };
}

/**
 * Encodes+decodes a preset with zero MIDI I/O -- no port is opened, so this
 * works even with the amp unplugged/off, and touches nothing on the
 * hardware. Same thing apply-preset.js's `write --dry-run` does.
 */
function doPreview(fileName) {
  const filePath = path.join(PRESETS_DIR, fileName);
  if (!filePath.startsWith(PRESETS_DIR)) throw new Error('invalid file');
  const preset = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const programBytes = protocol.encodeProgram(preset);
  return protocol.decodeProgram(programBytes);
}

async function doWrite(fileName, slotOverride) {
  const filePath = path.join(PRESETS_DIR, fileName);
  if (!filePath.startsWith(PRESETS_DIR)) throw new Error('invalid file');
  const preset = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const slot = slotOverride || preset.targetSlot;
  if (!slot) throw new Error('No target slot given and preset has no "targetSlot".');

  const programBytes = protocol.encodeProgram(preset);
  const writeMessage = protocol.buildWriteUserProgramMessage(slot, programBytes);
  const persistMessage = protocol.buildPersistUserProgramMessage(slot);

  const ports = openAmpPorts();
  try {
    await sendAndAwaitAck(ports, writeMessage, protocol.isAck);
    await sendAndAwaitAck(ports, persistMessage, protocol.isAck);
  } finally {
    ports.close();
  }

  return { slot, programName: preset.programName || '(unnamed)' };
}

/**
 * Makes the amp sound like the preset RIGHT NOW (whatever slot is
 * currently active), via the same live "dial turned" messages the amp's
 * own physical knobs send -- nothing is written to any slot. This is the
 * "Current Rig" action: hear a preset without committing it anywhere.
 */
async function doPlay(fileName) {
  const filePath = path.join(PRESETS_DIR, fileName);
  if (!filePath.startsWith(PRESETS_DIR)) throw new Error('invalid file');
  const preset = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const messages = protocol.buildLiveApplyMessages(preset);

  const ports = openAmpPorts();
  const failed = [];
  try {
    for (const { label, message } of messages) {
      try {
        await sendAndAwaitAck(ports, message, protocol.isAck, 800);
      } catch (err) {
        failed.push(label);
      }
    }
  } finally {
    ports.close();
  }

  const effectiveVolume = { ...protocol.AMP_DEFAULTS, ...(preset.amplifier || {}) }.volume;

  return { programName: preset.programName || '(unnamed)', messageCount: messages.length, failed, volume: effectiveVolume };
}

/**
 * Sets a single amp field (e.g. Volume) live, right now, on whatever slot
 * is currently active -- no preset file involved. Same underlying
 * mechanism as doPlay, just one dial instead of a whole preset's worth.
 */
async function doSetAmpDial(key, value) {
  const message = protocol.buildAmpDialLiveMessage(key, value);
  const ports = openAmpPorts();
  try {
    await sendAndAwaitAck(ports, message, protocol.isAck, 800);
  } finally {
    ports.close();
  }
  return { key, value };
}

/**
 * Reads the amp's actual current live state and returns just its Volume,
 * so the GUI's knob/slider can start at the real value instead of always
 * defaulting to 5.0. Callers should treat any failure here (amp off,
 * unplugged, another client connected) as "leave it at the default" --
 * not an error worth alarming the user over, since "not connected yet" is
 * a completely normal state on page load.
 */
async function doGetCurrentVolume() {
  const ports = openAmpPorts();
  try {
    const requestMessage = protocol.buildRequestCurrentProgramMessage();
    const response = await sendAndAwaitResponse(ports, requestMessage, 1500);
    const payload = response.slice(2, -1);
    const expectedPrefix = [0x30, 0x00, 0x01, 0x34, 0x40, 0x00];
    const prefixMatches = expectedPrefix.every((b, i) => payload[i] === b);
    if (!prefixMatches) throw new Error('Unexpected response from amp.');
    const programBytes = Buffer.from(payload.slice(6));
    if (programBytes.length !== 0x46) throw new Error(`Expected 70 bytes, got ${programBytes.length}.`);
    const decoded = protocol.decodeProgram(programBytes);
    return { volume: decoded.amplifier.volume };
  } finally {
    ports.close();
  }
}

async function doDump(slot, saveAsFileName) {
  const ports = openAmpPorts();
  let programBytes;
  try {
    const requestMessage = protocol.buildRequestUserProgramMessage(slot);
    const response = await sendAndAwaitResponse(ports, requestMessage);
    const payload = response.slice(2, -1);
    const expectedPrefix = [0x30, 0x00, 0x01, 0x34, 0x4c, 0x00];
    const prefixMatches = expectedPrefix.every((b, i) => payload[i] === b);
    if (!prefixMatches) throw new Error('Unexpected response from amp.');
    programBytes = Buffer.from(payload.slice(8));
    if (programBytes.length !== 0x46) throw new Error(`Expected 70 bytes, got ${programBytes.length}.`);
  } finally {
    ports.close();
  }

  const preset = protocol.decodeProgramToPresetInput(programBytes, slot);

  if (saveAsFileName) {
    const safeName = saveAsFileName.replace(/[^a-zA-Z0-9._-]/g, '_');
    const fileName = safeName.endsWith('.json') ? safeName : `${safeName}.json`;
    fs.writeFileSync(path.join(PRESETS_DIR, fileName), JSON.stringify(preset, null, 2) + '\n');
    return { saved: fileName, preset };
  }

  return { saved: null, preset };
}

const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' };

function serveStatic(req, res) {
  const urlPath = req.url === '/' ? '/index.html' : req.url;
  const filePath = path.join(PUBLIC_DIR, urlPath);
  if (!filePath.startsWith(PUBLIC_DIR) || !fs.existsSync(filePath)) {
    res.writeHead(404).end('Not found');
    return;
  }
  const ext = path.extname(filePath);
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch (err) { reject(err); }
    });
    req.on('error', reject);
  });
}

async function handleApi(req, res) {
  res.setHeader('Content-Type', 'application/json');
  try {
    if (req.method === 'GET' && req.url === '/api/presets') {
      res.end(JSON.stringify(listPresetFiles()));
      return;
    }

    if (req.method === 'GET' && req.url === '/api/status') {
      res.end(JSON.stringify(checkPorts()));
      return;
    }

    if (req.method === 'GET' && req.url === '/api/current-volume') {
      const result = await doGetCurrentVolume();
      res.end(JSON.stringify({ ok: true, result }));
      return;
    }

    if (req.method === 'POST' && req.url === '/api/preview') {
      const body = await readJsonBody(req);
      const result = doPreview(body.file);
      res.end(JSON.stringify({ ok: true, result }));
      return;
    }

    if (req.method === 'POST' && req.url === '/api/play') {
      const body = await readJsonBody(req);
      const result = await doPlay(body.file);
      res.end(JSON.stringify({ ok: true, result }));
      return;
    }

    if (req.method === 'POST' && req.url === '/api/live-dial') {
      const body = await readJsonBody(req);
      const result = await doSetAmpDial(body.key, body.value);
      res.end(JSON.stringify({ ok: true, result }));
      return;
    }

    if (req.method === 'POST' && req.url === '/api/write') {
      const body = await readJsonBody(req);
      const result = await doWrite(body.file, body.slot);
      res.end(JSON.stringify({ ok: true, result }));
      return;
    }

    if (req.method === 'POST' && req.url === '/api/dump') {
      const body = await readJsonBody(req);
      const result = await doDump(body.slot, body.saveAs);
      res.end(JSON.stringify({ ok: true, result }));
      return;
    }

    res.writeHead(404).end(JSON.stringify({ ok: false, error: 'Unknown endpoint' }));
  } catch (err) {
    res.writeHead(500).end(JSON.stringify({ ok: false, error: err.message }));
  }
}

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/api/')) {
    handleApi(req, res);
  } else {
    serveStatic(req, res);
  }
});

server.listen(PORT, () => {
  console.log(`vox-preset-cli GUI running at http://localhost:${PORT}`);
  console.log('Make sure nothing else (the librarian browser tab, VOX Tone Room) holds the MIDI connection.');
});
