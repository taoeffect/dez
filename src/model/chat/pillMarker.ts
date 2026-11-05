import { escapeMarkerAttribute, unescapeMarkerAttribute } from '../../utils/markerAttribute'
import { modelRefKey, parseModelRefKey } from './modelRef'
import type { ModelRef, Role } from './types'

// The `<dez:pill …/>` marker starts a section in conversation files and in
// clipboard text. Both formats write and read it only here, so they cannot
// drift apart.

export interface PillMarker {
  role: Role
  model: ModelRef | null
}

/** The marker text of a section. Only agent pills carry `model`, so a
 *  section saved or copied as `user` loses it. */
export function pillMarkerLine(role: Role, model?: ModelRef): string {
  if (role !== 'agent') return '<dez:pill type="user"/>'
  if (!model) return '<dez:pill type="agent"/>'
  return `<dez:pill type="agent" model="${escapeMarkerAttribute(modelRefKey(model))}"/>`
}

// One `name="value"` attribute. Escaped values never hold `"`
// (`escapeMarkerAttribute`), so a value ends at the next `"`, even when it
// holds `/>`. `PILL_MARKER` uses the same rule without capture groups.
const ATTRIBUTE = /([A-Za-z_][\w.:-]*)\s*=\s*"([^"]*)"/g

/** One whole marker inside other text, such as clipboard text. It has no
 *  capture groups, so callers can join its `source` into a larger pattern. */
export const PILL_MARKER = /<dez:pill(?:\s+[A-Za-z_][\w.:-]*\s*=\s*"[^"]*")*\s*\/>/

/** Role and model of a text that starts with `<dez:pill`. Null when `type`
 *  is not `user` or `agent`: the text is then not a marker. Attribute order
 *  and spacing do not matter. A `model` on a user pill is ignored, and a bad
 *  `model` value means "no model", not an error, so files edited by hand
 *  still open. */
export function parsePillMarker(text: string): PillMarker | null {
  if (!text.startsWith('<dez:pill')) return null
  const attributes = new Map<string, string>()
  for (const [, name, value] of text.slice('<dez:pill'.length).matchAll(ATTRIBUTE)) {
    if (!attributes.has(name)) attributes.set(name, value)
  }
  const role = attributes.get('type')
  if (role === 'user') return { role, model: null }
  if (role !== 'agent') return null
  const model = attributes.get('model')
  return { role, model: model === undefined ? null : parseModelRefKey(unescapeMarkerAttribute(model)) }
}
