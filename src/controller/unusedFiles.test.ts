import sbp from '@sbp/sbp'
import '@sbp/okturtles.eventqueue'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { UNUSED_FILE_MIN_AGE_MS, type UnusedFiles, type UnusedFilesDeleted } from '../model/chat/unusedFiles'
import { holdingCachePath } from './cacheHolds'
import type { AppFileEntry, AppFileRoot } from './nativeTypes'
import './unusedFiles'

interface Toast {
  title?: string
  message: string
  variant?: string
}

const APP_DIR = '/home/ann/.config/dez'
const CACHE_DIR = '/home/ann/.cache/dez'
const NOW = 1_800_000_000_000
const OLD = NOW - UNUSED_FILE_MIN_AGE_MS

// What the stub selectors below give, and what they were asked for. Reset
// in beforeEach. A key of `folders` is the root and the path of a listing
// (`app:assets/images`), with `:folders` for a listing of folders; an entry
// of `deletedFiles` is the root and the path, with ` (folder)` for a folder
// delete.
let folders: Record<string, AppFileEntry[]> = {}
let listAppFiles: (key: string) => Promise<AppFileEntry[]>
let conversations: string[] = []
let conversationsError: unknown = null
let conversationReads = 0
let heldTexts: string[] = []
let jobAssetSources: string[] = []
let deletedFiles: string[] = []
let deleteAppFile: (path: string) => Promise<void>
let toasts: Toast[] = []
let consoleError: MockInstance<typeof console.error>

sbp('sbp/selectors/register', {
  async 'dez.native/getAppDir' (root: AppFileRoot = 'app'): Promise<string> {
    return root === 'app' ? APP_DIR : CACHE_DIR
  },
  async 'dez.native/listAppFiles' (path: string, root: AppFileRoot = 'app', { folders = false }: { folders?: boolean } = {}): Promise<AppFileEntry[]> {
    return listAppFiles(`${root}:${path}${folders ? ':folders' : ''}`)
  },
  async 'dez.native/deleteAppFile' (path: string, root: AppFileRoot = 'app', { folder = false }: { folder?: boolean } = {}): Promise<void> {
    await deleteAppFile(path)
    deletedFiles.push(`${root}:${path}${folder ? ' (folder)' : ''}`)
  },
  async 'dez.persistence/eachConversationText' (visit: (text: string, index: number, count: number) => void): Promise<void> {
    conversationReads++
    for (const [index, text] of conversations.entries()) {
      await Promise.resolve()
      visit(text, index, conversations.length)
    }
    if (conversationsError !== null) throw conversationsError
  },
  'dez.model/heldTexts' (): string[] {
    return heldTexts
  },
  'dez.stream/jobAssetSources' (): string[] {
    return jobAssetSources
  },
  'dez.ui/toast' (_area: string, toast: Toast): void {
    toasts.push(toast)
  },
})

function file (name: string, size: number, updatedAt = OLD): AppFileEntry {
  return { name, updatedAt, size }
}

async function find (): Promise<{ unused: UnusedFiles, progress: number[] }> {
  const progress: number[] = []
  const unused = await sbp('dez.controller/unusedFiles/find', (fraction: number) => progress.push(fraction)) as UnusedFiles
  return { unused, progress }
}

function deleteUnused (unused: UnusedFiles): Promise<UnusedFilesDeleted> {
  return sbp('dez.controller/unusedFiles/delete', unused) as Promise<UnusedFilesDeleted>
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  folders = {}
  listAppFiles = async (key) => folders[key] ?? []
  conversations = []
  conversationsError = null
  conversationReads = 0
  heldTexts = []
  jobAssetSources = []
  deletedFiles = []
  deleteAppFile = async () => {}
  toasts = []
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  consoleError.mockRestore()
  vi.useRealTimers()
})

describe('dez.controller/unusedFiles/find', () => {
  const READ_FAILURE = 'The system did not let Dez read all of its files, so Dez deletes no file. The details tell why (for example, Dez has no permission to read a file). Fix that, and try again.'

  it('gives the old files of every stored-file folder that no text names, with their total size', async () => {
    folders = {
      'app:assets/images': [file('pasted-used.png', 1), file('pasted-free.png', 20), file('pasted-new.png', 300, OLD + 1)],
      'app:assets/generated/images': [file('made-held.webp', 4000), file('made-free.jpg', 50_000), file('made-by-job.png', 9)],
      'app:assets/generated/audio': [file('speech-prompt.mp3', 600_000), file('speech-free.wav', 7_000_000)],
      'app:assets/generated/video': [file('film-used.mp4', 80_000_000), file('film.mp4.4012.7.tmp', 900_000_000)],
      'app:assets/audio': [file('memo-free.m4a', 100)],
      'app:assets/video': [file('pasted-used.webm', 3_000_000)],
    }
    conversations = [
      `---\ntitle: One\n---\n![${APP_DIR}/assets/images/pasted-used.png](id=a)\n`,
      'No file here.',
      `<dez:video id="b" type="video/mp4" src="${APP_DIR}/assets/generated/video/film-used.mp4"/>\n`
        + `<dez:video id="d" type="video/webm" src="${APP_DIR}/assets/video/pasted-used.webm"/>\n`,
    ]
    // A tab that is not saved yet, and a saved prompt.
    heldTexts = [`![${APP_DIR}/assets/generated/images/made-held.webp](id=c)`, 'Say it as in speech-prompt.mp3']
    // The image of a job result that no text names yet.
    jobAssetSources = [`${APP_DIR}/assets/generated/images/made-by-job.png`]

    const { unused, progress } = await find()

    expect(unused).toStrictEqual({
      files: [
        { root: 'app', path: 'assets/images/pasted-free.png', size: 20 },
        { root: 'app', path: 'assets/generated/images/made-free.jpg', size: 50_000 },
        { root: 'app', path: 'assets/generated/audio/speech-free.wav', size: 7_000_000 },
        { root: 'app', path: 'assets/audio/memo-free.m4a', size: 100 },
      ],
      bytes: 7_050_120,
    })
    expect(progress).toEqual([0, 1 / 3, 2 / 3, 1, 1])
    expect(deletedFiles).toEqual([])
    expect(toasts).toEqual([])
  })

  it('gives the old entries of the cache folder that nothing uses, a work folder with the size of its files', async () => {
    folders = {
      'cache:media': [
        file('copy-used.mp4', 1),
        file('copy-of-job.webm', 2),
        file('copy-free.mp4', 30),
        file('copy-new.mp4', 4, OLD + 1),
        file('d1.part', 500),
        file('d2.part.4012.7.tmp', 6000),
        file('held.part.4012.7.tmp', 7),
        file('notes', 8),
      ],
      'cache:work:folders': [file('w1', 0), file('w-new', 0, OLD + 1), file('w-held', 0)],
      'cache:work/w1': [file('in.mp4', 70_000), file('out.mp4', 800_000)],
      'cache:work/w-held': [file('in.mp4', 9)],
    }
    conversations = [`<dez:video id="a" type="video/mp4" src="${CACHE_DIR}/media/copy-used.mp4"/>\n`]
    jobAssetSources = [`${CACHE_DIR}/media/copy-of-job.webm`]
    // A run in a work folder, and a download, of this app.
    let endWork = (): void => {}
    const work = holdingCachePath('work/w-held', () => new Promise<void>((resolve) => { endWork = resolve }))
    let endDownload = (): void => {}
    const download = holdingCachePath('media/held.part', () => new Promise<void>((resolve) => { endDownload = resolve }))

    const { unused } = await find()
    endWork()
    endDownload()
    await Promise.all([work, download])

    expect(unused).toStrictEqual({
      files: [
        { root: 'cache', path: 'media/copy-free.mp4', size: 30 },
        { root: 'cache', path: 'media/d1.part', size: 500 },
        { root: 'cache', path: 'media/d2.part.4012.7.tmp', size: 6000 },
        { root: 'cache', path: 'work/w1', size: 870_000 },
      ],
      bytes: 876_530,
    })
  })

  it('reads no conversation when the folders hold no old file', async () => {
    folders = { 'app:assets/images': [file('new.png', 5, NOW)], 'cache:work:folders': [file('w-new', 0, NOW)] }
    conversations = ['text']

    const { unused, progress } = await find()

    expect(unused).toStrictEqual({ files: [], bytes: 0 })
    expect(progress).toEqual([0, 1])
    expect(conversationReads).toBe(0)
  })

  // No text names a download or a work folder, so a read of the
  // conversations would find nothing.
  it('reads no conversation when only downloads and work folders are old', async () => {
    folders = { 'cache:media': [file('d1.part', 500)], 'cache:work:folders': [file('w1', 0)] }
    conversations = ['text']

    const { unused, progress } = await find()

    expect(unused).toStrictEqual({
      files: [{ root: 'cache', path: 'media/d1.part', size: 500 }, { root: 'cache', path: 'work/w1', size: 0 }],
      bytes: 500,
    })
    expect(progress).toEqual([0, 1])
    expect(conversationReads).toBe(0)
  })

  it('gives every old file when there is no conversation', async () => {
    folders = { 'app:assets/images': [file('a.png', 5)] }

    expect((await find()).unused).toStrictEqual({ files: [{ root: 'app', path: 'assets/images/a.png', size: 5 }], bytes: 5 })
  })

  // A scan that took the conversations it could read for all of them would
  // give the files of the others as unused.
  it('rejects with an error toast when the conversations cannot all be read', async () => {
    folders = { 'app:assets/images': [file('a.png', 5)] }
    conversations = ['first']
    conversationsError = 'Failed to read conversations/b.md: Permission denied (os error 13)'

    await expect(find()).rejects.toBe(conversationsError)

    expect(toasts).toStrictEqual([{ title: 'Could not look for unused files', message: `${READ_FAILURE}\n\nDetails: ${conversationsError}`, variant: 'error' }])
    expect(consoleError).toHaveBeenCalled()
  })

  it.each(['app:assets/generated/video', 'cache:media', 'cache:work/w1'])('rejects with an error toast when %s cannot be listed', async (failing) => {
    folders = { 'cache:work:folders': [file('w1', 0)] }
    listAppFiles = async (key) => {
      if (key === failing) throw new Error(`Failed to list ${failing}`)
      return folders[key] ?? [file('a.png', 5)]
    }

    await expect(find()).rejects.toThrow(`Failed to list ${failing}`)

    expect(toasts).toStrictEqual([{ title: 'Could not look for unused files', message: `${READ_FAILURE}\n\nDetails: Failed to list ${failing}`, variant: 'error' }])
    expect(conversationReads).toBe(0)
  })
})

describe('dez.controller/unusedFiles/delete', () => {
  const unused: UnusedFiles = {
    files: [
      { root: 'app', path: 'assets/images/a.png', size: 10 },
      { root: 'app', path: 'assets/generated/images/b.webp', size: 200 },
      { root: 'app', path: 'assets/generated/video/c.mp4', size: 3000 },
      { root: 'cache', path: 'media/d.mp4', size: 40_000 },
      { root: 'cache', path: 'media/e.part.4012.7.tmp', size: 500_000 },
      { root: 'cache', path: 'work/f', size: 6_000_000 },
    ],
    bytes: 6_543_210,
  }

  it('deletes the files and counts them, a work folder as a folder', async () => {
    expect(await deleteUnused(unused)).toStrictEqual({ deleted: 6, bytes: 6_543_210, inUse: 0, failed: 0 })
    expect(deletedFiles).toEqual([
      'app:assets/images/a.png',
      'app:assets/generated/images/b.webp',
      'app:assets/generated/video/c.mp4',
      'cache:media/d.mp4',
      'cache:media/e.part.4012.7.tmp',
      'cache:work/f (folder)',
    ])
    expect(toasts).toEqual([])
  })

  it('keeps a file that a text in memory or a job result names since the scan', async () => {
    heldTexts = ['', `Now with ![${APP_DIR}/assets/generated/images/b.webp](id=a)`]
    jobAssetSources = [`${CACHE_DIR}/media/d.mp4`]

    expect(await deleteUnused(unused)).toStrictEqual({ deleted: 4, bytes: 6_503_010, inUse: 2, failed: 0 })
    expect(deletedFiles).toEqual(['app:assets/images/a.png', 'app:assets/generated/video/c.mp4', 'cache:media/e.part.4012.7.tmp', 'cache:work/f (folder)'])
  })

  it('keeps a cache entry that work of this app holds since the scan', async () => {
    let endWork = (): void => {}
    const work = holdingCachePath('work/f', () => new Promise<void>((resolve) => { endWork = resolve }))
    let endDownload = (): void => {}
    const download = holdingCachePath('media/e.part', () => new Promise<void>((resolve) => { endDownload = resolve }))

    const deleted = await deleteUnused(unused)
    endWork()
    endDownload()
    await Promise.all([work, download])

    expect(deleted).toStrictEqual({ deleted: 4, bytes: 43_210, inUse: 2, failed: 0 })
    expect(deletedFiles).toEqual(['app:assets/images/a.png', 'app:assets/generated/images/b.webp', 'app:assets/generated/video/c.mp4', 'cache:media/d.mp4'])
  })

  it('counts a file that cannot be deleted, and still deletes the others', async () => {
    deleteAppFile = async (path) => {
      if (path === 'assets/images/a.png') throw 'Failed to delete assets/images/a.png: Permission denied (os error 13)'
    }

    expect(await deleteUnused(unused)).toStrictEqual({ deleted: 5, bytes: 6_543_200, inUse: 0, failed: 1 })
    expect(deletedFiles).not.toContain('app:assets/images/a.png')
    expect(consoleError).toHaveBeenCalled()
  })

  it('deletes no file that is not a stored image, a saved clip, or a cache entry of the cleanup', async () => {
    const files: UnusedFiles['files'] = [
      { root: 'app', path: 'app_state.json', size: 1 },
      { root: 'app', path: 'conversations/a.md', size: 2 },
      { root: 'app', path: 'assets/images/../../provider_keys.json', size: 3 },
      { root: 'app', path: 'assets/images/a.png.4012.7.tmp', size: 4 },
      { root: 'app', path: 'media/a.mp4', size: 5 },
      { root: 'app', path: 'work/w1', size: 6 },
      { root: 'cache', path: 'assets/images/a.png', size: 7 },
      { root: 'cache', path: 'media/sub/a.mp4', size: 8 },
      { root: 'cache', path: 'work/w1/a.mp4', size: 9 },
      { root: 'cache', path: 'work/..', size: 10 },
      { root: 'app', path: 'assets/images/a.png', size: 11 },
    ]

    expect(await deleteUnused({ files, bytes: 66 })).toStrictEqual({ deleted: 1, bytes: 11, inUse: 0, failed: 10 })
    expect(deletedFiles).toEqual(['app:assets/images/a.png'])
  })
})

describe('dez.controller/unusedFiles', () => {
  // A scan that read the folders while a delete ran would count files that
  // are gone a moment later.
  it('starts a scan only after the delete before it ends', async () => {
    folders = { 'app:assets/images': [file('a.png', 10), file('b.png', 20)] }
    let release = (): void => {}
    deleteAppFile = (path) => new Promise((resolve) => {
      release = () => {
        folders['app:assets/images'] = folders['app:assets/images'].filter((entry) => `assets/images/${entry.name}` !== path)
        resolve()
      }
    })

    const deleted = deleteUnused({ files: [{ root: 'app', path: 'assets/images/a.png', size: 10 }], bytes: 10 })
    const found = find()
    await vi.advanceTimersByTimeAsync(0)
    release()

    expect(await deleted).toStrictEqual({ deleted: 1, bytes: 10, inUse: 0, failed: 0 })
    expect((await found).unused).toStrictEqual({ files: [{ root: 'app', path: 'assets/images/b.png', size: 20 }], bytes: 20 })
  })
})
