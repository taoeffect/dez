import fs from 'node:fs'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { toolBlockText } from '../../src/model/chat/toolBlocks'
import { ASSET_INFO_COLUMNS } from '../../src/model/tools/assetInfo'
import { PICTURES_SHOWN_NOTE } from '../../src/model/tools/assetView'
import { jobStartedText, jobsWaitResults, startedJobId } from '../../src/model/tools/jobs'
import { byteSizeText } from '../../src/utils/byteSize'
import { consoleErrors, pointerClick, resetConsoleErrors, screenshotOnFailure, waitForValue } from './harness/dom'
import { expectNoLinkedFile, linkedDropDir, openDroppedFiles } from './harness/drops'
import { appFilePath, conversationFilePath, filesIn, workDir } from './harness/fixtures'
import { generatedImagesDir, pngDataUrl, shownImages, STRIPES_PNG } from './harness/images'
import { NO_JOBS_LIST_TEXT, waitCall } from './harness/jobs'
import { evalCall, expectReplyEnd as expectEnd, expectRunsEnded } from './harness/jsEval'
import { WEBM_VIDEO } from './harness/media'
import { startMockProviderApp, takeRequest, type MockProviderApp } from './harness/mockProviderApp'
import { mockChatPath, replyText, sendChatReply, sendToolCalls, toolResult, type HeldRequest, type MockProvider } from './harness/mockServer'
import { processExists, runningProgram } from './harness/processes'
import type { E2EBrowser } from './harness/session'
import { activeConversationId, endedReply, newTab, openSeededConversation, openToasts, sbpCall, submit } from './harness/thread'
import { codePanel, hiddenPart, hidingPart, intermediateParts, pressToolChip, revealingPart, toolChips, toolPanel } from './harness/toolChips'

// The `js_eval` tool, driven through the real app against a mock chat model
// in this process. The app runs the code of each call in the real Deno of
// the debug build:
// - the result of a call is the value that the code returned (a string as
//   it is, data as JSON, any other value as Deno shows it, also data with a
//   value in it that JSON loses), then the console output of the code; the
//   code can be TypeScript, it can load a built-in module, it has the time
//   zone of the app, and a timer that it leaves does not hold the call;
// - code that threw gives an error result that names the lines of the code
//   as lines of `/run/code.ts`, with the causes of the error; a syntax
//   error, a static `import`, a refused permission, and a refused package
//   each get the text that tells the model what to do;
// - code that ended before it returned a value, and code that Dez stopped
//   at the time limit of its call, give an error result, and the chip of
//   such a call shows that it failed; code that returned no value gives a
//   result that tells so, and no error;
// - Stop ends the code of a call that runs;
// - every run folder is gone after its call;
// - the code of each call gets the work folder of its conversation as
//   `dez.workFolder`, which the model reads as `/work`: a file that one call
//   wrote there is there for the next call, and a delete of the
//   conversation in History deletes the folder;
// - the code of a call runs the other Dez tools with `dez.sbp`, in both
//   forms of a call, on the files that the user dropped (a stored image, a
//   linked image, a linked clip) by their ids: it gets the result text of
//   each tool, and the error of a tool as an error that it can catch. An
//   image that a call made goes into the reply with the name of its tool,
//   and the next call of the code can name it. The model sees the picture
//   of an `asset_view` call of the code, in each later request too;
// - a job that the code started is a job of the reply: the code can wait
//   for it, the result of the call names each job that is still open, and
//   the model gets the result of such a job with `jobs_wait`;
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
// One app session serves the whole file; each test starts in a new tab.

const CALLER: MockProvider = { id: 'caller', name: 'Caller Mock', modelId: 'caller-model', modelName: 'Caller Model' }
const CHAT_PATH = mockChatPath(CALLER)

// The time zone of the app under test: one that no CI machine has, so the
// code of a call can only have it from the app.
const APP_TIME_ZONE = 'Asia/Tokyo'

describe('js_eval tool', () => {
  let setup: MockProviderApp
  let browser: E2EBrowser
  let workRoot: string
  let imagesDir: string
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
    expect(toolResult(second, 'call_exact')).toBe('18446744073709551616n')
    expect(toolResult(second, 'call_text')).toBe('one\ntwo')
    expect(toolResult(second, 'call_data')).toBe('{\n  "length": 5,\n  "hash": 64\n}\n\nConsole output of the code:\nthe point { x: 3, y: 4 }\na warning')
    expect(toolResult(second, 'call_lost')).toBe('{ counts: Map(1) { "a" => 3 }, unique: Set(1) { 1 }, list: [ 1, NaN ] }')
    expect(toolResult(second, 'call_date')).toBe('{\n  "when": "1970-01-01T00:00:00.000Z"\n}')
    expect(toolResult(second, 'call_place')).toBe(`/run file:///run/code.ts ${APP_TIME_ZONE}`)
    expect(toolResult(second, 'call_timer')).toBe('done')
    expect(toolResult(second, 'call_none')).toBe('The code returned no value, and it wrote nothing to the console. Give the result with `return`.')
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
    const thrown = toolResult(second, 'call_throw')
    expect(thrown.startsWith('The code threw an error:\nRangeError: too large\n    at check (file:///run/code.ts:2:')).toBe(true)
    expect(thrown).toContain('\n    at default (file:///run/code.ts:4:')
    expect(thrown).toContain('\nCaused by: Error: the cause\n    at check (file:///run/code.ts:2:')
    // No line of the module of Dez, which the model did not write.
    expect(thrown).not.toContain('runner.js')

    const syntax = toolResult(second, 'call_syntax')
    expect(syntax.startsWith('The code threw an error:\n')).toBe(true)
    expect(syntax).toContain('Expression expected')
    expect(syntax).toContain('file:///run/code.ts:1:')

    const noFlag = 'No flag changes these limits, and you can set no flag: do the work within the limits.'
    expect(toolResult(second, 'call_import')).toContain('a static `import` does not work in it.')
    const fetched = toolResult(second, 'call_fetch')
    expect(fetched.startsWith(`The code threw an error:\nNotCapable: Requires net access to "${new URL(setup.mock.url).host}"`)).toBe(true)
    expect(fetched).toContain(noFlag)
    const packaged = toolResult(second, 'call_package')
    expect(packaged).toContain('--no-npm')
    expect(packaged).toContain(noFlag)

    const late = toolResult(second, 'call_late')
    expect(late.startsWith('The code ended before it returned a value (exit code 1).')).toBe(true)
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
    expect(toolResult(second, 'call_loop')).toBe(
      'Dez stopped the code: it did not end within 1 second. Make the code do less work, or give it more time with `timeout_seconds` (at most 300).'
      + '\n\nConsole output of the code:\nstarted',
    )
    await expectReplyEnd(second)
    await waitForValue(browser, 'chip states', chipStates, ['error'])
  })

  it('ends the code of a call when the user stops the reply, and deletes its run folder', async () => {
    await submit(browser, 'Wait.')
    const first = await chatRequest()
    sendToolCalls(first.reply, [evalCall('call_wait', 'await new Promise((resolve) => setTimeout(resolve, 280_000))', { timeout_seconds: 300 })])
    const program = await runningProgram(browser, workRoot)

    // While a reply runs, the Submit button stops it.
    await pointerClick(browser, '.submit-button')

    await waitForValue(browser, 'the program of the call runs', async () => processExists(program), false)
    await waitForValue(browser, 'work folders', () => filesIn(workRoot), [])
    await endedReply(browser)
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
    expect(toolResult(second, 'call_write')).toBe('/work')
    sendToolCalls(second.reply, [evalCall('call_read', 'return await Deno.readTextFile(`${dez.workFolder}/note.txt`)')])

    const third = await chatRequest()
    expect(toolResult(third, 'call_read')).toBe('kept')
    await expectReplyEnd(third)
    expect(await filesIn(folder)).toStrictEqual(['note.txt'])
    await waitForValue(browser, 'saved conversation', async () => fs.existsSync(conversationFilePath(setup.app.home, conversationId)), true)

    await sbpCall(browser, 'dez.controller/deleteConversation', conversationId)

    await waitForValue(browser, 'work folder of the conversation', async () => fs.existsSync(folder), false)
    expect(fs.existsSync(conversationFilePath(setup.app.home, conversationId))).toBe(false)
    expect(await consoleErrors(browser)).toStrictEqual([])
  })

  it('runs the Dez tools that the code of a call names with dez.sbp, on a stored image and on linked files: their results, their images, their picture, and their errors', async () => {
    await openDroppedFiles(setup, CALLER, linkedDir, 'bridge')
    await submit(browser, ' Work on them.')
    const first = await chatRequest()
    const badCall = 'dez.sbp("dez.tools/image/scale", { image: "zz", width: 4 })'
    sendToolCalls(first.reply, [
      // A tool that runs a bundled program itself (ffprobe, for the clip).
      evalCall('call_facts', 'return await dez.sbp("dez.tools/asset_info", { assets: "@a @b @c" })'),
      // The two forms of a call of a subcommand. The second call names the
      // image that the first one made.
      evalCall('call_images', [
        'const flipped = await dez.sbp("dez.tools/image/flip", { image: "b", direction: "horizontal" })',
        'const [, id] = /^Made the image @([a-z]+) /.exec(flipped)',
        'return await dez.sbp("dez.tools/image", { command: "scale", parameters: JSON.stringify({ image: id, width: 45 }) })',
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
    expect(toolResult(second, 'call_facts').split('\n')).toStrictEqual([
      ASSET_INFO_COLUMNS,
      `@a | image | PNG | 90x20 | ${pngSize} | shown | from the user`,
      `@b | image | PNG | 90x20 | ${pngSize} | shown | from the user`,
      `@c | video | WebM | 2 s | 48x36 | 5 fps | vp9 | no sound | ${byteSizeText(WEBM_VIDEO.length)} | shown | from the user`,
    ])
    // The code returned only what its last call gave, so the result names
    // the image of the first call too.
    expect(toolResult(second, 'call_images')).toBe(
      'Made the image @e from @d. The image @e is 45x10 pixels.\n\nFrom the tool calls of the code:\nMade the image @d.',
    )
    expect(toolResult(second, 'call_view').split('\n').slice(0, 2)).toStrictEqual([`@b | image | PNG | 90x20 | ${pngSize}`, PICTURES_SHOWN_NOTE])
    // The error of a tool is the error text that a call of the model gets.
    const failure = 'No image of this conversation has the id @zz. Its images are @a, @b, @d, @e: call again with one of these ids.'
    expect(toolResult(second, 'call_caught')).toBe(`Error: ${failure}\n${NO_JOBS_LIST_TEXT}`)
    // The stack names the line of the code that made the call.
    expect(toolResult(second, 'call_thrown')).toBe(`The code threw an error:\nError: ${failure}\n    at default (file:///run/code.ts:2:11)`)

    // The model sees the picture of the `asset_view` call of the code as
    // after a call of its own: in one user message after the tool
    // messages, after a line that names it.
    const { messages } = JSON.parse(second.body) as { messages: unknown[] }
    expect(messages.at(-1)).toStrictEqual({
      role: 'user',
      content: [{ type: 'text', text: 'asset_view: the image @b.' }, { type: 'image_url', image_url: { url: pngDataUrl(STRIPES_PNG) } }],
    })

    // The code of a later call works on the images that the calls made, and
    // the request after it sends the same messages again, the picture at
    // the same place.
    sendToolCalls(second.reply, [evalCall('call_made', 'return await dez.sbp("dez.tools/asset_info", { assets: "@d @e" })')])
    const third = await chatRequest()
    const [, flipped, scaled] = toolResult(third, 'call_made').split('\n')
    expect(flipped.startsWith('@d | image | PNG | 90x20 | ')).toBe(true)
    expect(scaled.startsWith('@e | image | PNG | 45x10 | ')).toBe(true)
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

  it('makes a job that the code of a call started a job of the reply: the code waits for it, and the result names each job that is still open', async () => {
    await submit(browser, 'Make two pictures.')
    const first = await chatRequest()
    sendToolCalls(first.reply, [evalCall('call_jobs', [
      'const draw = (color) => dez.sbp("dez.tools/video/ffmpeg", {',
      '  arguments: `-f lavfi -i color=c=${color}:size=16x16:duration=1 -frames:v 1 -update 1 ${color}.png`,',
      '})',
      'await draw("red")',
      'const waited = await dez.sbp("dez.tools/jobs_wait")',
      'await draw("blue")',
      'return waited',
    ].join('\n'))])

    const second = await chatRequest()
    const [waited, left] = toolResult(second, 'call_jobs').split('\n\nFrom the tool calls of the code:\n')
    expect(waited.startsWith('1 job ended. No job still runs.\n\n')).toBe(true)
    const [red] = jobsWaitResults(waited)
    expect({ tool: red.tool, status: red.status, number: red.call.number }).toStrictEqual({ tool: 'video', status: 'finished', number: 1 })
    expect(red.text.endsWith('Made the image @a.')).toBe(true)
    // The code took the result of the first job, and its value tells of
    // the image of that job. So the result names only the second job.
    const blueId = startedJobId(left)
    expect(left).toBe(jobStartedText(String(blueId), 2))

    sendToolCalls(second.reply, [waitCall('call_wait')])
    const third = await chatRequest()
    const [blue] = jobsWaitResults(toolResult(third, 'call_wait'))
    expect({ id: blue.id, tool: blue.tool, status: blue.status, number: blue.call.number }).toStrictEqual({ id: blueId, tool: 'video', status: 'finished', number: 2 })
    expect(blue.text.endsWith('Made the image @b.')).toBe(true)
    await sendChatReply(third.reply, CALLER.modelName)

    // Each image is in the reply after the blocks of the round whose call
    // took the result of its job: a call of the code, then a call of the
    // model.
    const reply = await endedReply(browser)
    expect(madeImages(reply)).toStrictEqual([
      { id: 'a', marks: `tool=video|made-by=${red.id}`, stored: true },
      { id: 'b', marks: `tool=video|made-by=${blueId}`, stored: true },
    ])
    expect(reply.endsWith(`\n\n${replyText(CALLER.modelName)}`)).toBe(true)
    await expectRunsEnded(setup)
  })

  it('shows in the panel of a call its code and the tool calls of the code, and hides the image of an intermediate job of the code under the chip', async () => {
    await submit(browser, 'Make a draft.')
    const first = await chatRequest()
    const draw = { arguments: '-f lavfi -i color=c=red:size=16x16:duration=1 -frames:v 1 -update 1 draft.png', is_intermediate: true }
    const badImage = { image: 'zz', width: 4 }
    const code = [
      'await dez.sbp("dez.tools/jobs_list")',
      'let failure',
      'try {',
      `  await dez.sbp("dez.tools/image/scale", ${JSON.stringify(badImage)})`,
      '} catch (error) {',
      '  failure = error.message',
      '}',
      `await dez.sbp("dez.tools/video/ffmpeg", ${JSON.stringify(draw)})`,
      'await dez.sbp("dez.tools/jobs_wait")',
      'return failure',
    ].join('\n')
    sendToolCalls(first.reply, [evalCall('call_panel', code, { timeout_seconds: 60 })])

    const second = await chatRequest()
    const result = toolResult(second, 'call_panel')
    const [failure] = result.split('\n\nFrom the tool calls of the code:\n')
    expect(failure).toBe('This conversation has no images, so it has no image @zz. Do not call the image tool until the user adds an image to the conversation.')
    await sendChatReply(second.reply, CALLER.modelName)
    // The image is in the reply with the mark of its job, which hides it.
    const reply = await endedReply(browser)
    const jobId = String(/\|hidden=([^|\]]+)\]/.exec(reply)?.[1])
    expect(madeImages(reply)).toStrictEqual([{ id: 'a', marks: `tool=video|made-by=${jobId}|hidden=${jobId}`, stored: true }])

    // The image of the job does not show at its place: the chip of the
    // call whose code started the job hides it.
    await waitForValue(browser, 'chip after the reply', () => intermediateParts(browser), [hidingPart('image')])
    expect(await shownImages(browser)).toStrictEqual([])

    await pressToolChip(browser, 0)
    await waitForValue(browser, 'image in the panel', async () => (await shownImages(browser)).map(({ width, height }) => ({ width, height })), [{ width: 16, height: 16 }])
    expect(await intermediateParts(browser)).toStrictEqual([revealingPart('image')])
    expect(await hiddenPart(browser, 0)).toStrictEqual({ heading: 'Intermediate asset', assets: 1, text: null })
    // The code is not a parameter row, and the result is what the model got.
    expect(await toolPanel(browser, 0)).toStrictEqual({ parameters: [['timeout_seconds', '60']], result, failed: false })
    const panel = await codePanel(browser, 0)
    expect(panel?.headings).toStrictEqual(['Intermediate asset', 'Code', 'Parameters', 'Result', 'Tool calls of the code'])
    expect(panel?.code).toBe(code)
    expect(panel?.more).toBeNull()
    // Each tool call of the code, in the form of a call of the model, with
    // the text that the code got. The result of the `video` call tells of
    // the inputs of its run after the job.
    const calls = panel?.calls ?? []
    expect(calls).toMatchObject([
      { name: 'jobs_list', status: 'success', stateWord: null, parameters: [], result: NO_JOBS_LIST_TEXT, failed: false },
      { name: 'image', status: 'error', stateWord: 'failed', parameters: [['command', 'scale'], ['parameters', JSON.stringify(badImage)]], result: failure, failed: true },
      { name: 'video', status: 'success', stateWord: null, parameters: [['command', 'ffmpeg'], ['parameters', JSON.stringify(draw)]], failed: false },
      { name: 'jobs_wait', status: 'success', stateWord: null, parameters: [], failed: false },
    ])
    expect(calls[2].result.startsWith(jobStartedText(jobId, 1))).toBe(true)
    expect(jobsWaitResults(calls[3].result).map(({ id, tool, status }) => ({ id, tool, status }))).toStrictEqual([{ id: jobId, tool: 'video', status: 'finished' }])
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
