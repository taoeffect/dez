import { JOBS_WAIT_TOOL, jobsWaitResults, startedJobId, type JobResult } from '../tools/jobs'
import { findImageReferences, IMAGE_HIDDEN_KEY, type ImageReference } from './images'
import { findMediaTags, MEDIA_HIDDEN_ATTRIBUTE, type MediaTag } from './mediaTags'
import type { ToolBlock } from './toolBlocks'

// Hidden assets: the images and clips that a call made as a part of its
// work (`is_intermediate` of `model_invoke`). The text of such an asset is
// where every asset of a job is (after the blocks of the `jobs_wait` group
// that gave its result), with a marker that names its job
// (`IMAGE_HIDDEN_KEY`, `MEDIA_HIDDEN_ATTRIBUTE`). The editor shows it under
// the chip of the call that started that job, and not at its own place.
//
// The marker alone hides nothing. An asset is hidden only while a tool
// block of its agent section started its job, so that there is a chip to
// show it under: the asset of a deleted block, and the text in a user
// section, show as any other asset. This module is the one place that
// tells which assets are hidden.

/** One hidden asset of an agent section. `from` and `to` are the offsets
 *  of its reference or tag in the section text. */
export type HiddenAsset = { jobId: string, from: number, to: number } & (
  | { kind: 'image', image: ImageReference }
  | { kind: 'clip', tag: MediaTag }
)

// Blank text before and after the range, up to the line breaks.
function isAloneOnItsLine(text: string, from: number, to: number): boolean {
  const lineStart = text.lastIndexOf('\n', from - 1) + 1
  const lineEnd = text.indexOf('\n', to)
  return text.slice(lineStart, from).trim() === '' && text.slice(to, lineEnd < 0 ? text.length : lineEnd).trim() === ''
}

/** The hidden assets in the text of an agent section, in order. `blocks`
 *  are the tool blocks of that text (`findToolBlocks`).
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
    assets.push({ kind: 'image', jobId, from: image.from, to: image.to, image })
  }
  for (const tag of findMediaTags(text)) {
    const jobId = tag.other.find((attribute) => attribute.name === MEDIA_HIDDEN_ATTRIBUTE)?.value
    if (jobId === undefined || !jobIds.has(jobId) || inBlock(tag.from)) continue
    assets.push({ kind: 'clip', jobId, from: tag.from, to: tag.to, tag })
  }
  return assets.sort((a, b) => a.from - b.from)
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
