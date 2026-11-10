import { fileNameOf } from '../../utils/fileName'

// A Dez image reference is plain text in a text node:
// `![<absolute path>](<metadata>)`. The path is the alt text, in the exact
// form that the user asked for. The parens (the link destination) hold the
// image's metadata: nothing (references saved before ids existed), or
// `key=value` items joined by `|`, such as `id=a`, and later perhaps
// `id=a|desc=my great image`. The `id` is the image's short name in its
// conversation, from the one id sequence that clips use too (mediaIds.ts):
// the user names one image with it in a message (`@a`, imageMentions.ts),
// and models read it in the reference text. Only paths into an app image
// folder (`…/assets/images/<name>.<ext>` or `…/assets/generated/images/…`,
// as `dez.controller/images/save` writes them) count. Any other markdown image
// (a URL, a hand-written path) stays plain text: it is not rendered and not
// sent as an image. So what Dez shows and sends matches what the asset
// protocol scope (tauri.conf.json) and the Rust app-file path rule allow.
// The editor, the request builder, and the title, preview, and search text
// all use this one recognizer. Providers get no path, only the reference's
// metadata (`withoutStoredFilePaths`, storedFilePaths.ts).

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

// One metadata item: a lower-case key, `=`, and a one-line value in which a
// `\` escapes `|`, `(`, `)`, or `\`; every other char stands for itself. An
// unescaped `(` or `)` cannot be in a value, so the scan of a reference stops
// at its own `)`. A `|` or a space in a value is not valid in a CommonMark
// destination, but other markdown viewers do not show Dez references anyway.
const METADATA_ITEM_SOURCE = String.raw`[a-z][a-z0-9_-]*=(?:[^\\|()\r\n]|\\[\\|()])*`
// Global and shared: `findImageReferences` resets `lastIndex` on each call.
const IMAGE_REFERENCE = new RegExp(String.raw`!\[(${IMAGE_PATH_SOURCE})\]\((${METADATA_ITEM_SOURCE}(?:\|${METADATA_ITEM_SOURCE})*)?\)`, 'g')

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
