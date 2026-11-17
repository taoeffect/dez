import * as z from 'zod'
import { MARKER_ATTRIBUTES, escapeMarkerAttribute, markerAttributes, parseJsonAttribute } from '../../utils/markerAttribute'
import { contentPlainText, sectionIsEmpty, sectionPlainText, stripLiveSentinels, textNode } from './content'
import type { ConversationCost } from './conversationCost'
import { findImageReferences, IMAGE_ID_SOURCE, type ImageReference, type LinkedPathRule } from './images'
import { findMediaTags, type MediaTag } from './mediaTags'
import { readShownPictures, shownPicturesText, type ShownPicture } from './shownPictures'
import type { ContentNode, Role, Section } from './types'

// A compaction makes a long conversation small: what a model wrote about
// the work so far takes the place of the old messages. That text is the
// compaction block, at the start of the compaction section: the first
// section of the conversation, an agent section. The notes in the block
// hold the messages of the user that the work needs, word for word: the
// first one, the middle ones that the model kept, and the final one
// (compactionNotes.ts). This module is the one place that writes and
// recognizes the block.
//
// The compaction section is the section of the reply that ran the
// compaction: the block, then the text of that reply, with the id, the
// model, the thinking, and the time of the reply
// (streams/compactedSections.ts). So the reply has one AGENT pill. Every
// reader of the text of a reply reads only the text after the block
// (`sectionTextParts`). Two older layouts still open and send: the
// compaction section, the user sections that held the kept messages of
// the user, then the reply; and the compaction section, then the reply.
//
//   <dez:compaction count="2" last-id="k" dropped="5" pictures="[…]" linked="[…]">
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
//   end of the text of the section. Text after the block is the text of
//   the reply. `compactionBlockLineCount` is the one rule: the editor
//   reads its doc lines with it (view/editor/compactionBlock.ts).
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
//   - `linked`: the linked paths (linkedFiles.ts) that the user gave and
//     that the notes name, as a JSON list of strings. A linked path counts
//     in the block only when this list holds it (`linkedRuleParts`): the
//     compaction moves the messages of the user into the block, and their
//     linked files must still count there. A model cannot write the tag,
//     so it cannot add a path. Absent when there is none; a value that is
//     no list of strings reads as none. The text after the block is text
//     of a model: no linked path counts there.
// - The role of the first section follows its text: `agent` when it starts
//   with a valid tag, else `user`, as the first section of every other
//   conversation (`firstSectionRole`, `contentCompactionBlock`). So a user
//   who deletes the block (a selection that holds it) gets a normal
//   conversation, and an undo brings the compaction section back.
// - Answer text from a model is escaped (`ModelTextEscaper`, toolBlocks.ts),
//   so a model cannot write a tag or an end line.
// - A request sends the notes as one `user` message, with no tag and no
//   end line: the compaction message (`sectionsToStreamMessages`,
//   streams/messages.ts). Both wire formats need a user message first, and
//   only a user message takes image parts. The text after the block goes
//   as the rounds of the reply, as any agent section goes. In the oldest
//   layout, the user sections right after the compaction section go in
//   the compaction message too (`compactionMessageEnd`).
// - A text for people (the chips, Markdown, a preview, the search) shows
//   the notes as `compactionNotesForPeople` (compactionNotes.ts) gives them.

/** The name of the tag, for the escape of model text. */
export const COMPACTION_TAG_NAME = 'dez:compaction'

/** The line that ends a compaction block. */
export const COMPACTION_END_LINE = `</${COMPACTION_TAG_NAME}>`

/** The name of the tag of a message of the user in the notes
 *  (compactionNotes.ts), for the escapes of model text and of that
 *  message. */
export const USER_MESSAGE_TAG_NAME = 'dez:user-message'

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
  /** The linked paths that the user gave and that the notes name (see the
   *  top of this file). Absent when there is none. */
  linked?: string[]
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
 *  notes of the compaction block. It is in the cached prefix of every
 *  request of its conversation: never a date, a running count, or a
 *  random value. It is true for the older layouts too: the notes of the
 *  first layout with message parts hold only the first and the newest
 *  message, and the kept messages of the oldest layout come after the
 *  notes, each after `COMPACTION_USER_MESSAGE_LABEL`, with no fence. */
export const COMPACTION_MESSAGE_INTRO = '[Compaction: this conversation was long, so Dez put the notes below in place of its earlier messages. '
  + 'The notes are what the assistant wrote about the work so far, with the facts that Dez added. '
  + 'Dez kept word for word the messages of the user that the work needs: the first one, the middle ones that still count, and the newest one at the compaction. '
  + 'Each one is in a code fence under its heading in the notes, or after the notes after its label.]'

/** The line before each user section of the compaction message: a message
 *  of the oldest layout, and a message that the user wrote after a reply
 *  with no text. */
export const COMPACTION_USER_MESSAGE_LABEL = '[Message of the user]'

/** The first line of the section of the carried assets of the user, in
 *  the oldest layout: a user section that an older Dez wrote after the
 *  first kept message of the user. Below this line it holds only the image
 *  references and the media tags of the user's messages that the
 *  compaction took out, each on a line of its own, so that their ids still
 *  name them, and a linked file still counts. The line tells the model and
 *  the user what the section is, and it tells the next compaction that the
 *  section is no message of the user (`isCarriedUserAssets`). Dez only
 *  reads it now: the notes hold the assets of the user (compactionNotes.ts).
 *  It is in the cached prefix, as the texts above. */
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
// there. The `dropped`, the `pictures`, and the `linked` are not checked: a
// value that is not the writer's form reads as not known
// (`readCompactionBlock`), as no pictures (`readShownPictures`), and as no
// linked path (`readLinkedPaths`). `oldForm` is true for a tag that ends
// with `/>`.
function tagAttributes(line: string): { count: number, lastId: string | null, dropped: string | undefined, pictures: string | undefined, linked: string | undefined, oldForm: boolean } | null {
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
  return { count, lastId, dropped: attributes.get('dropped'), pictures: attributes.get('pictures'), linked: attributes.get('linked'), oldForm: match[2] === '/' }
}

const linkedPathsSchema = z.array(z.string())

// The paths of a `linked` value; none for no value, and for a value that
// is not the writer's form (a hand edit).
function readLinkedPaths(text: string | undefined): string[] {
  return (text === undefined ? null : parseJsonAttribute(text, linkedPathsSchema)) ?? []
}

/** The text of a tag line: one line, with live sentinels removed from
 *  every value (a label of a picture is text that a user can edit). */
export function compactionTagText({ count, lastId, dropped, pictures, linked }: CompactionTagData): string {
  const attributes: Array<readonly [string, string]> = [['count', String(count)]]
  if (lastId !== null) attributes.push(['last-id', lastId])
  if (dropped !== undefined) attributes.push(['dropped', String(dropped)])
  if (pictures.length > 0) attributes.push(['pictures', shownPicturesText(pictures)])
  if (linked !== undefined && linked.length > 0) attributes.push(['linked', JSON.stringify(linked)])
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
  const linked = readLinkedPaths(attributes.linked)
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
    ...(linked.length > 0 ? { linked } : {}),
    notesFrom,
    notes: text.slice(notesFrom, notesTo),
    to,
    textFrom: Math.min(to + 1, text.length),
  }
}

/** Where the linked paths of a compaction block count: only the paths of
 *  its `linked` list (see the top of this file). */
export function blockLinkedRule(block: Pick<CompactionTagData, 'linked'>): LinkedPathRule {
  return block.linked === undefined ? 'agent' : new Set(block.linked)
}

/** A part of the text of a section whose linked paths (linkedFiles.ts)
 *  count by one rule (`LinkedPathRule`, images.ts). */
export interface LinkedRulePart {
  text: string
  /** The offset of `text` in the text of the section. */
  from: number
  rule: LinkedPathRule
}

// The parts of `text`, which starts with `block`: the block, by the rule of
// its tag, and the text after it (the reply), by the rule of every agent
// section. The line break between them is in no part.
function blockRuleParts(text: string, block: CompactionBlock): LinkedRulePart[] {
  const parts: LinkedRulePart[] = [{ text: text.slice(0, block.to), from: 0, rule: blockLinkedRule(block) }]
  if (block.textFrom < text.length) parts.push({ text: text.slice(block.textFrom), from: block.textFrom, rule: 'agent' })
  return parts
}

/** Where the linked paths of `text` count: `text` is the text of section
 *  `index` of a conversation, whose role is `role`. In the compaction
 *  section, only the paths that its tag lists count in the block, and the
 *  text after the block is the text of a reply. Any other section is one
 *  part, with the rule of its role. The editor gives the text of its doc,
 *  so the block follows the rule of the doc (`firstSectionRole`). */
export function linkedRuleParts(role: Role, text: string, index: number): LinkedRulePart[] {
  const block = index === 0 && role === 'agent' ? readCompactionBlock(text) : null
  return block === null ? [{ text, from: 0, rule: role }] : blockRuleParts(text, block)
}

/** `linkedRuleParts` of the plain text of `section`, section `index` of a
 *  conversation, with the block of its content (`sectionCompactionBlock`). */
export function sectionLinkedRuleParts(section: Section, index: number): LinkedRulePart[] {
  const text = sectionPlainText(section)
  const block = index === 0 ? sectionCompactionBlock(section) : null
  return block === null ? [{ text, from: 0, rule: section.role }] : blockRuleParts(text, block)
}

/** The image references of `parts`, the parts of one text, in order, with
 *  offsets in that text. */
export function partsImageReferences(parts: readonly LinkedRulePart[]): ImageReference[] {
  return parts.flatMap(({ text, from, rule }) => findImageReferences(text, rule)
    .map((reference) => ({ ...reference, from: from + reference.from, to: from + reference.to })))
}

/** The media tags of `parts`, the parts of one text, in order, with offsets
 *  in that text, each one with the rule of its part. A tag is a whole
 *  line, so no tag runs over the end of a block. */
export function partsMediaTags(parts: readonly LinkedRulePart[]): { tag: MediaTag, rule: LinkedPathRule }[] {
  return parts.flatMap(({ text, from, rule }) => findMediaTags(text)
    .map((tag) => ({ tag: { ...tag, from: from + tag.from, to: from + tag.to }, rule })))
}

/** The text of a section, split at the end of its compaction block. */
export interface SectionTextParts {
  /** The block that starts the text; null for none. */
  block: CompactionBlock | null
  /** The text after the block: in the compaction section, the text of the
   *  reply that ran the compaction. The whole text of any other section. */
  text: string
  /** The offset of `text` in the plain text of the section. */
  from: number
}

/** The parts of the plain text of `section`, section `index` of a
 *  conversation (`sectionPlainText`). Every reader of the text of a reply
 *  reads `text`: no tool block, no round, and no asset of a reply is in
 *  the block. */
export function sectionTextParts(section: Section, index: number): SectionTextParts {
  const text = sectionPlainText(section)
  const block = index === 0 ? sectionCompactionBlock(section) : null
  return block === null ? { block, text, from: 0 } : { block, text: text.slice(block.textFrom), from: block.textFrom }
}

/** The sections of `sections` before the text of the reply whose section
 *  is `sections[replyIndex]`, for the requests of that reply: the sections
 *  before it, or, for a reply in the compaction section, that section with
 *  its block only. */
export function sectionsBeforeReply(sections: readonly Section[], replyIndex: number): Section[] {
  const block = replyIndex === 0 && sections.length > 0 ? sectionCompactionBlock(sections[0]) : null
  if (block === null) return sections.slice(0, replyIndex)
  const { id, role } = sections[0]
  return [{ id, role, content: [textNode(sectionPlainText(sections[0]).slice(0, block.to))] }]
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
 *  in the plain text of the content (`contentPlainText`, prompt bodies in
 *  it): a block with no end line runs to the end of the section, as in
 *  the editor doc. Null when there is none. The role of the section is
 *  not read. */
export function contentCompactionBlock(content: readonly ContentNode[]): CompactionBlock | null {
  const first = content[0]
  if (first?.kind !== 'text') return null
  // The doc line of the tag goes on into the node after a text with no
  // line break, and that node is a prompt pill.
  if (first.text.indexOf('\n') < 0 && content.length > 1) return null
  return readCompactionBlock(contentPlainText(content))
}

/** The block of `section` when it is a compaction section: an agent
 *  section that starts with a valid tag. Only the first section of a
 *  conversation can be one; the caller gives no other section. Null when
 *  it is none. */
export function sectionCompactionBlock(section: Section): CompactionBlock | null {
  return section.role === 'agent' ? contentCompactionBlock(section.content) : null
}

/** The index after the last section of the compaction message of
 *  `sections`, a conversation: the compaction section, and the user
 *  sections right after it up to the first later agent section that is not
 *  empty. The text of a reply after the block ends the message at the
 *  compaction section: the reply that ran the compaction wrote it there.
 *  So only a reply with no text (a stop, an error) lets a later message of
 *  the user join the compaction message, as in the old layouts, whose
 *  replies were sections of their own. The request
 *  (`sectionsToStreamMessages`, streams/messages.ts) and the compaction
 *  read this one rule. 0 for a conversation with no compaction. */
export function compactionMessageEnd(sections: readonly Section[]): number {
  if (sections.length === 0) return 0
  const { block, text } = sectionTextParts(sections[0], 0)
  if (block === null) return 0
  if (text.trim() !== '') return 1
  const firstReply = sections.findIndex((section, index) => index > 0 && section.role === 'agent' && !sectionIsEmpty(section))
  return firstReply < 0 ? sections.length : firstReply
}
