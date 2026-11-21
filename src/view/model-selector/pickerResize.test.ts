import { describe, expect, it } from 'vitest'
import type { ModelPickerSize } from '../../model/modelPickerSize'
import { draggedPickerSize, fitPickerSize, pickerRoom, type PickerDragStart, type PickerEdge } from './pickerResize'

const room = { width: 1000, height: 700 }

function start (
  edge: PickerEdge,
  rendered = { width: 400, height: 500 },
  size: ModelPickerSize = { width: 400, maxHeight: 500 },
): PickerDragStart {
  return { edge, rendered, size, room }
}

describe('draggedPickerSize', () => {
  it('changes only the dimensions of its edge, larger up and to the right', () => {
    expect(draggedPickerSize(start('top'), 30, -120)).toStrictEqual({ width: 400, maxHeight: 620 })
    expect(draggedPickerSize(start('right'), 150, -40)).toStrictEqual({ width: 550, maxHeight: 500 })
    expect(draggedPickerSize(start('corner'), 100, -80)).toStrictEqual({ width: 500, maxHeight: 580 })
    expect(draggedPickerSize(start('corner'), -20, 30)).toStrictEqual({ width: 380, maxHeight: 470 })
  })

  // A short list: the picker is 400 px tall under a limit of 600.
  it('starts a move down from the drawn picker, and a move up or no move keeps the stored limit', () => {
    const short = { width: 400, height: 400 }
    const size = { width: 400, maxHeight: 600 }
    expect(draggedPickerSize(start('top', short, size), 0, -10)).toStrictEqual({ width: 400, maxHeight: 600 })
    expect(draggedPickerSize(start('top', short, size), 0, -250)).toStrictEqual({ width: 400, maxHeight: 650 })
    expect(draggedPickerSize(start('top', short, size), 0, 10)).toStrictEqual({ width: 400, maxHeight: 390 })
    expect(draggedPickerSize(start('corner', short, size), 50, 0)).toStrictEqual({ width: 450, maxHeight: 600 })
    expect(draggedPickerSize(start('right', short, size), 50, 0)).toStrictEqual({ width: 450, maxHeight: 600 })
  })

  it('stays between the default size and the room', () => {
    expect(draggedPickerSize(start('corner'), -1000, 1000)).toStrictEqual({ width: 320, maxHeight: 360 })
    expect(draggedPickerSize(start('corner'), 1000, -1000)).toStrictEqual({ width: 1000, maxHeight: 700 })
  })

  // The stored 400 × 500 does not fit: `fitPickerSize` draws 300 × 250.
  const small = { ...start('corner', { width: 300, height: 250 }), room: { width: 300, height: 250 } }

  it('keeps the stored size when a small window stops a move up and to the right', () => {
    expect(draggedPickerSize(small, 40, -40)).toStrictEqual({ width: 400, maxHeight: 500 })
    expect(draggedPickerSize(small, 0, -40)).toStrictEqual({ width: 400, maxHeight: 500 })
  })

  it('gives the room when the window is too small for the default size', () => {
    expect(draggedPickerSize(small, -40, 40)).toStrictEqual({ width: 300, maxHeight: 250 })
  })

  it('rounds to whole px', () => {
    expect(draggedPickerSize(start('corner', { width: 400.5, height: 500.25 }), 10.2, -10.4))
      .toStrictEqual({ width: 411, maxHeight: 511 })
  })
})

describe('pickerRoom', () => {
  it('leaves the margin at the top and right edges of the window, in whole px', () => {
    expect(pickerRoom({ left: 8, bottom: 668 }, 900)).toStrictEqual({ width: 884, height: 660 })
    expect(pickerRoom({ left: 8.5, bottom: 668.6 }, 900)).toStrictEqual({ width: 883, height: 660 })
  })
})

describe('fitPickerSize', () => {
  it('makes the shown size smaller when the window has no room for it, and else keeps it', () => {
    const roomy = { width: 700, height: 500 }
    expect(fitPickerSize({ width: 900, maxHeight: 800 }, roomy)).toStrictEqual({ width: 700, maxHeight: 500 })
    expect(fitPickerSize({ width: 400, maxHeight: 420 }, roomy)).toStrictEqual({ width: 400, maxHeight: 420 })
    expect(fitPickerSize({ width: 900, maxHeight: 800 }, null)).toStrictEqual({ width: 900, maxHeight: 800 })
  })
})
