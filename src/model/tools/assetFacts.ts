import { byteSizeText } from '../../utils/byteSize'
import { formatName } from '../../utils/formatName'
import type { MediaTagKind } from '../chat/mediaTags'
import { FFPROBE_FIXED_ARGS, parseProbeOutput, probeDuration, probeText, shownVideoSize, usableFrameRate } from './videoTool'

// The facts of an image or a clip as a short text for a model, as in
// `PNG | 1024x768 | 1.2 MB`: the format, the picture size, the length,
// the frame rate, the sound, and the file size. The tools that tell a
// model about the assets of its conversation share them. An image's facts
// come from the webview (`dez.controller/images/redraw` decodes it), and a
// clip's from one ffprobe run on a copy of its file (`assetProbeArgs`,
// `clipProbeFacts`). Every fact that Dez does not know is left out.

// What ffprobe tells of each stream and of the file. ffprobe writes the
// side data of a stream (its rotation) only when an entry asks for it.
const ASSET_PROBE_ENTRIES = 'stream=codec_type,codec_name,width,height,avg_frame_rate,r_frame_rate,sample_rate,channels'
  + ':stream_side_data=rotation:format=duration,size'

/** The arguments of the ffprobe run that reads the facts of the clip file
 *  `name` (`clipProbeFacts` reads its output). */
export function assetProbeArgs(name: string): string[] {
  return [...FFPROBE_FIXED_ARGS, '-v', 'error', '-show_entries', ASSET_PROBE_ENTRIES, '-of', 'json', name]
}

/** The facts of a clip file, from ffprobe. */
export interface ClipProbeFacts {
  /** The length in seconds. */
  seconds: number | null
  /** The size of the file in bytes. */
  bytes: number | null
  /** The first video stream: the size of its picture as a player shows
   *  it, its frames per second, and its codec (blank for none). */
  video: { width: number, height: number, fps: number | null, codec: string } | null
  /** The first audio stream: its codec (blank for none), its sample rate,
   *  and its count of channels. */
  audio: { codec: string, sampleRate: number | null, channels: number | null } | null
}

// A whole number of the probe output that is more than 0; null for none.
function positiveInteger(value: unknown): number | null {
  const number = Number(probeText(value))
  return Number.isInteger(number) && number > 0 ? number : null
}

/** The facts of a clip from the output of its `assetProbeArgs` run; null
 *  when the output is no JSON object. A file that holds a cover picture
 *  next to its sound (an MP3) has a video stream too: the caller reads the
 *  streams of the clip's kind. */
export function clipProbeFacts(output: string): ClipProbeFacts | null {
  const probe = parseProbeOutput(output)
  if (!probe) return null
  const { streams, format } = probe
  const videoStream = streams.find((stream) => stream.codec_type === 'video')
  const audioStream = streams.find((stream) => stream.codec_type === 'audio')
  const size = videoStream ? shownVideoSize(videoStream) : null
  const rate = videoStream ? usableFrameRate(videoStream.avg_frame_rate) || usableFrameRate(videoStream.r_frame_rate) : ''
  const [numerator, denominator] = rate.split('/').map(Number)
  const sizeText = probeText(format.size)
  const bytes = sizeText === '' ? null : Number(sizeText)
  return {
    seconds: probeDuration(format),
    bytes: bytes !== null && Number.isInteger(bytes) && bytes >= 0 ? bytes : null,
    video: videoStream && size
      ? { width: size.width, height: size.height, fps: rate === '' ? null : numerator / denominator, codec: probeText(videoStream.codec_name) }
      : null,
    audio: audioStream
      ? { codec: probeText(audioStream.codec_name), sampleRate: positiveInteger(audioStream.sample_rate), channels: positiveInteger(audioStream.channels) }
      : null,
  }
}

// A number of seconds or frames with at most two decimals, as in `5.04`.
function shortNumber(value: number): string {
  return String(Number(value.toFixed(2)))
}

// The parts of a facts text, without the facts that are not known.
function factsText(parts: readonly (string | null | false | undefined)[]): string {
  return parts.filter((part): part is string => typeof part === 'string' && part !== '').join(' | ')
}

/** The facts of an image as a text, as in `PNG | 1024x768 | 1.2 MB`.
 *  `extension` is the one of its file; `size` is the size of its picture,
 *  and `bytes` the size of its file. */
export function imageFactsText(extension: string | null, size: { width: number, height: number } | null, bytes: number | null): string {
  return factsText([extension && formatName(extension), size && `${size.width}x${size.height}`, bytes !== null && byteSizeText(bytes)])
}

/** The facts of a clip of the kind `kind` as a text: for a video clip as
 *  in `MP4 | 5.04 s | 854x480 | 24 fps | h264 | sound (aac) | 1.2 MB`, and
 *  for an audio clip as in `WAV | 3.2 s | pcm_s16le | 44100 Hz | 2 channels
 *  | 560 KB`. `extension` is the one of the clip's type. A video clip with
 *  no picture or no sound says so: a model can then pick another clip. */
export function clipFactsText(kind: MediaTagKind, extension: string | null, facts: ClipProbeFacts): string {
  const { seconds, bytes, video, audio } = facts
  const format = extension && formatName(extension)
  const length = seconds !== null && `${shortNumber(seconds)} s`
  const size = bytes !== null && byteSizeText(bytes)
  if (kind === 'audio') {
    return factsText([
      format,
      length,
      audio === null ? 'no sound' : audio.codec,
      audio?.sampleRate != null && `${audio.sampleRate} Hz`,
      audio?.channels != null && `${audio.channels} ${audio.channels === 1 ? 'channel' : 'channels'}`,
      size,
    ])
  }
  return factsText([
    format,
    length,
    video === null ? 'no picture' : `${video.width}x${video.height}`,
    video?.fps != null && `${shortNumber(video.fps)} fps`,
    video?.codec,
    audio === null ? 'no sound' : `sound${audio.codec === '' ? '' : ` (${audio.codec})`}`,
    size,
  ])
}
