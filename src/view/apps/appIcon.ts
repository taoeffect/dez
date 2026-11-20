import { ROUND_STROKE, svgIcon, type IconShapes } from '../editor/svgIcon'

// A window with a title bar.
const APP_ICON_SHAPES: IconShapes = [
  ['rect', { x: '2', y: '3', width: '12', height: '10', rx: '2', ...ROUND_STROKE, 'stroke-width': '1.3' }],
  ['path', { d: 'M2.3 6.3h11.4', ...ROUND_STROKE, 'stroke-width': '1.3' }],
]

/** The symbol of an app, in `currentColor`: on its card, and in the bar of
 *  its frame. */
export function appIcon(): SVGSVGElement {
  return svgIcon('0 0 16 16', APP_ICON_SHAPES)
}
