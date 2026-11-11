import type { ProviderConfig, ProviderSettingDef } from './config'
import { effectiveRequest, type ModelInfo } from './types'

// The model of a toggle question: its id, and what the model cache knows of
// it. A model that the cache does not have (yet) is only its id, and every
// fact of it is unknown.
export type ToggleModel = Pick<ModelInfo, 'id' | 'request' | 'toolCalling' | 'thinking' | 'unsupportedSettings'>

// Which of a provider's toggles apply to one model.
export interface ModelToggles {
  // The Thinking toggle (thinking.ts).
  thinking: boolean
  // The Tools toggle (toolsSetting.ts).
  tools: boolean
  // The config's toggles (`settings`), in config order.
  settings: ProviderSettingDef[]
}

/** Whether the Tools toggle applies to the model: it takes chat requests,
 *  and it is not known as a model that cannot call tools. */
export function toolsApply(model: Pick<ModelInfo, 'request' | 'toolCalling'>): boolean {
  return effectiveRequest(model) === 'chat' && model.toolCalling !== false
}

/** The one rule of which provider toggles apply to a model. The provider
 *  settings popup shows exactly these, and a chat request offers the Dez
 *  tools (`toolsApply`) and writes the thinking and settings fields only for
 *  these, so the popup never shows a toggle that the request ignores.
 *
 *  A toggle applies unless Dez knows that the model cannot use it:
 *  - No toggle applies to a model that takes no chat request (a media
 *    request sends none of these fields).
 *  - Thinking needs a provider with `thinking`, and a model that is not
 *    known not to think.
 *  - A config toggle needs a model id with its `modelIdPrefix`, and a model
 *    that is not known not to take it.
 *
 *  An unknown fact counts as "can use it". A toggle that does not apply
 *  keeps its stored value, as the values are per provider, not per model. */
export function modelToggles(config: Pick<ProviderConfig, 'thinking' | 'settings'>, model: ToggleModel): ModelToggles {
  if (effectiveRequest(model) !== 'chat') return { thinking: false, tools: false, settings: [] }

  return {
    thinking: config.thinking !== undefined && model.thinking !== false,
    tools: toolsApply(model),
    settings: (config.settings ?? []).filter((setting) =>
      (setting.modelIdPrefix === undefined || model.id.startsWith(setting.modelIdPrefix)) &&
      !model.unsupportedSettings?.includes(setting.key)),
  }
}
