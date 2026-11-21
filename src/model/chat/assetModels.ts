import { SENTINEL_CHAR } from './content'
import { IMAGE_MODEL_KEY, IMAGE_TOOL_KEY, type ImageMetadataItem, type ImageReference } from './images'
import { MEDIA_MODEL_ATTRIBUTE, MEDIA_TOOL_ATTRIBUTE, type MediaTagAttribute, type MediaTagData } from './mediaTags'
import { modelRefKey, parseModelRefKey } from './modelRef'
import type { ModelRef, Section } from './types'

// The model that made an image or a clip. Dez writes it as a mark of the
// asset when it writes the asset (`IMAGE_MODEL_KEY`, `MEDIA_MODEL_ATTRIBUTE`):
// on the images and the clips of a reply, the model of the reply, and on
// the assets of a `model_invoke` job, the model that the job called. The
// mark stays with the asset through a compaction (the tool block that
// started a job goes, the reference stays) and in a copy that a mention
// paste makes (mentionPaste.ts). Assets that no model made (a paste, a
// drop, the `image`, `audio`, `video`, and `apps` tools) have none.

// A char that the mark cannot hold: a line break ends the alt text of an
// image reference, and a control char or a sentinel (content.ts) breaks
// the editor's line and section scan.
const NOT_MARK_CHAR = /[\u0000-\u001F\u007F]/

// The value of the model mark of an asset that `model` made; null when its
// `modelRefKey` holds a char that the text of an asset cannot hold.
function modelMarkValue(model: ModelRef): string | null {
  const key = modelRefKey(model)
  return NOT_MARK_CHAR.test(key) || SENTINEL_CHAR.test(key) ? null : key
}

/** The model mark of an image that `model` made, as the items to put in
 *  its metadata: none for no model, or for a model whose key cannot be a
 *  metadata value. */
export function imageModelMark(model: ModelRef | undefined): ImageMetadataItem[] {
  const value = model === undefined ? null : modelMarkValue(model)
  return value === null ? [] : [{ key: IMAGE_MODEL_KEY, value }]
}

/** The model mark of a clip that `model` made, as the attributes to put in
 *  the other attributes of its tag, as `imageModelMark` for an image. */
export function clipModelMark(model: ModelRef | undefined): MediaTagAttribute[] {
  const value = model === undefined ? null : modelMarkValue(model)
  return value === null ? [] : [{ name: MEDIA_MODEL_ATTRIBUTE, value }]
}

/** An image or a clip as the marks of its text: the metadata items of an
 *  image reference, or the other attributes of a clip's tag. */
export type MarkedAsset = Pick<ImageReference, 'metadata'> | Pick<MediaTagData, 'other'>

// The model mark and the tool mark of `asset`; null for a mark that it
// does not have.
function marksOf(asset: MarkedAsset): { model: string | null, tool: string | null } {
  if ('metadata' in asset) {
    const mark = (key: string) => asset.metadata.find((item) => item.key === key)?.value ?? null
    return { model: mark(IMAGE_MODEL_KEY), tool: mark(IMAGE_TOOL_KEY) }
  }
  const mark = (name: string) => asset.other.find((attribute) => attribute.name === name)?.value ?? null
  return { model: mark(MEDIA_MODEL_ATTRIBUTE), tool: mark(MEDIA_TOOL_ATTRIBUTE) }
}

/** The model that made `asset`, in `section`, for the label of its view.
 *  Its model mark tells it, in any section. An asset with no mark (or with
 *  a mark that is not a `modelRefKey`) in an agent section, with no tool
 *  mark and out of the compaction block, is one that the model of that
 *  section wrote in its reply before Dez wrote the mark, as `assetPlaces`
 *  (assetOrigins.ts) reads it. Null when nothing tells it: an asset of the
 *  user, of a Dez tool, or in the compaction block (the model of the
 *  compaction wrote the notes, not the assets in them). */
export function assetModel(asset: MarkedAsset, section: Pick<Section, 'role' | 'model'>, inCompactionBlock: boolean): ModelRef | null {
  const marks = marksOf(asset)
  const marked = marks.model === null ? null : parseModelRefKey(marks.model)
  if (marked) return marked
  if (section.role !== 'agent' || inCompactionBlock || marks.tool !== null) return null
  return section.model ?? null
}
