import sbp from '@sbp/sbp'
import { isTauri } from '@tauri-apps/api/core'
import { LogicalPosition, LogicalSize, PhysicalPosition, availableMonitors, getCurrentWindow, primaryMonitor } from '@tauri-apps/api/window'
import { debounce } from 'turtledash'
import type { SettingsSnapshot } from '../model/state'
import type { WindowGeometry } from '../model/state/settings'
import { isMacPlatform } from '../utils/platform'
import { fitWindowGeometry, screenInPoints, type Extent } from './windowFit'

// `minWidth` and `minHeight` of the main window in tauri.conf.json; the
// window API cannot read them.
const WINDOW_MIN_SIZE = { width: 600, height: 400 }

// The geometry to save while the window is maximized: the maximized size is
// not one to open with, and an unmaximize must return to this one.
let lastNormalGeometry: WindowGeometry | null = null
let stopWindowTracking: (() => void) | null = null

// With GTK client-side decorations (Linux, mostly Wayland), the size that
// `innerSize()` reads includes the invisible shadow and the header bar, but
// `setSize()` sets the size without the shadow. A saved read size would make
// the window larger at each launch. The difference between the size that the
// restore set and the first size that the tracker reads is that extent; it
// is 0 on the other platforms. The tracker takes it away before it saves.
// https://github.com/tauri-apps/plugins-workspace/issues/3553
let restoredSize: Extent | null = null
let decorationExtent: Extent | null = null

// GTK's shadow and header bar add well under this many logical px (+52 and
// +99 measured under kwin). A larger growth before the first tracker read
// is a resize by the user or by a tiling window manager, not a decoration;
// it gives no extent, so the window grows by the real extent once, at the
// next launch, instead of losing that resize from every save.
const MAX_DECORATION_EXTENT = 150

function decorationExtentOf (readLength: number, restoredLength: number | undefined): number {
  const growth = readLength - (restoredLength ?? readLength)
  return growth > 0 && growth <= MAX_DECORATION_EXTENT ? growth : 0
}

export default sbp('sbp/selectors/register', {
  // The main window starts hidden (`visible: false` in tauri.conf.json), so
  // it never shows at the default size before it moves to the saved one; on
  // macOS only, lib.rs shows it at launch, so that it comes to the front.
  // The saved geometry can be from another screen setup, so it is fitted to
  // the monitors there are now. Every path shows the window, also when the
  // restore fails: a window that stays hidden looks like an app that does
  // not start. On Linux and Windows only this selector shows the window, so
  // when the frontend fails before `dez.controller/app/init` runs (for
  // example a compile error in `npm run tauri dev`), no window shows; read
  // the Vite output. Wayland gives no window positions: there only the size
  // and maximized are restored, and the compositor places the window.
  async 'dez.controller/window/restore' (): Promise<void> {
    if (!isTauri()) return
    const appWindow = getCurrentWindow()
    try {
      const saved = (sbp('dez.model/settings/snapshot') as SettingsSnapshot).windowGeometry
      const [monitors, primary, scale, inner, outer] = await Promise.all([
        availableMonitors(),
        primaryMonitor(),
        appWindow.scaleFactor(),
        appWindow.innerSize(),
        appWindow.outerSize(),
      ])
      // On Linux the frame is known only after the window is first shown;
      // until then the outer size can even be less than the inner size.
      const frame = {
        width: Math.max(0, outer.width - inner.width) / scale,
        height: Math.max(0, outer.height - inner.height) / scale,
      }
      // The saved position is in logical points on macOS and in physical px
      // on the other platforms: each is the one space that the window system
      // uses for all screens. On macOS, `setPosition` converts physical px
      // with the scale factor of the screen that the window is on now, not
      // that of the saved place, and a window that was never shown reads a
      // scale factor of 1, also on a Retina screen: the window opened at
      // twice its saved position. Points need no scale factor.
      // https://github.com/tauri-apps/plugins-workspace/issues/3521
      // With nothing saved, the default size from tauri.conf.json is centered.
      const placement = fitWindowGeometry(
        saved
          ? { width: saved.width, height: saved.height, position: { x: saved.x, y: saved.y }, maximized: saved.maximized }
          : { width: inner.width / scale, height: inner.height / scale, position: null, maximized: false },
        {
          monitors: isMacPlatform ? monitors.map(screenInPoints) : monitors,
          primary: isMacPlatform && primary ? screenInPoints(primary) : primary,
          minSize: WINDOW_MIN_SIZE,
          frame,
        },
      )
      // The position goes after the size, so that a resize cannot move the
      // window after it is placed.
      await appWindow.setSize(new LogicalSize(placement.width, placement.height))
      restoredSize = { width: Math.round(placement.width), height: Math.round(placement.height) }
      decorationExtent = null
      if (placement.position) {
        const { x, y } = placement.position
        await appWindow.setPosition(isMacPlatform ? new LogicalPosition(x, y) : new PhysicalPosition(x, y))
        lastNormalGeometry = { ...restoredSize, ...placement.position, maximized: false }
      }
      if (placement.maximized) await appWindow.maximize()
    } catch (error) {
      console.error('Failed to restore the window size and position:', error)
    } finally {
      try {
        await appWindow.show()
        await appWindow.setFocus()
      } catch (error) {
        console.error('Failed to show the window:', error)
      }
    }
  },

  // Saves the window geometry into the settings store once at the start, so
  // the store holds the real geometry after the restore, and then after each
  // move and resize; the settings persistence writes it to app_state.json.
  'dez.controller/window/startTracking' (): void {
    if (!isTauri() || stopWindowTracking) return
    const appWindow = getCurrentWindow()
    // A drag sends many events; only the geometry at its end is saved.
    const saveGeometry = debounce(async () => {
      try {
        // A fullscreen size is not one to open with, and the store already
        // holds the geometry from before it. `appWindow.isFullscreen()`
        // misses a fullscreen that the Linux window manager makes; see
        // `is_window_fullscreen` in commands.rs. No e2e spec covers this:
        // only a window manager makes such a fullscreen, and CI has none.
        if (await appWindow.isMinimized() || await sbp('dez.native/isWindowFullscreen')) return
        if (await appWindow.isMaximized()) {
          if (lastNormalGeometry) sbp('dez.model/settings/setWindowGeometry', { ...lastNormalGeometry, maximized: true })
          return
        }
        const [size, physicalPosition, scale] = await Promise.all([
          appWindow.innerSize(),
          appWindow.outerPosition(),
          appWindow.scaleFactor(),
        ])
        // tao gives macOS positions as points times the window's scale
        // factor, so this division gives the points back exactly.
        const position = isMacPlatform ? physicalPosition.toLogical(scale) : physicalPosition
        const width = Math.round(size.width / scale)
        const height = Math.round(size.height / scale)
        // The first read comes at least 500 ms after the restore showed the
        // window, when the window usually has the size that the restore set.
        // A window that opens maximized gets the extent at its unmaximize,
        // which returns it to that size. A smaller read (the window manager
        // made the window smaller) gives no extent.
        decorationExtent ??= {
          width: decorationExtentOf(width, restoredSize?.width),
          height: decorationExtentOf(height, restoredSize?.height),
        }
        lastNormalGeometry = {
          width: width - decorationExtent.width,
          height: height - decorationExtent.height,
          x: Math.round(position.x),
          y: Math.round(position.y),
          maximized: false,
        }
        sbp('dez.model/settings/setWindowGeometry', lastNormalGeometry)
      } catch (error) {
        console.error('Failed to read the window size and position:', error)
      }
    }, 500)
    const listeners = [appWindow.onMoved(() => saveGeometry()), appWindow.onResized(() => saveGeometry())]
      .map((listener) => listener.catch((error: unknown) => {
        console.error('Failed to track the window size and position:', error)
        return null
      }))
    saveGeometry()
    stopWindowTracking = () => {
      // A pending save is dropped, so a move just before quit can be lost.
      saveGeometry.clear()
      for (const listener of listeners) void listener.then((unlisten) => unlisten?.())
    }
  },

  'dez.controller/window/stopTracking' (): void {
    stopWindowTracking?.()
    stopWindowTracking = null
  },
})
