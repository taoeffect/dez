import { describe, expect, it } from 'vitest'
import { fitWindowGeometry, screenInPoints, type MonitorArea, type MonitorInfo, type WindowFitOptions, type WindowPlacement } from './windowFit'

function monitor(x: number, y: number, width: number, height: number, scaleFactor = 1): MonitorArea {
  return { workArea: { position: { x, y }, size: { width, height } }, scaleFactor }
}

const main = monitor(0, 0, 1920, 1080)
const left = monitor(-1280, 0, 1280, 1024)

function options(overrides: Partial<WindowFitOptions> = {}): WindowFitOptions {
  return {
    monitors: [main],
    primary: main,
    minSize: { width: 600, height: 400 },
    frame: { width: 0, height: 0 },
    ...overrides,
  }
}

function saved(width: number, height: number, x: number | null, y = 0, maximized = false): WindowPlacement {
  return { width, height, position: x === null ? null : { x, y }, maximized }
}

describe('fitWindowGeometry', () => {
  it('keeps a saved geometry that fits', () => {
    expect(fitWindowGeometry(saved(1000, 700, 200, 100), options()))
      .toEqual({ width: 1000, height: 700, position: { x: 200, y: 100 }, maximized: false })
  })

  it('centers the window on the primary monitor when its monitor is gone', () => {
    expect(fitWindowGeometry(saved(1000, 700, 2500, 200), options()).position).toEqual({ x: 460, y: 190 })
  })

  it('shrinks and moves a window that is larger than a smaller screen', () => {
    expect(fitWindowGeometry(saved(1800, 1000, 100, 50), options({ monitors: [monitor(0, 0, 1366, 768)], primary: null })))
      .toEqual({ width: 1366, height: 768, position: { x: 0, y: 0 }, maximized: false })
    expect(fitWindowGeometry(saved(4000, 3000, 0, 0), options()))
      .toEqual({ width: 1920, height: 1080, position: { x: 0, y: 0 }, maximized: false })
  })

  it('moves a window that is partly off the screen back inside, on each side', () => {
    const position = (x: number, y: number) => fitWindowGeometry(saved(900, 700, x, y), options()).position
    expect(position(1500, 100)).toEqual({ x: 1020, y: 100 })
    expect(position(-300, 100)).toEqual({ x: 0, y: 100 })
    expect(position(200, -50)).toEqual({ x: 200, y: 0 })
    expect(position(200, 900)).toEqual({ x: 200, y: 380 })
  })

  it('centers a window that is wholly off the screen, on each side', () => {
    const centered = { x: 510, y: 190 }
    const position = (x: number, y: number) => fitWindowGeometry(saved(900, 700, x, y), options()).position
    expect(position(-3000, 100)).toEqual(centered)
    expect(position(5000, 100)).toEqual(centered)
    expect(position(100, -3000)).toEqual(centered)
    expect(position(100, 5000)).toEqual(centered)
  })

  it('keeps the title bar inside the work area, below a top panel', () => {
    const belowPanel = options({ monitors: [monitor(0, 32, 1920, 1048)], primary: null })
    expect(fitWindowGeometry(saved(800, 600, 100, 0), belowPanel).position).toEqual({ x: 100, y: 32 })
  })

  it('uses a monitor left of the primary one, at negative x', () => {
    const both = options({ monitors: [main, left] })
    const position = (x: number) => fitWindowGeometry(saved(800, 600, x, 100), both).position
    expect(position(-1000)).toEqual({ x: -1000, y: 100 })
    expect(position(-1400)).toEqual({ x: -1280, y: 100 })
    // Mostly on the primary monitor: it moves onto that one.
    expect(position(-200)).toEqual({ x: 0, y: 100 })
  })

  it('centers a window with no saved position on the primary monitor, else the first', () => {
    expect(fitWindowGeometry(saved(900, 700, null), options({ monitors: [left, main] })))
      .toEqual({ width: 900, height: 700, position: { x: 510, y: 190 }, maximized: false })
    expect(fitWindowGeometry(saved(900, 700, null), options({ monitors: [left, main], primary: null })).position)
      .toEqual({ x: -1090, y: 162 })
  })

  it('converts the logical size with the scale factor of the chosen monitor', () => {
    const hiDpi = monitor(1920, 0, 3840, 2160, 2)
    const mixed = options({ monitors: [main, hiDpi] })
    expect(fitWindowGeometry(saved(1200, 800, 2000, 100), mixed))
      .toEqual({ width: 1200, height: 800, position: { x: 2000, y: 100 }, maximized: false })
    // 3840x2160 physical px at scale 2 holds at most 1920x1080 logical px.
    expect(fitWindowGeometry(saved(2400, 1500, 2000, 100), mixed))
      .toEqual({ width: 1920, height: 1080, position: { x: 1920, y: 0 }, maximized: false })
    // The same window when the HiDPI monitor is gone.
    expect(fitWindowGeometry(saved(1600, 1000, 2200, 100), options()))
      .toEqual({ width: 1600, height: 1000, position: { x: 160, y: 40 }, maximized: false })
  })

  it('counts the frame in the size that must fit', () => {
    const laptop = options({ monitors: [monitor(0, 50, 2880, 1750, 2)], primary: null, frame: { width: 0, height: 28 } })
    expect(fitWindowGeometry(saved(1440, 900, 0, 50), laptop))
      .toEqual({ width: 1440, height: 847, position: { x: 0, y: 50 }, maximized: false })
  })

  it('keeps the min size unless the work area is smaller', () => {
    expect(fitWindowGeometry(saved(300, 200, 100, 100), options()))
      .toEqual({ width: 600, height: 400, position: { x: 100, y: 100 }, maximized: false })
    expect(fitWindowGeometry(saved(300, 200, 0, 0), options({ monitors: [monitor(0, 0, 500, 350)], primary: null })))
      .toEqual({ width: 500, height: 350, position: { x: 0, y: 0 }, maximized: false })
  })

  it('passes maximized through, with the fitted normal geometry', () => {
    expect(fitWindowGeometry(saved(4000, 3000, 5000, 0, true), options()))
      .toEqual({ width: 1920, height: 1080, position: { x: 0, y: 0 }, maximized: true })
  })

  it('applies only the saved size when no monitors are reported', () => {
    expect(fitWindowGeometry(saved(1000, 700, 200, 100, true), options({ monitors: [], primary: null })))
      .toEqual({ width: 1000, height: 700, position: null, maximized: true })
  })
})

describe('screenInPoints', () => {
  // How Tauri 2.10 reports macOS screens: rects are points times each
  // screen's own scale factor, and the work area starts at the screen top
  // but is only as high as the screen below the menu bar.
  function macScreen(x: number, y: number, width: number, height: number, scaleFactor: number, menuBar = 0): MonitorInfo {
    const position = { x: x * scaleFactor, y: y * scaleFactor }
    const size = { width: width * scaleFactor, height: height * scaleFactor }
    return { position, size, workArea: { position, size: { ...size, height: size.height - menuBar * scaleFactor } }, scaleFactor }
  }

  const retina = macScreen(0, 0, 1512, 982, 2, 33)
  const external = macScreen(1512, 0, 1920, 1080, 1, 25)
  const mac = options({ monitors: [retina, external].map(screenInPoints), primary: screenInPoints(retina), frame: { width: 0, height: 28 } })

  it('keeps a window on a non-Retina screen right of a Retina one', () => {
    // In physical px the Retina screen (0..3024) covers this place too.
    expect(fitWindowGeometry(saved(1000, 700, 2000, 100), mac))
      .toEqual({ width: 1000, height: 700, position: { x: 2000, y: 100 }, maximized: false })
  })

  it('keeps a window at the bottom of the screen where it is', () => {
    expect(fitWindowGeometry(saved(800, 600, 100, 354), mac))
      .toEqual({ width: 800, height: 600, position: { x: 100, y: 354 }, maximized: false })
  })
})
