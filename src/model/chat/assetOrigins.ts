import type { FoundAsset } from '../streams/mediaRequest'
import { assetOriginText } from '../tools/assetInfo'
import { JOBS_WAIT_TOOL, jobsWaitResults, madeAssetIds, startedJob } from '../tools/jobs'
import { callLabel } from '../tools/registry'
import { compactionMessageEnd, sectionTextParts } from './compaction'
import { notesAssetLines, notesJobLines, notesMessages, type NotesAssetLine, type NotesJobLine } from './compactionNotes'
import { sectionPlainText } from './content'
import { findHiddenAssets, findKeptAssets } from './hiddenAssets'
import { IMAGE_HIDDEN_KEY, IMAGE_MADE_BY_KEY, IMAGE_TOOL_KEY } from './images'
import { MEDIA_HIDDEN_ATTRIBUTE, MEDIA_MADE_BY_ATTRIBUTE, MEDIA_TOOL_ATTRIBUTE } from './mediaTags'
import { findToolBlocks, type ToolBlock } from './toolBlocks'
import type { ModelRef, Section } from './types'

// Who made each image and clip of a conversation, and whether the editor
// hides it, from the text of its section alone: the marks of its reference
// or tag, and the tool blocks of its reply. The `asset_info` tool tells
// these to a model, so that it knows which call made which clip (the jobs
// of a reply end in any order, and so do the ids of their assets).
//
// A compaction removes the tool blocks. The notes of its section keep one
// line for each asset, and one for each job of the reply that ran
// (compactionNotes.ts), and these lines then tell who made an asset.

/** Who made an image or a clip. */
export type AssetOrigin =
  | { kind: 'user' }
  /** A model wrote it in its reply; `model` is null when the section does
   *  not tell which. */
  | { kind: 'model', model: ModelRef | null }
  /** A job of a Dez tool call made it. `number` is the place of the job in
   *  the order of the starts of its reply (null when no text tells it), and
   *  `label` how its call begins (`callLabel`; blank for none). */
  | { kind: 'job', tool: string, number: number | null, label: string }
  /** A Dez tool call made it in its call, not as a job; `label` as for a
   *  job. */
  | { kind: 'call', tool: string, label: string }
  /** A compaction kept it in its section. `text` is what its line in the
   *  notes tells about who made it: the origin text of the time of that
   *  compaction (`assetOriginText`, tools/assetInfo.ts). */
  | { kind: 'carried', text: string }

/** Who made an image or a clip, and whether the editor hides it. A hidden
 *  one shows only in a panel: the one of the chip of its call
 *  (`findHiddenAssets`), or the one of the assets chip of a compaction
 *  (`findKeptAssets`). */
export interface AssetPlace {
  origin: AssetOrigin
  hidden: boolean
}

// The marks of an asset that a Dez tool made: the tool, and the job that
// made it (null for none). An old hidden asset has no `made-by` mark, but
// its `hidden` mark names the same job.
interface ToolMarks {
  tool: string
  jobId: string | null
}

// Who made the asset `id` of an agent section with the tool marks `marks`,
// from the tool blocks of that section, in this order:
// 1. the block that started its job, which tells the number of the job and
//    the arguments of its call;
// 2. the result of a `jobs_wait` block that names its job or the asset (an
//    asset of a job whose block is gone, or that has no job mark);
// 3. for an asset with a job mark, that job alone (its blocks are gone):
//    the line of the job in the notes of a compaction (`jobLines`) tells
//    its number and its call, else they are not known;
// 4. the result of another block that names the asset (an `image` or an
//    `audio clip` call, which makes it in its call);
// 5. the tool mark alone.
function toolOrigin(id: string, marks: ToolMarks, blocks: readonly ToolBlock[], jobLines: ReadonlyMap<string, NotesJobLine>): AssetOrigin {
  const { tool, jobId } = marks
  if (jobId !== null) {
    for (const block of blocks) {
      const started = startedJob(block.result)
      if (started?.id === jobId) return { kind: 'job', tool, number: started.number, label: callLabel(block.name, block.arguments) }
    }
  }
  for (const block of blocks) {
    if (block.name !== JOBS_WAIT_TOOL.name) continue
    const part = jobsWaitResults(block.result).find((result) => result.id === jobId || madeAssetIds(result.text).includes(id))
    if (part) return { kind: 'job', tool: part.tool, number: part.call.number, label: part.call.label }
  }
  if (jobId !== null) {
    const line = jobLines.get(jobId)
    return { kind: 'job', tool, number: line?.number ?? null, label: line?.label ?? '' }
  }
  const call = blocks.find((block) => block.name !== JOBS_WAIT_TOOL.name && madeAssetIds(block.result).includes(id))
  return { kind: 'call', tool, label: call ? callLabel(call.name, call.arguments) : '' }
}

// The tool marks of `asset`; null for an asset that no Dez tool made.
function toolMarks(asset: FoundAsset): ToolMarks | null {
  if (asset.kind === 'image') {
    const mark = (key: string) => asset.reference.metadata.find((item) => item.key === key)?.value ?? null
    const tool = mark(IMAGE_TOOL_KEY)
    return tool === null ? null : { tool, jobId: mark(IMAGE_MADE_BY_KEY) ?? mark(IMAGE_HIDDEN_KEY) }
  }
  const mark = (name: string) => asset.tag.other.find((attribute) => attribute.name === name)?.value ?? null
  const tool = mark(MEDIA_TOOL_ATTRIBUTE)
  return tool === null ? null : { tool, jobId: mark(MEDIA_MADE_BY_ATTRIBUTE) ?? mark(MEDIA_HIDDEN_ATTRIBUTE) }
}

const NO_JOB_LINES: ReadonlyMap<string, NotesJobLine> = new Map()

/** The place of each asset of `assets`, in its order: the assets that
 *  `conversationAssets` (streams/mediaRequest.ts) found in `sections`, a
 *  whole conversation. An asset of a user section is from the user, and
 *  one of an agent section with no tool mark is from the model of that
 *  section.
 *
 *  In a compacted conversation, an asset of the compaction block has the
 *  origin of its line in the notes. An asset in a message part of the
 *  notes, and an asset whose line tells "from the user", are from the
 *  user. The job lines of the notes are of the reply that ran at the
 *  compaction, so only its assets read them: a job id is unique in its
 *  reply only. That reply is the text after the block (chat/compaction.ts),
 *  or, in an older layout, the first reply after the compaction message. */
export function assetPlaces(sections: readonly Section[], assets: readonly FoundAsset[]): AssetPlace[] {
  const first = sections.length > 0 ? sectionTextParts(sections[0], 0) : null
  const block = first?.block ?? null
  const notes = block?.notes ?? ''
  // The section of the reply that ran at the compaction, and where its
  // text starts: the text after the block, or an older layout's reply.
  const ranReply = block === null
    ? null
    : first!.text.trim() !== '' ? { section: 0, from: block.textFrom } : { section: compactionMessageEnd(sections), from: 0 }
  const ranAtCompaction = (index: number, from: number) => ranReply !== null && index === ranReply.section && from >= ranReply.from
  // Whether the offset `from` of the text of the compaction section is in
  // a message part of its notes.
  let messageRanges: { from: number, to: number }[] | undefined
  const inMessage = (from: number) => {
    messageRanges ??= notesMessages(notes).map((message) => ({ from: block!.notesFrom + message.from, to: block!.notesFrom + message.to }))
    return messageRanges.some((range) => from >= range.from && from < range.to)
  }
  // Each of these reads whole texts, so only an asset that needs one asks
  // for it, and each is read once for all assets.
  let assetLines: ReadonlyMap<string, NotesAssetLine> | undefined
  let jobLines: ReadonlyMap<string, NotesJobLine> | undefined
  let keptFrom: Set<number>[] | undefined
  const isKept = (asset: FoundAsset, from: number) => {
    if (block === null) return false
    keptFrom ??= findKeptAssets(sections.map((section) => ({ role: section.role, text: sectionPlainText(section) })))
      .map((kept) => new Set(kept.map((hidden) => hidden.from)))
    return keptFrom[asset.section].has(from)
  }
  // The tool blocks of the text of each reply that holds one of `assets`
  // (`sectionTextParts`: never the compaction block), and the starts of
  // the assets that a chip of a call hides, as offsets in the section.
  const agentTexts = new Map<number, { blocks: ToolBlock[], hiddenFrom: Set<number> }>()
  const agentText = (index: number) => {
    let found = agentTexts.get(index)
    if (found === undefined) {
      const { text, from } = sectionTextParts(sections[index], index)
      const blocks = findToolBlocks(text)
      found = { blocks, hiddenFrom: new Set(findHiddenAssets(text, blocks).map((asset) => from + asset.from)) }
      agentTexts.set(index, found)
    }
    return found
  }

  return assets.map((asset): AssetPlace => {
    const section = sections[asset.section]
    const from = asset.kind === 'image' ? asset.reference.from : asset.tag.from
    if (section.role === 'user') return { origin: { kind: 'user' }, hidden: isKept(asset, from) }
    const { blocks, hiddenFrom } = agentText(asset.section)
    const hidden = hiddenFrom.has(from) || isKept(asset, from)
    const inNotes = block !== null && asset.section === 0 && from < block.to
    if (inNotes) {
      if (inMessage(from)) return { origin: { kind: 'user' }, hidden }
      const line = (assetLines ??= notesAssetLines(notes)).get(asset.id)
      if (line) return { origin: line.origin === assetOriginText({ kind: 'user' }) ? { kind: 'user' } : { kind: 'carried', text: line.origin }, hidden }
    }
    const marks = toolMarks(asset)
    // The model of a compaction wrote its notes, not the assets in them.
    if (!marks) return { origin: { kind: 'model', model: inNotes ? null : section.model ?? null }, hidden }
    const lines = ranAtCompaction(asset.section, from) ? (jobLines ??= notesJobLines(notes)) : NO_JOB_LINES
    return { origin: toolOrigin(asset.id, marks, blocks, lines), hidden }
  })
}
