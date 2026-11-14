import { describe, expect, it } from 'vitest'
import {
  assetViewCall,
  audioViewArgs,
  clipPart,
  DEFAULT_SHEET_FRAMES,
  frameSheetArgs,
  frameSheetTexts,
  loudnessOf,
  partHasNoFrame,
  sheetFrameTimes,
  sheetGrid,
} from './assetView'
import { refusal } from './testing'

// Lines of a real run of `frameSheetArgs` (ffmpeg 8, an mp4 of 24 fps):
// the config lines and the color lines of `showinfo` are no frames.
const SHOWINFO_LOG = [
  '[Parsed_showinfo_1 @ 0xffff9c43e130] config in time_base: 1/12288, frame_rate: 24/1',
  '[Parsed_showinfo_1 @ 0xffff9c43e130] config out time_base: 0/0, frame_rate: 0/0',
  '[Parsed_showinfo_1 @ 0xffff9c43e130] n:   0 pts:   2560 pts_time:0.208333 duration:    512 duration_time:0.0416667 fmt:yuv420p s:854x480',
  '[Parsed_showinfo_1 @ 0xffff9c43e130] color_range:unknown color_space:unknown color_primaries:unknown color_trc:unknown',
  '[Parsed_showinfo_1 @ 0xffff9c43e130] n:   1 pts:   7680 pts_time:0.625   duration:    512 duration_time:0.0416667 fmt:yuv420p s:854x480',
  '[Parsed_showinfo_1 @ 0xffff9c43e130] n:  12 pts:  12288 pts_time:1       duration:    512 duration_time:0.0416667 fmt:yuv420p s:854x480',
].join('\n')

// The end of the log of a real run of `audioViewArgs`.
function ebur128Log(integrated: string, range: string, peak: string): string {
  return [
    '[Parsed_ebur128_3 @ 0xffff9f0b4a60] Summary:',
    '',
    '  Integrated loudness:',
    `    I:         ${integrated} LUFS`,
    '    Threshold: -35.7 LUFS',
    '',
    '  Loudness range:',
    `    LRA:         ${range} LU`,
    '    Threshold: -45.7 LUFS',
    '    LRA low:   -32.6 LUFS',
    '    LRA high:  -23.2 LUFS',
    '',
    '  True peak:',
    `    Peak:      ${peak} dBFS`,
    '[out#1/null @ 0xffff9f073b00] video:0KiB audio:562KiB',
  ].join('\n')
}

describe('assetViewCall', () => {
  it('takes the ids, and the frames, start, and end with their defaults', () => {
    expect(assetViewCall({ assets: '@f @a' })).toStrictEqual({ ids: ['f', 'a'], frames: DEFAULT_SHEET_FRAMES, start: 0, end: null })
    expect(assetViewCall({ assets: '@f', frames: 16, start: 1.5, end: 3 })).toStrictEqual({ ids: ['f'], frames: 16, start: 1.5, end: 3 })
  })

  it('refuses more than 4 ids, frames out of 2 to 16, a start before 0, and an end that is not after the start', () => {
    expect(refusal(() => assetViewCall({ assets: '@a @b @c @d @e' }))).toMatch(/at most 4\b/)
    expect(refusal(() => assetViewCall({ assets: '@f', frames: 1 }))).toMatch(/2 to 16/)
    expect(refusal(() => assetViewCall({ assets: '@f', frames: 17 }))).toMatch(/2 to 16/)
    expect(refusal(() => assetViewCall({ assets: '@f', start: -1 }))).toMatch(/`start`/)
    expect(refusal(() => assetViewCall({ assets: '@f', start: 2, end: 2 }))).toMatch(/`end`/)
    expect(refusal(() => assetViewCall({ assets: '@f', end: 0 }))).toMatch(/`end`/)
  })
})

describe('clipPart', () => {
  const call = (start: number, end: number | null) => ({ ids: ['f'], frames: 6, start, end })

  it('ends at the end of the clip, or at an end before it', () => {
    expect(clipPart(call(1, null), 10)).toStrictEqual({ start: 1, end: 10 })
    expect(clipPart(call(1, 4), 10)).toStrictEqual({ start: 1, end: 4 })
    expect(clipPart(call(1, 40), 10)).toStrictEqual({ start: 1, end: 10 })
  })

  it('keeps the end of the call, or none, for a clip of unknown length', () => {
    expect(clipPart(call(1, 4), null)).toStrictEqual({ start: 1, end: 4 })
    expect(clipPart(call(0, null), null)).toStrictEqual({ start: 0, end: null })
  })

  it('shows nothing for a start at or after the end of the clip', () => {
    expect(clipPart(call(10, null), 10)).toEqual(expect.any(String))
    expect(clipPart(call(12, 14), 10)).toEqual(expect.any(String))
  })
})

describe('sheetGrid', () => {
  it('has at most 4 columns and rows that are as even as can be', () => {
    expect([2, 4, 5, 6, 7, 9, 16].map(sheetGrid)).toStrictEqual([
      { columns: 2, rows: 1 },
      { columns: 4, rows: 1 },
      { columns: 3, rows: 2 },
      { columns: 3, rows: 2 },
      { columns: 4, rows: 2 },
      { columns: 3, rows: 3 },
      { columns: 4, rows: 4 },
    ])
  })
})

describe('frameSheetArgs', () => {
  it('takes the first frame at or after the middle of each step, and reads only the part', () => {
    const whole = frameSheetArgs('f.mp4', 'f-frames.jpg', { start: 0, end: 10 }, 6)
    expect(whole).not.toContain('-ss')
    expect(whole.slice(whole.indexOf('-to'), whole.indexOf('-to') + 4)).toStrictEqual(['-to', '10.000', '-i', 'f.mp4'])
    expect(whole[whole.indexOf('-vf') + 1]).toMatch(/^select='gte\(t\\,0\.832\+1\.666667\*selected_n\)',showinfo,.*tile=3x2:/)
    expect(whole.at(-1)).toBe('f-frames.jpg')

    const part = frameSheetArgs('f.mp4', 'f-frames.jpg', { start: 2, end: 4 }, 5)
    expect(part.slice(part.indexOf('-ss'), part.indexOf('-ss') + 4)).toStrictEqual(['-ss', '2.000', '-to', '4.000'])
    expect(part[part.indexOf('-vf') + 1]).toMatch(/^select='gte\(t\\,0\.199\+0\.400000\*selected_n\)'/)
  })
})

describe('sheetFrameTimes', () => {
  it('reads the time of each frame of showinfo, from the start of the clip, at most the frames of the sheet', () => {
    expect(sheetFrameTimes(SHOWINFO_LOG, 2, 6)).toStrictEqual([2.208333, 2.625, 3])
    expect(sheetFrameTimes(SHOWINFO_LOG, 0, 2)).toStrictEqual([0.208333, 0.625])
    expect(sheetFrameTimes('Nothing was written into output file', 0, 6)).toStrictEqual([])
  })
})

// The end of the log of a real `frameSheetArgs` run (ffmpeg 8) that wrote
// no picture, after the lines of its case.
const NOTHING_WRITTEN = [
  '[vost#0:0/mjpeg @ 0xffffa3e22d50] [enc:mjpeg @ 0xffffa3e36c90] Could not open encoder before EOF',
  '[out#0/image2 @ 0xffffa3e20920] Nothing was written into output file, because at least one of its streams received no packets.',
  'Conversion failed!',
]
const NO_FILTERED_FRAMES = '[vf#0:0 @ 0xffffa3e1c2d0] No filtered frames for output stream, trying to initialize anyway.'

describe('partHasNoFrame', () => {
  it('is true for a part that ffmpeg read to its end with no frame in it', () => {
    expect(partHasNoFrame([NO_FILTERED_FRAMES, ...NOTHING_WRITTEN].join('\n'))).toBe(true)
  })

  // The error lines of ffmpeg 8 on damaged clips that ffprobe reads.
  it.each([
    ['a cut file, with no frame that decodes', '[vf#0:0 @ 0xffff9dfe0020] Cannot determine format of input 0:0 after EOF'],
    ['a frame that does not decode', `[vist#0:0/vp9 @ 0xffff8b377e20] [dec:vp9 @ 0xffff8b36e2b0] Decoding error: Invalid data found when processing input\n${NO_FILTERED_FRAMES}`],
    ['a packet that the decoder refuses', `[vist#0:0/h264 @ 0xffffabd51640] [dec:h264 @ 0xffffabd512b0] Error submitting packet to decoder: Invalid data found when processing input\n${NO_FILTERED_FRAMES}`],
    ['a corrupt frame', `[vist#0:0/h264 @ 0xffffabd51640] [dec:h264 @ 0xffffabd512b0] corrupt decoded frame\n${NO_FILTERED_FRAMES}`],
    ['a packet that the demuxer cannot read', `[in#0/matroska,webm @ 0xffff8b378840] Error during demuxing: Invalid data found when processing input\n${NO_FILTERED_FRAMES}`],
  ])('is false for a damaged clip: %s', (_case, lines) => {
    expect(partHasNoFrame([lines, ...NOTHING_WRITTEN].join('\n'))).toBe(false)
  })
})

describe('frameSheetTexts', () => {
  // A clip with a low frame rate gives fewer frames than the run asked
  // for, and they fill the rows of the grid that it asked for.
  it('tells the rows of the grid of the frames that the run asked for', () => {
    const times = [0.2, 0.4, 0.6, 0.8, 1, 1.2, 1.4, 1.6, 1.8]
    expect(frameSheetTexts('f', { start: 0, end: 2 }, times, 16).note).toContain('9 frames in rows of 4,')
    expect(frameSheetTexts('f', { start: 0, end: 2 }, times.slice(0, 3), 16).note).toContain('3 frames in one row,')
  })
})

describe('audioViewArgs', () => {
  it('draws the wave only when it has a file for it, and reads the loudness in both runs', () => {
    const withWave = audioViewArgs('g.webm', { start: 0, end: null }, 'g-wave.jpg')
    expect(withWave).not.toContain('-ss')
    expect(withWave).not.toContain('-to')
    expect(withWave[withWave.indexOf('-filter_complex') + 1]).toContain('showwavespic')
    expect(withWave.slice(withWave.indexOf('[p]') - 1, withWave.indexOf('g-wave.jpg') + 1)).toStrictEqual(['-map', '[p]', '-frames:v', '1', '-update', '1', '-q:v', '3', 'g-wave.jpg'])
    expect(withWave.slice(-5)).toStrictEqual(['-map', '[e]', '-f', 'null', '-'])

    const loudnessOnly = audioViewArgs('g.webm', { start: 1, end: 3 }, null)
    expect(loudnessOnly[loudnessOnly.indexOf('-filter_complex') + 1]).toBe('[0:a:0]ebur128=framelog=quiet:peak=true[e]')
    expect(loudnessOnly.slice(loudnessOnly.indexOf('-ss'), loudnessOnly.indexOf('-ss') + 4)).toStrictEqual(['-ss', '1.000', '-to', '3.000'])
    expect(loudnessOnly).not.toContain('[p]')
    expect(loudnessOnly.slice(-5)).toStrictEqual(['-map', '[e]', '-f', 'null', '-'])
  })
})

describe('loudnessOf', () => {
  it('reads the summary of ebur128, silence too', () => {
    expect(loudnessOf(ebur128Log('-23.1', '9.4', '-18.8'))).toStrictEqual({ integrated: '-23.1', range: '9.4', truePeak: '-18.8' })
    expect(loudnessOf(ebur128Log('-70.0', '0.0', '-inf'))).toStrictEqual({ integrated: '-70.0', range: '0.0', truePeak: '-inf' })
  })

  it('reads no loudness from a log without a summary', () => {
    expect(loudnessOf('[in#0 @ 0x1] Error opening input')).toBeNull()
  })
})
