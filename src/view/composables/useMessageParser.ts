export interface TextSegment {
  type: 'text'
  content: string
}

export interface CodeSegment {
  type: 'code'
  language: string
  content: string
}

export type MessageSegment = TextSegment | CodeSegment

const codeBlockRegex = /```(\w*)\n([\s\S]*?)```/g

export function parseMessageContent(content: string): MessageSegment[] {
  const segments: MessageSegment[] = []
  let lastIndex = 0

  for (const match of content.matchAll(codeBlockRegex)) {
    const matchStart = match.index!
    if (matchStart > lastIndex) {
      segments.push({ type: 'text', content: content.slice(lastIndex, matchStart) })
    }
    segments.push({
      type: 'code',
      language: match[1] || 'text',
      content: match[2],
    })
    lastIndex = matchStart + match[0].length
  }

  if (lastIndex < content.length) {
    segments.push({ type: 'text', content: content.slice(lastIndex) })
  }

  if (segments.length === 0) {
    segments.push({ type: 'text', content })
  }

  return segments
}
