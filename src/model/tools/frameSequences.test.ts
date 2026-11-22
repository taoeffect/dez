import { describe, expect, it } from 'vitest'
import { byteSizeText } from '../../utils/byteSize'
import { storedTypeOfBytes } from '../chat/fileSignatures'
import { APP_RUN_MAX_FRAMES, APP_RUN_MAX_OUTPUT_BYTES } from './appsTool'
import {
  checkedSequence,
  encodedClipProblem,
  encodedFrameCount,
  encodeErrorLine,
  frameEncodeArgs,
  FRAMES_FILE_MAX_BYTES,
  isFramesFolderName,
  readsFramesFile,
  sequenceClipType,
  type FrameSequence,
} from './frameSequences'
import { folderTree, MISSING_TREE, textBytes } from './testing'

const FACTS = { fps: 24, width: 64, height: 36, count: 3, alpha: false }
const PNG_SEQUENCE: FrameSequence = { ...FACTS, format: 'png' }

function json(value: unknown): Uint8Array {
  return textBytes(JSON.stringify(value))
}

// The listing of a frames folder with frames.json and the frames 0 to
// `count` - 1 of the ending `ending`, each of `size` bytes, and `more`.
function framesTree(count: number, ending = 'png', size = 100, more: Record<string, number | null | 'other'> = {}) {
  const frames = Object.fromEntries(Array.from({ length: count }, (_, index) => [`${String(index).padStart(6, '0')}.${ending}`, size]))
  return folderTree({ 'frames.json': 80, ...frames, ...more })
}

function notKept(checked: ReturnType<typeof checkedSequence>): string {
  if (!('notKept' in checked)) throw new Error(`The sequence passed: ${JSON.stringify(checked)}`)
  return checked.notKept
}

describe('isFramesFolderName', () => {
  it('takes a name that ends with .frames and has a name before it', () => {
    expect(isFramesFolderName('intro.frames')).toBe(true)
    expect(isFramesFolderName('a.b.frames')).toBe(true)
    expect(isFramesFolderName('.frames')).toBe(false)
    expect(isFramesFolderName('intro.frame')).toBe(false)
    expect(isFramesFolderName('frames')).toBe(false)
  })
})

describe('checkedSequence', () => {
  it('takes the PNG frames from 0 with no gap and the facts of frames.json; alpha is false when left out', () => {
    expect(checkedSequence('intro.frames', framesTree(3), json(FACTS))).toStrictEqual({ sequence: PNG_SEQUENCE })
    const { alpha: _, ...noAlpha } = FACTS
    expect(checkedSequence('intro.frames', framesTree(3), json(noAlpha))).toStrictEqual({ sequence: PNG_SEQUENCE })
    expect(checkedSequence('glow.frames', framesTree(3), json({ ...FACTS, alpha: true, fps: 29.97 }))).toStrictEqual({ sequence: { ...PNG_SEQUENCE, alpha: true, fps: 29.97 } })
  })

  it('takes raw RGBA frames of exactly 4 bytes for each pixel', () => {
    const raw = 64 * 36 * 4
    expect(checkedSequence('raw.frames', framesTree(3, 'rgba', raw), json(FACTS))).toStrictEqual({ sequence: { ...FACTS, format: 'rgba' } })

    const short = notKept(checkedSequence('raw.frames', framesTree(3, 'rgba', raw - 1), json(FACTS)))
    expect(short).toBe('raw.frames/ (its raw frame 000000.rgba has 9,215 bytes, and a raw frame of 64 × 36 pixels has 9,216: 4 bytes for each pixel, in the order R, G, B, A, row after row)')
  })

  it('refuses a folder with another entry, a frame that is no plain file, frames of two formats, and an empty frame', () => {
    const cases: Array<[ReturnType<typeof folderTree>, string]> = [
      [framesTree(3, 'png', 100, { 'notes.txt': 4 }), 'the file "notes.txt"'],
      [framesTree(3, 'png', 100, { '000003.jpg': 4 }), 'the file "000003.jpg"'],
      [framesTree(3, 'png', 100, { '1.png': 4 }), 'the file "1.png"'],
      [framesTree(3, 'png', 100, { sub: null, 'sub/000000.png': 4 }), 'the folder "sub"'],
      [framesTree(2, 'png', 100, { '000002.png': 'other' }), '"000002.png", a link or a special file'],
    ]
    for (const [tree, entry] of cases) {
      expect(notKept(checkedSequence('s.frames', tree, json(FACTS)))).toBe(`s.frames/ (a frame sequence that holds ${entry}: a frame sequence holds only frames.json and its frames, `
        + 'named 000000.png, 000001.png, and so on, or 000000.rgba, 000001.rgba, and so on)')
    }

    expect(notKept(checkedSequence('s.frames', framesTree(3, 'png', 100, { '000003.rgba': 4 }), json(FACTS)))).toContain('frames of two formats')
    expect(notKept(checkedSequence('s.frames', framesTree(3, 'png', 0), json(FACTS)))).toBe('s.frames/ (its frame 000000.png is empty)')
  })

  it('refuses a gap, a missing first frame, and more frames than frames.json gives', () => {
    const gap = folderTree({ 'frames.json': 80, '000000.png': 9, '000002.png': 9 })
    expect(notKept(checkedSequence('s.frames', gap, json({ ...FACTS, count: 2 }))))
      .toBe('s.frames/ (its frames.json gives 2 frames, and the frame 000001.png is missing: the frames are named from 000000.png, with no gap)')
    expect(notKept(checkedSequence('s.frames', folderTree({ 'frames.json': 80 }), json(FACTS)))).toContain('the frame 000000.png is missing')
    expect(notKept(checkedSequence('s.frames', framesTree(5), json(FACTS)))).toBe('s.frames/ (its frames.json gives 3 frames, but it also holds the frame 000003.png)')
  })

  it('refuses a folder with no frames.json, a frames.json that is too large or not read, and a cut listing', () => {
    expect(notKept(checkedSequence('s.frames', folderTree({ '000000.png': 9 }), null))).toContain('a frame sequence with no frames.json, which gives the facts of its clip, as in {"fps": 30')
    expect(notKept(checkedSequence('s.frames', folderTree({ 'frames.json': null, '000000.png': 9 }), null))).toContain('holds the folder "frames.json"')
    expect(notKept(checkedSequence('s.frames', folderTree({ 'frames.json': FRAMES_FILE_MAX_BYTES + 1, '000000.png': 9 }), null))).toBe('s.frames/ (its frames.json is larger than 64 KB)')
    expect(notKept(checkedSequence('s.frames', framesTree(3), null))).toBe('s.frames/ (Dez could not read its frames.json)')
    expect(notKept(checkedSequence('s.frames', { ...framesTree(3), more: true }, json(FACTS)))).toBe(`s.frames/ (more than ${APP_RUN_MAX_FRAMES.toLocaleString('en-US')} frames, the most that Dez encodes into one clip)`)
    expect(notKept(checkedSequence('s.frames', MISSING_TREE, null))).toBe('s.frames/ (Dez could not list it)')
  })

  it('refuses a frames.json that is no object, has an unknown field, or a value out of its range', () => {
    const problems: Array<[Uint8Array, string]> = [
      [textBytes('{"fps": 24,'), 'it must be one JSON object, as in {"fps": 30, "width": 1280, "height": 720, "count": 90, "alpha": false}'],
      [json([FACTS]), 'it must be one JSON object'],
      [json({ ...FACTS, frameRate: 24 }), 'it has the field "frameRate", which Dez does not know: it takes only "fps", "width", "height", "count" and "alpha"'],
      [json({ ...FACTS, fps: 0 }), '"fps" must be a number from 0.01 to 240'],
      [json({ ...FACTS, fps: '24' }), '"fps" must be a number'],
      [json({ ...FACTS, width: 4098 }), '"width" and "height" must each be a whole number from 1 to 4,096'],
      [json({ ...FACTS, height: 35.5 }), '"width" and "height" must each be a whole number'],
      [json({ ...FACTS, count: 0 }), `"count" must be a whole number from 1 to ${APP_RUN_MAX_FRAMES.toLocaleString('en-US')}`],
      [json({ ...FACTS, alpha: 'yes' }), '"alpha" must be true or false'],
      [json({ ...FACTS, width: 63 }), 'it gives the size 63 × 36, and a clip with no alpha (H.264) needs an even width and an even height'],
    ]
    for (const [bytes, problem] of problems) {
      expect(notKept(checkedSequence('s.frames', framesTree(3), bytes))).toContain(`s.frames/ (its frames.json is not valid: ${problem}`)
    }
    // A clip with alpha (MOV, PNG) takes an odd size.
    expect(checkedSequence('s.frames', framesTree(3), json({ ...FACTS, width: 63, alpha: true }))).toHaveProperty('sequence')
  })
})

describe('readsFramesFile', () => {
  it('reads only a plain frames.json directly in the folder, up to its size limit', () => {
    expect(readsFramesFile(framesTree(1))).toBe(true)
    expect(readsFramesFile(folderTree({ 'frames.json': FRAMES_FILE_MAX_BYTES }))).toBe(true)
    expect(readsFramesFile(folderTree({ 'frames.json': FRAMES_FILE_MAX_BYTES + 1 }))).toBe(false)
    expect(readsFramesFile(folderTree({ 'frames.json': 'other' }))).toBe(false)
    expect(readsFramesFile(folderTree({ sub: null, 'sub/frames.json': 5 }))).toBe(false)
  })
})

describe('frameEncodeArgs', () => {
  // The order of the arguments is the rule of ffmpeg: the options of an
  // input before its -i, those of the output before its file.
  it('encodes PNG frames with alpha into MOV with the PNG codec, at the size of frames.json', () => {
    expect(frameEncodeArgs('output/glow.frames', { ...PNG_SEQUENCE, alpha: true, fps: 29.97 }, 'c.mov')).toStrictEqual([
      '-nostdin', '-hide_banner', '-nostats', '-v', 'error', '-progress', 'pipe:1',
      '-f', 'image2', '-pattern_type', 'sequence', '-start_number', '0', '-framerate', '29.97', '-i', 'output/glow.frames/%06d.png',
      '-frames:v', '3', '-vf', 'scale=64:36,format=rgba', '-c:v', 'png', '-f', 'mov', '-fs', String(APP_RUN_MAX_OUTPUT_BYTES + 1), 'c.mov',
    ])
  })

  it('reads raw frames by their size and pixel format, and encodes a clip with no alpha as H.264 in MP4 with BT.709 tags', () => {
    const args = frameEncodeArgs('output/raw.frames', { ...FACTS, fps: 0.01, format: 'rgba' }, 'c.mp4')
    const input = args.indexOf('-i')

    expect(args.slice(args.indexOf('-framerate'), input + 2)).toStrictEqual([
      '-framerate', '0.01', '-pixel_format', 'rgba', '-video_size', '64x36', '-c:v', 'rawvideo', '-i', 'output/raw.frames/%06d.rgba',
    ])
    expect(args.slice(input + 2)).toStrictEqual([
      '-frames:v', '3',
      '-vf', 'scale=64:36:out_color_matrix=bt709:out_range=tv,format=yuv420p,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv',
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-movflags', '+faststart', '-f', 'mp4', '-fs', String(APP_RUN_MAX_OUTPUT_BYTES + 1), 'c.mp4',
    ])
  })
})

describe('sequenceClipType', () => {
  // A stored file has the type that its first bytes give.
  it('gives the type that the stored type of the clip bytes gives', () => {
    const iso = (brand: string) => new Uint8Array([0, 0, 0, 0x14, ...textBytes(`ftyp${brand}`), 0, 0, 0, 0])
    expect(sequenceClipType({ alpha: true })).toStrictEqual(storedTypeOfBytes(iso('qt  ')))
    expect(sequenceClipType({ alpha: false })).toStrictEqual(storedTypeOfBytes(iso('isom')))
  })
})

describe('encodedFrameCount', () => {
  it('reads the last frame count of the progress output', () => {
    expect(encodedFrameCount('frame=12\nfps=0.0\nprogress=continue\nframe=24\nprogress=end\n')).toBe(24)
    expect(encodedFrameCount('me=3\nprogress=end\n')).toBeNull()
    expect(encodedFrameCount('')).toBeNull()
  })
})

describe('encodedClipProblem', () => {
  it('keeps a clip with every frame, under the size limit', () => {
    expect(encodedClipProblem('s.frames', PNG_SEQUENCE, { size: APP_RUN_MAX_OUTPUT_BYTES, frames: 3 })).toBeNull()
  })

  // ffmpeg leaves out a PNG frame that it cannot read, with no error.
  it('tells of a clip with fewer frames, a clip over the size limit, and no clip', () => {
    expect(encodedClipProblem('s.frames', PNG_SEQUENCE, { size: 10, frames: 2 })).toBe('s.frames/ (ffmpeg encoded 2 of its 3 frames: a frame is no PNG file that ffmpeg can read)')
    expect(encodedClipProblem('s.frames', PNG_SEQUENCE, { size: 10, frames: null })).toContain('ffmpeg encoded 0 of its 3 frames')
    expect(encodedClipProblem('s.frames', PNG_SEQUENCE, { size: APP_RUN_MAX_OUTPUT_BYTES + 1, frames: 3 })).toContain(`its clip is larger than ${byteSizeText(APP_RUN_MAX_OUTPUT_BYTES)}`)
    expect(encodedClipProblem('s.frames', PNG_SEQUENCE, { size: null, frames: 3 })).toBe('s.frames/ (ffmpeg made no clip of it)')
  })
})

describe('encodeErrorLine', () => {
  it('gives the last line of the error output, with no mark of the part of ffmpeg', () => {
    const errors = '[png @ 0xffff8a444870] Invalid PNG signature 0x00000000.\n'
      + '[vist#0:0/png @ 0xffff8a41d7f0] [dec:png @ 0xffff8a462aa0] Decoding error: Invalid data found when processing input\n'
    expect(encodeErrorLine(errors)).toBe('Decoding error: Invalid data found when processing input')
    expect(encodeErrorLine('')).toBe('')
    expect(encodeErrorLine(`x ${'y'.repeat(500)}`).length).toBe(200)
  })
})
