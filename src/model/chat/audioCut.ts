// A cut of an audio clip in the webview (`dez.controller/media/cutAudio`):
// Web Audio decodes the clip, and a part of its samples becomes a WAV file.
// A media request uses it for an input clip. The `audio` tool cuts with
// ffmpeg (model/tools/audioTool.ts), at the rate `AUDIO_CUT_RATE`.

/** The rate that a cut decodes every clip at, in frames a second. The
 *  decode resamples a clip to the rate of its context, so every WAV file of
 *  a cut has this rate. */
export const AUDIO_CUT_RATE = 48000

/** A part of an audio clip, in seconds from its start: `start` is 0 or
 *  more and less than the clip's length, and `end` is after `start`. */
export interface AudioPart {
  start: number
  end: number
}

/** The WAV file that a cut made of `part` of a clip, and its length in
 *  seconds. */
export interface CutAudio {
  part: AudioPart
  bytes: Uint8Array
  duration: number
}

/** The frames of `part` in decoded audio of `length` frames at `rate`:
 *  from the frame `from` up to the frame `to`, which is not in the part.
 *  Each end goes to the nearest frame, and the part has at least one
 *  frame: a part of a clip shorter than one frame is the nearest frame. */
export function audioPartFrames(part: AudioPart, rate: number, length: number): { from: number; to: number } {
  const from = Math.max(0, Math.min(length - 1, Math.round(part.start * rate)))
  const to = Math.min(length, Math.max(from + 1, Math.round(part.end * rate)))
  return { from, to }
}
