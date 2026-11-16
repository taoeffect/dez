import { oneLineCut } from '../../utils/oneLineCut'
import type { AssetPlace } from '../chat/assetOrigins'
import { compactionMessageEnd, isCarriedUserAssets, sectionCompactionTag } from '../chat/compaction'
import { notesAssetLines, notesCellText, notesJobLines, type NotesAssetLine } from '../chat/compactionNotes'
import { sectionIsEmpty, sectionPlainText } from '../chat/content'
import { findAssetMentions } from '../chat/imageMentions'
import { IMAGE_HIDDEN_KEY } from '../chat/images'
import { MEDIA_HIDDEN_ATTRIBUTE } from '../chat/mediaTags'
import { findToolBlocks } from '../chat/toolBlocks'
import type { Section } from '../chat/types'
import { assetOriginText } from '../tools/assetInfo'
import { ASSET_NAMES, startedJob, type JobAssetKind, type JobInfo } from '../tools/jobs'
import { MAX_ASSET_SENTENCE_LENGTH, type AssetDecision, type CompactionAnswer } from './compactionRequest'
import type { FoundAsset } from './mediaRequest'
import { messageMentionIds } from './messages'

// The images and the clips of a conversation at a compaction: what Dez
// tells the model about each one in the compaction request (the asset
// table), and what the compaction does with each one. The model decides
// (`show`, `keep`, `drop`; compactionRequest.ts) what the work at hand
// needs, and the rest leaves the conversation. Dez holds only the rules
// that keep work that is still in use: a fault of the model, or of the
// reader of its answer, must never remove an asset of the user, or an
// asset that a later step needs. All pure; controller/compaction.ts reads
// the files.

/** Which sections a compaction replaces, as indexes of the sections of
 *  the conversation. */
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
  first: number | null
  /** The newest message of the user, which stays word for word: the one
   *  that the reply answers. Null when it is `first`, or there is none. */
  last: number | null
}

/** The scope of a compaction of `sections` in the reply whose section has
 *  the id `replySectionId`: at a submit, the empty section of the new
 *  reply. With an id of no section, the scope is the whole conversation.
 *
 *  A message of the user is a user section before the reply's section
 *  that is not empty, and that is not the section of the carried assets of
 *  the user that an earlier compaction wrote (`isCarriedUserAssets`, which
 *  counts only in the compaction message). */
export function compactionScope(sections: readonly Section[], replySectionId: string): CompactionScope {
  const found = sections.findIndex((section) => section.id === replySectionId)
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
  /** The facts of its file, as the notes hold them (`notesCellText`). */
  facts: string
  /** Who made it, as the notes hold it: `assetOriginText`, as a cell of
   *  the notes (`notesCellText`). */
  origin: string
  /** It is in a user section. */
  fromUser: boolean
  /** A call made it as a part of its work (the `hidden` mark). */
  intermediate: boolean
  /** The reply that runs made it: its text is in the section of the reply,
   *  or the notes of a compaction earlier in this same reply tell it
   *  (`NotesAssetLine.byReply`, `replyRanAtCompaction`). */
  byReply: boolean
  /** An open job of the reply that runs takes it as an input
   *  (`openJobInputs`). */
  jobInput: boolean
  /** What the model wrote about it at the compaction before this one;
   *  blank for none. */
  sentence: string
}

function isIntermediate(asset: FoundAsset): boolean {
  return asset.kind === 'image'
    ? asset.reference.metadata.some((item) => item.key === IMAGE_HIDDEN_KEY)
    : asset.tag.other.some((attribute) => attribute.name === MEDIA_HIDDEN_ATTRIBUTE)
}

// Whether the reply that runs (`scope.reply`) is the one that ran at the
// compaction of the notes of `sections`: no message of the user came after
// that compaction, so the reply's section is the first agent section with
// text after the compaction message. With no text in it yet, the reply
// counts as a new one: the next compaction of a reply comes only after a
// round, whose text is in its section.
function replyRanAtCompaction(sections: readonly Section[], scope: CompactionScope): boolean {
  return scope.reply !== null && sectionCompactionTag(sections[0]) !== null && compactionMessageEnd(sections) === scope.reply
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
}

/** The assets of a compaction, in the order of `input.found`. */
export function compactionAssets({ sections, scope, found, places, facts, jobInputs }: CompactionAssetsInput): CompactionAsset[] {
  const carried = carriedAssetLines(sections)
  const sameReply = replyRanAtCompaction(sections, scope)
  const inputs = new Set([...jobInputs.values()].flat())
  return found.map((asset, index): CompactionAsset => {
    const line = carried.get(asset.id)
    return {
      asset,
      kind: asset.kind === 'image' ? 'image' : asset.clip.kind,
      facts: line?.facts ?? notesCellText(facts.get(asset.id) ?? ''),
      origin: notesCellText(assetOriginText(places[index].origin)),
      fromUser: sections[asset.section].role === 'user',
      intermediate: isIntermediate(asset),
      byReply: asset.section === scope.reply || (sameReply && line?.byReply === true),
      jobInput: inputs.has(asset.id),
      sentence: line?.sentence ?? '',
    }
  })
}

/** The table of the assets in a compaction request: a first line that
 *  names the columns, then one line for each asset. */
export function assetTableText(assets: readonly CompactionAsset[]): string {
  if (assets.length === 0) return 'The conversation has no image and no clip, so your answer needs no line under the Assets heading.'
  const head = 'The images and the clips of the conversation (id | kind | facts | who made it | from the user or made | intermediate or - | this reply or earlier | open job or -). '
    + 'intermediate: a call made it as a part of its work, and the user sees it only in the panel of that call. '
    + 'this reply: the reply that you work on now made it; earlier: an earlier reply made it; - for an asset of the user. '
    + 'open job: a job that still runs, or whose result you did not get yet, takes it as an input.'
  const rows = assets.map(({ asset, kind, facts, origin, fromUser, intermediate, byReply, jobInput }) => [
    `@${asset.id}`,
    ASSET_NAMES[kind],
    facts,
    origin,
    fromUser ? 'user' : 'made',
    intermediate ? 'intermediate' : '-',
    fromUser ? '-' : byReply ? 'this reply' : 'earlier',
    jobInput ? 'open job' : '-',
  ].join(' | '))
  return [head, ...rows].join('\n')
}

/** The inputs of the open jobs of the reply that runs (`scope.reply`): a
 *  job of `jobs` that still runs, or whose result no `jobs_wait` gave yet.
 *  By job id, the ids of its inputs in order.
 *
 *  The tool blocks of the reply's section tell them: the `@id` mentions in
 *  the result of the block that started the job. The result, not the
 *  arguments of the call: the start result names each input of the job as
 *  `@id` (`invocationInputsText`, `videoInputsText`), also when the call
 *  named it with a bare id (`assetIdWords` takes `c` and `@c`, as in the
 *  `clips` of `video join_clips`).
 *
 *  A compaction earlier in the same reply removed the blocks of the jobs
 *  that started before it, so its notes tell their inputs
 *  (`NotesJobLine.inputs`). Job ids are unique only in one reply, so the
 *  notes count only when this reply ran at their compaction. */
export function openJobInputs(sections: readonly Section[], scope: CompactionScope, jobs: readonly JobInfo[]): Map<string, string[]> {
  const open = new Set(jobs.filter((job) => job.status === 'running' || (!job.delivered && job.status !== 'stopped')).map((job) => job.id))
  const inputs = new Map<string, string[]>()
  const add = (jobId: string, ids: Iterable<string>) => {
    const list = inputs.get(jobId) ?? []
    for (const id of ids) {
      if (!list.includes(id)) list.push(id)
    }
    inputs.set(jobId, list)
  }
  if (open.size === 0 || scope.reply === null) return inputs
  if (replyRanAtCompaction(sections, scope)) {
    for (const line of notesJobLines(sectionPlainText(sections[0])).values()) {
      if (open.has(line.id)) add(line.id, line.inputs)
    }
  }
  for (const block of findToolBlocks(sectionPlainText(sections[scope.reply]))) {
    const started = startedJob(block.result)
    if (started !== null && open.has(started.id)) add(started.id, findAssetMentions(block.result).map((mention) => mention.id))
  }
  return inputs
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
 *  from the answer of the model. The model judges what the work at hand
 *  needs; Dez guards only against its faults.
 *
 *  - An asset that the answer has no line for is kept when the reply that
 *    runs made it (the model forgot its line), and dropped when an earlier
 *    reply made it. When no line of the answer names an asset of `assets`,
 *    each one is kept: a broken answer must not remove work, and a
 *    compaction cannot be undone.
 *  - A `drop` reads as `keep` for an asset that work can still need: an
 *    asset of the user; an input of an open job (`jobInput`); and an asset
 *    that a text names which stays, the notes of the answer or a text of
 *    the user (`keptUserTexts`).
 *  - Any other line counts as it is: the model can drop an asset of the
 *    reply that runs. */
export function assetDecisions(
  assets: readonly CompactionAsset[],
  answer: CompactionAnswer,
  { keptTexts }: { keptTexts: readonly string[] },
): AssetChoice[] {
  const named = new Set(findAssetMentions([answer.summary, answer.requirements, answer.nextSteps].join('\n')).map((mention) => mention.id))
  for (const text of keptTexts) {
    for (const id of messageMentionIds(text)) named.add(id)
  }
  const lines = new Map(answer.assets.map((line, index) => [line.id, { line, index }]))
  const answered = assets.some(({ asset }) => lines.has(asset.id))
  return assets.map((asset): AssetChoice => {
    const { id } = asset.asset
    const found = lines.get(id)
    const guarded = asset.fromUser || asset.jobInput || named.has(id)
    const decision = found?.line.decision ?? (!answered || guarded || asset.byReply ? 'keep' : 'drop')
    return {
      asset,
      decision: decision === 'drop' && guarded ? 'keep' : decision,
      sentence: oneLineCut(found !== undefined && found.line.sentence !== '' ? found.line.sentence : asset.sentence, MAX_ASSET_SENTENCE_LENGTH),
      rank: found?.index ?? Infinity,
    }
  })
}
