import { compactionsField, type Compactions } from '../chat/compaction'
import { compactionTextForPeople } from '../chat/compactionNotes'
import { stripLiveSentinels } from '../chat/content'
import { contextField, type CountedContext } from '../chat/contextSize'
import { agentTextEditedField, costField, type ConversationCost } from '../chat/conversationCost'
import { durationField } from '../chat/duration'
import { messagesAsMarkdown, sectionTextAsMarkdown } from '../chat/markdown'
import { modelRefKey, parseModelRefKey } from '../chat/modelRef'
import { PILL_CLOSE_TAG, containerThinking, parsePillMarker, pillMarkerText, type PillMarker } from '../chat/pillMarker'
import type { ActiveModel, SectionThinking } from '../chat/types'
import type { ContentNodeData, ConversationData, SectionData } from './types'

// The conversation history file, ~/.config/dez/conversations/<id>.md
// (persistence.rs keeps only the ASCII letters, digits, `-`, and `_` of the
// id):
//
//   <!-- title: X | model: provider/model | created: N | cost: 0.42 | requests: 7 | unpriced: 1 | edited: yes | context: 81200 | context-estimate: 90400 | compactions: 2 | compacted-tokens: 412000 | compacted-cost: 0.31 | compacted-requests: 5 | compacted-left: 24100 -->
//
//   <dez:pill type="user"/>
//   text
//   <dez:prompt name="NAME">
//   prompt body
//   </dez:prompt>
//   <dez:pill type="agent" model="provider/model" duration-ms="4213"/>
//   text
//
// - The header `model:` is the tab's last selected model (`activeModel`),
//   not the model of each reply. A pill with no `model` gives a section with
//   no model; the header never fills it in.
// - `cost:` (USD), `requests:`, and `unpriced:` are `Tab.cost`, and
//   `edited: yes` is `Tab.agentTextEdited`. Each part is only there when
//   set (`unpriced:` only when more than 0). Files of an older Dez have
//   none of them, and an older Dez ignores them. A cost with a bad or a
//   missing value is ignored as a whole.
// - `context:` and `context-estimate:` are `Tab.context` (its `tokens` and
//   its `estimate`), there only when set. A context with a bad or a
//   missing value is ignored as a whole.
// - `compactions:`, `compacted-tokens:`, `compacted-cost:` (USD),
//   `compacted-requests:`, `compacted-unpriced:`, and `compacted-left:` are
//   `Tab.compactions` (its `count`, its `tokens`, its `cost`, and its
//   `left`), there only when set, after the other parts
//   (`compacted-unpriced:` only when more than 0). Compactions with a bad
//   or a missing value are ignored as a whole; `compacted-left:` can be
//   missing.
// - The first section of a compacted conversation is an agent section
//   whose first text line is the compaction tag (compaction.ts): the
//   block, then the text of the reply that ran at the compaction, with the
//   model, the thinking, and the time of that reply. The tag is section
//   text here, as a media tag is.
// - `duration-ms` is how long the reply took (`Section.durationMs`); files
//   saved before Dez stored it have none.
// - Each pill line starts a section. pillMarker.ts owns the pill markers,
//   the thinking containers, and their escaping.
// - A literal `</dez:prompt>` in a prompt body is written as `<\/dez:prompt>`.
//   The prompt name is written as is, without escapeMarkerAttribute.
// - The prompt `expanded` UI state is not saved: loaded prompts are collapsed.
// - Agent text can hold `<dez:tool …>` blocks (toolBlocks.ts). They are
//   section text here: their bodies are escaped, so no body line starts a
//   section or a prompt.

function escapeTitle(value: string): string {
  return value.replaceAll('|', '/').replaceAll('\n', ' ').replaceAll('\r', ' ')
}

function escapePromptBody(body: string): string {
  return body.replaceAll('</dez:prompt>', '<\\/dez:prompt>')
}

function unescapePromptBody(body: string): string {
  return body.replaceAll('<\\/dez:prompt>', '</dez:prompt>')
}

function promptId(): string {
  return `p-${Date.now().toString(16)}-${Math.floor(Math.random() * 0xffffffff).toString(16)}`
}

export function serializeConversation(data: ConversationData): string {
  const model = data.activeModel ? modelRefKey(data.activeModel) : ''
  let output = `<!-- title: ${escapeTitle(data.title)} | model: ${escapeTitle(model)} | created: ${data.created_at}${optionalHeaderParts(data)} -->\n`

  for (const section of data.sections) {
    output += '\n'
    output += `${pillMarkerText(section)}\n`
    for (const node of section.nodes) {
      if (node.kind === 'text') {
        const text = stripLiveSentinels(node.text)
        output += text
        if (!text.endsWith('\n')) output += '\n'
      } else {
        output += `<dez:prompt name="${node.name}">\n`
        const body = escapePromptBody(stripLiveSentinels(node.body))
        output += body
        if (!body.endsWith('\n')) output += '\n'
        output += '</dez:prompt>\n'
      }
    }
  }

  return output
}

// The parts of a cost: its USD sum, its requests, and (when more than 0)
// its requests with no known price, under the given part names.
function costParts(cost: ConversationCost, usd: string, requests: string, unpriced: string): string[] {
  // 12 significant digits drop the float noise of a long sum (0.1 + 0.2).
  const parts = [`${usd}: ${Number(cost.usd.toPrecision(12))}`, `${requests}: ${cost.requests}`]
  if (cost.unpriced > 0) parts.push(`${unpriced}: ${cost.unpriced}`)
  return parts
}

// The header parts that are only there when set, each with its ` | `.
function optionalHeaderParts({ cost, agentTextEdited, context, compactions }: ConversationData): string {
  const parts: string[] = []
  if (cost) parts.push(...costParts(cost, 'cost', 'requests', 'unpriced'))
  if (agentTextEdited) parts.push('edited: yes')
  if (context) parts.push(`context: ${context.tokens}`, `context-estimate: ${context.estimate}`)
  if (compactions) {
    parts.push(
      `compactions: ${compactions.count}`,
      `compacted-tokens: ${compactions.tokens}`,
      ...costParts(compactions.cost, 'compacted-cost', 'compacted-requests', 'compacted-unpriced'),
    )
    if (compactions.left !== undefined) parts.push(`compacted-left: ${compactions.left}`)
  }
  return parts.map((part) => ` | ${part}`).join('')
}

// The conversation as plain Markdown for people to read (Save As Markdown).
// The history format above does not render: a CommonMark tag name cannot
// hold `:`, so viewers show `<dez:pill …/>` as text. Each message gets its
// role heading (`messagesAsMarkdown`, which Copy Markdown also uses) and
// holds what the model received: its text with prompt bodies inline. The
// agent thinking and the tool calls are left out, a compaction block gives
// its notes for people (`compactionTextForPeople`), and a clip is a link
// (`sectionTextAsMarkdown`). Dez cannot read this format back.
export function serializeConversationAsMarkdown(data: ConversationData): string {
  const messages = messagesAsMarkdown(data.sections.map((section, index) => {
    const text = section.nodes
      .map((node) => stripLiveSentinels(node.kind === 'text' ? node.text : node.body))
      .join('')
    return { role: section.role, text: sectionTextAsMarkdown(section.role, compactionTextForPeople(text, index, section.role)) }
  }))
  const title = `# ${data.title.replace(/\s+/g, ' ').trim() || 'Conversation'}\n`
  return messages === '' ? title : `${title}\n${messages}`
}

interface ConversationHeader {
  title: string
  model: string
  createdAt: number
  cost?: ConversationCost
  agentTextEdited?: true
  context?: CountedContext
  compactions?: Compactions
}

const EMPTY_HEADER: ConversationHeader = { title: '', model: '', createdAt: 0 }

/** The number of a header part's text; NaN when there is none. */
function headerNumber(text: string | undefined): number {
  return text === undefined || text === '' ? Number.NaN : Number(text)
}

/** The cost of the texts of a USD part, a requests part, and an unpriced
 *  part of the header; undefined when one of them is missing or bad. The
 *  cost has `leastRequests` requests or more. */
function headerCost(usdText: string | undefined, requestsText: string | undefined, unpricedText: string | undefined, leastRequests = 1): ConversationCost | undefined {
  const usd = headerNumber(usdText)
  const requests = headerNumber(requestsText)
  const unpriced = unpricedText === undefined ? 0 : headerNumber(unpricedText)
  if (!Number.isFinite(usd) || usd < 0) return undefined
  if (!Number.isInteger(requests) || requests < leastRequests) return undefined
  if (!Number.isInteger(unpriced) || unpriced < 0 || unpriced > requests) return undefined
  return { usd, requests, unpriced }
}

/** The counted context of the header's `context:` and `context-estimate:`
 *  texts; undefined when one of them is missing or bad. */
function headerContext(tokensText: string | undefined, estimateText: string | undefined): CountedContext | undefined {
  const tokens = headerNumber(tokensText)
  const estimate = headerNumber(estimateText)
  if (!Number.isSafeInteger(tokens) || tokens < 0) return undefined
  if (!Number.isSafeInteger(estimate) || estimate < 0) return undefined
  return { tokens, estimate }
}

/** The compactions of the header's `compactions:`, `compacted-tokens:`,
 *  `compacted-cost:`, `compacted-requests:`, `compacted-unpriced:`, and
 *  `compacted-left:` texts; undefined when one of them is bad, or missing
 *  (`compacted-left:` can be missing). The cost at a compaction can have
 *  no request: a conversation whose first request is its compaction. */
function headerCompactions(values: ReadonlyMap<string, string>): Compactions | undefined {
  const count = headerNumber(values.get('compactions'))
  const tokens = headerNumber(values.get('compacted-tokens'))
  const cost = headerCost(values.get('compacted-cost'), values.get('compacted-requests'), values.get('compacted-unpriced'), 0)
  const leftText = values.get('compacted-left')
  const left = headerNumber(leftText)
  if (!Number.isSafeInteger(count) || count < 1) return undefined
  if (!Number.isSafeInteger(tokens) || tokens < 0) return undefined
  if (leftText !== undefined && (!Number.isSafeInteger(left) || left < 0)) return undefined
  return cost && { count, tokens, cost, ...(leftText !== undefined && { left }) }
}

function parseHeader(line: string): ConversationHeader {
  const inner = line
    .trim()
    .replace(/^<!--/, '')
    .replace(/-->$/, '')
    .trim()
  let title = ''
  let model = ''
  let createdAt = 0
  const values = new Map<string, string>()

  for (const rawPart of inner.split('|')) {
    const part = rawPart.trim()
    if (part.startsWith('title:')) {
      title = part.slice('title:'.length).trim()
    } else if (part.startsWith('model:')) {
      model = part.slice('model:'.length).trim()
    } else if (part.startsWith('created:')) {
      const parsed = Number.parseInt(part.slice('created:'.length).trim(), 10)
      createdAt = Number.isFinite(parsed) ? parsed : 0
    } else {
      const colon = part.indexOf(':')
      if (colon > 0) values.set(part.slice(0, colon).trim(), part.slice(colon + 1).trim())
    }
  }

  return {
    title,
    model,
    createdAt,
    ...costField(headerCost(values.get('cost'), values.get('requests'), values.get('unpriced'))),
    ...agentTextEditedField(values.get('edited') === 'yes'),
    ...contextField(headerContext(values.get('context'), values.get('context-estimate'))),
    ...compactionsField(headerCompactions(values)),
  }
}

function parsePromptOpen(trimmed: string): string | null {
  if (!trimmed.startsWith('<dez:prompt') || trimmed.endsWith('/>')) return null
  const start = trimmed.indexOf('name="')
  if (start < 0) return null
  const rest = trimmed.slice(start + 6)
  const end = rest.indexOf('"')
  if (end < 0) return null
  return rest.slice(0, end)
}

function flushText(nodes: ContentNodeData[], text: string, stripTrailingNewline: boolean): string {
  if (text.length === 0) return ''
  const value = stripTrailingNewline ? text.replace(/\n+$/, '') : text
  if (value.length > 0) nodes.push({ kind: 'text', text: value })
  return ''
}

// `marker` is the pill that started the section: null for text before the
// first pill, which is a user section.
function flushSection(
  sections: SectionData[],
  role: 'user' | 'agent' | null,
  marker: PillMarker | null,
  thinking: SectionThinking | undefined,
  nodes: ContentNodeData[],
): ContentNodeData[] {
  if (!role) return nodes
  if (sections.length === 0 && role === 'user' && nodes.length === 0) return []
  if (sections.length === 0 && role === 'user') {
    const first = nodes[0]
    if (first?.kind === 'text') {
      const trimmed = first.text.replace(/^\n+/, '')
      if (trimmed.length === 0) {
        nodes.shift()
      } else {
        first.text = trimmed
      }
    }
  }
  sections.push({
    role,
    nodes,
    ...(marker?.model ? { model: marker.model } : {}),
    ...durationField(marker?.durationMs ?? undefined),
    ...(thinking ? { thinking } : {}),
  })
  return []
}

function activeModelFromHeader(model: string): ActiveModel | null {
  const ref = parseModelRefKey(model)
  return ref ? { ...ref, modelName: ref.modelId } : null
}

// An opening tag starts a container only when a closing tag line comes
// before the next marker line. The writer escapes both in a thinking body
// (`pillMarkerText`), so a marker line first means a hand edit lost the
// closing line. The tag then reads as a self-closing marker, and the lines
// after it stay section text: a later container's closing line must not
// turn them into thinking that a `field` replay sends to the provider.
function closesContainer(lines: string[], start: number): boolean {
  for (let index = start; index < lines.length; index++) {
    const trimmed = lines[index].trim()
    if (trimmed === PILL_CLOSE_TAG) return true
    if (parsePillMarker(trimmed)) return false
  }
  return false
}

export function parseConversation(id: string, content: string): ConversationData {
  let header = EMPTY_HEADER
  let body = content
  const firstLineEnd = content.indexOf('\n')

  if (firstLineEnd >= 0) {
    const first = content.slice(0, firstLineEnd)
    if (first.trimStart().startsWith('<!--') && first.trimEnd().endsWith('-->')) {
      header = parseHeader(first)
      body = content.slice(firstLineEnd + 1)
    }
  } else if (content.trimStart().startsWith('<!--') && content.trimEnd().endsWith('-->')) {
    header = parseHeader(content)
    body = ''
  }

  const lines = body.split('\n').slice(0, body.endsWith('\n') ? -1 : undefined)
  const sections: SectionData[] = []
  let currentRole: 'user' | 'agent' | null = null
  let currentMarker: PillMarker | null = null
  let currentThinking: SectionThinking | undefined
  let currentNodes: ContentNodeData[] = []
  let textBuffer = ''
  let inPrompt = false
  let currentPromptName = ''
  let promptBody = ''
  // The marker of the container being read, and its body lines so far.
  let openContainer: PillMarker | null = null
  let containerLines: string[] = []

  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim()

    // The body is the exact lines between the tag lines. Unlike a prompt
    // body, it keeps trailing newlines: the text may go back to the provider.
    if (openContainer) {
      if (trimmed === PILL_CLOSE_TAG) {
        currentThinking = containerThinking(openContainer, containerLines.join('\n'))
        openContainer = null
        containerLines = []
      } else {
        containerLines.push(line)
      }
      continue
    }

    if (inPrompt) {
      if (trimmed === '</dez:prompt>') {
        currentNodes.push({
          kind: 'prompt',
          id: promptId(),
          promptId: null,
          name: currentPromptName,
          body: unescapePromptBody(promptBody.replace(/\n+$/, '')),
          expanded: false,
        })
        currentPromptName = ''
        promptBody = ''
        inPrompt = false
      } else {
        promptBody += line
        promptBody += '\n'
      }
      continue
    }

    const marker = parsePillMarker(trimmed)
    if (marker) {
      textBuffer = flushText(currentNodes, textBuffer, true)
      currentNodes = flushSection(sections, currentRole, currentMarker, currentThinking, currentNodes)
      currentRole = marker.role
      currentMarker = marker
      currentThinking = undefined
      if (marker.container && closesContainer(lines, index + 1)) openContainer = marker
      continue
    }

    const promptName = parsePromptOpen(trimmed)
    if (promptName !== null) {
      textBuffer = flushText(currentNodes, textBuffer, false)
      if (!currentRole) currentRole = 'user'
      currentPromptName = promptName
      inPrompt = true
      continue
    }

    if (!currentRole) currentRole = 'user'
    textBuffer += line
    textBuffer += '\n'
  }

  if (inPrompt) {
    textBuffer += `<dez:prompt name="${currentPromptName}">\n`
    textBuffer += promptBody
  }

  flushText(currentNodes, textBuffer, true)
  flushSection(sections, currentRole, currentMarker, currentThinking, currentNodes)

  if (sections.length === 0) {
    sections.push({ role: 'user', nodes: [] })
  }

  return {
    id,
    title: header.title,
    sections,
    activeModel: activeModelFromHeader(header.model),
    created_at: header.createdAt,
    ...costField(header.cost),
    ...agentTextEditedField(header.agentTextEdited),
    ...contextField(header.context),
    ...compactionsField(header.compactions),
  }
}
