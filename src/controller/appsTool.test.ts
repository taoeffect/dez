import sbp from '@sbp/sbp'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { toolBlockText } from '../model/chat/toolBlocks'
import type { Section, Tab } from '../model/chat/types'
import { MANIFEST_MAX_BYTES, parseAppManifest } from '../model/tools/appManifest'
import { showResultText } from '../model/tools/appShow'
import { APPS_MAX_BYTES, APPS_MAX_FILE_BYTES, EDIT_HINT, withEditHint } from '../model/tools/appsTool'
import { grepFiles, GREP_TIME_LIMIT_SECONDS, type GrepOutcome, type GrepRequest } from '../model/tools/grepMatch'
import type { ToolRunResult } from '../model/tools/types'
import { APP_DIR, appFiles, callContext, fakeAppFiles, native, resetNative, running, STOP, type FakeAppFiles } from './testing'
import type { ToolRunCall, ToolRunContext } from './tools'
// Side-effect imports: register the dez.model/* selectors, which give the
// sections of a tab, and the selector under test.
import '../model/state/index'
import './tools'

// The `apps` tool, from a call of a model to the files of the app root:
// the real checks and texts of the model module (model/tools/appsTool.ts)
// on the fake files of testing.ts, which follow the rules of the native
// side. The texts and the rules of each subcommand have their own tests
// (model/tools/appsTool.test.ts); the tests here tell what a call reads,
// writes, moves, and deletes.

function apps(command: string, parameters: Record<string, unknown> = {}, signal: AbortSignal = running(), context: Partial<ToolRunContext> = {}): Promise<ToolRunResult> {
  const call: ToolRunCall = { name: 'apps', arguments: { command, parameters: JSON.stringify(parameters) } }
  return sbp('dez.controller/tools/run', call, signal, callContext(context)) as Promise<ToolRunResult>
}

const decoder = new TextDecoder()

// The text of a file of the fake; null for a folder, and undefined when
// nothing is at the path.
function textAt(files: FakeAppFiles, path: string): string | null | undefined {
  const content = files.get(path)
  return content ? decoder.decode(content) : content
}

// The paths of the fake at or below `folder`, sorted; a folder ends with
// a `/`.
function pathsIn(files: FakeAppFiles, folder: string): string[] {
  return [...files]
    .filter(([path]) => path === folder || path.startsWith(`${folder}/`))
    .map(([path, content]) => (content === null ? `${path}/` : path))
    .sort()
}

// The apps that the editor was told are gone (`dez.editor/appDeleted`).
let goneApps: string[] = []

sbp('sbp/selectors/register', {
  'dez.editor/appDeleted' (name: string): void {
    goneApps.push(name)
  },
})

let consoleError: MockInstance<typeof console.error>

beforeEach(() => {
  setActivePinia(createPinia())
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
  resetNative()
  goneApps = []
})

afterEach(() => {
  consoleError.mockRestore()
})

describe('apps init', () => {
  it('makes the folder of a new app for the user only, and writes the files of its kind', async () => {
    const files = fakeAppFiles()

    const result = await apps('init', { name: 'notes', kind: 'ui', description: 'Keeps notes.' })

    expect(result).toStrictEqual({
      content: 'Made the UI app /apps/notes with 4 files:\n/apps/notes/manifest.json\n/apps/notes/index.html\n/apps/notes/main.js\n/apps/notes/style.css\nChange them with read, edit, and write.',
      isError: false,
    })
    // `createFolder` makes a folder that only the user can open; a save
    // would make it for everyone to read.
    expect(native.createdFolders).toStrictEqual([{ root: 'app', path: 'apps/notes' }])
    expect(pathsIn(files, 'apps')).toStrictEqual(['apps/', 'apps/notes/', 'apps/notes/index.html', 'apps/notes/main.js', 'apps/notes/manifest.json', 'apps/notes/style.css'])
    expect(parseAppManifest(textAt(files, 'apps/notes/manifest.json') ?? '')).toStrictEqual({ name: 'notes', description: 'Keeps notes.', kind: 'ui' })
  })

  it('changes nothing of an app that is there already', async () => {
    const files = fakeAppFiles(appFiles('notes', { 'main.ts': 'mine\n' }))

    const result = await apps('init', { name: 'notes', kind: 'script', description: 'Keeps notes.' })

    expect(result.isError).toBe(true)
    expect(result.content).toContain('The app /apps/notes is there already')
    expect(textAt(files, 'apps/notes/main.ts')).toBe('mine\n')
    expect(native.savedFiles).toStrictEqual([])
  })

  it('takes a half-made app away, so that the next call can make it', async () => {
    const files = fakeAppFiles(appFiles('other'))
    const save = native.saveAppFile
    native.saveAppFile = async (file, content) => {
      if (file.path.endsWith('/main.ts')) throw new Error('Failed to write apps/notes/main.ts: No space left on device (os error 28)')
      await save(file, content)
    }

    const failed = await apps('init', { name: 'notes', kind: 'script', description: 'Keeps notes.' })

    expect(failed.isError).toBe(true)
    expect(failed.content).toContain('Dez could not write /apps/notes/main.ts.')
    expect(pathsIn(files, 'apps')).toStrictEqual(['apps/', 'apps/other/', 'apps/other/manifest.json'])

    native.saveAppFile = save
    expect((await apps('init', { name: 'notes', kind: 'script', description: 'Keeps notes.' })).isError).toBe(false)
  })
})

describe('apps read', () => {
  it('gives the lines of a file', async () => {
    fakeAppFiles(appFiles('notes', { 'src/units.js': 'export const KM = 1000\nexport const M = 1\n' }))

    expect(await apps('read', { path: '/apps/notes/src/units.js', ranges: [{ from_line: 2 }] })).toStrictEqual({
      content: '/apps/notes/src/units.js: line 2 of 2 (42 B)\n2: export const M = 1',
      isError: false,
    })
  })

  it('reads no file that is too large, and none that is a folder', async () => {
    const files = fakeAppFiles(appFiles('notes', { data: null }))
    files.set('apps/notes/big.txt', new Uint8Array(APPS_MAX_FILE_BYTES + 1).fill(0x61))

    expect((await apps('read', { path: '/apps/notes/big.txt' })).content).toContain('the apps tool reads and edits a file of at most 2,097,152 bytes')
    expect((await apps('read', { path: '/apps/notes/data' })).content).toContain('/apps/notes/data is a folder, not a file.')
    expect((await apps('read', { path: '/apps/notes/gone.txt' })).content).toContain('There is no file /apps/notes/gone.txt.')
    expect(native.readFiles).toStrictEqual([])
  })
})

describe('apps write', () => {
  it('writes a new file, and makes the missing folders of its path for the user only', async () => {
    const files = fakeAppFiles(appFiles('notes', { src: null }))

    const result = await apps('write', { path: '/apps/notes/src/lib/units.js', content: 'export const KM = 1000\n' })

    expect(result).toStrictEqual({ content: 'Wrote the new file /apps/notes/src/lib/units.js (23 B, 1 line).', isError: false })
    expect(textAt(files, 'apps/notes/src/lib/units.js')).toBe('export const KM = 1000\n')
    expect(native.createdFolders).toStrictEqual([{ root: 'app', path: 'apps/notes/src/lib' }])
  })

  it('writes a file in place of one that is there, and makes no folder for it', async () => {
    const files = fakeAppFiles(appFiles('notes', { 'src/units.js': 'old text\n' }))

    const result = await apps('write', { path: '/apps/notes/src/units.js', content: 'new' })

    expect(result).toStrictEqual({ content: 'Wrote /apps/notes/src/units.js (3 B, 1 line) in place of the file that was there (9 B).', isError: false })
    expect(textAt(files, 'apps/notes/src/units.js')).toBe('new')
    expect(native.createdFolders).toStrictEqual([])
  })

  it('makes no app, and no file where a folder is', async () => {
    const files = fakeAppFiles(appFiles('notes', { src: null }))

    const noApp = await apps('write', { path: '/apps/calc/main.js', content: 'x' })
    const onFolder = await apps('write', { path: '/apps/notes/src', content: 'x' })

    expect(noApp).toStrictEqual({ content: 'There is no app /apps/calc. Make it with init first, or call list_apps to see the apps that are there.', isError: true })
    expect(onFolder.content).toContain('/apps/notes/src is a folder.')
    expect(pathsIn(files, 'apps')).toStrictEqual(['apps/', 'apps/notes/', 'apps/notes/manifest.json', 'apps/notes/src/'])
  })
})

describe('apps edit', () => {
  it('writes the file with the edits that passed', async () => {
    const files = fakeAppFiles(appFiles('notes', { 'main.js': 'const a = 1\nrun(a)\n' }))

    const result = await apps('edit', { path: '/apps/notes/main.js', edits: [{ from_line: 1, text: 'const a = 2' }, { from_line: 9, text: 'x' }] })

    expect(result.isError).toBe(false)
    expect(result.content).toContain('Edited /apps/notes/main.js: 1 of 2 edits done.')
    expect(textAt(files, 'apps/notes/main.js')).toBe('const a = 2\nrun(a)\n')
  })

  it('writes nothing when no edit changed the file', async () => {
    fakeAppFiles(appFiles('notes', { 'main.js': 'const a = 1\nrun(a)\n' }))

    const failed = await apps('edit', { path: '/apps/notes/main.js', edits: [{ from_line: 9, text: 'x' }] })
    const same = await apps('edit', { path: '/apps/notes/main.js', edits: [{ from_line: 2, text: 'run(a)' }] })

    expect(failed.isError).toBe(true)
    expect(failed.content).toContain('No edit of /apps/notes/main.js was done')
    expect(same.isError).toBe(false)
    expect(same.content).toContain('/apps/notes/main.js did not change')
    expect(native.savedFiles).toStrictEqual([])
  })

  it('adds no bytes to an app that is full, and still makes a file of it shorter', async () => {
    const files = fakeAppFiles(appFiles('notes', { 'main.js': 'const a = 1\nrun(a)\n' }))
    files.set('apps/notes/data.bin', new Uint8Array(APPS_MAX_BYTES))

    const longer = await apps('edit', { path: '/apps/notes/main.js', edits: [{ after_line: 2, text: 'done()' }] })

    expect(longer.isError).toBe(true)
    expect(longer.content).toContain('and this call would add 7 B.')
    expect(textAt(files, 'apps/notes/main.js')).toBe('const a = 1\nrun(a)\n')

    const shorter = await apps('edit', { path: '/apps/notes/main.js', edits: [{ from_line: 2, text: '' }] })

    expect(shorter.isError).toBe(false)
    expect(textAt(files, 'apps/notes/main.js')).toBe('const a = 1\n')
  })

  describe('the hint', () => {
    const PATH = '/apps/notes/main.js'
    const EDIT = { path: PATH, edits: [{ from_line: 1, text: 'const a = 2' }] }
    const MODEL = { providerId: 'venice', modelId: 'venice-glm-5' }
    // The tab of the calls.
    let tabId: string

    function edit(context: Partial<ToolRunContext> = {}, parameters: Record<string, unknown> = EDIT): Promise<ToolRunResult> {
      return apps('edit', parameters, running(), { tabId, ...context })
    }

    // The result ends with the hint, in a paragraph of its own.
    const hinted = (result: ToolRunResult): boolean => result.content.endsWith(`\n\n${EDIT_HINT}`)

    const ask = (id: string): Section => ({ id, role: 'user', content: [{ kind: 'text', text: 'Fix the app.' }] })

    // A reply with the blocks of `results`, the results of edit calls, as
    // the end of their round writes them.
    function reply(id: string, results: readonly ToolRunResult[]): Section {
      const blocks = results.map((result, index) => toolBlockText({
        id: `call_${index}`,
        name: 'apps',
        status: result.isError ? 'error' : 'success',
        arguments: { command: 'edit', parameters: JSON.stringify(EDIT) },
        result: result.content,
      }))
      return { id, role: 'agent', model: MODEL, content: [{ kind: 'text', text: blocks.join('') }] }
    }

    const keep = (sections: readonly Section[]): void => {
      sbp('dez.model/tabs/replaceSections', tabId, sections)
    }

    beforeEach(() => {
      fakeAppFiles(appFiles('notes', { 'main.js': 'const a = 1\nrun(a)\n' }))
      tabId = sbp('dez.model/tabs/activeId') as string
    })

    it('ends the result of the first edit of a tab with the hint, and of no edit while the tab holds it', async () => {
      const first = await edit()
      keep([ask('u1'), reply('a1', [first])])
      const second = await edit({}, { path: PATH, edits: [{ from_line: 2, text: 'run(a, 2)' }] })

      expect(first.isError).toBe(false)
      expect(hinted(first)).toBe(true)
      expect(second.content).toContain(`Edited ${PATH}: 1 of 1 edit done.`)
      expect(second.content).not.toContain(EDIT_HINT)
    })

    it('gives the hint to the first edit of each tab, while another tab holds it', async () => {
      keep([ask('u1'), reply('a1', [await edit()])])
      tabId = (sbp('dez.model/tabs/create') as Tab).id

      expect(hinted(await edit())).toBe(true)
    })

    it('gives the hint again after the user deleted the block that held it', async () => {
      keep([ask('u1'), reply('a1', [await edit()])])
      keep([ask('u1'), reply('a1', [])])

      expect(hinted(await edit())).toBe(true)
    })

    it('gives the hint again after a compaction took out the block that held it', async () => {
      keep([ask('u1'), reply('a1', [await edit()]), ask('u2'), reply('a2', [])])
      sbp('dez.model/tabs/compact', tabId, {
        sections: [
          { id: 'notes', role: 'agent', model: MODEL, content: [{ kind: 'text', text: '<dez:compaction count="1"/>\nThe notes.' }] },
          ask('u2'),
          reply('a2', []),
        ],
        replySectionId: 'a2',
        tokens: 1000,
        model: MODEL,
      })

      expect(hinted(await edit())).toBe(true)
    })

    // The results of a round reach the section only at the end of the
    // round.
    it('gives no hint when an earlier call of the round got it', async () => {
      const first = await edit()

      expect(hinted(await edit({ roundResults: ['Wrote the new file /apps/notes/a.js (1 B, 1 line).', first.content] }))).toBe(false)
      expect(hinted(await edit({ roundResults: ['Wrote the new file /apps/notes/a.js (1 B, 1 line).'] }))).toBe(true)
    })

    it('gives the hint with edits that all failed, and with a call that Dez refuses', async () => {
      const failed = await edit({}, { path: PATH, edits: [{ from_line: 9, text: 'x' }] })
      const refused = await edit({}, { ...EDIT, path: '/apps/notes/gone.js' })

      expect(failed.isError).toBe(true)
      expect(failed.content).toContain(`No edit of ${PATH} was done`)
      expect(hinted(failed)).toBe(true)
      expect(refused.isError).toBe(true)
      expect(refused.content).toContain('There is no file /apps/notes/gone.js.')
      expect(hinted(refused)).toBe(true)
    })

    // Its result goes to the code that made the call, not to the model.
    it('never gives the hint to a call of js_eval code', async () => {
      const done = await edit({ bridged: true })
      const refused = await edit({ bridged: true }, { ...EDIT, path: '/apps/notes/gone.js' })

      expect(done.isError).toBe(false)
      expect(done.content).not.toContain(EDIT_HINT)
      expect(refused.isError).toBe(true)
      expect(withEditHint(refused.content)).toBe((await edit({}, { ...EDIT, path: '/apps/notes/gone.js' })).content)
    })
  })
})

describe('apps rm', () => {
  it('deletes each path by itself: a file, a folder with all in it, and not what is not there', async () => {
    const files = fakeAppFiles(appFiles('notes', { 'old.js': 'old\n', 'src/a.js': 'a\n', 'src/lib/b.js': 'bb\n', 'keep.js': 'keep\n' }))

    const result = await apps('rm', { paths: ['/apps/notes/old.js', '/apps/notes/gone.js', '/apps/notes/src'] })

    expect(result).toStrictEqual({
      content: [
        'Deleted 2 of 3 paths.',
        '1. Done. Deleted the file /apps/notes/old.js (4 B).',
        '2. Failed. Nothing is at /apps/notes/gone.js.',
        '3. Done. Deleted the folder /apps/notes/src with the 3 files and folders in it (5 B):',
        '/apps/notes/src/a.js',
        '/apps/notes/src/lib/',
        '/apps/notes/src/lib/b.js',
      ].join('\n'),
      isError: false,
    })
    expect(pathsIn(files, 'apps/notes')).toStrictEqual(['apps/notes/', 'apps/notes/keep.js', 'apps/notes/manifest.json'])
    expect(goneApps).toStrictEqual([])
  })

  it('deletes an app as a whole, and tells the editor that the app is gone', async () => {
    const files = fakeAppFiles({ ...appFiles('notes', { 'main.ts': 'x\n' }), ...appFiles('calc'), ...appFiles('draw') })
    const remove = native.deleteAppFile
    native.deleteAppFile = async (file) => {
      if (file.path === 'apps/calc') throw new Error(`Failed to delete ${APP_DIR}/apps/calc: Permission denied (os error 13)`)
      await remove(file)
    }

    expect((await apps('rm', { paths: ['/apps/notes/', '/apps/calc', '/apps/draw/manifest.json'] })).isError).toBe(false)
    expect(pathsIn(files, 'apps')).toStrictEqual(['apps/', 'apps/calc/', 'apps/calc/manifest.json', 'apps/draw/'])
    // The app that a failed delete left keeps its runs and its cards.
    expect(goneApps).toStrictEqual(['notes'])
  })

  it('gives an error when no path was deleted', async () => {
    fakeAppFiles(appFiles('notes'))

    expect(await apps('rm', { paths: ['/apps/notes/a.js', '/apps/calc'] })).toStrictEqual({
      content: 'Deleted 0 of 2 paths.\n1. Failed. Nothing is at /apps/notes/a.js.\n2. Failed. Nothing is at /apps/calc.',
      isError: true,
    })
    expect(native.deletedFiles).toStrictEqual([])
  })

  it('goes on after a path that the file system did not delete, and tells why with no path of the computer', async () => {
    const files = fakeAppFiles(appFiles('notes', { 'a.js': 'a\n', 'b.js': 'b\n' }))
    const remove = native.deleteAppFile
    native.deleteAppFile = async (file) => {
      if (file.path.endsWith('/a.js')) throw new Error(`Failed to delete ${APP_DIR}/apps/notes/a.js: Permission denied (os error 13)`)
      await remove(file)
    }

    const result = await apps('rm', { paths: ['/apps/notes/a.js', '/apps/notes/b.js'] })

    expect(result.isError).toBe(false)
    expect(result.content).toContain('1. Failed. Dez could not delete /apps/notes/a.js.')
    expect(result.content).toContain('2. Done. Deleted the file /apps/notes/b.js (2 B).')
    expect(result.content).not.toContain(APP_DIR)
    expect(result.content.split('\n')).toHaveLength(3)
    expect(pathsIn(files, 'apps/notes')).toStrictEqual(['apps/notes/', 'apps/notes/a.js', 'apps/notes/manifest.json'])
  })

  it('deletes no more after the reply stopped', async () => {
    const files = fakeAppFiles(appFiles('notes', { 'a.js': 'a\n', 'b.js': 'b\n' }))
    const stop = new AbortController()
    const remove = native.deleteAppFile
    native.deleteAppFile = async (file) => {
      await remove(file)
      stop.abort(STOP)
    }

    await apps('rm', { paths: ['/apps/notes/a.js', '/apps/notes/b.js'] }, stop.signal)

    expect(pathsIn(files, 'apps/notes')).toStrictEqual(['apps/notes/', 'apps/notes/b.js', 'apps/notes/manifest.json'])
  })
})

describe('apps mv', () => {
  it('does the moves one after the other, so that a move sees what the one before it did', async () => {
    const files = fakeAppFiles(appFiles('notes', { 'a.js': 'a\n', src: null }))

    const result = await apps('mv', { moves: [
      { from: '/apps/notes/a.js', to: '/apps/notes/src/b.js' },
      { from: '/apps/notes/src', to: '/apps/notes/lib' },
      { from: '/apps/notes/lib/b.js', to: '/apps/notes/c.js' },
    ] })

    expect(result).toStrictEqual({
      content: [
        'Did 3 of 3 moves.',
        '1. Done. Moved /apps/notes/a.js to /apps/notes/src/b.js.',
        '2. Done. Moved /apps/notes/src to /apps/notes/lib.',
        '3. Done. Moved /apps/notes/lib/b.js to /apps/notes/c.js.',
      ].join('\n'),
      isError: false,
    })
    expect(pathsIn(files, 'apps/notes')).toStrictEqual(['apps/notes/', 'apps/notes/c.js', 'apps/notes/lib/', 'apps/notes/manifest.json'])
    expect(textAt(files, 'apps/notes/c.js')).toBe('a\n')
  })

  it('makes the missing folder of a target for the user only', async () => {
    const files = fakeAppFiles({ ...appFiles('notes', { 'a.js': 'a\n' }), ...appFiles('calc') })

    expect((await apps('mv', { moves: [{ from: '/apps/notes/a.js', to: '/apps/calc/lib/deep/a.js' }] })).isError).toBe(false)

    expect(native.createdFolders).toStrictEqual([{ root: 'app', path: 'apps/calc/lib/deep' }])
    expect(textAt(files, 'apps/calc/lib/deep/a.js')).toBe('a\n')
    expect(files.has('apps/notes/a.js')).toBe(false)
  })

  it('refuses a target below a file, and makes no folder for it', async () => {
    const files = fakeAppFiles(appFiles('notes', { 'a.js': 'a\n', 'x.js': 'x\n' }))

    const result = await apps('mv', { moves: [{ from: '/apps/notes/a.js', to: '/apps/notes/x.js/sub/y.js' }] })

    expect(result).toStrictEqual({ content: 'Did 0 of 1 move.\n1. Failed. /apps/notes/x.js is a file, so nothing can be in it.', isError: true })
    expect(native.createdFolders).toStrictEqual([])
    expect(textAt(files, 'apps/notes/a.js')).toBe('a\n')
  })

  it('moves nothing over a file, and goes on with the next move', async () => {
    const files = fakeAppFiles(appFiles('notes', { 'a.js': 'a\n', 'b.js': 'b\n', 'c.js': 'c\n' }))

    const result = await apps('mv', { moves: [
      { from: '/apps/notes/a.js', to: '/apps/notes/b.js' },
      { from: '/apps/notes/c.js', to: '/apps/notes/d.js' },
    ] })

    expect(result.isError).toBe(false)
    expect(result.content).toContain('Did 1 of 2 moves.')
    expect(result.content).toContain('1. Failed. /apps/notes/b.js is taken: a file is there already')
    expect(textAt(files, 'apps/notes/a.js')).toBe('a\n')
    expect(textAt(files, 'apps/notes/b.js')).toBe('b\n')
    expect(textAt(files, 'apps/notes/d.js')).toBe('c\n')
  })

  it('gives an error when no move was done, and makes no folder for a move that fails', async () => {
    const files = fakeAppFiles(appFiles('notes'))

    const result = await apps('mv', { moves: [{ from: '/apps/notes/gone.js', to: '/apps/notes/lib/gone.js' }] })

    expect(result).toStrictEqual({ content: 'Did 0 of 1 move.\n1. Failed. Nothing is at /apps/notes/gone.js.', isError: true })
    expect(pathsIn(files, 'apps/notes')).toStrictEqual(['apps/notes/', 'apps/notes/manifest.json'])
  })

  it('renames an app with all its files, and tells the editor that the app of the old name is gone', async () => {
    const files = fakeAppFiles(appFiles('notes', { 'src/a.js': 'a\n', 'lib/b.js': 'b\n' }))

    const result = await apps('mv', { moves: [{ from: '/apps/notes/lib', to: '/apps/shared' }, { from: '/apps/notes', to: '/apps/journal' }] })

    expect(result.content).toContain('Renamed the app /apps/notes to /apps/journal.')
    expect(pathsIn(files, 'apps')).toStrictEqual([
      'apps/',
      'apps/journal/',
      'apps/journal/manifest.json',
      'apps/journal/src/',
      'apps/journal/src/a.js',
      'apps/shared/',
      'apps/shared/b.js',
    ])
    // A folder that leaves an app takes no app away.
    expect(goneApps).toStrictEqual(['notes'])
  })

  it('moves no more after the reply stopped', async () => {
    const files = fakeAppFiles(appFiles('notes', { 'a.js': 'a\n', 'b.js': 'b\n' }))
    const stop = new AbortController()
    const move = native.moveAppFile
    native.moveAppFile = async (from, to) => {
      await move(from, to)
      stop.abort(STOP)
    }

    await apps('mv', { moves: [{ from: '/apps/notes/a.js', to: '/apps/notes/a2.js' }, { from: '/apps/notes/b.js', to: '/apps/notes/b2.js' }] }, stop.signal)

    expect(pathsIn(files, 'apps/notes')).toStrictEqual(['apps/notes/', 'apps/notes/a2.js', 'apps/notes/b.js', 'apps/notes/manifest.json'])
  })
})

describe('apps mkdir', () => {
  it('makes a folder with the missing folders above it', async () => {
    const files = fakeAppFiles(appFiles('notes'))

    expect(await apps('mkdir', { path: '/apps/notes/data/cache' })).toStrictEqual({
      content: 'Made the folder /apps/notes/data/cache, and above it /apps/notes/data.',
      isError: false,
    })
    expect(pathsIn(files, 'apps/notes')).toStrictEqual(['apps/notes/', 'apps/notes/data/', 'apps/notes/data/cache/', 'apps/notes/manifest.json'])
  })

  it('makes nothing for a folder that is there, and none in an app that is not there', async () => {
    const files = fakeAppFiles(appFiles('notes', { data: null }))

    expect(await apps('mkdir', { path: '/apps/notes/data' })).toStrictEqual({ content: 'The folder /apps/notes/data is there already.', isError: false })
    expect((await apps('mkdir', { path: '/apps/calc/data' })).isError).toBe(true)
    expect(native.createdFolders).toStrictEqual([])
    expect(files.has('apps/calc')).toBe(false)
  })
})

describe('apps ls', () => {
  it('lists the names of a folder, and the folder of all apps for a call with no path', async () => {
    fakeAppFiles({ ...appFiles('notes', { 'main.ts': 'main\n', 'src/a.js': 'a\n', 'src/lib/b.js': 'bb\n', data: null }), ...appFiles('calc') })

    expect((await apps('ls', { path: '/apps/notes' })).content).toBe([
      '/apps/notes: 2 folders and 2 files (name | size).',
      'data/ | 0 files, 0 B',
      'main.ts | 5 B',
      'manifest.json | 77 B',
      'src/ | 2 files, 5 B',
    ].join('\n'))
    expect((await apps('ls', { path: '/apps/notes/src/lib' })).content).toBe('/apps/notes/src/lib: 0 folders and 1 file (name | size).\nb.js | 3 B')
    expect((await apps('ls')).content).toBe('/apps: 2 folders and 0 files (name | size).\ncalc/ | 1 file, 75 B\nnotes/ | 4 files, 87 B')
  })

  it('tells that there are no apps before the first one is made', async () => {
    fakeAppFiles()

    expect(await apps('ls')).toStrictEqual({ content: 'There are no apps yet. Make one with init.', isError: false })
    expect(await apps('list_apps')).toStrictEqual({ content: 'There are no apps yet. Make one with init.', isError: false })
  })
})

describe('apps find', () => {
  it('finds the files of every app, or of one folder, by words of their paths', async () => {
    fakeAppFiles({ ...appFiles('notes', { 'main.ts': 'main\n', 'src/lib/b.js': 'bb\n', data: null }), ...appFiles('calc') })

    expect(await apps('find', { query: '*' })).toStrictEqual({
      content: [
        '/apps: 4 files (paths after /apps/), by path.',
        'calc/manifest.json',
        'notes/main.ts',
        'notes/manifest.json',
        'notes/src/lib/b.js',
      ].join('\n'),
      isError: false,
    })
    expect((await apps('find', { query: 'src b', path: '/apps/notes' })).content)
      .toBe('/apps/notes: 1 of 3 files matches "src b" (paths after /apps/), by path.\nnotes/src/lib/b.js')
    expect(await apps('find', { query: '*', path: '/apps/todo' })).toStrictEqual({
      content: 'There is no app /apps/todo. Call list_apps to see the apps that are there.',
      isError: true,
    })
  })
})

// A stand-in for the Web Worker of `grep` (Node has none). It runs the
// matching of a request as grepWorker.ts does, after a timer tick; with
// `hangs` it gives nothing, as on a slow pattern, with `fails` it fails
// as a worker that runs out of memory, and with `refuses` its
// `postMessage` throws, as for a buffer that it cannot move. It keeps each
// worker that the runner made, for the checks of `terminate`.
class FakeGrepWorker {
  static made: FakeGrepWorker[] = []
  static hangs = false
  static fails = false
  static refuses = false
  onmessage: ((event: { data: GrepOutcome }) => void) | null = null
  onerror: ((event: { message: string }) => void) | null = null
  onmessageerror: (() => void) | null = null
  terminated = false

  constructor() {
    FakeGrepWorker.made.push(this)
  }

  postMessage(request: GrepRequest): void {
    if (FakeGrepWorker.refuses) throw new DOMException('An ArrayBuffer is detached and could not be cloned.', 'DataCloneError')
    if (FakeGrepWorker.hangs) return
    setTimeout(() => {
      if (this.terminated) return
      if (FakeGrepWorker.fails) this.onerror?.({ message: 'Out of memory' })
      else this.onmessage?.({ data: grepFiles(request) })
    })
  }

  terminate(): void {
    this.terminated = true
  }
}

describe('apps grep', () => {
  beforeEach(() => {
    FakeGrepWorker.made = []
    FakeGrepWorker.hangs = false
    FakeGrepWorker.fails = false
    FakeGrepWorker.refuses = false
    vi.stubGlobal('Worker', FakeGrepWorker)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  const terminated = () => FakeGrepWorker.made.map((worker) => worker.terminated)
  // Waits with real timer turns until the runner has read the files and
  // made its worker; `vi.waitFor` would move fake timers on as it waits.
  const workerMade = async () => {
    while (FakeGrepWorker.made.length === 0) await new Promise((resolve) => setImmediate(resolve))
  }

  it('reads the files whose names match, matches their lines in a worker, and ends the worker', async () => {
    fakeAppFiles({ ...appFiles('notes', { 'main.ts': 'const units = 1\nconvert(units)\n', 'src/a.js': 'no\n' }), ...appFiles('calc', { 'calc.js': 'units()\n' }) })

    expect(await apps('grep', { pattern: 'units', include: '*.{ts,js}' })).toStrictEqual({
      content: [
        '/apps: 3 lines in 2 of 3 files match "units" (paths after /apps/), by path.',
        '',
        'calc/calc.js',
        '1: units()',
        '',
        'notes/main.ts',
        '1: const units = 1',
        '2: convert(units)',
      ].join('\n'),
      isError: false,
    })
    expect(native.readFiles.map((file) => file.path).sort()).toStrictEqual(['apps/calc/calc.js', 'apps/notes/main.ts', 'apps/notes/src/a.js'])
    expect(terminated()).toStrictEqual([true])
  })

  it('stops a search at the time limit', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    FakeGrepWorker.hangs = true
    fakeAppFiles(appFiles('notes', { 'main.js': `${'a'.repeat(40)}!\n` }))

    const result = apps('grep', { pattern: '(a+)+$' })
    await workerMade()
    await vi.advanceTimersByTimeAsync(GREP_TIME_LIMIT_SECONDS * 1000 - 100)
    expect(terminated()).toStrictEqual([false])
    await vi.advanceTimersByTimeAsync(100)

    expect(await result).toStrictEqual({
      content: 'The search ran for more than 10 seconds, so Dez stopped it. A repeat in a repeat, as "(a+)+", or ".*" at the start of a pattern, can take very long on some lines. '
        + 'Make the pattern simpler, or search fewer files with `path` or `include`.',
      isError: true,
    })
    expect(terminated()).toStrictEqual([true])
  })

  it('ends the worker when the reply stops', async () => {
    FakeGrepWorker.hangs = true
    fakeAppFiles(appFiles('notes', { 'main.js': 'a\n' }))
    const stop = new AbortController()

    const result = apps('grep', { pattern: 'a' }, stop.signal)
    await workerMade()
    stop.abort(STOP)

    expect((await result).isError).toBe(true)
    expect(terminated()).toStrictEqual([true])
  })

  it('tells the model to try again when the worker fails', async () => {
    FakeGrepWorker.fails = true
    fakeAppFiles(appFiles('notes', { 'main.js': 'a\n' }))

    expect(await apps('grep', { pattern: 'a' })).toStrictEqual({
      content: 'Dez could not search the files. This is most likely no fault of the call: try it again, and tell the user when it fails again.\n\n'
        + 'Details: The search worker failed: Out of memory',
      isError: true,
    })
    expect(terminated()).toStrictEqual([true])
  })

  it('ends the worker when it cannot take the request', async () => {
    FakeGrepWorker.refuses = true
    fakeAppFiles(appFiles('notes', { 'main.js': 'a\n' }))

    expect(await apps('grep', { pattern: 'a' })).toStrictEqual({
      content: 'Dez could not search the files. This is most likely no fault of the call: try it again, and tell the user when it fails again.\n\n'
        + 'Details: An ArrayBuffer is detached and could not be cloned.',
      isError: true,
    })
    expect(terminated()).toStrictEqual([true])
  })
})

describe('apps list_apps', () => {
  it('lists each app with the facts of its manifest and the size of all its files', async () => {
    fakeAppFiles({
      ...appFiles('notes', { 'src/lib/b.js': 'x'.repeat(3000) }),
      ...appFiles('calc', {}, 'ui'),
      'apps/bare/main.js': 'x\n',
    })

    expect((await apps('list_apps')).content).toBe([
      '3 apps (name | kind | size | description), by name.',
      'bare | ? | 2 B | (no manifest.json)',
      'calc | ui | 71 B | The calc app.',
      'notes | script | 3 KB | The notes app.',
    ].join('\n'))
    expect((await apps('list_apps', { min_bytes: 1000 })).content).toBe('1 of 3 apps matches `min_bytes` 1000 (name | kind | size | description), by name.\nnotes | script | 3 KB | The notes app.')
  })

  it('reads no manifest that is too large, and none that is a folder', async () => {
    const files = fakeAppFiles({ ...appFiles('notes'), 'apps/odd/manifest.json': null })
    files.set('apps/huge', null)
    files.set('apps/huge/manifest.json', new Uint8Array(MANIFEST_MAX_BYTES + 1).fill(0x20))

    const rows = (await apps('list_apps')).content.split('\n').slice(1)

    expect(rows).toStrictEqual([
      'huge | ? | 16 KB | (a manifest.json that Dez does not read: it is no plain file of at most 16 KB)',
      'notes | script | 77 B | The notes app.',
      'odd | ? | 0 B | (a manifest.json that Dez does not read: it is no plain file of at most 16 KB)',
    ])
    expect(native.readFiles).toStrictEqual([{ root: 'app', path: 'apps/notes/manifest.json' }])
  })
})

describe('apps show', () => {
  // The apps that the reply took, in the order of the calls.
  let shown: string[]
  const show = (name: string, takes = true) => apps('show', { name }, running(), {
    showApp: (app) => {
      if (takes) shown.push(app)
      return takes
    },
  })

  beforeEach(() => {
    shown = []
  })

  it('puts a UI app with a page into the reply, and changes no file', async () => {
    const files = fakeAppFiles(appFiles('notes', { 'index.html': '<p>Notes</p>\n' }, 'ui'))
    const before = pathsIn(files, 'apps')

    const result = await show('notes')

    expect(result).toStrictEqual({ content: showResultText('notes'), isError: false })
    expect(shown).toStrictEqual(['notes'])
    expect(pathsIn(files, 'apps')).toStrictEqual(before)
    expect(native.savedFiles).toStrictEqual([])
    // The page is not read: the frame of the app loads it.
    expect(native.readFiles).toStrictEqual([{ root: 'app', path: 'apps/notes/manifest.json' }])
  })

  it.each([
    ['an app that is not there', {}, 'There is no app /apps/notes'],
    ['a script app', appFiles('notes', { 'main.ts': 'export default () => 1\n' }), '/apps/notes is a script app'],
    ['a UI app with no page', appFiles('notes', { 'main.js': '' }, 'ui'), 'has no index.html'],
    ['a UI app with a folder at the place of its page', appFiles('notes', { 'index.html': null }, 'ui'), '/apps/notes/index.html is a folder and no file'],
    ['an app with no manifest', { 'apps/notes/index.html': '<p>Notes</p>\n' }, 'has no manifest.json'],
  ])('shows nothing for %s', async (_case, start, why) => {
    fakeAppFiles(start)

    const result = await show('notes')

    expect(result.isError).toBe(true)
    expect(result.content).toContain(why)
    expect(shown).toStrictEqual([])
  })

  it('tells that it showed no app when the reply takes no text any more', async () => {
    fakeAppFiles(appFiles('notes', { 'index.html': '<p>Notes</p>\n' }, 'ui'))

    const result = await show('notes', false)

    expect(result.isError).toBe(true)
    expect(result.content).toContain('The reply stopped before Dez could put the app into it')
    expect(result.content).not.toContain('Dez shows the app')
  })
})

describe('a failure of the file system', () => {
  it('gives a result that tells what Dez tried, with no path of the computer, and logs the cause', async () => {
    fakeAppFiles(appFiles('notes'))
    const cause = new Error(`Failed to list ${APP_DIR}/apps/notes: Permission denied (os error 13)`)
    native.fileTree = () => { throw cause }

    const result = await apps('ls', { path: '/apps/notes' })

    expect(result.isError).toBe(true)
    expect(result.content).toContain('Dez could not list /apps/notes. This is most likely no fault of the call')
    expect(result.content).toContain('Details: Failed to list /home/…')
    expect(result.content).not.toContain(APP_DIR)
    expect(consoleError).toHaveBeenCalledWith('apps tool: Dez could not list /apps/notes:', cause)
  })
})
