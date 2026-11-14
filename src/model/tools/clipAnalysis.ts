import { FFMPEG_FIXED_ARGS } from './videoTool'

// What ffmpeg finds in a clip, from the lines that its filters write into
// the log: the filters, and the readers of their lines. The tools that run
// ffmpeg (assetView.ts, assetInfo.ts) put the filters into their runs; the
// log itself goes to the console only, as it can hold a path.

/** The score from which `scdet` counts the change from one frame to the
 *  next as a cut: the default of ffmpeg, whose documentation calls 8 to 14
 *  good values. A moving picture with no cut stays far under it.
 *  https://ffmpeg.org/ffmpeg-filters.html#scdet-1 */
export const SCENE_CUT_THRESHOLD = 10

/** The video filter that writes a log line for each cut between two shots
 *  (a sudden change of the whole picture), with its time (`cutTimes`). It
 *  passes every frame on, and the first frame of a run is never a cut. */
export const SCENE_CUT_FILTER = `scdet=threshold=${SCENE_CUT_THRESHOLD}`

// A line of `SCENE_CUT_FILTER`. ffmpeg writes the time of a frame in its
// stream as a plain decimal number, never with an exponent.
const SCENE_CUT = /\[Parsed_scdet_\d+ @ [^\]]*\] lavfi\.scd\.score: [\d.]+, lavfi\.scd\.time: (-?[\d.]+)/g

/** The times of the cuts in the log of a run with `SCENE_CUT_FILTER`, in
 *  seconds of its input, in order: the time of the first frame of each new
 *  shot. */
export function cutTimes(log: string): number[] {
  return Array.from(log.matchAll(SCENE_CUT), (match) => Number(match[1]))
}

/** A time of a frame or of a cut as the texts write it: to the
 *  millisecond, so that an `asset_view` call that gives it back (`times`)
 *  gets the same frame (`frameTarget`, assetView.ts). */
export function frameTimeText(seconds: number): string {
  return String(Number(seconds.toFixed(3)))
}

/** A check of a whole clip (`asset_info` `checks`): its black parts, its
 *  frozen parts, its silent parts, the loudness of each second, or its
 *  cuts. */
export type ClipCheck = 'black' | 'frozen' | 'silence' | 'loudness_curve' | 'cuts'

/** Every check, in the order of a result. */
export const CLIP_CHECKS: readonly ClipCheck[] = ['black', 'frozen', 'silence', 'loudness_curve', 'cuts']

/** Whether a check reads the picture of a clip or its sound. */
export const CHECK_STREAMS: Readonly<Record<ClipCheck, 'picture' | 'sound'>> = {
  black: 'picture',
  frozen: 'picture',
  silence: 'sound',
  loudness_curve: 'sound',
  cuts: 'picture',
}

/** The shortest frozen part and the shortest silent part that the checks
 *  tell, in seconds: a still shot or a pause in speech that is shorter is
 *  normal. A black part counts from one frame on, as a black frame between
 *  two shots is a fault of a join. */
export const FROZEN_MIN_SECONDS = 1
export const SILENCE_MIN_SECONDS = 1

/** The level of the samples under which a sound counts as silent, in
 *  dBFS: the default of `silencedetect`. */
export const SILENCE_DBFS = -60

// The filter of each check. Each one passes every frame on, so the filters
// of one stream go in a chain. `framelog=info` writes the momentary
// loudness of each 100 ms at the log level `info` (`loudnessCurve`).
const CHECK_FILTERS: Readonly<Record<ClipCheck, string>> = {
  black: 'blackdetect=d=0',
  frozen: `freezedetect=d=${FROZEN_MIN_SECONDS}`,
  silence: `silencedetect=n=${SILENCE_DBFS}dB:d=${SILENCE_MIN_SECONDS}`,
  loudness_curve: 'ebur128=framelog=info',
  cuts: SCENE_CUT_FILTER,
}

/** The ffmpeg arguments of one run of `checks` over the whole clip file
 *  `input`: a chain of filters on its first picture stream and one on its
 *  first sound stream, as the checks need them. The caller gives only the
 *  checks that fit the clip (it has the streams that they read). The run
 *  writes nothing; the readers of this module read its log. */
export function clipChecksArgs(input: string, checks: readonly ClipCheck[]): string[] {
  const chains = ([['picture', '0:v:0', 'v'], ['sound', '0:a:0', 'a']] as const).flatMap(([stream, from, to]) => {
    const filters = CLIP_CHECKS.filter((check) => CHECK_STREAMS[check] === stream && checks.includes(check)).map((check) => CHECK_FILTERS[check])
    return filters.length === 0 ? [] : [{ graph: `[${from}]${filters.join(',')}[${to}]`, output: `[${to}]` }]
  })
  return [
    ...FFMPEG_FIXED_ARGS, '-v', 'info', '-i', input,
    '-filter_complex', chains.map(({ graph }) => graph).join(';'),
    ...chains.flatMap(({ output }) => ['-map', output]),
    '-f', 'null', '-',
  ]
}

/** A part of a clip, in seconds of the clip; `end` null for a part that
 *  lasts to the end of the clip. */
export interface ClipInterval {
  start: number
  end: number | null
}

// A time of these filters, which ffmpeg can write with an exponent.
const TIME = '-?[\\d.]+(?:e[-+]?\\d+)?'

// A part that a filter writes as one line, from `black_start` to
// `black_end`. At the end of the clip, `black_end` is the time of the last
// frame, not of the end of the clip.
const BLACK_PART = new RegExp(`\\[Parsed_blackdetect_\\d+ @ [^\\]]*\\] black_start:\\s*(${TIME}) black_end:\\s*(${TIME})`, 'g')

// The lines at the start and at the end of a part: a part that lasts to
// the end of the clip has only a start line.
const FROZEN_EDGE = new RegExp(`\\[Parsed_freezedetect_\\d+ @ [^\\]]*\\] lavfi\\.freezedetect\\.freeze_(start|end): (${TIME})`, 'g')
const SILENCE_EDGE = new RegExp(`\\[Parsed_silencedetect_\\d+ @ [^\\]]*\\] silence_(start|end): (${TIME})`, 'g')

// The parts of the lines of `pattern`, whose first group is `start` or
// `end` and whose second is the time. An end with no open part is no part.
function edgeIntervals(log: string, pattern: RegExp): ClipInterval[] {
  const found: ClipInterval[] = []
  for (const [, edge, time] of log.matchAll(pattern)) {
    const open = found.at(-1)
    if (edge === 'start') found.push({ start: Math.max(0, Number(time)), end: null })
    else if (open && open.end === null) open.end = Number(time)
  }
  return found
}

/** The black parts (`black`) in the log of a `clipChecksArgs` run. */
export function blackIntervals(log: string): ClipInterval[] {
  return Array.from(log.matchAll(BLACK_PART), ([, start, end]) => ({ start: Math.max(0, Number(start)), end: Number(end) }))
}

/** The frozen parts (`frozen`) in the log of a `clipChecksArgs` run. */
export function frozenIntervals(log: string): ClipInterval[] {
  return edgeIntervals(log, FROZEN_EDGE)
}

/** The silent parts (`silence`) in the log of a `clipChecksArgs` run. At
 *  the end of the sound, the filter ends an open part. */
export function silenceIntervals(log: string): ClipInterval[] {
  return edgeIntervals(log, SILENCE_EDGE)
}

/** The most values of a loudness curve: a longer sound gets a longer
 *  step. */
export const MAX_CURVE_VALUES = 120

/** The loudness of a sound over time (`loudness_curve`): the loudness of
 *  each `step` seconds from 0 s, in LUFS. -Infinity is a part with no sound
 *  at all, and null a part with no value. */
export interface LoudnessCurve {
  step: number
  values: (number | null)[]
}

/** The length of the window of the momentary loudness, in seconds. Before
 *  the sound fills it, the filter writes -120.7 as a stand-in. */
export const MOMENTARY_WINDOW_SECONDS = 0.4

// A line of the momentary loudness, as in `[Parsed_ebur128_4 @ 0x…] t:
// 0.999979   TARGET:-23 LUFS    M: -21.8 S:-120.7 …`: the time of the end of
// its 100 ms, and its loudness in LUFS. A window with no sound at all has
// `nan`.
const MOMENTARY = new RegExp(`\\[Parsed_ebur128_\\d+ @ [^\\]]*\\] t:\\s*(${TIME})\\s[^\\n]*?\\bM:\\s*(nan|-?inf|-?[\\d.]+)`, 'g')

/** The loudness curve in the log of a `clipChecksArgs` run with
 *  `loudness_curve`. Each value is the mean of the momentary loudness of
 *  the 100 ms steps of its part, taken over their energy, as loudness adds
 *  up: a mean of the LUFS numbers would make a short quiet gap weigh too
 *  much. The steps before the window is full are left out. Null for a log
 *  with no step after that (a sound shorter than the window). */
export function loudnessCurve(log: string): LoudnessCurve | null {
  // The filter keeps the steps after the window is full. Their times are a
  // bit under each 100 ms (0.399979), so the bound has a margin.
  const blocks = Array.from(log.matchAll(MOMENTARY), ([, time, lufs]) => ({
    time: Number(time),
    // The energy, up to a factor that the mean takes out again.
    energy: lufs === 'nan' || lufs.endsWith('inf') ? 0 : 10 ** (Number(lufs) / 10),
  })).filter(({ time }) => time > MOMENTARY_WINDOW_SECONDS - 0.05)
  if (blocks.length === 0) return null
  // Not `Math.max(...times)`: a long sound has more steps than a call can
  // take arguments.
  const last = blocks.reduce((latest, { time }) => Math.max(latest, time), 0)
  const step = Math.max(1, Math.ceil(last / MAX_CURVE_VALUES))
  // A time at the end of the last part (120 s of 120 s) counts in it.
  const sums = Array.from({ length: Math.max(1, Math.ceil(last / step)) }, () => ({ energy: 0, count: 0 }))
  for (const { time, energy } of blocks) {
    const sum = sums[Math.min(Math.floor(time / step), sums.length - 1)]
    sum.energy += energy
    sum.count += 1
  }
  return { step, values: sums.map(({ energy, count }) => (count === 0 ? null : 10 * Math.log10(energy / count))) }
}
