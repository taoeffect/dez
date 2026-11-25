// The copy that a local video clip plays from when this computer cannot
// play its file: controller/playCopies.ts has ffmpeg make it, and
// MediaPlayer.vue plays it. Dez's own clips with an alpha channel are PNG
// in MOV (`frameEncodeArgs`, model/tools/frameSequences.ts), and a model
// can make other formats with the `video` tool. WebKit on macOS plays
// through AVFoundation, which has no PNG video decoder, and WebKitGTK
// decodes only what the GStreamer plugins of the computer decode. The
// bundled ffmpeg decodes all of them, so it makes a copy in a format that
// the media element takes.
//
// The copy has no alpha channel: H.264 has none, and Safari shows the
// alpha of VP9 as grey. So the picture is flattened over black
// (`premultiply`), as a player with no alpha shows it.

/** The format of a play copy: H.264 and AAC in MP4, or VP9 and Opus in
 *  WebM. */
export type PlayCopyTarget = 'mp4' | 'webm'

// The type that a video element is asked about for each target, with the
// codecs of the copy: `avc1.42E01E` is the baseline profile of H.264,
// `mp4a.40.2` is AAC-LC.
const TARGET_QUERIES: Readonly<Record<PlayCopyTarget, string>> = {
  mp4: 'video/mp4; codecs="avc1.42E01E, mp4a.40.2"',
  webm: 'video/webm; codecs="vp9, opus"',
}

/** The format of the play copies of this computer, from `canPlay` (the
 *  `canPlayType` of a video element): H.264 in MP4 when it plays it (every
 *  macOS), else VP9 in WebM (a Linux whose GStreamer has no H.264
 *  decoder); null when it plays neither, and Dez makes no copy. */
export function playCopyTarget(canPlay: (type: string) => string): PlayCopyTarget | null {
  return (['mp4', 'webm'] as const).find((target) => canPlay(TARGET_QUERIES[target]) !== '') ?? null
}

/** The time limit of one run that makes a play copy. A long clip can take
 *  minutes; a longer run is one that hangs. */
export const PLAY_COPY_RUN_TIMEOUT_MS = 10 * 60 * 1000

/** The most bytes of one play copy: the player holds the whole copy in
 *  memory while it plays. */
export const PLAY_COPY_MAX_BYTES = 256 * 1024 ** 2

/** How long Dez keeps a play copy in memory after the last player that
 *  shows it went (a tab switch, a scroll that takes the player out of the
 *  drawn part of the editor, a closed preview box), so that a quick
 *  return makes no new run. */
export const PLAY_COPY_KEEP_MS = 60 * 1000

/** The bytes of the play copies in the memo past which Dez drops the
 *  copies that no player shows, the oldest first, before their
 *  `PLAY_COPY_KEEP_MS` ends. A copy that a player shows counts, but
 *  stays: its player holds its bytes anyway. */
export const PLAY_COPY_MEMO_MAX_BYTES = 512 * 1024 ** 2

/** One ffmpeg run that makes a play copy in a run folder. */
export interface PlayCopyRun {
  /** The name of the copy of the clip's file in the folder. */
  inputName: string
  /** The name of the new file. */
  name: string
  /** The media type of the new file. */
  type: string
  args: string[]
}

// The picture of a copy: the alpha flattened over black, an even width and
// height (yuv420p needs them), and the pixel format that every decoder of
// the two codecs reads. The colours are in the BT.709 matrix, and the
// frames tell it (`setparams`, which the encoder writes into the stream).
// With no matrix named, swscale converts RGB with BT.601 and the stream
// tells no matrix; a player then guesses, and GStreamer guesses BT.709 for
// a stream taller than 576 lines: a saturated colour of an HD copy shifts.
const PICTURE_FILTERS = 'format=rgba,premultiply=inplace=1,'
  + 'scale=trunc(iw/2)*2:trunc(ih/2)*2:out_color_matrix=bt709:out_range=tv,format=yuv420p,'
  + 'setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv'

// The encoders of each target. The baseline profile: openh264, the only
// H.264 decoder of Fedora's GStreamer, decodes no other. `faststart` puts
// the index first, so the player reads the length at once.
const TARGET_CODECS: Readonly<Record<PlayCopyTarget, readonly string[]>> = {
  mp4: ['-c:v', 'libx264', '-profile:v', 'baseline', '-preset', 'veryfast', '-crf', '23', '-c:a', 'aac', '-movflags', '+faststart'],
  webm: ['-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-row-mt', '1', '-crf', '32', '-b:v', '0', '-c:a', 'libopus'],
}

/** The run that makes the play copy of the clip whose file is `src`, in
 *  the format `target`. The copy holds the first video stream that is no
 *  cover picture (`V`), and the first audio stream when the clip has one.
 *  `-fs` stops the run at one byte over `PLAY_COPY_MAX_BYTES`, so that a
 *  copy that is too large ends soon and shows as one. The input keeps the
 *  extension of the file, which helps ffmpeg find its format. */
export function playCopyRun(target: PlayCopyTarget, src: string): PlayCopyRun {
  const extension = /\.([A-Za-z0-9]{1,10})$/.exec(src)?.[1].toLowerCase() ?? 'bin'
  const inputName = `play_input.${extension}`
  const name = `play_copy.${target}`
  return {
    inputName,
    name,
    type: `video/${target}`,
    args: [
      '-nostdin', '-hide_banner', '-v', 'error',
      '-i', inputName,
      '-map', '0:V:0', '-map', '0:a:0?',
      '-vf', PICTURE_FILTERS,
      ...TARGET_CODECS[target],
      '-fs', String(PLAY_COPY_MAX_BYTES + 1),
      name,
    ],
  }
}
