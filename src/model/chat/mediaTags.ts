import { MARKER_ATTRIBUTES, escapeMarkerAttribute, markerAttributes } from '../../utils/markerAttribute'
import { stripLiveSentinels } from './content'
import { IMAGE_ID_SOURCE } from './images'

// A clip that a model made (audio or video) is plain text in an agent
// section, as an image reference and a tool call are: no content node kind
// and no sentinel. It is one self-closing tag on a line of its own.
// Conversation files and clipboard text hold it as it is. This module is
// the one place that writes and recognizes it; requests, the id sequence
// (mediaIds.ts), and the search, preview, and Markdown text all call it.
//
//   <dez:video id="b" type="video/mp4" src="https://cdn.example/v.mp4?sig=1" url="https://cdn.example/v.mp4?sig=1" expires="2026-11-11T09:30:00.000Z"/>
//
// - A tag is one whole line: it starts at the text start or after `\n`, and
//   ends at the text end or before `\n`. The name is `dez:audio` or
//   `dez:video`. A tag with no valid `id` or with no `type` is plain text,
//   so the user sees that it is not valid.
// - Attributes (the grammar of markerAttribute.ts), written in this order:
//   - `id`: the clip's short name in its conversation, from the one id
//     sequence that images use too (mediaIds.ts). It never changes.
//   - `type`: the media type, such as `video/mp4`.
//   - `src`: the source that plays now: the saved file (an absolute path in
//     a folder of `MEDIA_FOLDERS`), else the temp copy (an absolute path in
//     `MEDIA_CACHE_FOLDER` of the cache root), else the value of `url`. A
//     clip that has no source any more has no `src`.
//   - `url`: the provider's URL of the clip, when the provider gave one. It
//     never changes, so that a clip can go back to it when its saved file
//     is deleted. It is a signed URL, which is a secret.
//   - `expires`: the ISO time after which the source that is not saved (the
//     URL, or the temp copy) stops working.
//   - Any other attribute is metadata that Dez does not know here. A
//     rewrite (read a tag, change fields, write it) keeps it, after the
//     known attributes and in its order.
// - Tags count in agent sections only; in a user section the same text is
//   plain text. Callers check the role, and find tags in one section at a
//   time.
// - Answer text from a model is escaped (`ModelTextEscaper`, toolBlocks.ts),
//   so a model cannot write a tag.
// - A provider gets only the request form (`mediaTagRequestText`).

/** The kinds of clips: the tag of a kind is `dez:<kind>`. */
export const MEDIA_TAG_KINDS = ['audio', 'video'] as const

export type MediaTagKind = typeof MEDIA_TAG_KINDS[number]

/** The names of the media tags, for the escape of model text. */
export const MEDIA_TAG_NAMES: readonly string[] = MEDIA_TAG_KINDS.map((kind) => `dez:${kind}`)

/** The folders of the saved clips, relative to the app folder. The asset
 *  protocol scope in tauri.conf.json serves only the files directly in
 *  them, and the path regexes below are built from these names, so nothing
 *  else spells them. */
export const MEDIA_FOLDERS = {
  audio: 'assets/generated/audio',
  video: 'assets/generated/video',
} as const satisfies Record<MediaTagKind, string>

// The name of Dez's folder in the OS cache folder (`~/.cache` on Linux):
// the `cache` root of the app-file selectors. `root_dir` in
// src-tauri/src/persistence.rs builds the same folder.
const CACHE_ROOT_NAME = 'dez'

/** The folder of the temp copies of the clips that are not saved, relative
 *  to the cache root. It is outside the app folder, so that clips that the
 *  user did not save do not fill it. The asset protocol scope in
 *  tauri.conf.json serves only the files directly in it. */
export const MEDIA_CACHE_FOLDER = 'media'

// A stored file name with any extension. The path scrub must not depend on
// the list of the media types that Dez can save.
const MEDIA_FILE_NAME_SOURCE = String.raw`[A-Za-z0-9_-]+\.[A-Za-z0-9]+`

// The folder names hold only letters and `/`, which a regex takes as they
// are.
const pathEndSource = (folder: string) => String.raw`${folder}\/${MEDIA_FILE_NAME_SOURCE}`

/** Regex source of the end of every saved clip's path, by kind: a media
 *  folder and a stored file name. No capture groups. */
export const SAVED_MEDIA_PATH_END_SOURCES: Readonly<Record<MediaTagKind, string>> = {
  audio: pathEndSource(MEDIA_FOLDERS.audio),
  video: pathEndSource(MEDIA_FOLDERS.video),
}

/** Regex source of the end of every temp copy's path. No capture groups. */
export const MEDIA_CACHE_PATH_END_SOURCE = pathEndSource(`${CACHE_ROOT_NAME}/${MEDIA_CACHE_FOLDER}`)

// An absolute path, on one line, that ends with `endSource`.
const absolutePath = (endSource: string) => new RegExp(String.raw`^\/(?:[^\r\n]*\/)?(?:${endSource})$`)
const SAVED_MEDIA_PATH = absolutePath(Object.values(SAVED_MEDIA_PATH_END_SOURCES).join('|'))
const TEMP_MEDIA_PATH = absolutePath(MEDIA_CACHE_PATH_END_SOURCE)

/** True for the path of a saved clip: an absolute path to a file directly
 *  in a media folder. A temp copy and a URL are not one. */
export function isSavedMediaPath(path: string): boolean {
  return SAVED_MEDIA_PATH.test(path)
}

/** True for the path of a temp copy: an absolute path to a file directly in
 *  the media folder of a cache root. */
export function isTempMediaPath(path: string): boolean {
  return TEMP_MEDIA_PATH.test(path)
}

/** One attribute of a tag that Dez does not know here. */
export interface MediaTagAttribute {
  name: string
  value: string
}

/** One clip, as a tag holds it. A field that is null has no attribute. */
export interface MediaTagData {
  kind: MediaTagKind
  id: string
  type: string
  src: string | null
  url: string | null
  expires: string | null
  /** The other attributes, in text order. A name must fit the attribute
   *  grammar (markerAttribute.ts); one with the name of a field above is
   *  not written. */
  other: readonly MediaTagAttribute[]
}

/** One tag in a text. */
export interface MediaTag extends MediaTagData {
  /** Offset of the `<`. */
  from: number
  /** Offset after the `>`. */
  to: number
}

/** A run of a text: plain text, or one media tag. */
export type MediaTextPiece =
  | { kind: 'text'; text: string }
  | { kind: 'media'; tag: MediaTag }

const TAG_PREFIX = '<dez:'
// Tested on one line only, so the `\s` of the attribute rule cannot cross a
// line break. The second group holds the attributes.
const TAG_LINE = new RegExp(String.raw`^<dez:(${MEDIA_TAG_KINDS.join('|')})(${MARKER_ATTRIBUTES})\/>$`)
const MEDIA_ID = new RegExp(`^${IMAGE_ID_SOURCE}$`)
const FIELD_ATTRIBUTES = ['id', 'type', 'src', 'url', 'expires'] as const

// The text of a tag with these attributes, in this order. Live sentinels in
// doc text break the editor's section and pill scan, and a value can come
// from a provider, so the writer removes them.
function tagText(kind: MediaTagKind, attributes: Iterable<readonly [string, string]>): string {
  let tag = `${TAG_PREFIX}${kind}`
  for (const [name, value] of attributes) tag += ` ${name}="${escapeMarkerAttribute(stripLiveSentinels(value))}"`
  return `${tag}/>`
}

/** The text of a tag: one line, with live sentinels removed from every
 *  value. */
export function mediaTagText(tag: MediaTagData): string {
  // A Map keeps the first position of a name, and the fields come first.
  const attributes = new Map<string, string>()
  for (const name of FIELD_ATTRIBUTES) {
    const value = tag[name]
    if (value !== null) attributes.set(name, value)
  }
  for (const { name, value } of tag.other) {
    if (!FIELD_ATTRIBUTES.some((field) => field === name)) attributes.set(name, value)
  }
  return tagText(tag.kind, attributes)
}

/** A tag as a provider gets it: only its `id` and `type`.
 *
 *    <dez:video id="b" type="video/mp4"/>
 *
 *  So a model reads the id and can name the clip. The form has no `src`,
 *  `url`, `expires`, or other attribute: no local path and no signed URL
 *  goes to a provider, and a save, a delete, or an expiry of the clip never
 *  changes the bytes of an earlier message (prompt cache). */
export function mediaTagRequestText(tag: Pick<MediaTagData, 'kind' | 'id' | 'type'>): string {
  return tagText(tag.kind, [['id', tag.id], ['type', tag.type]])
}

// `expires` tells the end of the source that is not saved. Both functions
// below keep it only with a `url`: it is then the end of that URL, which
// the clip needs again when its saved file is deleted. The end of a temp
// copy means nothing once the copy is a saved file.

/** The tag of a clip after its file was saved at `path` (Save): the saved
 *  file is the source that plays. */
export function savedMediaTag<T extends MediaTagData>(tag: T, path: string): T {
  return { ...tag, src: path, expires: tag.url === null ? null : tag.expires }
}

/** The tag of a saved clip after its file was deleted: the clip plays from
 *  its `url` again, and a clip with no `url` has no source any more. */
export function unsavedMediaTag<T extends MediaTagData>(tag: T): T {
  return { ...tag, src: tag.url, expires: tag.url === null ? null : tag.expires }
}

// The tag that is the whole of `line`; null when the line is not a tag. An
// attribute with an empty value reads as one that is not there.
function readTag(line: string): MediaTagData | null {
  const match = TAG_LINE.exec(line)
  if (!match) return null
  const attributes = markerAttributes(match[2])
  const id = attributes.get('id')
  const type = attributes.get('type')
  if (id === undefined || !MEDIA_ID.test(id) || type === undefined || type.trim() === '') return null
  const other: MediaTagAttribute[] = []
  for (const [name, value] of attributes) {
    if (!FIELD_ATTRIBUTES.some((field) => field === name)) other.push({ name, value })
  }
  return {
    kind: match[1] as MediaTagKind,
    id,
    type,
    src: attributes.get('src') || null,
    url: attributes.get('url') || null,
    expires: attributes.get('expires') || null,
    other,
  }
}

/** The media tags in a text, in order. */
export function findMediaTags(text: string): MediaTag[] {
  const tags: MediaTag[] = []
  for (let from = text.indexOf(TAG_PREFIX); from >= 0;) {
    if (from > 0 && text[from - 1] !== '\n') {
      from = text.indexOf(TAG_PREFIX, from + 1)
      continue
    }
    const lineEnd = text.indexOf('\n', from)
    const to = lineEnd < 0 ? text.length : lineEnd
    const tag = readTag(text.slice(from, to))
    if (tag) tags.push({ ...tag, from, to })
    // The rest of this line holds no line start.
    from = text.indexOf(TAG_PREFIX, to)
  }
  return tags
}

/** A text as its plain-text and media tag pieces, in order. Empty text
 *  pieces are left out; whitespace is kept. */
export function splitMediaTags(text: string): MediaTextPiece[] {
  const pieces: MediaTextPiece[] = []
  let start = 0
  for (const tag of findMediaTags(text)) {
    if (tag.from > start) pieces.push({ kind: 'text', text: text.slice(start, tag.from) })
    pieces.push({ kind: 'media', tag })
    start = tag.to
  }
  if (start < text.length) pieces.push({ kind: 'text', text: text.slice(start) })
  return pieces
}

/** The text that stands for a clip of each kind in history previews and
 *  Markdown text. */
export const MEDIA_TAG_LABELS: Readonly<Record<MediaTagKind, string>> = {
  audio: '[audio]',
  video: '[video]',
}

/** A text with each media tag replaced by `label`, or by the label of its
 *  kind when there is none. */
export function labelMediaTags(text: string, label?: string): string {
  return splitMediaTags(text).map((piece) => (piece.kind === 'text' ? piece.text : label ?? MEDIA_TAG_LABELS[piece.tag.kind])).join('')
}

// `target` as the destination of a Markdown link. CommonMark takes a plain
// destination only with no space, control char, `<`, or unbalanced paren;
// any other one goes in `<…>`, where `\` escapes `<`, `>`, and `\`. No
// destination can hold a line break: null for such a target.
function linkDestination(target: string): string | null {
  if (/[\r\n]/.test(target)) return null
  if (/^[^\s()<>\\\p{Cc}]+$/u.test(target)) return target
  return `<${target.replace(/[\\<>]/g, '\\$&')}>`
}

/** A text for people to read (Copy Markdown, Save As Markdown), with each
 *  media tag as a Markdown link, `[video](<target>)`: to the saved file
 *  when the clip has one, else to the provider's URL when it has one. A
 *  clip with neither gives only its label: a temp copy is not a lasting
 *  target. */
export function mediaTagsAsLinks(text: string): string {
  return splitMediaTags(text).map((piece) => {
    if (piece.kind === 'text') return piece.text
    const { kind, src, url } = piece.tag
    const target = src !== null && isSavedMediaPath(src) ? src : url
    const destination = target === null ? null : linkDestination(target)
    return destination === null ? MEDIA_TAG_LABELS[kind] : `${MEDIA_TAG_LABELS[kind]}(${destination})`
  }).join('')
}
