import { findImageReferences, imageIdChange, type ImageReference } from './images'
import { findMediaTags } from './mediaTags'

// The images and the clips of a conversation share one sequence of ids: the
// `id` item of an image reference (images.ts) and the `id` attribute of a
// media tag (mediaTags.ts). So an id names one thing, of any kind, and the
// user and the models can name it (`@a`, imageMentions.ts). An id is never
// changed after it is given, with one exception: the pasted image
// references of `pastedImageIdChanges`. Only the texts tell which ids are
// taken, so the highest id is given again after its image or clip is
// deleted.
//
// The functions read media tags in every text, with no role check, and
// `pastedImageIdChanges` reads a whole editor doc: a tag line in a user
// section is plain text there, but its id still counts as taken. A new id
// that skips one more letter does no harm.

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

/** The changes to `text`, a whole conversation after a paste or a drop
 *  (the editor doc of one tab), that give the image references that the
 *  paste brought in an id of their own. `pasted` holds the ranges of `text`
 *  that the paste inserted; a reference whose whole text is in one of them
 *  is pasted. A pasted reference with no id, or with an id that a clip or
 *  an image with another path already has, gets the id after the highest
 *  one in `text`. The same path with the same id is the same image, so it
 *  keeps its id. Other references and all media tags, pasted ones too, are
 *  never changed: a later tool history will name images and clips by these
 *  ids, and a change to an earlier message would also break the prompt
 *  cache. */
export function pastedImageIdChanges(text: string, pasted: readonly { from: number, to: number }[]): { from: number, to: number, insert: string }[] {
  const references = findImageReferences(text)
  const tags = findMediaTags(text)
  const isPasted = (reference: ImageReference) => pasted.some((range) => range.from <= reference.from && reference.to <= range.to)
  // What has each id: the paths of its images, and the text of its clips'
  // tags. A tag starts with `<` and a path with `/`, so the two never match.
  const ownersById = new Map<string, Set<string>>()
  const claim = (id: string, owner: string) => {
    const owners = ownersById.get(id)
    if (owners) owners.add(owner)
    else ownersById.set(id, new Set([owner]))
  }
  let highest = highestMediaId([...references.map((reference) => reference.id), ...tags.map((tag) => tag.id)])
  for (const reference of references) {
    if (reference.id !== null && !isPasted(reference)) claim(reference.id, reference.path)
  }
  for (const tag of tags) claim(tag.id, text.slice(tag.from, tag.to))
  const changes: { from: number, to: number, insert: string }[] = []
  for (const reference of references.filter(isPasted)) {
    const { id, path } = reference
    const owners = id === null ? undefined : ownersById.get(id)
    if (id !== null && (!owners || Array.from(owners).every((owner) => owner === path))) {
      claim(id, path)
      continue
    }
    const newId = nextMediaId(highest)
    highest = newId
    claim(newId, path)
    changes.push(imageIdChange(reference, newId))
  }
  return changes
}
