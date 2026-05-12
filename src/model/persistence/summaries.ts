import type { ConversationData, ConversationSummary, SectionData } from './types'

function nodePlainText(node: SectionData['nodes'][number]): string {
  return node.kind === 'text' ? node.text : node.body
}

function sectionHasVisibleContent(section: SectionData): boolean {
  return section.nodes.some((node) => {
    if (node.kind === 'text') return node.text.trim() !== ''
    return true
  })
}

export function messageCount(sections: SectionData[]): number {
  return sections.filter(sectionHasVisibleContent).length
}

export function conversationPreview(sections: SectionData[]): string {
  const text = sections
    .flatMap((section) => section.nodes)
    .map(nodePlainText)
    .join(' ')
  const normalized = text.split(/\s+/).filter(Boolean).join(' ')
  const maxPreviewChars = 160
  if ([...normalized].length > maxPreviewChars) {
    return [...normalized].slice(0, maxPreviewChars).join('') + '…'
  }
  return normalized
}

export function conversationModel(data: ConversationData): string | null {
  return data.activeModel ? `${data.activeModel.providerId}/${data.activeModel.modelId}` : null
}

export function conversationSummary(
  data: ConversationData,
  updatedAt = data.created_at,
): ConversationSummary {
  return {
    id: data.id,
    title: data.title,
    createdAt: data.created_at,
    updatedAt,
    model: conversationModel(data),
    messageCount: messageCount(data.sections),
    preview: conversationPreview(data.sections),
  }
}

export function sortConversationSummaries(summaries: ConversationSummary[]): ConversationSummary[] {
  return summaries.slice().sort((a, b) => b.updatedAt - a.updatedAt)
}
