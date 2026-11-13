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

/** Replace the last copy of `tail` in a section's text nodes with `text`,
 *  mutating in place for Vue reactivity. The stream controller replaces the
 *  running tool blocks that it appended (`dez.stream/start`). The user can
 *  type in a streaming section, also after those blocks, so the copy is the
 *  section's end only most of the time. Returns false when no text node
 *  holds `tail` (the user deleted it). */
export function replaceStreamingTail(section: Section, tail: string, text: string): boolean {
  for (let index = section.content.length - 1; index >= 0; index--) {
    const node = section.content[index]
    if (node.kind !== 'text') continue
    const at = node.text.lastIndexOf(tail)
    if (at < 0) continue
    node.text = node.text.slice(0, at) + text + node.text.slice(at + tail.length)
    return true
  }
  return false
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

/** Any live CodeMirror sentinel (the constants are in
 *  `src/view/thread/cmEditor.ts`): U+001E separates sections, U+E000 id
 *  U+E001 body U+E002 brackets a prompt pill, U+E003 is an escaped newline. */
export const SENTINEL_CHAR = /[\u001E\uE000-\uE003]/

// What `stripLiveSentinels` takes out of live-doc text: a pill header
// (U+E000 + id + U+E001), then every other marker. A header never holds a
// marker inside, so one pass finds the same ranges as a pass for the
// headers and a second one for the markers that are left.
const LIVE_MARKERS = /\u{E000}[^\n\u001E\u{E000}-\u{E002}]*\u{E001}|[\u001E\u{E000}-\u{E002}]/gu

/** Plain text of live-doc text that holds no well-formed pill: no sentinels,
 *  and no ids of broken pill headers. A header (U+E000 + id + U+E001) goes
 *  with its id: the id is not text, and kept as text it became UUID tab
 *  titles. The header rule must match `pillHeaderBodyIndex` in cmEditor.ts.
 *  The view (titles, clipboard) and the disk format both use this one copy.
 *  For the doc text of a whole section, pills and all, it gives the
 *  section's `sectionPlainText`: each pill leaves its body. (The one
 *  difference is a U+E001 inside a pill's body, which only a paste of that
 *  char can put there: it stays in the body and goes here.) */
export function stripLiveSentinels(text: string): string {
  if (!SENTINEL_CHAR.test(text)) return text
  return text.replace(LIVE_MARKERS, '').replace(/\u{E003}/gu, '\n')
}

/** `stripLiveSentinels(text)`, and where each of its chars is in `text`. */
export interface PlainLiveText {
  text: string
  /** The offset in the live text of the char at `offset` of `text`. */
  liveOffset: (offset: number) => number
}

/** The plain text of live-doc text (`stripLiveSentinels`) with the way
 *  back, for a reader that finds ranges in the plain text and shows them in
 *  the editor. U+E003 stays one char, so only the markers move offsets. */
export function plainLiveText(text: string): PlainLiveText {
  if (!SENTINEL_CHAR.test(text)) return { text, liveOffset: (offset) => offset }
  // After each marker: the length of the plain text before it, and the
  // length of all the markers up to its end.
  const markers: Array<{ plainLength: number, removed: number }> = []
  let plain = ''
  let end = 0
  for (const match of text.matchAll(LIVE_MARKERS)) {
    plain += text.slice(end, match.index)
    end = match.index + match[0].length
    markers.push({ plainLength: plain.length, removed: end - plain.length })
  }
  plain += text.slice(end)
  return {
    text: plain.replace(/\u{E003}/gu, '\n'),
    liveOffset(offset) {
      // The char is after every marker that has `offset` chars or fewer
      // before it.
      let removed = 0
      for (const marker of markers) {
        if (marker.plainLength > offset) break
        removed = marker.removed
      }
      return offset + removed
    },
  }
}
