import { findAssetMentions } from './imageMentions'
import { findImageReferences, imageIdChange } from './images'
import { findMediaTags, mediaTagText } from './mediaTags'

// The images and the clips of a conversation share one sequence of ids: the
// `id` item of an image reference (images.ts) and the `id` attribute of a
// media tag (mediaTags.ts). So an id names one thing, of any kind, and the
// user and the models can name it (`@a`, imageMentions.ts). An id that is
// in a conversation never changes. Only what a paste brings in can get
// another id, at the paste (`pastedMediaIdChanges`). Only the texts tell
// which ids are taken, so the highest id is given again after its image or
// clip is deleted.
//
// The functions read media tags in every text, with no role check, and
// `pastedMediaIdChanges` reads a whole editor doc: a tag counts in every
// section, user (a pasted or dropped clip) or agent.

/** A range of a text. */
interface TextRange {
  from: number
  to: number
}

/** A change to a text: `insert` in place of a range. */
interface TextChange extends TextRange {
  insert: string
}

/** One image reference or one media tag of a text. */
interface Asset extends TextRange {
  /** Null for an image reference with no id. */
  id: string | null
  /** What the asset is: the path of an image, the tag text of a clip. A tag
   *  starts with `<` and a path with `/`, so the two never match. */
  owner: string
  /** The change to the text that gives the asset this id. */
  withId: (id: string) => TextChange
}

/** Ids in their order (`nextMediaId`): shorter first, then by letters. */
function compareMediaIds(a: string, b: string): number {
  if (a.length !== b.length) return a.length - b.length
  return a < b ? -1 : a > b ? 1 : 0
}

/** The id after `id`: `a` … `z`, `aa`, `ab`, … `zz`, `aaa`, … (like
 *  spreadsheet columns). `a` after null. */
function nextMediaId(id: string | null): string {
  if (id === null) return 'a'
  let index = id.length - 1
  while (index >= 0 && id[index] === 'z') index--
  if (index < 0) return 'a'.repeat(id.length + 1)
  return id.slice(0, index) + String.fromCharCode(id.charCodeAt(index) + 1) + 'a'.repeat(id.length - index - 1)
}

/** The highest of these ids (`compareMediaIds`); null when there is none. */
function highestMediaId(ids: Iterable<string | null>): string | null {
  let highest: string | null = null
  for (const id of ids) {
    if (id !== null && (highest === null || compareMediaIds(id, highest) > 0)) highest = id
  }
  return highest
}

/** `count` ids, in order, for the image references and the media tags that
 *  Dez itself adds to a conversation (a generated image, a generated clip):
 *  the ids after the highest one in the image references and the media tags
 *  of `texts`, the texts of the whole conversation. The caller must write
 *  the references and the tags in the same tick, so that no paste in
 *  between takes an id. */
export function newMediaIds(texts: readonly string[], count: number): string[] {
  let id = highestMediaId(texts.flatMap((text) => [
    ...findImageReferences(text).map((reference) => reference.id),
    ...findMediaTags(text).map((tag) => tag.id),
  ]))
  return Array.from({ length: count }, () => (id = nextMediaId(id)))
}

/** The image references and the media tags of `text`, in doc order. */
function findAssets(text: string): Asset[] {
  const references = findImageReferences(text).map((reference): Asset => ({
    from: reference.from,
    to: reference.to,
    id: reference.id,
    owner: reference.path,
    withId: (id) => imageIdChange(reference, id),
  }))
  const tags = findMediaTags(text).map((tag): Asset => ({
    from: tag.from,
    to: tag.to,
    id: tag.id,
    owner: text.slice(tag.from, tag.to),
    // A tag has no change in place: its whole text is written again, which
    // keeps the attributes that Dez does not know (mediaTags.ts).
    withId: (id) => ({ from: tag.from, to: tag.to, insert: mediaTagText({ ...tag, id }) }),
  }))
  return [...references, ...tags].sort((a, b) => a.from - b.from)
}

/** The changes to `text`, a whole conversation after a paste or a drop
 *  (the editor doc of one tab), that give the image references and the
 *  media tags that the paste brought in an id of their own: a text copied
 *  from another tab holds the ids of that tab. `pasted` holds the ranges of
 *  `text` that the paste inserted; a reference or a tag whose whole text is
 *  in one of them is pasted.
 *
 *  - A pasted reference or tag with no id (a new image), or with an id
 *    that another image or clip of `text` has, gets the id after the
 *    highest one in `text`. The pasted ones are read in doc order, so an
 *    earlier one keeps an id that a later one has too.
 *  - The same image (the same path) or the same clip (the same tag text)
 *    with the same id is a copy: it keeps its id. When that id is taken,
 *    all the pasted copies get one new id.
 *  - An `@id` mention (imageMentions.ts) in the pasted text goes with its
 *    image or clip: when a pasted reference or tag gets a new id, each
 *    pasted mention of its old id gets the new one. Without this, a pasted
 *    "edit @a" would name another image of this conversation, and a
 *    request would send that one. When two pasted assets had the same id,
 *    its mentions go with the last one, as a request takes the last image
 *    of an id (`sectionsToStreamMessages`, streams/messages.ts). This
 *    covers the text of a pasted `<dez:tool>` block too. An id in any other
 *    form (a bare `a` in a tool argument) stays: nothing tells that it is
 *    an id.
 *  - Nothing that was not pasted changes: a later tool history will name
 *    images and clips by these ids, and a change to an earlier message
 *    would also break the prompt cache.
 *
 *  The changes are in doc order, and no two overlap. */
export function pastedMediaIdChanges(text: string, pasted: readonly TextRange[]): TextChange[] {
  const isPasted = ({ from, to }: TextRange) => pasted.some((range) => range.from <= from && to <= range.to)
  const assets = findAssets(text)
  const ownersById = new Map<string, Set<string>>()
  const claim = (id: string, owner: string) => {
    const owners = ownersById.get(id)
    if (owners) owners.add(owner)
    else ownersById.set(id, new Set([owner]))
  }
  let highest = highestMediaId(assets.map((asset) => asset.id))
  for (const asset of assets) {
    if (asset.id !== null && !isPasted(asset)) claim(asset.id, asset.owner)
  }
  const changes: TextChange[] = []
  // The new id of each id that changed, for the pasted mentions of the old
  // one. The last pasted asset of an id counts.
  const newIds = new Map<string, string>()
  // The new id of a pasted asset by its old id and its owner, so that the
  // pasted copies of one image or clip get one new id. An id has only
  // letters (`IMAGE_ID_SOURCE`), so the first `\n` ends it.
  const copyIds = new Map<string, string>()
  let changedTo = 0
  for (const asset of assets.filter(isPasted)) {
    // A tag holds any text in its attribute values, so it can hold a whole
    // image reference. When the tag is written again, a change to that
    // reference would overlap the tag's change: the reference stays.
    if (asset.from < changedTo) continue
    const owners = asset.id === null ? undefined : ownersById.get(asset.id)
    let id = asset.id
    if (id === null || (owners && Array.from(owners).some((owner) => owner !== asset.owner))) {
      const copyKey = id === null ? null : `${id}\n${asset.owner}`
      id = (copyKey === null ? undefined : copyIds.get(copyKey)) ?? (highest = nextMediaId(highest))
      if (copyKey !== null) copyIds.set(copyKey, id)
      changes.push(asset.withId(id))
      changedTo = asset.to
    }
    claim(id, asset.owner)
    if (asset.id !== null) {
      if (asset.id === id) newIds.delete(asset.id)
      else newIds.set(asset.id, id)
    }
  }
  if (newIds.size === 0) return changes

  // The mentions are read in each whole run of text between two assets, not
  // only in its pasted part, so that the chars around a mention count: a
  // pasted `@a` before the letters `bc` is the word `@abc`.
  let textFrom = 0
  for (const next of [...assets, { from: text.length, to: text.length }]) {
    for (const mention of findAssetMentions(text.slice(textFrom, next.from))) {
      const id = newIds.get(mention.id)
      const range = { from: textFrom + mention.from, to: textFrom + mention.to }
      // The change keeps the `@`.
      if (id !== undefined && isPasted(range)) changes.push({ from: range.from + 1, to: range.to, insert: id })
    }
    textFrom = Math.max(textFrom, next.to)
  }
  return changes.sort((a, b) => a.from - b.from)
}
