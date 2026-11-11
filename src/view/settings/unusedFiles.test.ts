import sbp from '@sbp/sbp'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { UnusedFiles, UnusedFilesDeleted } from '../../model/chat/unusedFiles'
import type { ToastData } from '../toast/selectors'
import { deleteQuestion, deleteUnusedFiles, deletedToast, unusedFilesProgress } from './unusedFiles'

const twoFiles: UnusedFiles = {
  files: [
    { path: 'assets/images/a.png', size: 1024 * 1024 },
    { path: 'assets/generated/video/b.mp4', size: 3 * 1024 * 1024 },
  ],
  bytes: 4 * 1024 * 1024,
}

// What the stub selectors below give, and what they were asked for. Reset
// in beforeEach.
let findCalls: Array<{ progress: (fraction: number) => void, finish: (unused: UnusedFiles) => void, fail: () => void }> = []
let confirmCalls: Array<{ message: string, answer: (confirmed: boolean) => void }> = []
let deleteCalls: UnusedFiles[] = []
let deleteResult: UnusedFilesDeleted = { deleted: 2, bytes: twoFiles.bytes, inUse: 0, failed: 0 }
let toasts: ToastData[] = []

sbp('sbp/selectors/register', {
  'dez.controller/unusedFiles/find' (progress: (fraction: number) => void): Promise<UnusedFiles> {
    return new Promise((resolve, reject) => {
      findCalls.push({ progress, finish: resolve, fail: () => reject(new Error('Permission denied')) })
    })
  },
  async 'dez.controller/unusedFiles/delete' (unused: UnusedFiles): Promise<UnusedFilesDeleted> {
    deleteCalls.push(unused)
    return deleteResult
  },
  'dez.ui/confirm' ({ message }: { message: string }): Promise<boolean> {
    return new Promise((resolve) => {
      confirmCalls.push({ message, answer: resolve })
    })
  },
  'dez.ui/toast' (_area: string, toast: ToastData): void {
    toasts.push(toast)
  },
})

beforeEach(() => {
  findCalls = []
  confirmCalls = []
  deleteCalls = []
  deleteResult = { deleted: 2, bytes: twoFiles.bytes, inUse: 0, failed: 0 }
  toasts = []
})

describe('deleteQuestion', () => {
  it('states the count of the files and the size that the delete frees', () => {
    expect(deleteQuestion(twoFiles)).toBe('Are you sure you want to delete 2 unused files? This frees 4.0 MB, and it cannot be undone.')
  })

  it('names one file as one file', () => {
    expect(deleteQuestion({ files: [{ path: 'assets/images/a.png', size: 300 }], bytes: 300 }))
      .toBe('Are you sure you want to delete 1 unused file? This frees 300 B, and it cannot be undone.')
  })
})

describe('deletedToast', () => {
  it('tells the count and the freed size, and goes away', () => {
    expect(deletedToast({ deleted: 12, bytes: 50_646_221, inUse: 0, failed: 0 }))
      .toStrictEqual({ message: 'Deleted 12 unused files (48.3 MB).', variant: 'success', duration: 5000 })
    expect(deletedToast({ deleted: 1, bytes: 2048, inUse: 0, failed: 0 }).message).toBe('Deleted 1 unused file (2 KB).')
  })

  it('tells the files that stay because a text names them again', () => {
    expect(deletedToast({ deleted: 3, bytes: 10, inUse: 1, failed: 0 }))
      .toStrictEqual({ message: 'Deleted 3 unused files (10 B). Kept 1 file now in use.', variant: 'success', duration: 5000 })
    expect(deletedToast({ deleted: 0, bytes: 0, inUse: 2, failed: 0 }))
      .toStrictEqual({ message: 'Deleted no files. Kept 2 files now in use.', variant: 'default', duration: 5000 })
  })

  it('stays open as a warning when a file could not be deleted', () => {
    expect(deletedToast({ deleted: 3, bytes: 10, inUse: 1, failed: 2 })).toStrictEqual({
      title: 'Unused files',
      message: 'Deleted 3 unused files (10 B). Kept 1 file now in use. Could not delete 2 files.',
      variant: 'warning',
    })
    expect(deletedToast({ deleted: 0, bytes: 0, inUse: 0, failed: 1 }).message).toBe('Deleted no files. Could not delete 1 file.')
  })
})

describe('deleteUnusedFiles', () => {
  it('shows the progress of the scan, asks, deletes on a yes, and tells the result', async () => {
    const run = deleteUnusedFiles()
    expect(unusedFilesProgress.value).toBe(0)

    findCalls[0].progress(0.5)
    expect(unusedFilesProgress.value).toBe(0.5)
    findCalls[0].progress(1)
    findCalls[0].finish(twoFiles)
    await vi.waitFor(() => expect(confirmCalls).toHaveLength(1))

    // The run goes on while the prompt is open.
    expect(unusedFilesProgress.value).toBe(1)
    expect(confirmCalls.map((call) => call.message)).toEqual([deleteQuestion(twoFiles)])
    expect(deleteCalls).toEqual([])

    confirmCalls[0].answer(true)
    await run

    expect(deleteCalls).toEqual([twoFiles])
    expect(toasts).toStrictEqual([{ message: 'Deleted 2 unused files (4.0 MB).', variant: 'success', duration: 5000 }])
    expect(unusedFilesProgress.value).toBeNull()
  })

  it('deletes nothing on a no', async () => {
    const run = deleteUnusedFiles()
    findCalls[0].finish(twoFiles)
    await vi.waitFor(() => expect(confirmCalls).toHaveLength(1))
    confirmCalls[0].answer(false)
    await run

    expect(deleteCalls).toEqual([])
    expect(toasts).toEqual([])
    expect(unusedFilesProgress.value).toBeNull()
  })

  it('asks nothing when the scan finds no file', async () => {
    const run = deleteUnusedFiles()
    findCalls[0].finish({ files: [], bytes: 0 })
    await run

    expect(confirmCalls).toEqual([])
    expect(toasts).toStrictEqual([{ message: 'No unused files found', duration: 5000 }])
    expect(unusedFilesProgress.value).toBeNull()
  })

  it('starts no second scan while one runs', async () => {
    const run = deleteUnusedFiles()
    await deleteUnusedFiles()

    expect(findCalls).toHaveLength(1)
    expect(unusedFilesProgress.value).toBe(0)

    findCalls[0].finish({ files: [], bytes: 0 })
    await run
  })

  // The controller showed the error toast: the run ends with no prompt and
  // no second toast, and the button works again.
  it('ends the run when the scan fails', async () => {
    const run = deleteUnusedFiles()
    findCalls[0].fail()
    await run

    expect(confirmCalls).toEqual([])
    expect(toasts).toEqual([])
    expect(unusedFilesProgress.value).toBeNull()

    const again = deleteUnusedFiles()
    expect(findCalls).toHaveLength(2)
    findCalls[1].finish({ files: [], bytes: 0 })
    await again
  })
})
