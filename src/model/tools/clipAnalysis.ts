// What ffmpeg finds in a clip, from the lines that its filters write into
// the log: the filters, and the readers of their lines. The tools that run
// ffmpeg (assetView.ts) put the filters into their runs; the log itself
// goes to the console only, as it can hold a path.

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
