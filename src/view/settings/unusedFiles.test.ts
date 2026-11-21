import sbp from '@sbp/sbp'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CleanupKind, UnusedFiles, UnusedFilesDeleted } from '../../model/chat/unusedFiles'
import type { ToastData } from '../toast/selectors'
import { deleteQuestion, deleteUnreferenced, deletedToast, runningCleanup } from './unusedFiles'

const twoFiles: UnusedFiles = {
  kind: 'files',
  files: [
    { root: 'app', path: 'assets/images/a.png', size: 1024 * 1024 },
    { root: 'cache', path: 'work/b', size: 3 * 1024 * 1024 },
  ],
  bytes: 4 * 1024 * 1024,
}

function apps (names: string[], size = 1024): UnusedFiles {
  return { kind: 'apps', files: names.map((name) => ({ root: 'app', path: `apps/${name}`, size })), bytes: names.length * size }
}

// What the stub selectors below give, and what they were asked for. Reset
// in beforeEach.
let findCalls: Array<{ kind: CleanupKind, progress: (fraction: number) => void, finish: (unused: UnusedFiles) => void, fail: () => void }> = []
let confirmCalls: Array<{ message: string, answer: (confirmed: boolean) => void }> = []
let deleteCalls: UnusedFiles[] = []
let deleteResult: UnusedFilesDeleted = { deleted: 2, bytes: twoFiles.bytes, inUse: 0, failed: 0 }
let toasts: ToastData[] = []

sbp('sbp/selectors/register', {
  'dez.controller/unusedFiles/find' (kind: CleanupKind, progress: (fraction: number) => void): Promise<UnusedFiles> {
    return new Promise((resolve, reject) => {
      findCalls.push({ kind, progress, finish: resolve, fail: () => reject(new Error('Permission denied')) })
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
    expect(deleteQuestion(twoFiles)).toBe('Are you sure you want to delete 2 unreferenced files? This frees 4.0 MB, and it cannot be undone.')
    expect(deleteQuestion({ kind: 'files', files: [{ root: 'app', path: 'assets/images/a.png', size: 300 }], bytes: 300 }))
      .toBe('Are you sure you want to delete 1 unreferenced file? This frees 300 B, and it cannot be undone.')
  })

  it('names each app, with the size that the delete frees', () => {
    expect(deleteQuestion(apps(['notes'])))
      .toBe('Are you sure you want to delete 1 unreferenced app (notes) with all its files? This frees 1 KB, and it cannot be undone.')
    expect(deleteQuestion(apps(['notes', 'timer'])))
      .toBe('Are you sure you want to delete 2 unreferenced apps (notes, timer) with all their files? This frees 2 KB, and it cannot be undone.')
  })

  // The user must see each app that the delete takes: no "and 2 more".
  it('names every app of a long list', () => {
    const names = Array.from({ length: 12 }, (_, index) => `a${index}`)
    expect(deleteQuestion(apps(names, 1)))
      .toBe('Are you sure you want to delete 12 unreferenced apps (a0, a1, a2, a3, a4, a5, a6, a7, a8, a9, a10, a11) with all their files? This frees 12 B, and it cannot be undone.')
  })
})

describe('deletedToast', () => {
  it('tells the count and the freed size, and goes away', () => {
    expect(deletedToast('files', { deleted: 12, bytes: 50_646_221, inUse: 0, failed: 0 }))
      .toStrictEqual({ message: 'Deleted 12 unreferenced files (48.3 MB).', variant: 'success', duration: 5000 })
    expect(deletedToast('files', { deleted: 1, bytes: 2048, inUse: 0, failed: 0 }).message).toBe('Deleted 1 unreferenced file (2 KB).')
    expect(deletedToast('apps', { deleted: 1, bytes: 2048, inUse: 0, failed: 0 }).message).toBe('Deleted 1 unreferenced app (2 KB).')
  })

  it('tells what stays because a text names it again', () => {
    expect(deletedToast('files', { deleted: 3, bytes: 10, inUse: 1, failed: 0 }))
      .toStrictEqual({ message: 'Deleted 3 unreferenced files (10 B). Kept 1 file now in use.', variant: 'success', duration: 5000 })
    expect(deletedToast('apps', { deleted: 0, bytes: 0, inUse: 2, failed: 0 }))
      .toStrictEqual({ message: 'Deleted no apps. Kept 2 apps now in use.', variant: 'default', duration: 5000 })
  })

  it('stays open as a warning that names the button of its cleanup when something could not be deleted', () => {
    expect(deletedToast('files', { deleted: 3, bytes: 10, inUse: 1, failed: 2 })).toStrictEqual({
      title: 'Unreferenced files',
      message: 'Deleted 3 unreferenced files (10 B). Kept 1 file now in use. Could not delete 2 files: the system did not let Dez delete them. '
        + 'Help › Developer Console shows why. Fix that, and click Delete Unreferenced Files again.',
      variant: 'warning',
    })
    expect(deletedToast('apps', { deleted: 0, bytes: 0, inUse: 0, failed: 1 })).toStrictEqual({
      title: 'Unreferenced apps',
      message: 'Deleted no apps. Could not delete 1 app: the system did not let Dez delete it. '
        + 'Help › Developer Console shows why. Fix that, and click Delete Unreferenced Apps again.',
      variant: 'warning',
    })
  })
})

describe('deleteUnreferenced', () => {
  it('shows the progress of the scan, asks, deletes on a yes, and tells the result', async () => {
    const run = deleteUnreferenced('files')
    expect(findCalls.map((call) => call.kind)).toEqual(['files'])
    expect(runningCleanup.value).toStrictEqual({ kind: 'files', progress: 0 })

    findCalls[0].progress(0.5)
    expect(runningCleanup.value).toStrictEqual({ kind: 'files', progress: 0.5 })
    findCalls[0].progress(1)
    findCalls[0].finish(twoFiles)
    await vi.waitFor(() => expect(confirmCalls).toHaveLength(1))

    // The run goes on while the prompt is open.
    expect(runningCleanup.value).toStrictEqual({ kind: 'files', progress: 1 })
    expect(confirmCalls.map((call) => call.message)).toEqual([deleteQuestion(twoFiles)])
    expect(deleteCalls).toEqual([])

    confirmCalls[0].answer(true)
    await run

    expect(deleteCalls).toEqual([twoFiles])
    expect(toasts).toStrictEqual([{ message: 'Deleted 2 unreferenced files (4.0 MB).', variant: 'success', duration: 5000 }])
    expect(runningCleanup.value).toBeNull()
  })

  it('asks with the names of the apps, and tells the result of a delete of apps', async () => {
    const found = apps(['notes', 'timer'])
    deleteResult = { deleted: 2, bytes: found.bytes, inUse: 0, failed: 0 }
    const run = deleteUnreferenced('apps')
    expect(findCalls.map((call) => call.kind)).toEqual(['apps'])
    expect(runningCleanup.value).toStrictEqual({ kind: 'apps', progress: 0 })
    findCalls[0].finish(found)
    await vi.waitFor(() => expect(confirmCalls).toHaveLength(1))
    expect(confirmCalls[0].message).toBe(deleteQuestion(found))

    confirmCalls[0].answer(true)
    await run

    expect(deleteCalls).toEqual([found])
    expect(toasts).toStrictEqual([{ message: 'Deleted 2 unreferenced apps (2 KB).', variant: 'success', duration: 5000 }])
    expect(runningCleanup.value).toBeNull()
  })

  it('deletes nothing on a no', async () => {
    const run = deleteUnreferenced('files')
    findCalls[0].finish(twoFiles)
    await vi.waitFor(() => expect(confirmCalls).toHaveLength(1))
    confirmCalls[0].answer(false)
    await run

    expect(deleteCalls).toEqual([])
    expect(toasts).toEqual([])
    expect(runningCleanup.value).toBeNull()
  })

  it.each(['files', 'apps'] as const)('asks nothing when the scan of the %s finds nothing', async (kind) => {
    const run = deleteUnreferenced(kind)
    findCalls[0].finish({ kind, files: [], bytes: 0 })
    await run

    expect(confirmCalls).toEqual([])
    expect(toasts).toStrictEqual([{ message: `No unreferenced ${kind} found`, duration: 5000 }])
    expect(runningCleanup.value).toBeNull()
  })

  // The two buttons share one run: a scan of the apps while the files are
  // deleted would wait in the queue of the controller with no bar.
  it('starts no second cleanup of either kind while one runs', async () => {
    const run = deleteUnreferenced('files')
    await deleteUnreferenced('files')
    await deleteUnreferenced('apps')

    expect(findCalls.map((call) => call.kind)).toEqual(['files'])
    expect(runningCleanup.value).toStrictEqual({ kind: 'files', progress: 0 })

    findCalls[0].finish({ kind: 'files', files: [], bytes: 0 })
    await run
  })

  // The controller showed the error toast: the run ends with no prompt and
  // no second toast, and the buttons work again.
  it('ends the run when the scan fails', async () => {
    const run = deleteUnreferenced('apps')
    findCalls[0].fail()
    await run

    expect(confirmCalls).toEqual([])
    expect(toasts).toEqual([])
    expect(runningCleanup.value).toBeNull()

    const again = deleteUnreferenced('files')
    expect(findCalls).toHaveLength(2)
    findCalls[1].finish({ kind: 'files', files: [], bytes: 0 })
    await again
  })
})
