import { describe, expect, it } from 'vitest'
import { MANIFEST_MAX_BYTES, parseAppManifest } from './appManifest'
import { invokeCall } from './appInvoke'
import { showCall } from './appShow'
import {
  APPS_MAX_BYTES,
  APPS_MAX_ENTRIES,
  APPS_MAX_FILE_BYTES,
  APPS_TOOL,
  APPS_TOOL_DEFINITION,
  appsPath,
  checkAppRoom,
  checkInitTarget,
  checkTextFile,
  editCall,
  editResult,
  fileText,
  hasReadableManifest,
  initCall,
  initText,
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
  writeCall,
  writePlan,
  writeText,
  type AppsTree,
  type ListedApp,
  type MoveFacts,
} from './appsTool'
import { checkArgumentValues } from './arguments'
import { parseSubcommandCall } from './subcommands'
import { appsArgs as args, CONVERSATION, fileTree as file, FOLDER_FACTS as FOLDER, folderTree as folder, MISSING_TREE as MISSING, refusal, textBytes } from './testing'
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
      ['read', ['path', 'from_line', 'to_line']],
      ['write', ['path', 'content']],
      ['edit', ['path', 'edits']],
      ['rm', ['paths']],
      ['list_apps', ['name', 'min_bytes', 'max_bytes', 'sort']],
      ['ls', ['path']],
      ['mkdir', ['path']],
      ['mv', ['moves']],
      ['show', ['name']],
      ['invoke', ['name', 'parameters', 'inputs', 'is_intermediate', 'timeout_seconds']],
    ])
  })

  it('gives each subcommand an example that its parameters and its checks take', () => {
    const checks: Record<string, (call: SubcommandArguments) => unknown> = {
      init: initCall, read: readCall, write: writeCall, edit: editCall, rm: rmCall, list_apps: listAppsCall, ls: lsCall, mkdir: mkdirCall, mv: mvCall,
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
  it('reads a path below /apps, with or without a "/" at its end', () => {
    expect(appsPath('/apps', 'path')).toStrictEqual({ names: [], virtual: '/apps', file: 'apps' })
    expect(appsPath('/apps/', 'path')).toStrictEqual({ names: [], virtual: '/apps', file: 'apps' })
    expect(appsPath(' /apps/notes/ ', 'path')).toStrictEqual({ names: ['notes'], virtual: '/apps/notes', file: 'apps/notes' })
    expect(appsPath('/apps/notes/src/main.js', 'path')).toStrictEqual({ names: ['notes', 'src', 'main.js'], virtual: '/apps/notes/src/main.js', file: 'apps/notes/src/main.js' })
  })

  it('refuses a path that is not below /apps', () => {
    const form = 'Every path starts with /apps/, as in "/apps/unit-converter/main.js".'

    expect(refusal(() => appsPath('', 'from'))).toBe(`\`from\` is empty. ${form}`)
    expect(refusal(() => appsPath(7, 'from'))).toBe(`\`from\` is empty. ${form}`)
    for (const path of ['notes/main.js', '/home/u/.config/dez/apps/notes/main.js', '/appsx/notes', 'apps/notes', '~/apps/notes']) {
      expect(refusal(() => appsPath(path, 'path')), path).toBe(`${JSON.stringify(path)} is no path of the apps tool. ${form}`)
    }
  })

  it('refuses "." and "..", and does not resolve them', () => {
    for (const path of ['/apps/notes/../other/main.js', '/apps/..', '/apps/notes/./main.js']) {
      expect(refusal(() => appsPath(path, 'path')), path).toContain('which the apps tool does not resolve')
    }
  })

  it('refuses a name that the file commands of Dez do not take', () => {
    for (const path of ['/apps/notes/my file.js', '/apps/notes/caf\u00e9.js', '/apps/notes/a\\b', '/apps/notes/a:b', '/apps/notes/x\n.js', '/apps/notes/*']) {
      expect(refusal(() => appsPath(path, 'path')), path).toContain('The name of a file or a folder has only ASCII letters, digits, "-", "_", and ".".')
    }
    expect(refusal(() => appsPath('/apps//notes', 'path'))).toContain('has an empty name')
    expect(refusal(() => appsPath('/apps/notes//', 'path'))).toContain('has an empty name')
  })

  it('refuses a name and a path that are too long', () => {
    expect(appsPath(`/apps/notes/${'a'.repeat(100)}`, 'path').names[1]).toHaveLength(100)
    expect(refusal(() => appsPath(`/apps/notes/${'a'.repeat(101)}`, 'path'))).toContain('holds a name of 101 characters, and a name has at most 100.')

    const deep = (count: number) => `/apps/${Array.from({ length: count }, () => 'a').join('/')}`
    expect(appsPath(deep(12), 'path').names).toHaveLength(12)
    expect(refusal(() => appsPath(deep(13), 'path'))).toContain('has 13 names after /apps/, and a path has at most 12.')
  })
})

describe('checkAppRoom', () => {
  const app = appsPath('/apps/notes', 'path')

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

    expect(call.app).toStrictEqual({ names: ['notes'], virtual: '/apps/notes', file: 'apps/notes' })
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
    // Dez's client script is first, so that it sees a key before the code
    // of the app does. The script of the app loads with `crossorigin`: the
    // webview hides the errors of any other script file from the page.
    expect(page).toContain('<script src="~dez.js"></script>\n  <script src="main.js" crossorigin></script>')
    expect(page).toContain('<link rel="stylesheet" href="style.css">')
    // Every script tag loads a file, and no tag has code in an attribute.
    expect(page).not.toMatch(/<script(?![^>]*\ssrc=)/)
    expect(page).not.toMatch(/\son[a-z]+\s*=|<style|javascript:/i)
    expect(initText(call)).toContain('Made the UI app /apps/unit-converter with 4 files:')
  })

  it('refuses a name that is no name of an app', () => {
    const rule = 'The name of an app is 1 to 64 characters: lower-case letters, digits, "-", and "_", and the first one is a letter or a digit, as in "unit-converter".'
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

describe('read', () => {
  const path = appsPath('/apps/notes/main.js', 'path')
  const read = (parameters: Record<string, unknown>, content: string) => readText(readCall(args('read', { path: path.virtual, ...parameters })), content, textBytes(content).length)

  it('gives each line after its number, under the facts of the file', () => {
    expect(read({}, 'const a = 1\n\n  return a\n')).toBe([
      '/apps/notes/main.js: lines 1-3 of 3 (24 B)',
      '1: const a = 1',
      '2: ',
      '3:   return a',
    ].join('\n'))
    expect(read({}, 'one line, no line end')).toBe('/apps/notes/main.js: line 1 of 1 (21 B)\n1: one line, no line end')
  })

  it('gives the lines of a range, and ends it at the end of the file', () => {
    const content = 'a\nb\nc\nd\n'

    expect(read({ from_line: 2, to_line: 3 }, content)).toBe('/apps/notes/main.js: lines 2-3 of 4 (8 B)\n2: b\n3: c')
    expect(read({ from_line: 4 }, content)).toBe('/apps/notes/main.js: line 4 of 4 (8 B)\n4: d')
    expect(read({ from_line: 3, to_line: 90 }, content)).toBe('/apps/notes/main.js: lines 3-4 of 4 (8 B)\n3: c\n4: d')
  })

  it('refuses a range that the file does not have', () => {
    expect(refusal(() => read({ from_line: 5 }, 'a\nb\nc\nd\n'))).toBe('`from_line` is 5, and /apps/notes/main.js has 4 lines.')
    expect(refusal(() => read({ from_line: 0 }, 'a\n'))).toBe('`from_line` is 0. The first line of a file is line 1.')
    expect(refusal(() => read({ from_line: 3, to_line: 2 }, 'a\n'))).toContain('`to_line` (2) is before `from_line` (3).')
  })

  it('tells that a file is empty', () => {
    expect(read({}, '')).toBe('/apps/notes/main.js is an empty file.')
    expect(refusal(() => read({ from_line: 2 }, ''))).toBe('`from_line` is 2, and /apps/notes/main.js is an empty file.')
  })

  it('gives at most 900 lines, and tells where to read on', () => {
    const result = read({}, 'x\n'.repeat(1000)).split('\n')

    expect(result[0]).toBe('/apps/notes/main.js: lines 1-900 of 1000 (2 KB)')
    expect(result).toHaveLength(902)
    expect(result[900]).toBe('900: x')
    expect(result[901]).toBe('Not shown: lines 901-1000. One call gives at most 900 lines and 50,000 characters: call read again with "from_line": 901 for the next ones.')
  })

  it('names as not shown only the lines that the call asked for', () => {
    const result = read({ from_line: 50, to_line: 960 }, 'x\n'.repeat(1000)).split('\n')

    expect(result[0]).toBe('/apps/notes/main.js: lines 50-949 of 1000 (2 KB)')
    expect(result.at(-1)).toContain('Not shown: lines 950-960.')
  })

  it('gives at most 50,000 characters', () => {
    const result = read({}, `${'y'.repeat(1000)}\n`.repeat(100)).split('\n')

    expect(result[0]).toBe('/apps/notes/main.js: lines 1-49 of 100 (98 KB)')
    expect(result.at(-1)).toContain('Not shown: lines 50-100.')
    expect(result.at(-1)).toContain('"from_line": 50')
    expect(result.join('\n').length).toBeLessThan(51_000)
  })

  it('gives the start of a line that is longer than a whole result', () => {
    const result = read({}, `${'z'.repeat(60_000)}\nsecond\n`).split('\n')

    expect(result[0]).toBe('/apps/notes/main.js: line 1 of 2 (59 KB)')
    expect(result[1]).toBe(`1: ${'z'.repeat(49_997)}…`)
    expect(result.slice(2)).toStrictEqual([
      'Line 1 has 60,000 characters, and only its start shows.',
      'Not shown: line 2. One call gives at most 900 lines and 50,000 characters: call read again with "from_line": 2 for the next ones.',
    ])
  })

  it('takes the path of a file only', () => {
    expect(refusal(() => readCall(args('read', { path: '/apps' })))).toContain('/apps is the folder of all apps, not a file.')
    expect(refusal(() => readCall(args('read', { path: '/apps/notes' })))).toContain('/apps/notes is the folder of an app, not a file.')
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
  const write = (path: string, content = 'a\nb\n') => writeCall(args('write', { path, content }))
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
  const edit = (edits: unknown[]) => editCall(args('edit', { path: '/apps/notes/main.js', edits }))

  it('does the edits that pass, and tells what each one did with a diff', () => {
    const result = editResult(edit([
      { from_line: 1, text: 'const a = 2' },
      { from_line: 7, text: 'x' },
      { after_line: 3, text: 'done()\n' },
    ]), 'const a = 1\nrun(a)\nlog(a)\n')

    expect(text(result.bytes)).toBe('const a = 2\nrun(a)\nlog(a)\ndone()\n')
    expect(result.isError).toBe(false)
    expect(result.content).toBe([
      'Edited /apps/notes/main.js: 2 of 3 edits done. The file had 3 lines, and it has 4 now.',
      '1. Done. Replaced line 1 with 1 line.',
      '2. Failed. It names line 7, and the file has 3 lines.',
      '3. Done. Put 1 line in after line 3.',
      'The lines have new numbers now: read the file again before the next edit of it.',
      'The change:',
      '@@ -1,3 +1,4 @@',
      '-const a = 1',
      '+const a = 2',
      ' run(a)',
      ' log(a)',
      '+done()',
    ].join('\n'))
  })

  it('keeps the line end, or none, after the last line', () => {
    const edits = edit([{ from_line: 2, text: 'B' }])

    expect(text(editResult(edits, 'a\nb\n').bytes)).toBe('a\nB\n')
    expect(text(editResult(edits, 'a\nb').bytes)).toBe('a\nB')
    expect(text(editResult(edit([{ after_line: 0, text: 'first' }]), '').bytes)).toBe('first\n')
    expect(text(editResult(edit([{ from_line: 1, to_line: 2, text: '' }]), 'a\nb\n').bytes)).toBe('')
  })

  it('gives an error and writes nothing when no edit passed', () => {
    expect(editResult(edit([{ from_line: 9, text: 'x' }, { after_line: 9, text: 'y' }]), 'a\n')).toStrictEqual({
      content: [
        'No edit of /apps/notes/main.js was done, and the file did not change.',
        '1. Failed. It names line 9, and the file has 1 line.',
        '2. Failed. `after_line` is 9, and the file has 1 line.',
      ].join('\n'),
      isError: true,
      bytes: null,
    })
  })

  it('writes nothing when the lines had the new text already', () => {
    expect(editResult(edit([{ from_line: 1, text: 'a' }]), 'a\nb\n')).toStrictEqual({
      content: '/apps/notes/main.js did not change: the lines had the new text already.\n1. Done. No change: line 1 had this text already.',
      isError: false,
      bytes: null,
    })
  })

  it('refuses edits that make the file larger than 2 MiB', () => {
    const long = 'a'.repeat(APPS_MAX_FILE_BYTES - 10)

    expect(() => editResult(edit([{ from_line: 1, text: long }]), 'a\n')).not.toThrow()
    expect(refusal(() => editResult(edit([{ after_line: 1, text: long }, { after_line: 1, text: 'b'.repeat(10) }]), 'a\n')))
      .toBe('With these edits /apps/notes/main.js would have 2,097,156 bytes, and a file is at most 2,097,152 bytes. Dez did not change the file.')
  })

  it('cuts a long diff, and still writes the whole file', () => {
    const lines = Array.from({ length: 400 }, (_, index) => `line ${index + 1} ${'-'.repeat(90)}`)
    const result = editResult(edit([{ from_line: 1, to_line: 400, text: lines.map((line) => `${line}!`).join('\n') }]), `${lines.join('\n')}\n`)

    const shown = result.content.split('\n')
    expect(shown.at(-1)).toMatch(/^… [\d,]+ more lines of the diff are not shown\. read gives the file as it is now\.$/)
    expect(result.content.length).toBeLessThan(21_000)
    expect(text(result.bytes)?.split('\n')).toHaveLength(401)
  })

  it('needs an edit, and the path of a file', () => {
    expect(refusal(() => edit([]))).toContain('`edits` is an empty list.')
    expect(refusal(() => editCall(args('edit', { path: '/apps/notes', edits: [{ from_line: 1, text: '' }] })))).toContain('is the folder of an app, not a file')
  })
})

describe('rm', () => {
  const rm = (paths: string[]) => rmCall(args('rm', { paths })).paths.map((path) => path.virtual)
  const path = appsPath('/apps/notes/old', 'paths')

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
  const move = (from: string, to: string) => mvCall(args('mv', { moves: [{ from, to }] })).moves[0]
  const facts = (more: Partial<MoveFacts> = {}): MoveFacts => ({ source: file(3), target: MISSING, app: folder({ lib: null }), ...more })

  it('refuses the whole call for a move that it cannot take', () => {
    expect(refusal(() => mvCall(args('mv', { moves: [] })))).toContain('`moves` is an empty list.')
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
    expect(moveStep(step, facts({ app: folder() })).folder?.file).toBe('apps/other/lib')
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

    expect(refusal(() => moveStep(step, facts({ app: MISSING })))).toContain('There is no app /apps/other.')
    expect(refusal(() => moveStep(step, facts({ app: folder({ lib: 2 }) })))).toBe('/apps/other/lib is a file, so nothing can be in it.')
    expect(refusal(() => moveStep(move('/apps/notes/a.js', '/apps/other/x.js/sub/y.js'), facts({ app: folder({ 'x.js': 2 }) }))))
      .toBe('/apps/other/x.js is a file, so nothing can be in it.')
  })

  it('renames an app, and makes an app of a folder', () => {
    expect(moveStep(move('/apps/notes', '/apps/journal'), facts({ source: FOLDER })))
      .toStrictEqual({ folder: null, text: 'Renamed the app /apps/notes to /apps/journal. Its manifest.json still has the old name: change "name" in it with edit.' })
    expect(moveStep(move('/apps/notes/tools', '/apps/tools'), facts({ source: FOLDER })).text).toContain('Moved the folder /apps/notes/tools to /apps/tools, where it is an app now.')
    expect(refusal(() => moveStep(move('/apps/notes/a', '/apps/a'), facts()))).toContain('/apps/a would be a file directly in /apps/, where only the folders of apps are.')
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
  const mkdir = (path: string) => mkdirCall(args('mkdir', { path })).path
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
  const ls = (path: string | undefined, tree: AppsTree) => lsText(lsCall(args('ls', path === undefined ? {} : { path })).path, tree)

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

  it('tells that there are no apps', () => {
    expect(list({}, [])).toBe('There are no apps yet. Make one with init.')
    expect(list({ name: 'x' }, [{ name: 'gone', tree: MISSING, manifest: null }])).toBe('There are no apps yet. Make one with init.')
  })
})
