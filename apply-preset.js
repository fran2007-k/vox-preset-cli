#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { parseArgs } = require('util');

const protocol = require('./lib/protocol');
const { openAmpPorts, sendAndAwaitResponse } = require('./lib/midi');

function printUsage() {
  console.log(`
vox-preset -- write/read VOX VT20X/40X/100X amp presets over MIDI

Usage:
  node apply-preset.js list-ports
  node apply-preset.js write <preset.json> [--slot A1..B4] [--dry-run]
  node apply-preset.js read <A1..B4>

"write" persists the preset directly to the amp's program memory in one
shot -- no live-editing required. The JSON file's own "targetSlot" field is
used if --slot is not given.

"read" fetches whatever is actually stored in a slot right now and prints
it as JSON, decoded straight from the amp's own bytes (not from any app's
cached state) -- useful to double check what really got written.

Examples:
  node apply-preset.js write presets/money-for-nothing.json
  node apply-preset.js write presets/money-for-nothing.json --slot A3 --dry-run
  node apply-preset.js read A2
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
    const writeAck = await sendAndAwaitResponse(ports, writeMessage);
    if (!protocol.isAck(writeAck)) {
      throw new Error(`Amp did not acknowledge the write. Got: ${Buffer.from(writeAck).toString('hex')}`);
    }

    const persistAck = await sendAndAwaitResponse(ports, persistMessage);
    if (!protocol.isAck(persistAck)) {
      throw new Error(`Amp did not acknowledge the persist. Got: ${Buffer.from(persistAck).toString('hex')}`);
    }

    console.log(`Done. Slot ${slot} now holds "${preset.programName || '(unnamed)'}".`);
    console.log(`Verify any time with: node apply-preset.js read ${slot}`);
  } finally {
    ports.close();
  }
}

async function readSlot(slot) {
  const ports = openAmpPorts();
  try {
    const requestMessage = protocol.buildRequestUserProgramMessage(slot);
    console.log(`Requesting slot ${slot} from the amp...`);
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

    console.log(JSON.stringify(protocol.decodeProgram(programBytes), null, 2));
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
    if (positionals.length !== 1) {
      console.error('Usage: node apply-preset.js read <A1..B4>');
      process.exitCode = 1;
      return;
    }
    await readSlot(positionals[0]);
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
