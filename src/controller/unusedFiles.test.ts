import sbp from '@sbp/sbp'
import '@sbp/okturtles.eventqueue'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { UNUSED_FILE_MIN_AGE_MS, type CleanupKind, type UnusedFiles, type UnusedFilesDeleted } from '../model/chat/unusedFiles'
import { holdingCachePath } from './cacheHolds'
import type { AppFileEntry, AppFileRoot, FileTree } from './nativeTypes'
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
const NO_TREE: FileTree = { kind: 'missing', size: 0, updatedAt: null, entries: [], more: false }

// What the stub selectors below give, and what they were asked for. Reset
// in beforeEach. A key of `folders` is the root and the path of a listing
// (`app:assets/images`), with `:folders` for a listing of folders; a key of
// `trees` and of `treeErrors` is a path in the app folder (`apps/notes`);
// an entry of `deletedFiles` is the root and the path, with ` (folder)` for
// a folder delete; `goneApps` are the apps that the editor was told of.
let folders: Record<string, AppFileEntry[]> = {}
let listAppFiles: (key: string) => Promise<AppFileEntry[]>
let trees: Record<string, FileTree> = {}
let treeErrors: Record<string, unknown> = {}
let goneApps: string[] = []
let conversations: string[] = []
let conversationsError: unknown = null
let conversationReads = 0
let heldTexts: string[] = []
let unnamedMadeFiles: string[] = []
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
  async 'dez.native/listFileTree' (path: string, maxEntries: number): Promise<FileTree> {
    if (path in treeErrors) throw treeErrors[path]
    const tree = trees[path] ?? NO_TREE
    return { ...tree, entries: tree.entries.slice(0, maxEntries), more: tree.more || tree.entries.length > maxEntries }
  },
  'dez.editor/appDeleted' (name: string): void {
    goneApps.push(name)
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
  'dez.stream/unnamedMadeFiles' (): string[] {
    return unnamedMadeFiles
  },
  'dez.ui/toast' (_area: string, toast: Toast): void {
    toasts.push(toast)
  },
})

function file (name: string, size: number, updatedAt = OLD): AppFileEntry {
  return { name, updatedAt, size }
}

// The listing of the folder of an app with the files `files` (path to
// size), each changed at `updatedAt`.
function appTree (files: Record<string, number>, updatedAt: number | null = OLD): FileTree {
  const entries = Object.entries(files).map(([path, size]) => ({ path, kind: 'file' as const, size, updatedAt }))
  return { kind: 'folder', size: 0, updatedAt, entries, more: false }
}

async function find (kind: CleanupKind = 'files'): Promise<{ unused: UnusedFiles, progress: number[] }> {
  const progress: number[] = []
  const unused = await sbp('dez.controller/unusedFiles/find', kind, (fraction: number) => progress.push(fraction)) as UnusedFiles
  return { unused, progress }
}

function deleteUnused (unused: UnusedFiles): Promise<UnusedFilesDeleted> {
  return sbp('dez.controller/unusedFiles/delete', unused) as Promise<UnusedFilesDeleted>
}

// Runs `scan` while work of this app holds the cache entries `paths`, and
// ends that work after it, also after a failure, so no hold stays for the
// next tests.
async function whileHeld<T> (paths: string[], scan: () => Promise<T>): Promise<T> {
  const ends: (() => void)[] = []
  const holds = paths.map((path) => holdingCachePath(path, () => new Promise<void>((resolve) => { ends.push(resolve) })))
  try {
    return await scan()
  } finally {
    for (const end of ends) end()
    await Promise.all(holds)
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  folders = {}
  listAppFiles = async (key) => folders[key] ?? []
  trees = {}
  treeErrors = {}
  goneApps = []
  conversations = []
  conversationsError = null
  conversationReads = 0
  heldTexts = []
  unnamedMadeFiles = []
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
  function readFailure (noun: string): string {
    return `The system did not let Dez read all of its files, so Dez deletes no ${noun}. The details tell why (for example, Dez has no permission to read a file). Fix that, and try again.`
  }

  it('gives the old files of every stored-file folder that no text names, with their total size', async () => {
    folders = {
      'app:assets/images': [file('pasted-used.png', 1), file('pasted-old.png', 5), file('pasted-free.png', 20), file('pasted-new.png', 300, OLD + 1)],
      'app:assets/generated/images': [file('made-held.webp', 4000), file('made-free.jpg', 50_000), file('made-by-job.png', 9)],
      'app:assets/generated/audio': [file('speech-prompt.mp3', 600_000), file('speech-free.wav', 7_000_000)],
      'app:assets/generated/video': [file('film-used.mp4', 80_000_000), file('film.mp4.4012.7.tmp', 900_000_000)],
      'app:assets/audio': [file('memo-free.m4a', 100)],
      'app:assets/video': [file('pasted-used.webm', 3_000_000)],
    }
    conversations = [
      `---\ntitle: One\n---\n![id=a](${APP_DIR}/assets/images/pasted-used.png)\n`,
      // A reference of the old form is plain text, but its path still
      // names the file.
      `No file here, and ![${APP_DIR}/assets/images/pasted-old.png](id=e) as text.`,
      `<dez:video id="b" type="video/mp4" src="${APP_DIR}/assets/generated/video/film-used.mp4"/>\n`
        + `<dez:video id="d" type="video/webm" src="${APP_DIR}/assets/video/pasted-used.webm"/>\n`,
    ]
    // A tab that is not saved yet, and a saved prompt.
    heldTexts = [`![id=c](${APP_DIR}/assets/generated/images/made-held.webp)`, 'Say it as in speech-prompt.mp3']
    // The image of a job result that no text names yet.
    unnamedMadeFiles = [`${APP_DIR}/assets/generated/images/made-by-job.png`]

    const { unused, progress } = await find()

    expect(unused).toStrictEqual({
      kind: 'files',
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
    unnamedMadeFiles = [`${CACHE_DIR}/media/copy-of-job.webm`]
    // A run in a work folder, and a download, of this app.
    const { unused } = await whileHeld(['work/w-held', 'media/held.part'], find)

    expect(unused).toStrictEqual({
      kind: 'files',
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

    expect(unused).toStrictEqual({ kind: 'files', files: [], bytes: 0 })
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
      kind: 'files',
      files: [{ root: 'cache', path: 'media/d1.part', size: 500 }, { root: 'cache', path: 'work/w1', size: 0 }],
      bytes: 500,
    })
    expect(progress).toEqual([0, 1])
    expect(conversationReads).toBe(0)
  })

  it('gives every old file when there is no conversation', async () => {
    folders = { 'app:assets/images': [file('a.png', 5)] }

    expect((await find()).unused).toStrictEqual({ kind: 'files', files: [{ root: 'app', path: 'assets/images/a.png', size: 5 }], bytes: 5 })
  })

  // Delete Unreferenced Files must never delete an app, and Delete
  // Unreferenced Apps never a stored file.
  it('gives only the things of the kind of the scan', async () => {
    folders = { 'app:assets/images': [file('a.png', 5)], 'app:apps:folders': [file('notes', 0)] }
    trees = { 'apps/notes': appTree({ 'manifest.json': 100 }) }

    expect((await find('files')).unused).toStrictEqual({ kind: 'files', files: [{ root: 'app', path: 'assets/images/a.png', size: 5 }], bytes: 5 })
    expect((await find('apps')).unused).toStrictEqual({ kind: 'apps', files: [{ root: 'app', path: 'apps/notes', size: 100 }], bytes: 100 })
  })

  it('gives the old apps that no text names, each with the size of its files', async () => {
    folders = { 'app:apps:folders': ['shown', 'called', 'pathed', 'held', 'free', 'listed'].map((name) => file(name, 0)) }
    trees = {
      'apps/shown': appTree({ 'manifest.json': 100, 'index.html': 900 }),
      'apps/called': appTree({ 'manifest.json': 100 }),
      'apps/pathed': appTree({ 'main.js': 10 }),
      'apps/held': appTree({ 'main.js': 10 }),
      'apps/free': appTree({ 'manifest.json': 100, 'data/log.txt': 4000 }),
      'apps/listed': appTree({ 'main.js': 7 }),
    }
    conversations = [
      '---\ntitle: One\n---\nHere it is:\n<dez:app name="shown"/>\n',
      '<dez:tool id="c1" name="apps" command="invoke" parameters="{&quot;name&quot;:&quot;called&quot;}">\nDone.\n</dez:tool>\n'
        + '<dez:tool id="c2" name="apps" command="read" parameters="{&quot;path&quot;:&quot;/apps/pathed/main.js&quot;}">\n1: let x\n</dez:tool>\n'
        // A list of all apps names none of them: it must not keep them all.
        + '<dez:tool id="c3" name="apps" command="list_apps" parameters="{}">\n'
        + '6 apps (name | kind | size | description), by name.\nfree | ui | 4 KB | Free.\nlisted | script | 7 B | Listed.\n</dez:tool>\n',
    ]
    // A tab that is not saved yet.
    heldTexts = ['Run it:\n<dez:app name="held"/>']

    const { unused, progress } = await find('apps')

    expect(unused).toStrictEqual({
      kind: 'apps',
      files: [{ root: 'app', path: 'apps/free', size: 4100 }, { root: 'app', path: 'apps/listed', size: 7 }],
      bytes: 4107,
    })
    expect(progress).toEqual([0, 1 / 2, 1, 1])
    expect(deletedFiles).toEqual([])
  })

  it('keeps an app that changed a moment ago, and one that it cannot tell the age or the files of', async () => {
    folders = { 'app:apps:folders': ['young-file', 'young-folder', 'no-time', 'huge', 'Not-An-App', 'gone', 'a-file', 'old'].map((name) => file(name, 0)) }
    const old = appTree({ 'main.js': 1, 'data.json': 2 })
    trees = {
      'apps/young-file': { ...old, entries: [old.entries[0], { ...old.entries[1], updatedAt: OLD + 1 }] },
      'apps/young-folder': { ...old, updatedAt: OLD + 1 },
      'apps/no-time': { ...old, entries: [{ ...old.entries[0], updatedAt: null }, old.entries[1]] },
      // More files than the tools of Dez put into an app: the listing is
      // cut, so Dez did not see the newest one.
      'apps/huge': appTree(Object.fromEntries(Array.from({ length: 1001 }, (_, index) => [`f${index}.js`, 1]))),
      // `apps/gone` went after the listing.
      'apps/a-file': { ...NO_TREE, kind: 'file', size: 5, updatedAt: OLD },
      'apps/old': old,
    }
    // The `apps` tool makes no folder with such a name, so the scan does not
    // read it: a folder of the user that Dez cannot read must not fail the
    // scan.
    treeErrors = { 'apps/Not-An-App': 'Failed to list apps/Not-An-App: Permission denied (os error 13)' }

    expect((await find('apps')).unused).toStrictEqual({ kind: 'apps', files: [{ root: 'app', path: 'apps/old', size: 3 }], bytes: 3 })
  })

  // A scan that took the conversations it could read for all of them would
  // give the files of the others as unused.
  it('rejects with an error toast when the conversations cannot all be read', async () => {
    folders = { 'app:assets/images': [file('a.png', 5)] }
    conversations = ['first']
    conversationsError = 'Failed to read conversations/b.md: Permission denied (os error 13)'

    await expect(find()).rejects.toBe(conversationsError)

    expect(toasts).toStrictEqual([{ title: 'Could not look for unreferenced files', message: `${readFailure('file')}\n\nDetails: ${conversationsError}`, variant: 'error' }])
    expect(consoleError).toHaveBeenCalled()
  })

  it.each([
    ['files', 'app:assets/generated/video'],
    ['files', 'cache:media'],
    ['files', 'cache:work/w1'],
    ['apps', 'app:apps:folders'],
  ] as const)('rejects a scan of the %s with an error toast when %s cannot be listed', async (kind, failing) => {
    folders = { 'cache:work:folders': [file('w1', 0)] }
    listAppFiles = async (key) => {
      if (key === failing) throw new Error(`Failed to list ${failing}`)
      return folders[key] ?? [file('a.png', 5)]
    }

    await expect(find(kind)).rejects.toThrow(`Failed to list ${failing}`)

    const noun = kind === 'apps' ? 'app' : 'file'
    expect(toasts).toStrictEqual([{ title: `Could not look for unreferenced ${kind}`, message: `${readFailure(noun)}\n\nDetails: Failed to list ${failing}`, variant: 'error' }])
    expect(conversationReads).toBe(0)
  })

  it('rejects with an error toast when the files of an app cannot be listed', async () => {
    folders = { 'app:apps:folders': [file('notes', 0)] }
    const treeError = 'Failed to list apps/notes: Permission denied (os error 13)'
    treeErrors = { 'apps/notes': treeError }

    await expect(find('apps')).rejects.toBe(treeError)

    expect(toasts).toStrictEqual([{ title: 'Could not look for unreferenced apps', message: `${readFailure('app')}\n\nDetails: ${treeError}`, variant: 'error' }])
    expect(conversationReads).toBe(0)
  })
})

describe('dez.controller/unusedFiles/delete', () => {
  const unused: UnusedFiles = {
    kind: 'files',
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
    heldTexts = ['', `Now with ![id=a](${APP_DIR}/assets/generated/images/b.webp)`]
    unnamedMadeFiles = [`${CACHE_DIR}/media/d.mp4`]

    expect(await deleteUnused(unused)).toStrictEqual({ deleted: 4, bytes: 6_503_010, inUse: 2, failed: 0 })
    expect(deletedFiles).toEqual(['app:assets/images/a.png', 'app:assets/generated/video/c.mp4', 'cache:media/e.part.4012.7.tmp', 'cache:work/f (folder)'])
  })

  it('keeps a cache entry that work of this app holds since the scan', async () => {
    const deleted = await whileHeld(['work/f', 'media/e.part'], () => deleteUnused(unused))

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

  describe('of the apps', () => {
    const apps: UnusedFiles = {
      kind: 'apps',
      files: [
        { root: 'app', path: 'apps/notes', size: 500 },
        { root: 'app', path: 'apps/timer', size: 7000 },
      ],
      bytes: 7500,
    }

    it('deletes the folder of each app, and tells the editor', async () => {
      expect(await deleteUnused(apps)).toStrictEqual({ deleted: 2, bytes: 7500, inUse: 0, failed: 0 })
      expect(deletedFiles).toEqual(['app:apps/notes (folder)', 'app:apps/timer (folder)'])
      expect(goneApps).toEqual(['notes', 'timer'])
    })

    it('keeps an app that a text in memory names since the scan, and counts one that cannot be deleted', async () => {
      heldTexts = ['Here it is:\n<dez:app name="notes"/>']
      deleteAppFile = async (path) => {
        if (path === 'apps/timer') throw 'Failed to delete apps/timer: Permission denied (os error 13)'
      }

      expect(await deleteUnused(apps)).toStrictEqual({ deleted: 0, bytes: 0, inUse: 1, failed: 1 })
      expect(deletedFiles).toEqual([])
      expect(goneApps).toEqual([])
      expect(consoleError).toHaveBeenCalled()
    })
  })

  // A delete gets its list from a scan of its kind, but it does not trust
  // the list: a hand-made list still deletes nothing else.
  describe('of a list that no scan gave', () => {
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
      { root: 'app', path: 'apps', size: 12 },
      { root: 'app', path: 'apps/notes/main.js', size: 13 },
      { root: 'app', path: 'apps/..', size: 14 },
      { root: 'app', path: 'apps/Not-An-App', size: 15 },
      { root: 'cache', path: 'apps/notes', size: 16 },
      { root: 'app', path: 'apps/notes', size: 17 },
      { root: 'app', path: 'assets/images/a.png', size: 11 },
    ]

    it('deletes in a cleanup of the files only a stored file or a cache entry, and never an app', async () => {
      expect(await deleteUnused({ kind: 'files', files, bytes: 153 })).toStrictEqual({ deleted: 1, bytes: 11, inUse: 0, failed: 16 })
      expect(deletedFiles).toEqual(['app:assets/images/a.png'])
      expect(goneApps).toEqual([])
    })

    it('deletes in a cleanup of the apps only the folder of an app', async () => {
      expect(await deleteUnused({ kind: 'apps', files, bytes: 153 })).toStrictEqual({ deleted: 1, bytes: 17, inUse: 0, failed: 16 })
      expect(deletedFiles).toEqual(['app:apps/notes (folder)'])
      expect(goneApps).toEqual(['notes'])
    })
  })
})

describe('dez.controller/unusedFiles/deleteUnnamed', () => {
  const IMAGE = `${APP_DIR}/assets/generated/images/draft.png`
  const CLIP = `${APP_DIR}/assets/generated/video/take.mp4`
  const COPY = `${CACHE_DIR}/media/take.webm`

  function deleteUnnamed (sources: string[], pictures: string[] = []): Promise<void> {
    return sbp('dez.controller/unusedFiles/deleteUnnamed', { sources, pictures }) as Promise<void>
  }

  // The files are a moment old: the age rule of a scan would keep them.
  it('deletes the stored files, the temp copies, and the picture copies, each one time, whatever their age', async () => {
    await deleteUnnamed([IMAGE, CLIP, COPY, IMAGE], ['sheet.jpg', 'wave.png'])

    expect(deletedFiles).toEqual([
      'app:assets/generated/images/draft.png',
      'app:assets/generated/video/take.mp4',
      'cache:media/take.webm',
      'app:assets/generated/views/sheet.jpg',
      'app:assets/generated/views/wave.png',
    ])
  })

  it('keeps a file that a conversation, a text in memory, or a job result still names', async () => {
    conversations = ['No file here.', `---\ntitle: Other\n---\n![id=a](${IMAGE})\n`]
    heldTexts = [`<dez:tool id="c" name="asset_view" pictures="[{&quot;file&quot;:&quot;sheet.jpg&quot;,&quot;label&quot;:&quot;&quot;}]">ok</dez:tool>`]
    unnamedMadeFiles = [COPY]

    await deleteUnnamed([IMAGE, CLIP, COPY], ['sheet.jpg', 'wave.png'])

    expect(deletedFiles).toEqual(['app:assets/generated/video/take.mp4', 'app:assets/generated/views/wave.png'])
  })

  it('keeps a temp copy that work of this app holds', async () => {
    await whileHeld(['media/take.webm'], () => deleteUnnamed([COPY, CLIP]))

    expect(deletedFiles).toEqual(['app:assets/generated/video/take.mp4'])
  })

  // A linked file of the user, a URL, a file of another home, and a name
  // that goes out of the views folder.
  it('deletes no file that Dez did not store, and reads no conversation for none', async () => {
    await deleteUnnamed([
      '/home/ann/Pictures/fox.png',
      'https://clips.example/take.mp4',
      '/home/bob/.config/dez/assets/generated/images/draft.png',
      `${APP_DIR}/provider_keys.json`,
      `${APP_DIR}/assets/images/../../app_state.json`,
    ], ['../../../provider_keys.json', 'notes.txt'])

    expect(deletedFiles).toEqual([])
    expect(conversationReads).toBe(0)
  })

  it('only logs a file that cannot be deleted, and a conversation that cannot be read', async () => {
    deleteAppFile = async (path) => {
      if (path === 'assets/generated/images/draft.png') throw 'Permission denied (os error 13)'
    }
    await deleteUnnamed([IMAGE, CLIP])
    expect(deletedFiles).toEqual(['app:assets/generated/video/take.mp4'])
    expect(consoleError).toHaveBeenCalledTimes(1)

    // With a text that Dez could not read, no file goes: it can name one.
    deletedFiles = []
    conversationsError = new Error('Failed to read conversations/a.md')
    await deleteUnnamed([CLIP])
    expect(deletedFiles).toEqual([])
    expect(consoleError).toHaveBeenCalledTimes(2)
    expect(toasts).toEqual([])
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

    const deleted = deleteUnused({ kind: 'files', files: [{ root: 'app', path: 'assets/images/a.png', size: 10 }], bytes: 10 })
    const found = find()
    await vi.advanceTimersByTimeAsync(0)
    release()

    expect(await deleted).toStrictEqual({ deleted: 1, bytes: 10, inUse: 0, failed: 0 })
    expect((await found).unused).toStrictEqual({ kind: 'files', files: [{ root: 'app', path: 'assets/images/b.png', size: 20 }], bytes: 20 })
  })
})
