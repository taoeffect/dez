import sbp from '@sbp/sbp'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { WORK_FOLDER_LIFETIME_MS } from '../model/tools/workFolders'
import type { AppFileEntry } from './nativeTypes'
import { deleteOldWorkFolders } from './workFolders'

// One call of an app-file selector, with the options that tell a folder
// from a file.
interface Call {
  root: string
  path: string
  options: object
}

const now = Date.UTC(2026, 10, 13, 12)
const OLD = now - WORK_FOLDER_LIFETIME_MS

let listings: Call[] = []
let listAppFiles: () => Promise<AppFileEntry[]>
let deletes: Call[] = []
let deleteAppFile: (path: string) => Promise<void>
let consoleError: MockInstance<typeof console.error>

sbp('sbp/selectors/register', {
  async 'dez.native/listAppFiles' (path: string, root = 'app', options: object = {}): Promise<AppFileEntry[]> {
    listings.push({ root, path, options })
    return listAppFiles()
  },
  async 'dez.native/deleteAppFile' (path: string, root = 'app', options: object = {}): Promise<void> {
    await deleteAppFile(path)
    deletes.push({ root, path, options })
  },
})

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(now)
  listings = []
  listAppFiles = async () => []
  deletes = []
  deleteAppFile = async () => {}
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  consoleError.mockRestore()
  vi.useRealTimers()
})

describe('deleteOldWorkFolders', () => {
  it('deletes the old folders of the work root of the cache, as folders', async () => {
    listAppFiles = async () => [
      { name: 'old', updatedAt: OLD, size: 0 },
      { name: 'new', updatedAt: OLD + 1, size: 0 },
    ]

    await deleteOldWorkFolders()

    // A listing with no `folders` gives the files of the work root, which
    // has none; a delete with no `folder` does not remove a folder.
    expect(listings).toStrictEqual([{ root: 'cache', path: 'work', options: { folders: true } }])
    expect(deletes).toStrictEqual([{ root: 'cache', path: 'work/old', options: { folder: true } }])
    expect(consoleError).not.toHaveBeenCalled()
  })

  it('goes on after a folder that cannot be deleted', async () => {
    listAppFiles = async () => [
      { name: 'locked', updatedAt: 0, size: 0 },
      { name: 'free', updatedAt: 0, size: 0 },
    ]
    deleteAppFile = async (path) => {
      if (path === 'work/locked') throw 'Failed to delete work/locked: Permission denied (os error 13)'
    }

    await deleteOldWorkFolders()

    expect(deletes.map((call) => call.path)).toStrictEqual(['work/free'])
    expect(consoleError).toHaveBeenCalledTimes(1)
    expect(consoleError).toHaveBeenCalledWith('Failed to delete the old work folder work/locked:', 'Failed to delete work/locked: Permission denied (os error 13)')
  })

  it('logs a work root that cannot be read, and does not fail', async () => {
    listAppFiles = async () => {
      throw 'Failed to list work: Permission denied (os error 13)'
    }

    await expect(deleteOldWorkFolders()).resolves.toBeUndefined()

    expect(deletes).toStrictEqual([])
    expect(consoleError).toHaveBeenCalledTimes(1)
    expect(consoleError).toHaveBeenCalledWith('Failed to list the work folders:', 'Failed to list work: Permission denied (os error 13)')
  })
})
