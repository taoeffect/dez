// A Dez image reference is plain text in a text node, in the exact form that
// the user asked for: `![<absolute path>]()`. The path is the alt text and
// the destination is empty. Only paths into an app image folder
// (`…/assets/images/<name>.<ext>`, as `dez.controller/images/save` writes
// them) count. Any other markdown image (a URL, a hand-written path) stays
// plain text: it is not rendered and not sent as an image. So what Dez shows
// and sends matches what the asset protocol scope (tauri.conf.json) and the
// Rust app-file path rule allow. The editor, the request builder, and the
// title, preview, and search text all use this one recognizer.

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

/** The folder of the stored images, relative to the app folder. The asset
 *  protocol scope in tauri.conf.json serves only the files directly in it,
 *  and `IMAGE_PATH_SOURCE` below spells the same folder. */
export const IMAGE_FOLDER = 'assets/images'

// An absolute path whose last two folders are `assets/images`. The path may
// not hold `[`, `]`, or a line break: `]` would end the alt text early, and
// with `[` excluded too, a search from one `![` stops at the next bracket, so
// a long line cannot make the regex slow.
const IMAGE_PATH_SOURCE = String.raw`\/(?:[^\[\]\r\n]*\/)?assets\/images\/[A-Za-z0-9_-]+\.(?:${Object.keys(MEDIA_TYPE_BY_EXTENSION).join('|')})`
const IMAGE_PATH = new RegExp(`^${IMAGE_PATH_SOURCE}$`)
const IMAGE_REFERENCE = new RegExp(String.raw`!\[(${IMAGE_PATH_SOURCE})\]\(\)`, 'g')

/** The text that stands for an image where a path would be noise: tab
 *  titles, history previews, and the message to a model that cannot read
 *  images. */
export const IMAGE_LABEL = '[image]'

/** One image reference in a text. */
export interface ImageReference {
  /** Offset of the `!`. */
  from: number
  /** Offset after the `)`. */
  to: number
  path: string
}

/** A run of a text: plain text, or one image reference. */
export type ImageTextPiece =
  | { kind: 'text'; text: string }
  | { kind: 'image'; path: string }

/** The image references in a text, in order. */
export function findImageReferences(text: string): ImageReference[] {
  return Array.from(text.matchAll(IMAGE_REFERENCE), (match) => ({
    from: match.index,
    to: match.index + match[0].length,
    path: match[1],
  }))
}

/** True when `imageMarkdown(path)` is a reference that the recognizer finds. */
export function isImagePath(path: string): boolean {
  return IMAGE_PATH.test(path)
}

/** The reference text of an image path. */
export function imageMarkdown(path: string): string {
  return `![${path}]()`
}

/** A text as its plain-text and image pieces, in order. Empty text pieces are
 *  left out; whitespace is kept. */
export function splitImageReferences(text: string): ImageTextPiece[] {
  const pieces: ImageTextPiece[] = []
  let start = 0
  for (const { from, to, path } of findImageReferences(text)) {
    if (from > start) pieces.push({ kind: 'text', text: text.slice(start, from) })
    pieces.push({ kind: 'image', path })
    start = to
  }
  if (start < text.length) pieces.push({ kind: 'text', text: text.slice(start) })
  return pieces
}

/** A text with each image reference replaced by `label`. */
export function labelImageReferences(text: string, label = IMAGE_LABEL): string {
  // A function, so that `$` in the label is not a replacement pattern.
  return text.replace(IMAGE_REFERENCE, () => label)
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
