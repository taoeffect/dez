// Shared helpers of the unit tests of the `video` tool: the output of the
// ffprobe run that reads the facts of a clip for a join (`joinProbeArgs`).

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
