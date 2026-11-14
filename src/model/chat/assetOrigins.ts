import type { FoundAsset } from '../streams/mediaRequest'
import { JOBS_WAIT_TOOL, jobsWaitResults, madeAssetIds, startedJob } from '../tools/jobs'
import { callLabel } from '../tools/registry'
import { sectionPlainText } from './content'
import { findHiddenAssets } from './hiddenAssets'
import { IMAGE_HIDDEN_KEY, IMAGE_MADE_BY_KEY, IMAGE_TOOL_KEY } from './images'
import { MEDIA_HIDDEN_ATTRIBUTE, MEDIA_MADE_BY_ATTRIBUTE, MEDIA_TOOL_ATTRIBUTE } from './mediaTags'
import { findToolBlocks, type ToolBlock } from './toolBlocks'
import type { ModelRef, Section } from './types'

// Who made each image and clip of a conversation, and whether the editor
// hides it, from the text of its section alone: the marks of its reference
// or tag, and the tool blocks of its reply. The `asset_info` tool tells
// these to a model, so that it knows which call made which clip (the jobs
// of a reply end in any order, and so do the ids of their assets).

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

/** Who made an image or a clip, and whether the editor hides it (it then
 *  shows only in the panel of the chip of its call: `findHiddenAssets`). */
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
// 3. for an asset with a job mark, that job alone (its blocks are gone, so
//    its number and its call are not known);
// 4. the result of another block that names the asset (an `image` or an
//    `audio clip` call, which makes it in its call);
// 5. the tool mark alone.
function toolOrigin(id: string, marks: ToolMarks, blocks: readonly ToolBlock[]): AssetOrigin {
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
  if (jobId !== null) return { kind: 'job', tool, number: null, label: '' }
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

/** The place of each asset of `assets`, in its order: the assets that
 *  `conversationAssets` (streams/mediaRequest.ts) found in `sections`. An
 *  asset of a user section is from the user, and one of an agent section
 *  with no tool mark is from the model of that section. */
export function assetPlaces(sections: readonly Section[], assets: readonly FoundAsset[]): AssetPlace[] {
  // The tool blocks of each agent section that holds one of `assets`, and
  // the starts of its hidden assets, read once for all its assets.
  const agentTexts = new Map<number, { blocks: ToolBlock[], hiddenFrom: Set<number> }>()
  const agentText = (index: number) => {
    let found = agentTexts.get(index)
    if (found === undefined) {
      const text = sectionPlainText(sections[index])
      const blocks = findToolBlocks(text)
      found = { blocks, hiddenFrom: new Set(findHiddenAssets(text, blocks).map((asset) => asset.from)) }
      agentTexts.set(index, found)
    }
    return found
  }

  return assets.map((asset): AssetPlace => {
    const section = sections[asset.section]
    if (section.role === 'user') return { origin: { kind: 'user' }, hidden: false }
    const { blocks, hiddenFrom } = agentText(asset.section)
    const marks = toolMarks(asset)
    return {
      origin: marks ? toolOrigin(asset.id, marks, blocks) : { kind: 'model', model: section.model ?? null },
      hidden: hiddenFrom.has(asset.kind === 'image' ? asset.reference.from : asset.tag.from),
    }
  })
}
