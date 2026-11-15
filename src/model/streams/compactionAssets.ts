import { assetTextPieces } from '../chat/assetMentions'
import type { AssetPlace } from '../chat/assetOrigins'
import { compactionMessageEnd, isCarriedUserAssets, sectionCompactionTag } from '../chat/compaction'
import { notesAssetLines, notesFactsText, type NotesAssetLine } from '../chat/compactionNotes'
import { sectionIsEmpty, sectionPlainText } from '../chat/content'
import { findAssetMentions } from '../chat/imageMentions'
import { IMAGE_HIDDEN_KEY } from '../chat/images'
import { MEDIA_HIDDEN_ATTRIBUTE } from '../chat/mediaTags'
import { withoutStoredFilePaths } from '../chat/storedFilePaths'
import { findToolBlocks } from '../chat/toolBlocks'
import type { Section } from '../chat/types'
import { assetOriginText } from '../tools/assetInfo'
import { ASSET_NAMES, startedJob, type JobAssetKind, type JobInfo } from '../tools/jobs'
import { MAX_ASSET_SENTENCE_LENGTH, type AssetDecision, type CompactionAnswer } from './compactionRequest'
import type { FoundAsset } from './mediaRequest'

// The images and the clips of a conversation at a compaction: what Dez
// tells the model about each one in the compaction request (the asset
// table), and what the compaction does with each one. The model decides
// (`show`, `keep`, `drop`; compactionRequest.ts), but Dez holds the rules
// that keep work that is still in use: a fault of the model, or of the
// reader of its answer, must never remove an asset that a later step
// needs. All pure; controller/compaction.ts reads the files.

/** Which sections a compaction replaces, as indexes of the sections of
 *  the conversation. */
export interface CompactionScope {
  /** The section of the reply that runs; null for a conversation with no
   *  such section, which the compaction then replaces whole. */
  reply: number | null
  /** The index after the last section that the compaction replaces: the
   *  one after the reply's section, or the count of the sections. The
   *  sections from here on stay as they are. */
  end: number
  /** The first message of the user, which stays word for word; null for a
   *  conversation with none. */
  first: number | null
  /** The newest message of the user, which stays word for word: the one
   *  that the reply answers. Null when it is `first`, or there is none. */
  last: number | null
}

/** The scope of a compaction of `sections` in the reply whose section has
 *  the id `replySectionId`: at a submit, the empty section of the new
 *  reply. With null, or an id of no section, the scope is the whole
 *  conversation.
 *
 *  A message of the user is a user section before the reply's section
 *  that is not empty, and that is not the section of the carried assets of
 *  the user that an earlier compaction wrote (`isCarriedUserAssets`, which
 *  counts only in the compaction message). */
export function compactionScope(sections: readonly Section[], replySectionId: string | null): CompactionScope {
  const found = replySectionId === null ? -1 : sections.findIndex((section) => section.id === replySectionId)
  const reply = found < 0 ? null : found
  const messagesEnd = reply ?? sections.length
  const carriedEnd = compactionMessageEnd(sections)
  const isMessage = (section: Section, index: number) => index < messagesEnd
    && section.role === 'user'
    && !sectionIsEmpty(section)
    && !(index < carriedEnd && isCarriedUserAssets(sectionPlainText(section)))
  const first = sections.findIndex(isMessage)
  const last = sections.findLastIndex(isMessage)
  return {
    reply,
    end: reply === null ? sections.length : reply + 1,
    first: first < 0 ? null : first,
    last: last < 0 || last === first ? null : last,
  }
}

/** The asset lines of the notes of the compaction section of `sections`,
 *  by asset id; none for a conversation with no compaction. */
export function carriedAssetLines(sections: readonly Section[]): Map<string, NotesAssetLine> {
  return sections.length > 0 && sectionCompactionTag(sections[0]) !== null ? notesAssetLines(sectionPlainText(sections[0])) : new Map()
}

/** One image or clip of a conversation at a compaction. */
export interface CompactionAsset {
  asset: FoundAsset
  kind: JobAssetKind
  /** The facts of its file, as the notes hold them (`notesFactsText`). */
  facts: string
  /** Who made it, as the notes hold it: `assetOriginText`, with no column
   *  mark. */
  origin: string
  /** It is in a user section. */
  fromUser: boolean
  /** A call made it as a part of its work (the `hidden` mark). */
  intermediate: boolean
  /** The notes of the compaction before this one have no line for it: it
   *  came after that compaction, or the conversation has none yet. */
  isNew: boolean
  /** What the model wrote about it at the compaction before this one;
   *  blank for none. */
  sentence: string
}

function isIntermediate(asset: FoundAsset): boolean {
  return asset.kind === 'image'
    ? asset.reference.metadata.some((item) => item.key === IMAGE_HIDDEN_KEY)
    : asset.tag.other.some((attribute) => attribute.name === MEDIA_HIDDEN_ATTRIBUTE)
}

/** The assets of a compaction of `sections`: `found` are the assets of the
 *  sections that it replaces (`conversationAssets`, with a section before
 *  `CompactionScope.end`), and `places` their places (`assetPlaces`), in
 *  the same order. `facts` holds the facts text of the file of each asset
 *  by its id (`imageFactsText`, `clipFactsText`, or the text of a file
 *  that Dez could not read). An asset with a line in the notes of the
 *  compaction before needs none: its line tells its facts. */
export function compactionAssets(
  sections: readonly Section[],
  found: readonly FoundAsset[],
  places: readonly AssetPlace[],
  facts: ReadonlyMap<string, string>,
): CompactionAsset[] {
  const carried = carriedAssetLines(sections)
  return found.map((asset, index): CompactionAsset => {
    const line = carried.get(asset.id)
    return {
      asset,
      kind: asset.kind === 'image' ? 'image' : asset.clip.kind,
      facts: line?.facts ?? notesFactsText(facts.get(asset.id) ?? ''),
      origin: assetOriginText(places[index].origin).replace(/\s*\|\s*/g, ' / '),
      fromUser: sections[asset.section].role === 'user',
      intermediate: isIntermediate(asset),
      isNew: line === undefined,
      sentence: line?.sentence ?? '',
    }
  })
}

/** The table of the assets in a compaction request: a first line that
 *  names the columns, then one line for each asset. */
export function assetTableText(assets: readonly CompactionAsset[]): string {
  if (assets.length === 0) return 'The conversation has no image and no clip, so your answer needs no line under the Assets heading.'
  const head = 'The images and the clips of the conversation (id | kind | facts | who made it | from the user or made | intermediate or - | new or earlier). '
    + 'intermediate: a call made it as a part of its work, and the user sees it only in the panel of that call. '
    + 'new: it came after the last compaction; earlier: the notes of the last compaction have its line.'
  const rows = assets.map(({ asset, kind, facts, origin, fromUser, intermediate, isNew }) => [
    `@${asset.id}`, ASSET_NAMES[kind], facts, origin, fromUser ? 'user' : 'made', intermediate ? 'intermediate' : '-', isNew ? 'new' : 'earlier',
  ].join(' | '))
  return [head, ...rows].join('\n')
}

/** The ids of the assets that the open jobs of a reply take as inputs: the
 *  `@id` mentions in the arguments of the tool blocks of `replyText` (the
 *  text of the reply's section) that started a job of `jobs` that still
 *  runs, or whose result no `jobs_wait` gave yet.
 *
 *  After a compaction in the reply, the blocks of its jobs are gone. So a
 *  second compaction of the same reply does not know the inputs of a job
 *  that still runs. The job has its own copies of them. */
export function openJobInputs(replyText: string, jobs: readonly JobInfo[]): Set<string> {
  const open = new Set(jobs.filter((job) => job.status === 'running' || (!job.delivered && job.status !== 'stopped')).map((job) => job.id))
  const ids = new Set<string>()
  if (open.size === 0) return ids
  for (const block of findToolBlocks(replyText)) {
    const started = startedJob(block.result)
    if (started === null || !open.has(started.id)) continue
    for (const value of Object.values(block.arguments)) {
      if (typeof value !== 'string') continue
      for (const mention of findAssetMentions(value)) ids.add(mention.id)
    }
  }
  return ids
}

/** The ids that the `@id` mentions of `text`, the text of a user section,
 *  name: the words that a request reads as mentions (`assetTextPieces`,
 *  after the path scrub, as in `messageTextPieces`, messages.ts). */
export function userTextMentionIds(text: string): Set<string> {
  const ids = new Set<string>()
  for (const piece of assetTextPieces(text, 'user')) {
    if (piece.kind !== 'gap') continue
    for (const mention of findAssetMentions(withoutStoredFilePaths(text.slice(piece.from, piece.to)))) ids.add(mention.id)
  }
  return ids
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

// `sentence` as the notes hold it: on one line, and cut at the limit, by
// code points, so that the cut leaves no half of a character.
function sentenceLine(sentence: string): string {
  const line = [...sentence.replace(/\s+/g, ' ').trim()]
  return line.length <= MAX_ASSET_SENTENCE_LENGTH ? line.join('') : `${line.slice(0, MAX_ASSET_SENTENCE_LENGTH - 1).join('').trimEnd()}…`
}

/** The texts of the user sections of `sections` that stay word for word
 *  after a compaction of `scope`: the first and the newest message of the
 *  user, and each user section after the sections that the compaction
 *  replaces. An `@id` mention of them must still name its asset
 *  (`assetDecisions`). */
export function keptUserTexts(sections: readonly Section[], scope: CompactionScope): string[] {
  const messages = [scope.first, scope.last].flatMap((index) => (index === null ? [] : [sections[index]]))
  return [...messages, ...sections.slice(scope.end).filter((section) => section.role === 'user')].map(sectionPlainText)
}

/** The label of the picture of a clip that a compaction keeps for its
 *  model: the text that goes right before the picture in the requests.
 *  `shows` tells what the picture shows (`ViewPicture.shows`,
 *  tools/assetView.ts): a text with a small first letter and no period. */
export function clipPictureLabel(shows: string): string {
  return `${shows.charAt(0).toUpperCase()}${shows.slice(1)}.`
}

/** What the compaction does with each asset of `assets`, in their order,
 *  from the answer of the model.
 *
 *  - An asset that the answer does not name is kept, with the sentence of
 *    the compaction before.
 *  - A `drop` reads as `keep` for an asset that work can still need: an
 *    asset of the user; an asset that came after the compaction before
 *    (so the first compaction drops nothing, and a new asset lives for one
 *    more compaction at least); an input of an open job (`openJobInputs`);
 *    and an asset that a text names which stays, the notes of the answer
 *    or a text of the user (`keptUserTexts`). */
export function assetDecisions(
  assets: readonly CompactionAsset[],
  answer: CompactionAnswer,
  { jobInputs, keptUserTexts }: { jobInputs: ReadonlySet<string>, keptUserTexts: readonly string[] },
): AssetChoice[] {
  const named = new Set(findAssetMentions([answer.summary, answer.requirements, answer.nextSteps].join('\n')).map((mention) => mention.id))
  for (const text of keptUserTexts) {
    for (const id of userTextMentionIds(text)) named.add(id)
  }
  const lines = new Map(answer.assets.map((line, index) => [line.id, { line, index }]))
  return assets.map((asset): AssetChoice => {
    const { id } = asset.asset
    const found = lines.get(id)
    const mustStay = asset.fromUser || asset.isNew || jobInputs.has(id) || named.has(id)
    const decision = found?.line.decision ?? 'keep'
    return {
      asset,
      decision: decision === 'drop' && mustStay ? 'keep' : decision,
      sentence: sentenceLine(found !== undefined && found.line.sentence !== '' ? found.line.sentence : asset.sentence),
      rank: found?.index ?? Infinity,
    }
  })
}
