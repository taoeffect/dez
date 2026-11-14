import sbp from '@sbp/sbp'
import { AUDIO_CUT_RATE, type DecodedAudio } from '../model/chat/audioCut'
import { MAX_SAVED_CLIP_BYTES, MEDIA_TEMP_LIFETIME_MS, mediaFileExtension, savedMediaFile, tempMediaFile } from '../model/chat/mediaFiles'
import { MEDIA_CACHE_FOLDER, MEDIA_FOLDERS, type MediaTagData } from '../model/chat/mediaTags'
import { newStoredFilePath } from '../model/chat/storedFilePaths'
import { signedUrlGone } from '../model/providers/errors'
import { wavFileOfChannels } from '../model/providers/pcmAudio'
import { byteSizeText } from '../utils/byteSize'
import { ExplainedError, errorText, explainedError, rawErrorText } from '../utils/errorText'
import { fileNameOf } from '../utils/fileName'
import type { NativeHttpStreamResult } from '../utils/protocol/nativeHttp'
import { ClipDownloadError, clipFromSources, downloadClip } from './clipSources'
import type { AppFileEntry } from './nativeTypes'
import { deleteOldWorkFolders } from './workFolders'

const CLEANUP_INTERVAL_MS = 60 * 60 * 1000
// The longest time that `urlAnswers` waits for an answer. The player of the
// clip waits for it to tell why the clip does not play.
const URL_ANSWER_TIMEOUT_MS = 10 * 1000

let cleanupStarted = false

// Deletes the temp copies that are older than the temp lifetime. The tag of
// such a clip tells that it has expired (`expires`), so no view plays the
// file any more. The temp file of a download that did not end (the app
// stopped) is in the same folder and goes the same way. A failure is only
// logged: the next run tries again, and the user did nothing to tell about.
async function deleteExpiredTempCopies(): Promise<void> {
  try {
    const files = await sbp('dez.native/listAppFiles', MEDIA_CACHE_FOLDER, 'cache') as AppFileEntry[]
    const now = Date.now()
    for (const { name, updatedAt } of files) {
      if (updatedAt + MEDIA_TEMP_LIFETIME_MS > now) continue
      try {
        await sbp('dez.native/deleteAppFile', `${MEDIA_CACHE_FOLDER}/${name}`, 'cache')
      } catch (error) {
        console.error(`Failed to delete the old temp copy ${name}:`, error)
      }
    }
  } catch (error) {
    console.error('Failed to list the temp copies of clips:', error)
  }
}

// The name of a new file for a clip of the media type `type`. Throws for a
// type that Dez does not know, when the path of `url` names none either.
function newClipFileName (type: string, url: string | null): string {
  const extension = mediaFileExtension(type, url)
  if (extension === null) {
    throw new ExplainedError(`Dez does not know the file type of this clip (${type}), so it cannot save it. Report this at Help › Dez on GitHub.`)
  }
  return `${crypto.randomUUID()}.${extension}`
}

// The name of the file that Save downloads a clip into. Throws for a clip
// that Save cannot download: no http or https URL, or a file type that Dez
// does not know.
function downloadFileName ({ type, url }: Pick<MediaTagData, 'type' | 'url'>): string {
  if (url === null || !/^https?:\/\//i.test(url)) {
    throw new ExplainedError('Dez cannot save this clip: its temp copy is not on this computer, and it has no web address to download it from. Make the clip again.')
  }
  return newClipFileName(type, url)
}

// What went wrong when the server of a clip refused its download, and what
// the user can do. The URL is one that the provider gave, and Save sends no
// key with it: so an access refusal or a missing file tells that the link
// has expired or that the clip was deleted, and not that a key is wrong.
function clipDownloadRefusal (status: number): string {
  if (signedUrlGone(status)) {
    return 'The clip is not on its server any more: its link has expired, or the provider deleted it. Make the clip again.'
  }
  if (status >= 500) return 'The server of the clip has a problem. Try again later.'
  return 'The server of the clip refused to send it. Try again later. If the error stays, make the clip again.'
}

// The bytes of a clip from its http or https URL (`downloadClip`): the
// clip goes into a part file of the cache media folder, which is read and
// then deleted. A delete that fails leaves the part file to the cleanup of
// the temp copies.
async function readClipUrl (url: string, type: string, signal: AbortSignal | undefined): Promise<Blob> {
  signal?.throwIfAborted()
  const part = `${MEDIA_CACHE_FOLDER}/${crypto.randomUUID()}.part`
  try {
    await downloadClip(url, { root: 'cache', path: part }, signal)
    const cacheDir = await sbp('dez.native/getAppDir', 'cache') as string
    const file = await sbp('dez.controller/images/readFile', `${cacheDir}/${part}`) as File
    return new Blob([file], { type })
  } finally {
    await sbp('dez.native/deleteAppFile', part, 'cache').catch((error: unknown) => {
      console.error('Failed to delete the part file of a clip download:', error)
    })
  }
}

export default sbp('sbp/selectors/register', {
  // Keeps a clip: its file goes into a media folder of its kind in the app
  // folder, and the absolute path of that file comes back, for the `src` of
  // the clip's tag (src/model/chat/mediaTags.ts). With `bytes` (a clip file
  // that the user pasted or dropped), they go to a new file named for the
  // clip's type, in the `pasted` folder. Else (the Save of a clip that a
  // model or a Dez tool made) the file goes into the `generated` folder: a
  // clip whose `src` is a temp copy of this computer moves there under its
  // name, and any other clip is downloaded from its `url` (http and https
  // only) with no provider header: the URL is a signed one, and a key must
  // not go to the host of a clip. A failure is logged, shows an error
  // toast, and rejects, so the caller keeps the tag as it is.
  async 'dez.controller/media/save' (
    clip: Pick<MediaTagData, 'kind' | 'type' | 'src' | 'url'>,
    { bytes }: { bytes?: Uint8Array } = {},
  ): Promise<string> {
    try {
      const tempFile = bytes !== undefined || clip.src === null ? null : tempMediaFile(clip.src, await sbp('dez.native/getAppDir', 'cache') as string)
      const fileName = bytes !== undefined
        ? newClipFileName(clip.type, null)
        : tempFile !== null ? fileNameOf(tempFile) : downloadFileName(clip)
      const file = `${MEDIA_FOLDERS[bytes !== undefined ? 'pasted' : 'generated'][clip.kind]}/${fileName}`
      const path = newStoredFilePath(await sbp('dez.native/getAppDir') as string, file, clip.kind)
      if (bytes !== undefined) {
        await sbp('dez.native/saveAppFile', file, bytes).catch((error: unknown) => {
          throw new ExplainedError(
            'The system did not let Dez write the clip file. The details tell why (for example, the disk is full). Fix that, and try again.',
            rawErrorText(error),
            { cause: error },
          )
        })
        return path
      }
      if (tempFile !== null) {
        await sbp('dez.native/moveAppFile', { root: 'cache', path: tempFile }, { root: 'app', path: file }).catch((error: unknown) => {
          throw new ExplainedError(
            'Dez could not move the temp copy of the clip into the Dez folder. The copy is gone, or the system did not let Dez write the file: the details tell which. If the copy is gone, make the clip again. Else fix the problem, and try again.',
            rawErrorText(error),
            { cause: error },
          )
        })
        return path
      }
      // `downloadFileName` refused a clip with no http or https URL.
      await downloadClip(clip.url as string, { root: 'app', path: file }, undefined).catch((error: unknown) => {
        if (!(error instanceof ClipDownloadError)) throw error
        if (error.status !== null) throw new ExplainedError(clipDownloadRefusal(error.status), `HTTP ${error.status}`, { cause: error })
        throw new ExplainedError(
          `Dez could not download the clip. The network failed, the clip is larger than ${byteSizeText(MAX_SAVED_CLIP_BYTES)} (the most that Dez saves), or the system did not let Dez write the file: the details tell which. Try again, unless the clip is too large.`,
          rawErrorText(error.cause),
          { cause: error },
        )
      })
      return path
    } catch (error) {
      console.error('Failed to save the clip:', error)
      sbp('dez.ui/toast', 'app-global', {
        title: 'Could not save the clip',
        message: explainedError(error).message,
        variant: 'error',
      })
      throw error
    }
  },

  // Deletes the file of a saved clip. Only a clip in a media folder of this
  // Dez folder is deleted (`savedMediaFile`); any other path (a temp copy, a
  // tag copied from another home) deletes no file, as the file of that name
  // here belongs to another clip. A missing file is not an error. A failure
  // is logged, shows an error toast, and rejects, so the caller keeps the
  // tag as it is.
  async 'dez.controller/media/delete' (path: string): Promise<void> {
    try {
      const file = savedMediaFile(path, await sbp('dez.native/getAppDir') as string)
      if (file) await sbp('dez.native/deleteAppFile', file)
    } catch (error) {
      console.error(`Failed to delete the clip ${path}:`, error)
      sbp('dez.ui/toast', 'app-global', {
        title: 'Could not delete the clip',
        message: errorText('The system did not let Dez delete the clip file. The details tell why (for example, Dez has no permission to change the folder). Fix that, and try again.', rawErrorText(error)),
        variant: 'error',
      })
      throw error
    }
  },

  // The bytes of a clip, for a tool or a request that uses the clip, from
  // the first of its sources that gives them (`clipFromSources`). A file
  // is read through the asset protocol; a linked file larger than
  // `MAX_SAVED_CLIP_BYTES` is not read, as a dropped clip that Dez copies
  // has that cap. A URL is downloaded (`readClipUrl`), and a stop of
  // `signal` ends that download. Throws a `ClipReadError` when no source
  // gives the bytes; after a stop, rejects with the stop instead.
  async 'dez.controller/media/readClip' (
    clip: Pick<MediaTagData, 'type' | 'src' | 'url' | 'expires'>,
    { signal }: { signal?: AbortSignal } = {},
  ): Promise<Blob> {
    return clipFromSources(clip, signal, (source) => source.kind === 'url'
      ? readClipUrl(source.url, clip.type, signal)
      : sbp('dez.controller/images/readFile', source.path, source.linked ? { maxBytes: MAX_SAVED_CLIP_BYTES } : {}) as Promise<File>)
  },

  // Decodes an audio clip in the webview (any audio type that the webview
  // decodes) for a media request: gives its length in seconds, and with
  // `wav`, a WAV copy of the whole clip, with 16-bit samples at
  // `AUDIO_CUT_RATE`. There is no Rust code for this: the webview has the
  // decoders (Web Audio). The `audio` tool does not use it: it cuts with
  // ffmpeg (audioTool.ts), which was 3 to 7 times faster in a measurement
  // on Linux and does not stop the page during the decode. Rejects when the
  // webview cannot decode the file; the caller logs it.
  async 'dez.controller/media/decodeAudio' (file: Blob, { wav }: { wav: boolean }): Promise<DecodedAudio> {
    // An offline context needs no sound device, and its decode resamples to
    // its rate. Its own length and channel count are only for a render,
    // which this context never does.
    const context = new OfflineAudioContext(1, 1, AUDIO_CUT_RATE)
    // The caller puts the message of this error into an error text, so the
    // message says what failed; the webview's own error is the cause.
    const audio = await context.decodeAudioData(await file.arrayBuffer()).catch((error: unknown) => {
      throw new Error('The audio cannot be decoded.', { cause: error })
    })
    if (!wav) return { seconds: audio.duration, wav: null }
    const channels = Array.from({ length: audio.numberOfChannels }, (_, index) => audio.getChannelData(index))
    return { seconds: audio.duration, wav: wavFileOfChannels(channels, audio.sampleRate) }
  },

  // Whether the URL of a clip answers: one GET of its first byte, with no
  // provider header (the URL can be a signed one, and a key must not go to
  // the host of a clip), and a short time limit. True for a 2xx status. The
  // player asks this when its URL gave "source not supported", which tells
  // no difference between a clip that it cannot decode and a URL that gives
  // no clip (`clipProblem`, src/view/media/clipState.ts). A HEAD is no
  // option: a URL that is signed for GET can refuse it. The body is not
  // read: a server that does not take ranges would send the whole clip. The
  // URL and the error of a failed request (which can name the URL) stay out
  // of the log.
  async 'dez.controller/media/urlAnswers' (url: string): Promise<boolean> {
    let result: NativeHttpStreamResult
    try {
      result = await sbp('dez.http/stream', {
        method: 'GET',
        url,
        headers: { Range: 'bytes=0-0' },
        timeoutMs: URL_ANSWER_TIMEOUT_MS,
      }) as NativeHttpStreamResult
    } catch {
      console.error('Failed to ask the URL of a clip whether it answers')
      return false
    }
    try {
      await sbp('dez.http/cancelStream', result.requestId)
    } catch (error) {
      console.error('Failed to stop the answer of a clip URL:', error)
    }
    return result.response.status >= 200 && result.response.status < 300
  },

  // Deletes the old files of the cache root (the temp copies of clips, and
  // the work folders of the bundled tools) now, and then each hour while
  // the app runs. A second call does nothing: one timer is enough for the
  // whole app.
  'dez.controller/media/startCleanup' (): void {
    if (cleanupStarted) return
    cleanupStarted = true
    const cleanUp = () => {
      void deleteExpiredTempCopies()
      void deleteOldWorkFolders()
    }
    cleanUp()
    setInterval(cleanUp, CLEANUP_INTERVAL_MS)
  },
})
