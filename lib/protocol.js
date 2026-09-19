'use strict';

/**
 * Pure re-implementation of the VOX VT20X/40X/100X SysEx protocol used by
 * the tmarsteel/vox-amp-librarian web app (see that repo's
 * doc/protocols/vt_20_40_100_x.md and src/main/kotlin/.../protocol/Program.kt).
 * This is a standalone sibling tool -- no shared code with that repo, just
 * the same reverse-engineered wire protocol.
 *
 * This is a direct, byte-for-byte port of Program.kt's writeTo()/readFrom(),
 * plus the descriptor tables from appmodel/amps.kt, slot1pedals.kt,
 * slot2pedals.kt and reverb_pedals.kt. Keeping it consistent with that source
 * means presets built here read back correctly in the web app too.
 */

const MANUFACTURER_ID = 0x42;

const PROGRAM_SLOTS = {
  A1: 0x00, A2: 0x01, A3: 0x02, A4: 0x03,
  B1: 0x04, B2: 0x05, B3: 0x06, B4: 0x07,
};

// --- Amp models --------------------------------------------------------

const AMP_MODELS = {
  DELUXE_CL_VIBRATO: { byte: 0x00, brightCap: true, label: "Fender '65 Deluxe Reverb Vibrato Channel" },
  DELUXE_CL_NORMAL: { byte: 0x01, brightCap: false, label: "Fender '65 Deluxe Reverb Normal Channel" },
  TWEED_410_BRIGHT: { byte: 0x02, brightCap: true, label: 'Fender Bassman 4x10 Bright Channel' },
  TWEED_410_NORMAL: { byte: 0x03, brightCap: false, label: 'Fender Bassman 4x10 Normal Channel' },
  BOUTIQUE_CL: { byte: 0x04, brightCap: true, label: 'Overdrive Special Clean Channel' },
  BOUTIQUE_OD: { byte: 0x05, brightCap: true, label: 'Overdrive Special Overdrive Channel' },
  VOX_AC30: { byte: 0x06, brightCap: true, label: 'VOX AC30' },
  VOX_AC30TB: { byte: 0x07, brightCap: true, label: 'VOX AC30TB' },
  BRIT_1959_TREBLE: { byte: 0x08, brightCap: true, label: 'Marshal JTM Treble' },
  BRIT_1959_NORMAL: { byte: 0x09, brightCap: false, label: 'Marshal JTM Normal' },
  BRIT_800: { byte: 0x0a, brightCap: true, label: 'Marshal JCM-800' },
  BRIT_VM: { byte: 0x0b, brightCap: true, label: 'Marshal JVM-410' },
  SL_OD: { byte: 0x0c, brightCap: true, label: 'Soldano SLO-100' },
  DOUBLE_REC: { byte: 0x0d, brightCap: true, label: 'Mesa Boogie Dual Rectifier' },
  CALI_ELATION: { byte: 0x0e, brightCap: true, label: 'Cali Elation' },
  ERUPT_III_CH2: { byte: 0x0f, brightCap: false, label: 'Peavy 5150 III Channel 2' },
  ERUPT_III_CH3: { byte: 0x10, brightCap: true, label: 'Peavy 5150 III Channel 3' },
  BOUTIQUE_METAL: { byte: 0x11, brightCap: false, label: 'Diezel VH4' },
  BRIT_OR_MKII: { byte: 0x12, brightCap: true, label: 'Orange Super Crush 100' },
  ORIGINAL_CL: { byte: 0x13, brightCap: true, label: 'No additional simulation, just the VTX amp' },
};

const AMP_DEFAULTS = {
  gain: 5.0, treble: 5.0, middle: 5.0, bass: 5.0, volume: 5.0,
  presence: 2.0, resonance: 7.5, noiseReductionSensitivity: 3.0,
  brightCap: true, lowCut: false, midBoost: false,
  tubeBias: 'OFF', ampClass: 'A',
};

const TUBE_BIAS = { OFF: 0x00, COLD: 0x01, HOT: 0x02 };
const AMP_CLASS = { A: 0x00, AB: 0x01 };

// --- Pedal 1 (COMP / CHORUS / overdrive family) -------------------------

const PEDAL1_TYPES = {
  COMP: 0x00, CHORUS: 0x01, OVERDRIVE: 0x02, GOLD_DRIVE: 0x03,
  TREBLE_BOOST: 0x04, RC_TURBO: 0x05, ORANGE_DIST: 0x06,
  FAT_DIST: 0x07, BRIT_LEAD: 0x08, FUZZ: 0x09,
};

const COMP_VOICE = { ONE: 0x00, TWO: 0x01, THREE: 0x02 };

// Each pedal1 type's own parameter set, matching the descriptors in
// appmodel/slot1pedals.kt exactly (dial slot 1-6, kind, default).
const PEDAL1_PARAMS = {
  COMP: {
    sens: { dial: 1, kind: 'unitless', default: 5.0 },
    level: { dial: 2, kind: 'unitless', default: 6.7 },
    attack: { dial: 3, kind: 'unitless', default: 5.7 },
    voice: { dial: 4, kind: 'discrete', choices: COMP_VOICE, default: 'TWO' },
  },
  // NOTE: depth/manual/mix are, in the original app, written into the SAME
  // wire bytes as Pedal 2's dial2/dial3/dial4 (see appmodel/slot1pedals.kt,
  // ChorusPedalDescriptor uses MutableProgram::pedal2Dial2/3/4 instead of
  // pedal1Dial2/3/4 for these three params -- almost certainly reverse
  // engineered off real hardware captures, so we replicate the wire layout,
  // but see encodeProgram() below for how we resolve the collision so
  // Chorus's own values always win when Pedal 1 is actually Chorus.
  CHORUS: {
    speedHz: { dial: 1, kind: 'frequency', default: 0.1 },
    depth: { dial: '2(shared-with-pedal2)', kind: 'unitless', default: 6.7 },
    manual: { dial: '2(shared-with-pedal2)', kind: 'unitless', default: 5.7 },
    mix: { dial: '2(shared-with-pedal2)', kind: 'unitless', default: 1.0 },
    lowCut: { dial: 5, kind: 'boolean', default: false },
    highCut: { dial: 6, kind: 'boolean', default: false },
  },
  ...Object.fromEntries(
    ['OVERDRIVE', 'GOLD_DRIVE', 'TREBLE_BOOST', 'RC_TURBO', 'ORANGE_DIST', 'FAT_DIST', 'BRIT_LEAD', 'FUZZ'].map((name) => [
      name,
      {
        drive: { dial: 1, kind: 'unitless', default: 5.0 },
        tone: { dial: 2, kind: 'unitless', default: 6.7 },
        level: { dial: 3, kind: 'unitless', default: 5.7 },
        treble: { dial: 4, kind: 'unitless', default: 5.0 },
        middle: { dial: 5, kind: 'unitless', default: 5.0 },
        bass: { dial: 6, kind: 'unitless', default: 5.0 },
      },
    ]),
  ),
};

// --- Pedal 2 (FLANGER / phasers / TREMOLO / delays) ---------------------

const PEDAL2_TYPES = {
  FLANGER: 0x00, BLK_PHASER: 0x01, ORG_PHASER_1: 0x02, ORG_PHASER_2: 0x03,
  TREMOLO: 0x04, TAPE_ECHO: 0x05, ANALOG_DELAY: 0x06,
};

const PEDAL2_PARAMS = {
  FLANGER: {
    speedHz: { dial: 1, kind: 'frequency', default: 0.1 },
    depth: { dial: 2, kind: 'unitless', default: 5.0 },
    manual: { dial: 3, kind: 'unitless', default: 7.7 },
    lowCut: { dial: 4, kind: 'boolean', default: false },
    highCut: { dial: 5, kind: 'boolean', default: false },
    resonance: { dial: 6, kind: 'unitless', default: 3.5 },
  },
  BLK_PHASER: {
    speedHz: { dial: 1, kind: 'frequency', default: 0.1 },
    resonance: { dial: 2, kind: 'unitless', default: 5.0 },
    manual: { dial: 3, kind: 'unitless', default: 7.7 },
    depth: { dial: 4, kind: 'unitless', default: 0.0 },
  },
  ORG_PHASER_1: {
    speedHz: { dial: 1, kind: 'frequency', default: 0.1 },
    resonance: { dial: 2, kind: 'unitless', default: 5.0 },
    manual: { dial: 3, kind: 'unitless', default: 7.7 },
    depth: { dial: 4, kind: 'unitless', default: 0.0 },
  },
  ORG_PHASER_2: {
    speedHz: { dial: 1, kind: 'frequency', default: 0.1 },
    resonance: { dial: 2, kind: 'unitless', default: 5.0 },
    manual: { dial: 3, kind: 'unitless', default: 7.7 },
    depth: { dial: 4, kind: 'unitless', default: 0.0 },
  },
  TREMOLO: {
    speedHz: { dial: 1, kind: 'frequency', default: 1.65 },
    depth: { dial: 2, kind: 'unitless', default: 5.0 },
    duty: { dial: 3, kind: 'unitless', default: 7.7 },
    shape: { dial: 4, kind: 'unitless', default: 0.0 },
    level: { dial: 5, kind: 'unitless', default: 1.0 },
  },
  TAPE_ECHO: {
    timeMs: { dial: 1, kind: 'duration', default: 30 },
    level: { dial: 2, kind: 'unitless', default: 5.0 },
    feedback: { dial: 3, kind: 'unitless', default: 7.7 },
    tone: { dial: 4, kind: 'unitless', default: 5.0 },
    modSpeed: { dial: 5, kind: 'unitless', default: 0.1 },
    modDepth: { dial: 6, kind: 'unitless', default: 0.0 },
  },
  ANALOG_DELAY: {
    timeMs: { dial: 1, kind: 'duration', default: 30 },
    level: { dial: 2, kind: 'unitless', default: 5.0 },
    feedback: { dial: 3, kind: 'unitless', default: 7.7 },
    tone: { dial: 4, kind: 'unitless', default: 5.0 },
    modSpeed: { dial: 5, kind: 'unitless', default: 0.1 },
    modDepth: { dial: 6, kind: 'unitless', default: 0.0 },
  },
};

// --- Reverb (shared parameter set across all 4 types) -------------------

const REVERB_TYPES = { ROOM: 0x00, SPRING: 0x01, HALL: 0x02, PLATE: 0x03 };

const REVERB_PARAMS = {
  mix: { dial: 1, kind: 'unitless', default: 7.5 },
  time: { dial: 2, kind: 'unitless', default: 4.5 },
  preDelayMs: { dial: 3, kind: 'durationByte', default: 0 },
  lowDamp: { dial: 4, kind: 'unitless', default: 3.6 },
  highDamp: { dial: 5, kind: 'unitless', default: 2.5 },
};

// --- Low-level value encoders --------------------------------------------

/** 0.0-10.0 (one decimal) -> single byte 0x00-0x64 */
function encodeUnitless(value) {
  const raw = Math.round(value * 10);
  if (raw < 0 || raw > 100) throw new Error(`value ${value} out of range 0.0-10.0`);
  return raw;
}

/**
 * Standard two-byte dial encoding (used for pedal1Dial1, and generally
 * anywhere a TwoByteDial is written directly). Semantic value is either raw
 * millihertz (frequency) or raw milliseconds (duration) or a raw 0-100
 * unitless integer. Protocol has a quirk: after 127 the encoded value jumps
 * by 129 (see doc/protocols/vt_20_40_100_x.md "Encoding for Frequency").
 */
function encodeTwoByteDialStandard(semanticValue) {
  const protocolValue = semanticValue + Math.floor(semanticValue / 0x80) * 0x80;
  return [protocolValue & 0xff, (protocolValue >> 8) & 0xff];
}

/**
 * Pedal-2-dial-1-specific encoding: an extra offset byte (written
 * separately at a fixed position) plus a raw low/high byte split, WITHOUT
 * the standard jump-by-129 quirk. See Program.kt's offsetEncode() and the
 * "Pedal 2 Dial 1" section of the protocol doc.
 */
function encodePedal2Dial1(semanticValue) {
  let lsb = semanticValue & 0xff;
  const msb = (semanticValue >> 8) & 0xff;
  let offset = 0x00;
  if (lsb >= 0x80) {
    offset = 0x20;
    lsb -= 0x80;
  }
  return { offset, bytes: [lsb, msb] };
}

function encodeFrequencyToMillihertz(hz) {
  return Math.round(hz * 1000);
}

function encodeProgramName(name) {
  if (name.length > 16) throw new Error(`program name "${name}" is longer than 16 characters`);
  // eslint-disable-next-line no-control-regex
  if (!/^[\x00-\x7f]*$/.test(name)) throw new Error('program name must be ASCII');
  const padded = name.padEnd(16, ' ');
  return Buffer.from(padded, 'ascii');
}

function resolveDialValue(spec, rawValue) {
  switch (spec.kind) {
    case 'unitless':
      return encodeUnitless(rawValue);
    case 'boolean':
      return rawValue ? 0x01 : 0x00;
    case 'discrete':
      if (!(rawValue in spec.choices)) {
        throw new Error(`invalid choice "${rawValue}", expected one of ${Object.keys(spec.choices).join(', ')}`);
      }
      return spec.choices[rawValue];
    case 'frequency':
      return encodeFrequencyToMillihertz(rawValue);
    case 'duration':
      return Math.round(rawValue);
    case 'durationByte':
      return Math.round(rawValue);
    default:
      throw new Error(`unknown dial kind ${spec.kind}`);
  }
}

/**
 * Builds the 6 raw byte-or-word values for a pedal1/pedal2 dial bank (dial1
 * is a TwoByteDial, dial2-6 are ordinarily plain bytes) from a params spec
 * + user-supplied values object. Missing values fall back to the spec's
 * documented default (matching the Kotlin descriptors).
 */
function resolvePedalDials(paramsSpec, values, dialCount) {
  const dials = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
  for (const [name, spec] of Object.entries(paramsSpec)) {
    if (typeof spec.dial !== 'number') continue; // handled specially (chorus depth/manual/mix)
    const raw = values && name in values ? values[name] : spec.default;
    dials[spec.dial] = resolveDialValue(spec, raw);
  }
  for (let i = dialCount + 1; i <= 6; i++) dials[i] = 0;
  return dials;
}

/**
 * Encodes a full preset JSON object into the 70-byte "Program" struct used
 * by the amp, exactly matching Program.kt's writeTo() byte order.
 */
function encodeProgram(preset) {
  const bytes = [];
  const w = (...vals) => bytes.push(...vals);

  // -- name (0x00-0x11) --
  const nameBytes = encodeProgramName(preset.programName || '');
  w(...nameBytes.subarray(0, 7), 0x00);
  w(...nameBytes.subarray(7, 14), 0x00);
  w(...nameBytes.subarray(14, 16));

  const amp = { ...AMP_DEFAULTS, ...(preset.amplifier || {}) };
  const ampModelKey = amp.model;
  if (!(ampModelKey in AMP_MODELS)) {
    throw new Error(`unknown amp model "${ampModelKey}", expected one of ${Object.keys(AMP_MODELS).join(', ')}`);
  }
  const ampModel = AMP_MODELS[ampModelKey];

  const pedal1 = preset.pedal1 || { type: 'COMP', enabled: false };
  const pedal2 = preset.pedal2 || { type: 'FLANGER', enabled: false };
  const reverb = preset.reverb || { type: 'ROOM', enabled: false };

  if (!(pedal1.type in PEDAL1_TYPES)) throw new Error(`unknown pedal1 type "${pedal1.type}"`);
  if (!(pedal2.type in PEDAL2_TYPES)) throw new Error(`unknown pedal2 type "${pedal2.type}"`);
  if (!(reverb.type in REVERB_TYPES)) throw new Error(`unknown reverb type "${reverb.type}"`);

  // -- noise reduction sensitivity (0x12) --
  w(encodeUnitless(amp.noiseReductionSensitivity));

  // -- flags (0x13) --
  let flags = 0x00;
  if (pedal1.enabled) flags |= 0b0000_0010;
  if (pedal2.enabled) flags |= 0b0000_0100;
  if (reverb.enabled) flags |= 0b0001_0000;
  w(flags);

  // -- amp model + dials (0x14-0x22) --
  w(ampModel.byte);
  w(encodeUnitless(amp.gain));
  w(encodeUnitless(amp.treble));
  w(0x00);
  w(encodeUnitless(amp.middle));
  w(encodeUnitless(amp.bass));
  w(encodeUnitless(amp.volume));
  w(encodeUnitless(amp.presence));
  w(encodeUnitless(amp.resonance));
  w(amp.brightCap ? 0x01 : 0x00);
  w(amp.lowCut ? 0x01 : 0x00);
  w(0x00);
  w(amp.midBoost ? 0x01 : 0x00);
  if (!(amp.tubeBias in TUBE_BIAS)) throw new Error(`unknown tubeBias "${amp.tubeBias}"`);
  w(TUBE_BIAS[amp.tubeBias]);
  if (!(amp.ampClass in AMP_CLASS)) throw new Error(`unknown ampClass "${amp.ampClass}"`);
  w(AMP_CLASS[amp.ampClass]);

  // -- pedal 1 (0x23-0x2B) --
  const p1Spec = PEDAL1_PARAMS[pedal1.type];
  const p1Dials = resolvePedalDials(p1Spec, pedal1.params, 6);
  w(PEDAL1_TYPES[pedal1.type]);
  w(...encodeTwoByteDialStandard(p1Dials[1]));
  w(p1Dials[2]);
  // byte at 0x27 (pedal2Dial1Offset) filled in below, once pedal2 is resolved
  const pedal2Dial1OffsetIndex = bytes.length;
  w(0x00); // placeholder
  w(p1Dials[3], p1Dials[4], p1Dials[5], p1Dials[6]);

  // -- pedal 2 (0x2C-0x34) --
  const p2Spec = PEDAL2_PARAMS[pedal2.type];
  const p2Dials = resolvePedalDials(p2Spec, pedal2.params, 6);

  // KNOWN QUIRK (matches appmodel/slot1pedals.kt ChorusPedalDescriptor):
  // Chorus's depth/manual/mix are wired to the same bytes as pedal2Dial2/3/4.
  // The original app applies pedal1 first then pedal2, so pedal2 always wins
  // there -- meaning Chorus's depth/manual/mix are silently discarded
  // whenever they're written as part of a full program alongside ANY pedal2
  // config. We deliberately invert that here: if pedal1 is actually Chorus,
  // its values win, so the audible effect (chorus) is the one that ends up
  // correct on the hardware. Pedal 2's decoded depth/manual/duty will read
  // wrong afterwards if you inspect this slot in the web app while pedal1
  // is Chorus -- but pedal2's dial-2/3/4 equivalents are cosmetic in that
  // case (real values live in dial5/6 or are simply not used the same way).
  if (pedal1.type === 'CHORUS') {
    const chorusDepth = 'depth' in (pedal1.params || {}) ? pedal1.params.depth : p1Spec.depth.default;
    const chorusManual = 'manual' in (pedal1.params || {}) ? pedal1.params.manual : p1Spec.manual.default;
    const chorusMix = 'mix' in (pedal1.params || {}) ? pedal1.params.mix : p1Spec.mix.default;
    p2Dials[2] = encodeUnitless(chorusDepth);
    p2Dials[3] = encodeUnitless(chorusManual);
    p2Dials[4] = encodeUnitless(chorusMix);
  }

  const pedal2Dial1Semantic = p2Dials[1];
  const { offset: pedal2Dial1Offset, bytes: pedal2Dial1Bytes } = encodePedal2Dial1(pedal2Dial1Semantic);
  bytes[pedal2Dial1OffsetIndex] = pedal2Dial1Offset;

  w(PEDAL2_TYPES[pedal2.type]);
  w(...pedal2Dial1Bytes);
  w(0x00);
  w(p2Dials[2], p2Dials[3], p2Dials[4], p2Dials[5], p2Dials[6]);

  // -- unknown/reserved (0x35-0x3D), always zero --
  w(0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00);

  // -- reverb (0x3E-0x45) --
  const reverbDials = resolvePedalDials(REVERB_PARAMS, reverb.params, 5);
  w(REVERB_TYPES[reverb.type]);
  w(0x00);
  w(encodeUnitless('mix' in (reverb.params || {}) ? reverb.params.mix : REVERB_PARAMS.mix.default));
  w(encodeUnitless('time' in (reverb.params || {}) ? reverb.params.time : REVERB_PARAMS.time.default));
  w(Math.round('preDelayMs' in (reverb.params || {}) ? reverb.params.preDelayMs : REVERB_PARAMS.preDelayMs.default));
  w(encodeUnitless('lowDamp' in (reverb.params || {}) ? reverb.params.lowDamp : REVERB_PARAMS.lowDamp.default));
  w(encodeUnitless('highDamp' in (reverb.params || {}) ? reverb.params.highDamp : REVERB_PARAMS.highDamp.default));
  w(0x00);

  if (bytes.length !== 0x46) {
    throw new Error(`internal error: encoded program is ${bytes.length} bytes, expected 70 (0x46)`);
  }

  return Buffer.from(bytes);
}

// --- SysEx message builders ---------------------------------------------

function sysex(...payloadBytes) {
  return [0xf0, MANUFACTURER_ID, ...payloadBytes, 0xf7];
}

function buildWriteUserProgramMessage(slotName, programBytes) {
  if (!(slotName in PROGRAM_SLOTS)) throw new Error(`unknown program slot "${slotName}"`);
  return sysex(0x30, 0x00, 0x01, 0x34, 0x4c, 0x00, PROGRAM_SLOTS[slotName], 0x00, ...programBytes);
}

function buildPersistUserProgramMessage(slotName) {
  if (!(slotName in PROGRAM_SLOTS)) throw new Error(`unknown program slot "${slotName}"`);
  return sysex(0x30, 0x00, 0x01, 0x34, 0x4e, 0x00, PROGRAM_SLOTS[slotName]);
}

function buildRequestUserProgramMessage(slotName) {
  if (!(slotName in PROGRAM_SLOTS)) throw new Error(`unknown program slot "${slotName}"`);
  return sysex(0x30, 0x00, 0x01, 0x34, 0x1c, 0x00, PROGRAM_SLOTS[slotName]);
}

const ACK_PREFIX = [0x30, 0x00, 0x01, 0x34, 0x23];

function isAck(sysexBytes) {
  // sysexBytes includes the leading 0xf0 0x42 and trailing 0xf7
  const payload = sysexBytes.slice(2, -1);
  return ACK_PREFIX.every((b, i) => payload[i] === b);
}

/** Decodes a "Request User Program" response's program bytes back into a friendly object, for verification. */
function decodeProgram(programBytes) {
  const b = programBytes;
  const name = Buffer.concat([
    b.subarray(0x00, 0x07),
    b.subarray(0x08, 0x0f),
    b.subarray(0x10, 0x12),
  ]).toString('ascii').trimEnd();

  const flags = b[0x13];
  const ampModelByte = b[0x14];
  const ampModelKey = Object.keys(AMP_MODELS).find((k) => AMP_MODELS[k].byte === ampModelByte);

  const tubeBiasByte = b[0x21];
  const tubeBiasKey = Object.keys(TUBE_BIAS).find((k) => TUBE_BIAS[k] === tubeBiasByte);
  const ampClassByte = b[0x22];
  const ampClassKey = Object.keys(AMP_CLASS).find((k) => AMP_CLASS[k] === ampClassByte);

  const pedal1TypeByte = b[0x23];
  const pedal1TypeKey = Object.keys(PEDAL1_TYPES).find((k) => PEDAL1_TYPES[k] === pedal1TypeByte);
  const pedal2TypeByte = b[0x2c];
  const pedal2TypeKey = Object.keys(PEDAL2_TYPES).find((k) => PEDAL2_TYPES[k] === pedal2TypeByte);
  const reverbTypeByte = b[0x3e];
  const reverbTypeKey = Object.keys(REVERB_TYPES).find((k) => REVERB_TYPES[k] === reverbTypeByte);

  const u = (byte) => Math.round(byte) / 10;

  const pedal1Dial1Raw = b[0x24] | (b[0x25] << 8);
  const pedal1Dial1Semantic = pedal1Dial1Raw - Math.floor(pedal1Dial1Raw / 0x100) * 0x80;

  const pedal2Dial1LowHigh = b[0x2d] | (b[0x2e] << 8);
  const pedal2Dial1Offset = b[0x27] === 0x20 ? 0x80 : 0x00;
  const pedal2Dial1Semantic = pedal2Dial1LowHigh + pedal2Dial1Offset;

  return {
    programName: name,
    amplifier: {
      model: ampModelKey,
      noiseReductionSensitivity: u(b[0x12]),
      gain: u(b[0x15]),
      treble: u(b[0x16]),
      middle: u(b[0x18]),
      bass: u(b[0x19]),
      volume: u(b[0x1a]),
      presence: u(b[0x1b]),
      resonance: u(b[0x1c]),
      brightCap: !!b[0x1d],
      lowCut: !!b[0x1e],
      midBoost: !!b[0x20],
      tubeBias: tubeBiasKey,
      ampClass: ampClassKey,
    },
    pedal1: {
      type: pedal1TypeKey,
      enabled: !!(flags & 0b0000_0010),
      dial1Semantic: pedal1Dial1Semantic,
      dial2: b[0x26], dial3: b[0x28], dial4: b[0x29], dial5: b[0x2a], dial6: b[0x2b],
    },
    pedal2: {
      type: pedal2TypeKey,
      enabled: !!(flags & 0b0000_0100),
      dial1Semantic: pedal2Dial1Semantic,
      dial2: b[0x30], dial3: b[0x31], dial4: b[0x32], dial5: b[0x33], dial6: b[0x34],
    },
    reverb: {
      type: reverbTypeKey,
      enabled: !!(flags & 0b0001_0000),
      mix: u(b[0x40]), time: u(b[0x41]), preDelayMs: b[0x42], lowDamp: u(b[0x43]), highDamp: u(b[0x44]),
    },
  };
}

module.exports = {
  MANUFACTURER_ID,
  PROGRAM_SLOTS,
  AMP_MODELS,
  PEDAL1_TYPES,
  PEDAL2_TYPES,
  REVERB_TYPES,
  encodeProgram,
  decodeProgram,
  buildWriteUserProgramMessage,
  buildPersistUserProgramMessage,
  buildRequestUserProgramMessage,
  isAck,
};
