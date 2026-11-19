import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { consoleErrors, pointerClick, resetConsoleErrors, screenshotOnFailure, waitForValue } from './harness/dom'
import { filesIn, workDir } from './harness/fixtures'
import { startMockProviderApp, takeRequest, type MockProviderApp } from './harness/mockProviderApp'
import { mockChatPath, openAiToolCall, replyText, sendChatReply, sendToolCalls, toolResult, type HeldRequest, type MockProvider } from './harness/mockServer'
import { processExists, runningProgram } from './harness/processes'
import type { E2EBrowser } from './harness/session'
import { endedReply, newTab, openToasts, submit } from './harness/thread'

// The `js_eval` tool, driven through the real app against a mock chat model
// in this process. The app runs the code of each call in the real Deno of
// the debug build:
// - the result of a call is the value that the code returned (a string as
//   it is, data as JSON, any other value as Deno shows it), then the
//   console output of the code; the code can be TypeScript, it can load a
//   built-in module, it has the time zone of the app, and a timer that it
//   leaves does not hold the call;
// - code that threw gives an error result that names the lines of the code
//   as lines of `/work/code.ts`, with the causes of the error; a syntax
//   error, a static `import`, a refused permission, and a refused package
//   each get the text that tells the model what to do;
// - code that ended with no value, and code that Dez stopped at the time
//   limit of its call, give an error result;
// - Stop ends the code of a call that runs;
// - every work folder is gone after its call.
// No request holds a path of the test HOME (`takeRequest` checks each one):
// the work folder of each run is in that HOME, and Deno names it in an error
// stack, in `import.meta.url`, and in `Deno.cwd()`.
//
// One app session serves the whole file; each test starts in a new tab.

const CALLER: MockProvider = { id: 'caller', name: 'Caller Mock', modelId: 'caller-model', modelName: 'Caller Model' }
const CHAT_PATH = mockChatPath(CALLER)

// The time zone of the app under test: one that no CI machine has, so the
// code of a call can only have it from the app.
const APP_TIME_ZONE = 'Asia/Tokyo'

/** A `js_eval` call of the mock model. */
function evalCall (id: string, code: string, more: Record<string, unknown> = {}): Record<string, unknown> {
  return openAiToolCall(id, 'js_eval', { code, ...more })
}

describe('js_eval tool', () => {
  let setup: MockProviderApp
  let browser: E2EBrowser
  let workRoot: string

  const chatRequest = (): Promise<HeldRequest> => takeRequest(setup, CHAT_PATH)

  // Answers the request with the last text of a reply, and checks the end
  // of the reply: its text ends after the blocks of the calls, no work
  // folder stays, and no error toast shows.
  async function expectReplyEnd (request: HeldRequest): Promise<void> {
    await sendChatReply(request.reply, CALLER.modelName)
    const reply = await endedReply(browser)
    expect(reply.endsWith(`</dez:tool>\n${replyText(CALLER.modelName)}`)).toBe(true)
    expect(setup.mock.hasWaitingRequest()).toBe(false)
    expect(await filesIn(workRoot)).toStrictEqual([])
    expect(await openToasts(browser, 'error')).toStrictEqual([])
  }

  beforeAll(async () => {
    setup = await startMockProviderApp(CALLER, {}, { env: { TZ: APP_TIME_ZONE } })
    browser = setup.browser
    workRoot = workDir(setup.app.home)
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
    expect(toolResult(second, 'call_place')).toBe(`/work file:///work/code.ts ${APP_TIME_ZONE}`)
    expect(toolResult(second, 'call_timer')).toBe('done')
    expect(toolResult(second, 'call_none')).toBe('The code returned no value, and it wrote nothing to the console. Give the result with `return`.')
    await expectReplyEnd(second)
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
    expect(thrown.startsWith('The code threw an error:\nRangeError: too large\n    at check (file:///work/code.ts:2:')).toBe(true)
    expect(thrown).toContain('\n    at default (file:///work/code.ts:4:')
    expect(thrown).toContain('\nCaused by: Error: the cause\n    at check (file:///work/code.ts:2:')
    // No line of the module of Dez, which the model did not write.
    expect(thrown).not.toContain('runner.js')

    const syntax = toolResult(second, 'call_syntax')
    expect(syntax.startsWith('The code threw an error:\n')).toBe(true)
    expect(syntax).toContain('Expression expected')
    expect(syntax).toContain('file:///work/code.ts:1:')

    const noFlag = 'No flag changes that, and you can set none: do the work without them.'
    expect(toolResult(second, 'call_import')).toContain('a static `import` does not work in it. Load a built-in module with `await import("node:…")`.')
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
    expect(late).toContain('file:///work/code.ts:1:')
    await expectReplyEnd(second)
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
  })

  it('ends the code of a call when the user stops the reply, and deletes its work folder', async () => {
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
})
