import type { PickerEdge } from '../../../src/view/model-selector/pickerResize'
import { pointerDrag, type Point } from './dom'
import type { E2EBrowser } from './session'

// The boxes of the bottom bar that take a resize by their handles
// (`src/view/model-selector/pickerResize.ts`): the model picker and the
// settings panel of the gear. Each helper takes the selector of the box.

/** The rect of an element, in viewport px. */
export interface Box {
  left: number
  top: number
  right: number
  bottom: number
  width: number
  height: number
}

export async function boxRect (browser: E2EBrowser, selector: string): Promise<Box> {
  return browser.execute((sel: string) => {
    const element = document.querySelector(sel)
    if (!element) throw new Error(`boxRect: no ${sel}`)
    const { left, top, right, bottom, width, height } = element.getBoundingClientRect()
    return { left, top, right, bottom, width, height }
  }, selector)
}

/** A point on each handle: the middle of the strip on the top edge and of
 *  the one on the right edge, each 3 px out of the border, and the corner
 *  of the border. */
export function handlePoint (box: Box, edge: PickerEdge): Point {
  if (edge === 'top') return { x: box.left + box.width / 2, y: box.top - 3 }
  if (edge === 'right') return { x: box.right + 3, y: box.top + box.height / 2 }
  return { x: box.right, y: box.top }
}

export async function cursorAt (browser: E2EBrowser, point: Point): Promise<string> {
  return browser.execute((x: number, y: number) => {
    const element = document.elementFromPoint(x, y)
    return element ? getComputedStyle(element).cursor : 'no element'
  }, Math.round(point.x), Math.round(point.y))
}

/** Whether the element at `point` is in an element that matches `selector`. */
export async function elementAtIs (browser: E2EBrowser, point: Point, selector: string): Promise<boolean> {
  return browser.execute((x: number, y: number, sel: string) =>
    document.elementFromPoint(x, y)?.closest(sel) != null, Math.round(point.x), Math.round(point.y), selector)
}

export async function viewport (browser: E2EBrowser): Promise<{ width: number, height: number }> {
  return browser.execute(() => ({ width: window.innerWidth, height: window.innerHeight }))
}

/** Drags the handle of `edge` of the box `selector` by (dx, dy), or to the
 *  viewport point `to`. With `release` false the button stays down until
 *  `pointerRelease`. */
export async function dragHandle (
  browser: E2EBrowser,
  selector: string,
  edge: PickerEdge,
  move: { dx: number, dy: number } | { to: Point },
  release = true,
): Promise<void> {
  const from = handlePoint(await boxRect(browser, selector), edge)
  const to = 'to' in move ? move.to : { x: from.x + move.dx, y: from.y + move.dy }
  await pointerDrag(browser, from, Math.round(to.x), { toY: Math.round(to.y), release })
}

/** The classes of `<html>` that a running resize sets. */
export async function resizeClasses (browser: E2EBrowser): Promise<string[]> {
  return browser.execute(() => [...document.documentElement.classList].filter((name) => name.startsWith('picker-resizing')))
}
