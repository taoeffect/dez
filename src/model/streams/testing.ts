import { assetPlaces } from '../chat/assetOrigins'
import type { ModelRef, Section } from '../chat/types'
import { compactionAssets, compactionScope, type CompactionAsset } from './compactionAssets'
import { conversationAssets } from './mediaRequest'

// Shared helpers of the unit tests of this folder: the sections of a tab,
// and the assets of a compaction.

/** The model of the agent sections that `reply` makes. */
export const model: ModelRef = { providerId: 'local', modelId: 'm' }

/** A user section with one text. */
export const user = (id: string, text: string): Section => ({ id, role: 'user', content: [{ kind: 'text', text }] })

/** An agent section of `model` with one text. */
export const reply = (id: string, text: string): Section => ({ id, role: 'agent', model, content: [{ kind: 'text', text }] })

/** The compaction assets of every image and clip of `sections`, with the
 *  file facts of `facts`, by id, at a compaction in the reply whose
 *  section has the id `replySectionId` (none: no section is the reply's),
 *  with the inputs of the open jobs `jobInputs`, the ids that the files of
 *  the apps name `appInputs`, and the sections of the cut replies that
 *  handed their jobs on `replySections`. */
export function assetsOf(
  sections: readonly Section[],
  facts: ReadonlyMap<string, string> = new Map(),
  { replySectionId = '', jobInputs = new Map(), appInputs = new Set(), replySections = [] }: {
    replySectionId?: string
    jobInputs?: ReadonlyMap<string, readonly string[]>
    appInputs?: ReadonlySet<string>
    replySections?: readonly string[]
  } = {},
): CompactionAsset[] {
  const found = [...conversationAssets(sections).found.values()]
  const scope = compactionScope(sections, replySectionId)
  return compactionAssets({ sections, scope, found, places: assetPlaces(sections, found), facts, jobInputs, appInputs, replySections })
}
