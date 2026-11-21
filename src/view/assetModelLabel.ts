import type { MediaTagKind } from '../model/chat/mediaTags'
import type { ModelRef } from '../model/chat/types'
import type { ModelDisplayNames } from '../model/providers/types'
import { ROUND_STROKE, svgIcon, type IconShapes } from './editor/svgIcon'
import { UNKNOWN_PROVIDER, modelFactLines, modelFacts, type ModelFacts } from './modelLabel'

// The label of the model that made an image or a clip, in the hover overlay
// of the asset, after its facts (`createImage` in editor/images.ts,
// `MediaPlayer.vue`). The model comes from `assetModel`
// (model/chat/assetModels.ts); the names come from
// `dez.provider/modelDisplayNames`. The label shows the model name, and its
// tooltip tells the model facts (`modelFacts`), as the agent pill does.

/** The facts of the model `model` with the names `names`; null for an
 *  asset that no known model made. */
export function assetModelLabel(model: ModelRef | null, names: ModelDisplayNames): ModelFacts | null {
  return model && modelFacts(model, names)
}

/** The texts of the model label of an asset of kind `kind`: the title and
 *  the lines of its tooltip, and its accessible name. */
export function assetModelTexts(label: ModelFacts, kind: 'image' | MediaTagKind): { title: string, lines: string[], ariaLabel: string } {
  return {
    title: `Model that made this ${kind}`,
    lines: modelFactLines(label),
    ariaLabel: `Made by ${label.tooltipName}, Provider: ${label.providerName ?? UNKNOWN_PROVIDER}`,
  }
}

/** The symbol of the model label: a sparkle, in the 16 by 16 view box and
 *  the line of the asset symbols (assetIcons.ts). */
export const MODEL_ICON_SHAPES: IconShapes = [
  ['path', { d: 'M8 2.2l1.3 3.4a1.6 1.6 0 0 0 1.1 1.1L13.8 8l-3.4 1.3a1.6 1.6 0 0 0-1.1 1.1L8 13.8l-1.3-3.4a1.6 1.6 0 0 0-1.1-1.1L2.2 8l3.4-1.3a1.6 1.6 0 0 0 1.1-1.1z', ...ROUND_STROKE, 'stroke-width': '1.3' }],
]

/** The symbol of the model label, as an inline SVG element. */
export function modelIcon(): SVGSVGElement {
  return svgIcon('0 0 16 16', MODEL_ICON_SHAPES)
}
