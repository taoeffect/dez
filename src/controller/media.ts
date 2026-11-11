import sbp from '@sbp/sbp'
import { MEDIA_TEMP_LIFETIME_MS, mediaFileExtension, savedMediaFile, tempMediaFile } from '../model/chat/mediaFiles'
import { MEDIA_CACHE_FOLDER, MEDIA_FOLDERS, isSavedMediaPath, type MediaTagData } from '../model/chat/mediaTags'
import { fileNameOf } from '../utils/fileName'
import type { NativeHttpDownload, NativeHttpStreamResult } from '../utils/protocol/nativeHttp'
import type { AppFileEntry } from './nativeTypes'

// The largest clip that Save downloads from a URL.
const MAX_SAVED_CLIP_BYTES = 1024 ** 3
// The longest time that Save waits for the whole download. A server that
// stops sending would keep the Save control busy with no end.
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

// The name of the file that Save downloads a clip into. Throws for a clip
// that Save cannot download: no http or https URL, or a file type that Dez
// does not know.
function downloadFileName ({ type, url }: Pick<MediaTagData, 'type' | 'url'>): string {
  if (url === null || !/^https?:\/\//i.test(url)) {
    throw new Error('This clip has no temp copy and no URL to save it from.')
  }
  const extension = mediaFileExtension(type, url)
  if (extension === null) {
    throw new Error(`Dez does not know the file type of this clip (${type}).`)
  }
  return `${crypto.randomUUID()}.${extension}`
}

// What the user can do after the server of a clip refused its download.
// The URL is one that the provider gave, and Save sends no key with it: so
// an access refusal or a missing file tells that the link has expired or
// that the clip was deleted, and not that a key is wrong.
function clipDownloadAdvice (status: number): string {
  if (status === 403 || status === 404 || status === 410) return ' The clip is not on the server any more: make it again.'
  if (status >= 500) return ' This is a problem at the server of the clip: try again later.'
  return ''
}

export default sbp('sbp/selectors/register', {
  // Keeps a clip: its file goes into the media folder of its kind in the app
  // folder, and the absolute path of that file comes back, for the `src` of
  // the clip's tag (src/model/chat/mediaTags.ts). A clip whose `src` is a
  // temp copy of this computer moves there under its name. Any other clip is
  // downloaded from its `url` (http and https only) with no provider header:
  // the URL is a signed one, and a key must not go to the host of a clip. A
  // failure is logged, shows an error toast, and rejects, so the caller keeps
  // the tag as it is.
  async 'dez.controller/media/save' (clip: Pick<MediaTagData, 'kind' | 'type' | 'src' | 'url'>): Promise<string> {
    try {
      const appDir = await sbp('dez.native/getAppDir') as string
      const tempFile = clip.src === null ? null : tempMediaFile(clip.src, await sbp('dez.native/getAppDir', 'cache') as string)
      const file = `${MEDIA_FOLDERS[clip.kind]}/${tempFile === null ? downloadFileName(clip) : fileNameOf(tempFile)}`
      const path = `${appDir}/${file}`
      // The recognizer takes only absolute paths on one line (e.g. not
      // `./.config/dez` when $HOME is not set). A tag with another path
      // would not show as a saved clip, so no file is written for it.
      if (!isSavedMediaPath(path)) {
        throw new Error(`Clips cannot be stored in this Dez folder: ${appDir}`)
      }
      if (tempFile !== null) {
        await sbp('dez.native/moveAppFile', { root: 'cache', path: tempFile }, { root: 'app', path: file })
        return path
      }
      const download = await sbp(
        'dez.native/downloadAppFile',
        { method: 'GET', url: clip.url, timeoutMs: SAVE_TIMEOUT_MS },
        crypto.randomUUID(),
        { root: 'app', path: file },
        { maxBytes: MAX_SAVED_CLIP_BYTES },
      ) as NativeHttpDownload
      if (!download.saved) {
        throw new Error(`The server of the clip answered HTTP ${download.status}.${clipDownloadAdvice(download.status)}`)
      }
      return path
    } catch (error) {
      console.error('Failed to save the clip:', error)
      sbp('dez.ui/toast', 'app-global', {
        title: 'Could not save the clip',
        message: error instanceof Error ? error.message : String(error),
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
        message: error instanceof Error ? error.message : String(error),
        variant: 'error',
      })
      throw error
    }
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
