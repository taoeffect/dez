import type { ContentNode, PromptNode, Section, TextNode } from './types'

export function textNode(text = ''): TextNode {
  return { kind: 'text', text }
}

export function promptNode(input: {
  promptId: string | null
  name: string
  body: string
  expanded?: boolean
  id?: string
}): PromptNode {
  return {
    kind: 'prompt',
    id: input.id ?? crypto.randomUUID(),
    promptId: input.promptId,
    name: input.name,
    body: input.body,
    expanded: input.expanded ?? false,
  }
}

/**
 * Coalesce adjacent text nodes; ensure the result is never empty by injecting
 * a zero-length text node. Preserves text nodes around prompt nodes so the
 * caret can always land on editable text between pills.
 */
export function normalizeContent(nodes: ContentNode[]): ContentNode[] {
  const out: ContentNode[] = []
  for (const node of nodes) {
    if (node.kind === 'text') {
      const last = out[out.length - 1]
      if (last && last.kind === 'text') {
        last.text += node.text
      } else {
        out.push({ kind: 'text', text: node.text })
      }
    } else {
      // Ensure a text node precedes every prompt node and follows the last one.
      const last = out[out.length - 1]
      if (!last || last.kind !== 'text') out.push(textNode(''))
      out.push(node)
    }
  }
  const last = out[out.length - 1]
  if (!last || last.kind !== 'text') out.push(textNode(''))
  if (out.length === 0) out.push(textNode(''))
  return out
}

/** Concatenate all text + prompt bodies in document order. */
export function sectionPlainText(section: Section): string {
  return section.content
    .map((n) => (n.kind === 'text' ? n.text : n.body))
    .join('')
}

/** Concatenate ONLY visible text (ignoring prompt bodies); used for title / emptiness. */
export function sectionVisibleText(section: Section): string {
  return section.content.map((n) => (n.kind === 'text' ? n.text : '')).join('')
}

/** True when the section has no prompt pills and only whitespace text. */
export function sectionIsEmpty(section: Section): boolean {
  for (const node of section.content) {
    if (node.kind === 'prompt') return false
    if (node.text.trim() !== '') return false
  }
  return true
}

/** Convert a plain string (legacy persisted form) into normalized content nodes. */
export function contentFromString(text: string): ContentNode[] {
  return normalizeContent([textNode(text)])
}

/**
 * Split a content array at a visible-text offset, returning [before, after].
 * Prompt pills are treated as atomic zero-length markers for offset purposes
 * (consistent with cursor walkers that skip over them). A pill landing
 * exactly at the split point goes into the `after` half.
 */
export function splitContentAt(
  nodes: ContentNode[],
  offset: number,
): [ContentNode[], ContentNode[]] {
  const before: ContentNode[] = []
  const after: ContentNode[] = []
  let consumed = 0
  let splitDone = false

  for (const node of nodes) {
    if (splitDone) {
      after.push(node)
      continue
    }
    if (node.kind === 'prompt') {
      before.push(node)
      continue
    }
    const remaining = offset - consumed
    if (remaining >= node.text.length) {
      before.push(node)
      consumed += node.text.length
      if (consumed === offset) {
        splitDone = true
      }
    } else {
      before.push(textNode(node.text.slice(0, Math.max(0, remaining))))
      after.push(textNode(node.text.slice(Math.max(0, remaining))))
      splitDone = true
    }
  }

  return [normalizeContent(before), normalizeContent(after)]
}

/** Append streaming tokens to the last text node, mutating in place for Vue reactivity. */
export function appendStreamingText(section: Section, token: string): void {
  const last = section.content[section.content.length - 1]
  if (last && last.kind === 'text') {
    last.text += token
  } else {
    section.content.push(textNode(token))
  }
}

/** Replace a section's content with a single text node (used when reading plain text from the DOM). */
export function setSectionPlainText(section: Section, text: string): void {
  // Mutate in place so array identity stays stable for reactivity consumers.
  section.content.splice(0, section.content.length, textNode(text))
}

/** Build a fresh empty section content array. */
export function emptyContent(): ContentNode[] {
  return [textNode('')]
}

/** Structural + text equality for two ContentNode arrays. */
export function contentEquals(a: ContentNode[], b: ContentNode[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const na = a[i]
    const nb = b[i]
    if (na.kind !== nb.kind) return false
    if (na.kind === 'text' && nb.kind === 'text') {
      if (na.text !== nb.text) return false
    } else if (na.kind === 'prompt' && nb.kind === 'prompt') {
      if (
        na.id !== nb.id ||
        na.promptId !== nb.promptId ||
        na.name !== nb.name ||
        na.body !== nb.body ||
        na.expanded !== nb.expanded
      ) return false
    }
  }
  return true
}
