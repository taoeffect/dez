import fs from 'node:fs'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { APP_RUNS_STATE } from '../../src/model/tools/appInvoke'
import { jobStartedText, jobsWaitResults, jobTimedOutText, startedJobId } from '../../src/model/tools/jobs'
import { appsCall, movingAppFiles, pageFrameCount, pageFrameGuards, seedApp, uiAppFiles } from './harness/apps'
import { consoleErrors, resetConsoleErrors, screenshotOnFailure, waitForValue } from './harness/dom'
import { expectNoLinkedFile, linkedDropDir, openDroppedFiles } from './harness/drops'
import { appFilePath, filesIn, newFileIn, storedFileName, writeTestFile } from './harness/fixtures'
import { colorDistance, decodedImage, generatedImagesDir, pngDataUrl, shownImages, solidPng, STRIPE_COLORS, STRIPES_PNG } from './harness/images'
import { runToolJob, startedJob, waitCall, type EndedJob } from './harness/jobs'
import { expectReplyEnd, expectRunsEnded } from './harness/jsEval'
import { clipTag, monoWav, shownPlayers, WAV_SAMPLE_RATE, WEBM_VIDEO } from './harness/media'
import { startMockProviderApp, takeRequest, type MockProviderApp } from './harness/mockProviderApp'
import { mockChatPath, replyText, sendChatReply, sendToolCalls, toolResult, type HeldRequest, type MockProvider } from './harness/mockServer'
import type { E2EBrowser } from './harness/session'
import { activeConversationId, endedReply, newTab, openSeededConversation, pickModel, submit } from './harness/thread'
import { hiddenAssetNotes, hiddenPart, hidingPart, intermediateParts, pressToolChip, revealingPart } from './harness/toolChips'

// The `invoke` subcommand of the `apps` tool, driven through the real app
// against a mock chat model in this process. Each run is a job of the
// reply.
//
// The app runs the code of a script app in the real Deno of the debug
// build:
// - the app that `init` made runs as it is; code that a model wrote after
//   it imports another file of its app, and keeps its state in a file of
//   the folder of the app from one run to the next;
// - the code gets a copy of each image and clip that the call names, in
//   the order of the call, also of a file that the user linked: a change of
//   a copy changes no file of the user;
// - Dez keeps each image and clip that the code left in the output folder
//   as a new asset of the conversation, in a stored file whose type follows
//   its bytes and not its name, and keeps no other file;
// - with `decode`, the real ffmpeg decodes each clip into the run folder
//   first, and the code reads the samples and the pixels with dez-media;
// - a built-in app runs from the bundle of the debug build, with the
//   decode of its manifest, and writes its result file into the work
//   folder of the conversation;
// - a run with `is_intermediate` hides its asset under the chip of its
//   call;
// - a call that names no app, or an app without the file that a run
//   needs, starts no job; code that threw gives an error result that names
//   the line by its path in the tool (`/apps/<name>/main.ts`), and Dez
//   keeps no file of that run;
// - the code opens no file outside the folder of its app and the work
//   folder of its run: not a file of another app, not the list of the
//   apps, and not a file of the Dez folder. Dez's module loads the main
//   file of an app by a path that it makes, so Deno checks the read
//   permission of each import of the code too (in a `js_eval` run only the
//   OS rule stops an import of a literal path). The audit of all that Deno
//   and the OS rule refuse is js-eval-sandbox.e2e.ts;
// - every work folder is gone after its run.
//
// The app loads the page of a UI app in a frame that the user does not
// see, from the real scheme of the app frames, and calls the handler that
// the page registered with Dez's client script (`~dez.js`):
// - the app that `init` made runs as it is;
// - the page reads each input of its call as a Blob, also a file that the
//   user linked, and no other asset of the conversation;
// - Dez keeps each image and clip that the page saved as a new asset of
//   the conversation, in the order of the saves;
// - the result has the console output of the page, the errors that no
//   code of the page caught, and a save that Dez refused and that the
//   handler did not wait for;
// - a handler that threw gives an error result that names the line by its
//   path in the tool (`/apps/<name>/main.js`); a page with no handler and
//   a page without Dez's script give one that tells what to write; a run
//   that does not end stops at its time limit. Dez keeps no file of those
//   runs;
// - a run whose page goes to another page stops, also when the page goes
//   while it loads, and Dez calls no handler of the other page;
// - the frame of every run is gone after it.
//
// No request holds a path of the test HOME (`takeRequest` checks each one):
// a result names the folder of an app as `/apps/<name>` and the run folder
// as `/run`. No request holds the path or the name of a linked file.
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

// The code of the `decode` app: it reads the decoded files of each input
// with dez-media, and gives their facts, the peak of the samples, and the
// middle pixel of the first frame.
const DECODE_MAIN = [
  'import { f32Samples, rgbFrames } from "dez-media"',
  '',
  'export default async function main(parameters, dez) {',
  '  const runs = []',
  '  for (const { id, audio, frames } of dez.inputs) {',
  '    const run = { id, audio, frames, frozen: Object.isFrozen(frames ?? audio) }',
  '    if (audio) {',
  '      const samples = f32Samples(await Deno.readFile(audio.path))',
  '      run.samples = samples.length',
  '      run.peak = samples.reduce((peak, value) => Math.max(peak, Math.abs(value)), 0)',
  '    }',
  '    if (frames) {',
  '      const read = rgbFrames(await Deno.readFile(frames.path), frames.width, frames.height)',
  '      const middle = (read.width * Math.floor(read.height / 2) + Math.floor(read.width / 2)) * 3',
  '      run.count = read.count',
  '      run.pixel = Array.from(read.data.slice(middle, middle + 3))',
  '    }',
  '    runs.push(run)',
  '  }',
  '  return runs',
  '}',
].join('\n')

// 2 s of a 440 Hz tone at half of full scale: 16-bit mono PCM at 8 kHz.
const TONE_WAV = monoWav(Buffer.from(Int16Array.from(
  { length: 2 * WAV_SAMPLE_RATE },
  (_, index) => Math.round(16384 * Math.sin(2 * Math.PI * 440 * index / WAV_SAMPLE_RATE)),
).buffer), 2)
// 2 s of silence with two bursts of a 500 Hz tone, each 0.2 s: a soft one
// at 0.5 s and a loud one at 1.2 s. A cycle is 16 samples, so each 10 ms
// frame of a burst has the same samples, and the loudest frame is the
// first one of the loud burst.
const BURSTS_WAV = monoWav(Buffer.from(Int16Array.from({ length: 2 * WAV_SAMPLE_RATE }, (_, index) => {
  const at = (seconds: number) => seconds * WAV_SAMPLE_RATE
  const amplitude = index >= at(0.5) && index < at(0.7) ? 8192 : index >= at(1.2) && index < at(1.4) ? 24576 : 0
  return Math.round(amplitude * Math.sin(2 * Math.PI * 500 * index / WAV_SAMPLE_RATE))
}).buffer), 2)
// The color of `WEBM_VIDEO`.
const VIDEO_COLOR = [0x2a, 0x7f, 0xd4]

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

// The script of the page of the `paint` app, a UI app. Its handler reads
// each input of the run as a Blob, draws the image on a canvas of half its
// size and saves the canvas as a PNG, saves the bytes of the clip as they
// are, and tries to read an asset that is no input of the run.
const PAINT_MAIN = [
  'console.log("the page loads")',
  'dez.sbp("sbp/selectors/register", {',
  '  "app/invoke": async (parameters, run) => {',
  '    const facts = []',
  '    const blobs = []',
  '    for (const { id, kind, type } of run.inputs) {',
  '      const blob = await dez.sbp("dez.app/readAsset", id)',
  '      blobs.push(blob)',
  '      facts.push(`${id} ${kind} ${type} ${blob.type} ${blob.size} ${blob instanceof File ? "a file" : "no file"}`)',
  '    }',
  '    const [clip, image] = blobs',
  '    const canvas = document.createElement("canvas")',
  '    canvas.width = 45',
  '    canvas.height = 10',
  '    canvas.getContext("2d").drawImage(await createImageBitmap(image), 0, 0, canvas.width, canvas.height)',
  '    const png = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"))',
  '    const saved = [await dez.sbp("dez.app/saveAsset", png), await dez.sbp("dez.app/saveAsset", await clip.arrayBuffer())]',
  '    const refused = await dez.sbp("dez.app/readAsset", "a").catch((error) => error.message)',
  '    console.log(`step ${parameters.step}`)',
  '    return { facts, saved, refused, page: [innerWidth, innerHeight], frozen: Object.isFrozen(dez) }',
  '  },',
  '})',
].join('\n')

// The script of the page of the `broken` app: its handler saves an image,
// and then throws in a function of the page.
const BROKEN_MAIN = [
  'function check(parameters) {',
  '  throw new RangeError(`no luck with ${parameters.count}`)',
  '}',
  'dez.sbp("sbp/selectors/register", {',
  '  "app/invoke": async (parameters) => {',
  `    await dez.sbp("dez.app/saveAsset", ${PNG_BYTES})`,
  '    check(parameters)',
  '  },',
  '})',
].join('\n')

// The script of the page of the `loose` app. Its handler does not wait
// for its save, which Dez refuses: the bytes are no image and no clip.
// The page also asks for two images that the app does not have (an HTML
// one and an SVG one), loads a script file that throws (`old.js`) without
// `crossorigin`, and its own script ends with an error that nothing
// catches.
const LOOSE_MAIN = [
  'dez.sbp("sbp/selectors/register", {',
  '  "app/invoke": () => {',
  '    dez.sbp("dez.app/saveAsset", new TextEncoder().encode("no image"))',
  '    return "done"',
  '  },',
  '})',
  'document.body.append(Object.assign(new Image(), { src: "none.png" }))',
  'document.body.insertAdjacentHTML("beforeend", \'<svg><image href="none.svg"/></svg>\')',
  'document.body.append(Object.assign(document.createElement("script"), { src: "old.js" }))',
  'missingFunction()',
].join('\n')

// The script of the page of the `stuck` app: its handler saves an image,
// and then never ends.
const STUCK_MAIN = [
  'dez.sbp("sbp/selectors/register", {',
  '  "app/invoke": async () => {',
  `    await dez.sbp("dez.app/saveAsset", ${PNG_BYTES})`,
  '    await new Promise(() => {})',
  '  },',
  '})',
].join('\n')

// The new script of the page of the `hello` app, which `init` made: a
// module that imports three by its name in the import map of the page.
const THREE_MAIN = [
  'import { Vector3 } from "three"',
  '',
  'dez.sbp("sbp/selectors/register", {',
  '  "app/invoke": () => String(new Vector3(1, 2, 2).length()),',
  '})',
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
      `c video video/webm /run/c.webm ${WEBM_VIDEO.length}`,
      `b image image/png /run/b.png ${STRIPES_PNG.length}`,
      `a image image/png /run/a.png ${STRIPES_PNG.length}`,
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

  it('decodes each clip before the run, and the code reads the samples and the pixels with dez-media', async () => {
    await seedApp(appsDir, { name: 'decode', description: 'Reads decoded clips.', kind: 'script' }, { 'main.ts': DECODE_MAIN })
    const { home } = setup.app
    const video = await writeTestFile(appFilePath(home, 'assets', 'generated', 'video', 'decode.webm'), WEBM_VIDEO)
    const tone = await writeTestFile(appFilePath(home, 'assets', 'generated', 'audio', 'decode.wav'), TONE_WAV)
    await openSeededConversation(browser, home, 'apps-invoke-decode', [{
      role: 'user',
      text: [clipTag('video', { id: 'a', type: 'video/webm', src: video }), clipTag('audio', { id: 'b', type: 'audio/wav', src: tone }), 'Read them.'].join('\n'),
    }])
    await pickModel(browser, CALLER.name, CALLER.modelName)
    await submit(browser, '')

    const decode = { audio: { rate: 8000 }, frames: { width: 12, height: 9 } }
    const run = await invoke(await chatRequest(), 'call_decode', { name: 'decode', inputs: '@a @b', decode })
    expect(run.result.status).toBe('finished')
    // The video has no sound, and the audio clip no picture. With no fps,
    // each frame of the clip comes once: 2 s at 5 frames a second.
    const [ofVideo, ofTone] = JSON.parse(run.result.text.split('\n\n')[0]) as Array<Record<string, unknown>>
    expect(ofVideo).toStrictEqual({
      id: 'a',
      audio: null,
      frames: { path: '/run/a.rgb', width: 12, height: 9, fps: 5, count: 10 },
      frozen: true,
      count: 10,
      pixel: expect.any(Array),
    })
    expect(colorDistance(ofVideo.pixel as number[], VIDEO_COLOR)).toBeLessThanOrEqual(8)
    // The tone reaches half of full scale at sample 150.
    expect(ofTone).toStrictEqual({ id: 'b', audio: { path: '/run/b.f32', rate: 8000, count: 16_000 }, frames: null, frozen: true, samples: 16_000, peak: 0.5 })

    await expectReplyEnd(setup, CALLER, run.next)
    await expectRunsEnded(setup)
    expect(await consoleErrors(browser)).toStrictEqual([])
  })

  it('runs the built-in apps dez-onsets and dez-cuts from the bundle, with the decode of their manifests, and each writes its result into the work folder', async () => {
    const { home } = setup.app
    const video = await writeTestFile(appFilePath(home, 'assets', 'generated', 'video', 'built-in.webm'), WEBM_VIDEO)
    const bursts = await writeTestFile(appFilePath(home, 'assets', 'generated', 'audio', 'built-in.wav'), BURSTS_WAV)
    await openSeededConversation(browser, home, 'apps-invoke-built-in', [{
      role: 'user',
      text: [clipTag('video', { id: 'a', type: 'video/webm', src: video }), clipTag('audio', { id: 'b', type: 'audio/wav', src: bursts }), 'Measure them.'].join('\n'),
    }])
    await pickModel(browser, CALLER.name, CALLER.modelName)
    await submit(browser, '')
    const workFolder = appFilePath(home, 'work', await activeConversationId(browser))

    const onsets = await invoke(await chatRequest(), 'call_onsets', { name: 'dez-onsets', inputs: '@b' })
    expect(onsets.result.status).toBe('finished')
    expect(onsets.result.text).toBe([
      '@b (2.000 s): the sound starts at 0.500 s, the loudest moment is at 1.200 s, 2 onsets. In /work/onsets-b.json.',
      'Each file holds id, duration, level, first (where the sound starts), peak, and onsets. Times are in seconds.',
    ].join('\n'))
    expect(JSON.parse(fs.readFileSync(path.join(workFolder, 'onsets-b.json'), 'utf8'))).toStrictEqual({ id: 'b', duration: 2, level: 0.3, first: 0.5, peak: 1.2, onsets: [0.5, 1.2] })

    // The video has one color: no cut. Its file has 5 frames a second.
    const cuts = await invoke(onsets.next, 'call_cuts', { name: 'dez-cuts', inputs: '@a', parameters: { save_to: '/work/video/cuts.json' } })
    expect(cuts.result.status).toBe('finished')
    expect(cuts.result.text.split('\n')[0]).toBe('@a (10 frames, 2.000 s at 5 fps): no cut. In /work/video/cuts.json.')
    expect(JSON.parse(fs.readFileSync(path.join(workFolder, 'video', 'cuts.json'), 'utf8'))).toStrictEqual({ id: 'a', fps: 5, frames: 10, duration: 2, threshold: 0.35, cuts: [] })

    await expectReplyEnd(setup, CALLER, cuts.next)
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

  it('starts no job for a call that names no app that can run, opens no other folder, names the line of an error by its path in the tool, and keeps no file of a run that failed', async () => {
    await seedApp(appsDir, { name: 'one', description: 'Tries to get out.', kind: 'script' }, { 'main.ts': ONE_MAIN })
    await seedApp(appsDir, { name: 'two', description: 'Another app.', kind: 'script' }, { 'main.ts': 'export default () => "two"\n' })
    // A UI app with no page.
    await seedApp(appsDir, { name: 'page', description: 'A page.', kind: 'ui' })
    const before = await filesIn(imagesDir)
    await submit(browser, 'Run the apps.')
    const first = await chatRequest()
    sendToolCalls(first.reply, [appsCall('call_none', 'invoke', { name: 'none' }), appsCall('call_page', 'invoke', { name: 'page' })])

    const second = await chatRequest()
    expect(toolResult(second, 'call_none')).toContain('There is no app /apps/none')
    expect(toolResult(second, 'call_page')).toContain('The app /apps/page has no index.html')
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
      expect.stringContaining('The app /apps/page has no index.html'),
    ])
  })

  it('runs a UI app as init made it, and then its new module, which imports a library that Dez ships, in a frame that is gone after each run', async () => {
    await submit(browser, 'Make a page app.')
    const first = await chatRequest()
    sendToolCalls(first.reply, [appsCall('call_init', 'init', { name: 'hello', kind: 'ui', description: 'Says hello.' })])
    const second = await chatRequest()
    expect(toolResult(second, 'call_init')).toContain('Made the UI app /apps/hello')

    const hello = await invoke(second, 'call_hello', { name: 'hello', parameters: { rows: 2 } })
    expect(hello.started).toBe(`${jobStartedText(hello.jobId, 1)}\nThe run has no input.`)
    expect(hello.result.status).toBe('finished')
    expect(hello.result.call).toStrictEqual({ number: 1, label: 'invoke hello {\'rows\':2}' })
    expect(hello.result.text).toBe('Hello from hello. The parameters of this run: {"rows":2}. The run has 0 input files.')
    expect(await pageFrameCount(browser)).toBe(0)

    // The page of a new UI app loads its main.js as a module, after the
    // import map of the shipped libraries.
    sendToolCalls(hello.next.reply, [appsCall('call_main', 'write', { path: '/apps/hello/main.js', content: THREE_MAIN })])
    const fourth = await chatRequest()
    expect(toolResult(fourth, 'call_main')).toContain('Wrote /apps/hello/main.js')
    const vector = await invoke(fourth, 'call_vector', { name: 'hello' })
    expect(vector.result.status).toBe('finished')
    expect(vector.result.text).toBe('3')
    expect(await pageFrameCount(browser)).toBe(0)

    await expectReplyEnd(setup, CALLER, vector.next)
    expect(await consoleErrors(browser)).toStrictEqual([])
  })

  it('gives the page of a UI app each input as a Blob, also a linked file, and keeps the images and the clips that the page saved', async () => {
    await seedApp(appsDir, { name: 'paint', description: 'Draws its inputs.', kind: 'ui' }, uiAppFiles(PAINT_MAIN))
    const files = await openDroppedFiles(setup, CALLER, linkedDir, 'apps-invoke-ui')
    const imagesBefore = await filesIn(imagesDir)
    const videosBefore = await filesIn(videoDir)
    await submit(browser, ' Paint them.')

    const run = await invoke(await chatRequest(), 'call_paint', { name: 'paint', inputs: '@c @b', parameters: { step: 3 } })
    expect(run.started).toBe(`${jobStartedText(run.jobId, 1)}\nThe inputs of the run, in the order of run.inputs: the video clip @c, the image @b.`)
    expect(run.result.status).toBe('finished')
    const [value, kept, written] = run.result.text.split('\n\n')
    expect(JSON.parse(value)).toStrictEqual({
      // A Blob has the type of its asset, and no name.
      facts: [`c video video/webm video/webm ${WEBM_VIDEO.length} no file`, `b image image/png image/png ${STRIPES_PNG.length} no file`],
      // An asset of a job has no id before a reader takes its result.
      saved: [{ id: null, kind: 'image', type: 'image/png' }, { id: null, kind: 'video', type: 'video/webm' }],
      refused: 'Dez gave no bytes for @a: it is no input of this run. The inputs of this run are the video clip @c, the image @b.',
      // The page has a layout of the size that the help of `invoke` tells.
      page: [1280, 720],
      frozen: true,
    })
    expect(kept).toBe('Dez keeps the 2 files that the app saved, in the order of the saves: image, video clip. The lines at the end give their ids in this order.')
    expect(written).toBe('Console output of the code:\nthe page loads\nstep 3\nMade the image @d.\nMade the video clip @e.')
    await sendChatReply(run.next.reply, CALLER.modelName)

    // Each saved file is a stored file, in the order of the saves.
    const reply = await endedReply(browser)
    const imagePath = path.join(imagesDir, await newFileIn(browser, imagesDir, imagesBefore))
    const videoPath = path.join(videoDir, await newFileIn(browser, videoDir, videosBefore))
    expect(path.basename(imagePath)).toMatch(storedFileName('png'))
    expect(path.basename(videoPath)).toMatch(storedFileName('webm'))
    expect(reply.slice(reply.lastIndexOf('</dez:tool>'))).toBe([
      '</dez:tool>',
      '',
      `![id=d|tool=apps|made-by=${run.jobId}](${imagePath})`,
      '',
      `<dez:video id="e" type="video/webm" src="${videoPath}" tool="apps" made-by="${run.jobId}"/>`,
      '',
      replyText(CALLER.modelName),
    ].join('\n'))
    // The image is what the page drew: the stripes of the linked image, at
    // half the size.
    const drawn = await decodedImage(browser, pngDataUrl(fs.readFileSync(imagePath)), [7, 22, 37])
    expect({ width: drawn.width, height: drawn.height }).toStrictEqual({ width: 45, height: 10 })
    expect(drawn.pixels.map((pixel, index) => colorDistance(pixel, STRIPE_COLORS[index]) <= 4)).toStrictEqual([true, true, true])
    expect(fs.readFileSync(videoPath).equals(WEBM_VIDEO)).toBe(true)
    await waitForValue(browser, 'new image', async () => (await shownImages(browser)).at(-1)?.width, 45)
    await waitForValue(browser, 'player of the new clip', async () => (await shownPlayers(browser)).at(-1)?.id, 'e')

    // The page got bytes, and no file of the user changed.
    expect(fs.readFileSync(files.b).equals(STRIPES_PNG)).toBe(true)
    expect(fs.readFileSync(files.c).equals(WEBM_VIDEO)).toBe(true)
    expectNoLinkedFile(requests, linkedDir)
    expect(await pageFrameCount(browser)).toBe(0)
    await expectRunsEnded(setup)
    expect(await consoleErrors(browser)).toStrictEqual([])
  })

  it('tells a model why a run of a UI app failed, with the errors of its page, and keeps no file of that run', async () => {
    await seedApp(appsDir, { name: 'bare', description: 'Has no handler.', kind: 'ui' }, uiAppFiles('console.warn("this page registers nothing")\n'))
    await seedApp(appsDir, { name: 'plain', description: 'Has no script of Dez.', kind: 'ui' }, { 'index.html': '<!doctype html>\n<p>A page.</p>\n' })
    await seedApp(appsDir, { name: 'broken', description: 'Throws.', kind: 'ui' }, uiAppFiles(BROKEN_MAIN))
    await seedApp(appsDir, { name: 'loose', description: 'Waits for nothing.', kind: 'ui' }, { ...uiAppFiles(LOOSE_MAIN), 'old.js': 'otherMissing()\n' })
    const before = await filesIn(imagesDir)
    await submit(browser, 'Run the pages.')

    // A page that registered no handler; its console output is in the
    // result.
    const bare = await invoke(await chatRequest(), 'call_bare', { name: 'bare' })
    expect(bare.result.status).toBe('failed')
    expect(bare.result.text).toContain('The page of the app has no handler for a run. Dez kept no file of the run.')
    expect(bare.result.text.endsWith('\n\nConsole output of the code:\nthis page registers nothing')).toBe(true)

    // A page that does not load Dez's script never answers.
    const plain = await invoke(bare.next, 'call_plain', { name: 'plain' })
    expect(plain.result.status).toBe('failed')
    expect(plain.result.text).toContain('The page of the app loaded, but it did not answer Dez. Dez kept no file of the run.')
    expect(plain.result.text).toContain('<script src="~dez.js"></script>')

    // A handler that threw: the error names its lines by the path of the
    // file in the tool, and the file that the page saved before is gone.
    const broken = await invoke(plain.next, 'call_broken', { name: 'broken', parameters: { count: 3 } })
    expect(broken.result.status).toBe('failed')
    const [lead, error, ...stack] = broken.result.text.split('\n')
    expect(lead).toBe('The code of the app threw an error. Dez kept no file of the run. The error:')
    expect(error).toBe('RangeError: no luck with 3')
    expect(stack[0]).toBe('check@/apps/broken/main.js:2:23')
    expect(stack[1]).toMatch(/\/apps\/broken\/main\.js:7:\d+$/)
    expect(broken.result.text).not.toContain('dezapp:')
    expect(broken.result.text).not.toContain('~dez.js')
    await waitForValue(browser, 'the images after the run that failed', () => filesIn(imagesDir), before)

    // A run that ended with no error tells of the errors that no code of
    // the page caught: the error of a script, the files that did not load
    // (also by the URL of an SVG element), and the save that Dez refused
    // and that the handler did not wait for. The webview hides the error
    // of a script file that the page loaded without `crossorigin`: the
    // result tells how to get it.
    const loose = await invoke(broken.next, 'call_loose', { name: 'loose' })
    expect(loose.result.status).toBe('finished')
    const [returned, log] = loose.result.text.split('\n\nConsole output of the code:\n')
    expect(returned).toBe('done')
    expect(log).toContain('Uncaught ReferenceError: Can\'t find variable: missingFunction\nglobal code@/apps/loose/main.js:10:16')
    expect(log).toContain('The page could not load /apps/loose/none.png')
    expect(log).toContain('The page could not load /apps/loose/none.svg')
    expect(log).toContain('Uncaught error in a script file of the page. The webview hides its details, because the page loads that file without `crossorigin`.')
    expect(log).not.toContain('otherMissing')
    expect(log).toContain('Uncaught (in a promise) Error: Dez saved nothing: the bytes are no file of a type that Dez stores.')
    expect(log).toContain('app/invoke@/apps/loose/main.js:3:12')
    expect(log).not.toContain('dezapp:')

    await expectReplyEnd(setup, CALLER, loose.next)
    expect(await filesIn(imagesDir)).toStrictEqual(before)
    expect(await pageFrameCount(browser)).toBe(0)
    // A refused save is no error of Dez.
    expect(await consoleErrors(browser)).toStrictEqual([])
  })

  it('stops a run of a UI app whose page goes to the page of another app, in its handler or while it loads, and calls no handler of that page', async () => {
    await seedApp(appsDir, { name: 'echo', description: 'Answers.', kind: 'ui' }, uiAppFiles('dez.sbp("sbp/selectors/register", { "app/invoke": () => "echo ran" })\n'))
    // The frame of this run loads a second time.
    await seedApp(appsDir, { name: 'late', description: 'Goes away in its run.', kind: 'ui' }, uiAppFiles([
      'dez.sbp("sbp/selectors/register", {',
      '  "app/invoke": () => {',
      '    location.href = "../echo/index.html"',
      '    return new Promise(() => {})',
      '  },',
      '})',
      '',
    ].join('\n')))
    // The frame of this run loads only once, with the page of `echo`.
    await seedApp(appsDir, { name: 'hop', description: 'Goes away at once.', kind: 'ui' }, movingAppFiles('echo'))
    const stopped = 'Dez stopped the app: its page loaded again, or went to another page. Dez kept no file of the run.'
    await submit(browser, 'Run the pages.')

    // The page of `echo` answers a run of its own app.
    const echo = await invoke(await chatRequest(), 'call_echo', { name: 'echo' })
    expect({ status: echo.result.status, text: echo.result.text }).toStrictEqual({ status: 'finished', text: 'echo ran' })

    const late = await invoke(echo.next, 'call_late', { name: 'late' })
    expect(late.result.status).toBe('failed')
    expect(late.result.text).toContain(stopped)

    const hop = await invoke(late.next, 'call_hop', { name: 'hop' })
    expect(hop.result.status).toBe('failed')
    expect(hop.result.text).toContain(stopped)

    await expectReplyEnd(setup, CALLER, hop.next)
    expect(await pageFrameCount(browser)).toBe(0)
    expect(await consoleErrors(browser)).toStrictEqual([])
  })

  it('stops a run of a UI app that does not end at its time limit, closes its frame, and deletes the file that its page saved', async () => {
    await seedApp(appsDir, { name: 'stuck', description: 'Never ends.', kind: 'ui' }, uiAppFiles(STUCK_MAIN))
    const before = await filesIn(imagesDir)
    await submit(browser, 'Run the page.')
    const first = await chatRequest()
    sendToolCalls(first.reply, [appsCall('call_stuck', 'invoke', { name: 'stuck', timeout_seconds: 10 })])
    const second = await chatRequest()
    const jobId = startedJob(second, 'call_stuck')

    // While the run goes on, its frame is in the page with the size of a
    // run, and the user does not see it. It is a sandboxed frame of the
    // scheme of the app frames, as a frame of the editor is.
    await newFileIn(browser, imagesDir, before)
    expect(await pageFrameGuards(browser)).toStrictEqual([{ sandbox: 'allow-scripts', src: 'dezapp://localhost/stuck/index.html' }])
    expect(await browser.execute(() => Array.from(document.querySelectorAll('iframe'), (frame) => {
      const { width, height } = frame.getBoundingClientRect()
      return { width, height, visibility: getComputedStyle(frame).visibility, inert: frame.closest<HTMLElement>('[inert]') !== null }
    }))).toStrictEqual([{ width: 1280, height: 720, visibility: 'hidden', inert: true }])

    sendToolCalls(second.reply, [waitCall('call_wait')])
    // The wait is longer than `waitForValue` takes.
    await browser.waitUntil(async () => setup.mock.hasWaitingRequest(), { timeout: 30_000, interval: 100, timeoutMsg: 'the job did not end at its time limit' })
    const third = await chatRequest()
    expect(jobsWaitResults(toolResult(third, 'call_wait')).map(({ id, status, text }) => ({ id, status, text }))).toStrictEqual([
      { id: jobId, status: 'timed out', text: jobTimedOutText(10_000, APP_RUNS_STATE) },
    ])
    expect(await pageFrameCount(browser)).toBe(0)
    await waitForValue(browser, 'the images after the time limit', () => filesIn(imagesDir), before)

    await expectReplyEnd(setup, CALLER, third)
    expect(await consoleErrors(browser)).toStrictEqual([])
  })
})
