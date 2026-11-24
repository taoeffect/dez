import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { textNode } from '../model/chat/content'
import { IMAGE_TOOL_KEY, imageMarkdown } from '../model/chat/images'
import type { MediaTagData } from '../model/chat/mediaTags'
import { SHOWN_PICTURE_FOLDER, type ShownPicture } from '../model/chat/shownPictures'
import type { Section } from '../model/chat/types'
import { NO_CALL_PICTURE_BUDGET, type CallPictureBudget } from '../model/streams/pictureBudget'
import { APP_RUN_MAX_TOOL_CALLS } from '../model/tools/appsTool'
import { jobStartedText } from '../model/tools/jobs'
import { JS_EVAL_MAX_TOOL_CALLS, type JsEvalCallLine } from '../model/tools/jsEval'
import { bridgedToolCall, JS_EVAL_BRIDGE, UNEXPECTED_BRIDGE_ERROR_TEXT } from '../model/tools/toolBridge'
import { TabJobs, type MadeAsset, type ToolJobs } from './jobs'
import type { ProgramInputWriter } from './programRuns'
import { callContext, heldStep, heldWork, LONG, native, resetNative, running, STOP, stubToolRuns, TOOL_DONE, toolRuns } from './testing'
import { AppRunBridge, ToolBridge } from './toolBridge'

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
    const bridge = new ToolBridge(callContext(), { run: [] }, running())

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
    const bridge = new ToolBridge(callContext(), { run: [] }, running())

    bridge.call(callLine(1), write)

    await vi.waitFor(() => expect(answers).toStrictEqual([{ id: 1, text: 'The image @z is not in this conversation.', isError: true }]))
  })

  it('answers a line that asks for no call that code can make with its error, and runs no tool', async () => {
    const line = callLine(1, 'dez.tools/js_eval', { code: 'return 1' })
    const bridge = new ToolBridge(callContext(), { run: [] }, running())

    bridge.call(line, write)

    await vi.waitFor(() => expect(answers).toHaveLength(1))
    const check = bridgedToolCall(line, 1, { run: [] }, JS_EVAL_BRIDGE)
    expect(answers).toStrictEqual([{ id: 1, text: check.ok ? '' : check.error, isError: true }])
    expect(toolRuns.calls).toStrictEqual([])
  })

  it('takes the paths of the run folder out of the arguments of a call', async () => {
    const bridge = new ToolBridge(callContext(), { run: ['/mnt/disk/cache/dez/work/1'] }, running())

    bridge.call(callLine(1, 'dez.tools/jobs_wait', { jobs: 'j-1 /mnt/disk/cache/dez/work/1/code.ts' }), write)

    await vi.waitFor(() => expect(answers).toHaveLength(1))
    expect(toolRuns.calls).toStrictEqual([{ name: 'jobs_wait', arguments: { jobs: 'j-1 /run/code.ts' } }])
  })

  it('runs no call of a line after the limit of a run', async () => {
    const bridge = new ToolBridge(callContext(), { run: [] }, running())

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
    const bridge = new ToolBridge(callContext(), { run: ['/mnt/disk/cache/dez/work/1'] }, running())

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
        { name: '/run/no tool', arguments: {}, status: 'error', result: answers[2].text },
      ],
      more: 0,
    })
    expect(answers[2].isError).toBe(true)
  })

  it('counts a line that Dez refuses in the limit of a run', async () => {
    const bridge = new ToolBridge(callContext(), { run: [] }, running())

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
    const bridge = new ToolBridge(context, { run: [] }, running())

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

  it('runs an apps show call of the code, and gives the apps that the reply took, in their order', async () => {
    const asked: string[] = []
    // The reply takes no second app.
    const context = callContext({ showApp: (name) => asked.push(name) !== 2 })
    toolRuns.tool = async (call, _signal, toolContext) => {
      toolContext.showApp((JSON.parse(String(call.arguments.parameters)) as { name: string }).name)
      return TOOL_DONE
    }
    const bridge = new ToolBridge(context, { run: [] }, running())

    for (const [id, name] of ['notes', 'gone', 'timer'].entries()) bridge.call(callLine(id, 'dez.tools/apps/show', { name }), write)
    await vi.waitFor(() => expect(answers).toHaveLength(3))

    expect(toolRuns.calls[0]).toStrictEqual({ name: 'apps', arguments: { command: 'show', parameters: '{"name":"notes"}' } })
    expect(asked).toStrictEqual(['notes', 'gone', 'timer'])
    expect((await bridge.end()).toolCalls.shownApps).toStrictEqual(['notes', 'timer'])
  })

  it('gives the pictures of the calls in their order, and gives a call the picture budget less the pictures of the earlier calls', async () => {
    const second: ShownPicture = { ...PICTURE, file: 'p2.jpg' }
    const budgets: CallPictureBudget[] = []
    toolRuns.tool = async (_call, _signal, toolContext) => {
      budgets.push(await toolContext.pictureBudget())
      return { ...TOOL_DONE, pictures: [budgets.length === 1 ? PICTURE : second] }
    }
    const bridge = new ToolBridge(callContext({ pictureBudget: async () => BUDGET }), { run: [] }, running())

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
    const bridge = new ToolBridge(callContext({ jobs }), { run: [] }, running())

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
    const bridge = new ToolBridge(callContext(), { run: [] }, running())

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

  it('takes no asset, no app, and no picture of a call that ends after the end of the run, and keeps its result in the list of the calls', async () => {
    const written: string[] = []
    const late = heldStep()
    let got: unknown
    toolRuns.tool = async (_call, _signal, toolContext) => {
      await late.wait
      got = { image: toolContext.writeImage('/x/late.png'), clip: toolContext.writeClip(CLIP), app: toolContext.showApp('notes'), budget: await toolContext.pictureBudget() }
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
      showApp: (name) => {
        written.push(name)
        return true
      },
      pictureBudget: async () => BUDGET,
    })
    const bridge = new ToolBridge(context, { run: [] }, running())

    bridge.call(callLine(1), write)
    await vi.waitFor(() => expect(toolRuns.calls).toHaveLength(1))
    const ending = bridge.end()
    late.finish()
    const end = await ending

    expect(got).toStrictEqual({ image: null, clip: null, app: false, budget: NO_CALL_PICTURE_BUDGET })
    expect(written).toStrictEqual([])
    expect(end).toStrictEqual({
      toolCalls: { assets: [], shownApps: [], jobs: [], unanswered: 1, pictures: 0 },
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
    const bridge = new ToolBridge(callContext(), { run: [] }, stop.signal)

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
    const bridge = new ToolBridge(callContext(), { run: [] }, running())

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
    const bridge = new ToolBridge(callContext(), { run: [] }, running())

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

describe('AppRunBridge', () => {
  // The tab of the apps invoke call holds the image @a.
  const TAB: Section[] = [{ id: 's1', role: 'user', content: [textNode(imageMarkdown('/x/a.png', [{ key: 'id', value: 'a' }]))] }]
  const FLUX = { providerId: 'venice', modelId: 'flux' }

  // The assets that the bridge gave the job (`keepAsset`), and the ones
  // that it wrote into the reply, which must stay empty.
  let kept: MadeAsset[]
  let replyWrites: string[]

  function newBridge(jobs: ToolJobs = new TabJobs(), callSignal = running()): AppRunBridge {
    const context = callContext({
      sections: () => TAB,
      writeImage: (path) => { replyWrites.push(path); return 'z' },
      writeClip: (clip) => { replyWrites.push(clip.src ?? ''); return 'z' },
    })
    return new AppRunBridge(context, jobs, { run: [] }, (asset) => kept.push(asset), callSignal)
  }

  beforeEach(() => {
    kept = []
    replyWrites = []
  })

  it('keeps each asset of a call as an asset of the job under its next handle, and a later call finds it by the handle', async () => {
    const ids: (string | null)[] = []
    const seenSections: (readonly Section[])[] = []
    toolRuns.tool = async (call, _signal, toolContext) => {
      seenSections.push(toolContext.sections())
      if (call.arguments.command === 'flip') {
        const id = toolContext.writeImage('/x/flipped.png')
        ids.push(id)
        return { content: `Made the image @${id}.`, isError: false }
      }
      // `jobs_wait` writes what the job of another tool made.
      ids.push(toolContext.writeClip(CLIP, { tool: 'model_invoke', madeBy: 'j-1', model: FLUX, hidden: 'j-1' }))
      return { content: `Scaled @${ids[0]} and @a.`, isError: false }
    }
    const bridge = newBridge()

    bridge.call(callLine(1, 'dez.tools/image/flip', { image: 'a', direction: 'horizontal' }), write)
    bridge.call(callLine(2, 'dez.tools/image/scale', { image: '&1', width: 64 }), write)
    await vi.waitFor(() => expect(answers).toHaveLength(2))

    // The ids that stand for the handles come after the ids of the tab, and
    // after each other.
    expect(ids).toStrictEqual(['b', 'c'])
    expect(answers).toStrictEqual([
      { id: 1, text: 'Made the image @&1.', isError: false },
      { id: 2, text: 'Scaled @&1 and @a.', isError: false },
    ])
    expect(JSON.parse(String(toolRuns.calls[1].arguments.parameters))).toStrictEqual({ image: 'b', width: 64 })
    expect(seenSections[0]).toStrictEqual([...TAB, expect.objectContaining({ role: 'agent', content: [textNode('')] })])
    expect(seenSections[1].at(-1)?.content).toStrictEqual([textNode(imageMarkdown('/x/flipped.png', [{ key: 'id', value: 'b' }, { key: IMAGE_TOOL_KEY, value: 'image' }]))])

    const made = [
      { kind: 'image', path: '/x/flipped.png', tool: 'image', handle: '&1' },
      { kind: 'clip', clip: CLIP, tool: 'model_invoke', model: FLUX, hidden: true, handle: '&2' },
    ]
    expect(kept).toStrictEqual(made)
    expect(await bridge.end()).toStrictEqual({ made, jobs: [], unanswered: 0 })
    expect(replyWrites).toStrictEqual([])
  })

  it('refuses a handle of no asset and an apps show call, and runs no tool for them', async () => {
    const bridge = newBridge()

    bridge.call(callLine(1, 'dez.tools/image/flip', { image: '&1', direction: 'horizontal' }), write)
    bridge.call(callLine(2, 'dez.tools/apps/show', { name: 'notes' }), write)
    await vi.waitFor(() => expect(answers).toHaveLength(2))

    expect(answers.map(({ isError }) => isError)).toStrictEqual([true, true])
    expect(answers[0].text).toMatch(/^The call names &1, but no tool call of this run made/)
    expect(answers[1].text).toMatch(/^The code of an app cannot call apps show/)
    expect(toolRuns.calls).toStrictEqual([])
  })

  it(`runs no call of a line after the limit of ${APP_RUN_MAX_TOOL_CALLS} of a run`, async () => {
    const bridge = newBridge()

    for (let id = 1; id <= APP_RUN_MAX_TOOL_CALLS + 2; id++) bridge.call(callLine(id), write)
    await vi.waitFor(() => expect(answers).toHaveLength(APP_RUN_MAX_TOOL_CALLS + 2))

    expect(toolRuns.calls).toHaveLength(APP_RUN_MAX_TOOL_CALLS)
    expect(answers.slice(-2).map(({ isError }) => isError)).toStrictEqual([true, true])
  })

  it('starts the jobs of the calls as jobs of the job, with the handle in the label and no id of the run in the inputs, and gives the open ones', async () => {
    const tabJobs = new TabJobs()
    const run = heldWork()
    tabJobs.start('apps', run.work, LONG)
    const started: { id: string, number: number }[] = []
    toolRuns.tool = async (call, _signal, toolContext) => {
      if (call.arguments.command === 'flip') {
        toolContext.writeImage('/x/flipped.png')
        return TOOL_DONE
      }
      started.push(toolContext.jobs.start('model_invoke', heldWork().work, { ...LONG, label: 'Paint @b like @a', inputs: ['b', 'a'] }))
      return TOOL_DONE
    }
    const bridge = newBridge(run.jobs())

    bridge.call(callLine(1, 'dez.tools/image/flip', { image: 'a', direction: 'horizontal' }), write)
    bridge.call(callLine(2), write)
    bridge.call(callLine(3), write)
    await vi.waitFor(() => expect(answers).toHaveLength(3))
    run.jobs().cancel([started[0].id])

    expect(run.jobs().list().map(({ call, inputs }) => [call.label, inputs])).toStrictEqual([['Paint @&1 like @a', ['a']], ['Paint @&1 like @a', ['a']]])
    expect(tabJobs.list()).toHaveLength(1)
    expect((await bridge.end()).jobs).toStrictEqual([started[1]])
  })

  it('keeps no asset of a call that ends after the end of the run, and counts the call as not answered', async () => {
    const late = heldStep()
    let got: string | null | undefined
    toolRuns.tool = async (_call, _signal, toolContext) => {
      await late.wait
      got = toolContext.writeImage('/x/late.png')
      return TOOL_DONE
    }
    const bridge = newBridge()

    bridge.call(callLine(1, 'dez.tools/image/flip', { image: 'a', direction: 'horizontal' }), write)
    await vi.waitFor(() => expect(toolRuns.calls).toHaveLength(1))
    const ending = bridge.end()
    late.finish()

    expect(await ending).toStrictEqual({ made: [], jobs: [], unanswered: 1 })
    expect(got).toBeNull()
    expect(kept).toStrictEqual([])
    expect(answers).toStrictEqual([])
  })

  it('deletes the copies of the pictures that a call shows, as a job shows no picture', async () => {
    toolRuns.tool = async () => ({ ...TOOL_DONE, pictures: [PICTURE] })
    const bridge = newBridge()

    bridge.call(callLine(1), write)
    await vi.waitFor(() => expect(answers).toHaveLength(1))

    await vi.waitFor(() => expect(native.deletedFiles).toStrictEqual([{ root: 'app', path: `${SHOWN_PICTURE_FOLDER}/${PICTURE.file}`, folder: false }]))
    expect(answers[0]).toStrictEqual({ id: 1, text: 'done', isError: false })
  })

  it('stops the call that runs at a stop of the job', async () => {
    const stop = new AbortController()
    let callSignal: AbortSignal | undefined
    toolRuns.tool = (_call, signal) => {
      callSignal = signal
      return new Promise((resolve) => signal.addEventListener('abort', () => resolve({ content: 'stopped', isError: true })))
    }
    const bridge = newBridge(new TabJobs(), stop.signal)

    bridge.call(callLine(1), write)
    await vi.waitFor(() => expect(callSignal).toBeDefined())
    stop.abort(STOP)

    expect(callSignal?.reason).toBe(STOP)
    expect((await bridge.end()).unanswered).toBe(1)
  })
})
