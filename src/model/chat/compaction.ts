import { MARKER_ATTRIBUTES, escapeMarkerAttribute, markerAttributes } from '../../utils/markerAttribute'
import { sectionIsEmpty, stripLiveSentinels } from './content'
import type { ConversationCost } from './conversationCost'
import { IMAGE_ID_SOURCE } from './images'
import { readShownPictures, shownPicturesText, type ShownPicture } from './shownPictures'
import type { ContentNode, Role, Section } from './types'

// A compaction makes a long conversation small: what a model wrote about
// the work so far takes the place of the old messages. That text is the
// compaction section: the first section of the conversation, an agent
// section whose first line is the compaction tag. The user messages that
// the compaction kept come right after it. This module is the one place
// that writes and recognizes the tag.
//
//   <dez:compaction count="2" last-id="k" pictures="[…]"/>
//
// - The tag is one whole line, and it counts only as the first line of the
//   first section of a conversation, at the start of the section's first
//   text node. At any other place the same text is plain text. A tag with
//   no valid `count`, or with a `last-id` that is no id, is plain text too,
//   so the user sees that it is not valid.
// - Attributes (the grammar of markerAttribute.ts), written in this order:
//   - `count`: the number of this compaction in its conversation, from 1.
//   - `last-id`: the highest id that the conversation ever gave to an image
//     or a clip. A compaction removes assets, and the kept text can still
//     name their ids (`@c`), so the id sequence counts this id too
//     (mediaIds.ts): the id of a removed asset is never given to a new one.
//     Absent when the conversation gave no id.
//   - `pictures`: the pictures that the compaction kept for the model (a
//     frame sheet of a clip, a wave), as their saved copies, in the form of
//     the `pictures` attribute of a tool block (shownPictures.ts). Absent
//     when there is none.
// - The role of the first section follows its text: `agent` when it starts
//   with a valid tag, else `user`, as the first section of every other
//   conversation (`firstSectionRole`, `contentCompactionTag`). So a user
//   who deletes the tag gets a normal conversation, and an undo brings the
//   compaction section back.
// - Answer text from a model is escaped (`ModelTextEscaper`, toolBlocks.ts),
//   so a model cannot write a tag.
// - A request sends the compaction section and the user sections right
//   after it as one `user` message, with no tag, the compaction message
//   (`sectionsToStreamMessages`, streams/messages.ts): both wire formats
//   need a user message first, and only a user message takes image parts.
// - A text for people (Markdown, a preview, the search) leaves the tag out
//   (`withoutCompactionTag`).

/** The name of the tag, for the escape of model text. */
export const COMPACTION_TAG_NAME = 'dez:compaction'

/** What a compaction tag holds. */
export interface CompactionTagData {
  /** The number of this compaction in its conversation: 1 or more. */
  count: number
  /** The highest id that the conversation ever gave to an image or a clip;
   *  null when it gave none. */
  lastId: string | null
  /** The pictures that the compaction kept for the model, in the order in
   *  which a request sends them. */
  pictures: ShownPicture[]
}

/** The tag at the start of a text. */
export interface CompactionTag extends CompactionTagData {
  /** The offset after the `>` of the tag. */
  to: number
  /** The offset of the text after the tag line: after its line break, or
   *  the end of a text that is only the tag. */
  textFrom: number
}

/** The numbers of the compactions of a conversation. Saved in the
 *  conversation header (conversationFormat.ts). The numbers of the part of
 *  the conversation since its newest compaction (its buffer) come from
 *  them: the cost of the buffer is the cost of the tab less `cost`, and
 *  the tokens of the whole conversation are `tokens` plus the context size
 *  of the tab. */
export interface Compactions {
  /** How many compactions the conversation had: 1 or more. */
  count: number
  /** The sum of the context sizes that the conversation had at each of its
   *  compactions, in tokens. */
  tokens: number
  /** The cost of the conversation at its newest compaction. */
  cost: ConversationCost
  /** The context size that the newest compaction left, in tokens: Dez's
   *  estimate right after it, then the count of the first chat request
   *  after it (`dez.model/tabs/countRequestContext`), which holds the
   *  answer of that request too. The two match the units of the context
   *  size at that time (`contextSize`). Absent when not known. The next
   *  compaction for the size waits for growth over it
   *  (`compactionDueSize`). */
  left?: number
}

/** For object spreads: `{ compactions }` (a copy), or `{}` without one,
 *  because a copy of a tab must never write `compactions: undefined`. */
export function compactionsField(compactions: Compactions | undefined): { compactions?: Compactions } {
  return compactions ? { compactions: { ...compactions, cost: { ...compactions.cost } } } : {}
}

/** The text that starts the compaction message of a request, before the
 *  text of the compaction section. It is in the cached prefix of every
 *  request of its conversation: never a date, a running count, or a
 *  random value. */
export const COMPACTION_MESSAGE_INTRO = '[Compaction: this conversation was long, so Dez put the notes below in place of its earlier messages. '
  + 'The notes are what the assistant wrote about the work so far, with the facts that Dez added. '
  + 'After the notes come the messages of the user that Dez kept, each one word for word.]'

/** The line before each user section of the compaction message. */
export const COMPACTION_USER_MESSAGE_LABEL = '[Message of the user]'

/** The first line of the section of the carried assets of the user: a user
 *  section that a compaction writes after the first kept message of the
 *  user. Below this line it holds only the image references and the media
 *  tags of the user's messages that the compaction took out, each on a
 *  line of its own, so that their ids still name them, and a linked file
 *  still counts (it counts only in a user section). The line tells the
 *  model and the user what the section is, and it tells the next
 *  compaction that the section is no message of the user
 *  (`isCarriedUserAssets`). It is in the cached prefix, as the texts
 *  above. */
export const CARRIED_USER_ASSETS_LABEL = '[Images and clips of the earlier messages of the user. Dez took those messages out of the conversation; the notes tell what they said.]'

/** Whether `text`, the text of a user section, is the section of the
 *  carried assets of the user (`CARRIED_USER_ASSETS_LABEL`). */
export function isCarriedUserAssets(text: string): boolean {
  return firstLine(text) === CARRIED_USER_ASSETS_LABEL
}

const TAG_START = `<${COMPACTION_TAG_NAME}`
// Tested on one line only, so the `\s` of the attribute rule cannot cross a
// line break. The group holds the attributes.
const TAG_LINE = new RegExp(String.raw`^${TAG_START}(${MARKER_ATTRIBUTES})\/>$`)
const COUNT = /^[1-9]\d*$/
const ASSET_ID = new RegExp(`^${IMAGE_ID_SOURCE}$`)

/** The line of `text` that starts at offset 0, with no line break. */
export function firstLine(text: string): string {
  const end = text.indexOf('\n')
  return end < 0 ? text : text.slice(0, end)
}

// The attributes of the tag that is the whole of `line`; null when the
// line is not a valid tag. An empty `last-id` reads as one that is not
// there. The `pictures` are not checked: a value that is not the writer's
// form reads as no pictures (`readShownPictures`).
function tagAttributes(line: string): { count: number, lastId: string | null, pictures: string | undefined } | null {
  // Most first lines are no tag: the cheap check comes first, as the editor
  // asks at each of its transactions (`firstSectionRole`).
  if (!line.startsWith(TAG_START)) return null
  const match = TAG_LINE.exec(line)
  if (!match) return null
  const attributes = markerAttributes(match[1])
  const countText = attributes.get('count')
  if (countText === undefined || !COUNT.test(countText)) return null
  const count = Number(countText)
  const lastId = attributes.get('last-id') || null
  if (!Number.isSafeInteger(count) || (lastId !== null && !ASSET_ID.test(lastId))) return null
  return { count, lastId, pictures: attributes.get('pictures') }
}

/** The text of a tag: one line, with live sentinels removed from every
 *  value (a label of a picture is text that a user can edit). */
export function compactionTagText({ count, lastId, pictures }: CompactionTagData): string {
  const attributes: Array<readonly [string, string]> = [['count', String(count)]]
  if (lastId !== null) attributes.push(['last-id', lastId])
  if (pictures.length > 0) attributes.push(['pictures', shownPicturesText(pictures)])
  return `${TAG_START}${attributes.map(([name, value]) => ` ${name}="${escapeMarkerAttribute(stripLiveSentinels(value))}"`).join('')}/>`
}

/** The tag that is the first line of `text`; null when that line is not a
 *  valid tag. The caller decides whether the text is one that a tag counts
 *  in (the first section of a conversation). */
export function readCompactionTag(text: string): CompactionTag | null {
  const line = firstLine(text)
  const attributes = tagAttributes(line)
  if (!attributes) return null
  return {
    count: attributes.count,
    lastId: attributes.lastId,
    pictures: attributes.pictures === undefined ? [] : readShownPictures(attributes.pictures),
    to: line.length,
    textFrom: Math.min(line.length + 1, text.length),
  }
}

/** The `last-id` of the tag that is the first line of `text`; null when
 *  that line is no valid tag, or a tag with no `last-id`. For the id
 *  sequence (mediaIds.ts), which reads it in the first section's text and
 *  in a whole editor doc. */
export function compactionLastId(text: string): string | null {
  return tagAttributes(firstLine(text))?.lastId ?? null
}

/** The role of the first section of a conversation whose editor doc (or
 *  first doc line) is `text`: `agent` when its first line is a valid tag,
 *  else `user`. A prompt pill on that line makes it no tag, as the line
 *  then holds the sentinels of the pill. */
export function firstSectionRole(text: string): Role {
  return tagAttributes(firstLine(text)) ? 'agent' : 'user'
}

/** The tag at the start of the content of a section, by the rule of the
 *  editor doc (`firstSectionRole`): the first node is a text that starts
 *  with the tag line, and no prompt pill is on that line. Null when there
 *  is none. The role of the section is not read. */
export function contentCompactionTag(content: readonly ContentNode[]): CompactionTag | null {
  const first = content[0]
  if (first?.kind !== 'text') return null
  const tag = readCompactionTag(first.text)
  // The doc line of the tag goes on into the node after a text with no
  // line break, and that node is a prompt pill.
  if (!tag || (tag.to === first.text.length && content.length > 1)) return null
  return tag
}

/** The tag of `section` when it is a compaction section: an agent section
 *  that starts with a valid tag. Only the first section of a conversation
 *  can be one; the caller gives no other section. Null when it is none. */
export function sectionCompactionTag(section: Section): CompactionTag | null {
  return section.role === 'agent' ? contentCompactionTag(section.content) : null
}

/** The index after the last section of the compaction message of
 *  `sections`, a conversation (or its sections that are not empty, for a
 *  request): the compaction section and the user sections right after it,
 *  up to the first later agent section that is not empty. The request
 *  (`sectionsToStreamMessages`, streams/messages.ts) and the compaction
 *  read this one rule. 0 for a conversation with no compaction. */
export function compactionMessageEnd(sections: readonly Section[]): number {
  if (sections.length === 0 || sectionCompactionTag(sections[0]) === null) return 0
  const firstReply = sections.findIndex((section, index) => index > 0 && section.role === 'agent' && !sectionIsEmpty(section))
  return firstReply < 0 ? sections.length : firstReply
}

/** `text`, which starts the text of section `index` of a conversation
 *  (role `role`), for a text that people read: with no tag line when that
 *  section is a compaction section. Any other text comes back as it is. */
export function withoutCompactionTag(text: string, index: number, role: Role): string {
  const tag = index === 0 && role === 'agent' ? readCompactionTag(text) : null
  return tag ? text.slice(tag.textFrom) : text
}
