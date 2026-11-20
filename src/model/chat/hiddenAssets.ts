import { blockJobStarts, JOBS_WAIT_TOOL, jobsWaitResults, type JobResult } from '../tools/jobs'
import { blockLinkedRule, isCarriedUserAssets, readCompactionBlock } from './compaction'
import { findImageReferences, IMAGE_HIDDEN_KEY, IMAGE_KEPT_KEY, isKeptImage, type ImageReference, type LinkedPathRule } from './images'
import { findMediaTags, isKeptClip, MEDIA_HIDDEN_ATTRIBUTE, type MediaTag } from './mediaTags'
import type { ToolBlock } from './toolBlocks'
import type { Role } from './types'

// Hidden assets: the images and clips that a call made as a part of its
// work (`is_intermediate` of `model_invoke`, of the `join_clips` and
// `ffmpeg` subcommands of `video`, and of the `invoke` subcommand of
// `apps`; `isIntermediateCall`, tools/registry.ts). The text of such an
// asset is where every asset of a
// job is (after the blocks of the `jobs_wait` group that gave its result),
// with a marker that names its job (`IMAGE_HIDDEN_KEY`,
// `MEDIA_HIDDEN_ATTRIBUTE`). The editor shows it under the chip of the
// call that started that job, and not at its own place. A tool call of the
// code of a `js_eval` call can start the job too (`blockJobStarts`): the
// chip of that `js_eval` call then shows the asset.
//
// The marker alone hides nothing. An asset is hidden only while a chip of
// a call that started its job can show it: a tool block of its agent
// section, or of an earlier agent section (`findHiddenAssets`). A job can
// outlive its reply: a reply that the user stops, or that a new message
// interrupts, leaves its jobs to the next reply of the tab. So the
// `jobs_wait` block that gives the result of a job, and the assets of the
// job, can be in a later agent section than the block that started it.
// The asset of a deleted block, and the text in a user section, show as
// any other asset. Only the view hides it: its id, its `@id` mentions, the
// requests, and Delete Unused Files treat it as any other asset.
//
// A compaction hides assets too: every asset of its block, with or without
// the kept mark (`IMAGE_KEPT_KEY`, `MEDIA_KEPT_ATTRIBUTE`), and, in the
// oldest layout, the kept assets of the user that an older Dez carried in
// a user section after the block. The editor shows them in the panel of
// the assets chip of the compaction (`findKeptAssets`).
//
// This module is the one place that tells which assets are hidden.

/** Who shows a hidden asset in place of the text of the asset: the chip of
 *  the call `callId` (`ToolBlock.id`) that started the job `jobId`, or the
 *  assets chip of the compaction. */
export type HiddenAssetOwner =
  | { kind: 'job', jobId: string, callId: string }
  | { kind: 'compaction' }

/** One hidden asset of a section. `from` and `to` are the offsets of its
 *  reference or tag in the section text. */
export type HiddenAsset = { owner: HiddenAssetOwner, from: number, to: number } & (
  | { kind: 'image', image: ImageReference }
  | { kind: 'clip', tag: MediaTag }
)

/** A section of a conversation, as the rule of the jobs reads it
 *  (`findHiddenAssets`, `findJobResults`). */
export interface ChipSection {
  role: Role
  /** The text of the section; the offsets of the assets are in it. */
  text: string
  /** The tool blocks of `text` that show as chips, in order
   *  (`findToolBlocks`; the editor leaves out the blocks that it shows as
   *  text, and the ones in the compaction block). The blocks of a user
   *  section count for nothing: a block there is plain text. */
  blocks: readonly ToolBlock[]
}

/** Where a block is: the index of its section, and its index in the
 *  `blocks` of that section. */
interface BlockPlace {
  section: number
  block: number
}

// For each of `sections`, the index in its `blocks` of each block that
// started a job (`blockJobStarts`), by job id, in text order. None for a
// user section.
function jobStarts(sections: readonly ChipSection[]): Map<string, number[]>[] {
  return sections.map(({ role, blocks }) => {
    const starts = new Map<string, number[]>()
    if (role !== 'agent') return starts
    blocks.forEach((block, index) => {
      for (const { id } of blockJobStarts(block)) {
        const found = starts.get(id)
        if (found) found.push(index)
        else starts.set(id, [index])
      }
    })
    return starts
  })
}

// The block whose chip owns what the job `jobId` gave at `from` in the
// text of the agent section `index` (`findHiddenAssets` tells the rule);
// null for none. `starts` are the `jobStarts` of `sections`.
function owningStart(sections: readonly ChipSection[], starts: readonly ReadonlyMap<string, readonly number[]>[], index: number, from: number, jobId: string): BlockPlace | null {
  const own = starts[index].get(jobId)
  if (own) return { section: index, block: own.findLast((block) => sections[index].blocks[block].from < from) ?? own[0] }
  for (let earlier = index - 1; earlier >= 0; earlier--) {
    const found = starts[earlier].get(jobId)
    if (found) return { section: earlier, block: found[found.length - 1] }
  }
  return null
}

// Blank text before and after the range, up to the line breaks.
function isAloneOnItsLine(text: string, from: number, to: number): boolean {
  const lineStart = text.lastIndexOf('\n', from - 1) + 1
  const lineEnd = text.indexOf('\n', to)
  return text.slice(lineStart, from).trim() === '' && text.slice(to, lineEnd < 0 ? text.length : lineEnd).trim() === ''
}

/** The assets that the chip of a call hides: for each of `sections` (a
 *  whole conversation, in order), its hidden assets in order, with offsets
 *  in its text.
 *
 *  An asset with the hidden mark of the job J belongs to the chip of one
 *  block that started J (`HiddenAssetOwner`):
 *  1. a block of its own section: the nearest one before it, else the
 *     first one after it. A reply writes the asset after the block, so
 *     only an edit puts the block after it, and the block still hides the
 *     asset: an edit that moves a block does not show the assets of its
 *     job. Two blocks of one section that started J also come only from an
 *     edit. The owner then names the nearest one, so that one panel shows
 *     the asset, and its trash and its Save find one text (a copy of a
 *     block has its call id too, so both chips of a copy show it).
 *  2. else the last such block of the nearest earlier agent section that
 *     has one: the reply of that section stopped, and a later reply took
 *     over its jobs and wrote the asset. A job id is unique only among the
 *     jobs of one reply and of the replies that took them over, so a
 *     nearer start of the same id is the start of a newer job.
 *  With no such block, the asset shows at its own place. An asset in a
 *  user section always shows, and a block there starts no job.
 *
 *  An image reference counts only when it is alone on its line, as the
 *  writer puts it: the editor hides whole lines, and other text on the
 *  line must stay in view. A media tag is always a whole line. A reference
 *  in the result of a block is a part of that block. */
export function findHiddenAssets(sections: readonly ChipSection[]): HiddenAsset[][] {
  const hidden: HiddenAsset[][] = sections.map(() => [])
  // Most sections have none, and the editor asks on every doc change.
  const marked = sections.map(({ role, text }) => role === 'agent' && text.includes(`${IMAGE_HIDDEN_KEY}=`))
  if (!marked.includes(true)) return hidden
  const starts = jobStarts(sections)
  sections.forEach(({ text, blocks }, index) => {
    if (!marked[index]) return
    const ownerOf = (jobId: string, from: number): HiddenAssetOwner | null => {
      const start = owningStart(sections, starts, index, from, jobId)
      return start && { kind: 'job', jobId, callId: sections[start.section].blocks[start.block].id }
    }
    const inBlock = (from: number) => blocks.some((block) => from >= block.from && from < block.to)
    const assets: HiddenAsset[] = []
    for (const image of findImageReferences(text, 'agent')) {
      const jobId = image.metadata.find((item) => item.key === IMAGE_HIDDEN_KEY)?.value
      if (jobId === undefined || inBlock(image.from) || !isAloneOnItsLine(text, image.from, image.to)) continue
      const owner = ownerOf(jobId, image.from)
      if (owner) assets.push({ kind: 'image', owner, from: image.from, to: image.to, image })
    }
    for (const tag of findMediaTags(text, 'agent')) {
      const jobId = tag.other.find((attribute) => attribute.name === MEDIA_HIDDEN_ATTRIBUTE)?.value
      if (jobId === undefined || inBlock(tag.from)) continue
      const owner = ownerOf(jobId, tag.from)
      if (owner) assets.push({ kind: 'clip', owner, from: tag.from, to: tag.to, tag })
    }
    hidden[index] = assets.sort((a, b) => a.from - b.from)
  })
  return hidden
}

// The assets with the kept mark in the text of a user section that holds
// the carried assets of the user (the oldest layout), in order: an image
// alone on its line, as in `findHiddenAssets`, and each clip.
function keptUserAssets(text: string): HiddenAsset[] {
  // The mark of an image is `kept=…`, and the one of a clip `kept="…"`.
  if (!text.includes(`${IMAGE_KEPT_KEY}=`)) return []
  const owner: HiddenAssetOwner = { kind: 'compaction' }
  const assets: HiddenAsset[] = []
  for (const image of findImageReferences(text, 'user')) {
    if (!isKeptImage(image) || !isAloneOnItsLine(text, image.from, image.to)) continue
    assets.push({ kind: 'image', owner, from: image.from, to: image.to, image })
  }
  for (const tag of findMediaTags(text, 'user')) {
    if (isKeptClip(tag)) assets.push({ kind: 'clip', owner, from: tag.from, to: tag.to, tag })
  }
  return assets.sort((a, b) => a.from - b.from)
}

// Every asset of the text of a compaction section before `to`, the end of
// its block, in order: the block shows only as its chips, so no asset in
// it can show at its own place. Its linked paths count by `rule`
// (`blockLinkedRule`).
function blockAssetsOf(text: string, to: number, rule: LinkedPathRule): HiddenAsset[] {
  const owner: HiddenAssetOwner = { kind: 'compaction' }
  const assets: HiddenAsset[] = []
  for (const image of findImageReferences(text.slice(0, to), rule)) assets.push({ kind: 'image', owner, from: image.from, to: image.to, image })
  for (const tag of findMediaTags(text.slice(0, to), rule)) assets.push({ kind: 'clip', owner, from: tag.from, to: tag.to, tag })
  return assets.sort((a, b) => a.from - b.from)
}

/** The assets that the assets chip of the compaction shows: for each of
 *  `sections` (a whole conversation, in order; `text` is the whole text of
 *  a section), its kept assets in order, with offsets in its text.
 *
 *  Only a compacted conversation has them (the first section is an agent
 *  section that starts with a valid block, so there are chips to show
 *  them under). In the compaction section, every image and clip of the
 *  block is hidden, with or without the kept mark (`blockAssetsOf`). In
 *  the user sections right after it (the oldest layout), an asset with the
 *  kept mark is hidden only in a section of the carried assets of the user
 *  (`isCarriedUserAssets`). A blank section ends that run as little as it
 *  ends the compaction message of a request. At any other place a marked
 *  asset shows as any other asset: in a kept message of the user of that
 *  layout, the mark only tells a request to send no pixels. */
export function findKeptAssets(sections: readonly { role: Role, text: string }[]): HiddenAsset[][] {
  const kept: HiddenAsset[][] = sections.map(() => [])
  const first = sections[0]
  const block = first?.role === 'agent' ? readCompactionBlock(first.text) : null
  if (!block) return kept
  kept[0] = blockAssetsOf(first.text, block.to, blockLinkedRule(block))
  for (let index = 1; index < sections.length; index++) {
    const { role, text } = sections[index]
    if (text.trim() === '') continue
    if (role === 'agent') break
    if (isCarriedUserAssets(text)) kept[index] = keptUserAssets(text)
  }
  return kept
}

/** The result of the job that each block of `sections` (a whole
 *  conversation, in order) started: for each section, one entry for each
 *  of its `blocks`. A result is what a `jobs_wait` block of an agent
 *  section gave to the model for a job. It belongs to the block that the
 *  rule of `findHiddenAssets` gives, with the `jobs_wait` block in the
 *  place of the asset: so it can be in a later agent section than the
 *  block that started the job. It also belongs to each copy of that block
 *  in its section (a block of the job with the same call id), as each chip
 *  of a copy shows the assets of the job. When two `jobs_wait` blocks give
 *  one for the same block, the first one counts; so a block that started
 *  more than one job (a `js_eval` block, `blockJobStarts`) has the first
 *  result of one of them. Null for a block that started no job, and for a
 *  job with no result (it still runs, its replies ended first, it was
 *  cancelled, or the `jobs_wait` block is gone). */
export function findJobResults(sections: readonly ChipSection[]): (JobResult | null)[][] {
  const results: (JobResult | null)[][] = sections.map(({ blocks }) => blocks.map(() => null))
  const gaveResults = (block: ToolBlock) => block.name === JOBS_WAIT_TOOL.name && block.status === 'success'
  // Most conversations have none, and the editor asks on every doc change.
  if (!sections.some(({ role, blocks }) => role === 'agent' && blocks.some(gaveResults))) return results
  const starts = jobStarts(sections)
  sections.forEach(({ role, blocks }, index) => {
    if (role !== 'agent') return
    for (const wait of blocks) {
      if (!gaveResults(wait)) continue
      for (const result of jobsWaitResults(wait.result)) {
        const start = owningStart(sections, starts, index, wait.from, result.id)
        if (!start) continue
        const startBlocks = sections[start.section].blocks
        const callId = startBlocks[start.block].id
        for (const block of starts[start.section].get(result.id) ?? []) {
          if (startBlocks[block].id === callId) results[start.section][block] ??= result
        }
      }
    }
  })
  return results
}
