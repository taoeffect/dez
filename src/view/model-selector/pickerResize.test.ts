import { describe, expect, it } from 'vitest'
import { MODEL_PICKER_SIZE_DEFAULT } from '../../model/modelPickerSize'
import { draggedPickerSize, fitPickerSize, pickerRoom, type BoxSize, type PickerDragStart, type PickerEdge } from './pickerResize'

const room = { width: 1000, height: 700 }

// The start of a drag of the model picker.
function start (
  edge: PickerEdge,
  rendered = { width: 400, height: 500 },
  size: BoxSize = { width: 400, maxHeight: 500 },
): PickerDragStart {
  return { edge, rendered, size, room, min: MODEL_PICKER_SIZE_DEFAULT, noLimitAtRoomTop: false }
}

// The start of a drag of a box whose height has no limit by default (the
// settings panel), with a smaller minimum than the picker's.
function panelStart (
  edge: PickerEdge,
  rendered = { width: 300, height: 500 },
  size: BoxSize = { width: 250, maxHeight: Infinity },
): PickerDragStart {
  return { edge, rendered, size, room, min: { width: 250, maxHeight: 160 }, noLimitAtRoomTop: true }
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

describe('draggedPickerSize of a box with no height limit', () => {
  it('stays at or over the minimum of its start', () => {
    expect(draggedPickerSize(panelStart('corner'), -1000, 1000)).toStrictEqual({ width: 250, maxHeight: 160 })
    expect(draggedPickerSize(panelStart('top'), 0, 100)).toStrictEqual({ width: 250, maxHeight: 400 })
  })

  it('gives no limit for a drag up to the top of the room, and a limit for a drag up that stays under it', () => {
    const limited = panelStart('top', { width: 300, height: 300 }, { width: 250, maxHeight: 300 })
    expect(draggedPickerSize(limited, 0, -150)).toStrictEqual({ width: 250, maxHeight: 450 })
    expect(draggedPickerSize(limited, 0, -400)).toStrictEqual({ width: 250, maxHeight: Infinity })
    expect(draggedPickerSize(limited, 0, -1000)).toStrictEqual({ width: 250, maxHeight: Infinity })
    expect(draggedPickerSize({ ...limited, edge: 'corner' }, 20, -400)).toStrictEqual({ width: 320, maxHeight: Infinity })
    // The model picker keeps a number.
    expect(draggedPickerSize(start('top'), 0, -1000)).toStrictEqual({ width: 400, maxHeight: 700 })
  })

  it('keeps no limit for a drag of the right edge, and for a drag up of a box shorter than the room', () => {
    expect(draggedPickerSize(panelStart('right'), 40, -30)).toStrictEqual({ width: 340, maxHeight: Infinity })
    expect(draggedPickerSize(panelStart('top'), 0, -20)).toStrictEqual({ width: 250, maxHeight: Infinity })
    expect(draggedPickerSize(panelStart('corner'), 0, 0)).toStrictEqual({ width: 250, maxHeight: Infinity })
  })

  it('starts a drag down from the drawn height', () => {
    expect(draggedPickerSize(panelStart('top'), 0, 30)).toStrictEqual({ width: 250, maxHeight: 470 })
  })

  // A small window draws a stored limit of 500 at the room's 400 px.
  it('gives no limit for a drag up when the window draws the box at the room height', () => {
    const small = { ...panelStart('top', { width: 300, height: 400 }, { width: 250, maxHeight: 500 }), room: { width: 600, height: 400 } }
    expect(draggedPickerSize(small, 0, -10)).toStrictEqual({ width: 250, maxHeight: Infinity })
    expect(draggedPickerSize(small, 0, 10)).toStrictEqual({ width: 250, maxHeight: 390 })
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
