import { oneLineCut } from '../../utils/oneLineCut'
import { appTagLabel } from '../chat/appTags'
import { assetTextPieces } from '../chat/assetMentions'
import type { AssetPlace } from '../chat/assetOrigins'
import { blockLinkedRule, compactionMessageEnd, isCarriedUserAssets, sectionCompactionBlock, sectionTextParts } from '../chat/compaction'
import { notesAssetLines, notesCellText, notesFinalReply, notesMessages, withAssetLabels, type NotesAssetLine } from '../chat/compactionNotes'
import { sectionIsEmpty, sectionPlainText } from '../chat/content'
import { findHiddenAssets } from '../chat/hiddenAssets'
import { findAssetMentions } from '../chat/imageMentions'
import { findImageReferences, IMAGE_HIDDEN_KEY, IMAGE_LABEL, type LinkedPathRule } from '../chat/images'
import { MEDIA_HIDDEN_ATTRIBUTE } from '../chat/mediaTags'
import { withoutStoredFilePaths } from '../chat/storedFilePaths'
import { findToolBlocks, unescapedModelText, withoutToolBlocks } from '../chat/toolBlocks'
import type { Section } from '../chat/types'
import { assetOriginText } from '../tools/assetInfo'
import { ASSET_NAMES, isOpenJob, type JobAssetKind, type JobInfo } from '../tools/jobs'
import { MAX_ASSET_SENTENCE_LENGTH, type AssetDecision, type CompactionAnswer } from './compactionRequest'
import { foundAssetFrom, type FoundAsset } from './mediaRequest'
import { messageMentionIds, withoutAssetLines } from './messages'

// The images and the clips of a conversation at a compaction: what Dez
// tells the model about each one in the compaction request (the asset
// table), and what the compaction does with each one. The model decides
// (`show`, `keep`, `drop`; compactionRequest.ts) what the work at hand
// needs, and the rest leaves the conversation. Dez holds only the rules
// that keep work that is still in use: a fault of the model, or of the
// reader of its answer, must never remove an asset of the user, or an
// asset that a later step needs. This module also tells which messages of
// the user the notes keep word for word (`compactionScope`,
// `keptMiddleMessages`), with the same rule for the words of the user, and
// the reply right before the final one (`CompactionScope.finalReply`).
// All pure; controller/compaction.ts reads the files.

/** A message of the user that a compaction can keep word for word: a
 *  user section, or a user part of the notes of the compaction before
 *  (`notesMessages`, chat/compactionNotes.ts). */
export interface KeptMessage {
  /** The index of its section. */
  section: number
  /** Its text: the plain text of a user section (`sectionPlainText`), or
   *  the text of a message part. */
  text: string
  /** Where it is in the plain text of its section: the whole text of a
   *  user section, or the text of a part with its escape. */
  from: number
  to: number
  /** Where the linked paths of `text` count (`LinkedPathRule`): `'user'`
   *  for a user section, the rule of the block for a part. */
  rule: LinkedPathRule
}

/** Which sections a compaction replaces, as indexes of the sections of
 *  the conversation, and which messages of the user it can keep. */
export interface CompactionScope {
  /** The section of the reply that runs; null when no section has its id,
   *  and the compaction then replaces the whole conversation. */
  reply: number | null
  /** The index after the last section that the compaction replaces: the
   *  one after the reply's section, or the count of the sections. The
   *  sections from here on stay as they are. */
  end: number
  /** The first message of the user, which stays word for word; null for a
   *  conversation with none. */
  first: KeptMessage | null
  /** The messages of the user between `first` and `last`, oldest first:
   *  the model keeps or drops each one (`keptMiddleMessages`). */
  middle: KeptMessage[]
  /** The final message of the user, which stays word for word: the one
   *  that the reply answers. Null when it is `first`, or there is none. */
  last: KeptMessage | null
  /** The reply of the assistant right before `last`, as the user saw it
   *  (`finalReplyText`), with no escape of model text; null with no
   *  `last`, with no such reply, or for a reply with no text. The notes
   *  keep it word for word before `last`, so that a short answer of the
   *  user ("yes, but …") still has the text that it answers. */
  finalReply: string | null
}

/** The scope of a compaction of `sections` in the reply whose section has
 *  the id `replySectionId`: at a submit, the empty section of the new
 *  reply. With an id of no section, the scope is the whole conversation.
 *
 *  A message of the user is a user section before the reply's section
 *  that is not empty, and that is not the section of the carried assets of
 *  the user that an older Dez wrote (`isCarriedUserAssets`, which counts
 *  only in the compaction message), or a message part of the notes of the
 *  compaction before. The parts are read by their place: the first one is
 *  the first message; of two or more, the last one is the final message,
 *  and the ones between them are middle messages. A user section came
 *  after the parts, so with one, the final part is a middle message now.
 *
 *  The final reply is the reply part of the notes before while their
 *  final part stays the final message. Else it is the first section
 *  before the final message that is not empty, when that is an agent
 *  section: a message of the user there means no reply. */
export function compactionScope(sections: readonly Section[], replySectionId: string): CompactionScope {
  const found = sections.findIndex((section) => section.id === replySectionId)
  const reply = found < 0 ? null : found
  const messagesEnd = reply ?? sections.length
  const carriedEnd = compactionMessageEnd(sections)
  const isMessage = (section: Section, index: number) => index < messagesEnd
    && section.role === 'user'
    && !sectionIsEmpty(section)
    && !(index < carriedEnd && isCarriedUserAssets(sectionPlainText(section)))
  const userSections = sections.flatMap((section, index): KeptMessage[] => {
    if (!isMessage(section, index)) return []
    const text = sectionPlainText(section)
    return [{ section: index, text, from: 0, to: text.length, rule: 'user' }]
  })
  // The message parts are in the block. The compaction section can be the
  // reply's section, but the block comes before the text of the reply, so
  // the parts are always before the reply.
  const block = sections.length > 0 ? sectionCompactionBlock(sections[0]) : null
  const parts: KeptMessage[] = block === null
    ? []
    : notesMessages(block.notes).map((part) => ({ section: 0, text: part.text, from: block.notesFrom + part.from, to: block.notesFrom + part.to, rule: blockLinkedRule(block) }))
  const messages = [...parts, ...userSections]
  // With no user section, the final part stays the final message.
  const last = messages.length > 1 ? messages[messages.length - 1] : null
  let finalReply: string | null = null
  if (last !== null && userSections.length === 0) finalReply = block === null ? null : notesFinalReply(block.notes)
  if (last !== null && userSections.length > 0) finalReply = replyBefore(sections, last.section)
  return {
    reply,
    end: reply === null ? sections.length : reply + 1,
    first: messages[0] ?? null,
    middle: messages.slice(1, -1),
    last,
    finalReply,
  }
}

// The text of the reply right before the user section `index`
// (`finalReplyText`): the first section before it that is not empty, when
// that is an agent section; null for none.
function replyBefore(sections: readonly Section[], index: number): string | null {
  let at = index - 1
  while (at >= 0 && sectionIsEmpty(sections[at])) at--
  return at >= 0 && sections[at].role === 'agent' ? finalReplyText(sections, at) : null
}

/** The text of the reply of section `index` of `sections` as the user saw
 *  it, for the final message pair of the notes: with no escape of model
 *  text, and null for a reply that showed no text. In the compaction
 *  section, the reply is its text after the block.
 *
 *  1. The hidden assets go, each with the line breaks around it: the user
 *     did not see them, and a mention of them would keep them.
 *  2. The tool blocks go, as the chips are no words of the reply.
 *  3. Each other image reference and media tag becomes its `@id` mention
 *     (an image with no id its label `[image]`), and each app tag its
 *     label `[app <name>]`. In the notes, a reference would count as an
 *     asset of the block, and a linked path that a model wrote must never
 *     count. The pieces are read with the rule of the user, where each
 *     linked path counts, so no reference stays that the rule of a block
 *     could take. Markdown code stays as it is: code is text.
 *
 *  The rule of the user does not end code at a `<dez:` line, as the rule
 *  of a reply does. So a tag of Dez after a fence that the reply left open
 *  stays as text, and the notes quote it in code. */
function finalReplyText(sections: readonly Section[], index: number): string | null {
  const chipSections = sections.slice(0, index + 1).map((section, at) => {
    const { text } = sectionTextParts(section, at)
    return { role: section.role, text, blocks: section.role === 'agent' ? findToolBlocks(text) : [] }
  })
  const text = withoutToolBlocks(withoutAssetLines(chipSections[index].text, findHiddenAssets(chipSections)[index]))
  const shown = assetTextPieces(text, 'user').map((piece) => {
    switch (piece.kind) {
      case 'media': return `@${piece.tag.id}`
      case 'app': return appTagLabel(piece.tag.name)
      case 'codeTag': return text.slice(piece.tag.from, piece.tag.to)
      case 'reference': {
        const id = findImageReferences(text.slice(piece.from, piece.to), 'user')[0]?.id ?? null
        return id === null ? IMAGE_LABEL : `@${id}`
      }
      default: return text.slice(piece.from, piece.to)
    }
  }).join('')
  // Blank lines at the two ends go; the spaces of the first line stay, as
  // they can make it a line of code.
  const trimmed = shown.replace(/^(?:[^\S\n]*\n)+/, '').trimEnd()
  return trimmed === '' ? null : unescapedModelText(trimmed)
}

/** The middle messages of `scope` that the notes keep word for word: each
 *  one that no `drop` line of `answer` names. A fault of the model, or of
 *  the reader of its answer, must never remove the words of the user, so
 *  a message with no line, and every message of an answer with no line,
 *  stays. */
export function keptMiddleMessages(scope: CompactionScope, answer: CompactionAnswer): KeptMessage[] {
  const dropped = new Set(answer.messages.filter((line) => line.decision === 'drop').map((line) => line.number))
  return scope.middle.filter((_, index) => !dropped.has(index + 1))
}

/** The messages of the user that the notes quote word for word, in their
 *  order: the first one, the middle ones that `answer` keeps
 *  (`keptMiddleMessages`), and the final one. */
export function quotedMessages(scope: CompactionScope, answer: CompactionAnswer): KeptMessage[] {
  return [scope.first, ...keptMiddleMessages(scope, answer), scope.last].filter((message) => message !== null)
}

// The most characters of the start of a middle message in the instruction.
const MESSAGE_START_LENGTH = 160

/** The start of each middle message of `scope`, in order, as the list of
 *  the instruction shows it (`CompactionInstruction.middleMessages`): on
 *  one line, and each image reference, clip tag, and app tag as its label
 *  (`withAssetLabels`), as the notes for people show them.
 *
 *  The path scrub runs before the cut: it finds a path by its end, so it
 *  would not see the part of a path before a cut, and the provider would
 *  get the user's name and folders. */
export function middleMessageStarts(scope: CompactionScope): string[] {
  return scope.middle.map(({ text, rule }) => oneLineCut(withoutStoredFilePaths(withAssetLabels(text, rule)), MESSAGE_START_LENGTH))
}

/** The asset lines of the notes of the compaction section of `sections`,
 *  by asset id; none for a conversation with no compaction. */
export function carriedAssetLines(sections: readonly Section[]): Map<string, NotesAssetLine> {
  const block = sections.length > 0 ? sectionCompactionBlock(sections[0]) : null
  return block ? notesAssetLines(block.notes) : new Map()
}

/** One image or clip of a conversation at a compaction. */
export interface CompactionAsset {
  asset: FoundAsset
  kind: JobAssetKind
  /** The facts of its file, as the notes hold them (`notesCellText`). */
  facts: string
  /** Who made it, as the notes hold it: `assetOriginText`, as a cell of
   *  the notes (`notesCellText`). */
  origin: string
  /** The user gave it (`assetPlaces`): it is in a user section, in a
   *  message part of the notes, or its line in the notes tells so. */
  fromUser: boolean
  /** A call made it as a part of its work (the `hidden` mark). */
  intermediate: boolean
  /** The reply that runs made it: its text is in the text of the reply,
   *  or of a reply that the user cut before it (they share their jobs:
   *  `CompactionAssetsInput.replySections`), after the block in the
   *  compaction section (`sectionTextParts`). Or the notes of a compaction
   *  earlier in this work tell it (`NotesAssetLine.byReply`,
   *  `replyRanAtCompaction`). */
  byReply: boolean
  /** An open job of the reply that runs takes it as an input
   *  (`openJobInputs`). */
  jobInput: boolean
  /** A file of an app of the conversation names it with `@id`
   *  (`CompactionAssetsInput.appInputs`). */
  appInput: boolean
  /** What the model wrote about it at the compaction before this one;
   *  blank for none. */
  sentence: string
}

function isIntermediate(asset: FoundAsset): boolean {
  return asset.kind === 'image'
    ? asset.reference.metadata.some((item) => item.key === IMAGE_HIDDEN_KEY)
    : asset.tag.other.some((attribute) => attribute.name === MEDIA_HIDDEN_ATTRIBUTE)
}

// Whether one of the replies `replySections` (the reply that runs and the
// replies that the user cut before it) is the one that ran at the
// compaction of the notes of `sections`: a compaction makes the reply's
// section the compaction section (compactedSections.ts). A section of an
// older layout after the block is never the section of a reply that runs:
// a reply that runs in a conversation of an older Dez is a new one.
function replyRanAtCompaction(sections: readonly Section[], replySections: ReadonlySet<string>): boolean {
  return sections.length > 0 && replySections.has(sections[0].id) && sectionCompactionBlock(sections[0]) !== null
}

/** What `compactionAssets` needs. */
export interface CompactionAssetsInput {
  sections: readonly Section[]
  scope: CompactionScope
  /** The assets of the sections that the compaction replaces
   *  (`conversationAssets`, with a section before `scope.end`). */
  found: readonly FoundAsset[]
  /** The places of `found` (`assetPlaces`), in the same order. */
  places: readonly AssetPlace[]
  /** The facts text of the file of each asset by its id
   *  (`imageFactsText`, `clipFactsText`, or the text of a file that Dez
   *  could not read). An asset with a line in the notes of the compaction
   *  before needs none: its line tells its facts. */
  facts: ReadonlyMap<string, string>
  /** The inputs of the open jobs of the reply (`openJobInputs`). */
  jobInputs: ReadonlyMap<string, readonly string[]>
  /** The ids that the files of the apps of the conversation name with
   *  `@id` (`appFileMentions`, compactionApps.ts). An id of no asset of
   *  `found` counts for nothing. */
  appInputs: ReadonlySet<string>
  /** The ids of the agent sections of the replies that took the jobs of
   *  the reply that runs (`TabJobs.replySections`, controller/jobs.ts):
   *  the replies that the user cut before it (a stop, a new submit, a
   *  delete of their running blocks), and the reply that runs. Their work
   *  counts as the work of the reply that runs. */
  replySections: readonly string[]
}

/** The assets of a compaction, in the order of `input.found`. */
export function compactionAssets({ sections, scope, found, places, facts, jobInputs, appInputs, replySections }: CompactionAssetsInput): CompactionAsset[] {
  const carried = carriedAssetLines(sections)
  const replyIds = new Set(replySections)
  if (scope.reply !== null) replyIds.add(sections[scope.reply].id)
  const sameReply = replyRanAtCompaction(sections, replyIds)
  const inputs = new Set([...jobInputs.values()].flat())
  // Where the text of a reply starts in each section of `replyIds`: after
  // the block, in the compaction section.
  const replyFrom = new Map<number, number>()
  sections.forEach((section, index) => {
    if (section.role === 'agent' && replyIds.has(section.id)) replyFrom.set(index, sectionTextParts(section, index).from)
  })
  return found.map((asset, index): CompactionAsset => {
    const line = carried.get(asset.id)
    const from = replyFrom.get(asset.section)
    return {
      asset,
      kind: asset.kind === 'image' ? 'image' : asset.clip.kind,
      facts: line?.facts ?? notesCellText(facts.get(asset.id) ?? ''),
      origin: notesCellText(assetOriginText(places[index].origin)),
      fromUser: places[index].origin.kind === 'user',
      intermediate: isIntermediate(asset),
      byReply: (from !== undefined && foundAssetFrom(asset) >= from) || (sameReply && line?.byReply === true),
      jobInput: inputs.has(asset.id),
      appInput: appInputs.has(asset.id),
      sentence: line?.sentence ?? '',
    }
  })
}

/** The table of the assets in a compaction request: a first line that
 *  names the columns, then one line for each asset. */
export function assetTableText(assets: readonly CompactionAsset[]): string {
  if (assets.length === 0) return 'The conversation has no image and no clip, so your answer needs no line under the Assets heading.'
  const head = 'The images and the clips of the conversation (id | kind | facts | who made it | from the user or made | intermediate or - | this reply or earlier | open job or - | app file or -). '
    + 'intermediate: a call made it as a part of its work, and the user sees it only in the panel of that call. '
    + 'this reply: the reply that you work on now made it; earlier: an earlier reply made it; - for an asset of the user. '
    + 'open job: a job that still runs, or whose result you did not get yet, takes it as an input. '
    + 'app file: a file of an app of the conversation names it with @id.'
  const rows = assets.map(({ asset, kind, facts, origin, fromUser, intermediate, byReply, jobInput, appInput }) => [
    `@${asset.id}`,
    ASSET_NAMES[kind],
    facts,
    origin,
    fromUser ? 'user' : 'made',
    intermediate ? 'intermediate' : '-',
    fromUser ? '-' : byReply ? 'this reply' : 'earlier',
    jobInput ? 'open job' : '-',
    appInput ? 'app file' : '-',
  ].join(' | '))
  return [head, ...rows].join('\n')
}

/** The inputs of the open jobs of the reply that runs (`isOpenJob`). By
 *  job id, the ids of its inputs in order (`JobInfo.inputs`). Each job
 *  keeps them from its start, so a job that a cut reply started, whose
 *  block is in an earlier section or gone in an earlier compaction, keeps
 *  them too. */
export function openJobInputs(jobs: readonly JobInfo[]): Map<string, readonly string[]> {
  return new Map(jobs.filter(isOpenJob).map((job) => [job.id, job.inputs]))
}

/** What a compaction does with one asset. */
export interface AssetChoice {
  asset: CompactionAsset
  decision: AssetDecision
  /** What the notes tell about it: one line of at most
   *  `MAX_ASSET_SENTENCE_LENGTH` characters; blank for none. */
  sentence: string
  /** The place of its line in the answer, from 0: the order in which the
   *  `show` assets get their pictures. Infinity for an asset with no line. */
  rank: number
}

/** The texts that stay word for word after a compaction of `scope` with
 *  `answer`: the messages of the user that the notes quote
 *  (`quotedMessages`), the reply of the final message pair
 *  (`CompactionScope.finalReply`), and each user section after the
 *  sections that the compaction replaces. An `@id` mention of them must
 *  still name its asset (`assetDecisions`). */
export function keptTexts(sections: readonly Section[], scope: CompactionScope, answer: CompactionAnswer): string[] {
  return [
    ...quotedMessages(scope, answer).map((message) => message.text),
    ...(scope.finalReply === null ? [] : [scope.finalReply]),
    ...sections.slice(scope.end).filter((section) => section.role === 'user').map(sectionPlainText),
  ]
}

/** The label of the picture of a clip that a compaction keeps for its
 *  model: the text that goes right before the picture in the requests.
 *  `shows` tells what the picture shows (`ViewPicture.shows`,
 *  tools/assetView.ts): a text with a small first letter and no period. */
export function clipPictureLabel(shows: string): string {
  return `${shows.charAt(0).toUpperCase()}${shows.slice(1)}.`
}

/** What the compaction does with each asset of `assets`, in their order,
 *  from the answer of the model. The model judges what the work at hand
 *  needs; Dez guards only against its faults.
 *
 *  - An asset that the answer has no line for is kept when the reply that
 *    runs made it (the model forgot its line), and dropped when an earlier
 *    reply made it. When no line of the answer names an asset of `assets`,
 *    each one is kept: a broken answer must not remove work, and a
 *    compaction cannot be undone.
 *  - A `drop` reads as `keep` for an asset that work can still need: an
 *    asset of the user; an input of an open job (`jobInput`); an asset
 *    that a file of an app of the conversation names (`appInput`); and an
 *    asset that a text names which stays, the notes of the answer or a
 *    text that the notes quote or that stays after them (`keptTexts`).
 *  - Any other line counts as it is: the model can drop an asset of the
 *    reply that runs. */
export function assetDecisions(
  assets: readonly CompactionAsset[],
  answer: CompactionAnswer,
  { keptTexts: texts }: { keptTexts: readonly string[] },
): AssetChoice[] {
  const named = new Set(findAssetMentions(answer.requirements).map((mention) => mention.id))
  for (const text of texts) {
    for (const id of messageMentionIds(text)) named.add(id)
  }
  const lines = new Map(answer.assets.map((line, index) => [line.id, { line, index }]))
  const answered = assets.some(({ asset }) => lines.has(asset.id))
  return assets.map((asset): AssetChoice => {
    const { id } = asset.asset
    const found = lines.get(id)
    const guarded = asset.fromUser || asset.jobInput || asset.appInput || named.has(id)
    const decision = found?.line.decision ?? (!answered || guarded || asset.byReply ? 'keep' : 'drop')
    return {
      asset,
      decision: decision === 'drop' && guarded ? 'keep' : decision,
      sentence: oneLineCut(found !== undefined && found.line.sentence !== '' ? found.line.sentence : asset.sentence, MAX_ASSET_SENTENCE_LENGTH),
      rank: found?.index ?? Infinity,
    }
  })
}
