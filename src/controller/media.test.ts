import sbp from '@sbp/sbp'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import type { AudioPart, CutAudio } from '../model/chat/audioCut'
import { ClipReadError, MEDIA_TEMP_LIFETIME_MS, savedMediaFile } from '../model/chat/mediaFiles'
import type { MediaTagData } from '../model/chat/mediaTags'
import type {
  NativeDownloadRule,
  NativeHttpDownload,
  NativeHttpRequest,
  NativeHttpResponseHead,
  NativeHttpStreamResult,
} from '../utils/protocol/nativeHttp'
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
let streams: NativeHttpRequest[] = []
let streamAnswer: () => Promise<NativeHttpResponseHead>
let cancelledStreams: string[] = []
let cancelStream: () => Promise<void>
let streamBody: AsyncIterable<Uint8Array>
let savedFiles: Array<{ path: string, bytes: Uint8Array }> = []
let saveAppFile: () => Promise<void>
let readFiles: string[] = []
let readFile: (path: string) => Promise<File>
let consoleError: MockInstance<typeof console.error>

// The body of a stream that the code under test must not read.
const UNREAD_BODY: AsyncIterable<Uint8Array> = {
  [Symbol.asyncIterator] () {
    throw new Error('The body was read')
  },
}

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
  async 'dez.http/stream' (request: NativeHttpRequest): Promise<NativeHttpStreamResult> {
    streams.push(request)
    const requestId = `stream-${streams.length}`
    return { requestId, response: await streamAnswer(), chunks: streamBody }
  },
  async 'dez.http/cancelStream' (requestId: string): Promise<void> {
    cancelledStreams.push(requestId)
    await cancelStream()
  },
  async 'dez.native/saveAppFile' (path: string, bytes: Uint8Array): Promise<void> {
    await saveAppFile()
    savedFiles.push({ path, bytes })
  },
  async 'dez.controller/images/readFile' (path: string): Promise<File> {
    readFiles.push(path)
    return readFile(path)
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
  streams = []
  streamAnswer = async () => ({ status: 206, statusText: 'Partial Content', headers: { 'content-range': 'bytes 0-0/1000' } })
  cancelledStreams = []
  cancelStream = async () => {}
  streamBody = UNREAD_BODY
  savedFiles = []
  saveAppFile = async () => {}
  readFiles = []
  readFile = async () => {
    throw new Error('The file cannot be read (HTTP 404).')
  }
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

  const NO_SOURCE = 'Dez cannot save this clip: its temp copy is not on this computer, and it has no web address to download it from. Make the clip again.'

  it.each<[string, Clip, string]>([
    ['a clip with no source', { kind: 'video', type: 'video/mp4', src: null, url: null }, NO_SOURCE],
    ['a temp copy of another computer and no URL', { kind: 'video', type: 'video/mp4', src: `/home/bob/.cache/dez/media/${NAME}.mp4`, url: null }, NO_SOURCE],
    ['a URL that is not http or https', { kind: 'video', type: 'video/mp4', src: null, url: 'file:///home/ann/.ssh/id_ed25519' }, NO_SOURCE],
    ['a saved file as the URL', { kind: 'video', type: 'video/mp4', src: null, url: `${APP_DIR}/assets/generated/video/${NAME}.mp4` }, NO_SOURCE],
    [
      'a clip of an unknown file type',
      { kind: 'video', type: 'application/octet-stream', src: CLIP_URL.replace('.mp4', ''), url: CLIP_URL.replace('.mp4', '') },
      'Dez does not know the file type of this clip (application/octet-stream), so it cannot save it. Report this at Help › Dez on GitHub.',
    ],
  ])('writes no file, shows an error toast, and rejects for %s', async (_case, clip, message) => {
    await expect(save(clip)).rejects.toThrow(message)

    expect(moves).toEqual([])
    expect(downloads).toEqual([])
    expect(toasts).toStrictEqual([{ title: 'Could not save the clip', message, variant: 'error' }])
    expect(consoleError).toHaveBeenCalledTimes(1)
  })

  it('writes no file and rejects for a relative Dez folder ($HOME not set), whose tags would not show as saved', async () => {
    appDir = './.config/dez'

    await expect(save({ kind: 'video', type: 'video/mp4', src: `${CACHE_DIR}/media/${NAME}.mp4`, url: CLIP_URL })).rejects.toThrow(appDir)
    await expect(save({ kind: 'video', type: 'video/mp4', src: null, url: CLIP_URL })).rejects.toThrow(appDir)

    expect(moves).toEqual([])
    expect(downloads).toEqual([])
  })

  it.each([
    [410, 'The clip is not on its server any more: its link has expired, or the provider deleted it. Make the clip again.\n\nDetails: HTTP 410'],
    [503, 'The server of the clip has a problem. Try again later.\n\nDetails: HTTP 503'],
    [400, 'The server of the clip refused to send it. Try again later. If the error stays, make the clip again.\n\nDetails: HTTP 400'],
  ])('logs, shows an error toast, and rejects when the server answers HTTP %i', async (status, message) => {
    downloadAppFile = async () => ({ status, statusText: '', headers: {}, saved: false, body: [] })

    await expect(save({ kind: 'video', type: 'video/mp4', src: CLIP_URL, url: CLIP_URL })).rejects.toThrow(message)

    expect(consoleError).toHaveBeenCalledWith('Failed to save the clip:', expect.any(Error))
    expect(toasts).toEqual([{ title: 'Could not save the clip', message, variant: 'error' }])
  })

  it('writes the bytes of a clip that Dez made to a new file of its type, with no move and no download', async () => {
    const bytes = Uint8Array.from([1, 2, 3])
    const clip: Clip = { kind: 'audio', type: 'audio/wav', src: `${CACHE_DIR}/media/${NAME}.mp3`, url: CLIP_URL }
    const path = await sbp('dez.controller/media/save', clip, { bytes }) as string

    expect(path).toMatch(/^\/home\/ann\/\.config\/dez\/assets\/generated\/audio\/[0-9a-f-]{36}\.wav$/)
    expect(savedFiles).toStrictEqual([{ path: path.slice(APP_DIR.length + 1), bytes }])
    expect(moves).toEqual([])
    expect(downloads).toEqual([])
    expect(toasts).toEqual([])
  })

  it('writes the bytes of a pasted clip file to the pasted folder of its kind', async () => {
    const bytes = Uint8Array.from([4, 5])
    const audio = await sbp('dez.controller/media/save', { kind: 'audio', type: 'audio/mpeg', src: null, url: null }, { bytes, folder: 'pasted' }) as string
    const video = await sbp('dez.controller/media/save', { kind: 'video', type: 'video/quicktime', src: null, url: null }, { bytes, folder: 'pasted' }) as string

    expect(audio).toMatch(/^\/home\/ann\/\.config\/dez\/assets\/audio\/[0-9a-f-]{36}\.mp3$/)
    expect(video).toMatch(/^\/home\/ann\/\.config\/dez\/assets\/video\/[0-9a-f-]{36}\.mov$/)
    expect(savedFiles).toStrictEqual([{ path: audio.slice(APP_DIR.length + 1), bytes }, { path: video.slice(APP_DIR.length + 1), bytes }])
    expect(toasts).toEqual([])
  })

  it('logs, shows an error toast, and rejects when the bytes cannot be written', async () => {
    const writeError = 'Failed to write assets/generated/audio/a.wav: No space left on device (os error 28)'
    saveAppFile = async () => {
      throw writeError
    }
    const message = 'The system did not let Dez write the clip file. The details tell why (for example, the disk is full). Fix that, and try again.'
      + `\n\nDetails: ${writeError}`

    await expect(sbp('dez.controller/media/save', { kind: 'audio', type: 'audio/wav', src: null, url: null }, { bytes: new Uint8Array(4) }))
      .rejects.toThrow(message)

    expect(consoleError).toHaveBeenCalledWith('Failed to save the clip:', expect.objectContaining({ cause: writeError }))
    expect(toasts).toStrictEqual([{ title: 'Could not save the clip', message, variant: 'error' }])
  })

  it('logs, shows an error toast, and rejects when the move or the download fails', async () => {
    const moveError = 'Failed to move media/a.mp4 to assets/generated/video/a.mp4: No such file or directory (os error 2)'
    const downloadError = 'The response is larger than 1073741824 bytes'
    moveAppFile = async () => {
      throw moveError
    }
    downloadAppFile = async () => {
      throw downloadError
    }
    const moveMessage = 'Dez could not move the temp copy of the clip into the Dez folder. The copy is gone, or the system did not let Dez write the file: the details tell which. If the copy is gone, make the clip again. Else fix the problem, and try again.'
      + `\n\nDetails: ${moveError}`
    const downloadMessage = 'Dez could not download the clip. The network failed, the clip is larger than 1.0 GB (the most that Dez saves), or the system did not let Dez write the file: the details tell which. Try again, unless the clip is too large.'
      + `\n\nDetails: ${downloadError}`

    await expect(save({ kind: 'video', type: 'video/mp4', src: `${CACHE_DIR}/media/a.mp4`, url: CLIP_URL }))
      .rejects.toThrow(moveMessage)
    await expect(save({ kind: 'video', type: 'video/mp4', src: CLIP_URL, url: CLIP_URL }))
      .rejects.toThrow(downloadMessage)

    // The move failed: the URL is not tried in its place.
    expect(downloads).toHaveLength(1)
    expect(consoleError).toHaveBeenCalledWith('Failed to save the clip:', expect.objectContaining({ cause: downloadError }))
    expect(toasts).toEqual([
      { title: 'Could not save the clip', message: moveMessage, variant: 'error' },
      { title: 'Could not save the clip', message: downloadMessage, variant: 'error' },
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
    await deleteClip(`${APP_DIR}/assets/video/${NAME}.mov`)

    expect(deletedFiles).toStrictEqual([
      { root: 'app', path: `assets/generated/video/${NAME}.mp4` },
      { root: 'app', path: 'assets/generated/audio/a_1.mp3' },
      { root: 'app', path: `assets/video/${NAME}.mov` },
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
      message: 'The system did not let Dez delete the clip file. The details tell why (for example, Dez has no permission to change the folder). Fix that, and try again.\n\nDetails: Failed to delete the file: Permission denied (os error 13)',
      variant: 'error',
    }])
  })
})

describe('dez.controller/media/urlAnswers', () => {
  function urlAnswers(url: string): Promise<boolean> {
    return sbp('dez.controller/media/urlAnswers', url) as Promise<boolean>
  }

  const NO_ANSWER_LOG = ['Failed to ask the URL of a clip whether it answers']

  it('asks for the first byte with one GET, no other header, and a short time limit, and stops the answer unread', async () => {
    expect(await urlAnswers(CLIP_URL)).toBe(true)

    expect(streams).toStrictEqual([{ method: 'GET', url: CLIP_URL, headers: { Range: 'bytes=0-0' }, timeoutMs: expect.any(Number) }])
    // The player waits for the answer.
    expect(streams[0].timeoutMs).toBeGreaterThan(0)
    expect(streams[0].timeoutMs).toBeLessThanOrEqual(30_000)
    expect(cancelledStreams).toStrictEqual(['stream-1'])
    expect(consoleError).not.toHaveBeenCalled()
  })

  it('takes each 2xx status as an answer, also the whole clip from a server that takes no ranges', async () => {
    for (const status of [200, 206, 299]) {
      streamAnswer = async () => ({ status, headers: {} })
      expect(await urlAnswers(CLIP_URL), String(status)).toBe(true)
    }
    expect(cancelledStreams).toStrictEqual(['stream-1', 'stream-2', 'stream-3'])
  })

  it('takes any other status as no answer, and logs nothing for it', async () => {
    const statuses = [199, 300, 403, 404, 410, 416, 500]
    for (const status of statuses) {
      streamAnswer = async () => ({ status, headers: {} })
      expect(await urlAnswers(CLIP_URL), String(status)).toBe(false)
    }
    expect(cancelledStreams).toHaveLength(statuses.length)
    expect(consoleError).not.toHaveBeenCalled()
  })

  it('gives no answer for a request that fails or times out, and logs neither the URL nor the error', async () => {
    for (const error of [new Error(`error sending request for url (${CLIP_URL})`), 'operation timed out']) {
      streamAnswer = async () => {
        throw error
      }
      expect(await urlAnswers(CLIP_URL)).toBe(false)
    }

    expect(cancelledStreams).toStrictEqual([])
    expect(consoleError.mock.calls).toStrictEqual([NO_ANSWER_LOG, NO_ANSWER_LOG])
  })

  it('still gives the answer when the stop of the answer fails', async () => {
    cancelStream = async () => {
      throw 'The stream was not found'
    }

    expect(await urlAnswers(CLIP_URL)).toBe(true)
    expect(consoleError.mock.calls).toStrictEqual([['Failed to stop the answer of a clip URL:', 'The stream was not found']])
  })
})

describe('dez.controller/media/readClip', () => {
  type ReadClip = Pick<MediaTagData, 'type' | 'src' | 'url' | 'expires'>
  const SAVED_PATH = `${APP_DIR}/assets/generated/audio/${NAME}.mp3`
  const TEMP_PATH = `${CACHE_DIR}/media/${NAME}.mp3`
  const FUTURE = '2999-01-01T00:00:00.000Z'
  const PAST = '2000-01-01T00:00:00.000Z'

  function readClip(clip: ReadClip): Promise<Blob> {
    return sbp('dez.controller/media/readClip', clip) as Promise<Blob>
  }

  async function readError(clip: ReadClip): Promise<ClipReadError> {
    const error = await readClip(clip).then(() => undefined, (caught: unknown) => caught)
    expect(error).toBeInstanceOf(ClipReadError)
    return error as ClipReadError
  }

  async function bytesOf(blob: Blob): Promise<number[]> {
    return [...new Uint8Array(await blob.arrayBuffer())]
  }

  function body(...parts: number[][]): AsyncIterable<Uint8Array> {
    return (async function * () {
      for (const part of parts) yield Uint8Array.from(part)
    })()
  }

  it('reads a saved file or a temp copy through the asset protocol, before the URL', async () => {
    readFile = async (path) => new File([Uint8Array.from([path.length])], 'clip.mp3', { type: 'audio/mpeg' })

    expect(await bytesOf(await readClip({ type: 'audio/mpeg', src: SAVED_PATH, url: CLIP_URL, expires: null }))).toStrictEqual([SAVED_PATH.length])
    expect(await bytesOf(await readClip({ type: 'audio/mpeg', src: TEMP_PATH, url: CLIP_URL, expires: FUTURE }))).toStrictEqual([TEMP_PATH.length])

    expect(readFiles).toStrictEqual([SAVED_PATH, TEMP_PATH])
    expect(streams).toEqual([])
  })

  it('downloads a clip that plays from its URL once, with no header, and gives the bytes with the clip type', async () => {
    streamAnswer = async () => ({ status: 200, headers: { 'content-type': 'application/octet-stream' } })
    streamBody = body([1, 2], [3])

    const blob = await readClip({ type: 'audio/mpeg', src: CLIP_URL, url: CLIP_URL, expires: FUTURE })

    expect(blob.type).toBe('audio/mpeg')
    expect(await bytesOf(blob)).toStrictEqual([1, 2, 3])
    expect(streams).toStrictEqual([{ method: 'GET', url: CLIP_URL, timeoutMs: expect.any(Number) }])
    expect(readFiles).toEqual([])
  })

  it('downloads from the URL when the saved file cannot be read', async () => {
    streamAnswer = async () => ({ status: 200, headers: {} })
    streamBody = body([7])

    expect(await bytesOf(await readClip({ type: 'audio/mpeg', src: SAVED_PATH, url: CLIP_URL, expires: FUTURE }))).toStrictEqual([7])
    expect(readFiles).toStrictEqual([SAVED_PATH])
    expect(streams.map((request) => request.url)).toStrictEqual([CLIP_URL])
  })

  it('throws "deleted" for a clip with no source', async () => {
    expect((await readError({ type: 'audio/mpeg', src: null, url: null, expires: null })).problem).toBe('deleted')
  })

  it('throws "expired" when no source gives the bytes after the clip expired, else "unreadable", with details that hold no path or URL', async () => {
    streamAnswer = async () => ({ status: 403, headers: {} })
    const expired = await readError({ type: 'audio/mpeg', src: TEMP_PATH, url: CLIP_URL, expires: PAST })
    expect([expired.problem, expired.details]).toStrictEqual(['expired', 'The file cannot be read (HTTP 404). The server of the clip answered HTTP 403.'])
    expect(cancelledStreams).toStrictEqual(['stream-1'])

    streamAnswer = async () => {
      throw new Error(`error sending request for url (${CLIP_URL})`)
    }
    const unreadable = await readError({ type: 'audio/mpeg', src: CLIP_URL, url: CLIP_URL, expires: FUTURE })
    expect([unreadable.problem, unreadable.details]).toStrictEqual(['unreadable', 'The server of the clip gave no answer.'])

    // A path of another home is no file of Dez: it is never read.
    const foreign = await readError({ type: 'audio/mpeg', src: '/home/bob/song.mp3', url: null, expires: null })
    expect([foreign.problem, foreign.details]).toStrictEqual(['unreadable', 'A source of the clip is not a file of Dez or a web address.'])

    for (const error of [expired, unreadable, foreign]) {
      expect(error.message).not.toContain('/home/')
      expect(error.message).not.toContain('cdn.example')
    }
    expect(readFiles).toStrictEqual([TEMP_PATH])
    expect(consoleError).not.toHaveBeenCalled()
  })

  it('throws "unreadable" when the answer of the server breaks off', async () => {
    streamAnswer = async () => ({ status: 200, headers: {} })
    streamBody = (async function * () {
      yield Uint8Array.from([1])
      throw new Error(`connection reset: ${CLIP_URL}`)
    })()

    const error = await readError({ type: 'audio/mpeg', src: null, url: CLIP_URL, expires: null })
    expect([error.problem, error.details]).toStrictEqual(['unreadable', 'The answer of the server of the clip broke off.'])
  })
})

describe('dez.controller/media/cutAudio', () => {
  const RATE = 48000
  let decoded: Float32Array[] | Error
  let contexts: number[][]
  let decodedInputs: number[][]

  // Web Audio's offline context, as the cut uses it: the decode gives the
  // channels of `decoded` at the context's rate.
  class FakeOfflineAudioContext {
    readonly rate: number

    constructor(channels: number, length: number, rate: number) {
      contexts.push([channels, length, rate])
      this.rate = rate
    }

    async decodeAudioData(data: ArrayBuffer) {
      decodedInputs.push([...new Uint8Array(data)])
      if (decoded instanceof Error) throw decoded
      const channels = decoded
      return {
        sampleRate: this.rate,
        length: channels[0].length,
        duration: channels[0].length / this.rate,
        numberOfChannels: channels.length,
        getChannelData: (index: number) => channels[index],
      }
    }
  }

  function cutAudio(plan: (duration: number) => AudioPart | null): Promise<CutAudio | null> {
    return sbp('dez.controller/media/cutAudio', new Blob([Uint8Array.from([5, 6])]), plan) as Promise<CutAudio | null>
  }

  beforeEach(() => {
    contexts = []
    decodedInputs = []
    vi.stubGlobal('OfflineAudioContext', FakeOfflineAudioContext)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('decodes the file at 48 kHz, asks the plan with the length in seconds, and gives the part as a 16-bit WAV file', async () => {
    // Two seconds of stereo; the first frame of the part is marked.
    const left = new Float32Array(2 * RATE)
    const right = new Float32Array(2 * RATE)
    left[RATE / 2] = 0.5
    right[RATE / 2] = -1
    decoded = [left, right]
    const durations: number[] = []

    const cut = await cutAudio((duration) => {
      durations.push(duration)
      return { start: 0.5, end: 1 }
    })

    expect(contexts.map(([, , rate]) => rate)).toStrictEqual([RATE])
    expect(decodedInputs).toStrictEqual([[5, 6]])
    expect(durations).toStrictEqual([2])
    expect([cut?.part, cut?.duration]).toStrictEqual([{ start: 0.5, end: 1 }, 0.5])
    const wav = new DataView(cut!.bytes.buffer)
    expect({
      length: cut!.bytes.length,
      channels: wav.getUint16(22, true),
      rate: wav.getUint32(24, true),
      firstFrame: [wav.getInt16(44, true), wav.getInt16(46, true)],
    }).toStrictEqual({ length: 44 + RATE / 2 * 2 * 2, channels: 2, rate: RATE, firstFrame: [16384, -32768] })
  })

  it('cuts nothing when the plan gives null', async () => {
    decoded = [new Float32Array(RATE)]

    expect(await cutAudio(() => null)).toBeNull()
  })

  it('rejects with a text for a model when the webview cannot decode the file, and with the error of the plan', async () => {
    const decodeError = new Error('Decoding failed')
    decoded = decodeError
    await expect(cutAudio(() => null)).rejects.toThrow(expect.objectContaining({ message: 'The audio cannot be decoded.', cause: decodeError }))

    decoded = [new Float32Array(RATE)]
    const planError = new Error('"start" must be 0 or more.')
    await expect(cutAudio(() => {
      throw planError
    })).rejects.toBe(planError)
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
      { name: 'old.mp4', updatedAt: start - MEDIA_TEMP_LIFETIME_MS - 1, size: 4 },
      { name: 'at-the-end.mp3', updatedAt: start - MEDIA_TEMP_LIFETIME_MS, size: 4 },
      { name: 'one-ms-left.mp4', updatedAt: start - MEDIA_TEMP_LIFETIME_MS + 1, size: 4 },
      { name: 'new.mp4', updatedAt: start, size: 4 },
      // The temp file of a download that the app did not end.
      { name: 'cut.mp4.4012.7.tmp', updatedAt: start - 2 * MEDIA_TEMP_LIFETIME_MS, size: 4 },
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
      { name: 'locked.mp4', updatedAt: 0, size: 4 },
      { name: 'free.mp4', updatedAt: 0, size: 4 },
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
    listAppFiles = async () => [{ name: 'locked.mp4', updatedAt: 0, size: 4 }]
    await vi.advanceTimersByTimeAsync(HOUR)

    expect(deletedFiles.slice(5)).toStrictEqual(cacheFiles('locked.mp4'))
    // The user did not ask for the cleanup, so its failures show no toast.
    expect(toasts).toEqual([])
  })
})
