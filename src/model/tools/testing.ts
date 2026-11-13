import { mediaTagText, type MediaTagData } from '../chat/mediaTags'
import { reply, user } from '../streams/testing'
import { ToolError } from './types'

// Shared helpers of the unit tests of the Dez tools: the text of a refused
// call, a conversation with images and clips for the `video` tool, and the
// output of the ffprobe run that reads the facts of a clip for a join
// (`joinProbeArgs`).

/** The text of the `ToolError` that `call` throws. */
export function refusal(call: () => unknown): string {
  try {
    call()
  } catch (error) {
    if (error instanceof ToolError) return error.message
    throw error
  }
  throw new Error('The call was not refused.')
}

export const RED = '/home/u/.config/dez/assets/images/red.jpg'
export const SKY = '/home/u/.config/dez/assets/images/sky.png'
export const SONG: MediaTagData = { kind: 'audio', id: 'b', type: 'audio/wav', src: '/home/u/.config/dez/assets/audio/s1.wav', url: null, expires: null, other: [] }
export const FILM: MediaTagData = { kind: 'video', id: 'c', type: 'video/webm', src: '/home/u/.cache/dez/media/v1.webm', url: null, expires: null, other: [] }
/** A clip that is only at its provider's address. */
export const LOOP: MediaTagData = { kind: 'video', id: 'd', type: 'video/webm', src: null, url: 'https://clips.example/x/loop?sig=1', expires: null, other: [] }

/** A conversation with the JPEG image `a` (RED), the audio clip `b`
 *  (SONG), the video clips `c` (FILM) and `d` (LOOP), and the PNG image `e`
 *  (SKY). */
export const CONVERSATION = [
  user('u1', `![${RED}](id=a)\n${mediaTagText(SONG)}`),
  reply('a1', `${mediaTagText(FILM)}\n${mediaTagText(LOOP)}`),
  user('u2', `![${SKY}](id=e)`),
]

/** A video stream of a probe output, as ffprobe writes it. */
export const VP9 = { index: 0, codec_name: 'vp9', codec_type: 'video', profile: 'Profile 0', level: -99, width: 48, height: 36, pix_fmt: 'yuv420p', r_frame_rate: '5/1', avg_frame_rate: '5/1', time_base: '1/1000', sample_aspect_ratio: '1:1' }

/** An audio stream of a probe output. */
export const OPUS = { index: 1, codec_name: 'opus', codec_type: 'audio', sample_rate: '48000', channels: 1, channel_layout: 'mono', r_frame_rate: '0/0', avg_frame_rate: '0/0', time_base: '1/1000', extradata_hash: 'MD5:19' }

/** The file facts of a probe output. */
export const WEBM = { format_name: 'matroska,webm', duration: '2.000000' }

/** The probe output of a clip with `streams`. */
export function probeOutput(streams: object[], format: object = WEBM): string {
  return JSON.stringify({ streams, format })
}
