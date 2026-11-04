# Vocal Studio

[![CI](https://github.com/saymirr/vocal-studio/actions/workflows/ci.yml/badge.svg)](https://github.com/saymirr/vocal-studio/actions/workflows/ci.yml)

A free vocal mixing and mastering studio that runs entirely in your browser. Record or import vocals, clean them up, tune them, mix them over a beat, master the result and export a WAV — no account, no install, no upload. Your audio never leaves your computer.

It's a single file, [`index.html`](index.html), with no dependencies and no build step. It uses the Web Audio API and works offline.

## Quick start

**Use it online:** <https://saymirr.github.io/vocal-studio/> (deployed automatically from `main`; everything still runs locally in your browser, and your audio is never uploaded).

**Or run it yourself — easiest:** download `index.html` and double-click it (Chrome or Edge recommended).

**If the microphone doesn't work from a double-clicked file**, serve it locally:

```bash
# macOS / Linux
python3 -m http.server 8000

# Windows
python -m http.server 8000
```

then open <http://localhost:8000>.

## Features

| Area | What you get |
| --- | --- |
| **Input** | Record from your microphone (with backing tracks playing), import audio or video files, drag and drop. Multi-track, with per-track volume, pan, mute, solo and a millisecond offset to fix recording latency. |
| **Clean-up** | Low-cut filter, input trim, and a **noise gate** with look-ahead (so word onsets aren't clipped), hold, attack, release and reduction depth. |
| **Auto-tune** | Pitch correction to a chosen key and scale (chromatic, major, minor, pentatonic, blues). Retune speed from 0 ms (hard, robotic) to 400 ms (natural) and an amount control. |
| **Pitch graph** | Piano-roll view of the detected notes, the raw pitch curve and the corrected curve, with a moving playhead and a hover read-out (note, cents, Hz). |
| **Vocal chain** | 3-band EQ with presence and air, split-band **de-esser**, compressor, warmth (saturation), delay and reverb. Presets for pop, rap, airy, warm, lo-fi and harsh voices. |
| **Mastering** | Master EQ, glue compressor, limiter with a hard ceiling, loudness drive and presets. |
| **Loudness** | Live peak meter, integrated LUFS analysis, and **Auto-level** to -14 / -16 / -11 / -9 LUFS. |
| **Spectrum** | Live log-frequency spectrum of the master output with peak hold and a marked sibilance zone. |
| **Undo / redo** | Up to 80 steps for every setting, mute/solo, clip move, rename, add/delete track and the whole master chain. A slider drag counts as one step, a deleted track comes back with its audio, and gate/auto-tune are re-applied automatically. `Ctrl+Z` / `Ctrl+Shift+Z` (or `Ctrl+Y`). |
| **Metronome & grid** | Set the BPM (or **tap it in**) and time signature (1–16 over 4 or 8). A sample-accurate **click** with an accented downbeat plays with the transport, with an optional **1–2 bar count-in before recording**. A bar/beat **grid** appears on the ruler and lanes, and clip drags and loop regions **snap to beats** (hold Shift for free movement). A grid offset lines bar 1 up with an imported beat. Click and grid are monitoring aids and are never included in exports. Tempo settings are saved in projects and covered by undo. |
| **Vocal doubler** | Thickens a lead with 1–2 artificial "second takes": pitch-shifted copies of the vocal (the same PSOLA engine as auto-tune, not a chorus) that are **detuned**, **drift slowly in pitch** like a human take, **delayed** 0–80 ms, **darkened** and **panned wide**. Controls: double level, detune, pitch drift, time offset, stereo spread, brightness, and 1 or 2 voices; presets for subtle, wide-pop and tight doubles. It follows the *tuned* vocal when auto-tune is on. The lead stays exactly as it was and the clip becomes stereo. Everything is seeded, so exports are repeatable. Check the result in mono — wide doubles can thin out when summed. |
| **Harmonizer** | Up to three harmony voices that **follow the lead and stay in your key**. Set the song's key and scale (major, minor, dorian, mixolydian, harmonic minor), then choose each voice's interval — −octave, −6th, −5th, −4th, −3rd, +3rd, +4th, +5th, +6th, +octave — counted in *scale steps*, so a "3rd above" is a major or minor third depending on the note being sung. Voices are pitch-shifted with the same PSOLA engine as auto-tune and the doubler. **Pitch lock** chooses between a dead-in-tune harmony (100%) and one that inherits the lead's wobble (0%); voices are also delayed, darkened, humanized and spread across the stereo field (voice 1 left, voice 2 right, voice 3 centre). It follows the *tuned* vocal when auto-tune is on, can be combined with the doubler (harmonies are built from the lead, not the doubles), and has presets for 3rd above/below, 3rd + 5th, octave stacks and a choir. |
| **Clip splitting** | Cut a clip at the playhead with **✂ Split** or the `S` key (`Shift+S` cuts every clip under the playhead), or **double-click** a clip to split exactly there (snaps to the grid when it is on, Shift = free). The right half becomes a new track directly below with identical settings; fades stay on the outer edges only. Delete the part you don't want, or drag the pieces apart to re-arrange a take. Undo restores the whole clip. |
| **Fades** | Per-track **fade in / fade out** (up to 10 s) with linear, equal-power or S-curve shapes. Set them with the sliders in *Track FX → Fades* or by **dragging the white handles** at the top corners of a clip (they snap to the grid when it is on, Shift = free). Fades are applied before the effects chain (so reverb and delay tails ring out naturally) and are identical in playback, mix export and stems. They are saved in projects and covered by undo. |
| **Timeline** | Drag clips to reposition them, drag on the ruler to set a **loop region**, click the ruler to seek. |
| **Export** | 16-bit (dithered) or 24-bit WAV, or **MP3** at 128 / 192 / 256 / 320 kbps (constant bit rate, stereo, 44.1 or 48 kHz; other sample rates are converted). **Stems** are always WAV: one WAV per track in a `.zip`, all the same length so they line up in any DAW. |
| **Projects** | Save and open `.vstudio` files containing your audio and every setting. **Autosave** keeps a recovery copy in your browser every 10 seconds and offers to restore it if the tab was closed. |

## MP3 export and the `vendor/` folder

Browsers can't write MP3 natively, so MP3 export uses [lamejs](https://github.com/zhuker/lamejs) (a JavaScript port of the LAME encoder, **LGPL-3.0**). To keep `index.html` free of third-party code, lamejs lives as a separate, unmodified file in [`vendor/`](vendor/) and is loaded **only when you export an MP3**:

1. from `vendor/lame.min.js` next to `index.html` (this is what the hosted site and a cloned repo use), then
2. as a fallback, from a pinned jsDelivr URL with a Subresource Integrity hash (so a downloaded lone `index.html` can still make MP3s while online).

If neither can be loaded you get a clear message, and WAV export keeps working offline. MP3 files carry no ID3 tags and have the usual ~25 ms encoder delay, which is why stems stay WAV and WAV is the format to archive or keep editing. Encoding runs at roughly 8× real time (about 20 s for a 3-minute song) with a progress readout. Aim for a master ceiling of −1 dB or lower so MP3's inter-sample peaks don't clip.

## Using it

1. **Add audio** with *Import audio* or *Record*. Wear headphones when recording over a beat, and use the *ms* field on the track to nudge a take that sounds late.
2. **Shape each track** in the *Track FX* tab: gate → EQ → de-esser → compressor → warmth/delay/reverb. Double-click any slider to reset it.
3. **Tune it** (optional): open the *Pitch graph* tab, press *Analyze pitch*, set the key and scale, enable *Auto-tune* and watch the corrected curve snap to the notes.
4. **Master the mix** in the *Master / Mastering* tab, then use *Auto-level master* to hit a loudness target.
5. **Export** the mix as WAV or MP3, and **Save project** (Ctrl+S) to come back to it later.

Keyboard: `Space` play/pause, `Home` go to start, `S` split, `Shift+S` split all, `Ctrl+S` save project, `Ctrl+Z` undo, `Ctrl+Shift+Z` / `Ctrl+Y` redo.

**Tempo:** type a BPM in the top bar (or use *Tempo & grid* → *Tap tempo*), switch on **🎵 Click** and **▦ Grid**. If a recording sounds early or late against the click, use the track's *ms* offset. **Loop:** drag across the time ruler to select a region (looping turns on), then use the 🔁 Loop button to switch it on or off. **Move a take:** drag its waveform left or right. **Stems:** *Stems (.zip)* exports each track after its own effects but before the master chain, ready for another DAW or an engineer.

## Project files (`.vstudio`)

A single binary file: the magic string `VSTUDIO1`, a little-endian `uint32` length, a JSON document (track and master settings, plus where each track's audio lives), then the raw 32-bit float PCM of each track's **original, unprocessed** audio. Gate and auto-tune are stored as settings and re-applied when a project is opened, so saving is lossless and re-tuning stays editable. Projects are about as large as the raw audio (roughly 10 MB per minute for a mono track at 48 kHz).

## How it works

- **Live signal chain:** per-track Web Audio graph (filters, split-band compressor, dynamics, convolution reverb) feeding a master chain. The same builder functions are used for playback and for the offline render, so what you hear is what you export.
- **Noise gate:** an offline, look-ahead processor on 1 ms blocks with linear-in-dB ramps.
- **Auto-tune:** YIN pitch detection on a decimated mono mix, pitch-mark placement on glottal peaks, then time-domain PSOLA to re-space the grains at the corrected period (duration is preserved). Pitch analysis is cached per track, so changing key, scale or speed re-renders quickly.
- **Loudness:** K-weighted, gated integrated loudness following the ITU-R BS.1770 method (approximate filter implementation), used by *Analyze loudness* and *Auto-level*.

## Limitations

- Auto-tune, the doubler and the harmonizer work best on a **dry, solo, monophonic** vocal. Harmonies are pitch-shifted copies of the lead (they re-use its words and timing), and shifts beyond about an octave start to sound unnatural. Heavy reverb, harmonies or backing music in the same track will confuse the pitch tracker. It is a practical corrector, not a replacement for commercial tools on extreme corrections.
- The LUFS figure is an approximation; verify against a dedicated meter if a platform is strict.
- No cloud saving, collaboration, sample library or mobile app. Autosave is a recovery copy in *this browser only* (it is lost if you clear site data or use a private window), so still save a `.vstudio` file with Ctrl+S for anything you care about.

## Development

There is no build step; edit `index.html` and reload.

```bash
npm install
npx playwright install chromium   # first time only
npm test
```

The tests in [`tests/app.test.js`](tests/app.test.js) load the page in headless Chromium and exercise the audio engine with synthetic signals: noise gate depth, auto-tune accuracy, loudness targeting, WAV output, project round-trips, the pitch graph, stem ZIP validity, loop playback, clip dragging, autosave/restore, the spectrum analyzer, undo/redo, the tempo grid, metronome scheduling, snapping and count-in, fade math, handles and persistence, the vocal doubler (voice pitch, level, delay, tuned-source and caching), the harmonizer (diatonic intervals in major and minor, octaves, pitch lock, level, pipeline), clip splitting, and MP3 export (valid frames, size, decoded SNR, mono and 96 kHz input, the download button, and the missing-encoder error path) (contiguity, seamless mix, undo/redo, keyboard and double-click). If your machine already has a Chromium binary, point `CHROMIUM_PATH` at it instead of installing one.

### Continuous integration

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs the test suite on every push to `main` and on every pull request, and uploads a screenshot of the pitch graph as a build artifact. [`.github/workflows/pages.yml`](.github/workflows/pages.yml) publishes `index.html` to GitHub Pages on every push to `main`.
