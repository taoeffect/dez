import { assetPlaces } from '../chat/assetOrigins'
import type { ModelRef, Section } from '../chat/types'
import { compactionAssets, type CompactionAsset } from './compactionAssets'
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
 *  file facts of `facts`, by id. */
export function assetsOf(sections: readonly Section[], facts: ReadonlyMap<string, string> = new Map()): CompactionAsset[] {
  const found = [...conversationAssets(sections).found.values()]
  return compactionAssets(sections, found, assetPlaces(sections, found), facts)
}
