import { describe, expect, it } from 'vitest'
import { audioPartFrames } from './audioCut'

describe('audioPartFrames', () => {
  it('gives the frames of the part, each end at the nearest frame', () => {
    expect(audioPartFrames({ start: 1, end: 2.5 }, 48000, 48000 * 3)).toStrictEqual({ from: 48000, to: 120000 })
    expect(audioPartFrames({ start: 0.00001, end: 0.00004 }, 48000, 100)).toStrictEqual({ from: 0, to: 2 })
  })

  it('ends at the last frame for an end past it', () => {
    expect(audioPartFrames({ start: 1, end: 3.00001 }, 48000, 48000 * 3)).toStrictEqual({ from: 48000, to: 144000 })
  })

  it('keeps at least one frame for a part shorter than one frame, also at the clip end', () => {
    expect(audioPartFrames({ start: 1, end: 1.000001 }, 48000, 48000 * 3)).toStrictEqual({ from: 48000, to: 48001 })
    expect(audioPartFrames({ start: 2.99999, end: 3 }, 48000, 48000 * 3)).toStrictEqual({ from: 143999, to: 144000 })
  })
})
