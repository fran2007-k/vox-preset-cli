# vox-preset-cli

A standalone Node.js CLI that writes (and reads) VOX VT20X/40X/100X amp
presets directly over MIDI, from a JSON file. No browser, no WebMIDI, no
live-editing dance -- it uses the amp's "Write User Program" + "Persist User
Program" SysEx messages to commit a complete preset in one shot.

It's a from-scratch re-implementation of the wire protocol documented in
[tmarsteel/vox-amp-librarian](https://github.com/tmarsteel/vox-amp-librarian)'s
`doc/protocols/vt_20_40_100_x.md` and implemented in that repo's Kotlin source
(`src/main/kotlin/.../protocol/Program.kt` and friends) -- see
`lib/protocol.js` for the byte-level encoder/decoder. This is a standalone
sibling project, not a fork or part of that repo -- it shares no code or
build tooling with it, only the wire protocol. If you have that repo cloned
locally too (e.g. as `../vox-amp-librarian`), its docs are worth cross
referencing, but this tool doesn't depend on it being present.

## AI involvement (honest disclosure)

This tool was written by [Claude](https://claude.com/claude-code) (Anthropic's
Sonnet 5 model, via Claude Code), in an interactive session with the repo
owner, who directed the work but did not hand-write the code. Concretely:

- Claude read `tmarsteel/vox-amp-librarian`'s Kotlin protocol source and its
  `doc/protocols/vt_20_40_100_x.md` doc, and ported the byte-level encoding
  logic (`lib/protocol.js`) from that Kotlin code into this JavaScript
  implementation.
- Claude wrote all of the code in this repo (`lib/protocol.js`, `lib/midi.js`,
  `apply-preset.js`, this README) in one sitting.
- Claude chose the MIDI library (`@julusian/midi`) and the overall CLI shape
  (`list-ports` / `write` / `read`) after the owner picked "standalone CLI"
  over "a feature inside the web app" as the architecture.
- Testing against real hardware (a physical VOX VT40X) was done interactively
  with the owner present and approving each step — Claude does not have
  unsupervised access to anyone's amp.
- While building this, Claude found and fixed a real bug: the upstream web
  app's Chorus effect silently discards its own Depth/Manual/Mix settings
  whenever a program also carries a Pedal 2 config, because both are wired to
  the same underlying protocol bytes and Pedal 2 is serialized second. This
  was confirmed by reading raw bytes back from real hardware, not just
  inferred from source. See the "protocol quirk" section below for the
  detailed writeup — that account is as accurate as the actual debugging
  session it summarizes, not written after the fact for appearances.
- There is no automated test suite. Correctness has been checked by: (a) a
  `--dry-run` decode-what-would-be-sent check, (b) round-tripping a real
  write against a live amp and reading the raw stored bytes back to confirm
  they match, both witnessed by the owner in the same session that produced
  this code.

If you're evaluating whether to trust this code: read `lib/protocol.js`
yourself and cross-check it against the upstream Kotlin source linked above —
don't take either the owner's or Claude's word for it.

## Setup

```bash
cd vox-preset-cli
npm install
```

Requires the amp connected via USB and powered on, and **nothing else**
holding the MIDI connection (close the vox-amp-librarian browser tab, quit
VOX Tone Room, etc. -- only one client can talk to the amp at a time).

## Usage

```bash
# see what MIDI ports are visible
node apply-preset.js list-ports

# write a preset to the amp (uses "targetSlot" from the JSON, or pass --slot)
node apply-preset.js write presets/money-for-nothing.json
node apply-preset.js write presets/money-for-nothing.json --slot A3

# just see the encoded bytes without touching the amp
node apply-preset.js write presets/money-for-nothing.json --dry-run

# read back what's ACTUALLY stored in a slot right now, decoded from the
# amp's own bytes -- not from any app's cached/optimistic state
node apply-preset.js read A2
```

`read` is the important one for trust: it's a direct round-trip against the
hardware, so it tells you the truth regardless of what any UI (this tool's
own `write`, or the web app) thinks it did.

## JSON preset format

```json
{
  "programName": "MoneyForNothing",
  "targetSlot": "A2",
  "amplifier": {
    "model": "DELUXE_CL_NORMAL",
    "gain": 3.5, "treble": 7.0, "middle": 4.5, "bass": 4.0, "volume": 6.0,
    "presence": 6.0, "resonance": 6.0, "noiseReductionSensitivity": 3.0,
    "brightCap": false, "lowCut": false, "midBoost": false,
    "tubeBias": "OFF", "ampClass": "A"
  },
  "pedal1": { "type": "CHORUS", "enabled": true, "params": { "speedHz": 0.8, "depth": 6.5, "manual": 5.7, "mix": 6.0 } },
  "pedal2": { "type": "TREMOLO", "enabled": false },
  "reverb": { "type": "ROOM", "enabled": true, "params": { "mix": 2.5, "time": 3.5 } }
}
```

Any field you omit falls back to the same default the web app uses. See
`lib/protocol.js` for the full list of valid `amplifier.model` /
`pedal1.type` / `pedal2.type` / `reverb.type` values and each pedal type's
own parameter names (they differ per effect -- e.g. Compressor has
`sens`/`level`/`attack`/`voice`, Chorus has `speedHz`/`depth`/`manual`/`mix`,
Tremolo has `speedHz`/`depth`/`duty`/`shape`/`level`, etc.).

Program names are capped at 16 ASCII characters (the amp's own limit).

## A protocol quirk this tool works around

The original app's Kotlin source (`appmodel/slot1pedals.kt`,
`ChorusPedalDescriptor`) maps Chorus's `depth`/`manual`/`mix` onto the exact
same wire bytes as Pedal 2's `dial2`/`dial3`/`dial4` (whatever Pedal 2's
type calls those -- e.g. Tremolo's depth/duty/shape). This looks like a
real reverse-engineering artifact (the doc says the whole protocol was
sniffed via Wireshark), not a typo -- so this tool replicates the same wire
layout rather than "fixing" it into an unverified new one.

But the original app applies Pedal 1 *before* Pedal 2 when serializing a
full program, so Pedal 2's value always silently overwrites Chorus's in the
bytes actually sent to the amp -- Chorus's depth/manual/mix are effectively
discarded whenever a program also carries a Pedal 2 config, even a
*disabled* one. We hit this for real: a "Money For Nothing" preset built
through the browser app's live editor *looked* right in the UI forever
after, but reading the actual stored bytes back showed the amp had Pedal
2's leftover values instead.

This CLI resolves the collision the other way: when `pedal1.type` is
`CHORUS`, its `depth`/`manual`/`mix` win and get written into those shared
bytes, since Chorus is presumably the pedal you actually want to hear. The
tradeoff: if you inspect that slot in the web app while Pedal 1 is Chorus,
Pedal 2's own depth/manual-ish knobs will show Chorus's numbers instead of
whatever Pedal 2 itself was configured with. Harmless if Pedal 2 is
disabled (as in the example preset); worth knowing if you rely on Pedal 2
being simultaneously active alongside Chorus.
