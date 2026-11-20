import fs from 'node:fs'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { appManifestText, parseAppManifest } from '../../src/model/tools/appManifest'
import { byteSizeText } from '../../src/utils/byteSize'
import { consoleErrors, resetConsoleErrors, screenshotOnFailure } from './harness/dom'
import { linkedDropDir } from './harness/drops'
import { appFilePath, filesIn, writeTestFile } from './harness/fixtures'
import { startMockProviderApp, takeRequest, type MockProviderApp } from './harness/mockProviderApp'
import { mockChatPath, openAiToolCall, replyText, sendChatReply, sendToolCalls, toolResult, type HeldRequest, type MockProvider } from './harness/mockServer'
import type { E2EBrowser } from './harness/session'
import { endedReply, newTab, openToasts, submit } from './harness/thread'

// The `apps` tool, driven through the real app against a mock chat model in
// this process. The calls work on the real folder `apps/` of the test HOME,
// through the file commands of the backend:
// - a model makes an app, and writes, reads, edits, moves, lists, and
//   deletes its files; only the user can open what the tool made;
// - the tool opens, changes, and moves nothing through a link that is in
//   the folder of an app, so a call never reaches a file of the computer
//   that is not in that folder, and the delete of an app leaves the file
//   that a link names.
// No request holds a path of the test HOME (`takeRequest` checks each one).
//
// One app session serves the whole file; each test starts in a new tab.

const CALLER: MockProvider = { id: 'caller', name: 'Caller Mock', modelId: 'caller-model', modelName: 'Caller Model' }
const CHAT_PATH = mockChatPath(CALLER)

/** An `apps` call of the mock model. */
function appsCall (id: string, command: string, parameters: Record<string, unknown> = {}): Record<string, unknown> {
  return openAiToolCall(id, 'apps', { command, parameters: JSON.stringify(parameters) })
}

describe('apps tool', () => {
  let setup: MockProviderApp
  let browser: E2EBrowser
  let appsDir: string
  // A folder that is not in the test HOME, for the file that a link names.
  let outsideDir: string

  const chatRequest = (): Promise<HeldRequest> => takeRequest(setup, CHAT_PATH)

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
      appsCall('call_edit', 'edit', { path: '/apps/notes/src/lib/units.js', edits: [{ after_line: 2, text: 'export const CM = 0.01' }] }),
    ])

    const second = await chatRequest()
    expect(toolResult(second, 'call_init')).toBe('Made the script app /apps/notes with 2 files:\n/apps/notes/manifest.json\n/apps/notes/main.ts\nChange them with read, edit, and write.')
    expect(toolResult(second, 'call_write')).toBe('Wrote the new file /apps/notes/src/lib/units.js (42 B, 2 lines).')
    expect(toolResult(second, 'call_mkdir')).toBe('Made the folder /apps/notes/data/cache, and above it /apps/notes/data.')
    expect(toolResult(second, 'call_read')).toBe('/apps/notes/src/lib/units.js: lines 1-2 of 2 (42 B)\n1: export const KM = 1000\n2: export const M = 1')
    expect(toolResult(second, 'call_edit')).toBe([
      'Edited /apps/notes/src/lib/units.js: 1 of 1 edit done. The file had 2 lines, and it has 3 now.',
      '1. Done. Put 1 line in after line 2.',
      'The lines have new numbers now: read the file again before the next edit of it.',
      'The change:',
      '@@ -1,2 +1,3 @@',
      ' export const KM = 1000',
      ' export const M = 1',
      '+export const CM = 0.01',
    ].join('\n'))
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
    expect(toolResult(third, 'call_list')).toBe(`1 app (name | kind | size | description), by name.\nnotes | script | ${byteSizeText(mainBytes + 65 + 75)} | Keeps notes.`)
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
    expect(toolResult(fourth, 'call_none')).toBe('There are no apps yet. Make one with init.')
    expect(await filesIn(appsDir)).toStrictEqual([])
    await expectReplyEnd(fourth)
    expect(await consoleErrors(browser)).toStrictEqual([])
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
      appsCall('call_edit_link', 'edit', { path: '/apps/safe/secret.txt', edits: [{ from_line: 1, text: 'changed' }] }),
      appsCall('call_mkdir_below', 'mkdir', { path: '/apps/safe/out/sub' }),
      appsCall('call_ls_below', 'ls', { path: '/apps/safe/out' }),
      appsCall('call_mv_link', 'mv', { moves: [{ from: '/apps/safe/secret.txt', to: '/apps/safe/moved.txt' }] }),
      appsCall('call_mv_below', 'mv', { moves: [{ from: '/apps/safe/manifest.json', to: '/apps/safe/out/manifest.json' }] }),
      appsCall('call_rm_below', 'rm', { paths: ['/apps/safe/out/secret.txt'] }),
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
})
