import * as z from 'zod'
import { escapeMarkerAttribute, unescapeMarkerAttribute } from '../../utils/markerAttribute'
import { modelRefKey, parseModelRefKey } from './modelRef'
import type { ModelRef, Role, Section, SectionThinking, ThinkingReplay } from './types'

// The `<dez:pill …/>` marker starts a section in conversation files and in
// clipboard text. An agent section with thinking gets a container instead,
// with the thinking text as its body:
//
//   <dez:pill type="agent" model="provider/model" duration-ms="4213" replay="{…}">
//   thinking text
//   </dez:pill>
//
// `duration-ms` is the reply duration (`Section.durationMs`). Both formats
// write and read the markers only here, so they cannot drift apart.

export interface PillMarker {
  role: Role
  model: ModelRef | null
  /** The `duration-ms` attribute of an agent marker. Null when it is
   *  missing or is not a whole number of milliseconds. */
  durationMs: number | null
  /** The text is the opening tag of a container: thinking text lines
   *  follow, up to a `PILL_CLOSE_TAG` line. */
  container: boolean
  /** The `replay` attribute of an agent container. Null when it is missing
   *  or is not a known shape: the thinking then never goes back to the
   *  provider, which is not an error. */
  replay: ThinkingReplay | null
}

export const PILL_CLOSE_TAG = '</dez:pill>'

const anthropicThinkingBlockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('thinking'), thinking: z.string(), signature: z.string() }),
  z.object({ type: z.literal('redacted_thinking'), data: z.string() }),
])

const thinkingReplaySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('field'), field: z.enum(['reasoning_content', 'reasoning']) }),
  z.object({ kind: z.literal('anthropicBlocks'), blocks: z.array(anthropicThinkingBlockSchema), prefixHash: z.string() }),
  z.object({ kind: z.literal('reasoningDetails'), details: z.array(z.record(z.string(), z.json())), prefixHash: z.string() }),
  z.object({ kind: z.literal('copilot'), opaque: z.string(), prefixHash: z.string() }),
])

function parseThinkingReplay(json: string): ThinkingReplay | null {
  let value: unknown
  try {
    value = JSON.parse(json)
  } catch {
    return null
  }
  const parsed = thinkingReplaySchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

// `pillMarkerText` writes whole, non-negative milliseconds. Any other value
// (a hand edit) reads as "unknown", as a bad `model` does.
function parseDurationMs(value: string | undefined): number | null {
  if (value === undefined || !/^\d+$/.test(value)) return null
  const durationMs = Number(value)
  return Number.isSafeInteger(durationMs) ? durationMs : null
}

// A marker in the thinking text would end the container early, so the text
// holds none: `</dez:pill>` is written as `<\/dez:pill>`, and `<dez:pill` as
// `<\dez:pill`. Each `<`, `\`…, optional `/`, `dez:pill` run gets one more
// `\` on write and loses one on read, so text that already holds
// `<\/dez:pill>` also reads back unchanged. A marker inside an open
// container then proves that a hand edit lost its closing line. The `field`
// replay sends the text back to the provider, so it must round-trip exactly;
// the prompt escaping in conversationFormat.ts cannot do that.
function escapeThinkingText(text: string): string {
  return text.replace(/<(\\*)(\/?)dez:pill/g, '<\\$1$2dez:pill')
}

function unescapeThinkingText(body: string): string {
  return body.replace(/<\\(\\*)(\/?)dez:pill/g, '<$1$2dez:pill')
}

/** The marker text of a section: one self-closing tag, or a container when
 *  an agent section has thinking. The container body is the exact thinking
 *  text, not trimmed or indented. Only agent pills carry `model`, the
 *  duration, and thinking, so a section saved or copied as `user` loses
 *  them. */
export function pillMarkerText(section: Pick<Section, 'role' | 'model' | 'thinking' | 'durationMs'>): string {
  if (section.role !== 'agent') return '<dez:pill type="user"/>'
  let tag = '<dez:pill type="agent"'
  if (section.model) tag += ` model="${escapeMarkerAttribute(modelRefKey(section.model))}"`
  if (section.durationMs !== undefined) tag += ` duration-ms="${section.durationMs}"`
  const { thinking } = section
  if (!thinking) return `${tag}/>`
  if (thinking.replay) tag += ` replay="${escapeMarkerAttribute(JSON.stringify(thinking.replay))}"`
  return `${tag}>\n${escapeThinkingText(thinking.text)}\n${PILL_CLOSE_TAG}`
}

// One `name="value"` attribute. Escaped values never hold `"`
// (`escapeMarkerAttribute`), so a value ends at the next `"`, even when it
// holds `/>` or `>`. `ATTRIBUTES` uses the same rule without capture groups.
const ATTRIBUTE = /([A-Za-z_][\w.:-]*)\s*=\s*"([^"]*)"/g
const ATTRIBUTES = String.raw`(?:\s+[A-Za-z_][\w.:-]*\s*=\s*"[^"]*")*\s*`

/** One whole marker inside other text, such as clipboard text: a
 *  self-closing tag, a container with its body, or an opening tag with no
 *  closing tag before the next marker, which reads as a self-closing tag,
 *  as in conversation files. A container body is the lines between the
 *  opening tag and the closing tag line, as in conversation files.
 *  `escapeThinkingText` leaves no `<dez:pill` or `</dez:pill` in a body, so
 *  the body stops at the first one: a lone opening tag never runs on to the
 *  closing tag of a later container. The lazy `??` tries "no body lines"
 *  first, for `<dez:pill …>\n</dez:pill>`. It has no capture groups, so
 *  callers can join its `source` into a larger pattern. */
export const PILL_MARKER = new RegExp(String.raw`<dez:pill${ATTRIBUTES}(?:\/>|>\n(?:(?:(?!<\/?dez:pill)[\s\S])*?\n)??<\/dez:pill>|>)`)

const OPENING_TAG = new RegExp(String.raw`^<dez:pill${ATTRIBUTES}>$`)

// The opening tag and the newline after it, at the start of a container.
// An attribute value can hold `>` and the tag can span lines, so the tag end
// is found with the attribute rule, not at the first `>` or `\n`.
const CONTAINER_START = new RegExp(String.raw`^<dez:pill${ATTRIBUTES}>\n`)

/** Role, model, duration, and container state of a text that starts with
 *  `<dez:pill`. Null when `type` is not `user` or `agent`: the text is then
 *  not a marker. Attribute order and spacing do not matter. A `model` or
 *  `duration-ms` on a user pill is ignored, and a bad `model`,
 *  `duration-ms`, or `replay` value means "none", not an error, so files
 *  edited by hand still open. Pass only the tag: the attributes are read
 *  from the whole text. */
export function parsePillMarker(text: string): PillMarker | null {
  if (!text.startsWith('<dez:pill')) return null
  const attributes = new Map<string, string>()
  for (const [, name, value] of text.slice('<dez:pill'.length).matchAll(ATTRIBUTE)) {
    if (!attributes.has(name)) attributes.set(name, value)
  }
  const role = attributes.get('type')
  const container = OPENING_TAG.test(text)
  if (role === 'user') return { role, model: null, durationMs: null, container, replay: null }
  if (role !== 'agent') return null
  const model = attributes.get('model')
  const replay = attributes.get('replay')
  return {
    role,
    model: model === undefined ? null : parseModelRefKey(unescapeMarkerAttribute(model)),
    durationMs: parseDurationMs(attributes.get('duration-ms')),
    container,
    replay: container && replay !== undefined ? parseThinkingReplay(unescapeMarkerAttribute(replay)) : null,
  }
}

/** The thinking of a container. `body` is the text between the opening tag
 *  line and the closing tag line, without the newlines next to the tags. A
 *  user pill has no thinking, so the body of a hand-edited user container is
 *  dropped. */
export function containerThinking(marker: PillMarker, body: string): SectionThinking | undefined {
  if (marker.role !== 'agent') return undefined
  const text = unescapeThinkingText(body)
  return marker.replay ? { text, replay: marker.replay } : { text }
}

/** The marker and thinking of one whole `PILL_MARKER` match. Null when
 *  `type` is not `user` or `agent`. Only a container with an agent role has
 *  thinking; a lone opening tag has none. */
export function parsePillMarkerMatch(text: string): { marker: PillMarker; thinking?: SectionThinking } | null {
  const start = CONTAINER_START.exec(text)
  const marker = parsePillMarker(start ? start[0].slice(0, -1) : text)
  if (!marker) return null
  if (!start) return { marker }
  // The text between the opening tag line and the closing tag ends with the
  // newline before the closing tag, unless the container has no body lines.
  let body = text.slice(start[0].length, text.length - PILL_CLOSE_TAG.length)
  if (body.endsWith('\n')) body = body.slice(0, -1)
  const thinking = containerThinking(marker, body)
  return thinking ? { marker, thinking } : { marker }
}
