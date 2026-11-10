import sbp from '@sbp/sbp'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { MEDIA_TEMP_LIFETIME_MS, savedMediaFile } from '../model/chat/mediaFiles'
import type { MediaTagData } from '../model/chat/mediaTags'
import type { NativeDownloadRule, NativeHttpDownload, NativeHttpRequest } from '../utils/protocol/nativeHttp'
import type { AppFileEntry, AppFileRef } from './nativeTypes'
import './media'

type Clip = Pick<MediaTagData, 'kind' | 'type' | 'src' | 'url'>

interface Download {
  request: NativeHttpRequest
  requestId: string
  file: AppFileRef
  rule: NativeDownloadRule
}

interface Toast {
  title?: string
  message: string
  variant?: string
}

const APP_DIR = '/home/ann/.config/dez'
const CACHE_DIR = '/home/ann/.cache/dez'
const NAME = '0c4e7a51-9b2d-4f6a-8e13-5d7c9a2b4f60'
const CLIP_URL = 'https://cdn.example/out/v.mp4?sig=1&exp=2'
const SAVED: NativeHttpDownload = { status: 200, statusText: 'OK', headers: { 'content-type': 'video/mp4' }, saved: true, body: [] }

let appDir: string
let moves: Array<{ from: AppFileRef, to: AppFileRef }> = []
let moveAppFile: () => Promise<void>
let downloads: Download[] = []
let downloadAppFile: () => Promise<NativeHttpDownload>
let deletedFiles: AppFileRef[] = []
let deleteAppFile: (file: AppFileRef) => Promise<void>
let listedFolders: AppFileRef[] = []
let listAppFiles: () => Promise<AppFileEntry[]>
let toasts: Toast[] = []
let consoleError: MockInstance<typeof console.error>

sbp('sbp/selectors/register', {
  async 'dez.native/getAppDir' (root = 'app'): Promise<string> {
    return root === 'cache' ? CACHE_DIR : appDir
  },
  async 'dez.native/moveAppFile' (from: AppFileRef, to: AppFileRef): Promise<void> {
    moves.push({ from, to })
    await moveAppFile()
  },
  async 'dez.native/downloadAppFile' (request: NativeHttpRequest, requestId: string, file: AppFileRef, rule: NativeDownloadRule): Promise<NativeHttpDownload> {
    downloads.push({ request, requestId, file, rule })
    return downloadAppFile()
  },
  async 'dez.native/deleteAppFile' (path: string, root = 'app'): Promise<void> {
    const file = { root, path } as AppFileRef
    await deleteAppFile(file)
    deletedFiles.push(file)
  },
  async 'dez.native/listAppFiles' (path: string, root = 'app'): Promise<AppFileEntry[]> {
    listedFolders.push({ root, path } as AppFileRef)
    return listAppFiles()
  },
  'dez.ui/toast' (_area: string, toast: Toast): void {
    toasts.push(toast)
  },
})

beforeEach(() => {
  appDir = APP_DIR
  moves = []
  moveAppFile = async () => {}
  downloads = []
  downloadAppFile = async () => SAVED
  deletedFiles = []
  deleteAppFile = async () => {}
  listedFolders = []
  listAppFiles = async () => []
  toasts = []
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  consoleError.mockRestore()
  vi.useRealTimers()
})

describe('dez.controller/media/save', () => {
  function save(clip: Clip): Promise<string> {
    return sbp('dez.controller/media/save', clip) as Promise<string>
  }

  it('moves a temp copy to the media folder of its kind, under its name', async () => {
    const video = await save({ kind: 'video', type: 'video/mp4', src: `${CACHE_DIR}/media/${NAME}.mp4`, url: CLIP_URL })
    const audio = await save({ kind: 'audio', type: 'audio/mpeg', src: `${CACHE_DIR}/media/a_1.mp3`, url: null })

    expect(video).toBe(`${APP_DIR}/assets/generated/video/${NAME}.mp4`)
    expect(audio).toBe(`${APP_DIR}/assets/generated/audio/a_1.mp3`)
    expect(moves).toStrictEqual([
      { from: { root: 'cache', path: `media/${NAME}.mp4` }, to: { root: 'app', path: `assets/generated/video/${NAME}.mp4` } },
      { from: { root: 'cache', path: 'media/a_1.mp3' }, to: { root: 'app', path: 'assets/generated/audio/a_1.mp3' } },
    ])
    expect(downloads).toEqual([])
    expect(toasts).toEqual([])
  })

  it('downloads a clip with no temp copy from its URL, with no header, to a new file', async () => {
    const first = await save({ kind: 'video', type: 'video/mp4', src: CLIP_URL, url: CLIP_URL })
    const second = await save({ kind: 'audio', type: 'audio/x-wav', src: null, url: 'http://cdn.example/a' })

    expect(first).toMatch(/^\/home\/ann\/\.config\/dez\/assets\/generated\/video\/[0-9a-f-]{36}\.mp4$/)
    expect(second).toMatch(/^\/home\/ann\/\.config\/dez\/assets\/generated\/audio\/[0-9a-f-]{36}\.wav$/)
    expect(downloads.map((download) => download.request)).toStrictEqual([
      { method: 'GET', url: CLIP_URL, timeoutMs: expect.any(Number) },
      { method: 'GET', url: 'http://cdn.example/a', timeoutMs: expect.any(Number) },
    ])
    expect(downloads.map((download) => `${APP_DIR}/${download.file.path}`)).toEqual([first, second])
    expect(downloads.map((download) => download.file.root)).toEqual(['app', 'app'])
    // Any content type is saved: a file server can answer `application/octet-stream`.
    expect(downloads.map((download) => download.rule)).toStrictEqual([{ maxBytes: expect.any(Number) }, { maxBytes: expect.any(Number) }])
    expect(downloads[0].rule.maxBytes).toBeGreaterThan(0)
    expect(downloads[0].requestId).not.toBe(downloads[1].requestId)
    // The trash finds the file by the path that came back.
    expect(savedMediaFile(first, APP_DIR)).toBe(downloads[0].file.path)
    expect(moves).toEqual([])
    expect(toasts).toEqual([])
  })

  it('names the file by the URL when the media type names no format', async () => {
    const path = await save({ kind: 'video', type: 'application/octet-stream', src: null, url: 'https://cdn.example/v.webm?sig=1' })

    expect(path).toMatch(/\/assets\/generated\/video\/[0-9a-f-]{36}\.webm$/)
  })

  it('downloads from the URL when the temp copy is of another computer', async () => {
    const path = await save({ kind: 'video', type: 'video/mp4', src: `/home/bob/.cache/dez/media/${NAME}.mp4`, url: CLIP_URL })

    expect(moves).toEqual([])
    expect(downloads.map((download) => download.request.url)).toEqual([CLIP_URL])
    expect(path).not.toContain(NAME)
  })

  it.each<[string, Clip]>([
    ['a clip with no source', { kind: 'video', type: 'video/mp4', src: null, url: null }],
    ['a temp copy of another computer and no URL', { kind: 'video', type: 'video/mp4', src: `/home/bob/.cache/dez/media/${NAME}.mp4`, url: null }],
    ['a URL that is not http or https', { kind: 'video', type: 'video/mp4', src: null, url: 'file:///home/ann/.ssh/id_ed25519' }],
    ['a saved file as the URL', { kind: 'video', type: 'video/mp4', src: null, url: `${APP_DIR}/assets/generated/video/${NAME}.mp4` }],
    ['a clip of an unknown file type', { kind: 'video', type: 'application/octet-stream', src: CLIP_URL.replace('.mp4', ''), url: CLIP_URL.replace('.mp4', '') }],
  ])('writes no file, shows an error toast, and rejects for %s', async (_case, clip) => {
    await expect(save(clip)).rejects.toThrow()

    expect(moves).toEqual([])
    expect(downloads).toEqual([])
    expect(toasts).toMatchObject([{ title: 'Could not save the clip', variant: 'error' }])
    expect(consoleError).toHaveBeenCalledTimes(1)
  })

  it('writes no file and rejects for a relative Dez folder ($HOME not set), whose tags would not show as saved', async () => {
    appDir = './.config/dez'

    await expect(save({ kind: 'video', type: 'video/mp4', src: `${CACHE_DIR}/media/${NAME}.mp4`, url: CLIP_URL })).rejects.toThrow(appDir)
    await expect(save({ kind: 'video', type: 'video/mp4', src: null, url: CLIP_URL })).rejects.toThrow(appDir)

    expect(moves).toEqual([])
    expect(downloads).toEqual([])
  })

  it('logs, shows an error toast, and rejects when the server does not give the clip', async () => {
    downloadAppFile = async () => ({ status: 410, statusText: 'Gone', headers: {}, saved: false, body: [] })

    await expect(save({ kind: 'video', type: 'video/mp4', src: CLIP_URL, url: CLIP_URL })).rejects.toThrow('HTTP 410')

    expect(consoleError).toHaveBeenCalledWith('Failed to save the clip:', expect.any(Error))
    expect(toasts).toEqual([{
      title: 'Could not save the clip',
      message: 'The server of the clip answered HTTP 410',
      variant: 'error',
    }])
  })

  it('logs, shows an error toast, and rejects when the move or the download fails', async () => {
    moveAppFile = async () => {
      throw 'Failed to move media/a.mp4 to assets/generated/video/a.mp4: No such file or directory (os error 2)'
    }
    downloadAppFile = async () => {
      throw 'The response is larger than 1073741824 bytes'
    }

    await expect(save({ kind: 'video', type: 'video/mp4', src: `${CACHE_DIR}/media/a.mp4`, url: CLIP_URL }))
      .rejects.toBe('Failed to move media/a.mp4 to assets/generated/video/a.mp4: No such file or directory (os error 2)')
    await expect(save({ kind: 'video', type: 'video/mp4', src: CLIP_URL, url: CLIP_URL }))
      .rejects.toBe('The response is larger than 1073741824 bytes')

    // The move failed: the URL is not tried in its place.
    expect(downloads).toHaveLength(1)
    expect(consoleError).toHaveBeenCalledWith('Failed to save the clip:', 'The response is larger than 1073741824 bytes')
    expect(toasts).toEqual([
      { title: 'Could not save the clip', message: 'Failed to move media/a.mp4 to assets/generated/video/a.mp4: No such file or directory (os error 2)', variant: 'error' },
      { title: 'Could not save the clip', message: 'The response is larger than 1073741824 bytes', variant: 'error' },
    ])
  })
})

describe('dez.controller/media/delete', () => {
  function deleteClip(path: string): Promise<void> {
    return sbp('dez.controller/media/delete', path) as Promise<void>
  }

  it('deletes a saved clip of this Dez folder by its app-file path', async () => {
    await deleteClip(`${APP_DIR}/assets/generated/video/${NAME}.mp4`)
    await deleteClip(`${APP_DIR}/assets/generated/audio/a_1.mp3`)

    expect(deletedFiles).toStrictEqual([
      { root: 'app', path: `assets/generated/video/${NAME}.mp4` },
      { root: 'app', path: 'assets/generated/audio/a_1.mp3' },
    ])
    expect(toasts).toEqual([])
  })

  it.each([
    ['a clip of another Dez folder, even with a file of that name here', `/home/bob/.config/dez/assets/generated/video/${NAME}.mp4`],
    ['a temp copy', `${CACHE_DIR}/media/${NAME}.mp4`],
    ['an image', `${APP_DIR}/assets/generated/images/${NAME}.png`],
    ['a file of the Dez folder that is not a clip', `${APP_DIR}/app_state.json`],
    ['a URL', CLIP_URL],
  ])('deletes no file for %s', async (_case, path) => {
    await deleteClip(path)

    expect(deletedFiles).toEqual([])
    expect(toasts).toEqual([])
  })

  it('logs, shows an error toast, and rejects when the delete fails', async () => {
    const path = `${APP_DIR}/assets/generated/video/${NAME}.mp4`
    deleteAppFile = async () => {
      throw 'Failed to delete the file: Permission denied (os error 13)'
    }

    await expect(deleteClip(path)).rejects.toBe('Failed to delete the file: Permission denied (os error 13)')

    expect(consoleError).toHaveBeenCalledWith(`Failed to delete the clip ${path}:`, 'Failed to delete the file: Permission denied (os error 13)')
    expect(toasts).toEqual([{
      title: 'Could not delete the clip',
      message: 'Failed to delete the file: Permission denied (os error 13)',
      variant: 'error',
    }])
  })
})

// One test for the whole life of the cleanup: it starts once for the app, so
// a second test could not start it again.
describe('dez.controller/media/startCleanup', () => {
  const HOUR = 60 * 60 * 1000
  const start = Date.UTC(2026, 10, 10, 12)
  const cacheFiles = (...names: string[]): AppFileRef[] => names.map((name) => ({ root: 'cache', path: `media/${name}` }))

  it('deletes the temp copies that are older than the temp lifetime, at the start and each hour', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(start)
    let files: AppFileEntry[] = [
      { name: 'old.mp4', updatedAt: start - MEDIA_TEMP_LIFETIME_MS - 1 },
      { name: 'at-the-end.mp3', updatedAt: start - MEDIA_TEMP_LIFETIME_MS },
      { name: 'one-ms-left.mp4', updatedAt: start - MEDIA_TEMP_LIFETIME_MS + 1 },
      { name: 'new.mp4', updatedAt: start },
      // The temp file of a download that the app did not end.
      { name: 'cut.mp4.4012.7.tmp', updatedAt: start - 2 * MEDIA_TEMP_LIFETIME_MS },
    ]
    // The list is what the folder holds: a deleted file is not in it again.
    listAppFiles = async () => files.filter((file) => !deletedFiles.some((deleted) => deleted.path === `media/${file.name}`))

    sbp('dez.controller/media/startCleanup')
    // A second start adds no second run.
    sbp('dez.controller/media/startCleanup')
    await vi.advanceTimersByTimeAsync(0)

    expect(listedFolders).toStrictEqual([{ root: 'cache', path: 'media' }])
    expect(deletedFiles).toStrictEqual(cacheFiles('old.mp4', 'at-the-end.mp3', 'cut.mp4.4012.7.tmp'))

    await vi.advanceTimersByTimeAsync(HOUR - 1)
    expect(listedFolders).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(1)
    expect(listedFolders).toHaveLength(2)
    expect(deletedFiles).toStrictEqual(cacheFiles('old.mp4', 'at-the-end.mp3', 'cut.mp4.4012.7.tmp', 'one-ms-left.mp4'))

    // A file that cannot be deleted does not stop the other deletes.
    files = [
      { name: 'locked.mp4', updatedAt: 0 },
      { name: 'free.mp4', updatedAt: 0 },
    ]
    deleteAppFile = async (file) => {
      if (file.path === 'media/locked.mp4') throw 'Failed to delete media/locked.mp4: Permission denied (os error 13)'
    }
    await vi.advanceTimersByTimeAsync(HOUR)

    expect(deletedFiles.slice(4)).toStrictEqual(cacheFiles('free.mp4'))
    expect(consoleError).toHaveBeenCalledTimes(1)
    expect(consoleError).toHaveBeenCalledWith('Failed to delete the old temp copy locked.mp4:', 'Failed to delete media/locked.mp4: Permission denied (os error 13)')

    // A folder that cannot be read is logged, and the next run works again.
    listAppFiles = async () => {
      throw 'Failed to list media: Permission denied (os error 13)'
    }
    await vi.advanceTimersByTimeAsync(HOUR)

    expect(consoleError).toHaveBeenLastCalledWith('Failed to list the temp copies of clips:', 'Failed to list media: Permission denied (os error 13)')

    deleteAppFile = async () => {}
    listAppFiles = async () => [{ name: 'locked.mp4', updatedAt: 0 }]
    await vi.advanceTimersByTimeAsync(HOUR)

    expect(deletedFiles.slice(5)).toStrictEqual(cacheFiles('locked.mp4'))
    // The user did not ask for the cleanup, so its failures show no toast.
    expect(toasts).toEqual([])
  })
})
