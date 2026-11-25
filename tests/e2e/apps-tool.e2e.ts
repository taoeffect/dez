import fs from 'node:fs'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { appTagText } from '../../src/model/chat/appTags'
import { appManifestText, parseAppManifest } from '../../src/model/tools/appManifest'
import { showResultText } from '../../src/model/tools/appShow'
import { grepTimeoutError } from '../../src/model/tools/appsGrep'
import { APPS_MAX_FILE_BYTES } from '../../src/model/tools/appsTool'
import { GREP_TIME_LIMIT_SECONDS } from '../../src/model/tools/grepMatch'
import { byteSizeText } from '../../src/utils/byteSize'
import { appsCall, seedApp, shownAppCards, type ShownAppCard } from './harness/apps'
import { consoleErrors, resetConsoleErrors, screenshotOnFailure, waitForValue } from './harness/dom'
import { linkedDropDir } from './harness/drops'
import { appFilePath, conversationFilePath, filesIn, writeTestFile } from './harness/fixtures'
import { startMockProviderApp, takeRequest, type MockProviderApp } from './harness/mockProviderApp'
import { mockChatPath, replyText, requestMessages, sendChatReply, sendToolCalls, toolResult, type HeldRequest, type MockProvider } from './harness/mockServer'
import type { E2EBrowser } from './harness/session'
import { activeConversationId, endedReply, newTab, openToasts, submit } from './harness/thread'

// The `apps` tool, driven through the real app against a mock chat model in
// this process. The calls work on the real folder `apps/` of the test HOME,
// through the file commands of the backend:
// - a model makes an app, and writes, reads, edits, moves, lists, and
//   deletes its files; only the user can open what the tool made;
// - the lists of /apps hold the built-in apps that the build ships, with
//   their mark, also after the delete of the last app of the user;
// - a model reads ranges of the lines of a file, and edits a file by find
//   and replace: a list of edits that pass or fail each by itself, and
//   calls of other forms that Dez refuses with the name of the wrong
//   parameter;
// - a model finds files by their paths, and lines by a regular
//   expression; the matching runs in a worker, so the window answers
//   while a slow pattern runs, and Dez ends it at its time limit;
// - a model counts the lines and the bytes of files;
// - a model shows a UI app: Dez writes the tag of the app into the reply,
//   the editor draws it as a card, and a request tells of the app only in
//   the result of the call;
// - the tool opens, changes, and moves nothing through a link that is in
//   the folder of an app, so a call never reaches a file of the computer
//   that is not in that folder, and the delete of an app leaves the file
//   that a link names.
// No request holds a path of the test HOME (`takeRequest` checks each one).
//
// One app session serves the whole file; each test starts in a new tab.

const CALLER: MockProvider = { id: 'caller', name: 'Caller Mock', modelId: 'caller-model', modelName: 'Caller Model' }
const CHAT_PATH = mockChatPath(CALLER)

// The built-in apps that the debug build ships (src-tauri/builtin-apps/),
// by name: each listing of /apps has them besides the apps of a test. An
// app is a folder of files, with no folder in it.
const BUILT_IN_DIR = new URL('../../src-tauri/builtin-apps/', import.meta.url)
const BUILT_IN_APPS = fs.readdirSync(BUILT_IN_DIR).sort().map((name) => {
  const folder = new URL(`${name}/`, BUILT_IN_DIR)
  const files = fs.readdirSync(folder).sort()
  const manifest = parseAppManifest(fs.readFileSync(new URL('manifest.json', folder), 'utf8'))
  if (!manifest) throw new Error(`The manifest of the built-in app ${name} is not valid.`)
  return {
    name,
    files: files.map((file) => `${name}/${file}`),
    bytes: files.reduce((sum, file) => sum + fs.statSync(new URL(file, folder)).size, 0),
    kind: manifest.kind,
    description: manifest.description,
  }
})
const BUILT_IN_FILES = BUILT_IN_APPS.flatMap((app) => app.files)

describe('apps tool', () => {
  let setup: MockProviderApp
  let browser: E2EBrowser
  let appsDir: string
  // A folder that is not in the test HOME, for the file that a link names.
  let outsideDir: string

  const chatRequest = (): Promise<HeldRequest> => takeRequest(setup, CHAT_PATH)

  // Whether `request` sends the tag of an app as a part of the
  // conversation.
  const sendsAppTag = (request: HeldRequest): boolean => JSON.stringify(requestMessages(request)).includes('dez:app')

  // The rights of the file or the folder at `relative`, a path in the
  // folder of the apps.
  const modeOf = (relative: string): number => fs.statSync(path.join(appsDir, relative)).mode & 0o777

  // Answers `request` with the last text of the reply, and checks that the
  // reply ended after the blocks of its calls with no error toast.
  async function expectReplyEnd (request: HeldRequest): Promise<void> {
    await sendChatReply(request.reply, CALLER.modelName)
    expect((await endedReply(browser)).endsWith(`</dez:tool>\n${replyText(CALLER.modelName)}`)).toBe(true)
    expect(setup.mock.hasWaitingRequest()).toBe(false)
    expect(await openToasts(browser, 'error')).toStrictEqual([])
  }

  beforeAll(async () => {
    outsideDir = await linkedDropDir('apps-tool')
    setup = await startMockProviderApp(CALLER)
    browser = setup.browser
    appsDir = appFilePath(setup.app.home, 'apps')
  })

  beforeEach(async () => {
    await newTab(browser)
    await resetConsoleErrors(browser)
  })

  afterEach(async (ctx) => {
    await screenshotOnFailure(browser, ctx)
    await setup.mock.dropOpenReplies(browser)
  })

  afterAll(async () => {
    await setup?.stop()
    if (outsideDir) await fs.promises.rm(outsideDir, { recursive: true, force: true })
  })

  it('makes an app, and reads, changes, moves, lists, and deletes its files', async () => {
    const units = 'export const KM = 1000\nexport const M = 1\n'
    await submit(browser, 'Make a notes app.')
    const first = await chatRequest()
    sendToolCalls(first.reply, [
      appsCall('call_init', 'init', { name: 'notes', kind: 'script', description: 'Keeps notes.' }),
      appsCall('call_write', 'write', { path: '/apps/notes/src/lib/units.js', content: units }),
      appsCall('call_mkdir', 'mkdir', { path: '/apps/notes/data/cache' }),
      appsCall('call_read', 'read', { path: '/apps/notes/src/lib/units.js' }),
      appsCall('call_edit', 'edit', { path: '/apps/notes/src/lib/units.js', edits: [{ old_string: 'export const M = 1\n', new_string: 'export const M = 1\nexport const CM = 0.01\n' }] }),
    ])

    const second = await chatRequest()
    expect(toolResult(second, 'call_init')).toBe('Made the script app /apps/notes with 2 files:\n/apps/notes/manifest.json\n/apps/notes/main.ts\nChange them with read, edit, and write.')
    expect(toolResult(second, 'call_write')).toBe('Wrote the new file /apps/notes/src/lib/units.js (42 B, 2 lines).')
    expect(toolResult(second, 'call_mkdir')).toBe('Made the folder /apps/notes/data/cache, and above it /apps/notes/data.')
    expect(toolResult(second, 'call_read')).toBe('/apps/notes/src/lib/units.js: lines 1-2 of 2 (42 B)\n1: export const KM = 1000\n2: export const M = 1')
    expect(toolResult(second, 'call_edit')).toBe('Edited /apps/notes/src/lib/units.js: 1 of 1 edit done.\n1. Done. Replaced the text at line 2.')
    expect(fs.readFileSync(path.join(appsDir, 'notes/src/lib/units.js'), 'utf8')).toBe(`${units}export const CM = 0.01\n`)
    expect(parseAppManifest(fs.readFileSync(path.join(appsDir, 'notes/manifest.json'), 'utf8'))).toStrictEqual({ name: 'notes', description: 'Keeps notes.', kind: 'script' })
    // Only the user can open the folders and the files that the tool made.
    expect(['.', 'notes', 'notes/src', 'notes/src/lib', 'notes/data', 'notes/data/cache'].map(modeOf)).toStrictEqual([0o700, 0o700, 0o700, 0o700, 0o700, 0o700])
    expect(['notes/manifest.json', 'notes/main.ts', 'notes/src/lib/units.js'].map(modeOf)).toStrictEqual([0o600, 0o600, 0o600])

    sendToolCalls(second.reply, [
      appsCall('call_mv', 'mv', { moves: [
        { from: '/apps/notes/src/lib/units.js', to: '/apps/notes/lib/units.js' },
        { from: '/apps/notes/src', to: '/apps/notes/data/old' },
        { from: '/apps/notes/gone.js', to: '/apps/notes/x.js' },
      ] }),
      appsCall('call_ls', 'ls', { path: '/apps/notes' }),
      appsCall('call_list', 'list_apps'),
    ])

    const third = await chatRequest()
    const mainBytes = fs.statSync(path.join(appsDir, 'notes/main.ts')).size
    expect(toolResult(third, 'call_mv')).toBe([
      'Did 2 of 3 moves.',
      '1. Done. Moved /apps/notes/src/lib/units.js to /apps/notes/lib/units.js.',
      '2. Done. Moved /apps/notes/src to /apps/notes/data/old.',
      '3. Failed. Nothing is at /apps/notes/gone.js.',
    ].join('\n'))
    expect(toolResult(third, 'call_ls')).toBe([
      '/apps/notes: 2 folders and 2 files (name | size).',
      'data/ | 0 files, 0 B',
      'lib/ | 1 file, 65 B',
      `main.ts | ${byteSizeText(mainBytes)}`,
      'manifest.json | 75 B',
    ].join('\n'))
    expect(toolResult(third, 'call_list')).toBe([
      `${BUILT_IN_APPS.length + 1} apps (name | kind | size | description), by name.`,
      ...BUILT_IN_APPS.map((app) => `${app.name} | ${app.kind} (built-in) | ${byteSizeText(app.bytes)} | ${app.description}`),
      `notes | script | ${byteSizeText(mainBytes + 65 + 75)} | Keeps notes.`,
    ].join('\n'))
    expect(['notes/lib', 'notes/data/old', 'notes/data/old/lib'].map(modeOf)).toStrictEqual([0o700, 0o700, 0o700])

    sendToolCalls(third.reply, [
      appsCall('call_rm', 'rm', { paths: ['/apps/notes/data', '/apps/notes/lib/units.js'] }),
      appsCall('call_rm_app', 'rm', { paths: ['/apps/notes'] }),
      appsCall('call_none', 'ls'),
    ])

    const fourth = await chatRequest()
    expect(toolResult(fourth, 'call_rm')).toBe([
      'Deleted 2 of 2 paths.',
      '1. Done. Deleted the folder /apps/notes/data with the 3 files and folders in it (0 B):',
      '/apps/notes/data/cache/',
      '/apps/notes/data/old/',
      '/apps/notes/data/old/lib/',
      '2. Done. Deleted the file /apps/notes/lib/units.js (65 B).',
    ].join('\n'))
    expect(toolResult(fourth, 'call_rm_app')).toBe([
      'Deleted 1 of 1 path.',
      `1. Done. Deleted the folder /apps/notes with the 3 files and folders in it (${byteSizeText(mainBytes + 75)}):`,
      '/apps/notes/lib/',
      '/apps/notes/main.ts',
      '/apps/notes/manifest.json',
    ].join('\n'))
    // The built-in apps stay.
    expect(toolResult(fourth, 'call_none')).toBe([
      `/apps: ${BUILT_IN_APPS.length} folders and 0 files (name | size).`,
      ...BUILT_IN_APPS.map((app) => `${app.name}/ | ${app.files.length} files, ${byteSizeText(app.bytes)} | built-in`),
    ].join('\n'))
    expect(await filesIn(appsDir)).toStrictEqual([])
    await expectReplyEnd(fourth)
    expect(await consoleErrors(browser)).toStrictEqual([])
  })

  it('changes the files of /work, the work folder of the conversation, and only reads /libs, the libraries that Dez ships', async () => {
    await seedApp(appsDir, { name: 'store', description: 'Keeps data.', kind: 'script' }, { 'main.ts': 'export default () => 1\n' })
    await submit(browser, 'Keep some data.')
    const first = await chatRequest()
    const workDir = appFilePath(setup.app.home, 'work', await activeConversationId(browser))
    sendToolCalls(first.reply, [
      appsCall('call_write', 'write', { path: '/work/data/a.json', content: '{}\n' }),
      appsCall('call_mv', 'mv', { moves: [{ from: '/work/data/a.json', to: '/apps/store/a.json' }, { from: '/apps/store/main.ts', to: '/work/main.ts' }] }),
      appsCall('call_rm_work', 'rm', { paths: ['/work'] }),
      appsCall('call_ls_libs', 'ls', { path: '/libs' }),
      appsCall('call_read_libs', 'read', { path: '/libs/import_map.json', ranges: [{ from_line: 1, to_line: 1 }] }),
      appsCall('call_write_libs', 'write', { path: '/libs/x.js', content: 'x' }),
    ])

    const second = await chatRequest()
    expect(toolResult(second, 'call_write')).toBe('Wrote the new file /work/data/a.json (3 B, 1 line).')
    expect(toolResult(second, 'call_mv')).toBe('Did 2 of 2 moves.\n1. Done. Moved /work/data/a.json to /apps/store/a.json.\n2. Done. Moved /apps/store/main.ts to /work/main.ts.')
    expect(fs.readFileSync(path.join(appsDir, 'store/a.json'), 'utf8')).toBe('{}\n')
    expect(await filesIn(workDir)).toStrictEqual(['data', 'main.ts'])
    // Only the user can open the work folder and what the tool made in it.
    expect([workDir, path.join(workDir, 'data')].map((folder) => fs.statSync(folder).mode & 0o777)).toStrictEqual([0o700, 0o700])
    expect(toolResult(second, 'call_rm_work')).toContain('/work is the work folder of this conversation, and rm does not delete it')
    expect(toolResult(second, 'call_ls_libs')).toMatch(/^\/libs: \d+ folders and \d+ files \(name \| size\)\.\n(.*\n)*three\/ \| \d/)
    expect(toolResult(second, 'call_read_libs')).toMatch(/^\/libs\/import_map\.json: line 1 of \d+ \(/)
    expect(toolResult(second, 'call_write_libs')).toContain('/libs/x.js: /libs/ holds the libraries that Dez ships')
    await expectReplyEnd(second)
    // Dez logs the two calls that it refuses, and nothing else.
    expect((await consoleErrors(browser)).map((error) => error.split('\n')[0].replace(/^The tool apps failed: ToolError: (\S+ \S+).*$/, '$1'))).toStrictEqual(['/work is', '/libs/x.js: /libs/'])

    await fs.promises.rm(appsDir, { recursive: true, force: true })
  })

  it('reads ranges of lines, and edits a file by find and replace', async () => {
    const items = Array.from({ length: 30 }, (_, index) => `item ${index + 1}`)
    const itemsText = `${items.join('\n')}\n`
    await seedApp(appsDir, { name: 'list', description: 'Keeps a list.', kind: 'script' }, { 'items.txt': itemsText })
    const file = '/apps/list/items.txt'

    await submit(browser, 'Change the list.')
    const first = await chatRequest()
    sendToolCalls(first.reply, [
      appsCall('call_read', 'read', { path: file, ranges: [{ from_line: 2, to_line: 3 }, { from_line: 29 }, { from_line: 3, to_line: 5 }] }),
    ])

    // The ranges show in the order of the call, and a range that overlaps
    // an earlier one shows no line.
    const second = await chatRequest()
    expect(toolResult(second, 'call_read')).toBe([
      `${file}: lines 2-3 and lines 29-30 of 30 (${byteSizeText(Buffer.byteLength(itemsText))})`,
      '2: item 2',
      '3: item 3',
      '29: item 29',
      '30: item 30',
      'Range 3 is left out. It names lines 3-5, and range 1 names lines 2-3 already. Make one range of the two, as in {"from_line": 2, "to_line": 5}.',
    ].join('\n'))
    // The edits apply in the order of the call, and each one passes or
    // fails by itself. The two other calls have two wrong forms that models
    // sent: items with other names, and the fields of one edit next to
    // `path`.
    sendToolCalls(second.reply, [
      appsCall('call_edit', 'edit', { path: file, edits: [
        { old_string: 'item 5\n', new_string: 'ITEM 5\n' },
        { old_string: 'item 1', new_string: 'first' },
        { old_string: 'item 2\n', new_string: 'item 2\nitem 2b\n' },
        { old_string: 'item 31', new_string: 'last' },
        { old_string: 'item ', new_string: 'entry ', replace_all: true },
      ] }),
      appsCall('call_wrong_items', 'edit', { path: file, edits: [{ from: 'item 1', to: 'first' }] }),
      appsCall('call_flat', 'edit', { path: file, old: 'item 1', new: 'first' }),
    ])

    // Which edits were done; the unit tests check the texts of the result
    // (model/tools/textEdits.test.ts, model/tools/appsTool.test.ts). Each
    // call of a wrong form gets an error that names what it gave wrong.
    const third = await chatRequest()
    expect(toolResult(third, 'call_edit').split('\n').map((row, index) => (index === 0 ? row : /^\d+\. (Done|Failed)\./.exec(row)?.[1])))
      .toStrictEqual([`Edited ${file}: 3 of 5 edits done.`, 'Done', 'Failed', 'Done', 'Failed', 'Done'])
    expect(toolResult(third, 'call_wrong_items')).toContain('an item of "edits" has no parameter "from".')
    expect(toolResult(third, 'call_flat')).toContain('apps edit has no parameter "old".')
    await expectReplyEnd(third)
    const entries = items.map((item) => item.replace('item ', 'entry '))
    expect(fs.readFileSync(path.join(appsDir, 'list/items.txt'), 'utf8')).toBe(`${[...entries.slice(0, 2), 'entry 2b', ...entries.slice(2, 4), 'ITEM 5', ...entries.slice(5)].join('\n')}\n`)
    // Dez logs the two calls that it refuses, and nothing else.
    expect((await consoleErrors(browser)).map((error) => error.split('\n')[0])).toStrictEqual([
      expect.stringMatching(/^The tool apps failed: ToolError: Item 1 of the parameter "edits" is not valid: /),
      expect.stringMatching(/^The tool apps failed: ToolError: apps edit has no parameter "old"\. /),
    ])

    await fs.promises.rm(appsDir, { recursive: true, force: true })
  })

  it('finds files by their paths, and lines by a regular expression', async () => {
    await seedApp(appsDir, { name: 'trip', description: 'Gives the length of a trip.', kind: 'script' }, {
      'main.ts': [
        "import { KM } from './units.ts'",
        '',
        '// The length of the trip, in km.',
        'const trip = 12',
        '',
        '// Gives the trip in m, as the units tell.',
        'export default () => trip * KM',
      ].join('\n') + '\n',
      'units.ts': 'export const KM = 1000\n',
    })
    // A line on which the engine of WebKit gives up: the repeat in a
    // repeat backtracks too much before the "x" at its end can match.
    await seedApp(appsDir, { name: 'slow', description: 'Has a slow line.', kind: 'script' }, { 'slow.txt': `${'a'.repeat(60)}!x\n` })

    await submit(browser, 'Find the units in my apps.')
    const first = await chatRequest()
    sendToolCalls(first.reply, [
      appsCall('call_find_all', 'find', { query: '*' }),
      appsCall('call_find_words', 'find', { query: 'trip ts' }),
      appsCall('call_grep', 'grep', { pattern: 'units?\\b', path: '/apps/trip', context: 1 }),
      appsCall('call_grep_bad', 'grep', { pattern: 'trip (' }),
      appsCall('call_grep_slow', 'grep', { pattern: '^(a+)+$|x', path: '/apps/slow/slow.txt' }),
    ])

    const second = await chatRequest()
    expect(toolResult(second, 'call_find_all')).toBe([
      `/apps: ${BUILT_IN_FILES.length + 5} files (paths after /apps/), by path.`,
      ...BUILT_IN_FILES,
      'slow/manifest.json',
      'slow/slow.txt',
      'trip/main.ts',
      'trip/manifest.json',
      'trip/units.ts',
    ].join('\n'))
    expect(toolResult(second, 'call_find_words')).toBe([
      `/apps: 2 of ${BUILT_IN_FILES.length + 5} files match "trip ts" (paths after /apps/), by path.`,
      'trip/main.ts',
      'trip/units.ts',
    ].join('\n'))
    expect(toolResult(second, 'call_grep')).toBe([
      '/apps/trip: 2 lines in 1 of 3 files match "units?\\\\b" (paths after /apps/), by path.',
      '',
      'trip/main.ts',
      "1: import { KM } from './units.ts'",
      '2- ',
      '--',
      '5- ',
      '6: // Gives the trip in m, as the units tell.',
      '7- export default () => trip * KM',
    ].join('\n'))
    const [badText, badDetails] = toolResult(second, 'call_grep_bad').split('\n\nDetails: ')
    expect(badText).toBe('`pattern` is no regular expression that JavaScript takes. '
      + 'Put a "\\" before a special character to find the character itself, or set `literal` to true to find the pattern as plain text.')
    expect(badDetails).toMatch(/^Invalid regular expression: /)
    // The line matches, but the engine gave up on it: the result must not
    // tell the model that no line matches and stop there.
    expect(toolResult(second, 'call_grep_slow')).toBe([
      'No line of /apps/slow/slow.txt matches "^(a+)+$|x".',
      '',
      'Not sure: 1 line took too long to match, and it can match: line 1. '
        + 'The engine of regular expressions gives up on a line that takes too long, as if the line did not match. '
        + 'A repeat in a repeat, as "(a+)+", or ".*" at the start of a pattern, can take very long on some lines. '
        + 'Make the pattern simpler, or read these lines.',
    ].join('\n'))
    await expectReplyEnd(second)
    // Dez logs the call that it refuses, and nothing else.
    expect((await consoleErrors(browser)).map((error) => error.split('\n')[0])).toStrictEqual([`The tool apps failed: ToolError: ${badText}`])

    await fs.promises.rm(appsDir, { recursive: true, force: true })
  })

  it('ends a grep at its time limit, and the window answers while it runs', async () => {
    await seedApp(appsDir, { name: 'long', description: 'Has a long line.', kind: 'script' }, { 'long.txt': `${'b'.repeat(1024 * 1024)}\n` })

    await submit(browser, 'Find zzz in the long app.')
    const first = await chatRequest()
    const sent = Date.now()
    // ".*" at the start makes the engine try each start of the line, each
    // to its end: much more than the time limit on a line of 1 MiB.
    sendToolCalls(first.reply, [appsCall('call_grep', 'grep', { pattern: '.*zzz', path: '/apps/long' })])

    // The search runs in a worker, so the page answers at once while it
    // runs. `chatRequest` waits only 10 seconds, so the page is asked first.
    let slowestAnswerMs = 0
    while (Date.now() - sent < 5_000) {
      const asked = Date.now()
      expect(await browser.execute(() => document.readyState)).toBe('complete')
      slowestAnswerMs = Math.max(slowestAnswerMs, Date.now() - asked)
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    expect(slowestAnswerMs).toBeLessThan(1_000)
    expect(setup.mock.hasWaitingRequest()).toBe(false)

    const second = await chatRequest()
    expect(Date.now() - sent).toBeGreaterThanOrEqual(GREP_TIME_LIMIT_SECONDS * 1000)
    expect(toolResult(second, 'call_grep')).toBe(grepTimeoutError().message)
    await expectReplyEnd(second)

    await fs.promises.rm(appsDir, { recursive: true, force: true })
  })

  it('counts the lines and the bytes of files', async () => {
    await seedApp(appsDir, { name: 'count', description: 'Has files to count.', kind: 'script' }, {
      'ends.txt': 'one\ntwo\n',
      'open.txt': 'one\ntwo',
      'empty.txt': '',
      'zero.bin': 'a\0b',
      'big.txt': 'a'.repeat(APPS_MAX_FILE_BYTES + 1),
    })

    await submit(browser, 'Count the files of the count app.')
    const first = await chatRequest()
    const files = ['ends.txt', 'open.txt', 'empty.txt', 'zero.bin', 'big.txt'].map((name) => `/apps/count/${name}`)
    sendToolCalls(first.reply, [appsCall('call_wc', 'wc', { paths: [...files, '/apps/count', '/apps/count/gone.txt'] })])

    const second = await chatRequest()
    expect(toolResult(second, 'call_wc')).toBe([
      '5 files (path | lines | size).',
      // A line end at the end of a file adds no line, as in read.
      '/apps/count/ends.txt | 2 lines | 8 B',
      '/apps/count/open.txt | 2 lines | 7 B',
      '/apps/count/empty.txt | 0 lines | 0 B',
      '/apps/count/zero.bin | not counted: no text file | 3 B',
      '/apps/count/big.txt | not counted: more than 2,097,152 bytes | 2,097,153 bytes',
      'Path 6 is left out. /apps/count is a folder, not a file. Call ls to see what is in it.',
      'Path 7 is left out. There is no file /apps/count/gone.txt. Call ls to see the files of its folder, as in {"path": "/apps/count"}.',
    ].join('\n'))
    await expectReplyEnd(second)

    await fs.promises.rm(appsDir, { recursive: true, force: true })
  })

  it('reaches no file of the computer through a link in the folder of an app', async () => {
    const SECRET = 'A text that no model must get.'
    const secret = await writeTestFile(path.join(outsideDir, 'secret.txt'), Buffer.from(SECRET))
    const manifest = appManifestText({ name: 'safe', description: 'A safe app.', kind: 'script' })
    await writeTestFile(path.join(appsDir, 'safe/manifest.json'), Buffer.from(manifest))
    await writeTestFile(path.join(appsDir, 'safe/my file.txt'), Buffer.from('abc'))
    // What a program that is not confined could leave in the folder: a
    // link to a file, and a link to a folder.
    fs.symlinkSync(secret, path.join(appsDir, 'safe/secret.txt'))
    fs.symlinkSync(outsideDir, path.join(appsDir, 'safe/out'))

    await submit(browser, 'Read the files of the safe app.')
    const first = await chatRequest()
    const throughLink = [
      appsCall('call_read_link', 'read', { path: '/apps/safe/secret.txt' }),
      appsCall('call_read_below', 'read', { path: '/apps/safe/out/secret.txt' }),
      appsCall('call_write_link', 'write', { path: '/apps/safe/secret.txt', content: 'changed' }),
      appsCall('call_write_below', 'write', { path: '/apps/safe/out/new.txt', content: 'new' }),
      appsCall('call_edit_link', 'edit', { path: '/apps/safe/secret.txt', edits: [{ old_string: 'text', new_string: 'changed' }] }),
      appsCall('call_mkdir_below', 'mkdir', { path: '/apps/safe/out/sub' }),
      appsCall('call_ls_below', 'ls', { path: '/apps/safe/out' }),
      appsCall('call_mv_link', 'mv', { moves: [{ from: '/apps/safe/secret.txt', to: '/apps/safe/moved.txt' }] }),
      appsCall('call_mv_below', 'mv', { moves: [{ from: '/apps/safe/manifest.json', to: '/apps/safe/out/manifest.json' }] }),
      appsCall('call_rm_below', 'rm', { paths: ['/apps/safe/out/secret.txt'] }),
      appsCall('call_wc_link', 'wc', { paths: ['/apps/safe/secret.txt', '/apps/safe/out/secret.txt'] }),
    ]
    sendToolCalls(first.reply, [
      ...throughLink,
      appsCall('call_dots', 'read', { path: '/apps/safe/../../provider_keys.json' }),
      appsCall('call_ls', 'ls', { path: '/apps/safe' }),
    ])

    const second = await chatRequest()
    for (const call of throughLink) {
      const id = call.id as string
      expect(toolResult(second, id), id).toContain('goes through a link')
    }
    // A count gives no fact of a file that a link names: each path fails.
    expect(toolResult(second, 'call_wc_link').split('\n').map((line) => line.includes('goes through a link'))).toStrictEqual([true, true])
    expect(toolResult(second, 'call_dots')).toContain('which the apps tool does not resolve')
    expect(toolResult(second, 'call_ls')).toBe([
      '/apps/safe: 0 folders and 4 files (name | size).',
      `manifest.json | ${byteSizeText(Buffer.byteLength(manifest))}`,
      '"my file.txt" | 3 B | a name that the apps tool does not take',
      'out | a link or a special file',
      'secret.txt | a link or a special file',
    ].join('\n'))
    expect(second.body).not.toContain(SECRET)
    expect(second.body).not.toContain(outsideDir)
    expect(fs.readFileSync(secret, 'utf8')).toBe(SECRET)
    expect(await filesIn(outsideDir)).toStrictEqual(['secret.txt'])
    expect(await filesIn(path.join(appsDir, 'safe'))).toStrictEqual(['manifest.json', 'my file.txt', 'out', 'secret.txt'])

    // The delete of the app takes the links, and not what they name.
    sendToolCalls(second.reply, [appsCall('call_rm_app', 'rm', { paths: ['/apps/safe'] })])

    const third = await chatRequest()
    expect(toolResult(third, 'call_rm_app')).toContain('1. Done. Deleted the folder /apps/safe with the 4 files and folders in it')
    expect(await filesIn(appsDir)).toStrictEqual([])
    expect(fs.readFileSync(secret, 'utf8')).toBe(SECRET)
    await expectReplyEnd(third)
  })

  it('shows a UI app as a card in the reply, and tells the model of it only in the result of the call', async () => {
    await seedApp(appsDir, { name: 'notes', description: 'Keeps notes.', kind: 'ui' }, { 'index.html': '<!doctype html>\n<p>Notes</p>\n' })
    await seedApp(appsDir, { name: 'sum', description: 'Adds numbers.', kind: 'script' }, { 'main.ts': 'export default () => 1\n' })
    await seedApp(appsDir, { name: 'bare', description: 'Has no page yet.', kind: 'ui' })
    const tag = appTagText('notes')

    await submit(browser, 'Show me the notes app.')
    const first = await chatRequest()
    sendToolCalls(first.reply, [
      appsCall('call_show', 'show', { name: 'notes' }),
      appsCall('call_script', 'show', { name: 'sum' }),
      appsCall('call_bare', 'show', { name: 'bare' }),
      appsCall('call_gone', 'show', { name: 'gone' }),
    ])

    const second = await chatRequest()
    expect(toolResult(second, 'call_show')).toBe(showResultText('notes'))
    expect(toolResult(second, 'call_script')).toContain('/apps/sum is a script app, and show shows only a UI app')
    expect(toolResult(second, 'call_bare')).toContain('The app /apps/bare has no index.html, the page that Dez shows.')
    expect(toolResult(second, 'call_gone')).toContain('/apps/gone')
    expect(sendsAppTag(second)).toBe(false)
    await sendChatReply(second.reply, CALLER.modelName)

    // One tag, for the one app that Dez can show: a paragraph of its own
    // between the blocks of the calls and the text of the next round.
    const reply = await endedReply(browser)
    expect(reply.endsWith(`</dez:tool>\n\n${tag}\n\n${replyText(CALLER.modelName)}`)).toBe(true)
    expect(reply.split('<dez:app').length - 1).toBe(1)
    // The card is a poster: the app does not run until the user starts it.
    const poster: ShownAppCard[] = [{ app: 'notes', state: 'run', text: 'notes\nKeeps notes.' }]
    await waitForValue(browser, 'the card of the app', () => shownAppCards(browser), poster)
    expect(await openToasts(browser, 'error')).toStrictEqual([])
    const file = conversationFilePath(setup.app.home, await activeConversationId(browser))
    await waitForValue(browser, 'saved tag', async () => (await fs.promises.readFile(file, 'utf8').catch(() => '')).includes(`\n${tag}\n`), true)

    // The request of the next reply sends the first reply with the same
    // bytes: the result of the call, and no tag.
    await submit(browser, 'Thanks.')
    const third = await chatRequest()
    expect(toolResult(third, 'call_show')).toBe(showResultText('notes'))
    expect(sendsAppTag(third)).toBe(false)
    const sentBefore = (JSON.parse(second.body) as { messages: unknown[] }).messages
    expect((JSON.parse(third.body) as { messages: unknown[] }).messages.slice(0, sentBefore.length)).toStrictEqual(sentBefore)
    await sendChatReply(third.reply, CALLER.modelName)
    await endedReply(browser, 3)
    await waitForValue(browser, 'the card of the app after the next reply', () => shownAppCards(browser), poster)
    // Dez logs each call that it refuses, and nothing else.
    expect((await consoleErrors(browser)).map((error) => error.split('\n')[0].replace(/^The tool apps failed: ToolError: (\S+ \S+ \S+).*$/, '$1'))).toStrictEqual([
      '/apps/sum is a',
      'The app /apps/bare',
      'There is no',
    ])

    await fs.promises.rm(appsDir, { recursive: true, force: true })
  })
})
