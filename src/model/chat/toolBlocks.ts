import { MARKER_ATTRIBUTES, escapeMarkerAttribute, markerAttributes } from '../../utils/markerAttribute'
import { fitsParameterType, toolDefinition } from '../tools/registry'
import type { ToolArguments, ToolArgumentValue, ToolParameterType } from '../tools/types'
import { stripLiveSentinels } from './content'

// A Dez tool call is plain text in an agent section, as an image reference
// is: no content node kind and no sentinel. Conversation files and clipboard
// text hold it as it is. This module is the one place that writes and
// recognizes it; requests, the editor, and the search, preview, and Markdown
// text all call it.
//
//   <dez:tool id="call_7Qx" name="model_list" filter="gemini">
//   3 models match "gemini" (full id | name | provider):
//   venice/gemini-3-pro-preview | Gemini 3 Pro Preview | Venice
//   </dez:tool>
//
// - The opening tag is one whole line, and so is the closing tag: a block
//   starts at the text start or after `\n`, and ends at the text end or
//   before `\n`. An opening tag with no closing line is plain text, and so
//   is a tag with no `id` or no `name`.
// - Attributes, in this order: `id` (the provider's call id, sent back byte
//   for byte), `name` (the tool name as the model gave it), `status` (absent
//   for success), then one per argument, in definition order. A string
//   argument is written as it is, a number or boolean as its JSON text; on
//   read, the tool's definition gives the type back. Values are escaped
//   (`escapeMarkerAttribute`), so the tag stays on one line.
// - The body is the result, escaped (`escapeResult`) so that no body line
//   can end the block or read as a pill or prompt line in a conversation
//   file.
// - Blocks count in agent sections only; in a user section the same text is
//   plain text. Callers check the role.
// - Answer text from a model is escaped too (`ModelTextEscaper`), so a model
//   cannot write a block.

/** `running`: the tool runs now, or ran when the app stopped. `error`: the
 *  result is an error message. */
export type ToolBlockStatus = 'success' | 'error' | 'running'

/** One tool call and its result, as a block holds them. */
export interface ToolBlockData {
  id: string
  name: string
  status: ToolBlockStatus
  /** The arguments by parameter name; the writer puts them in definition
   *  order, and so does the reader. Keys must be parameter names of a Dez
   *  tool: the registry test checks that they fit the attribute grammar and
   *  are not in `RESERVED_TOOL_ATTRIBUTES`. */
  arguments: ToolArguments
  result: string
}

/** One block in a text. */
export interface ToolBlock extends ToolBlockData {
  /** Offset of the `<` of the opening tag. */
  from: number
  /** Offset after the `>` of the closing tag. */
  to: number
}

/** A run of a text: plain text, or one tool block. */
export type ToolTextPiece =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; block: ToolBlock }

/** The attributes that every block writes before the arguments. No tool
 *  parameter may use these names. */
export const RESERVED_TOOL_ATTRIBUTES: readonly string[] = ['id', 'name', 'status']

const OPEN_PREFIX = '<dez:tool'
const CLOSE_TAG = '</dez:tool>'
// Tested on one line only, so the `\s` of the attribute rule cannot cross a
// line break.
const OPENING_LINE = new RegExp(String.raw`^<dez:tool${MARKER_ATTRIBUTES}>$`)
// The start of any `dez:` tag, which no escaped body holds. Global for its
// `lastIndex`, which each use sets first.
const ANY_TAG = /<\/?dez:/g

// Each `<`, `\`…, optional `/`, `dez:` run gets one more `\` after the `<`
// on write and loses one on read (the rule of `escapeThinkingText` in
// pillMarker.ts, for every `dez:` tag), so any result reads back exactly,
// also one that already holds the escaped form. A body then holds no
// `</dez:tool>` closing line, and no `<dez:pill` or `<dez:prompt` line that
// would start a section or a prompt in a conversation file or clipboard
// text.
function escapeResult(text: string): string {
  return text.replace(/<(\\*)(\/?)dez:/g, '<\\$1$2dez:')
}

function unescapeResult(body: string): string {
  return body.replace(/<\\(\\*)(\/?)dez:/g, '<$1$2dez:')
}

// Live sentinels in doc text break the editor's section and pill scan, and
// tool values come from a model or a tool, so the writer removes them.
function attributeValue(value: string): string {
  return escapeMarkerAttribute(stripLiveSentinels(value))
}

// The parameters of the tool's definition first, in definition order, then
// any other keys in their own order (a stable sort). Requests send the
// arguments in this order, so the bytes do not change when a hand edit
// moves an attribute.
function inDefinitionOrder<T>(name: string, entries: [string, T][]): [string, T][] {
  const parameters = toolDefinition(name)?.parameters ?? []
  const rank = (key: string): number => {
    const index = parameters.findIndex((parameter) => parameter.name === key)
    return index < 0 ? parameters.length : index
  }
  return entries.sort((a, b) => rank(a[0]) - rank(b[0]))
}

/** The text of a block, with live sentinels removed from every value. A
 *  running block has an empty result. */
export function toolBlockText(block: ToolBlockData): string {
  let tag = `${OPEN_PREFIX} id="${attributeValue(block.id)}" name="${attributeValue(block.name)}"`
  if (block.status !== 'success') tag += ` status="${block.status}"`
  for (const [name, value] of inDefinitionOrder(block.name, Object.entries(block.arguments))) {
    tag += ` ${name}="${attributeValue(typeof value === 'string' ? value : JSON.stringify(value))}"`
  }
  const result = escapeResult(stripLiveSentinels(block.result))
  return `${tag}>\n${result === '' ? '' : `${result}\n`}${CLOSE_TAG}`
}

// Any value other than `running` is an error: a block that Dez did not
// write as a success must not read as one.
function readStatus(value: string | undefined): ToolBlockStatus {
  if (value === undefined) return 'success'
  return value === 'running' ? 'running' : 'error'
}

// The writer gives a number or boolean as its JSON text. A value that does
// not read as its parameter's type (a hand edit) stays the text as written.
function readArgument(type: ToolParameterType, text: string): ToolArgumentValue {
  if (type === 'string') return text
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return text
  }
  return fitsParameterType(type, value) ? value : text
}

// The arguments in definition order. A parameter of the tool's definition
// gets its type back; any other attribute, and every attribute of a tool
// that Dez does not know, reads as a string. `Object.fromEntries` defines
// own keys, so a key such as `__proto__` stays an argument.
function readArguments(name: string, attributes: Map<string, string>): ToolArguments {
  const parameters = toolDefinition(name)?.parameters ?? []
  const entries: [string, ToolArgumentValue][] = []
  for (const [key, text] of attributes) {
    if (RESERVED_TOOL_ATTRIBUTES.includes(key)) continue
    const type = parameters.find((parameter) => parameter.name === key)?.type
    entries.push([key, type ? readArgument(type, text) : text])
  }
  return Object.fromEntries(inDefinitionOrder(name, entries))
}

// The block whose opening tag starts at `from`, a line start; null when the
// text there is not a block.
function readBlock(text: string, from: number): ToolBlock | null {
  const tagEnd = text.indexOf('\n', from)
  if (tagEnd < 0) return null
  const tag = text.slice(from, tagEnd)
  if (!OPENING_LINE.test(tag)) return null
  // The body holds no `dez:` tag, so the first one after the opening line
  // must be the closing line. Any other tag first (a hand edit) leaves the
  // opening tag as plain text, as a pill container does.
  ANY_TAG.lastIndex = tagEnd + 1
  const close = ANY_TAG.exec(text)?.index
  if (close === undefined || text[close - 1] !== '\n' || !text.startsWith(CLOSE_TAG, close)) return null
  const to = close + CLOSE_TAG.length
  if (to < text.length && text[to] !== '\n') return null
  const attributes = markerAttributes(tag.slice(OPEN_PREFIX.length, -1))
  const id = attributes.get('id')
  const name = attributes.get('name')
  if (id === undefined || name === undefined) return null
  // The body is empty, or its lines end with the `\n` before the closing
  // line.
  const body = text.slice(tagEnd + 1, close)
  return {
    from,
    to,
    id,
    name,
    status: readStatus(attributes.get('status')),
    arguments: readArguments(name, attributes),
    result: unescapeResult(body.slice(0, -1)),
  }
}

/** The tool blocks in a text, in order. */
export function findToolBlocks(text: string): ToolBlock[] {
  const blocks: ToolBlock[] = []
  for (let from = text.indexOf(OPEN_PREFIX); from >= 0;) {
    const block = from === 0 || text[from - 1] === '\n' ? readBlock(text, from) : null
    if (block) blocks.push(block)
    from = text.indexOf(OPEN_PREFIX, block ? block.to : from + 1)
  }
  return blocks
}

/** A text as its plain-text and tool block pieces, in order. Empty text
 *  pieces are left out; whitespace is kept. */
export function splitToolBlocks(text: string): ToolTextPiece[] {
  const pieces: ToolTextPiece[] = []
  let start = 0
  for (const block of findToolBlocks(text)) {
    if (block.from > start) pieces.push({ kind: 'text', text: text.slice(start, block.from) })
    pieces.push({ kind: 'tool', block })
    start = block.to
  }
  if (start < text.length) pieces.push({ kind: 'text', text: text.slice(start) })
  return pieces
}

/** A text with each tool block replaced by `label`. */
export function labelToolBlocks(text: string, label: string): string {
  return splitToolBlocks(text).map((piece) => (piece.kind === 'text' ? piece.text : label)).join('')
}

/** A text for people to read (Copy Markdown, Save As Markdown), with its
 *  tool blocks left out, as the agent thinking is. The text pieces around
 *  the blocks are joined by one blank line: the blank lines next to a block
 *  and the blank pieces go. A text with no block comes back as it is. */
export function withoutToolBlocks(text: string): string {
  const pieces = splitToolBlocks(text)
  if (!pieces.some((piece) => piece.kind === 'tool')) return text
  const kept: string[] = []
  pieces.forEach((piece, index) => {
    if (piece.kind === 'tool') return
    let part = piece.text
    if (pieces[index - 1]?.kind === 'tool') part = part.replace(/^(?:[^\S\n]*\n)+/, '')
    if (pieces[index + 1]?.kind === 'tool') part = part.trimEnd()
    if (part.trim() !== '') kept.push(part)
  })
  return kept.join('\n\n')
}

// Model answer text gets one more `\` after the `<` of each `<`, `\`…,
// optional `/`, `dez:tool` run, so no answer can hold a block's opening or
// closing tag. Requests remove the escape (`unescapeModelText`), so the
// provider gets the model's own bytes. The escape covers `dez:tool` only:
// prose about other tags keeps its bytes.
const MODEL_TEXT_TAG = 'dez:tool'

function escapeModelText(text: string): string {
  return text.replace(/<(\\*)(\/?)dez:tool/g, '<\\$1$2dez:tool')
}

/** Answer text as the model wrote it: the text of an agent section outside
 *  its tool blocks, with the `ModelTextEscaper` escape removed. */
export function unescapeModelText(text: string): string {
  return text.replace(/<\\(\\*)(\/?)dez:tool/g, '<$1$2dez:tool')
}

// True when `text`, which starts with `<`, can still grow into an escaped
// run: `<`, `\`…, an optional `/`, and a proper start of `dez:tool`.
function couldGrowIntoTag(text: string): boolean {
  let index = 1
  while (text[index] === '\\') index++
  if (text[index] === '/') index++
  const rest = text.slice(index)
  return rest.length < MODEL_TEXT_TAG.length && MODEL_TEXT_TAG.startsWith(rest)
}

/** Escapes a model's answer text as it streams in. A tag can be split across
 *  tokens, so the escaper holds back a text end that can still grow into a
 *  tag until a later token or `flush` decides. The joined output of every
 *  `push` and the last `flush` is the escaped text of the joined tokens. */
export class ModelTextEscaper {
  private held = ''

  /** The escaped text that can be shown now. */
  push(token: string): string {
    const text = this.held + token
    // A run holds no `<` after its first char, so only a run that starts at
    // the last `<` can reach the text end.
    const last = text.lastIndexOf('<')
    const holdFrom = last >= 0 && couldGrowIntoTag(text.slice(last)) ? last : text.length
    this.held = text.slice(holdFrom)
    return escapeModelText(text.slice(0, holdFrom))
  }

  /** The held text, at the end of a request round. It holds no whole run, so
   *  it needs no escape. */
  flush(): string {
    const held = this.held
    this.held = ''
    return held
  }
}
