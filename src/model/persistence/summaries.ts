import { labelImageReferences } from '../chat/images'
import { labelMediaTags } from '../chat/mediaTags'
import { cloneModelRef } from '../chat/modelRef'
import { labelToolBlocks } from '../chat/toolBlocks'
import type { Role } from '../chat/types'
import type { ConversationData, ConversationSummary, SectionData } from './types'

// An image reference shows as `[image]`, never as its path. Prompt bodies
// too: their references are sent as images. A tool block in agent text
// gives a space: its markup and its result are not reply text. A media tag
// shows as `[audio]` or `[video]`.
function nodePlainText(node: SectionData['nodes'][number], role: Role): string {
  if (node.kind === 'prompt') return labelImageReferences(node.body, role)
  return labelImageReferences(labelMediaTags(role === 'agent' ? labelToolBlocks(node.text, ' ') : node.text), role)
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
    .flatMap((section) => section.nodes.map((node) => nodePlainText(node, section.role)))
    .join(' ')
  const normalized = text.split(/\s+/).filter(Boolean).join(' ')
  const maxPreviewChars = 160
  if ([...normalized].length > maxPreviewChars) {
    return [...normalized].slice(0, maxPreviewChars).join('') + '…'
  }
  return normalized
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
    model: data.activeModel ? cloneModelRef(data.activeModel) : null,
    messageCount: messageCount(data.sections),
    preview: conversationPreview(data.sections),
  }
}
