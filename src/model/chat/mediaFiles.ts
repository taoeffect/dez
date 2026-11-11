import { fileNameOf } from '../../utils/fileName'
import { MEDIA_CACHE_FOLDER, MEDIA_FOLDERS, isSavedMediaPath, isTempMediaPath } from './mediaTags'

// The files of the clips (audio and video) that models make. A clip's tag
// (mediaTags.ts) holds an absolute path in its `src`. This module finds the
// file that such a path names in the two roots of the app-file selectors
// (`dez.native/*AppFile`): a saved clip in the app folder, and a temp copy
// in the cache root. It also names new files.

/** How long a temp copy stays before the cleanup deletes it. The `expires`
 *  of a tag with a temp copy is a time before the copy's download plus this
 *  lifetime, so the copy is there until then. */
export const MEDIA_TEMP_LIFETIME_MS = 24 * 60 * 60 * 1000

// The file extension of each media type that Dez gives a file name to.
// Servers name one format in more than one way.
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

/** The app-file path (`assets/generated/<kind>/<file>`, relative to the app
 *  folder) of a path that is directly in a media folder of the app folder
 *  `appDir`. Null for any other path, such as a tag copied from another
 *  home: a file of that name in this folder is another clip, so Dez must not
 *  delete it. */
export function savedMediaFile(path: string, appDir: string): string | null {
  if (!isSavedMediaPath(path)) return null
  const name = fileNameOf(path)
  return Object.values(MEDIA_FOLDERS)
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
  const mediaType = type.split(';', 1)[0].trim().toLowerCase()
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
