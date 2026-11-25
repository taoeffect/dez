import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BridgedCalls } from '../model/chat/bridgedCalls'
import { textNode } from '../model/chat/content'
import { IMAGE_TOOL_KEY, imageMarkdown } from '../model/chat/images'
import type { MediaTagData } from '../model/chat/mediaTags'
import { SHOWN_PICTURE_FOLDER, type ShownPicture } from '../model/chat/shownPictures'
import type { Section } from '../model/chat/types'
import { APP_RUN_MAX_TOOL_CALLS } from '../model/tools/appsTool'
import { JS_EVAL_MAX_TOOL_CALLS, type JsEvalCallLine, type RunFolderForms } from '../model/tools/jsEval'
import { APP_RUN_BRIDGE, bridgedToolCall, JS_EVAL_BRIDGE, UNEXPECTED_BRIDGE_ERROR_TEXT, type BridgeRules } from '../model/tools/toolBridge'
import { TabJobs, type MadeAsset, type ToolJobs } from './jobs'
import type { ProgramInputWriter } from './programRuns'
import { callContext, heldStep, heldWork, LONG, native, resetNative, running, STOP, stubToolRuns, TOOL_DONE, toolRuns } from './testing'
import { ScriptRunBridge } from './toolBridge'

// The bridge on stub tools (`toolRuns`): the real runners have their own
// tests (tools.test.ts).

const CLIP: Omit<MediaTagData, 'id' | 'other'> = { kind: 'audio', type: 'audio/wav', src: '/x/voice.wav', url: null, expires: null }
const PICTURE: ShownPicture = { file: 'p1.jpg', label: 'The image @a', width: 512, height: 512, bytes: 3000 }

// The tab of the call that started the run holds the image @a.
const TAB: Section[] = [{ id: 's1', role: 'user', content: [textNode(imageMarkdown('/x/a.png', [{ key: 'id', value: 'a' }]))] }]
const FLUX = { providerId: 'venice', modelId: 'flux' }

// A run folder of a test, as the code of the run gets its path.
const RUN_FOLDER = '/mnt/disk/cache/dez/work/1'

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

// The assets that the bridge gave the job (`keepAsset`), the ones that it
// wrote into the reply, which must stay empty, and the lists of the calls
// that it gave at its end (`onCalls`).
let kept: MadeAsset[]
let replyWrites: string[]
let listed: BridgedCalls[]

// What a test bridge differs in: the jobs of its run, the signal of the
// call that started the run, the rules of its kind of run, and the paths
// of its run folder.
interface BridgeSetup {
  jobs?: ToolJobs
  callSignal?: AbortSignal
  rules?: BridgeRules
  folders?: RunFolderForms
}

// A bridge in the tab `TAB`: of a run of an app with no run folder path,
// unless `setup` tells otherwise.
function newBridge({ jobs = new TabJobs(), callSignal = running(), rules = APP_RUN_BRIDGE, folders = { run: [] } }: BridgeSetup = {}): ScriptRunBridge {
  const context = callContext({
    sections: () => TAB,
    writeImage: (path) => { replyWrites.push(path); return 'z' },
    writeClip: (clip) => { replyWrites.push(clip.src ?? ''); return 'z' },
  })
  return new ScriptRunBridge({ context, jobs, onCalls: (calls) => listed.push(calls) }, folders, (asset) => kept.push(asset), callSignal, rules)
}

beforeEach(() => {
  resetNative()
  stubToolRuns()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  answers = []
  kept = []
  replyWrites = []
  listed = []
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('ScriptRunBridge', () => {
  it('runs the calls one at a time, in the order of their lines, and answers each with the id of its line', async () => {
    const first = heldStep()
    toolRuns.tool = async (call) => {
      if (call.arguments.command === 'scale') await first.wait
      return { content: `result of ${String(call.arguments.command)}`, isError: false }
    }
    const bridge = newBridge()

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
    expect((await bridge.end()).unanswered).toBe(0)
  })

  it('gives the code the error of a tool as an error answer', async () => {
    toolRuns.tool = async () => ({ content: 'The image @z is not in this conversation.', isError: true })
    const bridge = newBridge()

    bridge.call(callLine(1), write)

    await vi.waitFor(() => expect(answers).toStrictEqual([{ id: 1, text: 'The image @z is not in this conversation.', isError: true }]))
  })

  it('answers a line that the rules of its run refuse with their error, and runs no tool', async () => {
    const line = callLine(1, 'dez.tools/apps/show', { name: 'notes' })
    const bridge = newBridge({ rules: JS_EVAL_BRIDGE })

    bridge.call(line, write)

    await vi.waitFor(() => expect(answers).toHaveLength(1))
    const check = bridgedToolCall(line, 1, { run: [] }, JS_EVAL_BRIDGE, [])
    expect(check.ok).toBe(false)
    expect(answers).toStrictEqual([{ id: 1, text: check.ok ? '' : check.error, isError: true }])
    expect(toolRuns.calls).toStrictEqual([])
  })

  it('takes the paths of the run folder out of the arguments of a call', async () => {
    const bridge = newBridge({ folders: { run: [RUN_FOLDER] } })

    bridge.call(callLine(1, 'dez.tools/jobs_wait', { jobs: `j-1 ${RUN_FOLDER}/code.ts` }), write)

    await vi.waitFor(() => expect(answers).toHaveLength(1))
    expect(toolRuns.calls).toStrictEqual([{ name: 'jobs_wait', arguments: { jobs: 'j-1 /run/code.ts' } }])
  })

  it.each<[string, BridgeRules, number]>([
    ['a run of an app', APP_RUN_BRIDGE, APP_RUN_MAX_TOOL_CALLS],
    ['a js_eval run', JS_EVAL_BRIDGE, JS_EVAL_MAX_TOOL_CALLS],
  ])('runs no call of a line after the limit of %s, and counts those lines in the list of the calls', async (_name, rules, limit) => {
    const bridge = newBridge({ rules })

    for (let id = 1; id <= limit + 2; id++) bridge.call(callLine(id), write)
    await vi.waitFor(() => expect(answers).toHaveLength(limit + 2))

    expect(toolRuns.calls).toHaveLength(limit)
    expect(answers.slice(-3).map(({ isError }) => isError)).toStrictEqual([false, true, true])
    // The list of the calls has no entry for such a line, only a count.
    await bridge.end()
    const [calls] = listed
    expect(calls.calls).toHaveLength(limit)
    expect(calls.more).toBe(2)
  })

  it('counts a line that Dez refuses in the limit of a run', async () => {
    const bridge = newBridge({ rules: JS_EVAL_BRIDGE })

    for (let id = 1; id <= JS_EVAL_MAX_TOOL_CALLS; id++) bridge.call(callLine(id, 'dez.tools/no_tool'), write)
    bridge.call(callLine(JS_EVAL_MAX_TOOL_CALLS + 1), write)

    await vi.waitFor(() => expect(answers).toHaveLength(JS_EVAL_MAX_TOOL_CALLS + 1))
    expect(toolRuns.calls).toStrictEqual([])
  })

  it('keeps a list of the calls in the order of their lines: the tool and the arguments of each call, and what the code got', async () => {
    toolRuns.tool = async (call) => (call.name === 'asset_info'
      ? { content: 'The image @z is not in this conversation.', isError: true }
      : { content: `result of ${String(call.arguments.command)}`, isError: false })
    const refused = callLine(3, `${RUN_FOLDER}/no\ntool`, { a: 1 })
    const bridge = newBridge({ rules: JS_EVAL_BRIDGE, folders: { run: [RUN_FOLDER] } })

    bridge.call(callLine(1, 'dez.tools/image/scale', { image: 'a', width: 8 }), write)
    bridge.call(callLine(2, 'dez.tools/asset_info', { assets: '@z' }), write)
    bridge.call(refused, write)
    await vi.waitFor(() => expect(answers).toHaveLength(3))

    await bridge.end()
    expect(listed).toStrictEqual([{
      calls: [
        { name: 'image', arguments: { command: 'scale', parameters: '{"image":"a","width":8}' }, status: 'success', result: 'result of scale' },
        { name: 'asset_info', arguments: { assets: '@z' }, status: 'error', result: 'The image @z is not in this conversation.' },
        // No call of a tool: the selector of the line, with no path of
        // this computer, and the error that the code got.
        { name: '/run/no tool', arguments: {}, status: 'error', result: answers[2].text },
      ],
      more: 0,
    }])
    expect(answers[2].isError).toBe(true)
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

    // The clip keeps the job that made it and the job that hides it.
    const made = [
      { kind: 'image', path: '/x/flipped.png', tool: 'image', handle: '&1' },
      { kind: 'clip', clip: CLIP, tool: 'model_invoke', model: FLUX, madeBy: 'j-1', hidden: 'j-1', handle: '&2' },
    ]
    expect(kept).toStrictEqual(made)
    const end = await bridge.end()
    expect([end.made, end.jobs, end.unanswered]).toStrictEqual([made, [], 0])
    // The list of the calls keeps the results as the code got them.
    expect(listed[0].calls.map(({ result }) => result)).toStrictEqual(['Made the image @&1.', 'Scaled @&1 and @a.'])
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
    const bridge = newBridge({ jobs: run.jobs() })

    bridge.call(callLine(1, 'dez.tools/image/flip', { image: 'a', direction: 'horizontal' }), write)
    bridge.call(callLine(2), write)
    bridge.call(callLine(3), write)
    await vi.waitFor(() => expect(answers).toHaveLength(3))
    run.jobs().cancel([started[0].id])

    expect(run.jobs().list().map(({ call, inputs }) => [call.label, inputs])).toStrictEqual([['Paint @&1 like @a', ['a']], ['Paint @&1 like @a', ['a']]])
    expect(tabJobs.list()).toHaveLength(1)
    expect((await bridge.end()).jobs).toStrictEqual([started[1]])
  })

  it('stops the call that runs at the end of the run, runs no call after it, and keeps both as calls that the end cut', async () => {
    let callSignal: AbortSignal | undefined
    toolRuns.tool = (_call, signal) => new Promise((resolve) => {
      callSignal = signal
      signal.addEventListener('abort', () => resolve({ content: 'stopped', isError: true }))
    })
    const bridge = newBridge()

    bridge.call(callLine(1), write)
    bridge.call(callLine(2, 'dez.tools/image/flip', { image: 'a' }), write)
    bridge.call(callLine(3, 'dez.tools/no_tool'), write)
    await vi.waitFor(() => expect(toolRuns.calls).toHaveLength(1))
    const end = await bridge.end()
    await moment()

    expect(callSignal?.aborted).toBe(true)
    expect(toolRuns.calls).toHaveLength(1)
    expect(answers).toStrictEqual([])
    expect(end.unanswered).toBe(3)
    expect(listed).toStrictEqual([{
      calls: [
        { name: 'jobs_list', arguments: {}, status: 'cut', result: '' },
        { name: 'image', arguments: { command: 'flip', parameters: '{"image":"a"}' }, status: 'cut', result: '' },
        { name: 'dez.tools/no_tool', arguments: {}, status: 'cut', result: '' },
      ],
      more: 0,
    }])
  })

  it('keeps no asset of a call that ends after the end of the run, counts the call as not answered, and keeps its result in the list of the calls', async () => {
    const late = heldStep()
    let got: string | null | undefined
    toolRuns.tool = async (_call, _signal, toolContext) => {
      await late.wait
      got = toolContext.writeImage('/x/late.png')
      return TOOL_DONE
    }
    const bridge = newBridge()

    bridge.call(callLine(1), write)
    await vi.waitFor(() => expect(toolRuns.calls).toHaveLength(1))
    const ending = bridge.end()
    late.finish()

    expect(await ending).toStrictEqual({ made: [], jobs: [], unanswered: 1 })
    expect(listed).toStrictEqual([{ calls: [{ name: 'jobs_list', arguments: {}, status: 'success', result: TOOL_DONE.content }], more: 0 }])
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
    const bridge = newBridge({ callSignal: stop.signal })

    bridge.call(callLine(1), write)
    await vi.waitFor(() => expect(callSignal).toBeDefined())
    stop.abort(STOP)

    expect(callSignal?.reason).toBe(STOP)
    expect((await bridge.end()).unanswered).toBe(1)
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
    const bridge = newBridge()

    bridge.call(callLine(1), closedOnce)
    bridge.call(callLine(2), closedOnce)
    await vi.waitFor(() => expect(answers).toHaveLength(1))

    expect(answers).toStrictEqual([{ id: 2, text: 'done', isError: false }])
    expect((await bridge.end()).unanswered).toBe(1)
  })

  it('answers a line that Dez cannot check with an error, and goes on with the next call', async () => {
    // A forged line: more arrays in each other than the check can walk.
    let deep: unknown = 'x'
    for (let depth = 0; depth < 200_000; depth++) deep = [deep]
    const bridge = newBridge()

    bridge.call(callLine(1, 'dez.tools/jobs_list', { deep }), write)
    bridge.call(callLine(2), write)
    await vi.waitFor(() => expect(answers).toHaveLength(2))

    expect(answers).toStrictEqual([
      { id: 1, text: UNEXPECTED_BRIDGE_ERROR_TEXT, isError: true },
      { id: 2, text: 'done', isError: false },
    ])
    expect(toolRuns.calls).toHaveLength(1)
    await bridge.end()
    expect(listed[0].calls[0]).toStrictEqual({ name: 'dez.tools/jobs_list', arguments: {}, status: 'error', result: UNEXPECTED_BRIDGE_ERROR_TEXT })
  })
})
