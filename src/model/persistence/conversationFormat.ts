import { closesFence, fenceOpener, type Fence } from '../../utils/markdownFence'
import { stripLiveSentinels } from '../chat/content'
import { modelRefKey, parseModelRefKey } from '../chat/modelRef'
import { parsePillMarker, pillMarkerLine } from '../chat/pillMarker'
import type { ActiveModel, ModelRef } from '../chat/types'
import type { ContentNodeData, ConversationData, SectionData } from './types'

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
    output += `${pillMarkerLine(section.role, section.model)}\n`
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

// CommonMark ends an unclosed fence only at the end of the document, so a
// message that stops inside a code block (a stopped stream) would turn all
// later headings into code. The editor treats each message as its own
// document, so the export closes the fence at the end of its message.
function unclosedFence(text: string): Fence | null {
  let fence: Fence | null = null
  for (const line of text.split('\n')) {
    if (fence) {
      if (closesFence(line, fence)) fence = null
    } else {
      fence = fenceOpener(line)
    }
  }
  return fence
}

// The conversation as plain Markdown for people to read (Save As Markdown).
// The history format above does not render: a CommonMark tag name cannot
// hold `:`, so viewers show `<dez:pill …/>` as text. Each message gets a
// `## User` / `## Agent` heading (the editor's role labels) and holds what
// the model received: its text with prompt bodies inline. Dez cannot read
// this format back.
export function serializeConversationAsMarkdown(data: ConversationData): string {
  let output = `# ${data.title.replace(/\s+/g, ' ').trim() || 'Conversation'}\n`

  for (const section of data.sections) {
    const text = section.nodes
      .map((node) => stripLiveSentinels(node.kind === 'text' ? node.text : node.body))
      .join('')
    if (text.trim() === '') continue
    output += `\n## ${section.role === 'agent' ? 'Agent' : 'User'}\n\n${text}`
    if (!text.endsWith('\n')) output += '\n'
    // The closer keeps the opener's indent: a column-0 closer after a fence
    // in a list item would end the list item and open a new fence.
    const fence = unclosedFence(text)
    if (fence) output += `${' '.repeat(fence.indent)}${fence.char.repeat(fence.length)}\n`
  }

  return output
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

function flushSection(
  sections: SectionData[],
  role: 'user' | 'agent' | null,
  model: ModelRef | null,
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
  sections.push(model ? { role, nodes, model } : { role, nodes })
  return []
}

function activeModelFromHeader(model: string): ActiveModel | null {
  const ref = parseModelRefKey(model)
  return ref ? { ...ref, modelName: ref.modelId } : null
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

  const sections: SectionData[] = []
  let currentRole: 'user' | 'agent' | null = null
  let currentModel: ModelRef | null = null
  let currentNodes: ContentNodeData[] = []
  let textBuffer = ''
  let inPrompt = false
  let currentPromptName = ''
  let promptBody = ''

  for (const line of body.split('\n').slice(0, body.endsWith('\n') ? -1 : undefined)) {
    const trimmed = line.trim()

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
      currentNodes = flushSection(sections, currentRole, currentModel, currentNodes)
      currentRole = marker.role
      currentModel = marker.model
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
  flushSection(sections, currentRole, currentModel, currentNodes)

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
