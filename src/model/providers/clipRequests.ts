import sbp from '@sbp/sbp'
import type { ImageMediaType } from '../chat/images'
import { MAX_SAVED_CLIP_BYTES, MEDIA_TEMP_LIFETIME_MS } from '../chat/mediaFiles'
import { MEDIA_CACHE_FOLDER } from '../chat/mediaTags'
import { byteSizeText } from '../../utils/byteSize'
import { ExplainedError, rawErrorText } from '../../utils/errorText'
import { responseOk, sanitizeErrorText } from '../../utils/protocol/errors'
import { readNativeChunkBytes, responseContentType, textFromNativeBody, type NativeHttpDownload, type NativeHttpRequest, type NativeHttpResponseHead, type NativeHttpStreamResult } from '../../utils/protocol/nativeHttp'
import { imageUploadError, providerStatusError, UnusableAnswerError } from './errors'
import { jsonBody } from './mediaFormatParts'
import type { AnswerCost } from './mediaFormats'
import { clipFileType, wavFile } from './pcmAudio'
import type { Provider } from './provider'
import { assertStreamResponseOk } from './streaming'
import { CLIP_KINDS, type ClipKind, type GeneratedClip } from './types'

// The steps of dez.provider/generateMedia for a clip (speech, music, video)
// and for the images of a job (`ImageFormat.job`): one request of the job,
// the uploads of its input images, and the wait between two requests. The
// selector holds the order of the steps (the job loop).

// The time between two requests for the state of a job.
export const CLIP_POLL_INTERVAL_MS = 5_000
// The longest time from the first request of a clip or a job to its last
// byte, for a caller that names none
// (`ProviderGenerateMediaInput.timeoutMs`). A job that the provider never
// ends would keep the reply busy with no end.
export const CLIP_JOB_TIMEOUT_MS = 30 * 60 * 1000

// What all requests of one clip, or of the images of one job, have in
// common.
export interface JobRun {
  provider: Provider
  // dez.http/cancelStream with this id cancels the request that runs. The
  // requests of a job go one after the other, so they share the id.
  requestId: string
  // The longest time (ms) from the first request of the job to its last
  // byte, and the time at which that is over.
  limitMs: number
  deadline: number
  // Aborts when the caller stops the job.
  signal: AbortSignal | undefined
}

// What all requests of one clip have in common.
export interface ClipRun extends JobRun {
  kind: ClipKind
}

// `30 minutes`, `90 seconds`: a time limit in whole minutes when it is
// that, else in seconds.
function limitText(limitMs: number): string {
  const [count, unit] = limitMs % 60_000 === 0 ? [limitMs / 60_000, 'minute'] : [Math.round(limitMs / 1000), 'second']
  return `${count} ${unit}${count === 1 ? '' : 's'}`
}

// The error of a clip or of the images of a job (`made`) whose time
// (`JobRun.limitMs`) is over. With no `requestError`, the time was over
// before a request: the job did not end in time. With one, Rust ended a
// request at the deadline (`timeoutMs`), and that request can be the
// download of a file that is made.
function jobTimeoutError(run: JobRun, made: 'clip' | 'image', requestError?: unknown): ExplainedError {
  const name = run.provider.name
  const limit = `in ${limitText(run.limitMs)}, the longest time that Dez waits`
  if (requestError === undefined) return new ExplainedError(`${name} did not make the ${made} ${limit}. Send the request again later.`)
  return new ExplainedError(
    `Dez did not get the ${made} from ${name} ${limit}: ${name} did not make it in that time, or the download of the ${made} was too slow. Send the request again later.`,
    sanitizeErrorText(rawErrorText(requestError)),
    { cause: requestError },
  )
}

/** The clip of a temp copy that Dez wrote at `file`, a path in
 *  `MEDIA_CACHE_FOLDER` of the cache root (whose path is `cacheDir`).
 *  `startedAt` is a time before the download or the write of the copy, so
 *  the copy is there until the clip's `expires` (see
 *  `MEDIA_TEMP_LIFETIME_MS`). */
export function tempCopyClip(clip: Pick<GeneratedClip, 'kind' | 'mediaType' | 'jobId'>, file: string, cacheDir: string, startedAt: number): GeneratedClip {
  return { ...clip, src: `${cacheDir}/${file}`, url: null, expires: new Date(startedAt + MEDIA_TEMP_LIFETIME_MS).toISOString() }
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
  if (timeoutMs <= 0) throw jobTimeoutError(run, 'clip')

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
      { maxBytes: MAX_SAVED_CLIP_BYTES, contentTypes: [`${CLIP_KINDS[run.kind]}/`] },
    ) as NativeHttpDownload
  } catch (error) {
    // A stop rejects too: the caller tells it by its signal.
    if (run.signal?.aborted) throw error
    if (Date.now() >= run.deadline) throw jobTimeoutError(run, 'clip', error)
    // The code cannot tell the other causes apart (the connection, the size
    // limit, the write of the file): the text names all three, and the native
    // text in the details tells which one it was.
    throw new ExplainedError(
      `Dez could not get the answer of ${run.provider.name}: the connection broke, the clip is larger than ${byteSizeText(MAX_SAVED_CLIP_BYTES)} (the most that Dez takes), or Dez could not write the file. The details tell which. Check the internet connection and the free disk space, then send the request again.`,
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
  const fileType = clipFileType(contentType, run.provider.pcmSampleBits())
  if (fileType === null) {
    // A failed delete must not hide the error of the file type: the
    // cleanup of the temp copies deletes the part file later.
    await sbp('dez.native/deleteAppFile', part, 'cache').catch((error: unknown) => {
      console.error('Failed to delete a clip of an unknown file type:', error)
    })
    throw new ExplainedError(
      `${run.provider.name} sent the clip in a file type that Dez does not know. Choose another model, and report the file type at Help › Dez on GitHub.`,
      `Content type: ${sanitizeErrorText(contentType, 100)}`,
    )
  }
  const { mediaType, extension, pcm } = fileType
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
  return { clip: tempCopyClip({ kind: CLIP_KINDS[run.kind], mediaType, jobId }, file, cacheDir, startedAt) }
}

// Sends one request of the images of a job (a request for its state, or
// the download of an image) through dez.http/stream, with the time that
// the job has left as its time limit, and gives the body of its 2xx
// response. Throws for any other status, and when the job's time is over.
// `keyed`: the request has the provider's key (`providerStatusError`).
export async function sendImageJobRequest(run: JobRun, request: NativeHttpRequest, keyed: boolean): Promise<Uint8Array> {
  run.signal?.throwIfAborted()
  const timeoutMs = run.deadline - Date.now()
  if (timeoutMs <= 0) throw jobTimeoutError(run, 'image')
  let head: NativeHttpResponseHead
  let body: Uint8Array
  try {
    const { response, chunks } = await sbp('dez.http/stream', { ...request, timeoutMs }, run.requestId) as NativeHttpStreamResult
    head = response
    body = await readNativeChunkBytes(chunks)
  } catch (error) {
    // A stop rejects too: the caller tells it by its signal.
    if (run.signal?.aborted) throw error
    if (Date.now() >= run.deadline) throw jobTimeoutError(run, 'image', error)
    throw error
  }
  if (!responseOk(head)) throw providerStatusError(run.provider, head, textFromNativeBody(body), keyed)
  return body
}

// Uploads the input images of a request to a provider whose API takes
// them only at a web address (`Provider.imageUpload`), one after the
// other, each one in a request that `run.requestId` cancels, and gives
// their web addresses, in the order of `images`. `onUploaded` gets the
// price of each upload as soon as its answer comes: the provider took the
// money then, so a later failure must still count it. An upload has no
// time limit, as the one request of an image that is no job:
// `run.signal` ends it.
export async function uploadInputImages(
  run: JobRun,
  upload: NonNullable<ReturnType<Provider['imageUpload']>>,
  images: readonly { bytes: Uint8Array, mediaType: ImageMediaType }[],
  onUploaded: (cost: AnswerCost) => void,
): Promise<string[]> {
  const urls: string[] = []
  for (const [index, image] of images.entries()) {
    run.signal?.throwIfAborted()
    let uploaded: { url: string } & AnswerCost
    try {
      const { response, chunks } = await sbp('dez.http/stream', upload.request(image, index + 1), run.requestId) as NativeHttpStreamResult
      await assertStreamResponseOk(run.provider, response, chunks)
      uploaded = upload.result(jsonBody(await readNativeChunkBytes(chunks)))
    } catch (error) {
      // A stop rejects too: the caller tells it by its signal.
      if (run.signal?.aborted) throw error
      throw imageUploadError(run.provider, error, upload.refusal(error))
    }
    const { url, ...cost } = uploaded
    onUploaded(cost)
    urls.push(url)
  }
  return urls
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
