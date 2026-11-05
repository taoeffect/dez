// Where the main window opens at startup (dez.controller/window/restore). The
// saved geometry can come from another screen setup: a monitor that is gone,
// a lower resolution, another scale factor. The window keeps its saved size
// and place while they fit; else it moves and shrinks, so the whole window,
// frame included, is inside the work area of one monitor.

export interface PhysicalPoint {
  x: number
  y: number
}

export interface Extent {
  width: number
  height: number
}

// The parts of a Tauri `Monitor` that the fit reads. The work area is in
// physical px; it is the monitor without the panels, docks and menu bars.
export interface MonitorArea {
  workArea: { position: PhysicalPoint; size: Extent }
  scaleFactor: number
}

export interface WindowPlacement {
  /** Logical inner size. */
  width: number
  height: number
  /** Physical outer position. As the fit input, null means that no position
   *  was saved; as the fit output, null leaves the position to the OS. */
  position: PhysicalPoint | null
  maximized: boolean
}

export interface WindowFitOptions {
  monitors: MonitorArea[]
  /** The monitor to center on; null means the first monitor. */
  primary: MonitorArea | null
  /** Logical min inner size of the window. */
  minSize: Extent
  /** Logical size of the frame around the inner size (title bar, borders). */
  frame: Extent
}

function overlapLength(start: number, length: number, otherStart: number, otherLength: number): number {
  return Math.max(0, Math.min(start + length, otherStart + otherLength) - Math.max(start, otherStart))
}

// The monitor whose work area holds the largest part of the saved window, or
// null when no monitor holds any part of it. The saved size is logical, so
// each monitor converts it with its own scale factor.
function monitorUnder(request: WindowPlacement, position: PhysicalPoint, { monitors, frame }: WindowFitOptions): MonitorArea | null {
  let best: MonitorArea | null = null
  let bestOverlap = 0
  for (const monitor of monitors) {
    const { position: areaPosition, size: areaSize } = monitor.workArea
    const overlap = overlapLength(position.x, (request.width + frame.width) * monitor.scaleFactor, areaPosition.x, areaSize.width)
      * overlapLength(position.y, (request.height + frame.height) * monitor.scaleFactor, areaPosition.y, areaSize.height)
    if (overlap > bestOverlap) {
      best = monitor
      bestOverlap = overlap
    }
  }
  return best
}

// The saved length, but not more than the work area allows, and not less
// than the min length unless the work area is smaller than that.
function fitLength(saved: number, min: number, max: number): number {
  return Math.max(Math.min(Math.round(saved), max), Math.min(min, max))
}

// A window larger than the work area keeps its top-left corner (and so its
// title bar) inside the area.
function fitStart(start: number, outerLength: number, areaStart: number, areaLength: number): number {
  return Math.max(areaStart, Math.min(Math.round(start), areaStart + areaLength - outerLength))
}

// With no saved position, or with no part of the saved window on any
// monitor, the window is centered on the primary monitor. With no monitors,
// the OS places it.
export function fitWindowGeometry(request: WindowPlacement, options: WindowFitOptions): WindowPlacement {
  const { monitors, primary, minSize, frame } = options
  if (monitors.length === 0) {
    return { width: request.width, height: request.height, position: null, maximized: request.maximized }
  }
  const savedMonitor = request.position ? monitorUnder(request, request.position, options) : null
  const monitor = savedMonitor ?? primary ?? monitors[0]
  const { position: area, size: areaSize } = monitor.workArea
  const scale = monitor.scaleFactor
  const width = fitLength(request.width, minSize.width, Math.floor(areaSize.width / scale - frame.width))
  const height = fitLength(request.height, minSize.height, Math.floor(areaSize.height / scale - frame.height))
  const outerWidth = Math.round((width + frame.width) * scale)
  const outerHeight = Math.round((height + frame.height) * scale)
  const start = savedMonitor && request.position
    ? request.position
    : {
        x: area.x + Math.floor((areaSize.width - outerWidth) / 2),
        y: area.y + Math.floor((areaSize.height - outerHeight) / 2),
      }
  return {
    width,
    height,
    position: {
      x: fitStart(start.x, outerWidth, area.x, areaSize.width),
      y: fitStart(start.y, outerHeight, area.y, areaSize.height),
    },
    maximized: request.maximized,
  }
}
