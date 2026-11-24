import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import shippedImportMap from '../../../src-tauri/libs/import_map.json'
import { MANIFEST_MAX_BYTES, parseAppManifest } from './appManifest'
import { invokeCall } from './appInvoke'
import { grepCall } from './appsGrep'
import { showCall } from './appShow'
import {
  APPS_MAX_BYTES,
  APPS_MAX_ENTRIES,
  APPS_MAX_FILE_BYTES,
  APPS_TOOL,
  APPS_TOOL_DEFINITION,
  appsPath,
  appsRootTree,
  checkAppRoom,
  checkInitTarget,
  checkTextFile,
  editCall,
  editResult,
  fileText,
  findCall,
  findText,
  hasReadableManifest,
  initCall,
  initText,
  LIBRARY_SKILL_FILE,
  listAppsCall,
  listAppsText,
  lsCall,
  lsText,
  mkdirCall,
  mkdirStep,
  moveStep,
  mvCall,
  mvResult,
  nativeFailure,
  readCall,
  readText,
  rmCall,
  rmResult,
  rmStep,
  SHIPPED_LIBRARIES,
  wcCall,
  wcResult,
  wcRowOfBytes,
  wcRowOfFacts,
  writeCall,
  writePlan,
  writeText,
  type AppsTree,
  type ListedApp,
  type MoveFacts,
} from './appsTool'
import { checkArgumentValues } from './arguments'
import { parseSubcommandCall } from './subcommands'
import { appsArgs as args, CONVERSATION, CONVERSATION_ID, fileTree as file, FOLDER_FACTS as FOLDER, folderTree as folder, MISSING_TREE as MISSING, refusal, textBytes } from './testing'
import type { SubcommandArguments } from './types'

// The listing of an app with `count` files of `size` bytes.
function filled(count: number, size = 1): AppsTree {
  return folder(Object.fromEntries(Array.from({ length: count }, (_, index) => [`f${index}.txt`, size])))
}

const text = (content: Uint8Array | null) => (content === null ? null : new TextDecoder().decode(content))

describe('APPS_TOOL', () => {
  it('has the file subcommands, show, and invoke, in the order of the list that a model reads', () => {
    expect(APPS_TOOL_DEFINITION.name).toBe('apps')
    expect(APPS_TOOL.subcommands.map(({ name, parameters }) => [name, parameters.map((parameter) => parameter.name)])).toStrictEqual([
      ['init', ['name', 'kind', 'description']],
      ['read', ['path', 'ranges']],
      ['write', ['path', 'content']],
      ['edit', ['path', 'edits']],
      ['rm', ['paths']],
      ['list_apps', ['name', 'min_bytes', 'max_bytes', 'sort']],
      ['ls', ['path']],
      ['find', ['query', 'path']],
      ['grep', ['pattern', 'path', 'include', 'ignore_case', 'literal', 'context']],
      ['wc', ['paths']],
      ['mkdir', ['path']],
      ['mv', ['moves']],
      ['show', ['name']],
      ['invoke', ['name', 'parameters', 'inputs', 'decode', 'is_intermediate', 'timeout_seconds']],
    ])
  })

  it('gives each subcommand an example that its parameters and its checks take', () => {
    const id = CONVERSATION_ID
    const checks: Record<string, (call: SubcommandArguments) => unknown> = {
      init: initCall,
      read: (call) => readCall(call, id),
      write: (call) => writeCall(call, id),
      edit: (call) => editCall(call, id),
      rm: (call) => rmCall(call, id),
      list_apps: listAppsCall,
      ls: (call) => lsCall(call, id),
      find: (call) => findCall(call, id),
      grep: (call) => grepCall(call, id),
      wc: (call) => wcCall(call, id),
      mkdir: (call) => mkdirCall(call, id),
      mv: (call) => mvCall(call, id),
      show: showCall,
      invoke: (call) => invokeCall(call, CONVERSATION),
    }
    for (const subcommand of APPS_TOOL.subcommands) {
      expect(checkArgumentValues(subcommand, subcommand.example).ok, subcommand.name).toBe(true)
      expect(() => checks[subcommand.name](args(subcommand.name, subcommand.example)), subcommand.name).not.toThrow()
    }
  })

  it('runs the two list subcommands when a call gives no parameters', () => {
    expect(parseSubcommandCall(APPS_TOOL, { command: 'ls' })).toStrictEqual({ kind: 'run', name: 'ls', arguments: {} })
    expect(parseSubcommandCall(APPS_TOOL, { command: 'list_apps' })).toStrictEqual({ kind: 'run', name: 'list_apps', arguments: {} })
    expect(parseSubcommandCall(APPS_TOOL, { command: 'rm' }).kind).toBe('text')
  })
})

describe('appsPath', () => {
  // A path as a native file selector takes it, with the place of its top
  // folder.
  const place = (value: unknown) => {
    const { top, names, virtual, root, file } = appsPath(value, 'path', CONVERSATION_ID)
    return { place: top.place, names, virtual, root, file }
  }

  it('reads a path below /apps, with or without a "/" at its end', () => {
    expect(place('/apps')).toStrictEqual({ place: 'apps', names: [], virtual: '/apps', root: 'app', file: 'apps' })
    expect(place('/apps/')).toStrictEqual({ place: 'apps', names: [], virtual: '/apps', root: 'app', file: 'apps' })
    expect(place(' /apps/notes/ ')).toStrictEqual({ place: 'apps', names: ['notes'], virtual: '/apps/notes', root: 'app', file: 'apps/notes' })
    expect(place('/apps/notes/src/main.js')).toStrictEqual({ place: 'apps', names: ['notes', 'src', 'main.js'], virtual: '/apps/notes/src/main.js', root: 'app', file: 'apps/notes/src/main.js' })
  })

  it('reads a path below /libs in the files that Dez ships, and one below /work in the work folder of the conversation', () => {
    expect(place('/libs')).toStrictEqual({ place: 'libs', names: [], virtual: '/libs', root: 'resource', file: 'libs' })
    expect(place('/libs/three/three.module.js')).toStrictEqual({
      place: 'libs', names: ['three', 'three.module.js'], virtual: '/libs/three/three.module.js', root: 'resource', file: 'libs/three/three.module.js',
    })
    expect(place('/work/')).toStrictEqual({ place: 'work', names: [], virtual: '/work', root: 'app', file: `work/${CONVERSATION_ID}` })
    expect(place('/work/dez-x/data.json')).toStrictEqual({
      place: 'work', names: ['dez-x', 'data.json'], virtual: '/work/dez-x/data.json', root: 'app', file: `work/${CONVERSATION_ID}/dez-x/data.json`,
    })
  })

  it('refuses a path of /work in a conversation whose id names no folder', () => {
    expect(refusal(() => appsPath('/work/a.txt', 'path', 'a/b'))).toContain('this conversation has no /work folder')
    expect(appsPath('/apps/notes', 'path', 'a/b').file).toBe('apps/notes')
  })

  it('finds a built-in app by its name alone, in the files that Dez ships', () => {
    expect(place('/apps/dez-media/lib/main.ts')).toStrictEqual({
      place: 'apps', names: ['dez-media', 'lib', 'main.ts'], virtual: '/apps/dez-media/lib/main.ts', root: 'resource', file: 'builtin-apps/dez-media/lib/main.ts',
    })
    // Only the name of the app counts, not a name below it.
    expect(place('/apps/notes/dez-x')).toMatchObject({ root: 'app', file: 'apps/notes/dez-x' })
    expect(place('/apps/dez')).toMatchObject({ root: 'app', file: 'apps/dez' })
  })

  it('refuses a path that is not below /apps, /libs, or /work', () => {
    const form = 'Every path starts with /apps/, /libs/, or /work/, as in "/apps/unit-converter/main.js".'

    expect(refusal(() => appsPath('', 'from', CONVERSATION_ID))).toBe(`\`from\` is empty. ${form}`)
    expect(refusal(() => appsPath(7, 'from', CONVERSATION_ID))).toBe(`\`from\` is empty. ${form}`)
    for (const path of ['notes/main.js', '/home/u/.config/dez/apps/notes/main.js', '/appsx/notes', 'apps/notes', '~/apps/notes', '/workspace/a', '/run/a.txt']) {
      expect(refusal(() => appsPath(path, 'path', CONVERSATION_ID)), path).toBe(`${JSON.stringify(path)} is no path of the apps tool. ${form}`)
    }
  })

  it('refuses "." and "..", does not resolve them, and gives an example in the top folder of the path', () => {
    for (const path of ['/apps/notes/../other/main.js', '/apps/..', '/apps/notes/./main.js']) {
      expect(refusal(() => appsPath(path, 'path', CONVERSATION_ID)), path).toContain('which the apps tool does not resolve')
    }
    const examples = [
      ['/apps/notes/../a.js', 'Give the whole path from /apps/, as in "/apps/unit-converter/main.js".'],
      ['/libs/../three/SKILL.md', 'Give the whole path from /libs/, as in "/libs/dez-media/SKILL.md".'],
      ['/work/../a.mp4', 'Give the whole path from /work/, as in "/work/clips/a.mp4".'],
    ]
    for (const [path, advice] of examples) {
      expect(refusal(() => appsPath(path, 'path', CONVERSATION_ID)), path)
        .toBe(`The path ${JSON.stringify(path)} holds "..", which the apps tool does not resolve. ${advice}`)
    }
  })

  it('refuses a name that the file commands of Dez do not take', () => {
    for (const path of ['/apps/notes/my file.js', '/apps/notes/caf\u00e9.js', '/apps/notes/a\\b', '/apps/notes/a:b', '/apps/notes/x\n.js', '/apps/notes/*']) {
      expect(refusal(() => appsPath(path, 'path', CONVERSATION_ID)), path).toContain('The name of a file or a folder has only ASCII letters, digits, "-", "_", and ".".')
    }
    expect(refusal(() => appsPath('/apps//notes', 'path', CONVERSATION_ID))).toContain('has an empty name')
    expect(refusal(() => appsPath('/apps/notes//', 'path', CONVERSATION_ID))).toContain('has an empty name')
  })

  it('refuses a name and a path that are too long', () => {
    expect(appsPath(`/apps/notes/${'a'.repeat(100)}`, 'path', CONVERSATION_ID).names[1]).toHaveLength(100)
    expect(refusal(() => appsPath(`/apps/notes/${'a'.repeat(101)}`, 'path', CONVERSATION_ID))).toContain('holds a name of 101 characters, and a name has at most 100.')

    const deep = (count: number) => `/apps/${Array.from({ length: count }, () => 'a').join('/')}`
    expect(appsPath(deep(12), 'path', CONVERSATION_ID).names).toHaveLength(12)
    expect(refusal(() => appsPath(deep(13), 'path', CONVERSATION_ID))).toContain('has 13 names after /apps/, and a path has at most 12.')
  })
})

describe('checkAppRoom', () => {
  const app = appsPath('/apps/notes', 'path', CONVERSATION_ID)

  it('refuses what would put an app over a limit', () => {
    expect(() => checkAppRoom(app, filled(APPS_MAX_ENTRIES - 1), { entries: 1, bytes: 10 })).not.toThrow()
    expect(refusal(() => checkAppRoom(app, filled(APPS_MAX_ENTRIES - 1), { entries: 2, bytes: 0 })))
      .toBe('The app /apps/notes has 999 files and folders, and this call would add 2. An app holds at most 1,000 files and folders, and 100.0 MB. Delete files of the app with rm first.')

    const big = filled(2, APPS_MAX_BYTES / 2 - 10)
    expect(() => checkAppRoom(app, big, { entries: 1, bytes: 20 })).not.toThrow()
    expect(refusal(() => checkAppRoom(app, big, { entries: 1, bytes: 21 }))).toContain('The app /apps/notes has 100.0 MB, and this call would add 21 B.')
    expect(refusal(() => checkAppRoom(app, folder({ 'a.txt': 1 }, true), { entries: 1, bytes: 1 }))).toContain('has more than 1,000 files and folders, so Dez adds nothing to it.')
  })

  it('passes a call that adds nothing, also in an app that is over a limit', () => {
    expect(() => checkAppRoom(app, folder({ 'a.txt': APPS_MAX_BYTES * 2 }, true), { entries: 0, bytes: -5 })).not.toThrow()
    expect(() => checkAppRoom(app, folder({ 'a.txt': APPS_MAX_BYTES * 2 }, true), { entries: 0, bytes: 0 })).not.toThrow()
  })
})

describe('nativeFailure', () => {
  it('gives the cause of a failure, with no path of the computer', () => {
    expect(nativeFailure('write /apps/notes/main.js', 'Failed to write apps/notes/main.js: No space left on device (os error 28)').message).toBe(
      'Dez could not write /apps/notes/main.js. This is most likely no fault of the call: try it again, and tell the user when it fails again.'
      + '\n\nDetails: Failed to write apps/notes/main.js: No space left on device (os error 28)',
    )
    expect(nativeFailure('list /apps/notes', 'cannot open /home/u/.config/dez/apps/notes').message).not.toContain('/home/u')
  })
})

describe('init', () => {
  it('makes the manifest and the first files of a script app', () => {
    const call = initCall(args('init', { name: 'notes', kind: 'script', description: ' Keeps  notes.\nFast. ' }))

    expect(call.app).toMatchObject({ names: ['notes'], virtual: '/apps/notes', root: 'app', file: 'apps/notes' })
    expect(call.manifest).toStrictEqual({ name: 'notes', description: 'Keeps notes. Fast.', kind: 'script' })
    expect(call.files.map((made) => made.path.file)).toStrictEqual(['apps/notes/manifest.json', 'apps/notes/main.ts'])
    expect(parseAppManifest(call.files[0].content)).toStrictEqual(call.manifest)
    expect(call.files[1].content).toContain('export default async function main(')
    expect(initText(call)).toBe([
      'Made the script app /apps/notes with 2 files:',
      '/apps/notes/manifest.json',
      '/apps/notes/main.ts',
      'Change them with read, edit, and write.',
    ].join('\n'))
  })

  it('makes a UI app whose page has no script and no style of its own', () => {
    const call = initCall(args('init', { name: 'unit-converter', kind: 'UI', description: 'Converts units.' }))

    expect(call.manifest.kind).toBe('ui')
    expect(call.files.map((made) => made.path.virtual)).toStrictEqual([
      '/apps/unit-converter/manifest.json',
      '/apps/unit-converter/index.html',
      '/apps/unit-converter/main.js',
      '/apps/unit-converter/style.css',
    ])
    const page = call.files[1].content
    // The import map comes before the first module, and a browser takes it
    // from no file. Dez's client script is first of the scripts that load a
    // file, so that it sees a key before the code of the app does. The
    // script of the app is a module: it imports the shipped libraries, and
    // the webview shows its errors.
    expect(page.match(/<script[^>]*>/g)).toStrictEqual(['<script type="importmap">', '<script src="~dez.js">', '<script type="module" src="main.js">'])
    expect(page).toContain('<link rel="stylesheet" href="style.css">')
    expect(page).not.toMatch(/\son[a-z]+\s*=|<style|javascript:/i)
    expect(initText(call)).toContain('Made the UI app /apps/unit-converter with 4 files:')
  })

  it('refuses a name that is no name of an app', () => {
    const rule = 'The name of an app is 1 to 64 characters: lower-case letters, digits, "-", and "_", and the first one is a letter or a digit, as in "unit-converter". '
      + 'A name that starts with "dez-" is for the built-in apps of Dez.'
    const named = (name: string) => () => initCall(args('init', { name, kind: 'ui', description: 'x' }))

    for (const name of ['Notes', '-notes', '_notes', 'my notes', 'notes.app', 'a/b', '', 'a'.repeat(65)]) {
      expect(refusal(named(name)), name).toBe(`${JSON.stringify(name)} is no name for an app. ${rule}`)
    }
    expect(named('a'.repeat(64))).not.toThrow()
    expect(named('7_up-2')).not.toThrow()
    // Dez would hide a path with this name from the model.
    expect(refusal(named('home'))).toContain('The apps tool makes no file and no folder with the name "home" in its path (/apps/home)')
  })

  it('refuses an unknown kind and a description that is empty or too long', () => {
    const call = (more: Record<string, unknown>) => () => initCall(args('init', { name: 'notes', kind: 'ui', description: 'x', ...more }))

    expect(refusal(call({ kind: 'web' }))).toBe('Unknown value "web" in `kind`. Use one of: script, ui.')
    expect(refusal(call({ description: ' \n ' }))).toContain('`description` is empty.')
    expect(call({ description: 'd'.repeat(200) })).not.toThrow()
    expect(refusal(call({ description: 'd'.repeat(201) }))).toBe('`description` has 201 characters, and it has at most 200. Give a shorter one.')
  })

  it('replaces nothing that is at the path of the new app', () => {
    const call = initCall(args('init', { name: 'notes', kind: 'ui', description: 'x' }))

    expect(() => checkInitTarget(call, MISSING)).not.toThrow()
    expect(refusal(() => checkInitTarget(call, FOLDER))).toContain('The app /apps/notes is there already, and init replaces nothing.')
    expect(refusal(() => checkInitTarget(call, file(3)))).toBe('/apps/notes is there already, and it is a file. Give another name.')
  })
})

describe('built-in apps', () => {
  const refused = (path: string) => `${path}: the names of apps that start with "dez-" are for the built-in apps of Dez, and no call makes, changes, moves, or deletes a file there. `
    + 'Give an app of your own another name. To change a built-in app, copy its files into an app of your own with read and write.'

  it('refuses every call that would make, change, move, or delete a file of one', () => {
    expect(refusal(() => initCall(args('init', { name: 'dez-notes', kind: 'script', description: 'x' })))).toBe(refused('/apps/dez-notes'))
    expect(refusal(() => writeCall(args('write', { path: '/apps/dez-media/main.ts', content: 'x' }), CONVERSATION_ID))).toBe(refused('/apps/dez-media/main.ts'))
    expect(refusal(() => editCall(args('edit', { path: '/apps/dez-media/main.ts', edits: [{ old_string: 'a', new_string: 'b' }] }), CONVERSATION_ID))).toBe(refused('/apps/dez-media/main.ts'))
    expect(refusal(() => mkdirCall(args('mkdir', { path: '/apps/dez-media/data' }), CONVERSATION_ID))).toBe(refused('/apps/dez-media/data'))
    // One built-in path fails the whole call: rm deletes nothing then.
    expect(refusal(() => rmCall(args('rm', { paths: ['/apps/notes/old.js', '/apps/dez-media'] }), CONVERSATION_ID))).toBe(refused('/apps/dez-media'))
    expect(refusal(() => mvCall(args('mv', { moves: [{ from: '/apps/dez-media', to: '/apps/media' }] }), CONVERSATION_ID))).toBe(refused('/apps/dez-media'))
    expect(refusal(() => mvCall(args('mv', { moves: [{ from: '/apps/notes', to: '/apps/dez-notes' }] }), CONVERSATION_ID))).toBe(refused('/apps/dez-notes'))
    expect(refusal(() => mvCall(args('mv', { moves: [{ from: '/apps/notes/a.js', to: '/apps/dez-media/a.js' }] }), CONVERSATION_ID))).toBe(refused('/apps/dez-media/a.js'))
  })
})

describe('SHIPPED_LIBRARIES', () => {
  // The tool texts tell a model to import each library by its name and to
  // read its SKILL.md first: a name that the import map lacks, or a folder
  // with no SKILL.md, sends the model to a file or a module that is not
  // there.
  it('names libraries that the import map has, each with a SKILL.md that Dez ships', () => {
    for (const { name } of SHIPPED_LIBRARIES) {
      expect(Object.keys(shippedImportMap.imports), name).toContain(name)
      expect(existsSync(new URL(`../../../src-tauri/libs/${name}/${LIBRARY_SKILL_FILE}`, import.meta.url)), name).toBe(true)
    }
  })
})

describe('/libs and /work', () => {
  const write = (path: string) => writeCall(args('write', { path, content: 'a\n' }), CONVERSATION_ID)
  const mkdir = (path: string) => mkdirCall(args('mkdir', { path }), CONVERSATION_ID).path
  const ls = (path: string, tree: AppsTree) => lsText(lsCall(args('ls', { path }), CONVERSATION_ID).path, tree)
  const libsRefusal = (path: string) => `${path}: /libs/ holds the libraries that Dez ships, and no call makes, changes, moves, or deletes a file there. `
    + 'To change a file of it, copy it into /work/ or into an app of your own with read and write.'

  it('reads /libs, and refuses every call that would change it', () => {
    expect(readCall(args('read', { path: '/libs/three/x.js' }), CONVERSATION_ID).path.file).toBe('libs/three/x.js')
    expect(refusal(() => write('/libs/three/x.js'))).toBe(libsRefusal('/libs/three/x.js'))
    expect(refusal(() => editCall(args('edit', { path: '/libs/x.js', edits: [{ old_string: 'a', new_string: 'b' }] }), CONVERSATION_ID))).toBe(libsRefusal('/libs/x.js'))
    expect(refusal(() => mkdir('/libs/three'))).toBe(libsRefusal('/libs/three'))
    expect(refusal(() => rmCall(args('rm', { paths: ['/libs'] }), CONVERSATION_ID))).toBe(libsRefusal('/libs'))
    expect(refusal(() => mvCall(args('mv', { moves: [{ from: '/libs/three', to: '/work/three' }] }), CONVERSATION_ID))).toBe(libsRefusal('/libs/three'))
  })

  it('writes a file directly in /work, and makes the work folder when it is not there', () => {
    expect(writePlan(write('/work/a.txt'), MISSING, MISSING).folder).toMatchObject({ virtual: '/work', file: `work/${CONVERSATION_ID}` })
    expect(writePlan(write('/work/a.txt'), MISSING, folder())).toStrictEqual({ folder: null, replaced: null })
    expect(writePlan(write('/work/data/a.txt'), MISSING, MISSING).folder?.virtual).toBe('/work/data')
    expect(refusal(() => write('/work'))).toContain('/work is the work folder of this conversation, not a file.')
  })

  it('holds /work to no cap of an app', () => {
    const full = folder({ 'a.bin': APPS_MAX_BYTES * 2 }, true)

    expect(() => writePlan(write('/work/new/b.txt'), MISSING, full)).not.toThrow()
    expect(() => mkdirStep(mkdir('/work/x/y'), MISSING, full)).not.toThrow()
  })

  it('makes /work and the folders in it, and deletes nothing but what is in it', () => {
    expect(mkdirStep(mkdir('/work'), MISSING, MISSING)).toStrictEqual({ make: true, text: 'Made the folder /work.' })
    expect(mkdirStep(mkdir('/work/a/b'), MISSING, MISSING).text).toBe('Made the folder /work/a/b, and above it /work/a.')
    expect(refusal(() => rmCall(args('rm', { paths: ['/work/a.txt', '/work/'] }), CONVERSATION_ID)))
      .toBe('/work is the work folder of this conversation, and rm does not delete it: it goes with the conversation. To delete what is in it, give the paths in it, as in "/work/old.json".')
    expect(rmCall(args('rm', { paths: ['/work/a.txt'] }), CONVERSATION_ID).paths[0].file).toBe(`work/${CONVERSATION_ID}/a.txt`)
  })

  it('lists a /work that is not there yet as empty, and tells that a /libs that is not there is a fault of Dez', () => {
    expect(ls('/work', MISSING)).toBe('/work is an empty folder.')
    expect(ls('/work', folder({ 'a.txt': 3 }))).toBe('/work: 0 folders and 1 file (name | size).\na.txt | 3 B')
    expect(refusal(() => ls('/work/data', MISSING))).toBe('There is no folder /work/data. Call ls with "/work" to see what is there.')
    expect(refusal(() => ls('/libs', MISSING))).toBe('/libs is not there: Dez is not installed in full. This is a fault of Dez, not of your call: tell the user to install Dez again.')
    expect(findText(findCall(args('find', { query: 'three', path: '/libs' }), CONVERSATION_ID), folder({ three: null, 'three/three.module.js': 9 })))
      .toBe('/libs: 1 of 1 file matches "three" (paths after /libs/), by path.\nthree/three.module.js')
  })
})

describe('read', () => {
  const path = appsPath('/apps/notes/main.js', 'path', CONVERSATION_ID)
  const read = (parameters: Record<string, unknown>, content: string) => readText(readCall(args('read', { path: path.virtual, ...parameters }), CONVERSATION_ID), content, textBytes(content).length)
  const readRanges = (ranges: Record<string, number>[], content: string) => read({ ranges }, content)

  it('gives each line after its number, under the facts of the file', () => {
    expect(read({}, 'const a = 1\n\n  return a\n')).toBe([
      '/apps/notes/main.js: lines 1-3 of 3 (24 B)',
      '1: const a = 1',
      '2: ',
      '3:   return a',
    ].join('\n'))
    expect(read({}, 'one line, no line end')).toBe('/apps/notes/main.js: line 1 of 1 (21 B)\n1: one line, no line end')
    expect(readRanges([], 'one line, no line end')).toBe('/apps/notes/main.js: line 1 of 1 (21 B)\n1: one line, no line end')
  })

  it('gives the lines of a range, and ends it at the end of the file', () => {
    const content = 'a\nb\nc\nd\n'

    expect(readRanges([{ from_line: 2, to_line: 3 }], content)).toBe('/apps/notes/main.js: lines 2-3 of 4 (8 B)\n2: b\n3: c')
    expect(readRanges([{ from_line: 4 }], content)).toBe('/apps/notes/main.js: line 4 of 4 (8 B)\n4: d')
    expect(readRanges([{ from_line: 3, to_line: 90 }], content)).toBe('/apps/notes/main.js: lines 3-4 of 4 (8 B)\n3: c\n4: d')
  })

  it('gives the ranges in the order of the call', () => {
    expect(readRanges([{ from_line: 5 }, { from_line: 1, to_line: 2 }, { from_line: 4, to_line: 4 }], 'a\nb\nc\nd\ne\nf\n')).toBe([
      '/apps/notes/main.js: lines 5-6, lines 1-2, and line 4 of 6 (12 B)',
      '5: e',
      '6: f',
      '1: a',
      '2: b',
      '4: d',
    ].join('\n'))
  })

  it('leaves out a range that overlaps an earlier range, and gives the others', () => {
    expect(readRanges([{ from_line: 2, to_line: 4 }, { from_line: 4, to_line: 9 }, { from_line: 6 }, { from_line: 1, to_line: 2 }], 'a\nb\nc\nd\ne\nf\n')).toBe([
      '/apps/notes/main.js: lines 2-4 and line 6 of 6 (12 B)',
      '2: b',
      '3: c',
      '4: d',
      '6: f',
      'Range 2 is left out. It names lines 4-6, and range 1 names lines 2-4 already. Make one range of the two, as in {"from_line": 2, "to_line": 6}.',
      'Range 4 is left out. It names lines 1-2, and range 1 names lines 2-4 already. Make one range of the two, as in {"from_line": 1, "to_line": 4}.',
    ].join('\n'))
  })

  it('leaves out each range that the file does not have, and gives the others', () => {
    expect(readRanges([{ from_line: 0 }, { from_line: 2 }, { from_line: 3, to_line: 1 }, { from_line: 9 }], 'a\nb\nc\nd\n')).toBe([
      '/apps/notes/main.js: lines 2-4 of 4 (8 B)',
      '2: b',
      '3: c',
      '4: d',
      'Range 1 is left out. `from_line` is 0. The first line of a file is line 1.',
      'Range 3 is left out. `to_line` (1) is before `from_line` (3). Give the first and the last line to read, as in {"from_line": 3, "to_line": 102}.',
      'Range 4 is left out. `from_line` is 9, and /apps/notes/main.js has 4 lines.',
    ].join('\n'))
  })

  it('refuses a call whose ranges give no line', () => {
    expect(refusal(() => readRanges([{ from_line: 5 }], 'a\nb\nc\nd\n'))).toBe('`from_line` is 5, and /apps/notes/main.js has 4 lines.')
    expect(refusal(() => readRanges([{ from_line: 0 }], 'a\n'))).toBe('`from_line` is 0. The first line of a file is line 1.')
    expect(refusal(() => readRanges([{ from_line: 3, to_line: 2 }], 'a\n'))).toContain('`to_line` (2) is before `from_line` (3).')
    expect(refusal(() => readRanges([{ from_line: 2 }, { from_line: 0 }], 'a\n'))).toBe([
      'Range 1 is left out. `from_line` is 2, and /apps/notes/main.js has 1 line.',
      'Range 2 is left out. `from_line` is 0. The first line of a file is line 1.',
    ].join('\n'))
  })

  it('tells that a file is empty', () => {
    expect(read({}, '')).toBe('/apps/notes/main.js is an empty file.')
    expect(refusal(() => readRanges([{ from_line: 2 }], ''))).toBe('`from_line` is 2, and /apps/notes/main.js is an empty file.')
  })

  it('gives at most 900 lines, and tells where to read on', () => {
    const result = read({}, 'x\n'.repeat(1000)).split('\n')

    expect(result[0]).toBe('/apps/notes/main.js: lines 1-900 of 1000 (2 KB)')
    expect(result).toHaveLength(902)
    expect(result[900]).toBe('900: x')
    expect(result[901]).toBe('Not shown: lines 901-1000. One call gives at most 900 lines and 50,000 characters: call read again with "ranges": [{"from_line": 901}] for the next ones.')
  })

  it('names as not shown only the lines that the call asked for', () => {
    const result = readRanges([{ from_line: 50, to_line: 960 }], 'x\n'.repeat(1000)).split('\n')

    expect(result[0]).toBe('/apps/notes/main.js: lines 50-949 of 1000 (2 KB)')
    expect(result.at(-1)).toContain('Not shown: lines 950-960.')
    expect(result.at(-1)).toContain('"ranges": [{"from_line": 950, "to_line": 960}]')
  })

  it('counts the limits over all the ranges, and gives the ranges that they left out', () => {
    const result = readRanges([{ from_line: 1, to_line: 500 }, { from_line: 551 }, { from_line: 501, to_line: 510 }], 'x\n'.repeat(1000)).split('\n')

    expect(result[0]).toBe('/apps/notes/main.js: lines 1-500 and lines 551-950 of 1000 (2 KB)')
    expect(result).toHaveLength(902)
    expect(result[501]).toBe('551: x')
    expect(result.at(-1)).toBe('Not shown: lines 951-1000 and lines 501-510. One call gives at most 900 lines and 50,000 characters: '
      + 'call read again with "ranges": [{"from_line": 951}, {"from_line": 501, "to_line": 510}] for the next ones.')
  })

  it('gives at most 50,000 characters', () => {
    const result = read({}, `${'y'.repeat(1000)}\n`.repeat(100)).split('\n')

    expect(result[0]).toBe('/apps/notes/main.js: lines 1-49 of 100 (98 KB)')
    expect(result.at(-1)).toContain('Not shown: lines 50-100.')
    expect(result.at(-1)).toContain('"ranges": [{"from_line": 50}]')
    expect(result.join('\n').length).toBeLessThan(51_000)
  })

  it('gives the start of a line that is longer than a whole result', () => {
    const result = read({}, `${'z'.repeat(60_000)}\nsecond\n`).split('\n')

    expect(result[0]).toBe('/apps/notes/main.js: line 1 of 2 (59 KB)')
    expect(result[1]).toBe(`1: ${'z'.repeat(49_997)}…`)
    expect(result.slice(2)).toStrictEqual([
      'Line 1 has 60,000 characters, and only its start shows.',
      'Not shown: line 2. One call gives at most 900 lines and 50,000 characters: call read again with "ranges": [{"from_line": 2}] for the next ones.',
    ])
  })

  it('takes the path of a file only', () => {
    expect(refusal(() => readCall(args('read', { path: '/apps' }), CONVERSATION_ID))).toContain('/apps is the folder of all apps, not a file.')
    expect(refusal(() => readCall(args('read', { path: '/apps/notes' }), CONVERSATION_ID))).toContain('/apps/notes is the folder of an app, not a file.')
  })

  it('refuses what is no plain file of at most 2 MiB', () => {
    expect(() => checkTextFile(path, file(APPS_MAX_FILE_BYTES))).not.toThrow()
    expect(refusal(() => checkTextFile(path, MISSING))).toBe('There is no file /apps/notes/main.js. Call ls to see the files of its folder, as in {"path": "/apps/notes"}.')
    expect(refusal(() => checkTextFile(path, FOLDER))).toBe('/apps/notes/main.js is a folder, not a file. Call ls to see what is in it.')
    expect(refusal(() => checkTextFile(path, { kind: 'other', size: 0 }))).toContain('the apps tool opens plain files only')
    expect(refusal(() => checkTextFile(path, file(APPS_MAX_FILE_BYTES + 1)))).toBe('/apps/notes/main.js has 2,097,153 bytes, and the apps tool reads and edits a file of at most 2,097,152 bytes.')
    expect(refusal(() => checkTextFile(path, file(3 * APPS_MAX_FILE_BYTES)))).toBe('/apps/notes/main.js has 6.0 MB, and the apps tool reads and edits a file of at most 2.0 MB.')
  })

  it('refuses a file that is no text', () => {
    const noText = '/apps/notes/main.js is no text file (it holds a zero byte, or bytes that are no UTF-8), and the apps tool reads and edits text files only.'

    expect(fileText(path, textBytes('gr\u00fc\u00dfe \ud83d\ude00\n'))).toBe('gr\u00fc\u00dfe \ud83d\ude00\n')
    expect(refusal(() => fileText(path, new Uint8Array([0x61, 0x00, 0x62])))).toBe(noText)
    expect(refusal(() => fileText(path, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff])))).toBe(noText)
    // A file that grew after its size check.
    expect(refusal(() => fileText(path, new Uint8Array(APPS_MAX_FILE_BYTES + 1).fill(0x61)))).toContain('reads and edits a file of at most 2,097,152 bytes')
  })

  it('keeps a byte order mark, so that an edit writes it back', () => {
    const marked = new Uint8Array([0xef, 0xbb, 0xbf, 0x61, 0x0a])

    expect(textBytes(fileText(path, marked))).toStrictEqual(marked)
  })
})

describe('write', () => {
  const write = (path: string, content = 'a\nb\n') => writeCall(args('write', { path, content }), CONVERSATION_ID)
  const app = folder({ 'manifest.json': 80, src: null, 'src/a.js': 10, 'notes.txt': 5 })

  it('counts the bytes and the lines of the text', () => {
    const call = write('/apps/notes/a.txt', 'gr\u00fc\u00dfe\nb')

    expect(text(call.bytes)).toBe('gr\u00fc\u00dfe\nb')
    expect(call.lines).toBe(2)
    expect(writeText(call, null)).toBe('Wrote the new file /apps/notes/a.txt (9 B, 2 lines).')
    expect(writeText(call, 2048)).toBe('Wrote /apps/notes/a.txt (9 B, 2 lines) in place of the file that was there (2 KB).')
  })

  it('refuses a text of more than 2 MiB', () => {
    expect(() => write('/apps/notes/a.txt', 'a'.repeat(APPS_MAX_FILE_BYTES))).not.toThrow()
    expect(refusal(() => write('/apps/notes/a.txt', 'a'.repeat(APPS_MAX_FILE_BYTES + 1)))).toContain('`content` has 2,097,153 bytes, and a file is at most 2,097,152 bytes.')
  })

  it('takes the path of a file in an app only, with no name that Dez would hide', () => {
    expect(refusal(() => write('/apps/notes'))).toContain('/apps/notes is the folder of an app, not a file.')
    expect(refusal(() => write('/apps/notes/home/a.txt'))).toContain('with the name "home" in its path (/apps/notes/home/a.txt)')
    expect(refusal(() => write('/apps/notes/Users'))).toContain('with the name "Users" in its path')
    expect(() => write('/apps/notes/homepage/users.txt')).not.toThrow()
  })

  it('makes only the folders of the path that are missing', () => {
    expect(writePlan(write('/apps/notes/a.txt'), MISSING, app)).toStrictEqual({ folder: null, replaced: null })
    expect(writePlan(write('/apps/notes/src/b.js'), MISSING, app)).toStrictEqual({ folder: null, replaced: null })
    expect(writePlan(write('/apps/notes/src/lib/deep/b.js'), MISSING, app).folder?.virtual).toBe('/apps/notes/src/lib/deep')
  })

  it('replaces a file, and nothing else', () => {
    expect(writePlan(write('/apps/notes/notes.txt'), file(5), app)).toStrictEqual({ folder: null, replaced: 5 })
    expect(refusal(() => writePlan(write('/apps/notes/src'), FOLDER, app))).toBe('/apps/notes/src is a folder. Give the path of a file, as in "/apps/notes/src/main.js".')
    expect(refusal(() => writePlan(write('/apps/notes/link'), { kind: 'other', size: 0 }, app))).toContain('the apps tool writes plain files only')
    expect(refusal(() => writePlan(write('/apps/notes/notes.txt/a.js'), MISSING, app))).toBe('/apps/notes/notes.txt is a file, so nothing can be in it.')
  })

  it('writes only into an app that is there', () => {
    expect(refusal(() => writePlan(write('/apps/notes/a.txt'), MISSING, MISSING)))
      .toBe('There is no app /apps/notes. Make it with init first, or call list_apps to see the apps that are there.')
    expect(refusal(() => writePlan(write('/apps/notes/a.txt'), MISSING, file(3)))).toContain('/apps/notes is a file and no folder, so it is no app.')
  })

  it('counts the new file and the new folders against the limit of the app', () => {
    const almostFull = filled(APPS_MAX_ENTRIES - 2)

    expect(() => writePlan(write('/apps/notes/new/a.txt'), MISSING, almostFull)).not.toThrow()
    expect(refusal(() => writePlan(write('/apps/notes/new/deep/a.txt'), MISSING, almostFull))).toContain('has 998 files and folders, and this call would add 3.')
  })

  it('counts only the growth of a file that it replaces', () => {
    const full = filled(4, APPS_MAX_BYTES / 4)

    expect(() => writePlan(write('/apps/notes/f0.txt', 'a'.repeat(100)), file(100), full)).not.toThrow()
    expect(refusal(() => writePlan(write('/apps/notes/f0.txt', 'a'.repeat(101)), file(100), full))).toContain('and this call would add 1 B.')
    // A model can make a file of an app that is over a limit smaller.
    expect(() => writePlan(write('/apps/notes/f0.txt', 'a'), file(100), folder({ 'f0.txt': 100 }, true))).not.toThrow()
    expect(refusal(() => writePlan(write('/apps/notes/new.txt', 'a'), MISSING, folder({ 'f0.txt': 100 }, true)))).toContain('so Dez adds nothing to it')
  })
})

describe('edit', () => {
  const edit = (edits: unknown[]) => editCall(args('edit', { path: '/apps/notes/main.js', edits }), CONVERSATION_ID)

  it('does the edits that pass, and tells what each one did', () => {
    const result = editResult(edit([
      { old_string: 'a = 1', new_string: 'a = 2' },
      { old_string: 'b = 1', new_string: 'x' },
      { old_string: '(a)', new_string: '(a, 0)', replace_all: true },
    ]), 'const a = 1\nrun(a)\nlog(a)\n')

    expect(text(result.bytes)).toBe('const a = 2\nrun(a, 0)\nlog(a, 0)\n')
    expect(result.isError).toBe(false)
    expect(result.content).toBe([
      'Edited /apps/notes/main.js: 2 of 3 edits done.',
      '1. Done. Replaced the text at line 1.',
      '2. Failed. `old_string` is not in the file. The edits before this one changed the file first, and this edit looked for its text in what they left. '
        + 'Read the file again, and give the text as it is in the file, with its white space and its line ends, '
        + 'but without the `12: ` before each line of a read result: that number is no part of the file.',
      '3. Done. Replaced the text at 2 places, on lines 2 and 3.',
    ].join('\n'))
  })

  it('gives an error and writes nothing when no edit passed', () => {
    expect(editResult(edit([{ old_string: '', new_string: 'x' }, { old_string: 'a', new_string: 'b' }]), 'a\na\n')).toStrictEqual({
      content: [
        'No edit of /apps/notes/main.js was done, and the file did not change.',
        '1. Failed. `old_string` is empty. Give the text to replace; to make a new file, or to give a file all new text, use write.',
        '2. Failed. `old_string` is in the file at 2 places, on lines 1 and 2. '
          + 'Give more of the text around the place to change, so that `old_string` is in the file once, or set `replace_all` to true to change every place.',
      ].join('\n'),
      isError: true,
      bytes: null,
    })
  })

  it('writes nothing when the edits leave the text as it was', () => {
    expect(editResult(edit([{ old_string: 'a', new_string: 'a' }]), 'a\nb\n')).toStrictEqual({
      content: '/apps/notes/main.js did not change: after the edits that were done, its text is the same as before.\n1. Done. No change: `new_string` is the same as `old_string`.',
      isError: false,
      bytes: null,
    })
  })

  it('writes the line ends and the byte order mark of the file back', () => {
    const result = editResult(edit([{ old_string: 'a\nb', new_string: 'A\nB' }]), '\uFEFFa\r\nb\r\n')

    expect(result.bytes).toStrictEqual(textBytes('\uFEFFA\r\nB\r\n'))
  })

  it('refuses edits that make the file larger than 2 MiB', () => {
    const long = 'a'.repeat(APPS_MAX_FILE_BYTES - 10)

    expect(() => editResult(edit([{ old_string: 'a', new_string: long }]), 'a\n')).not.toThrow()
    expect(refusal(() => editResult(edit([{ old_string: 'a', new_string: long }, { old_string: '\n', new_string: `${'b'.repeat(10)}\n` }]), 'a\n')))
      .toBe('With these edits /apps/notes/main.js would have 2,097,153 bytes, and a file is at most 2,097,152 bytes. Dez did not change the file.')
  })

  it('needs an edit, and the path of a file', () => {
    expect(refusal(() => edit([]))).toBe('`edits` is an empty list. Give at least one edit, as in {"edits": [{"old_string": "...", "new_string": "..."}]}.')
    expect(refusal(() => editCall(args('edit', { path: '/apps/notes', edits: [{ old_string: 'a', new_string: 'b' }] }), CONVERSATION_ID))).toContain('is the folder of an app, not a file')
  })

  // The two wrong calls of the issue: line items of another name, and one
  // edit with its fields next to `path`.
  it('refuses calls of other forms with the names of its parameters', () => {
    const refused = (parameters: Record<string, unknown>) => refusal(() => parseSubcommandCall(APPS_TOOL, { command: 'edit', parameters: JSON.stringify(parameters) }))
    const form = ' The parameters go in "parameters" as the text of a JSON object, as in {"command":"edit","parameters":"{\\"path\\":\\"/apps/unit-converter/main.js\\",'
      + '\\"edits\\":[{\\"old_string\\":\\"const factor = 0.3\\",\\"new_string\\":\\"const factor = 0.3048\\"},{\\"old_string\\":\\"feet\\",\\"new_string\\":\\"ft\\",\\"replace_all\\":true}]}"}.'

    expect(refused({ path: '/apps/notes/main.js', edits: [{ from: 'a', to: 'b' }] })).toBe('Item 1 of the parameter "edits" is not valid: an item of "edits" has no parameter "from". '
      + `The parameters of an item of "edits" are: old_string (string, required), new_string (string, required), replace_all (boolean).${form}`)
    expect(refused({ new: 'b', old: 'a', path: '/apps/notes/main.js' })).toBe('apps edit has no parameter "new". '
      + `The parameters of apps edit are: path (string, required), edits (list of objects, required).${form}`)
  })
})

describe('rm', () => {
  const rm = (paths: string[]) => rmCall(args('rm', { paths }), CONVERSATION_ID).paths.map((path) => path.virtual)
  const path = appsPath('/apps/notes/old', 'paths', CONVERSATION_ID)

  it('deletes each path once, and none that goes with a folder of the call', () => {
    expect(rm(['/apps/notes/a.js', '/apps/notes/src/b.js', '/apps/notes/a.js/', '/apps/notes/src', '/apps/notes/srcs/c.js']))
      .toStrictEqual(['/apps/notes/a.js', '/apps/notes/src', '/apps/notes/srcs/c.js'])
    expect(rm(['/apps/notes/a.js', '/apps/notes'])).toStrictEqual(['/apps/notes'])
  })

  it('refuses the whole call for a path that it cannot take', () => {
    expect(refusal(() => rm([]))).toContain('`paths` is an empty list.')
    expect(refusal(() => rm(['/apps/notes/a.js', '/apps/']))).toContain('/apps is the folder of all apps, and rm does not delete it.')
    expect(refusal(() => rm(['/apps/notes/a.js', '/apps/notes/../x']))).toContain('does not resolve')
  })

  it('tells what the delete of a file and of an empty folder did', () => {
    expect(rmStep(path, file(2048))).toStrictEqual({ folder: false, text: 'Deleted the file /apps/notes/old (2 KB).' })
    expect(rmStep(path, folder())).toStrictEqual({ folder: true, text: 'Deleted the empty folder /apps/notes/old.' })
  })

  it('lists what went with a folder', () => {
    expect(rmStep(path, folder({ 'b.js': 1000, lib: null, 'lib/c.js': 24, 'a b.js': 0 }))).toStrictEqual({
      folder: true,
      text: [
        'Deleted the folder /apps/notes/old with the 4 files and folders in it (1 KB):',
        '/apps/notes/old/"a b.js"',
        '/apps/notes/old/b.js',
        '/apps/notes/old/lib/',
        '/apps/notes/old/lib/c.js',
      ].join('\n'),
    })
  })

  it('lists at most 100 paths of a folder', () => {
    const lines = rmStep(path, filled(130)).text.split('\n')
    expect(lines).toHaveLength(102)
    expect(lines.at(-1)).toBe('… and 30 more.')

    const cut = rmStep(path, { ...filled(120), more: true }).text.split('\n')
    expect(cut[0]).toBe('Deleted the folder /apps/notes/old with more than 120 files and folders in it (more than 120 B):')
    expect(cut.at(-1)).toBe('… and more than 20 others.')
    expect(rmStep(path, { ...filled(3), more: true }).text.split('\n')).toHaveLength(4)
  })

  it('fails for a path with nothing, and for a link', () => {
    expect(refusal(() => rmStep(path, MISSING))).toBe('Nothing is at /apps/notes/old.')
    expect(refusal(() => rmStep(path, { ...MISSING, kind: 'other' }))).toContain('which Dez deletes only with its folder')
  })

  it('gives an error only when every path failed', () => {
    const done = { done: true, text: 'Deleted the file /apps/notes/a.js (1 B).' }
    const failed = { done: false, text: 'Nothing is at /apps/notes/b.js.' }

    expect(rmResult([done, failed])).toStrictEqual({
      content: 'Deleted 1 of 2 paths.\n1. Done. Deleted the file /apps/notes/a.js (1 B).\n2. Failed. Nothing is at /apps/notes/b.js.',
      isError: false,
    })
    expect(rmResult([failed])).toStrictEqual({ content: 'Deleted 0 of 1 path.\n1. Failed. Nothing is at /apps/notes/b.js.', isError: true })
  })
})

describe('mv', () => {
  const move = (from: string, to: string) => mvCall(args('mv', { moves: [{ from, to }] }), CONVERSATION_ID).moves[0]
  const facts = (more: Partial<MoveFacts> = {}): MoveFacts => ({ source: file(3), target: MISSING, unit: folder({ lib: null }), ...more })

  it('refuses the whole call for a move that it cannot take', () => {
    expect(refusal(() => mvCall(args('mv', { moves: [] }), CONVERSATION_ID))).toContain('`moves` is an empty list.')
    expect(refusal(() => move('/apps', '/apps/notes/x'))).toBe('/apps is the folder of all apps, and mv does not move it.')
    expect(refusal(() => move('/apps/notes/a.js', '/apps/'))).toContain('`to` is /apps, the folder of all apps. Give the full new path')
    expect(refusal(() => move('/apps/notes/a.js', '/apps/a.js'))).toContain('"a.js" is no name for an app.')
    expect(refusal(() => move('/apps/notes/a.js', '/apps/notes/home/a.js'))).toContain('with the name "home" in its path')
    // A source with such a name can move away.
    expect(() => move('/apps/notes/home/a.js', '/apps/notes/a.js')).not.toThrow()
  })

  it('moves a file to a path in an app, and makes the folder of the path that is missing', () => {
    const step = move('/apps/notes/a.js', '/apps/other/lib/a.js')

    expect(moveStep(step, facts())).toStrictEqual({ folder: null, text: 'Moved /apps/notes/a.js to /apps/other/lib/a.js.' })
    expect(moveStep(step, facts({ unit: folder() })).folder?.file).toBe('apps/other/lib')
    expect(moveStep(move('/apps/notes/a.js', '/apps/other/lib/a/b/a.js'), facts()).folder?.virtual).toBe('/apps/other/lib/a/b')
    expect(moveStep(move('/apps/notes/lib', '/apps/notes/src/lib'), facts({ source: FOLDER })).text).toBe('Moved /apps/notes/lib to /apps/notes/src/lib.')
  })

  it('replaces nothing', () => {
    const step = move('/apps/notes/a.js', '/apps/notes/b.js')

    expect(refusal(() => moveStep(step, facts({ target: file(1) }))))
      .toBe('/apps/notes/b.js is taken: a file is there already, and a move replaces nothing. Delete it with rm first, or give another `to`.')
    expect(refusal(() => moveStep(step, facts({ target: FOLDER })))).toContain('/apps/notes/b.js is taken: a folder is there already')
  })

  it('fails for a move of nothing, to the same path, and into the moved folder', () => {
    expect(refusal(() => moveStep(move('/apps/notes/a.js', '/apps/notes/b.js'), facts({ source: MISSING })))).toBe('Nothing is at /apps/notes/a.js.')
    expect(refusal(() => moveStep(move('/apps/notes/a.js', '/apps/notes/a.js/'), facts()))).toBe('`from` and `to` are the same path, /apps/notes/a.js.')
    expect(refusal(() => moveStep(move('/apps/notes/src', '/apps/notes/src/old/src'), facts({ source: FOLDER }))))
      .toBe('/apps/notes/src/old/src is in /apps/notes/src, and a folder cannot move into itself.')
    expect(refusal(() => moveStep(move('/apps/notes/link', '/apps/notes/b'), facts({ source: { kind: 'other', size: 0 } })))).toContain('which the apps tool does not move')
  })

  it('moves only into an app that is there, and never below a file', () => {
    const step = move('/apps/notes/a.js', '/apps/other/lib/a.js')

    expect(refusal(() => moveStep(step, facts({ unit: MISSING })))).toContain('There is no app /apps/other.')
    expect(refusal(() => moveStep(step, facts({ unit: folder({ lib: 2 }) })))).toBe('/apps/other/lib is a file, so nothing can be in it.')
    expect(refusal(() => moveStep(move('/apps/notes/a.js', '/apps/other/x.js/sub/y.js'), facts({ unit: folder({ 'x.js': 2 }) }))))
      .toBe('/apps/other/x.js is a file, so nothing can be in it.')
  })

  it('renames an app, and makes an app of a folder', () => {
    expect(moveStep(move('/apps/notes', '/apps/journal'), facts({ source: FOLDER })))
      .toStrictEqual({ folder: null, text: 'Renamed the app /apps/notes to /apps/journal. Its manifest.json still has the old name: change "name" in it with edit.' })
    expect(moveStep(move('/apps/notes/tools', '/apps/tools'), facts({ source: FOLDER })).text).toContain('Moved the folder /apps/notes/tools to /apps/tools, where it is an app now.')
    expect(refusal(() => moveStep(move('/apps/notes/a', '/apps/a'), facts()))).toContain('/apps/a would be a file directly in /apps/, where only the folders of apps are.')
  })

  it('moves between /apps and /work, and makes the work folder of the conversation when it is not there', () => {
    expect(moveStep(move('/apps/notes/a.js', '/work/a.js'), facts({ unit: MISSING })))
      .toStrictEqual({ folder: expect.objectContaining({ virtual: '/work', file: `work/${CONVERSATION_ID}` }), text: 'Moved /apps/notes/a.js to /work/a.js.' })
    expect(moveStep(move('/apps/notes/a.js', '/work/x/a.js'), facts({ unit: folder() })).folder?.virtual).toBe('/work/x')
    expect(moveStep(move('/work/tools', '/apps/tools'), facts({ source: FOLDER })).text).toContain('where it is an app now')
    expect(refusal(() => move('/work', '/apps/notes/w'))).toBe('/work is the work folder of this conversation, and mv does not move it.')
    expect(refusal(() => move('/libs/three/x.js', '/work/x.js'))).toContain('/libs/three/x.js: /libs/ holds the libraries that Dez ships, and no call makes, changes, moves, or deletes a file there.')
    expect(refusal(() => move('/work/x.js', '/libs/x.js'))).toContain('/libs/ holds the libraries that Dez ships')
  })

  it('gives an error only when every move failed', () => {
    expect(mvResult([{ done: true, text: 'Moved /apps/a/x to /apps/a/y.' }, { done: false, text: 'Nothing is at /apps/a/z.' }])).toStrictEqual({
      content: 'Did 1 of 2 moves.\n1. Done. Moved /apps/a/x to /apps/a/y.\n2. Failed. Nothing is at /apps/a/z.',
      isError: false,
    })
    expect(mvResult([{ done: false, text: 'Nothing is at /apps/a/z.' }]).isError).toBe(true)
  })
})

describe('mkdir', () => {
  const mkdir = (path: string) => mkdirCall(args('mkdir', { path }), CONVERSATION_ID).path
  const app = folder({ 'manifest.json': 80, data: null, 'notes.txt': 5 })

  it('makes a folder with the folders above it that are missing', () => {
    expect(mkdirStep(mkdir('/apps/notes/data/cache'), MISSING, app)).toStrictEqual({ make: true, text: 'Made the folder /apps/notes/data/cache.' })
    expect(mkdirStep(mkdir('/apps/notes/a/b/c/'), MISSING, app)).toStrictEqual({ make: true, text: 'Made the folder /apps/notes/a/b/c, and above it /apps/notes/a and /apps/notes/a/b.' })
  })

  it('takes a folder that is there already as done', () => {
    expect(mkdirStep(mkdir('/apps/notes/data'), FOLDER, app)).toStrictEqual({ make: false, text: 'The folder /apps/notes/data is there already.' })
  })

  it('makes no folder where a file is, and none in an app that is not there', () => {
    expect(refusal(() => mkdirStep(mkdir('/apps/notes/notes.txt'), file(5), app))).toBe('/apps/notes/notes.txt is a file, so Dez makes no folder there. Give another path.')
    expect(refusal(() => mkdirStep(mkdir('/apps/notes/notes.txt/x'), MISSING, app))).toBe('/apps/notes/notes.txt is a file, so nothing can be in it.')
    expect(refusal(() => mkdirStep(mkdir('/apps/notes/data'), MISSING, MISSING))).toContain('There is no app /apps/notes. Make it with init first')
  })

  it('makes no app, and no folder with a name that Dez would hide', () => {
    expect(refusal(() => mkdir('/apps/notes'))).toContain('/apps/notes is the folder of an app. init makes a new app.')
    expect(refusal(() => mkdir('/apps'))).toContain('/apps is the folder of all apps. init makes a new app.')
    expect(refusal(() => mkdir('/apps/notes/Users/a'))).toContain('with the name "Users" in its path')
  })

  it('counts the new folders against the limit of the app', () => {
    expect(() => mkdirStep(mkdir('/apps/notes/a'), MISSING, filled(APPS_MAX_ENTRIES - 1))).not.toThrow()
    expect(refusal(() => mkdirStep(mkdir('/apps/notes/a/b'), MISSING, filled(APPS_MAX_ENTRIES - 1)))).toContain('this call would add 2')
  })
})

describe('ls', () => {
  const ls = (path: string | undefined, tree: AppsTree) => lsText(lsCall(args('ls', path === undefined ? {} : { path }), CONVERSATION_ID).path, tree)

  it('lists the files and the folders of a folder by name, a folder with what is below it', () => {
    expect(ls('/apps/notes', folder({ 'src/lib/c.js': 1024, 'manifest.json': 80, src: null, 'src/lib': null, 'src/b.js': 2048, 'main.js': 12, empty: null }))).toBe([
      '/apps/notes: 2 folders and 2 files (name | size).',
      'empty/ | 0 files, 0 B',
      'main.js | 12 B',
      'manifest.json | 80 B',
      'src/ | 2 files, 3 KB',
    ].join('\n'))
  })

  it('lists the apps for a call with no path', () => {
    expect(ls(undefined, folder({ notes: null, 'notes/manifest.json': 80, calc: null }))).toBe('/apps: 2 folders and 0 files (name | size).\ncalc/ | 0 files, 0 B\nnotes/ | 1 file, 80 B')
    expect(ls(undefined, MISSING)).toBe('There are no apps yet. Make one with init.')
    expect(ls('/apps/', folder())).toBe('There are no apps yet. Make one with init.')
  })

  it('marks a built-in app in the list of the apps only', () => {
    expect(ls(undefined, folder({ 'dez-media': null, 'dez-media/main.ts': 70, notes: null })).split('\n').slice(1)).toStrictEqual([
      'dez-media/ | 1 file, 70 B | built-in',
      'notes/ | 0 files, 0 B',
    ])
    expect(ls('/apps/notes', folder({ 'dez-x': null })).split('\n')[1]).toBe('dez-x/ | 0 files, 0 B')
  })

  it('tells what is at a path that is no folder', () => {
    expect(ls('/apps/notes/data', folder())).toBe('/apps/notes/data is an empty folder.')
    expect(ls('/apps/notes/main.js', file(12))).toBe('/apps/notes/main.js is a file (12 B), not a folder. read gives its text.')
    expect(refusal(() => ls('/apps/notes', MISSING))).toBe('There is no app /apps/notes. Call list_apps to see the apps that are there.')
    expect(refusal(() => ls('/apps/notes/data', MISSING))).toBe('There is no folder /apps/notes/data. Call ls with "/apps/notes" to see what is there.')
  })

  it('shows a name that no call takes on one line, and tells so', () => {
    expect(ls('/apps/notes', folder({ 'my\nfile.txt': 3, link: 'other' })).split('\n').slice(1)).toStrictEqual([
      'link | a link or a special file',
      '"my\\nfile.txt" | 3 B | a name that the apps tool does not take',
    ])
  })

  it('tells that the numbers of a folder with too many entries are a part', () => {
    const result = ls('/apps/notes', folder({ src: null, 'src/a.js': 5 }, true)).split('\n')

    expect(result[0]).toContain('The folder holds more than 5,000 files and folders at all depths')
    expect(result[1]).toBe('src/ | at least 1 file, 5 B')
  })

  it('lists at most 500 names', () => {
    const result = ls('/apps/notes', filled(520)).split('\n')

    expect(result[0]).toBe('/apps/notes: 0 folders and 520 files (name | size).')
    expect(result).toHaveLength(502)
    expect(result.at(-1)).toBe('… and 20 more.')
  })
})

describe('appsRootTree', () => {
  const paths = (tree: AppsTree) => tree.entries.map((entry) => entry.path)
  const own = folder({ notes: null, 'notes/main.js': 5, 'dez-old': null, 'dez-old/x.js': 1 })
  const builtIn = folder({ 'dez-media': null, 'dez-media/main.ts': 7, stray: null })

  it('lists the apps of the user and the built-in apps, each place with only its own names', () => {
    const tree = appsRootTree(own, builtIn, 10)

    // The entries nearer to the folder come first, as in a native listing.
    expect(paths(tree)).toStrictEqual(['dez-media', 'notes', 'dez-media/main.ts', 'notes/main.js'])
    expect(tree).toMatchObject({ kind: 'folder', more: false })
  })

  it('cuts the entries to the most that the listing asks for, and tells so', () => {
    expect(appsRootTree(own, builtIn, 2)).toMatchObject({ entries: [{ path: 'dez-media' }, { path: 'notes' }], more: true })
    expect(appsRootTree(own, folder({}, true), 10).more).toBe(true)
    expect(appsRootTree(folder({}, true), builtIn, 10).more).toBe(true)
  })

  it('is a folder when one of the two places is there', () => {
    expect(paths(appsRootTree(MISSING, builtIn, 10))).toStrictEqual(['dez-media', 'dez-media/main.ts'])
    expect(appsRootTree(MISSING, builtIn, 10).kind).toBe('folder')
    expect(appsRootTree(own, MISSING, 10).kind).toBe('folder')
    expect(appsRootTree(MISSING, MISSING, 10)).toStrictEqual(MISSING)
  })
})

describe('find', () => {
  const find = (parameters: Record<string, unknown>, tree: AppsTree) => findText(findCall(args('find', parameters), CONVERSATION_ID), tree)
  const APPS = folder({
    'unit-converter': null,
    'unit-converter/manifest.json': 80,
    'unit-converter/src/units.js': 300,
    'unit-converter/src/MainView.vue': 900,
    'unit-converter/data': null,
    notes: null,
    'notes/main.ts': 12,
    'notes/lib/units.ts': 40,
  })

  it('lists every file for "*", sorted by path, each as its path after /apps/', () => {
    expect(find({ query: '*' }, APPS)).toBe([
      '/apps: 5 files (paths after /apps/), by path.',
      'notes/lib/units.ts',
      'notes/main.ts',
      'unit-converter/manifest.json',
      'unit-converter/src/MainView.vue',
      'unit-converter/src/units.js',
    ].join('\n'))
  })

  it('lists the files whose paths match every word of the query, by the rule of the model picker', () => {
    expect(find({ query: 'units' }, APPS)).toBe('/apps: 2 of 5 files match "units" (paths after /apps/), by path.\nnotes/lib/units.ts\nunit-converter/src/units.js')
    // A word can run from a folder into a file name, as starts of words
    // that follow each other.
    expect(find({ query: 'srcunits' }, APPS).split('\n').slice(1)).toStrictEqual(['unit-converter/src/units.js'])
    expect(find({ query: 'ucsmv' }, APPS).split('\n').slice(1)).toStrictEqual(['unit-converter/src/MainView.vue'])
    expect(find({ query: 'lib units' }, APPS).split('\n').slice(1)).toStrictEqual(['notes/lib/units.ts'])
  })

  it('searches only below the folder of `path`, and still matches the path after /apps/', () => {
    const notes = folder({ 'main.ts': 12, lib: null, 'lib/units.ts': 40 })

    expect(find({ query: 'notes units', path: '/apps/notes' }, notes)).toBe('/apps/notes: 1 of 2 files matches "notes units" (paths after /apps/), by path.\nnotes/lib/units.ts')
  })

  it('tells when no file matches, and when there is no file', () => {
    expect(find({ query: 'zzz' }, APPS)).toBe('No file in /apps matches "zzz" (5 files searched). Give fewer or shorter words, or "*" to list every file.')
    expect(find({ query: '*', path: '/apps/notes/data' }, folder({ cache: null }))).toBe('/apps/notes/data has no files.')
    expect(find({ query: '*' }, MISSING)).toBe('There are no apps yet. Make one with init.')
    expect(find({ query: '*' }, folder())).toBe('There are no apps yet. Make one with init.')
  })

  it('refuses a path where no folder is', () => {
    expect(refusal(() => find({ query: '*', path: '/apps/notes' }, MISSING))).toBe('There is no app /apps/notes. Call list_apps to see the apps that are there.')
    expect(refusal(() => find({ query: '*', path: '/apps/notes/lib' }, MISSING))).toBe('There is no folder /apps/notes/lib. Call ls with "/apps/notes" to see what is there.')
    expect(refusal(() => find({ query: 'x', path: '/apps/notes/main.ts' }, file(12))))
      .toBe('/apps/notes/main.ts is a file, not a folder: find searches the files below a folder. Give a folder in `path`, as in "/apps/notes".')
  })

  it('shows a path that no call takes on one line, and tells so', () => {
    expect(find({ query: 'file' }, folder({ 'notes/my\nfile.txt': 3 })).split('\n').slice(1)).toStrictEqual(['"notes/my\\nfile.txt" (a path that the apps tool does not take)'])
  })

  it('lists at most 300 paths, and tells when the listing of the folder was cut', () => {
    const result = find({ query: 'txt', path: '/apps/notes' }, filled(320)).split('\n')

    expect(result[0]).toBe('/apps/notes: 320 of 320 files match "txt" (paths after /apps/), by path.')
    expect(result).toHaveLength(302)
    expect(result.at(-1)).toBe('… and 20 more. Give more words, or a folder in `path`, to get a shorter list.')
    expect(find({ query: '*' }, folder({ 'notes/a.js': 5 }, true)).split('\n')[0])
      .toBe('/apps: 1 file (paths after /apps/), by path. The folder holds more than 5,000 files and folders at all depths, so find searched only a part of them: search the folders in it one by one.')
  })
})

describe('wc', () => {
  const wc = (paths: unknown[]) => wcCall(args('wc', { paths }), CONVERSATION_ID).paths.map((path) => path.virtual)
  const path = appsPath('/apps/notes/main.js', 'paths', CONVERSATION_ID)
  const row = (content: string | Uint8Array) => wcRowOfBytes(path, typeof content === 'string' ? textBytes(content) : content)

  it('counts the paths in the order of the call, a repeated path once for each time', () => {
    expect(wc(['/apps/notes/b.js', '/apps/notes/a.js', '/apps/notes/b.js/'])).toStrictEqual(['/apps/notes/b.js', '/apps/notes/a.js', '/apps/notes/b.js'])
    expect(wc(Array.from({ length: 100 }, (_, index) => `/apps/notes/${index}.js`))).toHaveLength(100)
  })

  it('refuses the whole call for an empty list, for too many paths, and for a path that it cannot take', () => {
    expect(refusal(() => wc([]))).toBe('`paths` is an empty list. Give the files to count, as in {"paths": ["/apps/unit-converter/main.js"]}.')
    expect(refusal(() => wc(Array.from({ length: 101 }, (_, index) => `/apps/notes/${index}.js`))))
      .toBe('`paths` has 101 paths, and wc counts at most 100 files in one call. Call wc again for the rest.')
    expect(refusal(() => wc(['/apps/notes/a.js', '/apps/notes/../x']))).toContain('does not resolve')
  })

  it('counts the lines as read does: a line end at the end of a file adds no line', () => {
    expect(row('a\nb\n')).toBe('/apps/notes/main.js | 2 lines | 4 B')
    expect(row('a\nb')).toBe('/apps/notes/main.js | 2 lines | 3 B')
    expect(row('\n')).toBe('/apps/notes/main.js | 1 line | 1 B')
    expect(row('')).toBe('/apps/notes/main.js | 0 lines | 0 B')
  })

  it('gives only the size of a file that read does not take', () => {
    expect(row(new Uint8Array([0x61, 0x00, 0x62]))).toBe('/apps/notes/main.js | not counted: no text file | 3 B')
    expect(row(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff]))).toBe('/apps/notes/main.js | not counted: no text file | 5 B')

    expect(wcRowOfFacts(path, file(APPS_MAX_FILE_BYTES))).toBeNull()
    expect(wcRowOfFacts(path, file(APPS_MAX_FILE_BYTES + 1))).toBe('/apps/notes/main.js | not counted: more than 2,097,152 bytes | 2,097,153 bytes')
    expect(wcRowOfFacts(path, file(3 * APPS_MAX_FILE_BYTES))).toBe('/apps/notes/main.js | not counted: more than 2.0 MB | 6.0 MB')
    // A file that grew after its size check.
    expect(row(new Uint8Array(APPS_MAX_FILE_BYTES + 1).fill(0x61))).toBe('/apps/notes/main.js | not counted: more than 2,097,152 bytes | 2,097,153 bytes')
  })

  it('fails for a path where no plain file is', () => {
    expect(refusal(() => wcRowOfFacts(path, MISSING))).toBe('There is no file /apps/notes/main.js. Call ls to see the files of its folder, as in {"path": "/apps/notes"}.')
    expect(refusal(() => wcRowOfFacts(path, FOLDER))).toBe('/apps/notes/main.js is a folder, not a file. Call ls to see what is in it.')
    expect(refusal(() => wcRowOfFacts(path, { kind: 'other', size: 0 }))).toBe('/apps/notes/main.js is a link or a special file, and the apps tool opens plain files only.')
  })

  it('tells each path that failed after the rows, and gives an error only when every path failed', () => {
    const counted = (name: string) => ({ done: true, text: `/apps/notes/${name} | 1 line | 2 B` })
    const failed = (name: string) => ({ done: false, text: `There is no file /apps/notes/${name}.` })

    expect(wcResult([counted('a.js'), failed('b.js'), counted('c.js')])).toStrictEqual({
      content: [
        '2 files (path | lines | size).',
        '/apps/notes/a.js | 1 line | 2 B',
        '/apps/notes/c.js | 1 line | 2 B',
        'Path 2 is left out. There is no file /apps/notes/b.js.',
      ].join('\n'),
      isError: false,
    })
    expect(wcResult([counted('a.js')])).toStrictEqual({ content: '1 file (path | lines | size).\n/apps/notes/a.js | 1 line | 2 B', isError: false })
    expect(wcResult([failed('a.js')])).toStrictEqual({ content: 'There is no file /apps/notes/a.js.', isError: true })
    expect(wcResult([failed('a.js'), failed('b.js')])).toStrictEqual({
      content: 'Path 1 is left out. There is no file /apps/notes/a.js.\nPath 2 is left out. There is no file /apps/notes/b.js.',
      isError: true,
    })
  })
})

describe('list_apps', () => {
  const manifest = (kind: string, description: string) => textBytes(JSON.stringify({ name: 'x', description, kind }))
  const app = (name: string, size: number, manifestBytes: Uint8Array | null = manifest('ui', `The ${name} app.`)): ListedApp => ({
    name,
    tree: folder({ ...(manifestBytes ? { 'manifest.json': manifestBytes.length } : {}), 'main.js': size }),
    manifest: manifestBytes,
  })
  const list = (parameters: Record<string, unknown>, apps: ListedApp[]) => listAppsText(listAppsCall(args('list_apps', parameters)), apps)
  // The sizes of the apps with their manifests: 2 KB, 1.0 MB, 3 KB.
  const APPS = [app('notes', 2000), app('Calc', 1024 * 1024), app('converter', 3000, manifest('script', 'Converts | units.\nFast.'))]

  it('lists every app by name, with the facts of its manifest', () => {
    expect(list({}, APPS)).toBe([
      '3 apps (name | kind | size | description), by name.',
      'Calc | ui | 1.0 MB | The Calc app.',
      'converter | script | 3 KB | Converts / units. Fast.',
      'notes | ui | 2 KB | The notes app.',
    ].join('\n'))
  })

  it('sorts by size', () => {
    const names = (sort: string) => list({ sort }, APPS).split('\n').slice(1).map((row) => row.split(' | ')[0])

    expect(names('largest')).toStrictEqual(['Calc', 'converter', 'notes'])
    expect(names('SMALLEST')).toStrictEqual(['notes', 'converter', 'Calc'])
    expect(list({ sort: 'largest' }, APPS).split('\n')[0]).toBe('3 apps (name | kind | size | description), the largest first.')
    expect(refusal(() => list({ sort: 'newest' }, APPS))).toBe('Unknown value "newest" in `sort`. Use one of: name, largest, smallest.')
  })

  it('selects by a part of the name and by size', () => {
    expect(list({ name: 'C' }, APPS).split('\n')).toStrictEqual([
      '2 of 3 apps match `name` "c" (name | kind | size | description), by name.',
      'Calc | ui | 1.0 MB | The Calc app.',
      'converter | script | 3 KB | Converts / units. Fast.',
    ])
    expect(list({ min_bytes: 2500, max_bytes: 5000 }, APPS).split('\n')).toStrictEqual([
      '1 of 3 apps matches `min_bytes` 2500 and `max_bytes` 5000 (name | kind | size | description), by name.',
      'converter | script | 3 KB | Converts / units. Fast.',
    ])
    expect(list({ name: 'zzz' }, APPS)).toBe('No app matches `name` "zzz". /apps/ has 3 apps: call list_apps with no parameters to list them all.')
  })

  it('refuses sizes that select nothing', () => {
    expect(refusal(() => list({ min_bytes: -1 }, APPS))).toBe('`min_bytes` is -1. Give a size in bytes, from 0 on.')
    expect(refusal(() => list({ min_bytes: 10, max_bytes: 9 }, APPS))).toBe('`max_bytes` (9) is less than `min_bytes` (10), so no app can match.')
  })

  it('lists an app whose manifest Dez cannot read, so that a model can repair it', () => {
    const rows = list({}, [
      app('bare', 10, null),
      app('broken', 10, textBytes('{ "name": ')),
      app('odd', 10, manifest('game', 'x')),
      { name: 'huge', tree: folder({ 'manifest.json': MANIFEST_MAX_BYTES + 1 }), manifest: null },
      app('blank', 10, manifest('ui', '  ')),
    ]).split('\n').slice(1)

    expect(rows).toStrictEqual([
      'bare | ? | 10 B | (no manifest.json)',
      'blank | ui | 53 B | (no description)',
      'broken | ? | 20 B | (a manifest.json that is not valid: it needs "name", "description", and "kind", which is "script" or "ui")',
      'huge | ? | 16 KB | (a manifest.json that Dez does not read: it is no plain file of at most 16 KB)',
      'odd | ? | 54 B | (a manifest.json that is not valid: it needs "name", "description", and "kind", which is "script" or "ui")',
    ])
  })

  it('reads only a manifest that is a plain file of at most 16 KiB', () => {
    expect(hasReadableManifest(folder({ 'manifest.json': MANIFEST_MAX_BYTES }))).toBe(true)
    expect(hasReadableManifest(folder({ 'manifest.json': MANIFEST_MAX_BYTES + 1 }))).toBe(false)
    expect(hasReadableManifest(folder({ 'manifest.json': null }))).toBe(false)
    expect(hasReadableManifest(folder({ 'manifest.json': 'other' }))).toBe(false)
    expect(hasReadableManifest(folder({ 'src/manifest.json': 10 }))).toBe(false)
  })

  it('tells that the size of an app with too many files is a part', () => {
    expect(list({}, [{ name: 'big', tree: folder({ 'a.bin': 2048 }, true), manifest: null }]).split('\n')[1]).toBe('big | ? | more than 2 KB | (no manifest.json)')
  })

  it('marks a built-in app after its kind', () => {
    expect(list({}, [app('notes', 10), app('dez-media', 10, manifest('script', 'Edits media.'))]).split('\n').slice(1)).toStrictEqual([
      'dez-media | script (built-in) | 67 B | Edits media.',
      'notes | ui | 65 B | The notes app.',
    ])
  })

  it('tells that there are no apps', () => {
    expect(list({}, [])).toBe('There are no apps yet. Make one with init.')
    expect(list({ name: 'x' }, [{ name: 'gone', tree: MISSING, manifest: null }])).toBe('There are no apps yet. Make one with init.')
  })
})
