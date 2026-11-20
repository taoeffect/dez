import { MARKER_ATTRIBUTES, markerAttributes } from '../../utils/markerAttribute'
import { isAppName } from '../tools/appManifest'
import { codeRanges, inCode } from './codeRanges'
import type { LinkedPathRule } from './images'

// An app that Dez shows in a conversation is plain text, as a clip and a
// tool call are: no content node kind and no sentinel. It is one
// self-closing tag on a line of its own. Conversation files and clipboard
// text hold it as it is. This module is the one place that writes and
// recognizes it; requests, the editor (view/editor/apps.ts), and the
// search, preview, and Markdown text all call it.
//
//   <dez:app name="unit-converter"/>
//
// - A tag is one whole line: it starts at the text start or after `\n`, and
//   ends at the text end or before `\n`. Its attributes have the grammar of
//   markerAttribute.ts. `name` is the name of the app, which is the name of
//   its folder in `apps/` of the app root (`isAppName`,
//   tools/appManifest.ts). A tag with no valid `name` is plain text, so the
//   user sees that it is not valid. The tag code reads no other attribute,
//   and the writer gives none.
// - An app is no asset. The tag has no id of the id sequence (mediaIds.ts),
//   so no `@id` mention names it, and it holds no path: Dez finds the app
//   by its name in the folder of the apps. One app can have more than one
//   tag in a conversation, and a tag can name an app that is not there any
//   more.
// - Only `apps show` (tools/appShow.ts) writes a tag, into the reply of its
//   call. Answer text from a model is escaped (`ModelTextEscaper`,
//   toolBlocks.ts), so a model cannot write one. Tags count in every
//   section: a paste can bring one into a user section.
// - A tag in Markdown code (codeRanges.ts) is text, as a media tag there
//   is: no card. Only a user text can hold one: in any other text, a tag
//   line is a line of Dez, which ends code.
// - A provider gets a tag only as the text of the writer (`appTagText`):
//   of a user section through `assetTextPieces` (assetMentions.ts), and of
//   an agent section through `agentTextForRequest` (toolBlocks.ts). So an
//   attribute that a tag gets later changes no request bytes. A tag in
//   code goes as its text. The tag of an `apps show` call does not go at
//   all when the result of the call names the app (`roundRequestText`,
//   streams/messages.ts).

/** The name of the tag, for the escape of model text. */
export const APP_TAG_NAME = 'dez:app'

/** A tag in a text: the name of its app, and its range (`to` is the end
 *  of its line). */
export interface AppTag {
  name: string
  from: number
  to: number
}

/** A run of a text: plain text, or one app tag. */
export type AppTextPiece =
  | { kind: 'text'; text: string }
  | { kind: 'app'; tag: AppTag }

const TAG_START = `<${APP_TAG_NAME}`
// Tested on one line only, so the `\s` of the attribute rule cannot cross a
// line break. The group holds the attributes. The attribute rule needs a
// space after the tag name, so a longer name (`dez:apps`) is no tag.
const TAG_LINE = new RegExp(String.raw`^${TAG_START}(${MARKER_ATTRIBUTES})\/>$`)

/** The text of the tag of the app `name`: one line. The name of an app
 *  holds no char that an attribute value must escape (`isAppName`). */
export function appTagText(name: string): string {
  return `${TAG_START} name="${name}"/>`
}

// The name of the app of the tag that is the whole of `line`; null when
// the line is not a tag.
function readTag(line: string): string | null {
  const match = TAG_LINE.exec(line)
  const name = match ? markerAttributes(match[1]).get('name') : undefined
  return name !== undefined && isAppName(name) ? name : null
}

/** The app tags in a text whose linked paths count by `rule` (the rule
 *  tells whether the text can hold Markdown code, codeRanges.ts), in
 *  order. A tag in code is text, so it is not here, unless
 *  `options.inCode` is set. */
export function findAppTags(text: string, rule: LinkedPathRule, options: { inCode?: boolean } = {}): AppTag[] {
  const tags: AppTag[] = []
  for (let from = text.indexOf(TAG_START); from >= 0;) {
    if (from > 0 && text[from - 1] !== '\n') {
      from = text.indexOf(TAG_START, from + 1)
      continue
    }
    const lineEnd = text.indexOf('\n', from)
    const to = lineEnd < 0 ? text.length : lineEnd
    const name = readTag(text.slice(from, to))
    if (name !== null) tags.push({ name, from, to })
    // The rest of this line holds no line start.
    from = text.indexOf(TAG_START, to)
  }
  // In a text that is not a user text, a tag line is a line of Dez, which
  // no code holds (codeRanges.ts), so it needs no parse.
  if (tags.length === 0 || options.inCode || rule !== 'user') return tags
  const code = codeRanges(text, rule)
  return code.length === 0 ? tags : tags.filter((tag) => !inCode(code, tag.from))
}

/** A text as its plain-text and app tag pieces, in order, with the tags of
 *  `findAppTags`. Empty text pieces are left out; whitespace is kept. */
export function splitAppTags(text: string, rule: LinkedPathRule): AppTextPiece[] {
  const pieces: AppTextPiece[] = []
  let start = 0
  for (const tag of findAppTags(text, rule)) {
    if (tag.from > start) pieces.push({ kind: 'text', text: text.slice(start, tag.from) })
    pieces.push({ kind: 'app', tag })
    start = tag.to
  }
  if (start < text.length) pieces.push({ kind: 'text', text: text.slice(start) })
  return pieces
}

/** A text of the user as a provider gets it: each app tag as the text of
 *  the writer (`appTagText`), and the rest as it is, also a tag in code.
 *  Give it the whole text of a section: a tag counts only at a line start
 *  of that text. */
export function appTagsForRequest(text: string): string {
  return splitAppTags(text, 'user').map((piece) => (piece.kind === 'text' ? piece.text : appTagText(piece.tag.name))).join('')
}

/** The text that stands for the app `name` in history previews and
 *  Markdown text. */
export function appTagLabel(name: string): string {
  return `[app ${name}]`
}

/** A text whose linked paths count by `rule`, with each app tag replaced
 *  by `label` of its app: the label of previews when there is none. A tag
 *  in code stays as its text. */
export function labelAppTags(text: string, rule: LinkedPathRule, label: (name: string) => string = appTagLabel): string {
  return splitAppTags(text, rule).map((piece) => (piece.kind === 'text' ? piece.text : label(piece.tag.name))).join('')
}
