import { fileNameOf } from '../../utils/fileName'
import type { Role } from './types'

// A Dez image reference is plain text in a text node:
// `![<absolute path>](<metadata>)`. The path is the alt text, in the exact
// form that the user asked for. The parens (the link destination) hold the
// image's metadata: nothing (references saved before ids existed), or
// `key=value` items joined by `|`, such as `id=a`, and later perhaps
// `id=a|desc=my great image`. The `id` is the image's short name in its
// conversation, from the one id sequence that clips use too (mediaIds.ts):
// the user names one image with it in a message (`@a`, imageMentions.ts),
// and models read it in the reference text. Two forms of path count:
// - Stored: a path into an app image folder (`…/assets/images/<name>.<ext>`
//   or `…/assets/generated/images/…`, as `dez.controller/images/save`
//   writes them). It counts in every section.
// - Linked: any other absolute path with the extension of an image type
//   that Dez stores as it is (`isLinkedImagePath`): a dropped file that Dez
//   linked in place and did not copy (linkedFiles.ts). It counts only in a
//   user section: a model can write any text in its reply, and a linked
//   reference there would let the model choose a file of this computer
//   that Dez then reads, and sends on an `@id` mention.
// Any other markdown image (a URL, a relative path) stays plain text: it is
// not rendered and not sent as an image. The editor, the request builder,
// and the title, preview, and search text all use this one recognizer.
// Providers get no path, only the reference's metadata
// (`withoutStoredFilePaths`, storedFilePaths.ts).

// The image types that Dez stores as they are; the paste and drop code
// converts other image types to PNG. OpenAI, Anthropic, and Venice accept
// the first four ([unverified] GIF on Venice). No provider is known to take
// SVG image parts, so a request gets a PNG copy of an SVG (`requestImage`,
// src/model/providers/selectors.ts); the stored file stays SVG.
const EXTENSION_BY_MEDIA_TYPE = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
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
  svg: 'image/svg+xml',
}

/** The folders of the stored images, relative to the app folder: `pasted`
 *  for pasted and dropped images, `generated` for the images that models
 *  make (image models and chat replies) and that Dez tools make. The path
 *  regexes below are built from these names, so nothing else spells
 *  them. */
export const IMAGE_FOLDERS = {
  pasted: 'assets/images',
  generated: 'assets/generated/images',
} as const

export type ImageFolder = keyof typeof IMAGE_FOLDERS

/** Regex source of the end of every image path: an image folder and a
 *  stored file name. No capture groups. The folder names hold only letters
 *  and `/`, which a regex takes as they are. */
export const IMAGE_PATH_END_SOURCE = String.raw`(?:${Object.values(IMAGE_FOLDERS).join('|')})\/[A-Za-z0-9_-]+\.(?:${Object.keys(MEDIA_TYPE_BY_EXTENSION).join('|')})`
// An absolute path whose last folders are an image folder. The path may not
// hold `[`, `]`, or a line break: `]` would end the alt text early, and with
// `[` excluded too, a search from one `![` stops at the next bracket, so a
// long line cannot make the regex slow.
const IMAGE_PATH_SOURCE = String.raw`\/(?:[^\[\]\r\n]*\/)?${IMAGE_PATH_END_SOURCE}`
const IMAGE_PATH = new RegExp(`^${IMAGE_PATH_SOURCE}$`)

// `png` as `[pP][nN][gG]`: an extension in any letter case, in a regex
// with no `i` flag (the metadata keys must stay lower case).
const anyCase = (word: string) => [...word].map((char) => `[${char.toLowerCase()}${char.toUpperCase()}]`).join('')
/** Regex source of a linked image path (`isLinkedImagePath`), and of a
 *  stored one too: an absolute path that ends with the extension of an
 *  image type that Dez stores as it is, in any letter case (a camera names
 *  its photos `IMG_0001.JPG`). The path holds no bracket, as a stored one
 *  does not, and no control char or sentinel (content.ts), which would
 *  break the editor's line and section scan. No capture groups. */
export const LINKED_IMAGE_PATH_SOURCE = String.raw`\/[^\[\]\u0000-\u001F\u007F\uE000-\uE003]*\.(?:${Object.keys(MEDIA_TYPE_BY_EXTENSION).map(anyCase).join('|')})`
const LINKED_IMAGE_PATH = new RegExp(`^${LINKED_IMAGE_PATH_SOURCE}$`)

// One metadata item: a lower-case key, `=`, and a one-line value in which a
// `\` escapes `|`, `(`, `)`, or `\`; every other char stands for itself. An
// unescaped `(` or `)` cannot be in a value, so the scan of a reference stops
// at its own `)`. A `|` or a space in a value is not valid in a CommonMark
// destination, but other markdown viewers do not show Dez references anyway.
const METADATA_ITEM_SOURCE = String.raw`[a-z][a-z0-9_-]*=(?:[^\\|()\r\n]|\\[\\|()])*`
// Any absolute path as the alt text: `findImageReferences` then keeps the
// stored and the linked paths that count in the section. Global and
// shared: `findImageReferences` resets `lastIndex` on each call.
const IMAGE_REFERENCE = new RegExp(String.raw`!\[(\/[^\[\]\r\n]*)\]\((${METADATA_ITEM_SOURCE}(?:\|${METADATA_ITEM_SOURCE})*)?\)`, 'g')
// A whole image reference at the end of a text of a request, in which a
// word stands for its path (`withoutStoredFilePaths`: `![image](id=a)`).
// The alt text has no bracket and no line break, as a path has none, so
// the match cannot start in an earlier reference.
const REQUEST_REFERENCE_AT_END = new RegExp(String.raw`!\[[^\[\]\r\n]*\]\((?:${METADATA_ITEM_SOURCE}(?:\|${METADATA_ITEM_SOURCE})*)?\)$`)

/** An image id: lower-case letters, given in the order of the one id
 *  sequence (mediaIds.ts). The `@id` mentions (imageMentions.ts) and the
 *  media tags (mediaTags.ts) use the same source. */
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

/** The metadata key of an image that a Dez tool made, as in
 *  `![<path>](id=b|tool=image)`; its value is the name of the
 *  tool. Such a reference is in an agent section, but it is no part of what
 *  the model wrote in its reply (`roundThinking`, streams/messages.ts). */
export const IMAGE_TOOL_KEY = 'tool'

/** The metadata key of an image that a call made as a part of its work
 *  (`is_intermediate` of `model_invoke`), as in
 *  `![<path>](id=b|tool=model_invoke|hidden=j-k3x9)`; its value is the id
 *  of the Dez job that made the image. The editor shows such an image
 *  under the chip of the call that started that job, and not at the place
 *  of its reference (hiddenAssets.ts). It is an image as any other: it has
 *  its id, and a message can name it with `@id`. */
export const IMAGE_HIDDEN_KEY = 'hidden'

/** One image reference in a text. */
export interface ImageReference {
  /** Offset of the `!`. */
  from: number
  /** Offset after the `)`. */
  to: number
  path: string
  /** True for a linked path (`isLinkedImagePath`): the file is not one that
   *  Dez stores, so Dez never deletes it. */
  linked: boolean
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

/** The image references in a text of a section with the role `role`, in
 *  order: a linked path counts only in a user section (see the top of this
 *  file). */
export function findImageReferences(text: string, role: Role): ImageReference[] {
  const references: ImageReference[] = []
  IMAGE_REFERENCE.lastIndex = 0
  for (let match = IMAGE_REFERENCE.exec(text); match; match = IMAGE_REFERENCE.exec(text)) {
    const path = match[1]
    const linked = !isImagePath(path)
    const metadata = linked && (role !== 'user' || !LINKED_IMAGE_PATH.test(path)) ? null : parseImageMetadata(match[2] ?? '')
    // A path may hold a `)`, so a reference can start in the metadata of a
    // match that does not count, for bad metadata or a path that is no
    // image path (`![/a.txt](x=![/b)/c.png]()`): the scan goes on just
    // after the `!`.
    if (!metadata) {
      IMAGE_REFERENCE.lastIndex = match.index + 1
      continue
    }
    references.push({
      from: match.index,
      to: match.index + match[0].length,
      path,
      linked,
      id: metadata.find((item) => item.key === 'id')?.value ?? null,
      metadata,
    })
  }
  return references
}

/** The offset of the image reference that ends `text`, a text of a request
 *  in which a word stands for each stored image path (`![image](id=a)`,
 *  storedFilePaths.ts); null when no reference ends it. */
export function requestImageReferenceStart(text: string): number | null {
  return REQUEST_REFERENCE_AT_END.exec(text)?.index ?? null
}

/** True for a stored image path: a path into an app image folder, which
 *  counts as an image in every section (see the top of this file). */
export function isImagePath(path: string): boolean {
  return IMAGE_PATH.test(path)
}

/** True for a linked image path: an absolute path with the extension of an
 *  image type that Dez stores as it is (`LINKED_IMAGE_PATH_SOURCE`), and no
 *  stored image path. It counts as an image in a user section only. */
export function isLinkedImagePath(path: string): boolean {
  return LINKED_IMAGE_PATH.test(path) && !isImagePath(path)
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

/** The change to the text of `reference` that gives it the id `id`. It
 *  replaces only the text in the parens, and keeps the other items. */
export function imageIdChange(reference: ImageReference, id: string): { from: number, to: number, insert: string } {
  const { metadata, path } = reference
  const withId = reference.id === null
    ? [{ key: 'id', value: id }, ...metadata]
    : metadata.map((item) => (item.key === 'id' ? { key: 'id', value: id } : item))
  // The parens start after `![`, the path, and `](`.
  return { from: reference.from + path.length + 4, to: reference.to - 1, insert: metadataText(withId) }
}

/** A text of a section with the role `role` as its plain-text and image
 *  pieces, in order. Empty text pieces are left out; whitespace is kept. */
export function splitImageReferences(text: string, role: Role): ImageTextPiece[] {
  const pieces: ImageTextPiece[] = []
  let start = 0
  for (const { from, to, path } of findImageReferences(text, role)) {
    if (from > start) pieces.push({ kind: 'text', text: text.slice(start, from) })
    pieces.push({ kind: 'image', path, source: text.slice(from, to) })
    start = to
  }
  if (start < text.length) pieces.push({ kind: 'text', text: text.slice(start) })
  return pieces
}

/** A text of a section with the role `role`, with each image reference
 *  replaced by `label`. */
export function labelImageReferences(text: string, role: Role, label = IMAGE_LABEL): string {
  return splitImageReferences(text, role).map((piece) => (piece.kind === 'text' ? piece.text : label)).join('')
}

/** True for an image type that Dez stores as it is. */
export function isImageMediaType(type: string): type is ImageMediaType {
  return Object.hasOwn(EXTENSION_BY_MEDIA_TYPE, type)
}

/** The file extension that Dez gives a stored image of this type. */
export function imageExtension(mediaType: ImageMediaType): string {
  return EXTENSION_BY_MEDIA_TYPE[mediaType]
}

/** The media type of an image path, from its extension in any letter case.
 *  Null for an extension that Dez does not store. */
export function imageMediaType(path: string): ImageMediaType | null {
  const dot = path.lastIndexOf('.')
  if (dot < 0) return null
  const extension = path.slice(dot + 1).toLowerCase()
  return Object.hasOwn(MEDIA_TYPE_BY_EXTENSION, extension) ? MEDIA_TYPE_BY_EXTENSION[extension] : null
}
