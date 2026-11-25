import fs from 'node:fs'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { toolBlockText } from '../../src/model/chat/toolBlocks'
import { ASSET_INFO_COLUMNS } from '../../src/model/tools/assetInfo'
import { PICTURES_SHOWN_NOTE } from '../../src/model/tools/assetView'
import { jobStartedText, jobsWaitResults, startedJobId } from '../../src/model/tools/jobs'
import { CODE_RUNS_STATE, codeRunsAsJobText, codeTimedOutText } from '../../src/model/tools/jsEval'
import { byteSizeText } from '../../src/utils/byteSize'
import { consoleErrors, pointerClick, resetConsoleErrors, screenshotOnFailure, waitForValue } from './harness/dom'
import { expectNoLinkedFile, linkedDropDir, openDroppedFiles } from './harness/drops'
import { appFilePath, conversationFilePath, filesIn, newFileIn, workDir } from './harness/fixtures'
import { generatedImagesDir, shownImages, STRIPES_PNG } from './harness/images'
import { NO_JOBS_LIST_TEXT, runToolJob, startedJob, waitCall } from './harness/jobs'
import { codeResult, evalCall, expectReplyEnd as expectEnd, expectRunsEnded, runTime, thrownError, withoutRunTime } from './harness/jsEval'
import { shownPlayers, WEBM_VIDEO } from './harness/media'
import { startMockProviderApp, takeRequest, type MockProviderApp } from './harness/mockProviderApp'
import { mockChatPath, openAiToolCall, replyText, sendChatReply, sendToolCalls, toolResult, type HeldRequest, type MockProvider } from './harness/mockServer'
import { processExists, runningProgram } from './harness/processes'
import { mediaFacts, pixelColors } from './harness/programs'
import type { E2EBrowser } from './harness/session'
import { activeConversationId, activeTabId, endedReply, newTab, openSeededConversation, openToasts, sbpCall, submit } from './harness/thread'
import { codePanel, hiddenPart, hidingPart, intermediateParts, pressToolChip, revealingPart, toolChips, toolPanel } from './harness/toolChips'

// The `js_eval` tool, driven through the real app against a mock chat model
// in this process. The app runs the code of each call in the real Deno of
// the debug build, as a job of the reply that the call waits for, for at
// most 1 second:
// - the result of a call is the value that the code returned (a string as
//   it is, data as JSON, any other value as Deno shows it, also data with a
//   value in it that JSON loses), then the console output of the code, then
//   how long the code ran; the code can be TypeScript, it can load a
//   built-in module, it has the time zone of the app, and a timer that it
//   leaves does not hold the call;
// - code that threw gives an error result that names the lines of the code
//   as lines of `/run/code.ts`, with the causes of the error; a syntax
//   error, a static `import`, a refused permission, and a refused package
//   each get the text that tells the model what to do;
// - code that ended before it returned a value, and code that Dez stopped
//   at the time limit of its call, give an error result, and the chip of
//   such a call shows that it failed; code that returned no value gives a
//   result that tells so, and no error;
// - code that does not end within that wait goes on as a job of the reply,
//   whose result and files the model gets with `jobs_wait`; a run that
//   ended within the wait took no job number; Stop hands the job of such a
//   run on, and the close of its tab ends its code;
// - every run folder is gone after its call;
// - the code gets a copy of each input of its call (`inputs`), also of a
//   linked file, and Dez keeps each image and clip that the code leaves in
//   the output folder, under the name of the tool; the code draws text with
//   skia-canvas and the fonts that Dez ships (`dez.fonts`), and Dez encodes
//   a frame sequence that it wrote with dez-media/frames into one clip;
// - the code of each call gets the work folder of its conversation as
//   `dez.workFolder`, which the model reads as `/work`: a file that one call
//   wrote there is there for the next call, and a delete of the
//   conversation in History deletes the folder;
// - the code of a call runs the other Dez tools with `dez.sbp`, in both
//   forms of a call, on the files that the user dropped (a stored image, a
//   linked image, a linked clip) by their ids: it gets the result text of
//   each tool, and the error of a tool as an error that it can catch. An
//   image that a call made has a handle (`&1`), which the next call of the
//   code can name; the image goes into the reply with the name of its
//   tool, and the result gives the id of each handle. An `asset_view` call
//   of the code shows the model no picture;
// - a job that the code started is a job of the job of the call: the code
//   can wait for it, and its image is then an asset of the run; the result
//   of the call names each job that is still open, and the model gets the
//   result of such a job with `jobs_wait`. The code can run an app (the
//   built-in app dez-chart) with `apps invoke`, as such a job;
// - the panel of the chip of a call shows its code, and each tool call
//   that the code made with its arguments and what the code got from it;
//   the chip hides the image of a job that the code started with
//   `is_intermediate`, and its panel shows it. A saved call shows the same
//   list, with a tool call that the end of the code cut.
// No request holds a path of the test HOME (`takeRequest` checks each one):
// the run folder and the work folder of each run are in that HOME, and Deno
// names the run folder in an error stack, in `import.meta.url`, and in
// `Deno.cwd()`. No request holds the path or the name of a linked file.
//
// One app session serves the whole file; each test starts in a new tab. A
// test that needs a job makes its code wait more than 1 second; the code of
// the others ends well within the wait. A bundled program (ffmpeg, ffprobe)
// can start slowly on a busy computer, so the code of a run that must end
// within the wait never waits for one: a tool call of the code that runs
// such a program is in a run that is a job, or the code does not wait for
// the job of the call.

const CALLER: MockProvider = { id: 'caller', name: 'Caller Mock', modelId: 'caller-model', modelName: 'Caller Model' }
const CHAT_PATH = mockChatPath(CALLER)

// The time zone of the app under test: one that no CI machine has, so the
// code of a call can only have it from the app.
const APP_TIME_ZONE = 'Asia/Tokyo'

// The size, the frames a second, and the count of the frames of the frame
// sequence that the code of a call writes, and the color of its pixels,
// with half alpha.
const GLOW = { width: 64, height: 36, fps: 12, count: 12 }
const GLOW_COLOR = [255, 128, 0, 128]

// The data file that the code of a call writes into the work folder, for
// the chart of the built-in app dez-chart: a label column and two series.
const SALES_CSV = 'month,sales,cost\nJan,3,1\nFeb,5,2\nMar,2,2\nApr,8,3\n'

describe('js_eval tool', () => {
  let setup: MockProviderApp
  let browser: E2EBrowser
  let workRoot: string
  let imagesDir: string
  let videoDir: string
  // A folder that is not in the test HOME, so that the app links a file of
  // it in place.
  let linkedDir: string

  const chatRequest = (): Promise<HeldRequest> => takeRequest(setup, CHAT_PATH)

  const expectReplyEnd = (request: HeldRequest): Promise<void> => expectEnd(setup, CALLER, request)

  // The state of each tool call chip of the active editor, in doc order.
  const chipStates = async (): Promise<Array<string | null>> => (await toolChips(browser)).map(({ state }) => state)

  // The images that the tools of a reply made, from the text `reply` of its
  // section, in its order: the id and the marks of each reference, and
  // whether its file is a stored file of the generated images.
  function madeImages (reply: string): Array<{ id: string, marks: string, stored: boolean }> {
    return [...reply.matchAll(/!\[id=([a-z]+)\|([^\]]+)\]\(([^)\s]+)\)/g)]
      .map(([, id, marks, file]) => ({ id, marks, stored: path.dirname(file) === imagesDir && fs.existsSync(file) }))
  }

  beforeAll(async () => {
    linkedDir = await linkedDropDir('js-eval')
    setup = await startMockProviderApp(CALLER, {}, { env: { TZ: APP_TIME_ZONE } })
    browser = setup.browser
    workRoot = workDir(setup.app.home)
    imagesDir = generatedImagesDir(setup.app.home)
    videoDir = appFilePath(setup.app.home, 'assets', 'generated', 'video')
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
    if (linkedDir) await fs.promises.rm(linkedDir, { recursive: true, force: true })
  })

  it('gives the value that the code of a call returned, then its console output', async () => {
    await submit(browser, 'Do the math.')
    const first = await chatRequest()
    sendToolCalls(first.reply, [
      // Exact: 2 ** 64 as a number is 18446744073709552000.
      evalCall('call_exact', 'return 2n ** 64n'),
      evalCall('call_text', 'return ["one", "two"].join("\\n")'),
      // TypeScript, with a built-in module of Node.
      evalCall('call_data', [
        'interface Point { x: number, y: number }',
        'const point: Point = { x: 3, y: 4 }',
        'console.log("the point", point)',
        'const { createHash } = await import("node:crypto")',
        'console.error("a warning")',
        'return { length: Math.hypot(point.x, point.y), hash: createHash("sha256").update("dez").digest("hex").length }',
      ].join('\n')),
      // JSON would give `{}` for the `Map` and the `Set`, and `null` for
      // `NaN`; a `Date` in data that JSON keeps whole stays JSON.
      evalCall('call_lost', 'return { counts: new Map([["a", 3]]), unique: new Set([1]), list: [1, NaN] }'),
      evalCall('call_date', 'return { when: new Date(0) }'),
      evalCall('call_place', 'return [Deno.cwd(), import.meta.url, Intl.DateTimeFormat().resolvedOptions().timeZone].join(" ")'),
      // Without the end that Dez gives the run, the timer would hold the
      // call until its time limit.
      evalCall('call_timer', 'setInterval(() => {}, 1000)\nreturn "done"'),
      evalCall('call_none', 'const unused = 1'),
    ])

    const second = await chatRequest()
    expect(codeResult(second, 'call_exact')).toBe('18446744073709551616n')
    expect(codeResult(second, 'call_text')).toBe('one\ntwo')
    expect(codeResult(second, 'call_data')).toBe('{\n  "length": 5,\n  "hash": 64\n}\n\nConsole output of the code:\nthe point { x: 3, y: 4 }\na warning')
    expect(codeResult(second, 'call_lost')).toBe('{ counts: Map(1) { "a" => 3 }, unique: Set(1) { 1 }, list: [ 1, NaN ] }')
    expect(codeResult(second, 'call_date')).toBe('{\n  "when": "1970-01-01T00:00:00.000Z"\n}')
    expect(codeResult(second, 'call_place')).toBe(`/run file:///run/code.ts ${APP_TIME_ZONE}`)
    expect(codeResult(second, 'call_timer')).toBe('done')
    expect(codeResult(second, 'call_none')).toBe('The code returned no value, and it wrote nothing to the console. Give the result with `return`.')
    await expectReplyEnd(second)
    await waitForValue(browser, 'chip states', chipStates, Array(8).fill('success'))
    expect(await consoleErrors(browser)).toStrictEqual([])
  })

  it('gives the error of code that threw with the lines of the code, and tells what the code cannot do', async () => {
    await submit(browser, 'Run the code.')
    const first = await chatRequest()
    sendToolCalls(first.reply, [
      evalCall('call_throw', [
        'function check(value) {',
        '  if (value > 1) throw new RangeError("too large", { cause: new Error("the cause") })',
        '}',
        'check(2)',
      ].join('\n')),
      evalCall('call_syntax', 'const x = ;'),
      evalCall('call_import', 'import { readFileSync } from "node:fs"\nreturn 1'),
      // Deno refuses each one before it opens a connection: the mock server
      // of the spec gets no request, and the package name goes to no
      // registry.
      evalCall('call_fetch', `return (await fetch("${setup.mock.url}/")).status`),
      evalCall('call_package', 'return await import("npm:left-pad")'),
      // An error that the code did not await ends Deno, with no value.
      evalCall('call_late', 'setTimeout(() => { throw new Error("late failure") }, 0)\nawait new Promise((resolve) => setTimeout(resolve, 5000))\nreturn 1'),
    ])

    const second = await chatRequest()
    const thrown = thrownError(toolResult(second, 'call_throw'))
    expect(thrown.startsWith('RangeError: too large\n    at check (file:///run/code.ts:2:')).toBe(true)
    expect(thrown).toContain('\n    at default (file:///run/code.ts:4:')
    expect(thrown).toContain('\nCaused by: Error: the cause\n    at check (file:///run/code.ts:2:')
    // No line of the module of Dez, which the model did not write.
    expect(thrown).not.toContain('runner.js')

    const syntax = thrownError(toolResult(second, 'call_syntax'))
    expect(syntax).toContain('Expression expected')
    expect(syntax).toContain('file:///run/code.ts:1:')

    const noFlag = 'No flag changes these limits, and you can set no flag: do the work within the limits.'
    expect(toolResult(second, 'call_import')).toContain('a static `import` does not work in it.')
    const fetched = thrownError(toolResult(second, 'call_fetch'))
    expect(fetched.startsWith(`NotCapable: Requires net access to "${new URL(setup.mock.url).host}"`)).toBe(true)
    expect(fetched).toContain(noFlag)
    const packaged = toolResult(second, 'call_package')
    expect(packaged).toContain('--no-npm')
    expect(packaged).toContain(noFlag)

    const late = toolResult(second, 'call_late')
    expect(late).toContain('ended before it returned a value (exit code 1).')
    expect(late).toContain('\n\nConsole output of the code:\n')
    expect(late).toContain('late failure')
    expect(late).toContain('file:///run/code.ts:1:')
    await expectReplyEnd(second)
    await waitForValue(browser, 'chip states', chipStates, Array(6).fill('error'))
  })

  it('stops code that runs longer than the time limit of its call', async () => {
    await submit(browser, 'Count.')
    const first = await chatRequest()
    // The shortest limit that the tool takes.
    sendToolCalls(first.reply, [evalCall('call_loop', 'console.log("started")\nfor (;;) {}', { timeout_seconds: 1 })])

    const second = await chatRequest()
    // The stop ends the job of the run, which keeps no console output. The
    // limit is as long as the wait of the call: the call gets the end of
    // the run, not a job.
    expect(codeResult(second, 'call_loop')).toBe(codeTimedOutText(1000, CODE_RUNS_STATE))
    await expectReplyEnd(second)
    await waitForValue(browser, 'chip states', chipStates, ['error'])
  })

  it('runs code that does not end within 1 second on as a job: Stop hands the job on, and the close of the tab ends the code and deletes its run folder', async () => {
    await submit(browser, 'Wait.')
    const tabId = await activeTabId(browser)
    const first = await chatRequest()
    sendToolCalls(first.reply, [evalCall('call_wait', 'await new Promise((resolve) => setTimeout(resolve, 280_000))', { timeout_seconds: 300 })])
    const second = await chatRequest()
    const started = toolResult(second, 'call_wait')
    expect(started).toBe(codeRunsAsJobText(String(startedJobId(started)), 1))
    const program = await runningProgram(browser, workRoot)

    // While a reply runs, the Submit button stops it. Its job goes on for
    // the next reply of the tab.
    await pointerClick(browser, '.submit-button')
    await endedReply(browser)
    expect(processExists(program)).toBe(true)

    await sbpCall(browser, 'dez.controller/closeTab', tabId)

    await waitForValue(browser, 'the program of the call runs', async () => processExists(program), false)
    await waitForValue(browser, 'work folders', () => filesIn(workRoot), [])
    expect(setup.mock.hasWaitingRequest()).toBe(false)
    expect(await openToasts(browser, 'error')).toStrictEqual([])
    // A stop is no failure of the tool.
    expect(await consoleErrors(browser)).toStrictEqual([])
  })

  it('keeps the files that the code writes to the work folder of the conversation for the next call, and deletes the folder with the conversation', async () => {
    await submit(browser, 'Keep a note.')
    const conversationId = await activeConversationId(browser)
    const folder = appFilePath(setup.app.home, 'work', conversationId)
    const first = await chatRequest()
    sendToolCalls(first.reply, [evalCall('call_write', 'await Deno.writeTextFile(`${dez.workFolder}/note.txt`, "kept")\nreturn dez.workFolder')])

    const second = await chatRequest()
    expect(codeResult(second, 'call_write')).toBe('/work')
    sendToolCalls(second.reply, [evalCall('call_read', 'return await Deno.readTextFile(`${dez.workFolder}/note.txt`)')])

    const third = await chatRequest()
    expect(codeResult(third, 'call_read')).toBe('kept')
    await expectReplyEnd(third)
    expect(await filesIn(folder)).toStrictEqual(['note.txt'])
    await waitForValue(browser, 'saved conversation', async () => fs.existsSync(conversationFilePath(setup.app.home, conversationId)), true)

    await sbpCall(browser, 'dez.controller/deleteConversation', conversationId)

    await waitForValue(browser, 'work folder of the conversation', async () => fs.existsSync(folder), false)
    expect(fs.existsSync(conversationFilePath(setup.app.home, conversationId))).toBe(false)
    expect(await consoleErrors(browser)).toStrictEqual([])
  })

  it('gives the code a copy of each input of its call, also of a linked file, and keeps the images that it leaves in the output folder', async () => {
    const files = await openDroppedFiles(setup, CALLER, linkedDir, 'inputs')
    const before = await filesIn(imagesDir)
    await submit(browser, ' Copy one.')
    const first = await chatRequest()
    sendToolCalls(first.reply, [evalCall('call_inputs', [
      'const facts = []',
      'for (const { id, kind, type, path } of dez.inputs) facts.push(`${id} ${kind} ${type} ${path} ${(await Deno.stat(path)).size}`)',
      'await Deno.copyFile(dez.inputs[1].path, `${dez.outputFolder}/copy.png`)',
      'await Deno.writeTextFile(`${dez.outputFolder}/notes.txt`, "no image")',
      'for (const { path } of dez.inputs) await Deno.writeTextFile(path, "changed by the code")',
      'return facts.join("\\n")',
    ].join('\n'), { inputs: '@c @b' })])

    const second = await chatRequest()
    const result = codeResult(second, 'call_inputs')
    // The inputs are in the order of the call, each a copy in the run
    // folder.
    expect(result.split('\n\n')[0].split('\n')).toStrictEqual([
      `c video video/webm /run/c.webm ${WEBM_VIDEO.length}`,
      `b image image/png /run/b.png ${STRIPES_PNG.length}`,
    ])
    expect(result).toContain('Dez keeps 1 file of the output folder: copy.png (image).')
    expect(result).toContain('Dez did not keep notes.txt')
    expect(result.endsWith('\nMade the image @d.')).toBe(true)
    await sendChatReply(second.reply, CALLER.modelName)

    // The kept file is a stored file with the bytes that the code left. No
    // tool call made it, so it has the name of the tool of the call, and no
    // mark of a job.
    const reply = await endedReply(browser)
    const image = fs.readFileSync(path.join(imagesDir, await newFileIn(browser, imagesDir, before)))
    expect(image.equals(STRIPES_PNG)).toBe(true)
    expect(madeImages(reply)).toStrictEqual([{ id: 'd', marks: 'tool=js_eval', stored: true }])
    // The code wrote over its copies, and not over the files of the user.
    expect(fs.readFileSync(files.b).equals(STRIPES_PNG)).toBe(true)
    expect(fs.readFileSync(files.c).equals(WEBM_VIDEO)).toBe(true)
    expectNoLinkedFile([first, second], linkedDir)
    await expectRunsEnded(setup)
    expect(await consoleErrors(browser)).toStrictEqual([])
  })

  it('draws text with skia-canvas and the fonts that Dez ships, and encodes a frame sequence of dez-media/frames into one clip with the alpha of each pixel, in a run that goes on as a job: jobs_wait gives its result, its run time, and its files', async () => {
    const imagesBefore = await filesIn(imagesDir)
    const videosBefore = await filesIn(videoDir)
    await submit(browser, 'Draw a title.')
    const first = await chatRequest()
    const { jobId, started, result: drawn, next } = await runToolJob(chatRequest, first, 'js_eval', 'call_draw', evalCall('call_draw', [
      // More than the 1 second that the call waits for the run.
      'await new Promise((resolve) => setTimeout(resolve, 1500))',
      'const { Canvas } = await import("skia-canvas")',
      'const { useShippedFonts } = await import("dez-media/canvas")',
      'const { FrameWriter } = await import("dez-media/frames")',
      'const families = useShippedFonts(dez.fonts)',
      'const canvas = new Canvas(240, 64, { gpu: false })',
      'const ctx = canvas.getContext("2d")',
      'ctx.fillStyle = "white"',
      'ctx.fillRect(0, 0, canvas.width, canvas.height)',
      'ctx.fillStyle = "black"',
      'ctx.font = `bold 28px ${families}`',
      'ctx.fillText("Dez 日本 مرحبا", 8, 44)',
      'const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height)',
      'let ink = 0',
      'for (let index = 0; index < data.length; index += 4) if (data[index] < 128) ink += 1',
      'await canvas.toFile(`${dez.outputFolder}/title.png`)',
      `const { width, height, fps, count } = ${JSON.stringify(GLOW)}`,
      'const frames = new FrameWriter(dez.outputFolder, "glow", { fps, width, height, alpha: true })',
      'const pixels = new Uint8Array(width * height * 4)',
      `for (let index = 0; index < pixels.length; index += 4) pixels.set(${JSON.stringify(GLOW_COLOR)}, index)`,
      'for (let frame = 0; frame < count; frame += 1) frames.add(pixels)',
      'return { ink, first: families.split(", ")[0], frames: frames.end() }',
    ].join('\n')))
    expect(started).toBe(codeRunsAsJobText(jobId, 1))
    expect({ status: drawn.status, number: drawn.call.number }).toStrictEqual({ status: 'finished', number: 1 })
    // The run time counts the wait of the code.
    expect(Number.parseFloat(runTime(drawn.text))).toBeGreaterThanOrEqual(1.5)

    const result = withoutRunTime(drawn.text)
    const { ink, first: family, frames } = JSON.parse(result.split('\n\n')[0]) as { ink: number, first: string, frames: number }
    expect({ family, frames }).toStrictEqual({ family: '"Noto Sans"', frames: GLOW.count })
    expect(ink).toBeGreaterThan(300)
    expect(result).toContain(`Dez keeps 2 files of the output folder: glow.frames/ (video clip: ${GLOW.count} frames, PNG in MOV with alpha), title.png (image).`)
    expect(result.endsWith('\nMade the video clip @a.\nMade the image @b.')).toBe(true)
    await sendChatReply(next.reply, CALLER.modelName)

    // The files of the run have the mark of its job.
    const reply = await endedReply(browser)
    expect(madeImages(reply)).toStrictEqual([{ id: 'b', marks: `tool=js_eval|made-by=${jobId}`, stored: true }])
    const picture = fs.readFileSync(path.join(imagesDir, await newFileIn(browser, imagesDir, imagesBefore)))
    expect([picture.readUInt32BE(16), picture.readUInt32BE(20)]).toStrictEqual([240, 64])
    // The clip has each frame of the sequence once, and each pixel as the
    // code wrote it, with its alpha.
    const clip = path.join(videoDir, await newFileIn(browser, videoDir, videosBefore))
    expect(mediaFacts(setup.app, clip)).toStrictEqual({ streams: [`video png ${GLOW.width}x${GLOW.height}`], seconds: GLOW.count / GLOW.fps })
    expect(pixelColors(setup.app, clip)).toStrictEqual([GLOW_COLOR.join(',')])
    await waitForValue(browser, 'player of the clip', async () => (await shownPlayers(browser)).at(-1)?.id, 'a')
    await expectRunsEnded(setup)
    expect(await consoleErrors(browser)).toStrictEqual([])
  })

  it('runs the Dez tools that the code of a call names with dez.sbp, on a stored image and on linked files: their results, their images with handles, and their errors, but no picture', async () => {
    await openDroppedFiles(setup, CALLER, linkedDir, 'bridge')
    await submit(browser, ' Work on them.')
    const first = await chatRequest()
    const badCall = 'dez.sbp("dez.tools/image/scale", { image: "zz", width: 4 })'
    sendToolCalls(first.reply, [
      // A tool that runs a bundled program itself (ffprobe, for the clip).
      // The program can start slowly on a busy computer, so the code waits
      // more than the 1 second wait of its call first: the run is always
      // a job.
      evalCall('call_facts', [
        'await new Promise((resolve) => setTimeout(resolve, 1500))',
        'return await dez.sbp("dez.tools/asset_info", { assets: "@a @b @c" })',
      ].join('\n')),
      // The two forms of a call of a subcommand. The second call names the
      // image that the first one made by its handle.
      evalCall('call_images', [
        'const flipped = await dez.sbp("dez.tools/image/flip", { image: "b", direction: "horizontal" })',
        'const [, handle] = /^Made the image @(&\\d+) /.exec(flipped)',
        'return await dez.sbp("dez.tools/image", { command: "scale", parameters: JSON.stringify({ image: handle, width: 45 }) })',
      ].join('\n')),
      evalCall('call_view', 'return await dez.sbp("dez.tools/asset_view", { assets: "@b" })'),
      evalCall('call_caught', [
        'let failure',
        'try {',
        `  await ${badCall}`,
        '} catch (error) {',
        '  failure = `${error.name}: ${error.message}`',
        '}',
        // A call with no arguments, after a call that failed.
        'return [failure, await dez.sbp("dez.tools/jobs_list")].join("\\n")',
      ].join('\n')),
      evalCall('call_thrown', `const unused = 1\nawait ${badCall}`),
    ])

    const second = await chatRequest()
    const pngSize = byteSizeText(STRIPES_PNG.length)
    const factsJob = startedJob(second, 'call_facts')
    expect(toolResult(second, 'call_facts')).toBe(codeRunsAsJobText(factsJob, 1))
    // The code knows each new image by its handle, and the last lines of
    // the result give the id of each handle.
    const images = codeResult(second, 'call_images')
    expect(images.startsWith('Made the image @&2 from @&1. The image @&2 is 45x10 pixels.\n\n')).toBe(true)
    expect(images.endsWith('\nMade the image @d (handle &1).\nMade the image @e (handle &2).')).toBe(true)
    const viewed = codeResult(second, 'call_view')
    expect(viewed.split('\n')[0]).toBe(`@b | image | PNG | 90x20 | ${pngSize}`)
    expect(viewed).not.toContain(PICTURES_SHOWN_NOTE)
    // The error of a tool is the error text that a call of the model gets.
    const failure = 'No image of this conversation has the id @zz. Its images are @a, @b, @d, @e: call again with one of these ids.'
    expect(codeResult(second, 'call_caught')).toBe(`Error: ${failure}\n${NO_JOBS_LIST_TEXT}`)
    // The stack names the line of the code that made the call.
    expect(thrownError(toolResult(second, 'call_thrown'))).toBe(`Error: ${failure}\n    at default (file:///run/code.ts:2:11)`)

    // The `asset_view` call of the code showed no picture: the only user
    // message is the one of the dropped files.
    const { messages } = JSON.parse(second.body) as { messages: Array<{ role: string }> }
    expect(messages.filter(({ role }) => role === 'user')).toHaveLength(1)

    // The code of a later call works on the images that the calls made by
    // their ids, and the request after it sends the same messages again.
    // The model then gets the facts of the first run.
    sendToolCalls(second.reply, [
      evalCall('call_made', 'return await dez.sbp("dez.tools/asset_info", { assets: "@d @e" })'),
      waitCall('call_facts_wait'),
    ])
    const third = await chatRequest()
    const [, flipped, scaled] = codeResult(third, 'call_made').split('\n')
    expect(flipped.startsWith('@d | image | PNG | 90x20 | ')).toBe(true)
    expect(scaled.startsWith('@e | image | PNG | 45x10 | ')).toBe(true)
    const [facts] = jobsWaitResults(toolResult(third, 'call_facts_wait'))
    expect({ id: facts.id, status: facts.status }).toStrictEqual({ id: factsJob, status: 'finished' })
    expect(withoutRunTime(facts.text).split('\n')).toStrictEqual([
      ASSET_INFO_COLUMNS,
      `@a | image | PNG | 90x20 | ${pngSize} | shown | from the user`,
      `@b | image | PNG | 90x20 | ${pngSize} | shown | from the user`,
      `@c | video | WebM | 2 s | 48x36 | 5 fps | vp9 | no sound | ${byteSizeText(WEBM_VIDEO.length)} | shown | from the user`,
    ])
    const { messages: laterMessages } = JSON.parse(third.body) as { messages: unknown[] }
    expect(laterMessages.slice(0, messages.length)).toStrictEqual(messages)
    expectNoLinkedFile([first, second, third], linkedDir)

    await expectReplyEnd(third)
    // Each image is in the reply with the name of the tool that made it,
    // and the editor shows it. The editor draws only the images near its
    // view, which is at the end of the reply: the last two are these.
    expect(madeImages(await endedReply(browser))).toStrictEqual([
      { id: 'd', marks: 'tool=image', stored: true },
      { id: 'e', marks: 'tool=image', stored: true },
    ])
    await waitForValue(browser, 'shown images', async () => (await shownImages(browser)).slice(-2).map(({ width, height }) => ({ width, height })), [{ width: 90, height: 20 }, { width: 45, height: 10 }])
  })

  it('makes a job that the code of a call started a job of the job of the call: the code waits for it, and the result names each job that is still open, which the model then waits for', async () => {
    await submit(browser, 'Make two pictures.')
    const first = await chatRequest()
    sendToolCalls(first.reply, [evalCall('call_jobs', [
      // More than the 1 second that the call waits for the run, so that the
      // run is job 1 however slowly ffmpeg starts, and the jobs of its code
      // are jobs 2 and 3.
      'await new Promise((resolve) => setTimeout(resolve, 1500))',
      'const draw = (color) => dez.sbp("dez.tools/video/ffmpeg", {',
      '  arguments: `-f lavfi -i color=c=${color}:size=16x16:duration=1 -frames:v 1 -update 1 ${color}.png`,',
      '})',
      'await draw("red")',
      'const waited = await dez.sbp("dez.tools/jobs_wait")',
      'await draw("blue")',
      'return waited',
    ].join('\n'))])

    const second = await chatRequest()
    const runId = startedJob(second, 'call_jobs')
    expect(toolResult(second, 'call_jobs')).toBe(codeRunsAsJobText(runId, 1))
    // The model names the run: the job that its code left open can end
    // first.
    sendToolCalls(second.reply, [openAiToolCall('call_wait_run', 'jobs_wait', { jobs: runId })])
    const third = await chatRequest()
    const [run] = jobsWaitResults(toolResult(third, 'call_wait_run'))
    expect({ id: run.id, status: run.status, number: run.call.number }).toStrictEqual({ id: runId, status: 'finished', number: 1 })
    const result = withoutRunTime(run.text)
    expect(result.startsWith('1 job ended. No job still runs.\n\n')).toBe(true)
    // The code knows the image of its first job by its handle.
    const [red] = jobsWaitResults(result)
    expect({ tool: red.tool, status: red.status, number: red.call.number }).toStrictEqual({ tool: 'video', status: 'finished', number: 2 })
    expect(red.text.endsWith('Made the image @&1.')).toBe(true)
    // The code took the result of the first job, so its image is an asset
    // of the run, and the result names only the second job.
    const [, left] = result.split('\n\nFrom the tool calls of the code:\n')
    const blueId = String(startedJobId(left))
    expect(left).toBe(`${jobStartedText(blueId, 3)}\nMade the image @a (handle &1).`)

    sendToolCalls(third.reply, [waitCall('call_wait')])
    const fourth = await chatRequest()
    const [blue] = jobsWaitResults(toolResult(fourth, 'call_wait'))
    expect({ id: blue.id, tool: blue.tool, status: blue.status, number: blue.call.number }).toStrictEqual({ id: blueId, tool: 'video', status: 'finished', number: 3 })
    expect(blue.text.endsWith('Made the image @b.')).toBe(true)
    await sendChatReply(fourth.reply, CALLER.modelName)

    // Each image is in the reply after the blocks of the round whose call
    // took the result of its job. The first image is an asset of the run,
    // so it has the mark of the job of the run.
    const reply = await endedReply(browser)
    expect(madeImages(reply)).toStrictEqual([
      { id: 'a', marks: `tool=video|made-by=${runId}`, stored: true },
      { id: 'b', marks: `tool=video|made-by=${blueId}`, stored: true },
    ])
    expect(reply.endsWith(`\n\n${replyText(CALLER.modelName)}`)).toBe(true)
    await expectRunsEnded(setup)
  })

  it('runs an app from the code of a call with apps invoke: the run of the app is a job of the run of the code, which waits for it and gets its image', async () => {
    const before = await filesIn(imagesDir)
    await submit(browser, 'Chart my sales.')
    const first = await chatRequest()
    const { jobId, started, result: ran, next } = await runToolJob(chatRequest, first, 'js_eval', 'call_chart', evalCall('call_chart', [
      // More than the 1 second that the call waits for the run, so that
      // the run is job 1 and the run of the app job 2.
      'await new Promise((resolve) => setTimeout(resolve, 1500))',
      `await Deno.writeTextFile(\`\${dez.workFolder}/sales.csv\`, ${JSON.stringify(SALES_CSV)})`,
      'const started = await dez.sbp("dez.tools/apps/invoke", {',
      '  name: "dez-chart",',
      '  parameters: { data: "/work/sales.csv", type: "bar", title: "Sales", width: 320, height: 200 },',
      '})',
      'const [, id] = /Started the job (\\S+)\\./.exec(started)',
      'return await dez.sbp("dez.tools/jobs_wait", { jobs: id })',
    ].join('\n')))
    expect(started).toBe(codeRunsAsJobText(jobId, 1))
    expect({ status: ran.status, number: ran.call.number }).toStrictEqual({ status: 'finished', number: 1 })

    // The code got the result of the app and its image by its handle.
    const result = withoutRunTime(ran.text)
    const [chart] = jobsWaitResults(result)
    expect({ tool: chart.tool, status: chart.status, number: chart.call.number }).toStrictEqual({ tool: 'apps', status: 'finished', number: 2 })
    expect(chart.text.startsWith('A bar chart of "sales", "cost" (4 rows) from /work/sales.csv: chart.png, 320×200, light theme.\n\n')).toBe(true)
    expect(chart.text.endsWith('\nMade the image @&1.')).toBe(true)
    expect(result.endsWith('\nMade the image @a (handle &1).')).toBe(true)
    await sendChatReply(next.reply, CALLER.modelName)

    // The image has the mark of the app. Its job mark is the job of the
    // run: the reply has the call of that job, but no call of its code.
    const reply = await endedReply(browser)
    expect(madeImages(reply)).toStrictEqual([{ id: 'a', marks: `tool=apps|made-by=${jobId}`, stored: true }])
    const picture = fs.readFileSync(path.join(imagesDir, await newFileIn(browser, imagesDir, before)))
    expect([picture.readUInt32BE(16), picture.readUInt32BE(20)]).toStrictEqual([320, 200])
    await expectRunsEnded(setup)
    expect(await consoleErrors(browser)).toStrictEqual([])
  })

  it('shows in the panel of a call its code and the tool calls of the code, and hides the image of an intermediate job of the code under the chip', async () => {
    await submit(browser, 'Make a draft.')
    const first = await chatRequest()
    const draw = { arguments: '-f lavfi -i color=c=red:size=16x16:duration=1 -frames:v 1 -update 1 draft.png', is_intermediate: true }
    const badImage = { image: 'zz', width: 4 }
    // The code does not wait for the job of ffmpeg, which can start slowly
    // on a busy computer: the run ends within the wait of its call, as only
    // such a run shows the list of the tool calls of its code.
    const code = [
      'await dez.sbp("dez.tools/jobs_list")',
      'let failure',
      'try {',
      `  await dez.sbp("dez.tools/image/scale", ${JSON.stringify(badImage)})`,
      '} catch (error) {',
      '  failure = error.message',
      '}',
      `await dez.sbp("dez.tools/video/ffmpeg", ${JSON.stringify(draw)})`,
      'return failure',
    ].join('\n')
    sendToolCalls(first.reply, [evalCall('call_panel', code, { timeout_seconds: 60 })])

    const second = await chatRequest()
    const result = toolResult(second, 'call_panel')
    const [failure, left] = codeResult(second, 'call_panel').split('\n\nFrom the tool calls of the code:\n')
    expect(failure).toBe('This conversation has no images, so it has no image @zz. Do not call the image tool until the user adds an image to the conversation.')
    // The run took no job number: the job of its code is job 1 of the
    // reply, which the model waits for.
    const jobId = String(startedJobId(left))
    expect(left).toBe(jobStartedText(jobId, 1))
    sendToolCalls(second.reply, [waitCall('call_wait')])
    const third = await chatRequest()
    const [draft] = jobsWaitResults(toolResult(third, 'call_wait'))
    expect({ id: draft.id, tool: draft.tool, status: draft.status, number: draft.call.number }).toStrictEqual({ id: jobId, tool: 'video', status: 'finished', number: 1 })
    await sendChatReply(third.reply, CALLER.modelName)
    // The image is in the reply with the mark of its job, which hides it.
    const reply = await endedReply(browser)
    expect(madeImages(reply)).toStrictEqual([{ id: 'a', marks: `tool=video|made-by=${jobId}|hidden=${jobId}`, stored: true }])

    // The image of the job does not show at its place: the chip of the
    // call whose code started the job hides it, and not the chip of the
    // `jobs_wait` call.
    await waitForValue(browser, 'chips after the reply', () => intermediateParts(browser), [hidingPart('image'), null])
    expect(await shownImages(browser)).toStrictEqual([])

    await pressToolChip(browser, 0)
    await waitForValue(browser, 'image in the panel', async () => (await shownImages(browser)).map(({ width, height }) => ({ width, height })), [{ width: 16, height: 16 }])
    expect(await intermediateParts(browser)).toStrictEqual([revealingPart('image'), null])
    expect(await hiddenPart(browser, 0)).toStrictEqual({ heading: 'Intermediate asset', assets: 1, text: null })
    // The code is not a parameter row, and the result is what the model got.
    expect(await toolPanel(browser, 0)).toStrictEqual({ parameters: [['timeout_seconds', '60']], result, failed: false })
    const panel = await codePanel(browser, 0)
    expect(panel?.headings).toStrictEqual(['Intermediate asset', 'Code', 'Parameters', 'Result', 'Tool calls of the code'])
    expect(panel?.code).toBe(code)
    expect(panel?.more).toBeNull()
    // Each tool call of the code, in the form of a call of the model, with
    // the text that the code got.
    const calls = panel?.calls ?? []
    expect(calls).toMatchObject([
      { name: 'jobs_list', status: 'success', stateWord: null, parameters: [], result: NO_JOBS_LIST_TEXT, failed: false },
      { name: 'image', status: 'error', stateWord: 'failed', parameters: [['command', 'scale'], ['parameters', JSON.stringify(badImage)]], result: failure, failed: true },
      { name: 'video', status: 'success', stateWord: null, parameters: [['command', 'ffmpeg'], ['parameters', JSON.stringify(draw)]], failed: false },
    ])
    expect(calls[2].result.startsWith(jobStartedText(jobId, 1))).toBe(true)
    await expectRunsEnded(setup)
  })

  it('shows the tool calls of the code of a saved call: one that the end of the code cut, and how many the list does not hold', async () => {
    const code = 'dez.sbp("dez.tools/jobs_wait")\nthrow new Error("stop")'
    const result = 'The code threw an error:\nError: stop'
    const block = toolBlockText({
      id: 'call_saved',
      name: 'js_eval',
      status: 'error',
      arguments: { code },
      result,
      bridged: { calls: [{ name: 'jobs_wait', arguments: { all: true }, status: 'cut', result: '' }], more: 2 },
    })
    await openSeededConversation(browser, setup.app.home, 'js-eval-saved', [{ role: 'user', text: 'Run it.' }, { role: 'agent', text: block }, { role: 'user', text: '' }])
    await waitForValue(browser, 'chips', async () => (await toolChips(browser)).map(({ name, state }) => ({ name, state })), [{ name: 'js_eval', state: 'error' }])

    await pressToolChip(browser, 0)
    await waitForValue(browser, 'panel of the saved call', () => codePanel(browser, 0), {
      headings: ['Code', 'Result', 'Tool calls of the code'],
      code,
      calls: [{
        name: 'jobs_wait',
        status: 'cut',
        stateWord: 'not finished',
        parameters: [['all', 'true']],
        result: '',
        placeholder: 'The code ended before this tool call did.',
        failed: false,
      }],
      more: '2 more tool calls of the code are not in this list.',
    })
    expect(await toolPanel(browser, 0)).toStrictEqual({ parameters: [], result, failed: true })
    expect(await consoleErrors(browser)).toStrictEqual([])
  })
})
