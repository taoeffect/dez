import sbp from '@sbp/sbp'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import type { SettingsSnapshot } from '../model/state'
import type { WindowGeometry } from '../model/state/settings'
import type { NativeMonitors } from './nativeTypes'
// Side-effect imports: register the dez.model/* selectors and the selectors
// under test.
import '../model/state/index'
import './window'

// The Dez window on one 1920x1080 screen at scale 1, with no frame, as the
// Tauri window API reports it. Under GTK's Wayland backend the window reads
// its place as (0,0), and `setPosition` does nothing.
const desktop = vi.hoisted(() => ({
  wayland: false,
  window: { width: 900, height: 600, x: 0, y: 0, maximized: false },
  listeners: [] as (() => void)[],
}))

vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true }))
vi.mock('../utils/platform', () => ({ isMacPlatform: false }))
vi.mock('@tauri-apps/api/window', () => {
  class LogicalSize {
    constructor (readonly width: number, readonly height: number) {}
  }
  class PhysicalPosition {
    constructor (readonly x: number, readonly y: number) {}
  }
  const listen = async (listener: () => void) => {
    desktop.listeners.push(listener)
    return () => {}
  }
  const appWindow = {
    scaleFactor: async () => 1,
    innerSize: async () => ({ width: desktop.window.width, height: desktop.window.height }),
    outerSize: async () => ({ width: desktop.window.width, height: desktop.window.height }),
    outerPosition: async () => desktop.wayland ? { x: 0, y: 0 } : { x: desktop.window.x, y: desktop.window.y },
    setSize: async ({ width, height }: LogicalSize) => {
      Object.assign(desktop.window, { width, height })
    },
    setPosition: async ({ x, y }: PhysicalPosition) => {
      if (!desktop.wayland) Object.assign(desktop.window, { x, y })
    },
    maximize: async () => {
      desktop.window.maximized = true
    },
    isMaximized: async () => desktop.window.maximized,
    isMinimized: async () => false,
    show: async () => {},
    setFocus: async () => {},
    onMoved: listen,
    onResized: listen,
  }
  return {
    LogicalSize,
    LogicalPosition: PhysicalPosition,
    PhysicalPosition,
    getCurrentWindow: () => appWindow,
  }
})

let gdkBackend: () => Promise<string | null>
let consoleError: MockInstance<typeof console.error>

const area = { position: { x: 0, y: 0 }, size: { width: 1920, height: 1080 } }
const monitor = { ...area, workArea: area, scaleFactor: 1 }

sbp('sbp/selectors/register', {
  'dez.native/gdkBackend' (): Promise<string | null> {
    return gdkBackend()
  },
  async 'dez.native/isWindowFullscreen' (): Promise<boolean> {
    return false
  },
  async 'dez.native/monitors' (): Promise<NativeMonitors> {
    return { monitors: [monitor], primary: monitor }
  },
})

// The top-left of a 900x600 window centered on the screen.
const CENTERED = { x: 510, y: 240 }

function useBackend (backend: 'x11' | 'wayland'): void {
  desktop.wayland = backend === 'wayland'
  gdkBackend = async () => backend
}

function savedGeometry (): WindowGeometry | null {
  return (sbp('dez.model/settings/snapshot') as SettingsSnapshot).windowGeometry
}

// A launch as dez.controller/app/init runs it, with a new hidden window at
// the default size, up to the tracker's first save. The settings store is
// app_state.json: it keeps what the last launch saved.
async function launch (): Promise<void> {
  sbp('dez.controller/window/stopTracking')
  desktop.window = { width: 900, height: 600, x: 0, y: 0, maximized: false }
  desktop.listeners = []
  await sbp('dez.controller/window/restore')
  sbp('dez.controller/window/startTracking')
  await vi.advanceTimersByTimeAsync(500)
}

// A move, resize, or unmaximize by the user or the window manager, up to the
// tracker's save after it.
async function changeWindow (change: Partial<typeof desktop.window>): Promise<void> {
  Object.assign(desktop.window, change)
  for (const listener of desktop.listeners) listener()
  await vi.advanceTimersByTimeAsync(500)
}

describe('window place on Linux', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    setActivePinia(createPinia())
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    sbp('dez.controller/window/stopTracking')
    vi.useRealTimers()
    expect(consoleError).not.toHaveBeenCalled()
    consoleError.mockRestore()
  })

  it('opens an X11 window at its saved place, and saves a move', async () => {
    useBackend('x11')
    sbp('dez.model/settings/setWindowGeometry', { width: 900, height: 600, x: 300, y: 200, maximized: false })
    await launch()
    expect(desktop.window).toMatchObject({ x: 300, y: 200 })
    await changeWindow({ x: 437, y: 291 })
    expect(savedGeometry()).toEqual({ width: 900, height: 600, x: 437, y: 291, maximized: false })
  })

  it('keeps the saved place under Wayland, where the window reads (0,0)', async () => {
    useBackend('wayland')
    sbp('dez.model/settings/setWindowGeometry', { width: 900, height: 600, x: 300, y: 200, maximized: false })
    await launch()
    expect(savedGeometry()).toEqual({ width: 900, height: 600, x: 300, y: 200, maximized: false })
    await changeWindow({ width: 1000, height: 700 })
    expect(savedGeometry()).toEqual({ width: 1000, height: 700, x: 300, y: 200, maximized: false })
  })

  // The restore fits the off-screen place to this screen, but under Wayland
  // that fitted place is not where the window is either.
  it('keeps a saved place off this screen when a Wayland window opens maximized', async () => {
    useBackend('wayland')
    const offScreen = { width: 900, height: 600, x: -9000, y: 9000 }
    sbp('dez.model/settings/setWindowGeometry', { ...offScreen, maximized: true })
    await launch()
    expect(desktop.window.maximized).toBe(true)
    expect(savedGeometry()).toEqual({ ...offScreen, maximized: true })
    await changeWindow({ maximized: false })
    expect(savedGeometry()).toEqual({ ...offScreen, maximized: false })
  })

  it('saves no place under Wayland when none was saved, so that X11 centers the window', async () => {
    useBackend('wayland')
    await launch()
    expect(savedGeometry()).toStrictEqual({ width: 900, height: 600, maximized: false })
    useBackend('x11')
    await launch()
    expect(desktop.window).toMatchObject(CENTERED)
    expect(savedGeometry()).toEqual({ width: 900, height: 600, ...CENTERED, maximized: false })
  })

  it('keeps the saved place when the GDK backend read fails', async () => {
    useBackend('x11')
    gdkBackend = async () => { throw new Error('IPC failed') }
    sbp('dez.model/settings/setWindowGeometry', { width: 900, height: 600, x: 300, y: 200, maximized: false })
    await launch()
    await changeWindow({ x: 437, y: 291 })
    expect(savedGeometry()).toEqual({ width: 900, height: 600, x: 300, y: 200, maximized: false })
    expect(consoleError).toHaveBeenCalledWith('Failed to read the GDK backend:', expect.any(Error))
    consoleError.mockClear()
  })
})
