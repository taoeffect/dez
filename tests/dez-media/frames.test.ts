import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FrameWriter } from '../../src-tauri/libs/dez-media/frames.js'
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
