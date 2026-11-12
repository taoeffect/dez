import type { ProviderConfig, ProviderSettingDef } from './config'
import { THINKING_DEFAULT, THINKING_SETTING_KEY } from './thinking'
import { TOOLS_DEFAULT, TOOLS_SETTING_KEY } from './toolsSetting'
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

// One toggle that applies to a model, as the provider settings popup shows
// it and `model_info` tells it.
export interface ToggleRow {
  key: string
  label: string
  default: boolean
}

// Dez's own toggles (thinking.ts, toolsSetting.ts) as rows.
const THINKING_ROW: Readonly<ToggleRow> = { key: THINKING_SETTING_KEY, label: 'Thinking', default: THINKING_DEFAULT }
const TOOLS_ROW: Readonly<ToggleRow> = { key: TOOLS_SETTING_KEY, label: 'Tools', default: TOOLS_DEFAULT }

/** The toggles of `toggles` as rows: Dez's own toggles first (Thinking,
 *  then Tools), then the config's toggles. Dez's own toggles are stored
 *  with the config's toggles, so the rows share one code path, and "Reset
 *  to defaults" resets them too. */
export function toggleRows(toggles: ModelToggles): ToggleRow[] {
  return [
    ...(toggles.thinking ? [{ ...THINKING_ROW }] : []),
    ...(toggles.tools ? [{ ...TOOLS_ROW }] : []),
    ...toggles.settings.map(({ key, label, default: defaultValue }) => ({ key, label, default: defaultValue })),
  ]
}

/** The value of the toggle `row`: the user's value in `stored`
 *  (settings.providerSettings[providerId]), else the row's default. The
 *  stored toggles are sparse: only a flipped toggle has a value. */
export function toggleValue(row: Pick<ToggleRow, 'key' | 'default'>, stored: Readonly<Record<string, boolean>> | undefined): boolean {
  const value = stored?.[row.key]
  return typeof value === 'boolean' ? value : row.default
}

/** The value of the Thinking toggle in `stored`. It matters only where
 *  the toggle applies (`modelToggles`). */
export function isThinkingEnabled(stored: Readonly<Record<string, boolean>> | undefined): boolean {
  return toggleValue(THINKING_ROW, stored)
}

/** The value of the Tools toggle in `stored`. It matters only where the
 *  toggle applies (`toolsApply`). */
export function isToolsEnabled(stored: Readonly<Record<string, boolean>> | undefined): boolean {
  return toggleValue(TOOLS_ROW, stored)
}
