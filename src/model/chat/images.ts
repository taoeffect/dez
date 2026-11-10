import { fileNameOf } from '../../utils/fileName'

// A Dez image reference is plain text in a text node:
// `![<absolute path>](<metadata>)`. The path is the alt text, in the exact
// form that the user asked for. The parens (the link destination) hold the
// image's metadata: nothing (references saved before ids existed), or
// `key=value` items joined by `|`, such as `id=a`, and later perhaps
// `id=a|desc=my great image`. The `id` is the image's short name in its
// conversation (`pastedImageIdChanges`, `newImageIds`): the user names one
// image with it in a message (`@a`, imageMentions.ts), and models read it
// in the reference text. Only paths into an app image folder
// (`…/assets/images/<name>.<ext>` or `…/assets/generated/images/…`, as
// `dez.controller/images/save` writes them) count. Any other markdown image
// (a URL, a hand-written path) stays plain text: it is not rendered and not
// sent as an image. So what Dez shows and sends matches what the asset
// protocol scope (tauri.conf.json) and the Rust app-file path rule allow.
// The editor, the request builder, and the title, preview, and search text
// all use this one recognizer. Providers get no path, only the reference's
// metadata (`withoutImagePaths`).

// The image types that Dez stores as they are; the paste and drop code
// converts other image types to PNG. OpenAI, Anthropic, and Venice accept
// all four ([unverified] GIF on Venice).
const EXTENSION_BY_MEDIA_TYPE = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
} as const

export type ImageMediaType = keyof typeof EXTENSION_BY_MEDIA_TYPE

// Read only after an `Object.hasOwn` check, so that a name such as
// `constructor` finds nothing.
const MEDIA_TYPE_BY_EXTENSION: Record<string, ImageMediaType> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
}

/** The folders of the stored images, relative to the app folder: `pasted`
 *  for pasted and dropped images, `generated` for the images that image
 *  models make. The asset protocol scope in tauri.conf.json serves only the
 *  files directly in them, and the path regexes below are built from these
 *  names, so nothing else spells them. */
export const IMAGE_FOLDERS = {
  pasted: 'assets/images',
  generated: 'assets/generated/images',
} as const

export type ImageFolder = keyof typeof IMAGE_FOLDERS

// The end of every image path: an image folder and a stored file name. The
// folder names hold only letters and `/`, which a regex takes as they are.
const IMAGE_PATH_END_SOURCE = String.raw`(?:${Object.values(IMAGE_FOLDERS).join('|')})\/[A-Za-z0-9_-]+\.(?:${Object.keys(MEDIA_TYPE_BY_EXTENSION).join('|')})`
// An absolute path whose last folders are an image folder. The path may not
// hold `[`, `]`, or a line break: `]` would end the alt text early, and with
// `[` excluded too, a search from one `![` stops at the next bracket, so a
// long line cannot make the regex slow.
const IMAGE_PATH_SOURCE = String.raw`\/(?:[^\[\]\r\n]*\/)?${IMAGE_PATH_END_SOURCE}`
const IMAGE_PATH = new RegExp(`^${IMAGE_PATH_SOURCE}$`)
// The end of every image path that Dez writes, on any machine and in any
// home: `$HOME/.config/dez/<image folder>/<file>` (`base_dir()` in
// persistence.rs). Many web projects have an `assets/images` folder too
// (Angular, Rails, Hugo); the scrub leaves their paths as they are, so code
// and commands go to the model as the user wrote them.
const DEZ_IMAGE_PATH_END_SOURCE = String.raw`\/\.config\/dez\/${IMAGE_PATH_END_SOURCE}`
// A text holds a Dez image path exactly when it holds one of these ends.
// Global for `matchAll` only, which copies the regex and keeps no state in it.
const DEZ_IMAGE_PATH_END = new RegExp(DEZ_IMAGE_PATH_END_SOURCE, 'g')
// Not global, so `test` keeps no `lastIndex` state between calls.
const ANY_DEZ_IMAGE_PATH_END = new RegExp(DEZ_IMAGE_PATH_END_SOURCE)
// A run of text with no bracket or line break, the chars that no image path
// holds.
const BRACKET_FREE_RUN = /[^\[\]\r\n]+/g

/** The word that stands for each image path in a text for a provider. */
const IMAGE_PATH_STAND_IN = 'image'

// One metadata item: a lower-case key, `=`, and a one-line value in which a
// `\` escapes `|`, `(`, `)`, or `\`; every other char stands for itself. An
// unescaped `(` or `)` cannot be in a value, so the scan of a reference stops
// at its own `)`. A `|` or a space in a value is not valid in a CommonMark
// destination, but other markdown viewers do not show Dez references anyway.
const METADATA_ITEM_SOURCE = String.raw`[a-z][a-z0-9_-]*=(?:[^\\|()\r\n]|\\[\\|()])*`
// Global and shared: `findImageReferences` resets `lastIndex` on each call.
const IMAGE_REFERENCE = new RegExp(String.raw`!\[(${IMAGE_PATH_SOURCE})\]\((${METADATA_ITEM_SOURCE}(?:\|${METADATA_ITEM_SOURCE})*)?\)`, 'g')

/** An image id: lower-case letters, given in the order of `nextImageId`.
 *  The `@id` mentions (imageMentions.ts) use the same source. */
export const IMAGE_ID_SOURCE = '[a-z]+'
const IMAGE_ID = new RegExp(`^${IMAGE_ID_SOURCE}$`)

/** The text that stands for a whole image reference in tab titles and
 *  history previews. */
export const IMAGE_LABEL = '[image]'

/** One `key=value` item of a reference's metadata, with no escapes. */
export interface ImageMetadataItem {
  key: string
  value: string
}

/** One image reference in a text. */
export interface ImageReference {
  /** Offset of the `!`. */
  from: number
  /** Offset after the `)`. */
  to: number
  path: string
  /** The value of the `id` item, or null for a reference with no id. */
  id: string | null
  /** All the items, in text order, with the keys that Dez does not know. */
  metadata: readonly ImageMetadataItem[]
}

/** A run of a text: plain text, or one image reference with its text
 *  (`source`) as it is in the text. */
export type ImageTextPiece =
  | { kind: 'text'; text: string }
  | { kind: 'image'; path: string; source: string }

/** The items of a metadata text that `IMAGE_REFERENCE` matched, with the
 *  escapes removed. Null when a key comes twice, or when the id is not
 *  `IMAGE_ID`: the reference then stays plain text, as it does with any
 *  other text in its parens, so the user sees that it is not valid. */
function parseImageMetadata(source: string): ImageMetadataItem[] | null {
  const items: ImageMetadataItem[] = []
  // The text matched the grammar, so each run of unescaped chars other than
  // `|` is one item, and its first `=` ends the key.
  for (const [item] of source.matchAll(/(?:[^\\|]|\\.)+/g)) {
    const equals = item.indexOf('=')
    const key = item.slice(0, equals)
    const value = item.slice(equals + 1).replace(/\\(.)/g, '$1')
    if (items.some((other) => other.key === key)) return null
    if (key === 'id' && !IMAGE_ID.test(value)) return null
    items.push({ key, value })
  }
  return items
}

/** The text in the parens of a reference with these items. */
function metadataText(metadata: readonly ImageMetadataItem[]): string {
  return metadata.map(({ key, value }) => `${key}=${value.replace(/[\\|()]/g, '\\$&')}`).join('|')
}

/** The image references in a text, in order. */
export function findImageReferences(text: string): ImageReference[] {
  const references: ImageReference[] = []
  IMAGE_REFERENCE.lastIndex = 0
  for (let match = IMAGE_REFERENCE.exec(text); match; match = IMAGE_REFERENCE.exec(text)) {
    const metadata = parseImageMetadata(match[2] ?? '')
    // A path may hold a `)`, so a reference can start in the metadata of a
    // match that is not valid (`![p](id=X|x=![/a)/assets/images/b.png]()`):
    // the scan goes on just after the `!`.
    if (!metadata) {
      IMAGE_REFERENCE.lastIndex = match.index + 1
      continue
    }
    references.push({
      from: match.index,
      to: match.index + match[0].length,
      path: match[1],
      id: metadata.find((item) => item.key === 'id')?.value ?? null,
      metadata,
    })
  }
  return references
}

/** True when `imageMarkdown(path)` is a reference that the recognizer finds. */
export function isImagePath(path: string): boolean {
  return IMAGE_PATH.test(path)
}

/** The app-file path (`assets/images/<file>` or
 *  `assets/generated/images/<file>`, relative to the app folder) of an image
 *  path that is directly in an image folder of the app folder `appDir`. Null
 *  for any other path, such as a reference copied from another home: a file
 *  of that name in this folder is another image, so Dez must neither send
 *  nor delete it. */
export function storedImageFile(path: string, appDir: string): string | null {
  if (!isImagePath(path)) return null
  const name = fileNameOf(path)
  return Object.values(IMAGE_FOLDERS)
    .map((folder) => `${folder}/${name}`)
    .find((file) => path === `${appDir}/${file}`) ?? null
}

/** The reference text of an image path, with its metadata items in this
 *  order. Each value must be one line; `|`, `(`, `)`, and `\` in it are
 *  escaped. */
export function imageMarkdown(path: string, metadata: readonly ImageMetadataItem[] = []): string {
  return `![${path}](${metadataText(metadata)})`
}

/** Image ids in their order (`nextImageId`): shorter first, then by
 *  letters. */
function compareImageIds(a: string, b: string): number {
  if (a.length !== b.length) return a.length - b.length
  return a < b ? -1 : a > b ? 1 : 0
}

/** The id after `id`: `a` … `z`, `aa`, `ab`, … `zz`, `aaa`, … (like
 *  spreadsheet columns). `a` after null. */
function nextImageId(id: string | null): string {
  if (id === null) return 'a'
  let index = id.length - 1
  while (index >= 0 && id[index] === 'z') index--
  if (index < 0) return 'a'.repeat(id.length + 1)
  return id.slice(0, index) + String.fromCharCode(id.charCodeAt(index) + 1) + 'a'.repeat(id.length - index - 1)
}

/** The highest of these ids (`compareImageIds`); null when there is none. */
function highestImageId(ids: Iterable<string | null>): string | null {
  let highest: string | null = null
  for (const id of ids) {
    if (id !== null && (highest === null || compareImageIds(id, highest) > 0)) highest = id
  }
  return highest
}

/** `count` ids, in order, for the image references that Dez itself adds to a
 *  conversation (a generated image): the ids after the highest one in
 *  `texts`, the texts of the whole conversation. The caller must write the
 *  references in the same tick, so that no paste in between takes an id. */
export function newImageIds(texts: readonly string[], count: number): string[] {
  let id = highestImageId(texts.flatMap((text) => findImageReferences(text).map((reference) => reference.id)))
  return Array.from({ length: count }, () => (id = nextImageId(id)))
}

/** The changes to `text`, a whole conversation after a paste or a drop
 *  (the editor doc of one tab), that give the image references that the
 *  paste brought in an id of their own. `pasted` holds the ranges of `text`
 *  that the paste inserted; a reference whose whole text is in one of them
 *  is pasted. A pasted reference with no id, or with an id that an image
 *  with another path already has, gets the id after the highest one in
 *  `text`. The same path with the same id is the same image, so it keeps
 *  its id. Other references are never changed: a later tool history will
 *  name images by these ids, and a change to an earlier message would also
 *  break the prompt cache. Each change replaces only the text in the
 *  parens, and keeps the other items. */
export function pastedImageIdChanges(text: string, pasted: readonly { from: number, to: number }[]): { from: number, to: number, insert: string }[] {
  const references = findImageReferences(text)
  const isPasted = (reference: ImageReference) => pasted.some((range) => range.from <= reference.from && reference.to <= range.to)
  const pathsById = new Map<string, Set<string>>()
  const claim = (id: string, path: string) => {
    const paths = pathsById.get(id)
    if (paths) paths.add(path)
    else pathsById.set(id, new Set([path]))
  }
  let highest = highestImageId(references.map((reference) => reference.id))
  for (const reference of references) {
    if (reference.id !== null && !isPasted(reference)) claim(reference.id, reference.path)
  }
  const changes: { from: number, to: number, insert: string }[] = []
  for (const reference of references.filter(isPasted)) {
    const { id, path, metadata } = reference
    const owners = id === null ? undefined : pathsById.get(id)
    if (id !== null && (!owners || Array.from(owners).every((owner) => owner === path))) {
      claim(id, path)
      continue
    }
    const newId = nextImageId(highest)
    highest = newId
    claim(newId, path)
    const withId = id === null
      ? [{ key: 'id', value: newId }, ...metadata]
      : metadata.map((item) => (item.key === 'id' ? { key: 'id', value: newId } : item))
    // The parens start after `![`, the path, and `](`.
    changes.push({ from: reference.from + path.length + 4, to: reference.to - 1, insert: metadataText(withId) })
  }
  return changes
}

/** A text as its plain-text and image pieces, in order. Empty text pieces are
 *  left out; whitespace is kept. */
export function splitImageReferences(text: string): ImageTextPiece[] {
  const pieces: ImageTextPiece[] = []
  let start = 0
  for (const { from, to, path } of findImageReferences(text)) {
    if (from > start) pieces.push({ kind: 'text', text: text.slice(start, from) })
    pieces.push({ kind: 'image', path, source: text.slice(from, to) })
    start = to
  }
  if (start < text.length) pieces.push({ kind: 'text', text: text.slice(start) })
  return pieces
}

/** A text with each image reference replaced by `label`. */
export function labelImageReferences(text: string, label = IMAGE_LABEL): string {
  return splitImageReferences(text).map((piece) => (piece.kind === 'text' ? piece.text : label)).join('')
}

/** True when a text holds a Dez image path, in a reference or not. */
export function holdsImagePath(text: string): boolean {
  return ANY_DEZ_IMAGE_PATH_END.test(text)
}

/** A text for a provider, with each Dez image path replaced by the word
 *  `image`. A provider must never get a path: it holds the user's name and
 *  folders. So a reference goes as `![image](id=a)`, with its metadata as it
 *  is in the text, and a reference that is not valid (the Backspace rule's
 *  `![<path>](id=a`, bad metadata), a bare path, and a path in a metadata
 *  value lose their paths too. A text with no Dez image path comes back as
 *  it is, so text-only request bodies keep their bytes (prompt cache). A
 *  hand-written reference into an `assets/images` folder outside a
 *  `.config/dez` folder keeps its path: Dez never writes one, and a request
 *  that sends it as an image fails first ("Image not found").
 *
 *  A path's start in prose is not known (a home folder can hold spaces), so
 *  each run with no bracket or line break loses all from its first `/` to
 *  the end of its last Dez image path: some prose or a URL before a path can
 *  go too, but never a part of the path. That is what a global regex for a
 *  whole path would replace, in linear time: such a regex rescans the rest
 *  of the run from each `/`, which took 0.5 s on a 200 KB base64 line. */
export function withoutImagePaths(text: string): string {
  if (!holdsImagePath(text)) return text
  return text.replace(BRACKET_FREE_RUN, (run) => {
    let end = -1
    for (const match of run.matchAll(DEZ_IMAGE_PATH_END)) end = match.index + match[0].length
    return end < 0 ? run : `${run.slice(0, run.indexOf('/'))}${IMAGE_PATH_STAND_IN}${run.slice(end)}`
  })
}

/** True for an image type that Dez stores as it is. */
export function isImageMediaType(type: string): type is ImageMediaType {
  return Object.hasOwn(EXTENSION_BY_MEDIA_TYPE, type)
}

/** The file extension that Dez gives a stored image of this type. */
export function imageExtension(mediaType: ImageMediaType): string {
  return EXTENSION_BY_MEDIA_TYPE[mediaType]
}

/** The media type of an image path, from its extension. Null for an
 *  extension that Dez does not store. */
export function imageMediaType(path: string): ImageMediaType | null {
  const dot = path.lastIndexOf('.')
  if (dot < 0) return null
  const extension = path.slice(dot + 1)
  return Object.hasOwn(MEDIA_TYPE_BY_EXTENSION, extension) ? MEDIA_TYPE_BY_EXTENSION[extension] : null
}
