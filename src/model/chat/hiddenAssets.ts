import { JOBS_WAIT_TOOL, jobsWaitResults, startedJobId, type JobResult } from '../tools/jobs'
import { isCarriedUserAssets, readCompactionBlock } from './compaction'
import { findImageReferences, IMAGE_HIDDEN_KEY, IMAGE_KEPT_KEY, isKeptImage, type ImageReference } from './images'
import { findMediaTags, isKeptClip, MEDIA_HIDDEN_ATTRIBUTE, type MediaTag } from './mediaTags'
import { findToolBlocks, type ToolBlock } from './toolBlocks'
import type { Role } from './types'

// Hidden assets: the images and clips that a call made as a part of its
// work (`is_intermediate` of `model_invoke`, and of the `join_clips` and
// `ffmpeg` subcommands of `video`; `isIntermediateCall`,
// tools/registry.ts). The text of such an asset is where every asset of a
// job is (after the blocks of the `jobs_wait` group that gave its result),
// with a marker that names its job (`IMAGE_HIDDEN_KEY`,
// `MEDIA_HIDDEN_ATTRIBUTE`). The editor shows it under the chip of the
// call that started that job, and not at its own place.
//
// The marker alone hides nothing. An asset is hidden only while a tool
// block of its agent section started its job, so that there is a chip to
// show it under: the asset of a deleted block, and the text in a user
// section, show as any other asset. Only the view hides it: its id, its
// `@id` mentions, the requests, and Delete Unused Files treat it as any
// other asset.
//
// A compaction hides assets too: every asset of its block (the kept assets
// that it wrote with the kept mark, `IMAGE_KEPT_KEY` and
// `MEDIA_KEPT_ATTRIBUTE`, in its notes), and the kept assets of the user
// that it carried. The editor shows them in the panel of the assets chip
// of the compaction (`findKeptAssets`).
//
// This module is the one place that tells which assets are hidden.

/** Who shows a hidden asset in place of the text of the asset: the chip of
 *  the call that started the job `jobId`, or the assets chip of the
 *  compaction. */
export type HiddenAssetOwner =
  | { kind: 'job', jobId: string }
  | { kind: 'compaction' }

/** One hidden asset of a section. `from` and `to` are the offsets of its
 *  reference or tag in the section text. */
export type HiddenAsset = { owner: HiddenAssetOwner, from: number, to: number } & (
  | { kind: 'image', image: ImageReference }
  | { kind: 'clip', tag: MediaTag }
)

// Blank text before and after the range, up to the line breaks.
function isAloneOnItsLine(text: string, from: number, to: number): boolean {
  const lineStart = text.lastIndexOf('\n', from - 1) + 1
  const lineEnd = text.indexOf('\n', to)
  return text.slice(lineStart, from).trim() === '' && text.slice(to, lineEnd < 0 ? text.length : lineEnd).trim() === ''
}

/** The assets in the text of an agent section that the chip of a call
 *  hides, in order. `blocks` are the tool blocks of that text
 *  (`findToolBlocks`).
 *
 *  An image reference counts only when it is alone on its line, as the
 *  writer puts it: the editor hides whole lines, and other text on the
 *  line must stay in view. A media tag is always a whole line. A reference
 *  in the result of a block is a part of that block. */
export function findHiddenAssets(text: string, blocks: readonly ToolBlock[]): HiddenAsset[] {
  // Most sections have none, and the editor asks on every doc change.
  if (!text.includes(`${IMAGE_HIDDEN_KEY}=`)) return []
  const jobIds = new Set<string>()
  for (const block of blocks) {
    const jobId = startedJobId(block.result)
    if (jobId !== null) jobIds.add(jobId)
  }
  if (jobIds.size === 0) return []
  const inBlock = (from: number) => blocks.some((block) => from >= block.from && from < block.to)

  const assets: HiddenAsset[] = []
  for (const image of findImageReferences(text, 'agent')) {
    const jobId = image.metadata.find((item) => item.key === IMAGE_HIDDEN_KEY)?.value
    if (jobId === undefined || !jobIds.has(jobId) || inBlock(image.from) || !isAloneOnItsLine(text, image.from, image.to)) continue
    assets.push({ kind: 'image', owner: { kind: 'job', jobId }, from: image.from, to: image.to, image })
  }
  for (const tag of findMediaTags(text)) {
    const jobId = tag.other.find((attribute) => attribute.name === MEDIA_HIDDEN_ATTRIBUTE)?.value
    if (jobId === undefined || !jobIds.has(jobId) || inBlock(tag.from)) continue
    assets.push({ kind: 'clip', owner: { kind: 'job', jobId }, from: tag.from, to: tag.to, tag })
  }
  return assets.sort((a, b) => a.from - b.from)
}

// The assets with the kept mark in the text of a section of the role
// `role`, in order, by the rules of `findHiddenAssets`: an image alone on
// its line, and nothing in a tool block.
function keptAssetsOf(text: string, role: Role): HiddenAsset[] {
  // The mark of an image is `kept=…`, and the one of a clip `kept="…"`.
  if (!text.includes(`${IMAGE_KEPT_KEY}=`)) return []
  const blocks = role === 'agent' ? findToolBlocks(text) : []
  const inBlock = (from: number) => blocks.some((block) => from >= block.from && from < block.to)
  const owner: HiddenAssetOwner = { kind: 'compaction' }
  const assets: HiddenAsset[] = []
  for (const image of findImageReferences(text, role)) {
    if (!isKeptImage(image) || inBlock(image.from) || !isAloneOnItsLine(text, image.from, image.to)) continue
    assets.push({ kind: 'image', owner, from: image.from, to: image.to, image })
  }
  for (const tag of findMediaTags(text)) {
    if (isKeptClip(tag) && !inBlock(tag.from)) assets.push({ kind: 'clip', owner, from: tag.from, to: tag.to, tag })
  }
  return assets.sort((a, b) => a.from - b.from)
}

// Every asset of the text of a compaction section before `to`, the end of
// its block, in order: the block shows only as its chips, so no asset in
// it can show at its own place.
function blockAssetsOf(text: string, to: number): HiddenAsset[] {
  const owner: HiddenAssetOwner = { kind: 'compaction' }
  const assets: HiddenAsset[] = []
  for (const image of findImageReferences(text.slice(0, to), 'agent')) assets.push({ kind: 'image', owner, from: image.from, to: image.to, image })
  for (const tag of findMediaTags(text.slice(0, to))) assets.push({ kind: 'clip', owner, from: tag.from, to: tag.to, tag })
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
 *  the user sections right after it, an asset with the kept mark is
 *  hidden only in a section of the carried assets of the user
 *  (`isCarriedUserAssets`). A blank section ends that run as little as it
 *  ends the compaction message of a request. At any other place a marked
 *  asset shows as any other asset: in a kept message of the user, the
 *  mark only tells a request to send no pixels. */
export function findKeptAssets(sections: readonly { role: Role, text: string }[]): HiddenAsset[][] {
  const kept: HiddenAsset[][] = sections.map(() => [])
  const first = sections[0]
  const block = first?.role === 'agent' ? readCompactionBlock(first.text) : null
  if (!block) return kept
  kept[0] = blockAssetsOf(first.text, block.to)
  for (let index = 1; index < sections.length; index++) {
    const { role, text } = sections[index]
    if (text.trim() === '') continue
    if (role === 'agent') break
    if (isCarriedUserAssets(text)) kept[index] = keptAssetsOf(text, 'user')
  }
  return kept
}

/** The result of the job `jobId` that a `jobs_wait` block of `blocks` gave
 *  to the model; null when none did (the job still runs, its reply ended
 *  first, or the block is gone). */
export function jobResultInBlocks(blocks: readonly ToolBlock[], jobId: string): JobResult | null {
  for (const block of blocks) {
    if (block.name !== JOBS_WAIT_TOOL.name || block.status !== 'success' || !block.result.includes(jobId)) continue
    const result = jobsWaitResults(block.result).find((job) => job.id === jobId)
    if (result) return result
  }
  return null
}
