import type { MentionSection } from './assetMentions'
import { compactionLastId, linkedRuleParts, partsImageReferences, partsMediaTags } from './compaction'
import { IMAGE_HIDDEN_KEY, IMAGE_KEPT_KEY, IMAGE_MADE_BY_KEY, IMAGE_TOOL_KEY, imageMarkdown, type ImageReference } from './images'
import { findAssets, highestMediaId, nextMediaId, pastedMediaIdChanges, pastedMentions, type TextChange, type TextRange } from './mediaIds'
import {
  isLinkedMediaPath,
  MEDIA_HIDDEN_ATTRIBUTE,
  MEDIA_KEPT_ATTRIBUTE,
  MEDIA_MADE_BY_ATTRIBUTE,
  MEDIA_TOOL_ATTRIBUTE,
  mediaTagText,
  sectionClipSource,
  type MediaTagData,
} from './mediaTags'
import type { Role } from './types'

// The rules of a paste of `@id` mentions (imageMentions.ts) into another tab
// than the one of the copy. A mention names an image or a clip by its id,
// and an id names another asset, or none, in another conversation. So at
// the copy, the editor records the asset that each copied mention names
// (`mentionedAssets`), and at the paste it makes the mentions name the same
// assets in the new conversation (`mentionPastePlan`):
//
// - A mention names an asset by the rules of a request (`namedMentions`,
//   assetMentions.ts): the last image of its id in its own section or an
//   earlier one, else the last clip of its id there.
// - Only a pasted mention of an id that no pasted image or clip has
//   counts. A pasted asset and its mentions follow the paste rule of
//   `pastedMediaIdChanges` (mediaIds.ts), as before.
// - An asset that the new conversation names at the paste place (the same
//   image path, or the same clip `src`, or the same `url` when neither has
//   a `src`) is present: its mentions get its id there, and no copy goes
//   in.
// - Any other asset is missing: a copy of its reference or tag goes in, on
//   a line of its own at the start of the line where the paste starts, in
//   the order of the first mention of each asset. So each mention comes
//   after its asset, in the same section. The copy names the same file:
//   Dez copies no file. It leaves out the marks that tie an asset to its
//   own conversation (tool, made by, hidden, kept), and keeps the rest.
// - A copy takes the id of the same asset elsewhere in the conversation,
//   else its own id when no asset has it, else a new id (mediaIds.ts).
// - A linked file is copied only into a user section, where a linked path
//   counts (images.ts): a model's text must never make Dez read a file of
//   the computer. In another section, its mentions stay as pasted.
//
// The editor applies the plan in the transaction of the paste, and its
// `pastedMediaIds` filter then runs `pastedMediaIdChanges` on that
// transaction. So the plan must leave that filter nothing to change: it
// gives the pasted assets their new ids itself, with the copies in place.
// Without that, a pasted `![id=b](…)` that gets a new id would also take
// a mention that the plan changed to `@b`, for an asset of the new
// conversation.

/** An image or a clip that a mention of a copied text names, as its
 *  reference or tag was at the copy. The source tab can change or close
 *  before the paste. */
export type MentionedAsset =
  | { kind: 'image', reference: Pick<ImageReference, 'path' | 'linked' | 'metadata'> }
  | { kind: 'clip', tag: MediaTagData }

/** A mention of a copied text: its id, and the index of its section in the
 *  conversation. */
export interface CopiedMention {
  section: number
  id: string
}

/** The asset that each of `mentions` names in `sections` (the conversation
 *  of the copy, in order), by the id of the mention. A mention that names
 *  nothing is left out. A clip in a part of a section where its linked
 *  `src` does not count (`sectionClipSource`) is kept with no `src`, as a
 *  request reads it. When two mentions of one id name two assets, the
 *  last mention wins. */
export function mentionedAssets(sections: readonly MentionSection[], mentions: readonly CopiedMention[]): Map<string, MentionedAsset> {
  const images = new Map<string, MentionedAsset>()
  const clips = new Map<string, MentionedAsset>()
  const named = new Map<string, MentionedAsset>()
  sections.forEach(({ role, text }, index) => {
    const parts = linkedRuleParts(role, text, index)
    for (const { id, path, linked, metadata } of partsImageReferences(parts)) {
      if (id !== null) images.set(id, { kind: 'image', reference: { path, linked, metadata } })
    }
    for (const { tag: { kind, id, type, src, url, expires, other }, rule } of partsMediaTags(parts)) {
      clips.set(id, { kind: 'clip', tag: { kind, id, type, src: sectionClipSource(src, rule), url, expires, other } })
    }
    for (const mention of mentions) {
      if (mention.section !== index) continue
      const asset = images.get(mention.id) ?? clips.get(mention.id)
      if (asset) named.set(mention.id, asset)
    }
  })
  return named
}

/** A section of the editor doc after a plain paste. */
export interface PastedDocSection {
  role: Role
  /** The offset of `text` in the doc. */
  from: number
  text: string
}

/** The editor doc of the new tab after a plain paste of a copied text. */
export interface PastedDoc {
  doc: string
  /** All the sections of `doc`, in order. */
  sections: readonly PastedDocSection[]
  /** The range of `doc` that the paste inserted. */
  pasted: TextRange
}

/** What a paste of mentions changes in the doc after the plain paste. */
export interface MentionPastePlan {
  /** The changes to the pasted text (mentions, and the ids of the pasted
   *  assets), with offsets in the doc after the plain paste, in order, with
   *  no overlap. None starts before `copiesAt`. */
  changes: TextChange[]
  /** The offset of the copies in that doc. */
  copiesAt: number
  /** The text of each copy, one line each, in order. Each goes in followed
   *  by a line break. */
  copies: string[]
  /** The new id of each mentioned id that changes. */
  idChanges: ReadonlyMap<string, string>
}

// The marks that tie an asset to its own conversation: a copy leaves them
// out.
const COPY_LEFT_OUT_IMAGE_KEYS: ReadonlySet<string> = new Set([IMAGE_TOOL_KEY, IMAGE_MADE_BY_KEY, IMAGE_HIDDEN_KEY, IMAGE_KEPT_KEY])
const COPY_LEFT_OUT_TAG_ATTRIBUTES: ReadonlySet<string> = new Set([MEDIA_TOOL_ATTRIBUTE, MEDIA_MADE_BY_ATTRIBUTE, MEDIA_HIDDEN_ATTRIBUTE, MEDIA_KEPT_ATTRIBUTE])

// What makes two assets the same asset: the path of an image; the `src` of
// a clip, or its `url` when it has no `src`. Null for a clip with neither,
// which is the same as no other clip.
const imageIdentity = (path: string) => `image\n${path}`
function clipIdentity({ kind, src, url }: Pick<MediaTagData, 'kind' | 'src' | 'url'>): string | null {
  if (src !== null) return `${kind}\nsrc\n${src}`
  return url === null ? null : `${kind}\nurl\n${url}`
}
function identity(asset: MentionedAsset): string | null {
  return asset.kind === 'image' ? imageIdentity(asset.reference.path) : clipIdentity(asset.tag)
}

// Whether the asset has a linked file (linkedFiles.ts).
function isLinked(asset: MentionedAsset): boolean {
  return asset.kind === 'image' ? asset.reference.linked : asset.tag.src !== null && isLinkedMediaPath(asset.tag.src)
}

// The reference or tag text of a copy of `asset` with the id `id`.
function copyText(asset: MentionedAsset, id: string): string {
  if (asset.kind === 'image') {
    const metadata = asset.reference.metadata
      .filter((item) => !COPY_LEFT_OUT_IMAGE_KEYS.has(item.key))
      .map((item) => (item.key === 'id' ? { key: 'id', value: id } : item))
    return imageMarkdown(asset.reference.path, metadata)
  }
  return mediaTagText({ ...asset.tag, id, other: asset.tag.other.filter((attribute) => !COPY_LEFT_OUT_TAG_ATTRIBUTES.has(attribute.name)) })
}

// The owner of a copy with the id `id`, as `findAssets` reads it
// (mediaIds.ts): the path of an image, the tag text of a clip.
function copyOwner(asset: MentionedAsset, id: string): string {
  return asset.kind === 'image' ? asset.reference.path : copyText(asset, id)
}

/** An asset that a mention at the paste place names. */
interface NamedAsset {
  identity: string | null
  /** The offset of the asset in the doc. */
  from: number
}

// The assets that a mention at the paste place names, by id: the ones of
// `sections` (the sections up to the one of the paste place) that are not
// in `pasted`, by the rules of a request (see the top of this file).
function namedAssets(sections: readonly PastedDocSection[], pasted: TextRange): Map<string, NamedAsset> {
  const isPasted = (from: number, to: number) => pasted.from <= from && to <= pasted.to
  const images = new Map<string, NamedAsset>()
  const clips = new Map<string, NamedAsset>()
  sections.forEach(({ role, from: sectionFrom, text }, index) => {
    const parts = linkedRuleParts(role, text, index)
    for (const { id, path, from, to } of partsImageReferences(parts)) {
      if (id !== null && !isPasted(sectionFrom + from, sectionFrom + to)) images.set(id, { identity: imageIdentity(path), from: sectionFrom + from })
    }
    for (const { tag, rule } of partsMediaTags(parts)) {
      if (isPasted(sectionFrom + tag.from, sectionFrom + tag.to)) continue
      clips.set(tag.id, { identity: clipIdentity({ ...tag, src: sectionClipSource(tag.src, rule) }), from: sectionFrom + tag.from })
    }
  })
  // An id that an image and a clip both have names the image.
  return new Map([...clips, ...images])
}

// The id at the paste place of the asset `sourceId` with this identity: its
// own id when that id names it there, else the id of the latest asset in
// the doc that has it. Undefined when none has it.
function presentId(named: ReadonlyMap<string, NamedAsset>, sourceId: string, assetIdentity: string): string | undefined {
  if (named.get(sourceId)?.identity === assetIdentity) return sourceId
  let found: { id: string, from: number } | undefined
  for (const [id, asset] of named) {
    if (asset.identity === assetIdentity && (found === undefined || asset.from > found.from)) found = { id, from: asset.from }
  }
  return found?.id
}

/** The paste of the mentions of a copied text into another tab, on the doc
 *  of that tab after the plain paste (`PastedDoc`). `record` holds the
 *  assets that the copy's mentions name (`mentionedAssets`). Null when the
 *  paste is the plain paste: no copy goes in, and no mention changes. See
 *  the top of this file for the rules. */
export function mentionPastePlan({ doc, sections, pasted }: PastedDoc, record: ReadonlyMap<string, MentionedAsset>): MentionPastePlan | null {
  const isPasted = ({ from, to }: TextRange) => pasted.from <= from && to <= pasted.to
  const assets = findAssets(doc)
  const pastedIds = new Set(assets.filter(isPasted).map((asset) => asset.id))
  const mentions = pastedMentions(doc, assets, [pasted]).filter((mention) => record.has(mention.id) && !pastedIds.has(mention.id))
  if (mentions.length === 0) return null

  const placeIndex = sections.findLastIndex((section) => section.from <= pasted.from)
  const place = sections[placeIndex]
  const named = namedAssets(sections.slice(0, placeIndex + 1), pasted)
  // The id of each mentioned asset that is present, and the index of the
  // copy of each one that is missing.
  const presentIds = new Map<string, string>()
  const copyIndexes = new Map<string, number>()
  const copies: { asset: MentionedAsset, sourceId: string }[] = []
  // The copy of each identity, so that two mentioned ids of one file get
  // one copy.
  const copyIndexByIdentity = new Map<string, number>()
  // The ids in the order of their first mention, which is the order of the
  // copies.
  for (const sourceId of new Set(mentions.map((mention) => mention.id))) {
    const asset = record.get(sourceId)
    if (asset === undefined) continue
    const assetIdentity = identity(asset)
    const present = assetIdentity === null ? undefined : presentId(named, sourceId, assetIdentity)
    if (present !== undefined) {
      presentIds.set(sourceId, present)
      continue
    }
    if (isLinked(asset) && place.role !== 'user') continue
    let index = assetIdentity === null ? undefined : copyIndexByIdentity.get(assetIdentity)
    if (index === undefined) {
      index = copies.push({ asset, sourceId }) - 1
      if (assetIdentity !== null) copyIndexByIdentity.set(assetIdentity, index)
    }
    copyIndexes.set(sourceId, index)
  }

  const copyIds = newCopyIds(doc, assets.filter((asset) => !isPasted(asset)), new Set(assets.map((asset) => asset.id)), copies)
  const idChanges = new Map<string, string>()
  for (const [sourceId, id] of presentIds) {
    if (id !== sourceId) idChanges.set(sourceId, id)
  }
  for (const [sourceId, index] of copyIndexes) {
    if (copyIds[index] !== sourceId) idChanges.set(sourceId, copyIds[index])
  }
  if (copies.length === 0 && idChanges.size === 0) return null

  const lineStart = pasted.from === 0 ? 0 : doc.lastIndexOf('\n', pasted.from - 1) + 1
  const copiesAt = Math.max(lineStart, place.from)
  const copyLines = copies.map(({ asset }, index) => copyText(asset, copyIds[index]))
  // The new ids of the pasted assets, read with the copies in place (see the
  // top of this file). The copies come first in the doc, and no other asset
  // has their ids, so they keep them.
  const copiesText = copyLines.map((line) => `${line}\n`).join('')
  const withCopies = doc.slice(0, copiesAt) + copiesText + doc.slice(copiesAt)
  const shift = copiesText.length
  const changes = pastedMediaIdChanges(withCopies, [{ from: copiesAt, to: copiesAt + shift }, { from: pasted.from + shift, to: pasted.to + shift }])
    .map(({ from, to, insert }) => ({ from: from - shift, to: to - shift, insert }))
  for (const mention of mentions) {
    const id = idChanges.get(mention.id)
    // The change keeps the `@`.
    if (id !== undefined) changes.push({ from: mention.from + 1, to: mention.to, insert: id })
  }
  return { changes: changes.sort((a, b) => a.from - b.from), copiesAt, copies: copyLines, idChanges }
}

// The id of each copy, in order (see the top of this file): the id of the
// same asset elsewhere in the doc, which no other asset there has; else its
// own id, when no asset of the doc (`docIds`) and no earlier copy has it;
// else the next id after the highest one of the doc and of the copies.
// `others` are the assets of the doc that were not pasted.
function newCopyIds(
  doc: string,
  others: readonly { id: string | null, owner: string }[],
  docIds: ReadonlySet<string | null>,
  copies: readonly { asset: MentionedAsset, sourceId: string }[],
): string[] {
  const ownersById = new Map<string, Set<string>>()
  for (const { id, owner } of others) {
    if (id !== null) ownersById.set(id, (ownersById.get(id) ?? new Set()).add(owner))
  }
  const taken = new Set<string>()
  const ids = copies.map(({ asset, sourceId }) => {
    const sameAsset = others.find(({ id, owner }) => {
      if (id === null || taken.has(id) || owner !== copyOwner(asset, id)) return false
      return ownersById.get(id)?.size === 1
    })?.id ?? null
    const id = sameAsset ?? (docIds.has(sourceId) || taken.has(sourceId) ? null : sourceId)
    if (id !== null) taken.add(id)
    return id
  })
  let highest = highestMediaId([compactionLastId(doc), ...docIds, ...ids])
  return ids.map((id) => id ?? (highest = nextMediaId(highest)))
}
