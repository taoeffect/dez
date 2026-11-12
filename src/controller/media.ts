import sbp from '@sbp/sbp'
import { AUDIO_CUT_RATE, audioPartFrames, type AudioPart, type CutAudio } from '../model/chat/audioCut'
import { ClipReadError, MAX_SAVED_CLIP_BYTES, MEDIA_TEMP_LIFETIME_MS, mediaFileExtension, savedMediaFile, tempMediaFile } from '../model/chat/mediaFiles'
import { MEDIA_CACHE_FOLDER, MEDIA_FOLDERS, isSavedMediaPath, isTempMediaPath, type MediaFolder, type MediaTagData } from '../model/chat/mediaTags'
import { wavFileOfChannels } from '../model/providers/pcmAudio'
import { byteSizeText } from '../utils/byteSize'
import { ExplainedError, errorText, explainedError, rawErrorText } from '../utils/errorText'
import { fileNameOf } from '../utils/fileName'
import type { NativeHttpDownload, NativeHttpStreamResult } from '../utils/protocol/nativeHttp'
import type { AppFileEntry } from './nativeTypes'

// The longest time that Save, or a read of a clip from its URL, waits for
// the whole download. A server that stops sending would keep the Save
// control, or the tool or the request that reads the clip, busy with no
// end.
const SAVE_TIMEOUT_MS = 30 * 60 * 1000
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
  if (status === 403 || status === 404 || status === 410) {
    return 'The clip is not on its server any more: its link has expired, or the provider deleted it. Make the clip again.'
  }
  if (status >= 500) return 'The server of the clip has a problem. Try again later.'
  return 'The server of the clip refused to send it. Try again later. If the error stays, make the clip again.'
}

// The bytes of a clip from its http or https URL, with no provider header:
// the URL is a signed one, and a key must not go to the host of a clip.
// Rust downloads the clip into a part file of the cache media folder, so no
// byte of it crosses the bridge as a JSON number array, and a clip larger
// than `MAX_SAVED_CLIP_BYTES` fails before it fills the memory. A stop of
// `signal` cancels the download and rejects with the stop. The part file
// goes after the read; a delete that fails leaves it to the cleanup of the
// temp copies. Throws an error whose text holds no URL and no path, as the
// error of a failed request can name them.
async function readClipUrl (url: string, type: string, signal: AbortSignal | undefined): Promise<Blob> {
  signal?.throwIfAborted()
  const part = `${MEDIA_CACHE_FOLDER}/${crypto.randomUUID()}.part`
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
        { method: 'GET', url, timeoutMs: SAVE_TIMEOUT_MS },
        requestId,
        { root: 'cache', path: part },
        { maxBytes: MAX_SAVED_CLIP_BYTES },
      ) as NativeHttpDownload
    } catch {
      throw new Error(`The download of the clip failed: its server gave no answer, the answer broke off, the clip is larger than ${byteSizeText(MAX_SAVED_CLIP_BYTES)}, or Dez could not write the file.`)
    }
    if (!download.saved) throw new Error(`The server of the clip answered HTTP ${download.status}.`)
    // A stop that came while the download ended, before its cancel did.
    signal?.throwIfAborted()
    const cacheDir = await sbp('dez.native/getAppDir', 'cache') as string
    const file = await sbp('dez.controller/images/readFile', `${cacheDir}/${part}`) as File
    return new Blob([file], { type })
  } finally {
    signal?.removeEventListener('abort', cancel)
    await sbp('dez.native/deleteAppFile', part, 'cache').catch((error: unknown) => {
      console.error('Failed to delete the part file of a clip download:', error)
    })
  }
}

export default sbp('sbp/selectors/register', {
  // Keeps a clip: its file goes into the media folder of its kind in the app
  // folder (`folder`: `generated` for a clip that a model or a Dez tool
  // made, `pasted` for a clip file that the user pasted or dropped), and the
  // absolute path of that file comes back, for the `src` of the clip's tag
  // (src/model/chat/mediaTags.ts). With `bytes` (a clip that Dez made, such
  // as a cut of the `audio` tool, or a pasted file), they go to a new file
  // named for the clip's type. Else a clip whose `src` is a temp copy of
  // this computer moves there under its name, and any other clip is
  // downloaded from its `url` (http and https only) with no provider header:
  // the URL is a signed one, and a key must not go to the host of a clip. A
  // failure is logged, shows an error toast, and rejects, so the caller keeps
  // the tag as it is.
  async 'dez.controller/media/save' (
    clip: Pick<MediaTagData, 'kind' | 'type' | 'src' | 'url'>,
    { bytes, folder = 'generated' }: { bytes?: Uint8Array, folder?: MediaFolder } = {},
  ): Promise<string> {
    try {
      const appDir = await sbp('dez.native/getAppDir') as string
      const tempFile = bytes !== undefined || clip.src === null ? null : tempMediaFile(clip.src, await sbp('dez.native/getAppDir', 'cache') as string)
      const fileName = bytes !== undefined
        ? newClipFileName(clip.type, null)
        : tempFile !== null ? fileNameOf(tempFile) : downloadFileName(clip)
      const file = `${MEDIA_FOLDERS[folder][clip.kind]}/${fileName}`
      const path = `${appDir}/${file}`
      // The recognizer takes only absolute paths on one line (e.g. not
      // `./.config/dez` when $HOME is not set). A tag with another path
      // would not show as a saved clip, so no file is written for it.
      if (!isSavedMediaPath(path)) {
        throw new ExplainedError(`Dez cannot store clips in the Dez folder ${appDir}. The path of this folder must start with "/" and must not hold a line break. Start Dez with a HOME environment variable that gives such a path.`)
      }
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
      // The native download fails for a network error (its text has no
      // URL), a body over the size limit, and a file that cannot be written.
      const download = await sbp(
        'dez.native/downloadAppFile',
        { method: 'GET', url: clip.url, timeoutMs: SAVE_TIMEOUT_MS },
        crypto.randomUUID(),
        { root: 'app', path: file },
        { maxBytes: MAX_SAVED_CLIP_BYTES },
      ).catch((error: unknown) => {
        throw new ExplainedError(
          `Dez could not download the clip. The network failed, the clip is larger than ${byteSizeText(MAX_SAVED_CLIP_BYTES)} (the most that Dez saves), or the system did not let Dez write the file: the details tell which. Try again, unless the clip is too large.`,
          rawErrorText(error),
          { cause: error },
        )
      }) as NativeHttpDownload
      if (!download.saved) {
        throw new ExplainedError(clipDownloadRefusal(download.status), `HTTP ${download.status}`)
      }
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

  // The bytes of a clip, for a tool or a request that uses the clip: from
  // its `src`, else from its `url`. A saved file or a temp copy of this
  // computer is read through the asset protocol; a URL (http or https) is
  // downloaded with no provider header (`readClipUrl`), and a stop of
  // `signal` ends that download. Throws a `ClipReadError` when no source
  // gives them (src/model/chat/mediaFiles.ts tells each problem); it holds
  // no path and no URL. After a stop, rejects with the stop instead. A
  // failed read is not logged here: the caller logs, and words the problem
  // for its reader.
  async 'dez.controller/media/readClip' (
    clip: Pick<MediaTagData, 'type' | 'src' | 'url' | 'expires'>,
    { signal }: { signal?: AbortSignal } = {},
  ): Promise<Blob> {
    const sources = [...new Set([clip.src, clip.url])].filter((source): source is string => source !== null)
    if (sources.length === 0) throw new ClipReadError('deleted')
    const failures: string[] = []
    for (const source of sources) {
      try {
        if (isSavedMediaPath(source) || isTempMediaPath(source)) return await sbp('dez.controller/images/readFile', source) as File
        if (/^https?:\/\//i.test(source)) return await readClipUrl(source, clip.type, signal)
        failures.push('A source of the clip is not a file of Dez or a web address.')
      } catch (error) {
        // A stop is no problem of the clip, and no later source is tried.
        signal?.throwIfAborted()
        failures.push(rawErrorText(error))
      }
    }
    const expired = clip.expires !== null && Date.parse(clip.expires) <= Date.now()
    throw new ClipReadError(expired ? 'expired' : 'unreadable', failures.join(' '))
  },

  // Cuts a part of an audio clip in the webview: decodes `file` (any audio
  // type that the webview decodes) at `AUDIO_CUT_RATE`, asks `plan` which
  // part to keep of audio of that length in seconds, and gives that part as
  // a 16-bit WAV file. A part of the whole clip converts it to WAV. Null
  // when `plan` gives null: nothing is cut. There is no Rust code for this:
  // the webview has the decoders (Web Audio). Rejects when the webview
  // cannot decode the file and when `plan` throws; the caller logs it, as
  // each caller has its own answer to a failure.
  async 'dez.controller/media/cutAudio' (file: Blob, plan: (duration: number) => AudioPart | null): Promise<CutAudio | null> {
    // An offline context needs no sound device, and its decode resamples to
    // its rate. Its own length and channel count are only for a render,
    // which this context never does.
    const context = new OfflineAudioContext(1, 1, AUDIO_CUT_RATE)
    // A tool gives the message of this error to a model, so the message
    // says what failed; the webview's own error is the cause.
    const audio = await context.decodeAudioData(await file.arrayBuffer()).catch((error: unknown) => {
      throw new Error('The audio cannot be decoded.', { cause: error })
    })
    const part = plan(audio.duration)
    if (!part) return null
    const { from, to } = audioPartFrames(part, audio.sampleRate, audio.length)
    const channels = Array.from({ length: audio.numberOfChannels }, (_, index) => audio.getChannelData(index).subarray(from, to))
    return { part, bytes: wavFileOfChannels(channels, audio.sampleRate), duration: (to - from) / audio.sampleRate }
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

  // Deletes the old temp copies now, and then each hour while the app runs.
  // A second call does nothing: one timer is enough for the whole app.
  'dez.controller/media/startCleanup' (): void {
    if (cleanupStarted) return
    cleanupStarted = true
    void deleteExpiredTempCopies()
    setInterval(() => {
      void deleteExpiredTempCopies()
    }, CLEANUP_INTERVAL_MS)
  },
})
