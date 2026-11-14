import sbp from '@sbp/sbp'
import { ClipReadError, MAX_SAVED_CLIP_BYTES } from '../model/chat/mediaFiles'
import { isLinkedMediaPath, isSavedMediaPath, isTempMediaPath, type MediaTagData } from '../model/chat/mediaTags'
import { byteSizeText } from '../utils/byteSize'
import { rawErrorText } from '../utils/errorText'
import type { NativeHttpDownload } from '../utils/protocol/nativeHttp'
import type { AppFileRef } from './nativeTypes'

// Where the clip of a media tag comes from, for the code that uses the
// clip itself (a request that sends it, a tool that works on it): the one
// rule of which sources Dez may take it from, and the download of a clip
// from a web address. This module registers no selector, so that a module
// with no selectors can use it (programRuns.ts).

/** The longest time that Dez waits for the whole download of a clip. A
 *  server that stops sending would keep the Save control, or the tool or
 *  the request that reads the clip, busy with no end. */
const CLIP_DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000

/** The failure of a clip download (`downloadClip`). `status` is the HTTP
 *  status of a server that refused the clip; null when no answer came (the
 *  network failed, the clip is larger than `MAX_SAVED_CLIP_BYTES`, or Dez
 *  could not write the file), and then `cause` is the native error, whose
 *  text can name the URL or the file. The message holds no URL and no path,
 *  so a tool can give it to a chat provider; a text for the user words the
 *  failure itself. */
export class ClipDownloadError extends Error {
  constructor(
    readonly status: number | null,
    options?: ErrorOptions,
  ) {
    super(status === null
      ? `The download of the clip failed: its server gave no answer, the answer broke off, the clip is larger than ${byteSizeText(MAX_SAVED_CLIP_BYTES)}, or Dez could not write the file.`
      : `The server of the clip answered HTTP ${status}.`, options)
    this.name = 'ClipDownloadError'
  }
}

/** Downloads a clip from its http or https URL into `file`, with no
 *  provider header: the URL is a signed one, and a key must not go to the
 *  host of a clip. Rust writes the file, so no byte of the clip crosses the
 *  bridge as a JSON number array, and a clip larger than
 *  `MAX_SAVED_CLIP_BYTES` fails before it fills the memory. A stop of
 *  `signal` cancels the download and rejects with the stop. Any other
 *  failure throws a `ClipDownloadError`. A download that failed can leave a
 *  part of the clip in `file`: the caller deletes it. */
export async function downloadClip (url: string, file: AppFileRef, signal: AbortSignal | undefined): Promise<void> {
  signal?.throwIfAborted()
  const requestId = crypto.randomUUID()
  const cancel = () => {
    sbp('dez.native/cancelHttpStream', requestId).catch((error: unknown) => {
      console.error('Failed to stop the download of a clip:', error)
    })
  }
  signal?.addEventListener('abort', cancel, { once: true })
  try {
    let download: NativeHttpDownload
    try {
      download = await sbp(
        'dez.native/downloadAppFile',
        { method: 'GET', url, timeoutMs: CLIP_DOWNLOAD_TIMEOUT_MS },
        requestId,
        file,
        { maxBytes: MAX_SAVED_CLIP_BYTES },
      ) as NativeHttpDownload
    } catch (error) {
      signal?.throwIfAborted()
      throw new ClipDownloadError(null, { cause: error })
    }
    if (!download.saved) throw new ClipDownloadError(download.status)
    // A stop that came while the download ended, before its cancel did.
    signal?.throwIfAborted()
  } finally {
    signal?.removeEventListener('abort', cancel)
  }
}

/** A place that Dez may take a clip from: a file of this computer
 *  (`linked`: a linked file, not a file of Dez), or an http or https URL. */
export type ClipSource =
  | { kind: 'file', path: string, linked: boolean }
  | { kind: 'url', url: string }

// The place that `source` (the `src` or the `url` of a clip) names; null
// for one that Dez may not take a clip from. A saved file and a temp copy
// count in both. A linked file counts only as the `src`: the caller gives a
// linked `src` only for a tag of a user section (`sectionClipSource`), and
// the `url` is the provider's, so a linked path there is never read.
function clipSource (source: string, isSrc: boolean): ClipSource | null {
  if (isSavedMediaPath(source) || isTempMediaPath(source)) return { kind: 'file', path: source, linked: false }
  if (/^https?:\/\//i.test(source)) return { kind: 'url', url: source }
  return isSrc && isLinkedMediaPath(source) ? { kind: 'file', path: source, linked: true } : null
}

/** A clip from the first of its sources that gives it: its `src`, else its
 *  `url`. `take` gets one source and gives the clip in the form that the
 *  caller needs (its bytes, or a file for a program); it rejects when the
 *  source does not give the clip, with an error whose text holds no path
 *  and no URL. Throws a `ClipReadError` when no source gives the clip
 *  (src/model/chat/mediaFiles.ts tells each problem); it holds the texts
 *  of those errors. After a stop of `signal`, rejects with the stop
 *  instead. A failure is not logged here: the caller logs, and words the
 *  problem for its reader. */
export async function clipFromSources<T> (
  clip: Pick<MediaTagData, 'src' | 'url' | 'expires'>,
  signal: AbortSignal | undefined,
  take: (source: ClipSource) => Promise<T>,
): Promise<T> {
  const sources = [...new Set([clip.src, clip.url])].filter((source): source is string => source !== null)
  if (sources.length === 0) throw new ClipReadError('deleted')
  const failures: string[] = []
  for (const source of sources) {
    const place = clipSource(source, source === clip.src)
    if (!place) {
      failures.push('A source of the clip is not a file that Dez may read or a web address.')
      continue
    }
    try {
      return await take(place)
    } catch (error) {
      // A stop is no problem of the clip, and no later source is tried.
      signal?.throwIfAborted()
      failures.push(rawErrorText(error))
    }
  }
  const expired = clip.expires !== null && Date.parse(clip.expires) <= Date.now()
  throw new ClipReadError(expired ? 'expired' : 'unreadable', failures.join(' '))
}
