import { fileNameOf } from '../../utils/fileName'
import type { Role } from './types'

// A Dez image reference is plain text in a text node, in the markdown image
// form that other markdown editors show: `![<metadata>](<absolute path>)`.
// The alt text holds the image's metadata: nothing (references saved before
// ids existed), or `key=value` items joined by `|`, such as `id=a`, and
// later perhaps `id=a|desc=my great image`. The destination holds the path,
// in the exact form that the user asked for: as it is, or in `<…>` when it
// holds a space or a paren (CommonMark ends a bare destination at a space).
// The `id` is the image's short name in its conversation, from the one id
// sequence that clips use too (mediaIds.ts): the user names one image with
// it in a message (`@a`, imageMentions.ts), and models read it in the
// reference text. Two forms of path count:
// - Stored: a path into an app image folder (`…/assets/images/<name>.<ext>`
//   or `…/assets/generated/images/…`, as `dez.controller/images/save`
//   writes them). It counts in every section.
// - Linked: any other absolute path with the extension of an image type
//   that Dez stores as it is (`isLinkedImagePath`): a dropped file that Dez
//   linked in place and did not copy (linkedFiles.ts). It counts only where
//   the user put it (`LinkedPathRule`): in a user section, and in the
//   compaction block for a path that its tag lists (compaction.ts). A
//   model can write any text in its reply, and a linked reference there
//   would let the model choose a file of this computer that Dez then
//   reads, and sends on an `@id` mention.
// Any other markdown image (a URL, a relative path, the old form with the
// path in the alt text) stays plain text: it is not rendered and not sent
// as an image. The editor, the request builder, and the title, preview, and
// search text all use this one recognizer. Providers get no path, only the
// reference's metadata (`withoutStoredFilePaths`, storedFilePaths.ts).

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
// hold `[`, `]`, `<`, `>`, or a line break: a bracket would end the alt text
// of a markdown link early, and `<…>` (the destination of a path with a
// space) cannot hold `<`, `>`, or a line break. With brackets excluded too,
// a scan from one `![` stops at the next bracket, so a long line cannot make
// the regex slow.
const IMAGE_PATH_SOURCE = String.raw`\/(?:[^\[\]<>\r\n]*\/)?${IMAGE_PATH_END_SOURCE}`
const IMAGE_PATH = new RegExp(`^${IMAGE_PATH_SOURCE}$`)

// `png` as `[pP][nN][gG]`: an extension in any letter case, in a regex
// with no `i` flag (the metadata keys must stay lower case).
const anyCase = (word: string) => [...word].map((char) => `[${char.toLowerCase()}${char.toUpperCase()}]`).join('')
// The extensions of the image types that Dez stores as they are, in any
// letter case (a camera names its photos `IMG_0001.JPG`).
const IMAGE_EXTENSION_SOURCE = `(?:${Object.keys(MEDIA_TYPE_BY_EXTENSION).map(anyCase).join('|')})`
/** Regex source of a linked image path (`isLinkedImagePath`), and of a
 *  stored one too: an absolute path that ends with the extension of an
 *  image type that Dez stores as it is. The path holds no bracket, `<`, or
 *  `>`, as a stored one does not, and no control char or sentinel
 *  (content.ts), which would break the editor's line and section scan. No
 *  capture groups. */
export const LINKED_IMAGE_PATH_SOURCE = String.raw`\/[^\[\]<>\u0000-\u001F\u007F\uE000-\uE003]*\.${IMAGE_EXTENSION_SOURCE}`
const LINKED_IMAGE_PATH = new RegExp(`^${LINKED_IMAGE_PATH_SOURCE}$`)
// The chars of a path that CommonMark does not take in a bare destination:
// a path with one goes in `<…>`.
const NOT_BARE_PATH_CHAR = String.raw`\s()\u0000-\u001F\u007F`
const NOT_BARE_PATH = new RegExp(`[${NOT_BARE_PATH_CHAR}]`)
/** Regex source of the destination of a markdown link or image that holds
 *  a linked or stored image path (`LINKED_IMAGE_PATH_SOURCE`): the path in
 *  `<…>`, or the path as it is when it holds no char that a bare
 *  destination ends at. No capture groups. */
export const IMAGE_DESTINATION_SOURCE = String.raw`(?:<${LINKED_IMAGE_PATH_SOURCE}>|\/[^${NOT_BARE_PATH_CHAR}\[\]<>\uE000-\uE003]*\.${IMAGE_EXTENSION_SOURCE})`

// One metadata item: a lower-case key, `=`, and a one-line value in which a
// `\` escapes `\`, `|`, `[`, or `]`; every other char stands for itself, so
// `metadataText` gives back the text of the items char for char. An
// unescaped `]` cannot be in a value, so the alt text ends at its own `]`,
// as it does in CommonMark. A `|` splits a GFM table row, but references on
// a table row are not shown as images anyway (`findRenderedImages`).
const METADATA_ITEM_SOURCE = String.raw`[a-z][a-z0-9_-]*=(?:[^\\|\[\]\r\n]|\\[\\|\[\]])*`
const METADATA_SOURCE = String.raw`${METADATA_ITEM_SOURCE}(?:\|${METADATA_ITEM_SOURCE})*`
// Group 1 is the metadata; group 2 an absolute path in `<…>`, or group 3 a
// bare one: `findImageReferences` then keeps the stored and the linked
// paths that count in the section. Global and shared:
// `findImageReferences` resets `lastIndex` on each call.
const IMAGE_REFERENCE = new RegExp(String.raw`!\[(${METADATA_SOURCE})?\]\((?:<(\/[^\[\]<>\r\n]*)>|(\/[^${NOT_BARE_PATH_CHAR}\[\]<>]*))\)`, 'g')
// A whole image reference at the end of a text of a request, in which a
// word stands for its path (`withoutStoredFilePaths`: `![id=a](image)`).
// The alt text has no unescaped bracket, so the match cannot start in an
// earlier reference.
const REQUEST_REFERENCE_AT_END = new RegExp(String.raw`!\[(?:${METADATA_SOURCE})?\]\([^${NOT_BARE_PATH_CHAR}\[\]<>]*\)$`)

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
 *  `![id=b|tool=image](<path>)`; its value is the name of the
 *  tool. Such a reference is in an agent section, but it is no part of what
 *  the model wrote in its reply (`roundThinking`, streams/messages.ts). */
export const IMAGE_TOOL_KEY = 'tool'

/** The metadata key of an image that a call made as a part of its work
 *  (`is_intermediate` of `model_invoke` or of a `video` subcommand), as in
 *  `![id=b|tool=model_invoke|made-by=j-k3x9|hidden=j-k3x9](<path>)`; its
 *  value is the id of the Dez job that made the image. The editor shows
 *  such an image under the chip of the call that started that job, and not
 *  at the place of its reference (hiddenAssets.ts). It is an image as any
 *  other: it has its id, and a message can name it with `@id`. */
export const IMAGE_HIDDEN_KEY = 'hidden'

/** The metadata key of an image that a Dez job made, hidden or not, as in
 *  `![id=b|tool=model_invoke|made-by=j-k3x9](<path>)`; its value is the id
 *  of the job. `asset_info` (tools/assetInfo.ts) finds the call that
 *  started the job by it, in the same agent section. A job id is unique
 *  only in its reply, which is one agent section. */
export const IMAGE_MADE_BY_KEY = 'made-by'

/** The metadata key of an image that a compaction kept as one line of its
 *  notes and not as pixels (compaction.ts), as in
 *  `![id=b|kept=compaction](<path>)`; its value is `KEPT_MARK_VALUE`. In
 *  the compaction message of a request, such a reference sends no image by
 *  itself (streams/messages.ts), also in a message part of the notes. In
 *  the section of the carried assets of the user of an older Dez, the
 *  editor shows the image in the panel of the assets chip of the
 *  compaction, and not at the place of its reference (hiddenAssets.ts). At
 *  any other place the mark does nothing for the editor: the panel shows
 *  every asset of the compaction block, with or without the mark. */
export const IMAGE_KEPT_KEY = 'kept'

/** The value of the kept mark of an image (`IMAGE_KEPT_KEY`) and of a clip
 *  (`MEDIA_KEPT_ATTRIBUTE`, mediaTags.ts). */
export const KEPT_MARK_VALUE = 'compaction'

/** One image reference in a text. */
export interface ImageReference {
  /** Offset of the `!`. */
  from: number
  /** Offset after the destination's `)`. */
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
 *  other text in its alt text, so the user sees that it is not valid. */
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

/** The alt text of a reference with these items. */
function metadataText(metadata: readonly ImageMetadataItem[]): string {
  return metadata.map(({ key, value }) => `${key}=${value.replace(/[\\|[\]]/g, '\\$&')}`).join('|')
}

/** The destination text of an image path: `<path>` for a path with a
 *  char that ends a bare destination, else the path. */
function destinationText(path: string): string {
  return NOT_BARE_PATH.test(path) ? `<${path}>` : path
}

/** Where the linked paths of a text count (see the top of this file):
 *  `'user'` for a user section (every linked path counts), `'agent'` for
 *  an agent section (none counts), or the paths that count, for the
 *  compaction block, whose tag lists the linked paths that the user gave
 *  (`linkedRuleParts`, compaction.ts). A model never sees a linked path (a
 *  request holds no path), so it cannot copy one into its notes. */
export type LinkedPathRule = Role | ReadonlySet<string>

/** Whether the linked path `path` counts in a text with the rule `rule`. */
export function linkedPathCounts(path: string, rule: LinkedPathRule): boolean {
  return rule === 'user' || (typeof rule !== 'string' && rule.has(path))
}

/** The image references in a text whose linked paths count by `rule`, in
 *  order (see the top of this file). */
export function findImageReferences(text: string, rule: LinkedPathRule): ImageReference[] {
  const references: ImageReference[] = []
  IMAGE_REFERENCE.lastIndex = 0
  // No `![` can start inside a match after its own `!`: the alt text holds
  // a `[` only after a `\`, and the path holds none. So the scan goes on
  // after a match that does not count.
  for (let match = IMAGE_REFERENCE.exec(text); match; match = IMAGE_REFERENCE.exec(text)) {
    const path = match[2] ?? match[3]
    const linked = !isImagePath(path)
    const metadata = linked && (!LINKED_IMAGE_PATH.test(path) || !linkedPathCounts(path, rule)) ? null : parseImageMetadata(match[1] ?? '')
    if (!metadata) continue
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
 *  in which a word stands for each stored image path (`![id=a](image)`,
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
 *  stored image path. It counts as an image only where its rule lets it
 *  (`LinkedPathRule`). */
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
 *  order. Each value must be one line; `|`, `[`, `]`, and `\` in it are
 *  escaped. */
export function imageMarkdown(path: string, metadata: readonly ImageMetadataItem[] = []): string {
  return `![${metadataText(metadata)}](${destinationText(path)})`
}

/** The change to the text of `reference` that gives it the id `id`. It
 *  replaces only the alt text, keeps the other items, and keeps the
 *  destination as it is in the text. */
export function imageIdChange(reference: ImageReference, id: string): { from: number, to: number, insert: string } {
  const { metadata } = reference
  const withId = reference.id === null
    ? [{ key: 'id', value: id }, ...metadata]
    : metadata.map((item) => (item.key === 'id' ? { key: 'id', value: id } : item))
  // The alt text starts after `![`, and its text is the one of its items
  // (`METADATA_ITEM_SOURCE`).
  const from = reference.from + 2
  return { from, to: from + metadataText(metadata).length, insert: metadataText(withId) }
}

/** Whether `reference` has the kept mark (`IMAGE_KEPT_KEY`). */
export function isKeptImage(reference: Pick<ImageReference, 'metadata'>): boolean {
  return reference.metadata.some((item) => item.key === IMAGE_KEPT_KEY)
}

/** The text of `reference` with the kept mark (`kept`), or with none. Its
 *  other items stay, in their order. */
export function imageReferenceTextWithKeptMark(reference: Pick<ImageReference, 'path' | 'metadata'>, kept: boolean): string {
  const others = reference.metadata.filter((item) => item.key !== IMAGE_KEPT_KEY)
  return imageMarkdown(reference.path, kept ? [...others, { key: IMAGE_KEPT_KEY, value: KEPT_MARK_VALUE }] : others)
}

/** A text whose linked paths count by `rule` as its plain-text and image
 *  pieces, in order. Empty text pieces are left out; whitespace is kept. */
export function splitImageReferences(text: string, rule: LinkedPathRule): ImageTextPiece[] {
  const pieces: ImageTextPiece[] = []
  let start = 0
  for (const { from, to, path } of findImageReferences(text, rule)) {
    if (from > start) pieces.push({ kind: 'text', text: text.slice(start, from) })
    pieces.push({ kind: 'image', path, source: text.slice(from, to) })
    start = to
  }
  if (start < text.length) pieces.push({ kind: 'text', text: text.slice(start) })
  return pieces
}

/** A text whose linked paths count by `rule`, with each image reference
 *  replaced by `label`. */
export function labelImageReferences(text: string, rule: LinkedPathRule, label = IMAGE_LABEL): string {
  return splitImageReferences(text, rule).map((piece) => (piece.kind === 'text' ? piece.text : label)).join('')
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
