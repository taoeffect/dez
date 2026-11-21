import type { MediaTagKind } from '../model/chat/mediaTags'
import { modelRefKey } from '../model/chat/modelRef'
import type { ModelRef } from '../model/chat/types'
import type { ModelDisplayNames } from '../model/providers/types'
import { ROUND_STROKE, svgIcon, type IconShapes } from './editor/svgIcon'
import { modelLabel, modelTooltipName } from './modelLabel'

// The label of the model that made an image or a clip, in the hover overlay
// of the asset, after its facts (`createImage` in editor/images.ts,
// `MediaPlayer.vue`). The model comes from `assetModel`
// (model/chat/assetModels.ts); the names come from
// `dez.provider/modelDisplayNames`, as for the agent pill (modelChip.ts).
// The label shows the model name, and its tooltip tells the same facts as
// the title of the agent pill.

/** What the model label of an asset shows. */
export interface AssetModelLabel {
  /** `modelRefKey` of the model: the only fact that holds the provider id. */
  key: string
  /** The name that the label shows: the model name, else the model id. */
  name: string
  /** The id with the pretty name (`modelTooltipName`), for the tooltip. */
  tooltipName: string
  /** Null for an unknown or a deleted provider (`modelLabel`). */
  providerName: string | null
}

/** The label of the model `model` with the names `names`; null for an
 *  asset that no known model made. */
export function assetModelLabel(model: ModelRef | null, names: ModelDisplayNames): AssetModelLabel | null {
  if (!model) return null
  const key = modelRefKey(model)
  const { modelName, providerName } = modelLabel(model, names)
  return { key, name: modelName, tooltipName: modelTooltipName(model.modelId, modelName, names.readableNames.get(key)), providerName }
}

/** Whether `a` and `b` show the same label. A widget compares its label
 *  with this, or it keeps a stale label. */
export function sameAssetModelLabel(a: AssetModelLabel | null, b: AssetModelLabel | null): boolean {
  if (!a || !b) return !a && !b
  return a.key === b.key && a.name === b.name && a.tooltipName === b.tooltipName && a.providerName === b.providerName
}

/** The texts of the model label of an asset of kind `kind`: the title and
 *  the lines of its tooltip, and its accessible name. */
export function assetModelTexts(label: AssetModelLabel, kind: 'image' | MediaTagKind): { title: string, lines: string[], ariaLabel: string } {
  const provider = label.providerName ?? 'Unknown provider'
  return {
    title: `Model that made this ${kind}`,
    lines: [label.tooltipName, provider, label.key],
    ariaLabel: `Made by ${label.tooltipName}, provider: ${provider}`,
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
