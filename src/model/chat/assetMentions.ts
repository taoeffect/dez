import { findAssetMentions, type AssetMention } from './imageMentions'
import { findImageReferences } from './images'
import { findMediaTags, type MediaTag, type MediaTagKind } from './mediaTags'
import { withoutStoredFilePaths } from './storedFilePaths'
import type { Role } from './types'

// Where a section's text can hold an `@id` mention (imageMentions.ts), and
// which image or clip a mention names. Two readers need it: the request
// builder (streams/messages.ts), which sends the image or the clip of each
// mention of the newest user message, and the editor
// (view/editor/mentions.ts), which shows each mention that names something
// as a chip. A chip must be true: it shows where a request takes a mention.
// So both split a text with `assetTextPieces`, and `namedMentions` follows
// the rules of the request builder (`sectionsToStreamMessages`,
// `messageClips`); a test ties the two.

/** A run of a section's text: a media tag, an image reference, or the text
 *  between them (a gap). `from` and `to` are offsets in that text. */
export type AssetTextPiece =
  | { kind: 'media', tag: MediaTag }
  | { kind: 'reference', from: number, to: number, path: string }
  | { kind: 'gap', from: number, to: number }

/** The pieces of a section's text, in order, with no empty gap. References
 *  are read in the text outside the media tags, with `role` (a linked
 *  reference counts only in a user section, images.ts). Mentions count only
 *  in a gap: the path and the metadata of a reference and the attributes of
 *  a tag can hold an `@`. */
export function assetTextPieces(text: string, role: Role): AssetTextPiece[] {
  const pieces: AssetTextPiece[] = []
  const addGap = (from: number, to: number) => {
    if (from < to) pieces.push({ kind: 'gap', from, to })
  }
  // The text between two tags: its references, and the gaps around them.
  const addText = (from: number, to: number) => {
    let end = from
    for (const reference of findImageReferences(text.slice(from, to), role)) {
      addGap(end, from + reference.from)
      end = from + reference.to
      pieces.push({ kind: 'reference', from: from + reference.from, to: end, path: reference.path })
    }
    addGap(end, to)
  }
  let start = 0
  for (const tag of findMediaTags(text)) {
    addText(start, tag.from)
    pieces.push({ kind: 'media', tag })
    start = tag.to
  }
  addText(start, text.length)
  return pieces
}

/** What an `@id` mention names. */
export type AssetKind = 'image' | MediaTagKind

/** A mention that names an image or a clip of its conversation. */
export interface NamedMention extends AssetMention {
  kind: AssetKind
}

/** A section as the mention rules read it: its role and its whole text
 *  (`sectionPlainText`, content.ts). */
export interface MentionSection {
  role: Role
  text: string
}

// Whether a request sends the line of `gap` that holds `mention` as it is:
// the line holds no path that the scrub takes out. The scrub never reads
// across a line break, so one line tells it.
function requestKeepsLine(gap: string, mention: AssetMention): boolean {
  // The mention starts with `@`, so the search finds the break before it.
  const lineFrom = gap.lastIndexOf('\n', mention.from) + 1
  const lineEnd = gap.indexOf('\n', mention.to)
  const line = gap.slice(lineFrom, lineEnd < 0 ? gap.length : lineEnd)
  return withoutStoredFilePaths(line) === line
}

/** For each of `sections` (a conversation, in order), the mentions of its
 *  text that name an image or a clip, in text order, with offsets in that
 *  text. The rules are the ones of a request:
 *  - A mention names the image or the clip that has its id in its own
 *    section or in a section before it, user or agent. A later section is
 *    never read. An id that an image and a clip both have (a hand edit)
 *    names the image; of two clips with one id, it names the last one.
 *  - A mention counts only in a gap of `assetTextPieces`.
 *  - A request reads the mentions of a gap after the path scrub
 *    (`withoutStoredFilePaths`). On a line that the scrub changes (a bare
 *    path of a stored file, a broken reference or tag), the offsets are
 *    others after it, and a word in the path is gone. So a mention on such
 *    a line is left out here.
 *
 *  So each mention here is one that a request takes when its section is
 *  the newest user message, and only a line that the scrub changes can hold
 *  a mention of a request that is not here. */
export function namedMentions(sections: readonly MentionSection[]): NamedMention[][] {
  const imageIds = new Set<string>()
  const clipKinds = new Map<string, MediaTagKind>()
  return sections.map(({ role, text }) => {
    for (const { id } of findImageReferences(text, role)) {
      if (id !== null) imageIds.add(id)
    }
    for (const { id, kind } of findMediaTags(text)) clipKinds.set(id, kind)
    if ((imageIds.size === 0 && clipKinds.size === 0) || !text.includes('@')) return []

    const mentions: NamedMention[] = []
    for (const piece of assetTextPieces(text, role)) {
      if (piece.kind !== 'gap') continue
      const gap = text.slice(piece.from, piece.to)
      for (const mention of findAssetMentions(gap)) {
        const kind = imageIds.has(mention.id) ? 'image' : clipKinds.get(mention.id)
        if (kind === undefined || !requestKeepsLine(gap, mention)) continue
        mentions.push({ from: piece.from + mention.from, to: piece.from + mention.to, id: mention.id, kind })
      }
    }
    return mentions
  })
}
