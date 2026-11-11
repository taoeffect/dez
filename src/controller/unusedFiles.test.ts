import sbp from '@sbp/sbp'
import '@sbp/okturtles.eventqueue'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { UNUSED_FILE_MIN_AGE_MS, type UnusedFiles, type UnusedFilesDeleted } from '../model/chat/unusedFiles'
import type { AppFileEntry } from './nativeTypes'
import './unusedFiles'

interface Toast {
  title?: string
  message: string
  variant?: string
}

const APP_DIR = '/home/ann/.config/dez'
const NOW = 1_800_000_000_000
const OLD = NOW - UNUSED_FILE_MIN_AGE_MS

// What the stub selectors below give, and what they were asked for. Reset
// in beforeEach.
let folders: Record<string, AppFileEntry[]> = {}
let listAppFiles: (folder: string) => Promise<AppFileEntry[]>
let conversations: string[] = []
let conversationsError: unknown = null
let conversationReads = 0
let heldTexts: string[] = []
let deletedFiles: string[] = []
let deleteAppFile: (path: string) => Promise<void>
let toasts: Toast[] = []
let consoleError: MockInstance<typeof console.error>

sbp('sbp/selectors/register', {
  async 'dez.native/getAppDir' (): Promise<string> {
    return APP_DIR
  },
  async 'dez.native/listAppFiles' (folder: string): Promise<AppFileEntry[]> {
    return listAppFiles(folder)
  },
  async 'dez.native/deleteAppFile' (path: string): Promise<void> {
    await deleteAppFile(path)
    deletedFiles.push(path)
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
  listAppFiles = async (folder) => folders[folder] ?? []
  conversations = []
  conversationsError = null
  conversationReads = 0
  heldTexts = []
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

  it('gives the old files of the four folders that no text names, with their total size', async () => {
    folders = {
      'assets/images': [file('pasted-used.png', 1), file('pasted-free.png', 20), file('pasted-new.png', 300, OLD + 1)],
      'assets/generated/images': [file('made-held.webp', 4000), file('made-free.jpg', 50_000)],
      'assets/generated/audio': [file('speech-prompt.mp3', 600_000), file('speech-free.wav', 7_000_000)],
      'assets/generated/video': [file('film-used.mp4', 80_000_000), file('film.mp4.4012.7.tmp', 900_000_000)],
    }
    conversations = [
      `---\ntitle: One\n---\n![${APP_DIR}/assets/images/pasted-used.png](id=a)\n`,
      'No file here.',
      `<dez:video id="b" type="video/mp4" src="${APP_DIR}/assets/generated/video/film-used.mp4"/>\n`,
    ]
    // A tab that is not saved yet, and a saved prompt.
    heldTexts = [`![${APP_DIR}/assets/generated/images/made-held.webp](id=c)`, 'Say it as in speech-prompt.mp3']

    const { unused, progress } = await find()

    expect(unused).toStrictEqual({
      files: [
        { path: 'assets/images/pasted-free.png', size: 20 },
        { path: 'assets/generated/images/made-free.jpg', size: 50_000 },
        { path: 'assets/generated/audio/speech-free.wav', size: 7_000_000 },
      ],
      bytes: 7_050_020,
    })
    expect(progress).toEqual([0, 1 / 3, 2 / 3, 1, 1])
    expect(deletedFiles).toEqual([])
    expect(toasts).toEqual([])
  })

  it('reads no conversation when the folders hold no old file', async () => {
    folders = { 'assets/images': [file('new.png', 5, NOW)] }
    conversations = ['text']

    const { unused, progress } = await find()

    expect(unused).toStrictEqual({ files: [], bytes: 0 })
    expect(progress).toEqual([0, 1])
    expect(conversationReads).toBe(0)
  })

  it('gives every old file when there is no conversation', async () => {
    folders = { 'assets/images': [file('a.png', 5)] }

    expect((await find()).unused).toStrictEqual({ files: [{ path: 'assets/images/a.png', size: 5 }], bytes: 5 })
  })

  // A scan that took the conversations it could read for all of them would
  // give the files of the others as unused.
  it('rejects with an error toast when the conversations cannot all be read', async () => {
    folders = { 'assets/images': [file('a.png', 5)] }
    conversations = ['first']
    conversationsError = 'Failed to read conversations/b.md: Permission denied (os error 13)'

    await expect(find()).rejects.toBe(conversationsError)

    expect(toasts).toStrictEqual([{ title: 'Could not look for unused files', message: `${READ_FAILURE}\n\nDetails: ${conversationsError}`, variant: 'error' }])
    expect(consoleError).toHaveBeenCalled()
  })

  it('rejects with an error toast when a folder cannot be listed', async () => {
    listAppFiles = async (folder) => {
      if (folder === 'assets/generated/video') throw new Error('Failed to list assets/generated/video')
      return [file('a.png', 5)]
    }

    await expect(find()).rejects.toThrow('Failed to list assets/generated/video')

    expect(toasts).toStrictEqual([{ title: 'Could not look for unused files', message: `${READ_FAILURE}\n\nDetails: Failed to list assets/generated/video`, variant: 'error' }])
    expect(conversationReads).toBe(0)
  })
})

describe('dez.controller/unusedFiles/delete', () => {
  const unused: UnusedFiles = {
    files: [
      { path: 'assets/images/a.png', size: 10 },
      { path: 'assets/generated/images/b.webp', size: 200 },
      { path: 'assets/generated/video/c.mp4', size: 3000 },
    ],
    bytes: 3210,
  }

  it('deletes the files and counts them', async () => {
    expect(await deleteUnused(unused)).toStrictEqual({ deleted: 3, bytes: 3210, inUse: 0, failed: 0 })
    expect(deletedFiles).toEqual(['assets/images/a.png', 'assets/generated/images/b.webp', 'assets/generated/video/c.mp4'])
    expect(toasts).toEqual([])
  })

  it('keeps a file that a text in memory names since the scan', async () => {
    heldTexts = ['', `Now with ![${APP_DIR}/assets/generated/images/b.webp](id=a)`]

    expect(await deleteUnused(unused)).toStrictEqual({ deleted: 2, bytes: 3010, inUse: 1, failed: 0 })
    expect(deletedFiles).toEqual(['assets/images/a.png', 'assets/generated/video/c.mp4'])
  })

  it('counts a file that cannot be deleted, and still deletes the others', async () => {
    deleteAppFile = async (path) => {
      if (path === 'assets/images/a.png') throw 'Failed to delete assets/images/a.png: Permission denied (os error 13)'
    }

    expect(await deleteUnused(unused)).toStrictEqual({ deleted: 2, bytes: 3200, inUse: 0, failed: 1 })
    expect(deletedFiles).toEqual(['assets/generated/images/b.webp', 'assets/generated/video/c.mp4'])
    expect(consoleError).toHaveBeenCalled()
  })

  it('deletes no file that is not a stored image or a saved clip', async () => {
    const files = [
      { path: 'app_state.json', size: 1 },
      { path: 'conversations/a.md', size: 2 },
      { path: 'assets/images/../../provider_keys.json', size: 3 },
      { path: 'assets/images/a.png.4012.7.tmp', size: 4 },
      { path: 'assets/images/a.png', size: 5 },
    ]

    expect(await deleteUnused({ files, bytes: 15 })).toStrictEqual({ deleted: 1, bytes: 5, inUse: 0, failed: 4 })
    expect(deletedFiles).toEqual(['assets/images/a.png'])
  })
})

describe('dez.controller/unusedFiles', () => {
  // A scan that read the folders while a delete ran would count files that
  // are gone a moment later.
  it('starts a scan only after the delete before it ends', async () => {
    folders = { 'assets/images': [file('a.png', 10), file('b.png', 20)] }
    let release = (): void => {}
    deleteAppFile = (path) => new Promise((resolve) => {
      release = () => {
        folders['assets/images'] = folders['assets/images'].filter((entry) => `assets/images/${entry.name}` !== path)
        resolve()
      }
    })

    const deleted = deleteUnused({ files: [{ path: 'assets/images/a.png', size: 10 }], bytes: 10 })
    const found = find()
    await vi.advanceTimersByTimeAsync(0)
    release()

    expect(await deleted).toStrictEqual({ deleted: 1, bytes: 10, inUse: 0, failed: 0 })
    expect((await found).unused).toStrictEqual({ files: [{ path: 'assets/images/b.png', size: 20 }], bytes: 20 })
  })
})
