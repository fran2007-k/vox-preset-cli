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

// Shared by doPlay and doWrite (both apply a preset live and report what a
// caller needs to re-sync Volume + the Live Pedal cards without a separate
// amp round-trip). Fallback defaults match buildLiveApplyMessages's own,
// for a slot the preset leaves out entirely.
function presetLiveSummary(preset) {
  return {
    volume: { ...protocol.AMP_DEFAULTS, ...(preset.amplifier || {}) }.volume,
    pedal1: preset.pedal1 || { type: 'COMP', enabled: false },
    pedal2: preset.pedal2 || { type: 'FLANGER', enabled: false },
    reverb: preset.reverb || { type: 'ROOM', enabled: false },
  };
}

/** Sends each live message, tolerating the handful of fields known not to accept live updates at all (see README). Returns their labels. */
async function applyLiveMessages(ports, messages) {
  const failed = [];
  for (const { label, message } of messages) {
    try {
      await sendAndAwaitAck(ports, message, protocol.isAck, 800);
    } catch (err) {
      failed.push(label);
    }
  }
  return failed;
}

/**
 * Persists the preset into a slot AND makes the amp sound like it right
 * now, via the same live "dial turned" messages doPlay uses -- otherwise
 * writing would only ever touch a slot's stored memory, never the amp's
 * actual active buffer, and the Live Pedal cards / Current Rig would have
 * nothing real to sync themselves from afterward. In practice this is
 * usually a no-op sound-wise (the established workflow is play-then-write,
 * so the amp's already sounding like this), but it also covers writing a
 * preset that was never auditioned first, or dumped from elsewhere.
 */
async function doWrite(fileName, slotOverride) {
  const filePath = path.join(PRESETS_DIR, fileName);
  if (!filePath.startsWith(PRESETS_DIR)) throw new Error('invalid file');
  const preset = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const slot = slotOverride || preset.targetSlot;
  if (!slot) throw new Error('No target slot given and preset has no "targetSlot".');

  const programBytes = protocol.encodeProgram(preset);
  const writeMessage = protocol.buildWriteUserProgramMessage(slot, programBytes);
  const persistMessage = protocol.buildPersistUserProgramMessage(slot);
  const liveMessages = protocol.buildLiveApplyMessages(preset);

  const ports = openAmpPorts();
  let failed;
  try {
    await sendAndAwaitAck(ports, writeMessage, protocol.isAck);
    await sendAndAwaitAck(ports, persistMessage, protocol.isAck);
    failed = await applyLiveMessages(ports, liveMessages);
  } finally {
    ports.close();
  }

  return { slot, programName: preset.programName || '(unnamed)', failed, ...presetLiveSummary(preset) };
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
  let failed;
  try {
    failed = await applyLiveMessages(ports, messages);
  } finally {
    ports.close();
  }

  return { programName: preset.programName || '(unnamed)', messageCount: messages.length, failed, ...presetLiveSummary(preset) };
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

// Which "kind" each pedal1/pedal2 type counts as for the Live Pedal cards'
// per-kind coloring (COMPRESSOR / DRIVE / MODULATION / DELAY / REVERB --
// same convention as the ModularModeling project's stompbox cards). Reverb
// only ever has one kind; pedal1/pedal2 vary by which type is selected.
const PEDAL1_KIND_BY_TYPE = {
  COMP: 'compressor',
  CHORUS: 'modulation',
  OVERDRIVE: 'drive', GOLD_DRIVE: 'drive', TREBLE_BOOST: 'drive', RC_TURBO: 'drive',
  ORANGE_DIST: 'drive', FAT_DIST: 'drive', BRIT_LEAD: 'drive', FUZZ: 'drive',
};
const PEDAL2_KIND_BY_TYPE = {
  FLANGER: 'modulation', BLK_PHASER: 'modulation', ORG_PHASER_1: 'modulation',
  ORG_PHASER_2: 'modulation', TREMOLO: 'modulation',
  TAPE_ECHO: 'delay', ANALOG_DELAY: 'delay',
};

/**
 * Static metadata the Live Pedal cards need to render themselves generically
 * (type choices, per-type param specs with kind/default/min/max/choices, and
 * a UI "kind" for coloring) instead of duplicating protocol.js's tables in
 * the frontend. Doesn't touch MIDI -- safe to call with the amp off.
 */
function getPedalSchema() {
  return {
    pedal1: {
      types: Object.keys(protocol.PEDAL1_TYPES).map((type) => ({ type, kind: PEDAL1_KIND_BY_TYPE[type] })),
      params: protocol.PEDAL1_PARAMS,
    },
    pedal2: {
      types: Object.keys(protocol.PEDAL2_TYPES).map((type) => ({ type, kind: PEDAL2_KIND_BY_TYPE[type] })),
      params: protocol.PEDAL2_PARAMS,
    },
    reverb: {
      types: Object.keys(protocol.REVERB_TYPES).map((type) => ({ type, kind: 'reverb' })),
      // Reverb's params are the same regardless of type, so it's keyed by
      // "ALL" here rather than duplicated per type like pedal1/pedal2.
      params: { ALL: protocol.REVERB_PARAMS },
    },
  };
}

/** Live-enables/disables one of pedal1/pedal2/reverb, right now, on whatever slot is currently active. */
async function doSetPedalEnabled(slot, enabled) {
  const message = protocol.buildPedalEnabledLiveMessage(slot, enabled);
  const ports = openAmpPorts();
  try {
    await sendAndAwaitAck(ports, message, protocol.isAck, 800);
  } finally {
    ports.close();
  }
  return { slot, enabled };
}

/**
 * Live-switches one of pedal1/pedal2/reverb to a new type, then resets that
 * type's params to their documented defaults (so it starts from a
 * known-good sound instead of inheriting the previous type's raw dial
 * values, which mean something different -- or nothing -- for the new
 * type). Per-field resilient like doPlay, since a couple of fields are
 * known not to accept live updates at all (Phaser Depth, Delay modDepth).
 */
async function doSetPedalType(slot, type) {
  const typeMessage = protocol.buildPedalTypeLiveMessage(slot, type);
  const defaultMessages = protocol.buildPedalDefaultsLiveMessages(slot, type);

  const ports = openAmpPorts();
  const failed = [];
  try {
    await sendAndAwaitAck(ports, typeMessage, protocol.isAck, 800);
    for (const { label, message } of defaultMessages) {
      try {
        await sendAndAwaitAck(ports, message, protocol.isAck, 800);
      } catch (err) {
        failed.push(label);
      }
    }
  } finally {
    ports.close();
  }

  return { slot, type, failed };
}

/** Live-sets one named param of one pedal/reverb slot's current type. */
async function doSetPedalParam(slot, type, paramName, value) {
  const message = protocol.buildPedalParamLiveMessage(slot, type, paramName, value);
  const ports = openAmpPorts();
  try {
    await sendAndAwaitAck(ports, message, protocol.isAck, 800);
  } finally {
    ports.close();
  }
  return { slot, type, param: paramName, value };
}

// A handful of fields are known (see README's "play vs write" section) to
// not reliably reflect a live update when read back from the amp -- Chorus
// Speed reports a stale/unrelated value, and Phaser Depth / Delay modDepth
// simply don't accept live updates at all. Excluding exactly these from the
// comparison keeps matching EXACT rather than needing a fuzzy numeric
// tolerance: current-state and preset both go through the same encode/decode
// round trip (see doGetCurrentRig below), so anything not on this list will
// either match bit-for-bit or genuinely isn't the same preset.
const UNRELIABLE_LIVE_PARAMS = {
  pedal1: { CHORUS: ['speedHz'] },
  pedal2: {
    BLK_PHASER: ['depth'], ORG_PHASER_1: ['depth'], ORG_PHASER_2: ['depth'],
    TAPE_ECHO: ['modDepth'], ANALOG_DELAY: ['modDepth'],
  },
};

function paramsMatch(side, type, a, b) {
  const skip = (UNRELIABLE_LIVE_PARAMS[side] && UNRELIABLE_LIVE_PARAMS[side][type]) || [];
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  for (const key of keys) {
    if (skip.includes(key)) continue;
    if ((a || {})[key] !== (b || {})[key]) return false;
  }
  return true;
}

const AMP_COMPARE_KEYS = [
  'gain', 'treble', 'middle', 'bass', 'volume', 'presence', 'resonance',
  'noiseReductionSensitivity', 'brightCap', 'lowCut', 'midBoost', 'tubeBias', 'ampClass',
];

function currentMatchesPreset(current, preset) {
  if (current.amplifier.model !== preset.amplifier.model) return false;
  for (const key of AMP_COMPARE_KEYS) {
    if (current.amplifier[key] !== preset.amplifier[key]) return false;
  }

  if (current.pedal1.type !== preset.pedal1.type || current.pedal1.enabled !== preset.pedal1.enabled) return false;
  if (current.pedal1.enabled && !paramsMatch('pedal1', current.pedal1.type, current.pedal1.params, preset.pedal1.params)) return false;

  if (current.pedal2.type !== preset.pedal2.type || current.pedal2.enabled !== preset.pedal2.enabled) return false;
  if (current.pedal2.enabled && !paramsMatch('pedal2', current.pedal2.type, current.pedal2.params, preset.pedal2.params)) return false;

  if (current.reverb.type !== preset.reverb.type || current.reverb.enabled !== preset.reverb.enabled) return false;
  if (current.reverb.enabled && !paramsMatch('reverb', current.reverb.type, current.reverb.params, preset.reverb.params)) return false;

  return true;
}

/**
 * Reads the amp's actual current live state (whatever's really sounding --
 * from this GUI, the CLI, or the amp's own physical knobs) and tries to
 * identify it as one of the preset files in presets/, so "Current Rig" can
 * reflect reality on page load instead of just defaulting to nothing. Also
 * always returns Volume, so the knob/slider can start at the real value
 * even when nothing matches. Callers should treat any read failure here
 * (amp off, unplugged, another client connected) as "leave everything at
 * the default" -- not an error worth alarming the user over, since "not
 * connected yet" is a completely normal state on page load.
 */
async function doGetCurrentRig() {
  const ports = openAmpPorts();
  let current;
  try {
    const requestMessage = protocol.buildRequestCurrentProgramMessage();
    const response = await sendAndAwaitResponse(ports, requestMessage, 1500);
    const payload = response.slice(2, -1);
    const expectedPrefix = [0x30, 0x00, 0x01, 0x34, 0x40, 0x00];
    const prefixMatches = expectedPrefix.every((b, i) => payload[i] === b);
    if (!prefixMatches) throw new Error('Unexpected response from amp.');
    const programBytes = Buffer.from(payload.slice(6));
    if (programBytes.length !== 0x46) throw new Error(`Expected 70 bytes, got ${programBytes.length}.`);
    current = protocol.decodeProgramToPresetInput(programBytes);
  } finally {
    ports.close();
  }

  let match = { matched: false };
  for (const file of listPresetFiles()) {
    if (file.error) continue;
    let preset;
    try {
      preset = JSON.parse(fs.readFileSync(path.join(PRESETS_DIR, file.file), 'utf8'));
    } catch (err) {
      continue;
    }
    const normalized = protocol.decodeProgramToPresetInput(protocol.encodeProgram(preset));
    if (currentMatchesPreset(current, normalized)) {
      match = { matched: true, file: file.file, programName: preset.programName || '(unnamed)' };
      break;
    }
  }

  // pedal1/pedal2/reverb are always included (not just on a miss) -- the
  // Live Pedal cards need the amp's actual current type/enabled/params to
  // initialize themselves from, whether or not the overall rig happens to
  // match a saved preset file.
  return {
    ...match,
    volume: current.amplifier.volume,
    amplifier: current.amplifier.model,
    pedal1: current.pedal1,
    pedal2: current.pedal2,
    reverb: current.reverb,
  };
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

    if (req.method === 'GET' && req.url === '/api/current-rig') {
      const result = await doGetCurrentRig();
      res.end(JSON.stringify({ ok: true, result }));
      return;
    }

    if (req.method === 'GET' && req.url === '/api/pedal-schema') {
      res.end(JSON.stringify({ ok: true, result: getPedalSchema() }));
      return;
    }

    if (req.method === 'POST' && req.url === '/api/pedal-enabled') {
      const body = await readJsonBody(req);
      const result = await doSetPedalEnabled(body.slot, body.enabled);
      res.end(JSON.stringify({ ok: true, result }));
      return;
    }

    if (req.method === 'POST' && req.url === '/api/pedal-type') {
      const body = await readJsonBody(req);
      const result = await doSetPedalType(body.slot, body.type);
      res.end(JSON.stringify({ ok: true, result }));
      return;
    }

    if (req.method === 'POST' && req.url === '/api/pedal-param') {
      const body = await readJsonBody(req);
      const result = await doSetPedalParam(body.slot, body.type, body.param, body.value);
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
