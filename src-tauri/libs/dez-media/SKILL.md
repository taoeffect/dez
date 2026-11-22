# dez-media

Dez's own library: the measurements of sound and video (beats, onsets, align, cuts, sync), signal functions with the
names and the results of NumPy, tables of CSV and JSON data, the checks of the parameters and the inputs of a script
app, result files, animated titles, and frame sequences.
The source is in this folder: read a file for the details of a function.

## Import

| Name | Has | Loads in |
| --- | --- | --- |
| `dez-media` | all but the two below | a script app, `js_eval`, a UI page |
| `dez-media/canvas` | `useShippedFonts`, `titleLayer`, `drawTitleFrame` | a script app with `"native": ["skia-canvas"]` |
| `dez-media/frames` | `FrameWriter` | a script app |

```js
import { beatGrid, f32Samples } from "dez-media"           // a script app, a UI page
const { beatGrid } = await import("dez-media")              // js_eval: a literal name
```

## The built-in apps

`dez-beats`, `dez-onsets`, `dez-align`, `dez-cuts`, `dez-sync`, `dez-title`, and `dez-chart` use this library. The
`audio` and `video` tools run the first six (`audio beats`, `video cuts`, …). Their code is in
`/apps/dez-<name>/main.ts`. You can read and run a built-in app, but not change it: to start an app of your own,
make it with `apps init` and write a copy of the code into it.

## The samples and the frames of a clip

`apps invoke` decodes the input clips of a script app before the run: the `decode` parameter of the call, else the
field `decode` of the `manifest.json` of the app, as in
`{"audio": {"rate": 22050}, "frames": {"width": 96, "height": 54, "fps": 24}}`. The call's `decode` takes the place
of the manifest's as a whole, and `{}` decodes nothing. Each clip of `dez.inputs` then has:

- `audio: { path, rate, count }`: the sound as one channel of float32 samples (`count` samples), from 1000 to
  192000 samples a second.
- `frames: { path, width, height, fps, count }`: the frames as RGB, 3 bytes each pixel. With no `fps` in the decode,
  each frame of the clip comes once, and `fps` is the rate of the clip, or null when it has none.

Each one is absent when the decode does not ask for it, and null for a clip with no such stream. The decoded files
of one run are at most 2 GiB together.

```ts
const samples = f32Samples(await Deno.readFile(input.audio.path))                  // Float32Array
const frames = rgbFrames(await Deno.readFile(input.frames.path), input.frames.width, input.frames.height)
// frames: { width, height, count, data }
```

`decodedSound("my-app", input)` gives `input.audio`, and `decodedFrames("my-app", input)` gives `input.frames`. Each
throws a RangeError that tells why a clip has none: an image (or no video), a `decode` of the call that left it out,
or a clip with no such stream.

## Measurements

Times are seconds. Each throws a RangeError with a text that tells why.

- `beatGrid(samples, rate = BEAT_RATE)` (22050): `{ duration, bpm, beats, downbeatPhase, downbeats, loudness,
  accents }`. `loudness` is dBFS for each 0.5 s; `accents` are up to 60 strong hits.
- `onsets(samples, rate = ANCHOR_RATE, { level = 0.3 })` (8000): `{ first, peak, onsets }`; `first` and `peak` are
  null for a clip with no sound.
- `align(clip, within, rate = ALIGN_RATE, { maxLag = 6, phases = 4 })` (8000): `{ offset, confidence }`, where
  `clip` starts in `within`. A confidence under 0.3 is no match.
- `cuts(frames, { fps, threshold = 0.35 })`: `{ cuts: [{ frame, time, score }], scores }`. Small frames are enough
  (96 × 54).
- `syncCheck(cutTimes, beatTimes, { offset = 0, tolerance = 0.042 })`: `{ cuts: [{ time, beat, error, offBeat }],
  meanError, maxError }`.

## Signal functions (as NumPy, in float64)

`hann(m)`, `rfft(x, n)` (gives `{ re, im }`; n a power of 2), `stft(y, { nfft = 2048, hop = 256, window })` (gives
`{ frames, bins, magnitude }`; bin b of frame f is `magnitude[f * bins + b]`), `diff`, `convolve(a, v, mode)`,
`correlate(a, v, mode)`, `argmax`, `argmin`, `mean`, `std`, `median`, `histogram(x, bins, range)` (gives
`{ counts, edges }`). The steps of `beatGrid`: `onsetEnvelope(spectrogram, lo, hi)`, `tempo(env, fps)` (gives
`{ bpm, period }`), `trackBeats(env, period)`.

## Parameters, data, and result files

- `checkParameterNames("my-app", parameters, ["level", "save_to"])` refuses a parameter that the app does not take:
  with a misspelled name, the run would else go on with the default value.
- `numberParameter(parameters, "level", (v) => v > 0 && v < 1, "a number more than 0 and less than 1") ?? 0.3` and
  `choiceParameter(parameters, "theme", ["light", "dark"])` (the first is the default) check one parameter. Each
  check throws a RangeError that tells how to fix the call.
- `csvTable(text, { delimiter })` and `jsonTable(JSON.parse(text))` give `{ columns, rows }`: a field is a number,
  a text, or null. `csvTable` throws a RangeError when two columns have one name. `numericColumns(table)` names the
  columns of numbers. `parseCsv` gives the raw records.
- `workFile(dez.workFolder, "/work/beats/song.json")` gives `{ path, shown }`: the file to open, and the path that
  you read. It refuses a path out of `/work/`.
- `resultFiles("beats", parameters, dez)` gives the `workFile` of each input: `/work/beats-<id>.json`, or the
  `save_to` parameter of a call with one input. `resultFile("align", parameters, dez, "/work/align.json")` gives the
  one file of a run: `save_to`, else the path that you give.
- `resultJson(value)` gives JSON text that code and a model both read well: one field on each line, and a list
  of numbers on one line. It writes no file: write the text to a file yourself. `roundTo(value, 3)` rounds a time
  to the millisecond.

## Frame sequences

A folder `<name>.frames` directly in `dez.outputFolder` is one clip: Dez encodes it after the run, and it counts as
one output file. It holds the frames from `000000.png` (or all raw RGBA: `000000.rgba`, 4 bytes each pixel) with no
gap, and `frames.json`: `{"fps": 30, "width": 1280, "height": 720, "count": 90, "alpha": false}`. The fps is from
0.01 to 240, a side at most 4096 pixels, and at most 36,000 frames. With no alpha the clip is H.264 in MP4 (the width
and the height must be even); with `"alpha": true` it is MOV with the PNG codec.

`new FrameWriter(dez.outputFolder, "intro", { fps, width, height, alpha })` writes such a folder:
`frames.add(canvas)` or `frames.add(rgbaBytes)` for each frame, then `frames.end()`. It throws at once for facts
out of these limits, and for a frame past the 36,000th.

## Titles

`titleMotion(time, { duration, entrance, exit, glint })` gives the state of an animated title at a time
(`TITLE_ENTRANCES`: slam, fade, none; `TITLE_EXITS`: glitch, fade, none). With skia-canvas:
`const layer = titleLayer({ width, height, text, families, subtitle })`, then for each frame
`drawTitleFrame(ctx, layer, titleMotion(i / fps, { duration }))`. `/apps/dez-title/main.ts` is the full app.
