import { describe, expect, it } from 'vitest'
import { clipFactsText, clipProbeFacts, imageFactsText, type ClipProbeFacts } from './assetFacts'

// Outputs of the ffprobe that Dez ships, with the arguments of
// `assetProbeArgs`, for clips that its ffmpeg made.
const VIDEO_WITH_SOUND = JSON.stringify({
  programs: [],
  stream_groups: [],
  streams: [
    { codec_name: 'mpeg4', codec_type: 'video', width: 854, height: 480, r_frame_rate: '24000/1001', avg_frame_rate: '24000/1001' },
    { codec_name: 'aac', codec_type: 'audio', sample_rate: '44100', channels: 1, r_frame_rate: '0/0', avg_frame_rate: '0/0' },
  ],
  format: { duration: '5.040000', size: '1250000' },
})
const TURNED_VIDEO = JSON.stringify({
  streams: [{ codec_name: 'vp9', codec_type: 'video', width: 48, height: 36, r_frame_rate: '5/1', avg_frame_rate: '5/1', side_data_list: [{ rotation: 90 }] }],
  format: { duration: '2.000000', size: '1071' },
})
const WAV = JSON.stringify({
  streams: [{ codec_name: 'pcm_s16le', codec_type: 'audio', sample_rate: '44100', channels: 2, r_frame_rate: '0/0', avg_frame_rate: '0/0' }],
  format: { duration: '1.500000', size: '264678' },
})
// An M4A file with a cover picture: ffprobe gives the picture as a video
// stream, with the tick rate of the container as its rate.
const AUDIO_WITH_COVER = JSON.stringify({
  streams: [
    { codec_name: 'aac', codec_type: 'audio', sample_rate: '44100', channels: 1, r_frame_rate: '0/0', avg_frame_rate: '0/0' },
    { codec_name: 'mjpeg', codec_type: 'video', width: 64, height: 64, r_frame_rate: '90000/1', avg_frame_rate: '0/0' },
  ],
  format: { duration: '0.022993', size: '1585' },
})

describe('clipProbeFacts', () => {
  it('reads the length, the file size, the picture, and the sound of a clip', () => {
    expect(clipProbeFacts(VIDEO_WITH_SOUND)).toStrictEqual({
      seconds: 5.04,
      bytes: 1_250_000,
      video: { width: 854, height: 480, fps: 24000 / 1001, codec: 'mpeg4' },
      audio: { codec: 'aac', sampleRate: 44100, channels: 1 },
    })
  })

  it('gives the picture size of a turned clip as a player shows it', () => {
    expect(clipProbeFacts(TURNED_VIDEO)?.video).toStrictEqual({ width: 36, height: 48, fps: 5, codec: 'vp9' })
  })

  it('takes no frame rate that a clip cannot have', () => {
    expect(clipProbeFacts(AUDIO_WITH_COVER)?.video?.fps).toBeNull()
  })

  it('leaves out the facts that the output does not tell', () => {
    const output = JSON.stringify({ streams: [{ codec_type: 'video', width: 0, height: 36 }, { codec_type: 'audio', channels: 'two' }], format: { duration: 'N/A' } })

    expect(clipProbeFacts(output)).toStrictEqual({ seconds: null, bytes: null, video: null, audio: { codec: '', sampleRate: null, channels: null } })
  })

  it('gives null for an output that is no JSON object', () => {
    expect(clipProbeFacts('')).toBeNull()
    expect(clipProbeFacts('[Errno] cannot open')).toBeNull()
  })
})

describe('clipFactsText', () => {
  const facts = (output: string) => clipProbeFacts(output) as ClipProbeFacts

  it('tells the facts of a video clip in one line', () => {
    expect(clipFactsText('video', 'mp4', facts(VIDEO_WITH_SOUND))).toBe('MP4 | 5.04 s | 854x480 | 23.98 fps | mpeg4 | sound (aac) | 1.2 MB')
  })

  it('tells that a video clip has no sound, or no picture', () => {
    expect(clipFactsText('video', 'webm', facts(TURNED_VIDEO))).toBe('WebM | 2 s | 36x48 | 5 fps | vp9 | no sound | 1 KB')
    expect(clipFactsText('video', 'mp4', facts(WAV))).toBe('MP4 | 1.5 s | no picture | sound (pcm_s16le) | 258 KB')
  })

  it('tells the facts of an audio clip, with no cover picture', () => {
    expect(clipFactsText('audio', 'wav', facts(WAV))).toBe('WAV | 1.5 s | pcm_s16le | 44100 Hz | 2 channels | 258 KB')
    expect(clipFactsText('audio', 'm4a', facts(AUDIO_WITH_COVER))).toBe('M4A | 0.02 s | aac | 44100 Hz | 1 channel | 2 KB')
  })

  it('leaves out the facts that Dez does not know', () => {
    expect(clipFactsText('audio', null, { seconds: null, bytes: null, video: null, audio: null })).toBe('no sound')
    expect(clipFactsText('video', null, { seconds: 3, bytes: null, video: { width: 2, height: 2, fps: null, codec: '' }, audio: { codec: '', sampleRate: null, channels: null } }))
      .toBe('3 s | 2x2 | sound')
  })
})

describe('imageFactsText', () => {
  it('tells the format, the size in pixels, and the file size', () => {
    expect(imageFactsText('jpg', { width: 1024, height: 768 }, 1_250_000)).toBe('JPEG | 1024x768 | 1.2 MB')
  })

  it('leaves out the facts that Dez does not know', () => {
    expect(imageFactsText(null, null, 500)).toBe('500 B')
  })
})
