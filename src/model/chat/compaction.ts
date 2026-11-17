import { MARKER_ATTRIBUTES, escapeMarkerAttribute, markerAttributes } from '../../utils/markerAttribute'
import { sectionIsEmpty, stripLiveSentinels } from './content'
import type { ConversationCost } from './conversationCost'
import { IMAGE_ID_SOURCE } from './images'
import { readShownPictures, shownPicturesText, type ShownPicture } from './shownPictures'
import type { ContentNode, Role, Section } from './types'

// A compaction makes a long conversation small: what a model wrote about
// the work so far takes the place of the old messages. That text is the
// compaction section: the first section of the conversation, an agent
// section that starts with the compaction block. The user messages that
// the compaction kept come right after it. This module is the one place
// that writes and recognizes the block.
//
//   <dez:compaction count="2" last-id="k" dropped="5" pictures="[…]">
//   (the notes: compactionNotes.ts)
//   </dez:compaction>
//
// - The tag is one whole line, and it counts only as the first line of the
//   first section of a conversation, at the start of the section's first
//   text node. At any other place the same text is plain text. A tag with
//   no valid `count`, or with a `last-id` that is no id, is plain text too,
//   so the user sees that it is not valid.
// - The end line is one whole line. The block runs from the tag line to
//   the first end line after it. With no end line, the block runs to the
//   end of the text of the section. Text after the block is normal text of
//   the section. `compactionBlockLineCount` is the one rule: the editor
//   reads its doc lines with it (view/editor/compaction.ts).
// - The old form: an older Dez wrote a tag that ends with `/>`, and no end
//   line. Its notes run to the end of the text of the section. Saved
//   conversations keep this form, and Dez does not change their text: this
//   rule is the one place that reads it.
// - Attributes (the grammar of markerAttribute.ts), written in this order:
//   - `count`: the number of this compaction in its conversation, from 1.
//   - `last-id`: the highest id that the conversation ever gave to an image
//     or a clip. A compaction removes assets, and the kept text can still
//     name their ids (`@c`), so the id sequence counts this id too
//     (mediaIds.ts): the id of a removed asset is never given to a new one.
//     Absent when the conversation gave no id.
//   - `dropped`: how many images and clips this compaction took out of the
//     conversation (0 or more), for the assets chip of the compaction.
//     Absent in a tag of an older Dez, which did not count them. A value
//     that is no count reads as absent: the tag stays valid.
//   - `pictures`: the pictures that the compaction kept for the model (a
//     frame sheet of a clip, a wave), as their saved copies, in the form of
//     the `pictures` attribute of a tool block (shownPictures.ts). Absent
//     when there is none.
// - The role of the first section follows its text: `agent` when it starts
//   with a valid tag, else `user`, as the first section of every other
//   conversation (`firstSectionRole`, `contentCompactionBlock`). So a user
//   who deletes the block gets a normal conversation, and an undo brings
//   the compaction section back.
// - Answer text from a model is escaped (`ModelTextEscaper`, toolBlocks.ts),
//   so a model cannot write a tag or an end line.
// - A request sends the notes, the text after the block, and the user
//   sections right after it as one `user` message, with no tag and no end
//   line: the compaction message (`sectionsToStreamMessages`,
//   streams/messages.ts). Both wire formats need a user message first, and
//   only a user message takes image parts.
// - A text for people (the chips, Markdown, a preview, the search) shows
//   the notes as `compactionNotesForPeople` (compactionNotes.ts) gives them.

/** The name of the tag, for the escape of model text. */
export const COMPACTION_TAG_NAME = 'dez:compaction'

/** The line that ends a compaction block. */
export const COMPACTION_END_LINE = `</${COMPACTION_TAG_NAME}>`

/** What a compaction tag holds. */
export interface CompactionTagData {
  /** The number of this compaction in its conversation: 1 or more. */
  count: number
  /** The highest id that the conversation ever gave to an image or a clip;
   *  null when it gave none. */
  lastId: string | null
  /** How many images and clips this compaction took out of the
   *  conversation. Absent when not known: a tag of an older Dez. */
  dropped?: number
  /** The pictures that the compaction kept for the model, in the order in
   *  which a request sends them. */
  pictures: ShownPicture[]
}

/** The compaction block at the start of a text. */
export interface CompactionBlock extends CompactionTagData {
  /** The offset of the notes: after the line break of the tag line, or the
   *  end of a text that is only the tag line. */
  notesFrom: number
  /** The notes: the lines between the tag line and the end line. */
  notes: string
  /** The offset after the end line; the end of the text for a block with
   *  no end line. */
  to: number
  /** The offset of the text after the block: after the line break that
   *  follows the end line, or the end of the text. */
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
// line break. The first group holds the attributes; the second is `/` for a
// tag of the old form.
const TAG_LINE = new RegExp(String.raw`^${TAG_START}(${MARKER_ATTRIBUTES})(\/?)>$`)
const COUNT = /^[1-9]\d*$/
const DROPPED = /^(?:0|[1-9]\d*)$/
const ASSET_ID = new RegExp(`^${IMAGE_ID_SOURCE}$`)

/** The line of `text` that starts at offset 0, with no line break. */
export function firstLine(text: string): string {
  const end = text.indexOf('\n')
  return end < 0 ? text : text.slice(0, end)
}

// The attributes of the tag that is the whole of `line`; null when the
// line is not a valid tag. An empty `last-id` reads as one that is not
// there. The `dropped` and the `pictures` are not checked: a value that is
// not the writer's form reads as not known (`readCompactionBlock`) and as
// no pictures (`readShownPictures`). `oldForm` is true for a tag that ends
// with `/>`.
function tagAttributes(line: string): { count: number, lastId: string | null, dropped: string | undefined, pictures: string | undefined, oldForm: boolean } | null {
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
  return { count, lastId, dropped: attributes.get('dropped'), pictures: attributes.get('pictures'), oldForm: match[2] === '/' }
}

/** The text of a tag line: one line, with live sentinels removed from
 *  every value (a label of a picture is text that a user can edit). */
export function compactionTagText({ count, lastId, dropped, pictures }: CompactionTagData): string {
  const attributes: Array<readonly [string, string]> = [['count', String(count)]]
  if (lastId !== null) attributes.push(['last-id', lastId])
  if (dropped !== undefined) attributes.push(['dropped', String(dropped)])
  if (pictures.length > 0) attributes.push(['pictures', shownPicturesText(pictures)])
  return `${TAG_START}${attributes.map(([name, value]) => ` ${name}="${escapeMarkerAttribute(stripLiveSentinels(value))}"`).join('')}>`
}

/** The text of a whole block: the tag line, the lines of `notes`, and the
 *  end line. The notes must hold no end line: Dez writes the text of a
 *  model in them with its escape (`escapedModelText`). */
export function compactionBlockText(data: CompactionTagData, notes: string): string {
  return notes === '' ? `${compactionTagText(data)}\n${COMPACTION_END_LINE}` : `${compactionTagText(data)}\n${notes}\n${COMPACTION_END_LINE}`
}

/** How many of `lines` (the lines of a text, from its first line) the
 *  compaction block takes; 0 when the first line is no valid tag. The
 *  block takes the lines up to the first end line after the tag line, or
 *  every line when there is no end line, or when the tag is of the old
 *  form. The one rule of the model (`readCompactionBlock`) and of the
 *  editor, which gives the lines of the first section of its doc. */
export function compactionBlockLineCount(lines: Iterable<string>): number {
  let count = 0
  let oldForm = false
  for (const line of lines) {
    count++
    if (count === 1) {
      const attributes = tagAttributes(line)
      if (!attributes) return 0
      oldForm = attributes.oldForm
    } else if (!oldForm && line === COMPACTION_END_LINE) {
      return count
    }
  }
  return count
}

// The lines of `text`, in order, with no line breaks.
function* linesOf(text: string): Generator<string> {
  let from = 0
  for (let end = text.indexOf('\n'); end >= 0; end = text.indexOf('\n', from)) {
    yield text.slice(from, end)
    from = end + 1
  }
  yield text.slice(from)
}

// The offset of the end of line `line` (from 1) of `text`, before its line
// break.
function lineEnd(text: string, line: number): number {
  let end = -1
  for (let index = 0; index < line; index++) {
    end = text.indexOf('\n', end + 1)
    if (end < 0) return text.length
  }
  return end
}

/** The block that starts `text`; null when its first line is not a valid
 *  tag. The caller decides whether the text is one that a block counts in
 *  (the first section of a conversation). */
export function readCompactionBlock(text: string): CompactionBlock | null {
  const lineCount = compactionBlockLineCount(linesOf(text))
  if (lineCount === 0) return null
  const line = firstLine(text)
  const attributes = tagAttributes(line)!
  const droppedNumber = attributes.dropped !== undefined && DROPPED.test(attributes.dropped) ? Number(attributes.dropped) : NaN
  const notesFrom = Math.min(line.length + 1, text.length)
  const to = lineEnd(text, lineCount)
  const lastLineFrom = lineCount === 1 ? 0 : text.lastIndexOf('\n', to - 1) + 1
  const hasEndLine = !attributes.oldForm && lineCount > 1 && text.slice(lastLineFrom, to) === COMPACTION_END_LINE
  // The notes end before the line break of the end line; a block of only a
  // tag line and an end line has no notes.
  const notesTo = hasEndLine ? Math.max(notesFrom, lastLineFrom - 1) : to
  return {
    count: attributes.count,
    lastId: attributes.lastId,
    ...(Number.isSafeInteger(droppedNumber) ? { dropped: droppedNumber } : {}),
    pictures: attributes.pictures === undefined ? [] : readShownPictures(attributes.pictures),
    notesFrom,
    notes: text.slice(notesFrom, notesTo),
    to,
    textFrom: Math.min(to + 1, text.length),
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

/** The block at the start of the content of a section, by the rule of the
 *  editor doc (`firstSectionRole`): the first node is a text that starts
 *  with the tag line, and no prompt pill is on that line. Its offsets are
 *  in the plain text of the content (prompt bodies in it, as
 *  `sectionPlainText`): a block with no end line runs to the end of the
 *  section, as in the editor doc. Null when there is none. The role of the
 *  section is not read. */
export function contentCompactionBlock(content: readonly ContentNode[]): CompactionBlock | null {
  const first = content[0]
  if (first?.kind !== 'text') return null
  // The doc line of the tag goes on into the node after a text with no
  // line break, and that node is a prompt pill.
  if (first.text.indexOf('\n') < 0 && content.length > 1) return null
  return readCompactionBlock(content.map((node) => (node.kind === 'text' ? node.text : node.body)).join(''))
}

/** The block of `section` when it is a compaction section: an agent
 *  section that starts with a valid tag. Only the first section of a
 *  conversation can be one; the caller gives no other section. Null when
 *  it is none. */
export function sectionCompactionBlock(section: Section): CompactionBlock | null {
  return section.role === 'agent' ? contentCompactionBlock(section.content) : null
}

/** The index after the last section of the compaction message of
 *  `sections`, a conversation (or its sections that are not empty, for a
 *  request): the compaction section and the user sections right after it,
 *  up to the first later agent section that is not empty. The request
 *  (`sectionsToStreamMessages`, streams/messages.ts) and the compaction
 *  read this one rule. 0 for a conversation with no compaction. */
export function compactionMessageEnd(sections: readonly Section[]): number {
  if (sections.length === 0 || sectionCompactionBlock(sections[0]) === null) return 0
  const firstReply = sections.findIndex((section, index) => index > 0 && section.role === 'agent' && !sectionIsEmpty(section))
  return firstReply < 0 ? sections.length : firstReply
}
