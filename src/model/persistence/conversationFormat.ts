import { stripLiveSentinels } from '../chat/content'
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
//   <!-- title: X | model: provider/model | created: N -->
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
  let output = `<!-- title: ${escapeTitle(data.title)} | model: ${escapeTitle(model)} | created: ${data.created_at} -->\n`

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

// The conversation as plain Markdown for people to read (Save As Markdown).
// The history format above does not render: a CommonMark tag name cannot
// hold `:`, so viewers show `<dez:pill …/>` as text. Each message gets its
// role heading (`messagesAsMarkdown`, which Copy Markdown also uses) and
// holds what the model received: its text with prompt bodies inline. The
// agent thinking and the tool calls are left out, and a clip is a link
// (`sectionTextAsMarkdown`). Dez cannot read this format back.
export function serializeConversationAsMarkdown(data: ConversationData): string {
  const messages = messagesAsMarkdown(data.sections.map((section) => {
    const text = section.nodes
      .map((node) => stripLiveSentinels(node.kind === 'text' ? node.text : node.body))
      .join('')
    return { role: section.role, text: sectionTextAsMarkdown(section.role, text) }
  }))
  const title = `# ${data.title.replace(/\s+/g, ' ').trim() || 'Conversation'}\n`
  return messages === '' ? title : `${title}\n${messages}`
}

function parseHeader(line: string): { title: string; model: string; createdAt: number } {
  const inner = line
    .trim()
    .replace(/^<!--/, '')
    .replace(/-->$/, '')
    .trim()
  let title = ''
  let model = ''
  let createdAt = 0

  for (const rawPart of inner.split('|')) {
    const part = rawPart.trim()
    if (part.startsWith('title:')) {
      title = part.slice('title:'.length).trim()
    } else if (part.startsWith('model:')) {
      model = part.slice('model:'.length).trim()
    } else if (part.startsWith('created:')) {
      const parsed = Number.parseInt(part.slice('created:'.length).trim(), 10)
      createdAt = Number.isFinite(parsed) ? parsed : 0
    }
  }

  return { title, model, createdAt }
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
  let title = ''
  let model = ''
  let createdAt = 0
  let body = content
  const firstLineEnd = content.indexOf('\n')

  if (firstLineEnd >= 0) {
    const first = content.slice(0, firstLineEnd)
    if (first.trimStart().startsWith('<!--') && first.trimEnd().endsWith('-->')) {
      const header = parseHeader(first)
      title = header.title
      model = header.model
      createdAt = header.createdAt
      body = content.slice(firstLineEnd + 1)
    }
  } else if (content.trimStart().startsWith('<!--') && content.trimEnd().endsWith('-->')) {
    const header = parseHeader(content)
    title = header.title
    model = header.model
    createdAt = header.createdAt
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
    title,
    sections,
    activeModel: activeModelFromHeader(model),
    created_at: createdAt,
  }
}
