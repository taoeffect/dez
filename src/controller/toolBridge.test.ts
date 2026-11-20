import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MediaTagData } from '../model/chat/mediaTags'
import { SHOWN_PICTURE_FOLDER, type ShownPicture } from '../model/chat/shownPictures'
import { NO_CALL_PICTURE_BUDGET, type CallPictureBudget } from '../model/streams/pictureBudget'
import { jobStartedText } from '../model/tools/jobs'
import { JS_EVAL_MAX_TOOL_CALLS, type JsEvalCallLine } from '../model/tools/jsEval'
import { bridgedToolCall, UNEXPECTED_BRIDGE_ERROR_TEXT } from '../model/tools/toolBridge'
import { TabJobs } from './jobs'
import type { ProgramInputWriter } from './programRuns'
import { callContext, heldStep, heldWork, LONG, native, resetNative, running, STOP, stubToolRuns, TOOL_DONE, toolRuns } from './testing'
import { ToolBridge } from './toolBridge'

// The bridge on stub tools (`toolRuns`): the real runners have their own
// tests (tools.test.ts).

const CLIP: Omit<MediaTagData, 'id' | 'other'> = { kind: 'audio', type: 'audio/wav', src: '/x/voice.wav', url: null, expires: null }
const PICTURE: ShownPicture = { file: 'p1.jpg', label: 'The image @a', width: 512, height: 512, bytes: 3000 }
const BUDGET: CallPictureBudget = { left: { tokens: 100_000, bytes: 1_000_000, pictures: 5 }, roundPictures: 3 }

// A call line of the code: `jobs_list`, a tool with no arguments, when a
// test names no other selector.
function callLine(id: number, selector = 'dez.tools/jobs_list', args?: unknown): JsEvalCallLine {
  return { type: 'call', id, selector, ...(args !== undefined && { arguments: args }) }
}

// The answers that the program got.
let answers: { id: number, text: string, isError: boolean }[]
const write: ProgramInputWriter = async (text) => {
  answers.push(JSON.parse(text))
}

// Time for a call that must not run.
const moment = () => new Promise((resolve) => setTimeout(resolve, 5))

beforeEach(() => {
  resetNative()
  stubToolRuns()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  answers = []
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('ToolBridge', () => {
  it('runs the calls one at a time, in the order of their lines, and answers each with the id of its line', async () => {
    const first = heldStep()
    toolRuns.tool = async (call) => {
      if (call.arguments.command === 'scale') await first.wait
      return { content: `result of ${String(call.arguments.command)}`, isError: false }
    }
    const bridge = new ToolBridge(callContext(), [], running())

    bridge.call(callLine(7, 'dez.tools/image/scale', { image: 'a', width: 8 }), write)
    bridge.call(callLine(3, 'dez.tools/image/flip'), write)
    await vi.waitFor(() => expect(toolRuns.calls).toHaveLength(1))
    await moment()

    expect(toolRuns.calls).toStrictEqual([{ name: 'image', arguments: { command: 'scale', parameters: '{"image":"a","width":8}' } }])
    first.finish()
    await vi.waitFor(() => expect(answers).toHaveLength(2))
    expect(answers).toStrictEqual([
      { id: 7, text: 'result of scale', isError: false },
      { id: 3, text: 'result of flip', isError: false },
    ])
    expect((await bridge.end()).toolCalls.unanswered).toBe(0)
  })

  it('gives the code the error of a tool as an error answer', async () => {
    toolRuns.tool = async () => ({ content: 'The image @z is not in this conversation.', isError: true })
    const bridge = new ToolBridge(callContext(), [], running())

    bridge.call(callLine(1), write)

    await vi.waitFor(() => expect(answers).toStrictEqual([{ id: 1, text: 'The image @z is not in this conversation.', isError: true }]))
  })

  it('answers a line that asks for no call that code can make with its error, and runs no tool', async () => {
    const line = callLine(1, 'dez.tools/js_eval', { code: 'return 1' })
    const bridge = new ToolBridge(callContext(), [], running())

    bridge.call(line, write)

    await vi.waitFor(() => expect(answers).toHaveLength(1))
    const check = bridgedToolCall(line, 1, [])
    expect(answers).toStrictEqual([{ id: 1, text: check.ok ? '' : check.error, isError: true }])
    expect(toolRuns.calls).toStrictEqual([])
  })

  it('takes the paths of the work folder out of the arguments of a call', async () => {
    const bridge = new ToolBridge(callContext(), ['/mnt/disk/cache/dez/work/1'], running())

    bridge.call(callLine(1, 'dez.tools/jobs_wait', { jobs: 'j-1 /mnt/disk/cache/dez/work/1/code.ts' }), write)

    await vi.waitFor(() => expect(answers).toHaveLength(1))
    expect(toolRuns.calls).toStrictEqual([{ name: 'jobs_wait', arguments: { jobs: 'j-1 /work/code.ts' } }])
  })

  it('runs no call of a line after the limit of a run', async () => {
    const bridge = new ToolBridge(callContext(), [], running())

    for (let id = 1; id <= JS_EVAL_MAX_TOOL_CALLS + 2; id++) bridge.call(callLine(id), write)

    await vi.waitFor(() => expect(answers).toHaveLength(JS_EVAL_MAX_TOOL_CALLS + 2))
    expect(toolRuns.calls).toHaveLength(JS_EVAL_MAX_TOOL_CALLS)
    expect(answers.map((answer) => answer.isError)).toStrictEqual([...Array<boolean>(JS_EVAL_MAX_TOOL_CALLS).fill(false), true, true])
    // The list of the calls has no entry for such a line, only a count.
    const { bridged } = await bridge.end()
    expect(bridged.calls).toHaveLength(JS_EVAL_MAX_TOOL_CALLS)
    expect(bridged.more).toBe(2)
  })

  it('keeps a list of the calls in the order of their lines: the tool and the arguments of each call, and what the code got', async () => {
    toolRuns.tool = async (call) => (call.name === 'asset_info'
      ? { content: 'The image @z is not in this conversation.', isError: true }
      : { content: `result of ${String(call.arguments.command)}`, isError: false })
    const refused = callLine(3, '/mnt/disk/cache/dez/work/1/no\ntool', { a: 1 })
    const bridge = new ToolBridge(callContext(), ['/mnt/disk/cache/dez/work/1'], running())

    bridge.call(callLine(1, 'dez.tools/image/scale', { image: 'a', width: 8 }), write)
    bridge.call(callLine(2, 'dez.tools/asset_info', { assets: '@z' }), write)
    bridge.call(refused, write)
    await vi.waitFor(() => expect(answers).toHaveLength(3))

    expect((await bridge.end()).bridged).toStrictEqual({
      calls: [
        { name: 'image', arguments: { command: 'scale', parameters: '{"image":"a","width":8}' }, status: 'success', result: 'result of scale' },
        { name: 'asset_info', arguments: { assets: '@z' }, status: 'error', result: 'The image @z is not in this conversation.' },
        // No call of a tool: the selector of the line, with no path of
        // this computer, and the error that the code got.
        { name: '/work/no tool', arguments: {}, status: 'error', result: answers[2].text },
      ],
      more: 0,
    })
    expect(answers[2].isError).toBe(true)
  })

  it('counts a line that Dez refuses in the limit of a run', async () => {
    const bridge = new ToolBridge(callContext(), [], running())

    for (let id = 1; id <= JS_EVAL_MAX_TOOL_CALLS; id++) bridge.call(callLine(id, 'dez.tools/no_tool'), write)
    bridge.call(callLine(JS_EVAL_MAX_TOOL_CALLS + 1), write)

    await vi.waitFor(() => expect(answers).toHaveLength(JS_EVAL_MAX_TOOL_CALLS + 1))
    expect(toolRuns.calls).toStrictEqual([])
  })

  it('names the tool of a call on the assets that the call writes, and gives the assets that the reply took', async () => {
    const written: unknown[] = []
    const ids = ['a', 'b']
    const context = callContext({
      writeImage: (path, options) => {
        written.push({ path, ...options })
        return ids.shift() ?? null
      },
      writeClip: (clip, options) => {
        written.push({ clip: clip.src, ...options })
        return ids.shift() ?? null
      },
    })
    toolRuns.tool = async (call, _signal, toolContext) => {
      if (call.name === 'image') {
        toolContext.writeImage('/x/small.png')
      } else {
        // `jobs_wait` writes what the jobs of other tools made.
        toolContext.writeClip(CLIP, { tool: 'audio', madeBy: 'j-1' })
        toolContext.writeImage('/x/frame.png', { tool: 'video', madeBy: 'j-2', hidden: 'j-2' })
      }
      return TOOL_DONE
    }
    const bridge = new ToolBridge(context, [], running())

    bridge.call(callLine(1, 'dez.tools/image/scale'), write)
    bridge.call(callLine(2, 'dez.tools/jobs_wait'), write)
    await vi.waitFor(() => expect(answers).toHaveLength(2))

    expect(written).toStrictEqual([
      { path: '/x/small.png', tool: 'image' },
      { clip: CLIP.src, tool: 'audio', madeBy: 'j-1' },
      { path: '/x/frame.png', tool: 'video', madeBy: 'j-2', hidden: 'j-2' },
    ])
    // The reply did not take the third one.
    expect((await bridge.end()).toolCalls.assets).toStrictEqual([{ kind: 'image', id: 'a' }, { kind: 'audio', id: 'b' }])
  })

  it('gives the pictures of the calls in their order, and gives a call the picture budget less the pictures of the earlier calls', async () => {
    const second: ShownPicture = { ...PICTURE, file: 'p2.jpg' }
    const budgets: CallPictureBudget[] = []
    toolRuns.tool = async (_call, _signal, toolContext) => {
      budgets.push(await toolContext.pictureBudget())
      return { ...TOOL_DONE, pictures: [budgets.length === 1 ? PICTURE : second] }
    }
    const bridge = new ToolBridge(callContext({ pictureBudget: async () => BUDGET }), [], running())

    bridge.call(callLine(1), write)
    bridge.call(callLine(2), write)
    await vi.waitFor(() => expect(answers).toHaveLength(2))
    const end = await bridge.end()

    expect(budgets[0]).toStrictEqual(BUDGET)
    expect(budgets[1].roundPictures).toBe(2)
    expect(budgets[1].left.pictures).toBe(4)
    // The base64 text of 3000 bytes.
    expect(budgets[1].left.bytes).toBe(BUDGET.left.bytes - 4000)
    expect(budgets[1].left.tokens).toBeLessThan(BUDGET.left.tokens)
    expect(end.pictures).toStrictEqual([PICTURE, second])
    expect(end.toolCalls.pictures).toBe(2)
    expect(native.deletedFiles).toStrictEqual([])
  })

  it('gives the jobs that the calls started and that are still open, also the job of a call that ended after the run', async () => {
    const jobs = new TabJobs()
    const started: { id: string, number: number }[] = []
    const last = heldStep()
    toolRuns.tool = async (call, _signal, toolContext) => {
      const job = toolContext.jobs.start('video', heldWork().work, LONG)
      started.push(job)
      if (call.arguments.command === 'flip') await last.wait
      return { content: jobStartedText(job.id, job.number), isError: false }
    }
    // A job of the reply that no call of the code started.
    jobs.start('audio', heldWork().work, LONG)
    const bridge = new ToolBridge(callContext({ jobs }), [], running())

    for (const [id, command] of ['crop', 'scale', 'flip'].entries()) bridge.call(callLine(id, `dez.tools/image/${command}`), write)
    await vi.waitFor(() => expect(started).toHaveLength(3))
    jobs.cancel([started[0].id])
    const ending = bridge.end()
    last.finish()

    expect((await ending).toolCalls.jobs).toStrictEqual([started[1], started[2]])
  })

  it('stops the call that runs at the end of the run, runs no call after it, and keeps both as calls that the end cut', async () => {
    let callSignal: AbortSignal | undefined
    toolRuns.tool = (_call, signal) => new Promise((resolve) => {
      callSignal = signal
      signal.addEventListener('abort', () => resolve({ content: 'stopped', isError: true }))
    })
    const bridge = new ToolBridge(callContext(), [], running())

    bridge.call(callLine(1), write)
    bridge.call(callLine(2, 'dez.tools/image/flip', { image: 'a' }), write)
    bridge.call(callLine(3, 'dez.tools/no_tool'), write)
    await vi.waitFor(() => expect(toolRuns.calls).toHaveLength(1))
    const end = await bridge.end()
    await moment()

    expect(callSignal?.aborted).toBe(true)
    expect(toolRuns.calls).toHaveLength(1)
    expect(answers).toStrictEqual([])
    expect(end.toolCalls.unanswered).toBe(3)
    expect(end.bridged).toStrictEqual({
      calls: [
        { name: 'jobs_list', arguments: {}, status: 'cut', result: '' },
        { name: 'image', arguments: { command: 'flip', parameters: '{"image":"a"}' }, status: 'cut', result: '' },
        { name: 'dez.tools/no_tool', arguments: {}, status: 'cut', result: '' },
      ],
      more: 0,
    })
  })

  it('takes no asset and no picture of a call that ends after the end of the run, and keeps its result in the list of the calls', async () => {
    const written: string[] = []
    const late = heldStep()
    let got: unknown
    toolRuns.tool = async (_call, _signal, toolContext) => {
      await late.wait
      got = { image: toolContext.writeImage('/x/late.png'), clip: toolContext.writeClip(CLIP), budget: await toolContext.pictureBudget() }
      return { ...TOOL_DONE, pictures: [PICTURE] }
    }
    const context = callContext({
      writeImage: (path) => {
        written.push(path)
        return 'a'
      },
      writeClip: (clip) => {
        written.push(clip.src ?? '')
        return 'b'
      },
      pictureBudget: async () => BUDGET,
    })
    const bridge = new ToolBridge(context, [], running())

    bridge.call(callLine(1), write)
    await vi.waitFor(() => expect(toolRuns.calls).toHaveLength(1))
    const ending = bridge.end()
    late.finish()
    const end = await ending

    expect(got).toStrictEqual({ image: null, clip: null, budget: NO_CALL_PICTURE_BUDGET })
    expect(written).toStrictEqual([])
    expect(end).toStrictEqual({
      toolCalls: { assets: [], jobs: [], unanswered: 1, pictures: 0 },
      pictures: [],
      bridged: { calls: [{ name: 'jobs_list', arguments: {}, status: 'success', result: TOOL_DONE.content }], more: 0 },
    })
    expect(answers).toStrictEqual([])
    await vi.waitFor(() => expect(native.deletedFiles).toStrictEqual([{ root: 'app', path: `${SHOWN_PICTURE_FOLDER}/${PICTURE.file}`, folder: false }]))
  })

  it('stops the call that runs at a stop of the js_eval call', async () => {
    const stop = new AbortController()
    let callSignal: AbortSignal | undefined
    toolRuns.tool = (_call, signal) => {
      callSignal = signal
      return new Promise(() => {})
    }
    const bridge = new ToolBridge(callContext(), [], stop.signal)

    bridge.call(callLine(1), write)
    await vi.waitFor(() => expect(toolRuns.calls).toHaveLength(1))
    stop.abort(STOP)

    expect(callSignal?.aborted).toBe(true)
    expect(callSignal?.reason).toBe(STOP)
  })

  it('counts a call whose answer the program did not take as not answered, and goes on with the next call', async () => {
    let closed = true
    const closedOnce: ProgramInputWriter = async (text) => {
      if (closed) {
        closed = false
        throw 'The program closed its input'
      }
      await write(text)
    }
    const bridge = new ToolBridge(callContext(), [], running())

    bridge.call(callLine(1), closedOnce)
    bridge.call(callLine(2), closedOnce)
    await vi.waitFor(() => expect(answers).toHaveLength(1))

    expect(answers).toStrictEqual([{ id: 2, text: 'done', isError: false }])
    expect((await bridge.end()).toolCalls.unanswered).toBe(1)
  })

  it('answers a line that Dez cannot check with an error, and goes on with the next call', async () => {
    // A forged line: more arrays in each other than the check can walk.
    let deep: unknown = 'x'
    for (let depth = 0; depth < 200_000; depth++) deep = [deep]
    const bridge = new ToolBridge(callContext(), [], running())

    bridge.call(callLine(1, 'dez.tools/jobs_list', { deep }), write)
    bridge.call(callLine(2), write)
    await vi.waitFor(() => expect(answers).toHaveLength(2))

    expect(answers).toStrictEqual([
      { id: 1, text: UNEXPECTED_BRIDGE_ERROR_TEXT, isError: true },
      { id: 2, text: 'done', isError: false },
    ])
    expect(toolRuns.calls).toHaveLength(1)
    expect((await bridge.end()).bridged.calls[0]).toStrictEqual({ name: 'dez.tools/jobs_list', arguments: {}, status: 'error', result: UNEXPECTED_BRIDGE_ERROR_TEXT })
  })
})
