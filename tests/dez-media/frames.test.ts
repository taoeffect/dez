import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FrameWriter } from '../../src-tauri/libs/dez-media/frames.js'
import { APP_RUN_MAX_FRAMES, FRAMES_MAX_FPS, FRAMES_MAX_SIDE, FRAMES_MIN_FPS } from '../../src/model/tools/appsTool'
import { checkedSequence } from '../../src/model/tools/frameSequences'
import { folderTree, PNG_BYTES } from '../../src/model/tools/testing'

// The writer of a frame sequence, on a temp folder in place of the output
// folder of a run. Each folder that it writes must pass the check of Dez
// (`checkedSequence`), which the encode of the folder needs.

let output = ''

// A canvas of skia-canvas, as the writer uses it.
const canvas = { toBufferSync: (format: 'png') => (format === 'png' ? PNG_BYTES : new Uint8Array()) }

// What Dez checks of the folder `name` of the output folder.
function dezCheck(name: string) {
  const folder = join(output, name)
  const sizes = Object.fromEntries(readdirSync(folder).map((entry) => [entry, statSync(join(folder, entry)).size]))
  return checkedSequence(name, folderTree(sizes), readFileSync(join(folder, 'frames.json')))
}

beforeEach(() => {
  output = mkdtempSync(join(tmpdir(), 'dez-frames-'))
})

afterEach(() => {
  rmSync(output, { recursive: true, force: true })
})

describe('dez-media FrameWriter', () => {
  it('writes canvases as PNG frames from 000000, and frames.json with the count, which Dez takes', () => {
    const writer = new FrameWriter(output, 'intro', { fps: 30, width: 64, height: 36 })
    for (let index = 0; index < 3; index++) writer.add(canvas)

    expect(writer.end()).toBe(3)
    expect(readdirSync(join(output, 'intro.frames')).sort()).toStrictEqual(['000000.png', '000001.png', '000002.png', 'frames.json'])
    expect(readFileSync(join(output, 'intro.frames/000001.png'))).toStrictEqual(Buffer.from(PNG_BYTES))
    expect(dezCheck('intro.frames')).toStrictEqual({ sequence: { fps: 30, width: 64, height: 36, count: 3, alpha: false, format: 'png' } })
  })

  it('writes raw RGBA frames with alpha, which Dez takes', () => {
    const writer = new FrameWriter(output, 'glow', { fps: 12.5, width: 3, height: 2, alpha: true })
    writer.add(new Uint8ClampedArray(3 * 2 * 4).fill(255))
    writer.add(new Uint8Array(3 * 2 * 4))

    expect(writer.end()).toBe(2)
    expect(readFileSync(join(output, 'glow.frames/000000.rgba'))).toStrictEqual(Buffer.alloc(24, 255))
    expect(dezCheck('glow.frames')).toStrictEqual({ sequence: { fps: 12.5, width: 3, height: 2, count: 2, alpha: true, format: 'rgba' } })
  })

  it('refuses a raw frame of another size, a frame of the other kind, and a value that is no frame', () => {
    const writer = new FrameWriter(output, 'mixed', { fps: 30, width: 2, height: 2 })
    expect(() => writer.add(new Uint8Array(15))).toThrow('A raw frame of 2 × 2 pixels has 16 bytes')
    // A PNG file in a byte array is no raw frame.
    expect(() => writer.add(PNG_BYTES)).toThrow(RangeError)
    expect(() => writer.add('frame.png' as never)).toThrow(TypeError)
    writer.add(new Uint8Array(16))
    expect(() => writer.add(canvas)).toThrow('and the first frame was raw RGBA pixels')
  })

  it('refuses a name that the file calls of Dez do not take, and facts that are no clip', () => {
    for (const name of ['my intro', 'a/b', '', 'é']) expect(() => new FrameWriter(output, name, { fps: 30, width: 2, height: 2 }), name).toThrow(RangeError)
    expect(() => new FrameWriter('', 'intro', { fps: 30, width: 2, height: 2 })).toThrow('dez.outputFolder')
    expect(() => new FrameWriter(output, 'intro', { fps: 0, width: 2, height: 2 })).toThrow('`fps`')
    expect(() => new FrameWriter(output, 'intro', { fps: 30, width: 2.5, height: 2 })).toThrow('`width` and `height`')
    expect(() => new FrameWriter(output, 'intro', { fps: 30, width: 2, height: 2, alpha: 'yes' as never })).toThrow('`alpha`')
  })

  // The writer has copies of the limits of Dez (`parsedFacts`), so that a
  // run does not draw a clip that Dez refuses after it.
  it('takes the facts of a clip that Dez takes, and refuses the others before the first frame', () => {
    const taken = [
      { fps: FRAMES_MIN_FPS, width: 2, height: 2 },
      { fps: FRAMES_MAX_FPS, width: FRAMES_MAX_SIDE, height: FRAMES_MAX_SIDE },
      { fps: 30, width: 63, height: 1, alpha: true },
    ]
    for (const [index, facts] of taken.entries()) {
      const writer = new FrameWriter(output, `taken-${index}`, facts)
      writer.add(canvas)
      writer.end()
      expect(dezCheck(`taken-${index}.frames`), JSON.stringify(facts)).toHaveProperty('sequence')
    }

    const fpsRule = `a number from ${FRAMES_MIN_FPS} to ${FRAMES_MAX_FPS}`
    expect(() => new FrameWriter(output, 'slow', { fps: FRAMES_MIN_FPS / 2, width: 2, height: 2 })).toThrow(fpsRule)
    expect(() => new FrameWriter(output, 'fast', { fps: FRAMES_MAX_FPS + 1, width: 2, height: 2 })).toThrow(fpsRule)
    const sizeRule = `whole numbers from 1 to ${FRAMES_MAX_SIDE}`
    expect(() => new FrameWriter(output, 'wide', { fps: 30, width: FRAMES_MAX_SIDE + 2, height: 2 })).toThrow(sizeRule)
    expect(() => new FrameWriter(output, 'tall', { fps: 30, width: 2, height: FRAMES_MAX_SIDE + 1, alpha: true })).toThrow(sizeRule)
    expect(() => new FrameWriter(output, 'odd', { fps: 30, width: 1281, height: 720 })).toThrow('needs an even `width` and an even `height`, and 1281 × 720 is not')
    expect(() => new FrameWriter(output, 'odd', { fps: 30, width: 1280, height: 719 })).toThrow('and 1280 × 719 is not')
    // A refused writer leaves no folder, which Dez would refuse in its result.
    expect(readdirSync(output).sort()).toStrictEqual(['taken-0.frames', 'taken-1.frames', 'taken-2.frames'])
  })

  it('takes as many frames as Dez encodes into one clip, and refuses one more', () => {
    const writer = new FrameWriter(output, 'long', { fps: 60, width: 2, height: 2 })
    const frame = new Uint8Array(2 * 2 * 4)
    for (let index = 0; index < APP_RUN_MAX_FRAMES; index++) writer.add(frame)

    expect(() => writer.add(frame)).toThrow(`at most ${APP_RUN_MAX_FRAMES.toLocaleString('en-US')} frames`)
    expect(writer.end()).toBe(APP_RUN_MAX_FRAMES)
    expect(dezCheck('long.frames')).toHaveProperty('sequence.count', APP_RUN_MAX_FRAMES)
  })

  it('writes frames.json once, after at least one frame, and no frame after it', () => {
    const writer = new FrameWriter(output, 'intro', { fps: 30, width: 2, height: 2 })
    expect(() => writer.end()).toThrow('before any frame')
    writer.add(canvas)
    writer.end()

    expect(() => writer.add(canvas)).toThrow('after end()')
    expect(() => writer.end()).toThrow('a second time')
    expect(readdirSync(join(output, 'intro.frames')).sort()).toStrictEqual(['000000.png', 'frames.json'])
  })
})
