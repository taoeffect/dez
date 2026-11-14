import { describe, expect, it } from 'vitest'
import {
  assetViewCall,
  audioViewArgs,
  clipPart,
  cropRegion,
  DEFAULT_SHEET_FRAMES,
  frameSheetArgs,
  frameSheetTexts,
  imagePictureDrawing,
  loudnessOf,
  partHasNoFrame,
  sheetFrameTimes,
  sheetGrid,
  smallerPictureDrawing,
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
  it('takes the ids, and the frames, start, end, detail, and crop with their defaults', () => {
    expect(assetViewCall({ assets: '@f @a' })).toStrictEqual({ ids: ['f', 'a'], frames: DEFAULT_SHEET_FRAMES, start: 0, end: null, detail: 'review', crop: null })
    expect(assetViewCall({ assets: '@f', frames: 16, start: 1.5, end: 3, detail: 'full', crop: '0.25 0 0.5 1' })).toStrictEqual({
      ids: ['f'], frames: 16, start: 1.5, end: 3, detail: 'full', crop: { left: 0.25, top: 0, width: 0.5, height: 1 },
    })
  })

  it('takes a detail in any case, crop numbers split by commas, and blank texts as none', () => {
    expect(assetViewCall({ assets: '@f', detail: ' Full ', crop: '0.1, 0.2,0.3 0.4' })).toMatchObject({ detail: 'full', crop: { left: 0.1, top: 0.2, width: 0.3, height: 0.4 } })
    expect(assetViewCall({ assets: '@f @a', detail: ' ', crop: '  ' })).toMatchObject({ detail: 'review', crop: null })
  })

  it('takes a crop that ends at the right and bottom edges', () => {
    expect(assetViewCall({ assets: '@f', crop: '0.7 0.9 0.3 0.1' }).crop).toStrictEqual({ left: 0.7, top: 0.9, width: 0.3, height: 0.1 })
  })

  it('refuses more than 4 ids, frames out of 2 to 16, a start before 0, and an end that is not after the start', () => {
    expect(refusal(() => assetViewCall({ assets: '@a @b @c @d @e' }))).toMatch(/at most 4\b/)
    expect(refusal(() => assetViewCall({ assets: '@f', frames: 1 }))).toMatch(/2 to 16/)
    expect(refusal(() => assetViewCall({ assets: '@f', frames: 17 }))).toMatch(/2 to 16/)
    expect(refusal(() => assetViewCall({ assets: '@f', start: -1 }))).toMatch(/`start`/)
    expect(refusal(() => assetViewCall({ assets: '@f', start: 2, end: 2 }))).toMatch(/`end`/)
    expect(refusal(() => assetViewCall({ assets: '@f', end: 0 }))).toMatch(/`end`/)
  })

  it('refuses an unknown detail, and a crop that is not four numbers from 0 to 1', () => {
    expect(refusal(() => assetViewCall({ assets: '@f', detail: 'high' }))).toMatch(/`detail`/)
    for (const crop of ['0.1 0.2 0.3', '0.1 0.2 0.3 0.4 0.5', 'a b c d', '0.1 0.2 1.5 0.1', '-0.1 0 0.5 0.5']) {
      expect(refusal(() => assetViewCall({ assets: '@f', crop }))).toMatch(/`crop`/)
    }
  })

  it('refuses a crop with no width or height, past an edge, or for more than one asset', () => {
    expect(refusal(() => assetViewCall({ assets: '@f', crop: '0 0 0 0.5' }))).toMatch(/width of 0/)
    expect(refusal(() => assetViewCall({ assets: '@f', crop: '0.6 0 0.5 0.5' }))).toMatch(/right edge/)
    expect(refusal(() => assetViewCall({ assets: '@f', crop: '0 0.6 0.5 0.5' }))).toMatch(/bottom edge/)
    expect(refusal(() => assetViewCall({ assets: '@f @a', crop: '0 0 0.5 0.5' }))).toMatch(/2 assets/)
  })
})

describe('cropRegion', () => {
  it('takes the pixels nearest to the edges of the part, and never past the image', () => {
    expect(cropRegion({ left: 0.5, top: 0, width: 0.5, height: 0.5 }, { width: 1000, height: 500 })).toStrictEqual({ x: 500, y: 0, width: 500, height: 250 })
    expect(cropRegion({ left: 0.333, top: 0.1, width: 0.333, height: 0.9 }, { width: 100, height: 10 })).toStrictEqual({ x: 33, y: 1, width: 34, height: 9 })
    expect(cropRegion({ left: 0.7, top: 0, width: 0.3 + 1e-10, height: 1 }, { width: 10, height: 10 })).toStrictEqual({ x: 7, y: 0, width: 3, height: 10 })
  })

  it('is null for a part of less than one pixel across or down', () => {
    expect(cropRegion({ left: 0.5, top: 0, width: 0.001, height: 1 }, { width: 100, height: 100 })).toBeNull()
    expect(cropRegion({ left: 0, top: 0, width: 1, height: 0.004 }, { width: 100, height: 100 })).toBeNull()
  })
})

describe('imagePictureDrawing', () => {
  const review = { detail: 'review', crop: null } as const
  const full = { detail: 'full', crop: null } as const
  const whole = (width: number, height: number) => ({ x: 0, y: 0, width, height })

  it('sends an image that fits the side of its detail and the byte limit as it is', () => {
    expect(imagePictureDrawing(review, { width: 1568, height: 1000 }, 3_750_000, 'image/png')).toBeNull()
    expect(imagePictureDrawing(full, { width: 3000, height: 3000 }, 1000, 'image/jpeg')).toBeNull()
  })

  it('sends a JPEG copy on white at the side of its detail for a larger image', () => {
    expect(imagePictureDrawing(review, { width: 3000, height: 1500 }, 1000, 'image/png'))
      .toStrictEqual({ crop: whole(3000, 1500), width: 1568, height: 784, background: '#ffffff', mediaType: 'image/jpeg' })
    expect(imagePictureDrawing(full, { width: 1500, height: 4000 }, 1000, 'image/webp'))
      .toStrictEqual({ crop: whole(1500, 4000), width: 1125, height: 3000, background: '#ffffff', mediaType: 'image/jpeg' })
  })

  it('sends a JPEG copy of the same size for a file over the byte limit', () => {
    expect(imagePictureDrawing(review, { width: 1000, height: 500 }, 3_750_001, 'image/png'))
      .toStrictEqual({ crop: whole(1000, 500), width: 1000, height: 500, background: '#ffffff', mediaType: 'image/jpeg' })
  })

  it('sends a PNG drawing of an SVG or of a type that does not go as it is', () => {
    expect(imagePictureDrawing(review, { width: 800, height: 600 }, 1000, 'image/svg+xml')).toMatchObject({ crop: whole(800, 600), width: 800, height: 600, mediaType: 'image/png' })
    expect(imagePictureDrawing(review, { width: 800, height: 600 }, 1000, null)).toMatchObject({ mediaType: 'image/png' })
  })

  it('draws a crop at its own pixels, a JPEG as a JPEG and else as a PNG', () => {
    const crop = { left: 0.5, top: 0.5, width: 0.5, height: 0.5 }
    expect(imagePictureDrawing({ detail: 'review', crop }, { width: 1000, height: 600 }, 9_000_000, 'image/jpeg'))
      .toStrictEqual({ crop: { x: 500, y: 300, width: 500, height: 300 }, width: 500, height: 300, mediaType: 'image/jpeg' })
    expect(imagePictureDrawing({ detail: 'review', crop }, { width: 1000, height: 600 }, 1000, 'image/webp')).toMatchObject({ width: 500, height: 300, mediaType: 'image/png' })
    expect(imagePictureDrawing({ detail: 'review', crop }, { width: 1000, height: 600 }, 1000, null)).toMatchObject({ mediaType: 'image/png' })
  })

  it('draws a crop smaller only down to the side of its detail', () => {
    const crop = { left: 0, top: 0, width: 1, height: 0.5 }
    expect(imagePictureDrawing({ detail: 'review', crop }, { width: 4000, height: 2000 }, 1000, 'image/png')).toMatchObject({ width: 1568, height: 392 })
    expect(imagePictureDrawing({ detail: 'full', crop }, { width: 4000, height: 2000 }, 1000, 'image/png')).toMatchObject({ width: 3000, height: 750 })
  })

  it('has no drawing for a crop of less than one pixel', () => {
    expect(imagePictureDrawing({ detail: 'review', crop: { left: 0, top: 0, width: 0.001, height: 1 } }, { width: 100, height: 100 }, 1000, 'image/png')).toBeNull()
  })
})

describe('smallerPictureDrawing', () => {
  it('draws a JPEG again at 2048, 1568, then 1024 pixels on its longer side, then gives up', () => {
    const region = { x: 10, y: 20, width: 3000, height: 1500 }
    let drawing = imagePictureDrawing({ detail: 'full', crop: null }, { width: 3000, height: 1500 }, 9_000_000, 'image/png')
    const sides: number[] = []
    while (drawing) {
      sides.push(drawing.width)
      drawing = smallerPictureDrawing({ ...drawing, crop: region })
      if (drawing) expect(drawing).toMatchObject({ crop: region, height: drawing.width / 2, background: '#ffffff', mediaType: 'image/jpeg' })
    }
    expect(sides).toStrictEqual([3000, 2048, 1568, 1024])
  })

  it('draws a PNG again as a JPEG of the same size, and a small JPEG at the next side under it', () => {
    const region = { x: 0, y: 0, width: 800, height: 600 }
    expect(smallerPictureDrawing({ crop: region, width: 800, height: 600, mediaType: 'image/png' }))
      .toStrictEqual({ crop: region, width: 800, height: 600, background: '#ffffff', mediaType: 'image/jpeg' })
    const large = { x: 0, y: 0, width: 1600, height: 1200 }
    expect(smallerPictureDrawing({ crop: large, width: 1600, height: 1200, mediaType: 'image/jpeg' })).toMatchObject({ width: 1568, height: 1176 })
    expect(smallerPictureDrawing({ crop: region, width: 800, height: 600, mediaType: 'image/jpeg' })).toBeNull()
  })
})

describe('clipPart', () => {
  const call = (start: number, end: number | null) => ({ start, end })

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
    const whole = frameSheetArgs('f.mp4', 'f-frames.jpg', { start: 0, end: 10 }, 6, 320)
    expect(whole).not.toContain('-ss')
    expect(whole.slice(whole.indexOf('-to'), whole.indexOf('-to') + 4)).toStrictEqual(['-to', '10.000', '-i', 'f.mp4'])
    expect(whole[whole.indexOf('-vf') + 1]).toMatch(/^select='gte\(t\\,0\.832\+1\.666667\*selected_n\)',showinfo,.*tile=3x2:/)
    expect(whole.at(-1)).toBe('f-frames.jpg')

    const part = frameSheetArgs('f.mp4', 'f-frames.jpg', { start: 2, end: 4 }, 5, 320)
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
