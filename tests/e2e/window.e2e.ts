import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { WindowGeometry } from '../../src/model/state/settings'
import { startApp, type RunningApp } from './harness/app'
import { screenshotOnFailure, waitFor, waitForValue } from './harness/dom'
import { readAppState, seedAppState } from './harness/fixtures'
import { createSession, destroySession, type E2EBrowser } from './harness/session'

// The main window opens with the geometry saved in app_state.json, fitted to
// the screen: a saved window that is larger than the screen and off it opens
// inside the screen. A resize and a move are saved and come back after a
// relaunch, at the same size.
//
// Wayland gives no window positions: there the position always reads (0,0)
// and a move does nothing, so the position checks hold there trivially. CI
// runs these specs on X11 (xvfb-run), where they are real. Under Wayland,
// GTK draws the window frame, and the read size is larger than the saved
// one; the size checks are real there.

interface Rect {
  x: number
  y: number
  width: number
  height: number
}

interface WindowState {
  visible: boolean
  /** Logical inner size, as tao reads it. */
  width: number
  height: number
  /** Physical outer position. */
  x: number
  y: number
  scale: number
  /** Physical work areas of the monitors. */
  workAreas: Rect[]
}

// A size that fits a screen of 640x400 logical px, and is not smaller than
// the minimum size in tauri.conf.json.
const RESIZED = { width: 620, height: 400 }
const MOVED = { x: 40, y: 30 }
// More growth than any GTK frame adds; still fits a 1280x800 logical screen
// with the frame.
const GROWN = { width: RESIZED.width + 250, height: RESIZED.height + 250 }

// The window API that the app uses, called in the page.
async function windowState (browser: E2EBrowser): Promise<WindowState> {
  return browser.execute(async () => {
    interface Point { x: number; y: number }
    interface Size { width: number; height: number }
    const internals = Reflect.get(window, '__TAURI_INTERNALS__') as {
      invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>
    }
    const label = { label: 'main' }
    const [visible, scale, inner, position, monitors] = await Promise.all([
      internals.invoke('plugin:window|is_visible', label),
      internals.invoke('plugin:window|scale_factor', label),
      internals.invoke('plugin:window|inner_size', label),
      internals.invoke('plugin:window|outer_position', label),
      internals.invoke('plugin:window|available_monitors'),
    ]) as [boolean, number, Size, Point, { workArea: { position: Point; size: Size } }[]]
    return {
      visible,
      width: Math.round(inner.width / scale),
      height: Math.round(inner.height / scale),
      ...position,
      scale,
      workAreas: monitors.map(({ workArea }) => ({ ...workArea.position, ...workArea.size })),
    }
  })
}

// The work area that holds the whole saved window, if any. The saved size is
// logical and the work areas are physical.
function workAreaHolding (geometry: WindowGeometry, { scale, workAreas }: WindowState): Rect | undefined {
  return workAreas.find((area) => geometry.x >= area.x && geometry.y >= area.y &&
    geometry.x + geometry.width * scale <= area.x + area.width &&
    geometry.y + geometry.height * scale <= area.y + area.height)
}

describe('window geometry', () => {
  let app: RunningApp
  let browser: E2EBrowser

  async function savedGeometry (): Promise<WindowGeometry | null> {
    return (await readAppState(app.home))?.window ?? null
  }

  beforeAll(async () => {
    app = await startApp()
    try {
      // From a larger screen, and on a monitor left of and below this one.
      await seedAppState(app.home, { window: { width: 5000, height: 4000, x: -9000, y: 9000, maximized: false } })
      browser = await createSession(app.binary, app.port)
    } catch (err) {
      await app.stop()
      throw err
    }
    await waitFor(browser, 'header.tab-bar', 60_000)
  })

  afterEach(async (ctx) => {
    await screenshotOnFailure(browser, ctx)
  })

  afterAll(async () => {
    await destroySession(browser)
    await app?.stop()
  })

  it('fits a saved window that is larger than the screen and off it into the screen', async () => {
    // The tracker saves the fitted geometry over the seeded one.
    await waitForValue(browser, 'saved geometry fits a work area', async () => {
      const saved = await savedGeometry()
      return saved !== null && saved.width !== 5000 && workAreaHolding(saved, await windowState(browser)) !== undefined
    }, true)
    const saved = await savedGeometry() as WindowGeometry
    const state = await windowState(browser)
    const area = workAreaHolding(saved, state) as Rect
    // The fit clamps the 5000 px wide seed to the width of the work area. A
    // restore that failed or ignored the seed leaves the 900 px wide default
    // of tauri.conf.json, which fits a large screen too, so only the width
    // shows that the fit ran.
    expect(saved.width * state.scale).toBeGreaterThan(area.width * 0.9)
    expect(saved.height).toBeGreaterThanOrEqual(400)
  })

  // Regression: under Wayland the saved read size included the frame, so
  // the window got larger at each launch.
  it('saves a resize and a move, and restores them after a relaunch', async () => {
    await browser.execute(async (size: typeof RESIZED, position: typeof MOVED) => {
      const internals = Reflect.get(window, '__TAURI_INTERNALS__') as {
        invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>
      }
      await internals.invoke('plugin:window|set_size', { label: 'main', value: { Logical: size } })
      await internals.invoke('plugin:window|set_position', { label: 'main', value: { Physical: position } })
    }, RESIZED, MOVED)
    await waitForValue(browser, 'saved size', async () => {
      const saved = await savedGeometry()
      return saved && { width: saved.width, height: saved.height }
    }, RESIZED)
    const moved = await windowState(browser)
    expect(await savedGeometry()).toEqual({ ...RESIZED, x: moved.x, y: moved.y, maximized: false })

    await destroySession(browser)
    browser = await createSession(app.binary, app.port)
    await waitFor(browser, 'header.tab-bar', 60_000)
    const placement = ({ visible, width, height, x, y }: WindowState) => ({ visible, width, height, x, y })
    await waitForValue(browser, 'restored window', async () => placement(await windowState(browser)), placement(moved))
  })

  // Regression: the tracker took all growth before its first save as the
  // frame extent, and took it away from every save in that session. So a
  // resize while the app started (by the user, or a tiling window manager)
  // was lost.
  it('saves a resize that comes before the first save after a launch', async () => {
    await destroySession(browser)
    browser = await createSession(app.binary, app.port)
    // At once: createSession returns when the window shows, and the first
    // save comes at least 500 ms after the rest of the startup.
    await browser.execute(async (size: typeof GROWN) => {
      const internals = Reflect.get(window, '__TAURI_INTERNALS__') as {
        invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>
      }
      await internals.invoke('plugin:window|set_size', { label: 'main', value: { Logical: size } })
    }, GROWN)
    await waitFor(browser, 'header.tab-bar', 60_000)
    // Under Wayland the saved size also holds the frame: growth this large
    // gives no frame extent. So the check is "not smaller than GROWN".
    await waitForValue(browser, 'saved size', async () => {
      const saved = await savedGeometry()
      return saved && { width: Math.min(saved.width, GROWN.width), height: Math.min(saved.height, GROWN.height) }
    }, GROWN)
  })
})
