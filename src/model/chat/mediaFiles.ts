import { byteSizeText } from '../../utils/byteSize'
import { fileNameOf } from '../../utils/fileName'
import { MEDIA_CACHE_FOLDER, MEDIA_FOLDERS, isSavedMediaPath, isTempMediaPath, type MediaTagKind } from './mediaTags'

// The files of the clips (audio and video). A clip's tag (mediaTags.ts)
// holds an absolute path in its `src`. This module finds the file that such
// a path names in the two roots of the app-file selectors
// (`dez.native/*AppFile`): a stored clip in the app folder, and a temp copy
// in the cache root. It also names new files, and tells which files a user
// can paste or drop as clips.

/** How long a temp copy stays before the cleanup deletes it. The `expires`
 *  of a tag with a temp copy is a time before the copy's download plus this
 *  lifetime, so the copy is there until then. */
export const MEDIA_TEMP_LIFETIME_MS = 24 * 60 * 60 * 1000

/** The largest clip that Dez stores: Save downloads no larger one,
 *  `dez.provider/generateMedia` takes no larger temp copy (a Save only moves
 *  it), and a paste or a drop leaves out a larger file. */
export const MAX_SAVED_CLIP_BYTES = 1024 ** 3

// The file extension of each media type that Dez gives a file name to.
// Servers name one format in more than one way; the first name of an
// extension is the one that Dez writes (`MEDIA_TYPE_BY_EXTENSION`).
const EXTENSION_BY_MEDIA_TYPE: Readonly<Record<string, string>> = {
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/wave': 'wav',
  'audio/x-wav': 'wav',
  'audio/ogg': 'ogg',
  'audio/flac': 'flac',
  'audio/x-flac': 'flac',
  'audio/mp4': 'm4a',
  'audio/m4a': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/aac': 'aac',
  'audio/opus': 'opus',
}

const MEDIA_EXTENSIONS: ReadonlySet<string> = new Set(Object.values(EXTENSION_BY_MEDIA_TYPE))

// The media type that Dez writes into the tag of a pasted or dropped clip
// file, by the file's extension: the first name of each extension of
// `EXTENSION_BY_MEDIA_TYPE`.
const MEDIA_TYPE_BY_EXTENSION: Readonly<Record<string, string>> = Object.entries(EXTENSION_BY_MEDIA_TYPE)
  .reduce<Record<string, string>>((types, [mediaType, extension]) => {
    types[extension] ??= mediaType
    return types
  }, {})

// A media type with no parameters, in lower case.
function bareMediaType(type: string): string {
  return type.split(';', 1)[0].trim().toLowerCase()
}

/** A media type with no parameters, in lower case, with one name for each
 *  format that Dez knows: `audio/x-flac` is `audio/flac`, `audio/mp3` is
 *  `audio/mpeg`. Another type stays as it is. */
export function canonicalMediaType(type: string): string {
  const mediaType = bareMediaType(type)
  return Object.hasOwn(EXTENSION_BY_MEDIA_TYPE, mediaType) ? MEDIA_TYPE_BY_EXTENSION[EXTENSION_BY_MEDIA_TYPE[mediaType]] : mediaType
}

/** The extensions of the files that Dez takes as clips in a paste or a
 *  drop, for the text that tells the user. */
export const CLIP_FILE_EXTENSIONS: readonly string[] = Object.keys(MEDIA_TYPE_BY_EXTENSION)

/** The kind and the media type of a file that the user pastes or drops,
 *  from its type as the system gives it (can be empty or an alias), else
 *  from the extension of its name. Null for a file that Dez does not store
 *  as a clip. */
export function storableClip(type: string, fileName: string): { kind: MediaTagKind, type: string } | null {
  const extension = mediaFileExtension(type, null) ?? /\.([A-Za-z0-9]+)$/.exec(fileName)?.[1].toLowerCase()
  if (extension === undefined || !Object.hasOwn(MEDIA_TYPE_BY_EXTENSION, extension)) return null
  const mediaType = MEDIA_TYPE_BY_EXTENSION[extension]
  return { kind: mediaType.startsWith('audio/') ? 'audio' : 'video', type: mediaType }
}

/** The app-file path (`assets/…/<kind>/<file>`, relative to the app folder)
 *  of a path that is directly in a media folder of the app folder `appDir`,
 *  generated or pasted. Null for any other path, such as a tag copied from
 *  another home: a file of that name in this folder is another clip, so
 *  Dez must not delete it. */
export function savedMediaFile(path: string, appDir: string): string | null {
  if (!isSavedMediaPath(path)) return null
  const name = fileNameOf(path)
  return Object.values(MEDIA_FOLDERS)
    .flatMap((folders) => Object.values(folders))
    .map((folder) => `${folder}/${name}`)
    .find((file) => path === `${appDir}/${file}`) ?? null
}

/** The app-file path (`media/<file>`, relative to the cache root) of a path
 *  that is directly in the media folder of the cache root `cacheDir`. Null
 *  for any other path. */
export function tempMediaFile(path: string, cacheDir: string): string | null {
  if (!isTempMediaPath(path)) return null
  const file = `${MEDIA_CACHE_FOLDER}/${fileNameOf(path)}`
  return path === `${cacheDir}/${file}` ? file : null
}

// The path of a URL, with no host, query, or fragment: only the path can
// name a file (`https://cdn.mp4` and `…/clip?name=x.mp4` name none). Empty
// for a text that is not a URL.
function urlPath(url: string): string {
  try {
    return new URL(url).pathname
  } catch {
    return ''
  }
}

/** The extension for the file of a clip: from its media type (parameters
 *  and case do not count), else from the path of the clip's URL when that
 *  names a media file. Null when neither tells. */
export function mediaFileExtension(type: string, url: string | null): string | null {
  const mediaType = bareMediaType(type)
  if (Object.hasOwn(EXTENSION_BY_MEDIA_TYPE, mediaType)) return EXTENSION_BY_MEDIA_TYPE[mediaType]
  const extension = /\.([A-Za-z0-9]+)$/.exec(urlPath(url ?? ''))?.[1].toLowerCase()
  return extension !== undefined && MEDIA_EXTENSIONS.has(extension) ? extension : null
}

/** Why `dez.controller/media/readClip` read no bytes of a clip:
 *  - `deleted`: the clip has no source: its saved file was deleted, and it
 *    has no URL.
 *  - `expired`: no source gave the bytes, and the clip's `expires` time is
 *    past.
 *  - `unreadable`: no source gave the bytes for another cause (a missing
 *    file, a network failure, a refusal of the server). */
export type ClipReadProblem = 'deleted' | 'expired' | 'unreadable'

/** The error of a clip whose bytes Dez could not read. Each caller words
 *  the problem for its own reader (a model, or the user). `details` tell
 *  what each source gave, with no path and no URL, so that a text with
 *  them can go to a chat provider. */
export class ClipReadError extends Error {
  constructor(
    readonly problem: ClipReadProblem,
    readonly details = '',
  ) {
    super(`The clip cannot be read (${problem}).${details === '' ? '' : ` ${details}`}`)
    this.name = 'ClipReadError'
  }
}

/** The error of a file read (`dez.controller/images/readFile`) that stopped
 *  because the file is larger than `maxBytes`. Each caller words it for its
 *  reader. The message holds no path, as a tool can give it to a chat
 *  provider. */
export class FileTooLargeError extends Error {
  constructor(
    readonly size: number,
    readonly maxBytes: number,
  ) {
    super(`The file is ${byteSizeText(size)}, larger than the ${byteSizeText(maxBytes)} that Dez reads.`)
    this.name = 'FileTooLargeError'
  }
}
