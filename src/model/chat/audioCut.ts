// The audio facts that the `audio` tool and a media request share. The
// `audio` tool cuts a clip with ffmpeg (model/tools/audioTool.ts). A media
// request decodes an input clip in the webview
// (`dez.controller/media/decodeAudio`) for its length and its WAV copy.

/** The rate of every WAV file that Dez makes of an audio clip, in frames a
 *  second: ffmpeg and the webview decode resample a clip to it. */
export const AUDIO_CUT_RATE = 48000

/** A part of an audio clip, in seconds from its start: `start` is 0 or
 *  more and less than the clip's length, and `end` is after `start`. */
export interface AudioPart {
  start: number
  end: number
}

/** An audio clip that the webview decoded: its length in seconds, and its
 *  WAV copy (the whole clip), or null when the caller asked for none. */
export interface DecodedAudio {
  seconds: number
  wav: Uint8Array | null
}
