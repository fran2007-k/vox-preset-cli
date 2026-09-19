'use strict';

const midi = require('@julusian/midi');

const PORT_NAME_HINT = 'Valvetronix';

function findPortIndex(port, nameHint) {
  const count = port.getPortCount();
  for (let i = 0; i < count; i++) {
    if (port.getPortName(i).includes(nameHint)) return i;
  }
  return -1;
}

/**
 * Opens the amp's MIDI input+output ports. Throws with a helpful message if
 * the amp isn't found (not connected, powered off, or another app -- VOX
 * Tone Room, the web app's browser tab, etc. -- already has it open).
 */
function openAmpPorts(nameHint = PORT_NAME_HINT) {
  const input = new midi.Input();
  const output = new midi.Output();

  const inIndex = findPortIndex(input, nameHint);
  const outIndex = findPortIndex(output, nameHint);

  if (inIndex === -1 || outIndex === -1) {
    const available = [];
    for (let i = 0; i < input.getPortCount(); i++) available.push(input.getPortName(i));
    throw new Error(
      `Could not find a MIDI device matching "${nameHint}". ` +
      `Make sure the amp is connected via USB, powered on, and that no other ` +
      `app (VOX Tone Room, the vox-amp-librarian browser tab, etc.) is already ` +
      `connected to it -- only one client can hold the MIDI connection at a time.\n` +
      `Available MIDI input ports: ${available.length ? available.join(', ') : '(none)'}`
    );
  }

  // sysex messages are ignored by default in most MIDI libraries; we need them.
  input.ignoreTypes(false, true, true);
  input.openPort(inIndex);
  output.openPort(outIndex);

  return {
    input,
    output,
    close() {
      input.closePort();
      output.closePort();
    },
  };
}

/**
 * Sends a raw sysex message (array of ints, no need to include F0/F7 --
 * callers pass the fully-framed message built by lib/protocol.js) and waits
 * for the amp's next sysex response, up to `timeoutMs`.
 */
function sendAndAwaitResponse(ports, message, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ports.input.removeListener('message', onMessage);
      reject(new Error(`Timed out after ${timeoutMs}ms waiting for a response from the amp.`));
    }, timeoutMs);

    function onMessage(deltaTime, sysexBytes) {
      clearTimeout(timer);
      ports.input.removeListener('message', onMessage);
      resolve(sysexBytes);
    }

    ports.input.on('message', onMessage);
    ports.output.sendMessage(message);
  });
}

/**
 * Like sendAndAwaitResponse, but specifically for commands that expect an
 * ACK (`30 00 01 34 23`): while waiting, the amp can spontaneously emit
 * unrelated status/echo messages (observed in practice when firing a long
 * sequence of live dial-turn messages back to back) -- those are logged and
 * ignored rather than treated as the response, so we keep waiting for the
 * actual ACK until the timeout.
 */
function sendAndAwaitAck(ports, message, isAck, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ports.input.removeListener('message', onMessage);
      reject(new Error(`Timed out after ${timeoutMs}ms waiting for an ACK from the amp.`));
    }, timeoutMs);

    function onMessage(deltaTime, sysexBytes) {
      if (isAck(sysexBytes)) {
        clearTimeout(timer);
        ports.input.removeListener('message', onMessage);
        resolve(sysexBytes);
      }
      // else: an unrelated message arrived (e.g. the amp echoing its own
      // state) -- ignore it and keep waiting for the real ACK.
    }

    ports.input.on('message', onMessage);
    ports.output.sendMessage(message);
  });
}

function send(ports, message) {
  ports.output.sendMessage(message);
}

module.exports = { openAmpPorts, sendAndAwaitResponse, sendAndAwaitAck, send, PORT_NAME_HINT };
