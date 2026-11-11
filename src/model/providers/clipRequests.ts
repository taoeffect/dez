import sbp from '@sbp/sbp'
import { MEDIA_TEMP_LIFETIME_MS, mediaFileExtension } from '../chat/mediaFiles'
import { MEDIA_CACHE_FOLDER } from '../chat/mediaTags'
import { ExplainedError, rawErrorText } from '../../utils/errorText'
import { responseOk, sanitizeErrorText } from '../../utils/protocol/errors'
import { responseContentType, textFromNativeBody, type NativeHttpDownload, type NativeHttpRequest } from '../../utils/protocol/nativeHttp'
import { providerStatusError, UnusableAnswerError } from './errors'
import { pcmLayout, wavFile } from './pcmAudio'
import type { Provider } from './provider'
import { CLIP_KINDS, type ClipKind, type GeneratedClip } from './types'

// The steps of dez.provider/generateMedia for a clip (speech, music, video):
// one request of the job, and the wait between two requests. The selector
// holds the order of the steps (the job loop).

// The time between two requests for the state of a job.
export const CLIP_POLL_INTERVAL_MS = 5_000
// The longest time from the first request of a clip to its last byte. A job
// that the provider never ends would keep the reply busy with no end.
export const CLIP_JOB_TIMEOUT_MS = 30 * 60 * 1000
// The largest clip that Dez takes.
const MAX_CLIP_BYTES = 1024 ** 3

// What all requests of one clip have in common.
export interface ClipRun {
  provider: Provider
  kind: ClipKind
  // dez.http/cancelStream with this id cancels the request that runs. The
  // requests of a clip go one after the other, so they share the id.
  requestId: string
  // The time (ms) at which the clip must be there.
  deadline: number
  // Aborts when the caller stops the clip.
  signal: AbortSignal | undefined
}

// Sends one request of a clip, with the time that the clip has left as its
// time limit. A 2xx response with the content type of the clip's kind
// (audio or video) is the clip: Rust writes it to a temp copy
// (`MEDIA_CACHE_FOLDER` of the cache root, `cacheDir`), so no byte of a clip
// comes through the webview, and the clip comes back with `jobId`. Only raw
// PCM audio comes through the webview, to get its file format. Any other
// 2xx response is JSON, which comes back as `data`. Throws for any other
// status, for a response that is neither, and when the clip's time is over.
// `keyed`: the request has the provider's key (`providerStatusError`).
export async function sendClipRequest(
  run: ClipRun,
  request: NativeHttpRequest,
  jobId: string | null,
  cacheDir: string,
  keyed = true,
): Promise<{ clip: GeneratedClip } | { data: unknown }> {
  run.signal?.throwIfAborted()
  const startedAt = Date.now()
  const timeoutMs = run.deadline - startedAt
  if (timeoutMs <= 0) {
    throw new ExplainedError(`${run.provider.name} did not make the clip in ${CLIP_JOB_TIMEOUT_MS / 60_000} minutes, the longest time that Dez waits. Send the request again later.`)
  }

  // The file has no type in its name until the response tells one. The
  // cleanup of the temp copies also deletes a part file that stays.
  const name = crypto.randomUUID()
  const part = `${MEDIA_CACHE_FOLDER}/${name}.part`
  let download: NativeHttpDownload
  try {
    download = await sbp(
      'dez.native/downloadAppFile',
      { ...request, timeoutMs },
      run.requestId,
      { root: 'cache', path: part },
      { maxBytes: MAX_CLIP_BYTES, contentTypes: [`${CLIP_KINDS[run.kind]}/`] },
    ) as NativeHttpDownload
  } catch (error) {
    // A stop rejects too: the caller tells it by its signal.
    if (run.signal?.aborted) throw error
    // The native text does not tell which step failed: the connection, or
    // the write of the file.
    throw new ExplainedError(
      `Dez could not get the answer of ${run.provider.name}: the connection broke, or Dez could not write the file. Check the internet connection and the free disk space, then send the request again.`,
      sanitizeErrorText(rawErrorText(error)),
      { cause: error },
    )
  }
  if (!responseOk(download)) throw providerStatusError(run.provider, download, textFromNativeBody(download.body), keyed)
  if (!download.saved) {
    try {
      return { data: JSON.parse(textFromNativeBody(download.body)) as unknown }
    } catch {
      throw new UnusableAnswerError(`The answer is neither a clip nor JSON (content type: ${sanitizeErrorText(responseContentType(download), 100) || 'none'}).`)
    }
  }

  // Raw PCM (`audio/pcm`) is samples with no file format, and no player
  // plays it: the temp copy is a WAV file of the samples. Dez asks for raw
  // PCM only from speech models that make nothing else, and speech is
  // small. A PCM response that does not tell its layout gets no file, and
  // the error names its whole content type.
  const contentType = responseContentType(download)
  const pcm = pcmLayout(contentType, run.provider.pcmSampleBits())
  const mediaType = pcm ? 'audio/wav' : contentType.split(';', 1)[0].trim()
  const extension = mediaFileExtension(mediaType, null)
  if (extension === null) {
    await sbp('dez.native/deleteAppFile', part, 'cache')
    throw new ExplainedError(
      `${run.provider.name} sent the clip in a file type that Dez does not know. Choose another model, and report the file type at Help › Dez on GitHub.`,
      `Content type: ${contentType}`,
    )
  }
  const file = `${MEDIA_CACHE_FOLDER}/${name}.${extension}`
  if (pcm) {
    try {
      const samples = await sbp('dez.native/loadAppFileBytes', part, 'cache') as Uint8Array
      await sbp('dez.native/saveAppFile', file, wavFile(samples, pcm), 'cache')
    } finally {
      // A delete that fails must not lose a clip that is paid for: the
      // cleanup of the temp copies deletes the part file later.
      await sbp('dez.native/deleteAppFile', part, 'cache').catch((error: unknown) => {
        console.error('Failed to delete the raw samples of a clip:', error)
      })
    }
  } else {
    await sbp('dez.native/moveAppFile', { root: 'cache', path: part }, { root: 'cache', path: file })
  }
  return {
    clip: {
      kind: CLIP_KINDS[run.kind],
      mediaType,
      src: `${cacheDir}/${file}`,
      url: null,
      // A time before the download, so the copy is there until then (see
      // `MEDIA_TEMP_LIFETIME_MS`).
      expires: new Date(startedAt + MEDIA_TEMP_LIFETIME_MS).toISOString(),
      jobId,
    },
  }
}

// Waits before the next request for a job's state. Rejects at once when
// the caller stops the clip.
export function clipPollDelay(signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    signal?.throwIfAborted()
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal?.reason)
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, CLIP_POLL_INTERVAL_MS)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
