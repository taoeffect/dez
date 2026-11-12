import { StateEffect, StateField } from '@codemirror/state'
import type { ModelRef, Role } from '../../model/chat/types'
import { modelRefKey } from '../../model/chat/modelRef'
import type { ModelDisplayNames } from '../../model/providers/types'
import { modelLabel, modelTooltipName } from '../modelLabel'

/** What the model part of an agent role pill shows. */
export interface ModelChip {
  key: string
  modelName: string
  /** The model's readable name, for the tooltip (`modelTooltipName`); null
   *  when unknown. */
  readableName: string | null
  providerName: string | null
  /** Label of the model of the nearest earlier agent section that has a
   *  model, when that model differs from this one; else null. */
  switchedFrom: string | null
  /** The section is the one the active tab's stream writes into. */
  streaming: boolean
}

/** `RoleSeparatorWidget.eq` uses this. It must compare every field that
 *  `addModelToPill` renders, or CodeMirror keeps stale pill DOM. */
export function sameModelChip(a: ModelChip | null, b: ModelChip | null): boolean {
  if (!a || !b) return !a && !b
  return (
    a.key === b.key &&
    a.modelName === b.modelName &&
    a.readableName === b.readableName &&
    a.providerName === b.providerName &&
    a.switchedFrom === b.switchedFrom &&
    a.streaming === b.streaming
  )
}

/** Provider and model names for the agent pills (`dez.provider/modelDisplayNames`).
 *  ThreadEditor seeds it and sends `setModelDisplayNamesEffect` when a name
 *  changes. */
export const setModelDisplayNamesEffect = StateEffect.define<ModelDisplayNames>()

export const modelDisplayNamesField = StateField.define<ModelDisplayNames>({
  create: () => ({ providers: new Map(), models: new Map(), readableNames: new Map() }),
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setModelDisplayNamesEffect)) return e.value
    }
    return value
  },
})

/** Id of the section that the active tab's stream writes into, or null.
 *  ThreadEditor seeds it and sends `setStreamingSectionEffect` when the
 *  stream starts or ends. */
export const setStreamingSectionEffect = StateEffect.define<string | null>()

export const streamingSectionField = StateField.define<string | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setStreamingSectionEffect)) return e.value
    }
    return value
  },
})

/** The model part of each section's pill, by section index; null means the
 *  pill shows no model. Only agent sections with a model get one (the model
 *  is agent-only). The switch cue compares with the nearest earlier agent
 *  section that has a model, so a legacy agent section (no model) between
 *  two responses of one model shows no switch. The section with id
 *  `streamingSectionId` is `streaming`. */
export function sectionModelChips(
  sections: readonly { id: string; role: Role; model?: ModelRef }[],
  names: ModelDisplayNames,
  streamingSectionId: string | null,
): (ModelChip | null)[] {
  let previous: { key: string; label: string } | null = null
  return sections.map((section) => {
    if (section.role !== 'agent' || !section.model) return null
    const key = modelRefKey(section.model)
    const { modelName, providerName } = modelLabel(section.model, names)
    const switchedFrom = previous && previous.key !== key ? previous.label : null
    previous = { key, label: providerName ? `${modelName} (${providerName})` : modelName }
    return {
      key,
      modelName,
      readableName: names.readableNames.get(key) ?? null,
      providerName,
      switchedFrom,
      streaming: section.id === streamingSectionId,
    }
  })
}

const SVG_NS = 'http://www.w3.org/2000/svg'

function switchIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('class', 'dez-role-separator__switch')
  svg.setAttribute('viewBox', '0 0 12 12')
  svg.setAttribute('aria-hidden', 'true')
  const path = document.createElementNS(SVG_NS, 'path')
  path.setAttribute('d', 'M2 4h7.5M7.5 2l2 2-2 2M10 8H2.5M4.5 6l-2 2 2 2')
  path.setAttribute('fill', 'none')
  path.setAttribute('stroke', 'currentColor')
  path.setAttribute('stroke-width', '1.3')
  path.setAttribute('stroke-linecap', 'round')
  path.setAttribute('stroke-linejoin', 'round')
  svg.appendChild(path)
  return svg
}

function span(className: string, text = ''): HTMLSpanElement {
  const el = document.createElement('span')
  el.className = className
  el.textContent = text
  return el
}

/** Shows the model inside the agent role pill, after the role word: the
 *  switch icon, the model name, and the provider name. The pill also gets
 *  the model facts (the name with the readable name) as its tooltip, and
 *  the model part gets them as its accessible name. One pill and one color
 *  for every model: the name, not a color, tells models apart. Styles are in
 *  `dezTheme` (`cmEditor.ts`). The model is widget DOM, not doc text, so
 *  find and copy never see it. */
export function addModelToPill(pill: HTMLElement, chip: ModelChip): void {
  pill.setAttribute('data-model-key', chip.key)
  const provider = chip.providerName ?? 'Unknown provider'
  const switched = chip.switchedFrom ? `Switched from ${chip.switchedFrom}` : null
  const name = modelTooltipName(chip.modelName, chip.readableName)
  pill.title = [name, provider, chip.key, switched].filter(Boolean).join('\n')
  if (chip.streaming) pill.setAttribute('data-streaming', '1')
  const model = span('dez-role-separator__model')
  // A plain span cannot carry an aria-label, so the model part is one
  // labeled graphic for screen readers. "Generating" is the spoken form of
  // the streaming animation. The role is on the model part, not on the
  // pill: an image hides its children, and the pill also holds the role
  // word and the thinking triangle (`thinkingPill.ts`), which screen
  // readers must reach.
  model.setAttribute('role', 'img')
  const generating = chip.streaming ? 'Generating' : null
  model.setAttribute('aria-label', [`Model: ${name}`, `Provider: ${provider}`, chip.key, switched, generating].filter(Boolean).join(', '))
  if (chip.switchedFrom) {
    pill.setAttribute('data-switched', '1')
    model.appendChild(switchIcon())
  }
  model.appendChild(span('dez-role-separator__model-name', chip.modelName))
  if (chip.providerName) model.appendChild(span('dez-role-separator__model-provider', chip.providerName))
  pill.appendChild(model)
}
