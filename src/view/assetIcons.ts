import type { MediaTagKind } from '../model/chat/mediaTags'
import { ROUND_STROKE, svgIcon, type IconShapes } from './editor/svgIcon'

// The symbol of each kind of asset: in the id badge of an image
// (editor/images.ts) and of a player (media/MediaPlayer.vue), and on the
// chip of a call that hides an asset (editor/toolCalls.ts). A kind has one
// symbol in the whole editor. The shapes fill a 16 by 16 view box and carry
// their own stroke, so that each place draws them the same.

const LINE = { ...ROUND_STROKE, 'stroke-width': '1.3' }

export const ASSET_ICON_SHAPES: Readonly<Record<'image' | MediaTagKind, IconShapes>> = {
  // A picture frame with a sun and hills, so that the id badge reads as the
  // label of the image.
  image: [
    ['rect', { x: '2', y: '3', width: '12', height: '10', rx: '2', ...LINE }],
    ['circle', { cx: '6', cy: '6.5', r: '1.2', fill: 'currentColor' }],
    ['path', { d: 'M2.6 11.6l3.4-3.3 2.4 2.3 1.9-1.8 3.1 3', ...LINE }],
  ],
  // A film camera.
  video: [
    ['rect', { x: '1.8', y: '4', width: '8.6', height: '8', rx: '1.8', ...LINE }],
    ['path', { d: 'M10.4 7.2l3.8-2.2v6l-3.8-2.2', ...LINE }],
  ],
  // Sound bars.
  audio: [['path', { d: 'M3 6.5v3M5.5 4.4v7.2M8 2.8v10.4M10.5 5v6M13 6.7v2.6', ...LINE }]],
}

/** The symbol of an asset kind, as an inline SVG element. */
export function assetIcon(kind: keyof typeof ASSET_ICON_SHAPES): SVGSVGElement {
  return svgIcon('0 0 16 16', ASSET_ICON_SHAPES[kind])
}
