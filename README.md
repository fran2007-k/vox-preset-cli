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

## Goal

To easily use, share, and generate presets for the VOX VT-series amps
(VT20X/40X/100X), and apply them to the amp effortlessly, bypassing VOX's
own unmaintained ToneRoom software.

Not affiliated with, endorsed by, or supported by VOX, KORG, or any
related entity. This is an independent, unofficial tool built by
reverse-engineering the amp's own USB-MIDI protocol for interoperability,
without copying any VOX software or code.

## Acknowledgments

None of this exists without [Tobias Marstaller](https://github.com/tmarsteel)'s
work on [vox-amp-librarian](https://github.com/tmarsteel/vox-amp-librarian).
Reverse-engineering a closed USB-MIDI protocol from scratch, sniffing real
traffic with Wireshark, working out byte layouts and quirky encodings by
hand, and then writing them up clearly enough that someone else could pick
them up cold, is real, patient work, and it's the only reason anything in
`lib/protocol.js` was possible. I didn't rediscover any of that protocol
knowledge myself; I built a different tool on top of it.

## AI involvement (honest disclosure)

This tool was written by [Claude](https://claude.com/claude-code) (Anthropic's
Sonnet 5 model, via Claude Code), in an interactive session with the repo
owner, who directed the work but did not hand-write the code. Concretely:

- Claude read `tmarsteel/vox-amp-librarian`'s Kotlin protocol source and its
  `doc/protocols/vt_20_40_100_x.md` doc, and ported the byte-level encoding
  logic (`lib/protocol.js`) from that Kotlin code into this JavaScript
  implementation.
- Claude wrote all of the code in this repo (`lib/protocol.js`, `lib/midi.js`,
  `apply-preset.js`, `gui/`, this README), across four sessions with the
  same owner: the initial `write`/`read` implementation, then `dump` plus
  the parameter reference tables (added when the owner pointed out the first
  version left "how do I write the JSON in the first place"
  underdocumented), then the `gui/` web launcher (scoped down from "full
  knob editor" to "preset launcher" specifically to avoid duplicating what
  vox-amp-librarian already does well), then `play`/"Current Rig" (live
  audition without writing to a slot, requested so writing to a slot didn't
  have to be the only way to hear a preset).
- Building `play` surfaced a real, narrow hardware quirk (Chorus Speed's
  readback via "Request Current Program" specifically) that Claude found by
  writing an isolated test and reading raw bytes back from the amp, not by
  reasoning about the protocol doc alone -- documented above and in the
  code rather than glossed over. The first version of the ACK-waiting logic
  also had a real bug (assumed the amp's first reply to a live message was
  always the ACK; it sometimes wasn't), caught the same way: real hardware
  behaved differently than assumed, so the assumption got fixed, not
  explained away.
- Claude chose the MIDI library (`@julusian/midi`) and the overall CLI shape
  (`list-ports` / `write` / `read` / `dump`) after the owner picked
  "standalone CLI" over "a feature inside the web app" as the architecture.
- The parameter reference tables (amp models, pedal types, their param names
  and ranges) were transcribed by Claude from `lib/protocol.js`'s own
  descriptor tables, which were themselves ported from the Kotlin source —
  i.e. two hops removed from the original reverse-engineering. If a table
  here and the code ever disagree, trust the code.
- Testing against real hardware (a physical VOX VT40X) was done interactively
  with the owner present and approving each step — Claude does not have
  unsupervised access to anyone's amp.
- A later session added a single-knob live Volume control and the
  dropdown-based Current Rig picker (replacing an earlier version that
  listed every preset as its own card, and before that a plain `<select>`
  the owner explicitly asked to be replaced with something that matched
  the rest of the page). Also found, in that same session: Phaser "Depth"
  never accepts a live update at all (tested exhaustively, not assumed),
  and Phaser "Manual" read back a different value than was sent despite
  being acknowledged -- flagged as unresolved rather than guessed at,
  since audio correctness can't be verified without physically hearing it.
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

## GUI (optional)

If you'd rather click than type, there's a small local web GUI:

```bash
./run-gui
# or: npm run gui
```

`./run-gui` starts the server and opens it in your default browser
automatically (real browser, real tab -- it uses macOS's `open` command).
`npm run gui` just starts the server without opening anything, if you'd
rather control that yourself.

Either way it prints the URL (`http://localhost:4242` by default). It has
three parts:

- **Current Rig** -- pick a preset from the dropdown and hit Play Now to
  hear it instantly (nothing saved, see "play" below). Also has a Volume
  slider that sets the amp's live Volume directly, on its own, without
  loading a whole preset -- drag and release to apply.
- **Presets** -- Preview inspects a preset's decoded values with zero MIDI;
  Write to Amp is permanent, with a confirm prompt.
- **Dump** -- pulls a slot's sound off the amp as a new preset file.

The Current Rig dropdown is a small custom component (not a native
`<select>`), styled to match the rest of the page and showing each
preset's amp/pedal/reverb summary inline so you don't have to open
something else to remember what's in it.

It's a preset launcher, not a knob editor -- there are no sliders/dials
here. For live knob-by-knob tweaking, use vox-amp-librarian's browser app;
this GUI is for managing/sharing/applying whole presets as files. All the
actual MIDI I/O happens in the Node process (same `lib/protocol.js` and
`lib/midi.js` the CLI uses) -- the browser page itself never touches MIDI,
so there's no WebMIDI permission prompt and nothing extra to trust in the
frontend beyond what's already in this repo.

## Usage

```bash
# see what MIDI ports are visible
node apply-preset.js list-ports

# make the amp sound like a preset RIGHT NOW -- nothing is written to any
# slot, this is the "current rig" / audition command
node apply-preset.js play presets/money-for-nothing.json

# write a preset to the amp (uses "targetSlot" from the JSON, or pass --slot)
node apply-preset.js write presets/money-for-nothing.json
node apply-preset.js write presets/money-for-nothing.json --slot A3

# just see the encoded bytes without touching the amp
node apply-preset.js write presets/money-for-nothing.json --dry-run

# read back what's ACTUALLY stored in a slot right now (raw dial-by-dial),
# decoded from the amp's own bytes -- not from any app's cached state
node apply-preset.js read A2

# read the amp's CURRENT LIVE state instead (what it actually sounds like
# right now, e.g. after "play") -- no slot argument
node apply-preset.js read

# pull a slot's sound off the amp as a ready-to-edit preset JSON
node apply-preset.js dump A1
node apply-preset.js dump A1 --out presets/funky.json
```

`read` and `dump` decode the same underlying bytes; `read` prints raw dial
numbers (good for debugging/verifying), `dump` prints/saves the same shape
`write` accepts (good for generating a preset without writing JSON from
scratch -- tweak a couple of values in the dumped file and write it
straight back, or to a different slot).

## `play` vs `write`: audition vs commit

- **`play`** sends live "dial turned" messages -- the same mechanism the
  amp's own physical knobs use -- to whatever slot is currently active.
  Nothing is written to persistent memory. Power-cycling the amp, or
  switching to a different slot, reverts it. Use this to just *hear* a
  preset without deciding yet whether to keep it anywhere. This is what
  the GUI's "Current Rig" section does.
- **`write`** persists the preset into a specific slot's memory via
  "Write User Program" + "Persist User Program". This is permanent (until
  overwritten) and survives power cycles.

Both take the exact same preset JSON -- there's no format difference, just
pick the command for what you're trying to do right now.

One caveat found while building `play`, verified by isolated testing
against real hardware (not just reasoning from the protocol doc): reading
the amp's current live state back (`read` with no slot, or the GUI
equivalent) misreports Chorus's Speed dial specifically -- every other
field, including the structurally identical Pedal 2 speed dial, round-trips
correctly. `play` still sets Chorus's Speed correctly (the amp appears to
normalize the value internally for actual playback); it's only reading it
back afterward via this specific command that's affected. See the comment
above `buildRequestCurrentProgramMessage()` in `lib/protocol.js` for the
full isolated-test writeup.

**Known limitation, confirmed by testing every value from 0.1-20.0 against
real hardware:** Phaser "Depth" (`BLK_PHASER` / `ORG_PHASER_1` /
`ORG_PHASER_2`, `pedal2.params.depth`) never accepts a live update to a
nonzero value -- the amp simply never ACKs it, at any value, regardless of
encoding. `0.0` (the default) is the only value that works live. `play`
reports this per-field rather than failing the whole sequence (see below);
`write` is unaffected, since it persists the whole program as one blob
rather than one message per field.

Separately, and **not fully resolved**: reading Phaser's "Manual" position
back after a successful `play` (i.e. the CLI reported it as ACKed) showed a
value that didn't match what was sent. This might be the same class of
readback-only quirk as Chorus's Speed above, or a genuine gap in the
Phaser `liveDial` mapping in `lib/protocol.js` -- I wasn't able to
distinguish the two from bytes alone. If a Phaser preset's modulation
sounds off, this is the first thing to suspect; `write`ing the same preset
to a slot and comparing bypasses `play` entirely and is a good way to
isolate whether it's a `play`-specific issue.

`play` (both the CLI and the GUI) sends every message in a preset even if
an earlier one fails, and reports exactly which fields (by name, e.g.
`pedal2.params.depth`) the amp didn't accept, rather than aborting the
whole sequence on the first failure.

## Generating a preset JSON

Two ways to get one:

1. **Start from what's already on the amp**: `node apply-preset.js dump A1 --out mine.json`, edit the numbers, `node apply-preset.js write mine.json --slot A3`.
2. **Write one from scratch**, using the reference below.

### Amp models (`amplifier.model`)

| Key | Bright Cap switch | Notes |
|---|---|---|
| `DELUXE_CL_VIBRATO` | yes | Fender '65 Deluxe Reverb Vibrato Channel |
| `DELUXE_CL_NORMAL` | no | Fender '65 Deluxe Reverb Normal Channel |
| `TWEED_410_BRIGHT` | yes | Fender Bassman 4x10 Bright Channel |
| `TWEED_410_NORMAL` | no | Fender Bassman 4x10 Normal Channel |
| `BOUTIQUE_CL` | yes | Overdrive Special Clean Channel |
| `BOUTIQUE_OD` | yes | Overdrive Special Overdrive Channel |
| `VOX_AC30` | yes | VOX AC30 |
| `VOX_AC30TB` | yes | VOX AC30TB |
| `BRIT_1959_TREBLE` | yes | Marshall JTM Treble |
| `BRIT_1959_NORMAL` | no | Marshall JTM Normal |
| `BRIT_800` | yes | Marshall JCM-800 |
| `BRIT_VM` | yes | Marshall JVM-410 |
| `SL_OD` | yes | Soldano SLO-100 |
| `DOUBLE_REC` | yes | Mesa Boogie Dual Rectifier |
| `CALI_ELATION` | yes | Cali Elation |
| `ERUPT_III_CH2` | no | Peavey 5150 III Channel 2 |
| `ERUPT_III_CH3` | yes | Peavey 5150 III Channel 3 |
| `BOUTIQUE_METAL` | no | Diezel VH4 |
| `BRIT_OR_MKII` | yes | Orange Super Crush 100 |
| `ORIGINAL_CL` | yes | No additional simulation, just the VTX amp |

`amplifier` also takes: `gain`, `treble`, `middle`, `bass`, `volume`,
`presence` (`0.0`-`10.0` each, default `5.0`/`5.0`/`5.0`/`5.0`/`5.0`/`2.0`),
`resonance` (default `7.5`), `noiseReductionSensitivity` (default `3.0`),
`brightCap`/`lowCut`/`midBoost` (booleans, default `true`/`false`/`false` --
`brightCap` only has an audible effect on models that support it, but the
byte is always written), `tubeBias` (`"OFF"` / `"COLD"` / `"HOT"`, default
`"OFF"`), `ampClass` (`"A"` / `"AB"`, default `"A"`).

### Pedal 1 (`pedal1.type`)

| Key | `params` |
|---|---|
| `COMP` | `sens` (0-10, def 5.0), `level` (0-10, def 6.7), `attack` (0-10, def 5.7), `voice` (`"ONE"`\|`"TWO"`\|`"THREE"`, def `"TWO"`) |
| `CHORUS` | `speedHz` (0.1-10.0 Hz, def 0.1), `depth` (0-10, def 6.7), `manual` (0-10, def 5.7), `mix` (0-10, def 1.0), `lowCut`/`highCut` (bool, def false) -- see the protocol quirk section, `depth`/`manual`/`mix` share bytes with Pedal 2 |
| `OVERDRIVE` (Tube OD), `GOLD_DRIVE`, `TREBLE_BOOST`, `RC_TURBO`, `ORANGE_DIST`, `FAT_DIST`, `BRIT_LEAD`, `FUZZ` | `drive` (0-10, def 5.0), `tone` (0-10, def 6.7), `level` (0-10, def 5.7), `treble`/`middle`/`bass` (0-10, def 5.0 each) |

### Pedal 2 (`pedal2.type`)

| Key | `params` |
|---|---|
| `FLANGER` | `speedHz` (0.1-5.0 Hz, def 0.1), `depth` (0-10, def 5.0), `manual` (0-10, def 7.7), `lowCut`/`highCut` (bool, def false), `resonance` (0-10, def 3.5) |
| `BLK_PHASER`, `ORG_PHASER_1`, `ORG_PHASER_2` | `speedHz` (0.1-10.0 Hz, def 0.1), `resonance` (0-10, def 5.0), `manual` (0-10, def 7.7), `depth` (0-10, def 0.0) |
| `TREMOLO` | `speedHz` (1.65-10.0 Hz, def 1.65), `depth` (0-10, def 5.0), `duty` (0-10, def 7.7), `shape` (0-10, def 0.0), `level` (0-10, def 1.0) |
| `TAPE_ECHO`, `ANALOG_DELAY` | `timeMs` (30-1200 ms, def 30), `level` (0-10, def 5.0), `feedback` (0-10, def 7.7), `tone` (0-10, def 5.0), `modSpeed` (0-10, def 0.1), `modDepth` (0-10, def 0.0) |

### Reverb (`reverb.type`)

Same `params` for every type: `mix` (0-10, def 7.5), `time` (0-10, def 4.5),
`preDelayMs` (0-70 ms, def 0), `lowDamp` (0-10, def 3.6), `highDamp` (0-10,
def 2.5).

Types: `ROOM`, `SPRING`, `HALL`, `PLATE`.

---

Any field you omit falls back to the defaults listed above (same defaults
the web app uses). Program names are capped at 16 ASCII characters (the
amp's own limit). The full source of truth, if this table and the code
ever disagree, is `lib/protocol.js` -- these tables are generated by hand
from it, not the other way around.

A full example (this is `presets/money-for-nothing.json`):

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

## License

MIT, plus the [Commons Clause](https://commonsclause.com/). Plain-language
summary (the [LICENSE](LICENSE) file is what actually governs): free to
use, modify, and share, including inside your own commercial projects --
the one thing you can't do is sell this software itself, or sell a
product/service whose value comes mainly from it (e.g. repackaging it as a
paid tool). This isn't an OSI-approved "open source" license because of
that restriction, but the source is fully open and everything else about
MIT still applies.
