#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { parseArgs } = require('util');

const protocol = require('./lib/protocol');
const { openAmpPorts, sendAndAwaitResponse, sendAndAwaitAck } = require('./lib/midi');

function printUsage() {
  console.log(`
vox-preset -- write/read VOX VT20X/40X/100X amp presets over MIDI

Usage:
  node apply-preset.js list-ports
  node apply-preset.js play <preset.json>
  node apply-preset.js write <preset.json> [--slot A1..B4] [--dry-run]
  node apply-preset.js read [A1..B4]
  node apply-preset.js dump <A1..B4> [--out <file.json>]

"play" makes the amp sound like the preset RIGHT NOW, on whatever slot is
currently active -- the same as turning its physical knobs, just all at
once. Nothing is written to any slot; power-cycling the amp or switching
slots reverts it. This is the one to reach for if you just want to hear a
preset without committing it anywhere -- your "current rig" for the
session.

"write" persists the preset directly to the amp's program memory in one
shot -- no live-editing required. The JSON file's own "targetSlot" field is
used if --slot is not given.

"read <slot>" fetches whatever is actually stored in that slot right now
and prints a raw decode of it (dial-by-dial) -- useful to double check what
really got written, at the byte level. "read" with no slot instead reads
the amp's CURRENT LIVE state (what it actually sounds like right now,
including anything applied with "play") -- the read-side counterpart to
"play".

"dump" is the easier way to *generate* a preset JSON: it fetches a slot and
prints (or saves) it already shaped as a preset file ready for "write" --
so you can pull any sound already on the amp and use it as a starting
point instead of writing JSON from scratch. See README.md for the full
parameter reference if you'd rather build one by hand.

Examples:
  node apply-preset.js play presets/money-for-nothing.json
  node apply-preset.js write presets/money-for-nothing.json
  node apply-preset.js write presets/money-for-nothing.json --slot A3 --dry-run
  node apply-preset.js read A2
  node apply-preset.js dump A1 --out presets/funky.json
`);
}

function listPorts() {
  const midi = require('@julusian/midi');
  const input = new midi.Input();
  const output = new midi.Output();
  console.log('MIDI input ports:');
  for (let i = 0; i < input.getPortCount(); i++) console.log(`  [${i}] ${input.getPortName(i)}`);
  console.log('MIDI output ports:');
  for (let i = 0; i < output.getPortCount(); i++) console.log(`  [${i}] ${output.getPortName(i)}`);
}

async function playPreset(jsonPath) {
  const preset = JSON.parse(fs.readFileSync(path.resolve(jsonPath), 'utf8'));
  const messages = protocol.buildLiveApplyMessages(preset);

  const ports = openAmpPorts();
  const failed = [];
  try {
    console.log(`Playing "${preset.programName || '(unnamed)'}" live (${messages.length} messages, nothing saved)...`);
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

  if (failed.length > 0) {
    console.log(`Done, with ${failed.length} field(s) the amp didn't accept live (known hardware limitation, not necessarily a bug -- see README): ${failed.join(', ')}`);
  } else {
    console.log('Done -- the amp should sound like it now. Nothing was written to any slot.');
  }
}

async function writePreset(jsonPath, slotOverride, dryRun) {
  const raw = fs.readFileSync(path.resolve(jsonPath), 'utf8');
  const preset = JSON.parse(raw);
  const slot = slotOverride || preset.targetSlot;
  if (!slot) {
    throw new Error('No target slot given -- pass --slot A1..B4 or set "targetSlot" in the JSON file.');
  }

  const programBytes = protocol.encodeProgram(preset);
  const writeMessage = protocol.buildWriteUserProgramMessage(slot, programBytes);
  const persistMessage = protocol.buildPersistUserProgramMessage(slot);

  if (dryRun) {
    console.log(`Would write "${preset.programName || '(unnamed)'}" to slot ${slot}:`);
    console.log('  WriteUserProgram:', Buffer.from(writeMessage).toString('hex').replace(/(..)/g, '$1 ').trim());
    console.log('  PersistUserProgram:', Buffer.from(persistMessage).toString('hex').replace(/(..)/g, '$1 ').trim());
    console.log('Decoded program that would be sent:');
    console.log(JSON.stringify(protocol.decodeProgram(programBytes), null, 2));
    return;
  }

  const ports = openAmpPorts();
  try {
    console.log(`Writing "${preset.programName || '(unnamed)'}" to slot ${slot}...`);
    await sendAndAwaitAck(ports, writeMessage, protocol.isAck);
    await sendAndAwaitAck(ports, persistMessage, protocol.isAck);

    console.log(`Done. Slot ${slot} now holds "${preset.programName || '(unnamed)'}".`);
    console.log(`Verify any time with: node apply-preset.js read ${slot}`);
  } finally {
    ports.close();
  }
}

async function fetchProgramBytes(ports, slot) {
  const requestMessage = protocol.buildRequestUserProgramMessage(slot);
  const response = await sendAndAwaitResponse(ports, requestMessage);

  // response: F0 42 30 00 01 34 4c 00 <slot> 00 <70 program bytes> F7
  const payload = response.slice(2, -1);
  const expectedPrefix = [0x30, 0x00, 0x01, 0x34, 0x4c, 0x00];
  const prefixMatches = expectedPrefix.every((b, i) => payload[i] === b);
  if (!prefixMatches) {
    throw new Error(`Unexpected response from amp: ${Buffer.from(response).toString('hex')}`);
  }

  const programBytes = Buffer.from(payload.slice(8));
  if (programBytes.length !== 0x46) {
    throw new Error(`Expected a 70-byte program, got ${programBytes.length} bytes.`);
  }
  return programBytes;
}

async function readCurrent() {
  const ports = openAmpPorts();
  try {
    console.log('Requesting the amp\'s current live state (not a stored slot)...');
    const requestMessage = protocol.buildRequestCurrentProgramMessage();
    const response = await sendAndAwaitResponse(ports, requestMessage);
    const payload = response.slice(2, -1);
    const expectedPrefix = [0x30, 0x00, 0x01, 0x34, 0x40, 0x00];
    const prefixMatches = expectedPrefix.every((b, i) => payload[i] === b);
    if (!prefixMatches) {
      throw new Error(`Unexpected response from amp: ${Buffer.from(response).toString('hex')}`);
    }
    const programBytes = Buffer.from(payload.slice(6));
    if (programBytes.length !== 0x46) {
      throw new Error(`Expected a 70-byte program, got ${programBytes.length} bytes.`);
    }
    console.log(JSON.stringify(protocol.decodeProgram(programBytes), null, 2));
  } finally {
    ports.close();
  }
}

async function readSlot(slot) {
  const ports = openAmpPorts();
  try {
    console.log(`Requesting slot ${slot} from the amp...`);
    const programBytes = await fetchProgramBytes(ports, slot);
    console.log(JSON.stringify(protocol.decodeProgram(programBytes), null, 2));
  } finally {
    ports.close();
  }
}

async function dumpSlot(slot, outFile) {
  const ports = openAmpPorts();
  try {
    console.log(`Requesting slot ${slot} from the amp...`);
    const programBytes = await fetchProgramBytes(ports, slot);
    const preset = protocol.decodeProgramToPresetInput(programBytes, slot);
    const json = JSON.stringify(preset, null, 2);

    if (outFile) {
      fs.writeFileSync(path.resolve(outFile), json + '\n');
      console.log(`Saved to ${outFile}. Edit it and "write" it back with:`);
      console.log(`  node apply-preset.js write ${outFile}`);
    } else {
      console.log(json);
    }

    if (preset.pedal2._warning) {
      console.warn('\nNote: a field-collision warning was attached to this preset -- see the "_warning" key above.');
    }
  } finally {
    ports.close();
  }
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);

  if (!command || command === '--help' || command === '-h') {
    printUsage();
    return;
  }

  if (command === 'list-ports') {
    listPorts();
    return;
  }

  if (command === 'play') {
    const { positionals } = parseArgs({ args: rest, allowPositionals: true });
    if (positionals.length !== 1) {
      console.error('Usage: node apply-preset.js play <preset.json>');
      process.exitCode = 1;
      return;
    }
    await playPreset(positionals[0]);
    return;
  }

  if (command === 'write') {
    const { positionals, values } = parseArgs({
      args: rest,
      options: { slot: { type: 'string' }, 'dry-run': { type: 'boolean', default: false } },
      allowPositionals: true,
    });
    if (positionals.length !== 1) {
      console.error('Usage: node apply-preset.js write <preset.json> [--slot A1..B4] [--dry-run]');
      process.exitCode = 1;
      return;
    }
    await writePreset(positionals[0], values.slot, values['dry-run']);
    return;
  }

  if (command === 'read') {
    const { positionals } = parseArgs({ args: rest, allowPositionals: true });
    if (positionals.length === 0) {
      await readCurrent();
      return;
    }
    if (positionals.length !== 1) {
      console.error('Usage: node apply-preset.js read [A1..B4]');
      process.exitCode = 1;
      return;
    }
    await readSlot(positionals[0]);
    return;
  }

  if (command === 'dump') {
    const { positionals, values } = parseArgs({
      args: rest,
      options: { out: { type: 'string' } },
      allowPositionals: true,
    });
    if (positionals.length !== 1) {
      console.error('Usage: node apply-preset.js dump <A1..B4> [--out <file.json>]');
      process.exitCode = 1;
      return;
    }
    await dumpSlot(positionals[0], values.out);
    return;
  }

  console.error(`Unknown command "${command}".`);
  printUsage();
  process.exitCode = 1;
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exitCode = 1;
});
