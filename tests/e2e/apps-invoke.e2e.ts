import fs from 'node:fs'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { jobStartedText, startedJobId } from '../../src/model/tools/jobs'
import { appsCall, seedApp } from './harness/apps'
import { consoleErrors, resetConsoleErrors, screenshotOnFailure, waitForValue } from './harness/dom'
import { expectNoLinkedFile, linkedDropDir, openDroppedFiles } from './harness/drops'
import { appFilePath, filesIn, newFileIn, storedFileName } from './harness/fixtures'
import { generatedImagesDir, shownImages, solidPng, STRIPES_PNG } from './harness/images'
import { runToolJob, type EndedJob } from './harness/jobs'
import { expectReplyEnd, expectRunsEnded } from './harness/jsEval'
import { shownPlayers, WEBM_VIDEO } from './harness/media'
import { startMockProviderApp, takeRequest, type MockProviderApp } from './harness/mockProviderApp'
import { mockChatPath, replyText, sendChatReply, sendToolCalls, toolResult, type HeldRequest, type MockProvider } from './harness/mockServer'
import type { E2EBrowser } from './harness/session'
import { endedReply, newTab, submit } from './harness/thread'
import { hiddenAssetNotes, hiddenPart, hidingPart, intermediateParts, pressToolChip, revealingPart } from './harness/toolChips'

// The `invoke` subcommand of the `apps` tool for a script app, driven
// through the real app against a mock chat model in this process. The app
// runs the code of each app in the real Deno of the debug build, as a job
// of the reply:
// - the app that `init` made runs as it is; code that a model wrote after
//   it imports another file of its app, and keeps its state in a file of
//   the folder of the app from one run to the next;
// - the code gets a copy of each image and clip that the call names, in
//   the order of the call, also of a file that the user linked: a change of
//   a copy changes no file of the user;
// - Dez keeps each image and clip that the code left in the output folder
//   as a new asset of the conversation, in a stored file whose type follows
//   its bytes and not its name, and keeps no other file;
// - a run with `is_intermediate` hides its asset under the chip of its
//   call;
// - a call that names no app or a UI app starts no job; code that threw
//   gives an error result that names the line by its path in the tool
//   (`/apps/<name>/main.ts`), and Dez keeps no file of that run;
// - the code opens no file outside the folder of its app and the work
//   folder of its run: not a file of another app, not the list of the
//   apps, and not a file of the Dez folder. Dez's module loads the main
//   file of an app by a path that it makes, so Deno checks the read
//   permission of each import of the code too (in a `js_eval` run only the
//   OS rule stops an import of a literal path). The audit of all that Deno
//   and the OS rule refuse is js-eval-sandbox.e2e.ts;
// - every work folder is gone after its run.
// No request holds a path of the test HOME (`takeRequest` checks each one):
// a result names the folder of an app as `/apps/<name>` and the work folder
// as `/work`. No request holds the path or the name of a linked file.
//
// One app session serves the whole file; each test starts in a new tab and
// works on apps of its own.

const CALLER: MockProvider = { id: 'caller', name: 'Caller Mock', modelId: 'caller-model', modelName: 'Caller Model' }
const CHAT_PATH = mockChatPath(CALLER)

// A 16 x 16 PNG image, as an expression of the code of an app.
const PNG_BYTES = `Uint8Array.from(atob("${solidPng(16, 16, [40, 90, 220]).toString('base64')}"), (character) => character.charCodeAt(0))`

// The code of the `counter` app, which a model writes over the file that
// `init` made: it adds the step of the run to the count that the last run
// left in a file of the app.
const COUNTER_MAIN = [
  'import { nextCount } from "./lib/count.ts"',
  '',
  'export default async function main(parameters, dez) {',
  '  await Deno.mkdir(`${dez.appFolder}/data`, { recursive: true })',
  '  const file = `${dez.appFolder}/data/count.txt`',
  '  console.log(`step ${parameters.step}`)',
  '  return { count: await nextCount(file, parameters.step), file, frozen: Object.isFrozen(dez) }',
  '}',
].join('\n')

const COUNTER_LIB = [
  'export async function nextCount(file: string, step: number): Promise<number> {',
  '  let count = 0',
  '  try {',
  '    count = Number(await Deno.readTextFile(file))',
  '  } catch (error) {',
  '    if (!(error instanceof Deno.errors.NotFound)) throw error',
  '  }',
  '  await Deno.writeTextFile(file, String(count + step))',
  '  return count + step',
  '}',
].join('\n')

// The code of the `sheet` app: it tells the facts of each input, leaves a
// clip, an image under a name of no image, and a text in the output
// folder, and then writes over each copy of an input.
const SHEET_MAIN = [
  'export default async function main(parameters, dez) {',
  '  const facts = []',
  '  for (const { id, kind, type, path } of dez.inputs) facts.push(`${id} ${kind} ${type} ${path} ${(await Deno.stat(path)).size}`)',
  '  const [clip, image] = dez.inputs',
  '  await Deno.copyFile(clip.path, `${dez.outputFolder}/clip.webm`)',
  '  await Deno.copyFile(image.path, `${dez.outputFolder}/picture.dat`)',
  '  await Deno.writeTextFile(`${dez.outputFolder}/notes.txt`, "no image and no clip")',
  '  for (const { path } of dez.inputs) await Deno.writeTextFile(path, "changed by the app")',
  '  return facts.join("\\n")',
  '}',
].join('\n')

const DRAFT_MAIN = [
  'export default async function main(parameters, dez) {',
  `  await Deno.writeFile(\`\${dez.outputFolder}/draft.png\`, ${PNG_BYTES})`,
  '  return "A draft."',
  '}',
].join('\n')

// What the code of the `one` app tries outside its two folders, by the
// name of each try, with the outcome that the run must give for it.
const ESCAPES = [
  ['read a file of another app', 'Deno.readTextFile(`${dez.appFolder}/../two/manifest.json`)', 'NotCapable: Requires read access'],
  ['write into another app', 'Deno.writeTextFile(`${dez.appFolder}/../two/new.txt`, "x")', 'NotCapable: Requires write access'],
  ['import a file of another app', 'import("../two/main.ts")', 'TypeError: Requires read access'],
  ['import it by a path that the code makes', 'import(`file://${dez.appFolder}/../two/main.ts`)', 'TypeError: Requires read access'],
  ['list the apps', 'Array.fromAsync(Deno.readDir(`${dez.appFolder}/..`))', 'NotCapable: Requires read access'],
  ['read the state of Dez', 'Deno.readTextFile(`${dez.appFolder}/../../app_state.json`)', 'NotCapable: Requires read access'],
] as const

// The code of the `one` app. With the parameter `fail`, it leaves an image
// in the output folder and throws. Without it, it returns one line for
// each try of `ESCAPES`: its name, then `done`, or the name of the error
// and the refusal that the error text names, without the path after it.
const ONE_MAIN = [
  'export default async function main(parameters, dez) {',
  '  if (parameters.fail) {',
  `    await Deno.writeFile(\`\${dez.outputFolder}/lost.png\`, ${PNG_BYTES})`,
  '    throw new Error(`no luck in ${dez.appFolder}`)',
  '  }',
  '  const tries = {',
  ...ESCAPES.map(([name, source]) => `    ${JSON.stringify(name)}: () => ${source},`),
  '  }',
  '  const lines = []',
  '  for (const [name, attempt] of Object.entries(tries)) {',
  '    try {',
  '      await attempt()',
  '      lines.push(`${name}: done`)',
  '    } catch (error) {',
  '      lines.push(`${name}: ${error.name}: ${/Requires \\w+ access|Permission denied/.exec(error.message)?.[0]}`)',
  '    }',
  '  }',
  '  return lines.join("\\n")',
  '}',
].join('\n')

describe('apps invoke', () => {
  let setup: MockProviderApp
  let browser: E2EBrowser
  let appsDir: string
  let imagesDir: string
  let videoDir: string
  // A folder that is not in the test HOME, so that the app links a file of
  // it in place.
  let linkedDir: string
  // Each chat request of the test that runs.
  let requests: HeldRequest[]

  async function chatRequest (): Promise<HeldRequest> {
    const request = await takeRequest(setup, CHAT_PATH)
    requests.push(request)
    return request
  }

  // Runs the job of the `invoke` call `callId` (`runToolJob`).
  function invoke (request: HeldRequest, callId: string, parameters: Record<string, unknown>): Promise<EndedJob> {
    return runToolJob(chatRequest, request, 'apps', callId, appsCall(callId, 'invoke', parameters))
  }

  beforeAll(async () => {
    linkedDir = await linkedDropDir('apps-invoke')
    setup = await startMockProviderApp(CALLER)
    browser = setup.browser
    appsDir = appFilePath(setup.app.home, 'apps')
    imagesDir = generatedImagesDir(setup.app.home)
    videoDir = appFilePath(setup.app.home, 'assets', 'generated', 'video')
  })

  beforeEach(async () => {
    requests = []
    await newTab(browser)
    await resetConsoleErrors(browser)
  })

  afterEach(async (ctx) => {
    await screenshotOnFailure(browser, ctx)
    await setup.mock.dropOpenReplies(browser)
  })

  afterAll(async () => {
    await setup?.stop()
    if (linkedDir) await fs.promises.rm(linkedDir, { recursive: true, force: true })
  })

  it('runs a script app as init made it, and then its new code, which imports a file of the app and keeps its state in the folder of the app', async () => {
    await submit(browser, 'Make a counter app.')
    const first = await chatRequest()
    sendToolCalls(first.reply, [appsCall('call_init', 'init', { name: 'counter', kind: 'script', description: 'Counts its runs.' })])
    const second = await chatRequest()
    expect(toolResult(second, 'call_init')).toContain('Made the script app /apps/counter')

    // The app as `init` made it. The call starts a job, and the result of
    // the job is what the code returned.
    const hello = await invoke(second, 'call_hello', { name: 'counter', parameters: { rows: 2 } })
    expect(hello.started).toBe(`${jobStartedText(hello.jobId, 1)}\nThe run has no input.`)
    expect(hello.result.status).toBe('finished')
    expect(hello.result.call).toStrictEqual({ number: 1, label: 'invoke counter {\'rows\':2}' })
    expect(hello.result.text).toBe('Hello from counter. The parameters of this run: {"rows":2}. The run has 0 input files.')

    sendToolCalls(hello.next.reply, [
      appsCall('call_main', 'write', { path: '/apps/counter/main.ts', content: COUNTER_MAIN }),
      appsCall('call_lib', 'write', { path: '/apps/counter/lib/count.ts', content: COUNTER_LIB }),
    ])
    const fourth = await chatRequest()
    expect(toolResult(fourth, 'call_main')).toContain('Wrote /apps/counter/main.ts')
    expect(toolResult(fourth, 'call_lib')).toContain('Wrote the new file /apps/counter/lib/count.ts')

    // A value that is no string comes as JSON, with the path of a file of
    // the app as the tool names it, and the console output after it.
    const one = await invoke(fourth, 'call_one', { name: 'counter', parameters: { step: 2 } })
    const [value, written] = one.result.text.split('\n\nConsole output of the code:\n')
    expect(JSON.parse(value)).toStrictEqual({ count: 2, file: '/apps/counter/data/count.txt', frozen: true })
    expect(written).toBe('step 2')
    // The next run finds the file that this run left.
    const two = await invoke(one.next, 'call_two', { name: 'counter', parameters: { step: 5 } })
    expect(JSON.parse(two.result.text.split('\n\n')[0])).toMatchObject({ count: 7 })
    expect(two.result.call.number).toBe(3)
    expect(fs.readFileSync(path.join(appsDir, 'counter/data/count.txt'), 'utf8')).toBe('7')

    await expectReplyEnd(setup, CALLER, two.next)
    expect(await consoleErrors(browser)).toStrictEqual([])
  })

  it('gives the code a copy of each input, also of a linked file, and keeps the images and the clips of the output folder', async () => {
    await seedApp(appsDir, { name: 'sheet', description: 'Copies its inputs.', kind: 'script' }, { 'main.ts': SHEET_MAIN })
    const files = await openDroppedFiles(setup, CALLER, linkedDir, 'apps-invoke')
    const imagesBefore = await filesIn(imagesDir)
    const videosBefore = await filesIn(videoDir)
    await submit(browser, ' Make a sheet of them.')

    const run = await invoke(await chatRequest(), 'call_sheet', { name: 'sheet', inputs: '@c @b @a' })
    expect(run.started).toBe(`${jobStartedText(run.jobId, 1)}\nThe inputs of the run, in the order of dez.inputs: the video clip @c, the image @b, the image @a.`)
    expect(run.result.status).toBe('finished')
    // The inputs are in the order of the call, each a copy in the work
    // folder of the run.
    const [facts, outputs] = run.result.text.split('\n\n')
    expect(facts.split('\n')).toStrictEqual([
      `c video video/webm /work/c.webm ${WEBM_VIDEO.length}`,
      `b image image/png /work/b.png ${STRIPES_PNG.length}`,
      `a image image/png /work/a.png ${STRIPES_PNG.length}`,
    ])
    expect(outputs).toContain('Dez keeps 2 files of the output folder: clip.webm (video clip), picture.dat (image).')
    expect(outputs).toContain('Dez did not keep notes.txt')
    expect(run.result.text.endsWith('\nMade the video clip @d.\nMade the image @e.')).toBe(true)
    await sendChatReply(run.next.reply, CALLER.modelName)

    // Each kept file is a stored file with the bytes that the code left.
    // Its type follows those bytes: the code gave the image no image name.
    const reply = await endedReply(browser)
    const videoName = await newFileIn(browser, videoDir, videosBefore)
    const imageName = await newFileIn(browser, imagesDir, imagesBefore)
    expect(videoName).toMatch(storedFileName('webm'))
    expect(imageName).toMatch(storedFileName('png'))
    const videoPath = path.join(videoDir, videoName)
    const imagePath = path.join(imagesDir, imageName)
    expect(fs.readFileSync(videoPath).equals(WEBM_VIDEO)).toBe(true)
    expect(fs.readFileSync(imagePath).equals(STRIPES_PNG)).toBe(true)
    expect(reply.slice(reply.lastIndexOf('</dez:tool>'))).toBe([
      '</dez:tool>',
      '',
      `<dez:video id="d" type="video/webm" src="${videoPath}" tool="apps" made-by="${run.jobId}"/>`,
      '',
      `![id=e|tool=apps|made-by=${run.jobId}](${imagePath})`,
      '',
      replyText(CALLER.modelName),
    ].join('\n'))
    await waitForValue(browser, 'player of the new clip', async () => (await shownPlayers(browser)).at(-1)?.id, 'd')
    await waitForValue(browser, 'new image', async () => (await shownImages(browser)).at(-1)?.width, 90)

    // The code wrote over its copies, and not over the files of the user.
    expect(fs.readFileSync(files.a).equals(STRIPES_PNG)).toBe(true)
    expect(fs.readFileSync(files.b).equals(STRIPES_PNG)).toBe(true)
    expect(fs.readFileSync(files.c).equals(WEBM_VIDEO)).toBe(true)
    expectNoLinkedFile(requests, linkedDir)
    await expectRunsEnded(setup)
    expect(await consoleErrors(browser)).toStrictEqual([])
  })

  it('hides the image of a run with is_intermediate under the chip of its call, which shows it when it opens', async () => {
    await seedApp(appsDir, { name: 'draft', description: 'Makes a draft.', kind: 'script' }, { 'main.ts': DRAFT_MAIN })
    const before = await filesIn(imagesDir)
    await submit(browser, 'Make a draft.')
    const run = await invoke(await chatRequest(), 'call_draft', { name: 'draft', is_intermediate: true })
    expect(run.result.text).toContain('Dez keeps 1 file of the output folder: draft.png (image).')
    expect(run.result.text.endsWith('\nMade the image @a.')).toBe(true)
    await sendChatReply(run.next.reply, CALLER.modelName)

    // The image is in the reply with the mark of its job, which hides it.
    const reply = await endedReply(browser)
    const imagePath = path.join(imagesDir, await newFileIn(browser, imagesDir, before))
    expect(reply.endsWith(`</dez:tool>\n\n![id=a|tool=apps|made-by=${run.jobId}|hidden=${run.jobId}](${imagePath})\n\n${replyText(CALLER.modelName)}`)).toBe(true)

    // The chip of the `apps` call tells of the image; the `jobs_wait` chip
    // does not, and the image does not show at its place.
    await waitForValue(browser, 'chips after the reply', () => intermediateParts(browser), [hidingPart('image'), null])
    expect(await shownImages(browser)).toStrictEqual([])
    expect(await hiddenAssetNotes(browser)).toStrictEqual([{ text: 'Hidden intermediate image @a. Open its tool call to see it.', visible: false }])

    await pressToolChip(browser, 0)
    await waitForValue(browser, 'image in the panel', async () => (await shownImages(browser)).map(({ width, height }) => ({ width, height })), [{ width: 16, height: 16 }])
    expect(await intermediateParts(browser)).toStrictEqual([revealingPart('image'), null])
    expect(await hiddenPart(browser, 0)).toStrictEqual({ heading: 'Intermediate asset', assets: 1, text: null })
    await expectRunsEnded(setup)
    expect(await consoleErrors(browser)).toStrictEqual([])
  })

  it('starts no job for a call that names no script app, opens no other folder, names the line of an error by its path in the tool, and keeps no file of a run that failed', async () => {
    await seedApp(appsDir, { name: 'one', description: 'Tries to get out.', kind: 'script' }, { 'main.ts': ONE_MAIN })
    await seedApp(appsDir, { name: 'two', description: 'Another app.', kind: 'script' }, { 'main.ts': 'export default () => "two"\n' })
    await seedApp(appsDir, { name: 'page', description: 'A page.', kind: 'ui' }, { 'index.html': '<!doctype html>\n' })
    const before = await filesIn(imagesDir)
    await submit(browser, 'Run the apps.')
    const first = await chatRequest()
    sendToolCalls(first.reply, [appsCall('call_none', 'invoke', { name: 'none' }), appsCall('call_page', 'invoke', { name: 'page' })])

    const second = await chatRequest()
    expect(toolResult(second, 'call_none')).toContain('There is no app /apps/none')
    expect(toolResult(second, 'call_page')).toContain('is a UI app')
    for (const callId of ['call_none', 'call_page']) expect(startedJobId(toolResult(second, callId))).toBeNull()

    const escapes = await invoke(second, 'call_escapes', { name: 'one' })
    expect(escapes.result.text.split('\n')).toStrictEqual(ESCAPES.map(([name, , outcome]) => `${name}: ${outcome}`))
    expect(await filesIn(path.join(appsDir, 'two'))).toStrictEqual(['main.ts', 'manifest.json'])

    const failed = await invoke(escapes.next, 'call_fail', { name: 'one', parameters: { fail: true } })
    expect(failed.result.status).toBe('failed')
    const [lead, error, where] = failed.result.text.split('\n')
    expect(lead).toContain('The code of the app threw an error. Dez kept no file of the run.')
    expect(error).toBe('Error: no luck in /apps/one')
    expect(where).toContain('file:///apps/one/main.ts:4:')
    expect(await filesIn(imagesDir)).toStrictEqual(before)

    await expectReplyEnd(setup, CALLER, failed.next)
    // The app logs each call that it refused.
    expect(await consoleErrors(browser)).toStrictEqual([
      expect.stringContaining('There is no app /apps/none'),
      expect.stringContaining('is a UI app'),
    ])
  })
})
