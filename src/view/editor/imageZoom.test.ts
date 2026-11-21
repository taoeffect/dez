import { describe, expect, it } from 'vitest'
import { zoomedImageRect } from './imageZoom'

describe('zoomedImageRect', () => {
  const area = { width: 1000, height: 600 }

  it('shrinks a wide image to the width of the room, at its aspect ratio, in the middle', () => {
    expect(zoomedImageRect(area, { width: 4000, height: 1000 }, 50)).toEqual({ left: 50, top: 188, width: 900, height: 225 })
  })

  it('shrinks a tall image to the height of the room', () => {
    expect(zoomedImageRect(area, { width: 1000, height: 2000 }, 50)).toEqual({ left: 375, top: 50, width: 250, height: 500 })
  })

  it('grows a small image until it fills the room one way', () => {
    expect(zoomedImageRect(area, { width: 40, height: 30 }, 50)).toEqual({ left: 167, top: 50, width: 667, height: 500 })
  })

  it('gives an image with no natural size the whole room', () => {
    expect(zoomedImageRect(area, { width: 0, height: 0 }, 50)).toEqual({ left: 50, top: 50, width: 900, height: 500 })
  })

  it('keeps at least one pixel each way when the margins take the whole area', () => {
    expect(zoomedImageRect({ width: 80, height: 60 }, { width: 40, height: 30 }, 52)).toEqual({ left: 40, top: 30, width: 1, height: 1 })
  })
})
