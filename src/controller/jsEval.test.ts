import sbp from '@sbp/sbp'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MediaTagData } from '../model/chat/mediaTags'
import { codeRunCall, scriptOutputNotStoredText, type CodeRunCall } from '../model/tools/appInvoke'
import { JOB_LIMIT_TEXT, jobStartedText, madeAssetText, MAX_OPEN_JOBS } from '../model/tools/jobs'
import {
  codeRunsAsJobText,
  codeTimedOutText,
  JS_EVAL_CALL_WAIT_MS,
  JS_EVAL_CODE_FILE,
  JS_EVAL_OUTPUT_BYTES,
  JS_EVAL_RUNNER,
  JS_EVAL_RUNNER_FILE,
  jsEvalCodeFile,
  RUN_DESCRIPTION_FILE,
} from '../model/tools/jsEval'
import { programNotConfinedText } from '../model/tools/programRuns'
import { CONVERSATION, CONVERSATION_ID, FILM, PNG_BYTES, protocolLine, RED } from '../model/tools/testing'
import { FONT_FOLDER, SHIPPED_FONTS } from '../model/tools/videoFonts'
import { TabJobs } from './jobs'
import { runJsEval } from './jsEval'
import type { BundledToolEnd } from './nativeTypes'
import {
  APP_DIR,
  CACHE_DIR,
  callContext,
  callingProgram,
  CONVERSATION_WORK_FOLDER,
  deletedWorkFolder,
  ENDED,
  failureOf,
  heldWork,
  LONG,
  native,
  outputFolderHolds,
  refusalOf,
  resetNative,
  RESOURCE_DIR,
  returns,
  running,
  STOP,
  stubToolRuns,
  TOOL_DONE,
  toolRuns,
  type StubProgram,
} from './testing'

// The run of a `js_eval` call: a job of the reply that runs the code with
// `runScriptJob`, which the call waits for a short time. The rules of a
// script run have their own tests (appInvoke.test.ts); the tests here tell
// what the code of a call gets, and what the call gives.
//
// The clock of the computer stands still unless a test moves it, so a run
// takes no time.

const CLIP: Omit<MediaTagData, 'id' | 'other'> = { kind: 'audio', type: 'audio/wav', src: '/x/voice.wav', url: null, expires: null }
const FLUX = { providerId: 'venice', modelId: 'flux' }
// The entry of a `jobs_list` call of the code that gave `TOOL_DONE`.
const LIST_CALL = { name: 'jobs_list', arguments: {}, status: 'success', result: TOOL_DONE.content }
// The last paragraph of the result of a run that took no time.
const NO_TIME = '\n\nThe code ran for less than 0.1 seconds.'

// The jobs of the tab of the call.
let jobs: TabJobs
// What the call put into the reply: the source of each image and clip,
// with its options. The reply gives each image the id `x`, and each clip
// the id `y`, or null when it takes no asset any more.
let written: { source: string | null, options: unknown }[]
let replyTakesAssets: boolean
let deletedImages: string[]

sbp('sbp/selectors/register', {
  async 'dez.controller/images/delete' (path: string): Promise<void> {
    deletedImages.push(path)
  },
})

// The checked call of `code`, with the more arguments `more`.
function codeCall(more: Record<string, unknown> = {}): CodeRunCall {
  return codeRunCall({ code: 'return 1 + 1', ...more }, CONVERSATION)
}

// The context of the call: the tab holds `CONVERSATION`.
function context() {
  return callContext({
    jobs,
    sections: () => CONVERSATION,
    writeImage: (path, options) => {
      written.push({ source: path, options })
      return replyTakesAssets ? 'x' : null
    },
    writeClip: (clip, options) => {
      written.push({ source: clip.src, options })
      return replyTakesAssets ? 'y' : null
    },
  })
}

// The description of the run that Dez wrote into the run folder `folder`.
function runDescription(folder: string): Record<string, unknown> {
  const saved = native.savedFiles.find(({ file }) => file.path === `${folder}/${RUN_DESCRIPTION_FILE}`)
  return JSON.parse(saved?.content as string) as Record<string, unknown>
}

// The answers to the tool calls of the code, as the program got them.
const answers = () => native.inputWrites.map(({ text }) => JSON.parse(text) as { id: number, text: string, isError: boolean })

// A program that runs until Dez stops its run.
async function untilCancelled(): Promise<BundledToolEnd> {
  await vi.waitFor(() => expect(native.cancelledRuns).toHaveLength(1))
  return { kind: 'cancelled' }
}

// `program`, after it ran for `ms` on the clock of the computer.
function taking(ms: number, program: StubProgram): StubProgram {
  return async (run, onOutput) => {
    vi.advanceTimersByTime(ms)
    return program(run, onOutput)
  }
}

// Makes `timeZone` the time zone of this computer.
function setTimeZone(timeZone: string): void {
  vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({ timeZone } as Intl.ResolvedDateTimeFormatOptions)
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  resetNative()
  stubToolRuns()
  outputFolderHolds({})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  setTimeZone('Europe/Berlin')
  jobs = new TabJobs()
  written = []
  replyTakesAssets = true
  deletedImages = []
})

afterEach(() => {
  jobs.stopAll()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('runJsEval', () => {
  it('runs the code as a job that the call waits for, with the module of Dez, the description of the run, the code, and copies of the inputs in a new run folder, and gives the value and the run time', async () => {
    native.program = returns('2')

    const result = await runJsEval(codeCall({ inputs: '@a @c', timeout_seconds: 20 }), running(), context())

    const folder = deletedWorkFolder()
    expect(result).toStrictEqual({ content: `2${NO_TIME}`, isError: false })
    expect(native.savedFiles.map(({ file, content }) => [file, content])).toStrictEqual([
      [{ root: 'cache', path: `${folder}/${JS_EVAL_RUNNER_FILE}` }, JS_EVAL_RUNNER],
      [{ root: 'cache', path: `${folder}/${RUN_DESCRIPTION_FILE}` }, expect.any(String)],
      [{ root: 'cache', path: `${folder}/${JS_EVAL_CODE_FILE}` }, jsEvalCodeFile('return 1 + 1')],
    ])
    expect(runDescription(folder)).toStrictEqual({
      kind: 'code',
      inputs: [
        { id: 'a', kind: 'image', type: 'image/jpeg', path: `${CACHE_DIR}/${folder}/a.jpg` },
        { id: 'c', kind: 'video', type: 'video/webm', path: `${CACHE_DIR}/${folder}/c.webm` },
      ],
      outputFolder: `${CACHE_DIR}/${folder}/output`,
      workFolder: `${APP_DIR}/${CONVERSATION_WORK_FOLDER}`,
      fonts: SHIPPED_FONTS.map(({ file, family, weight, scripts }) => ({ file, family, weight, scripts, path: `${RESOURCE_DIR}/${FONT_FOLDER}/${file}` })),
    })
    // The input of the program takes the answers of the tool calls, and
    // the code can always load skia-canvas.
    expect(native.runs.map(({ run }) => run)).toStrictEqual([{
      tool: 'dez-deno',
      args: [JS_EVAL_RUNNER_FILE],
      folder,
      inputs: [{ name: 'a.jpg', source: RED }, { name: 'c.webm', source: FILM.src }],
      timeoutMs: 20_000,
      maxOutputBytes: JS_EVAL_OUTPUT_BYTES,
      stdin: true,
      conversationFolder: CONVERSATION_ID,
      nativeCanvas: true,
      timeZone: 'Europe/Berlin',
    }])
    // The call took the result of its job, which was never a job of the
    // model.
    expect(jobs.list()).toStrictEqual([])
    expect(jobs.ready).toBe(0)
  })

  it('gives the run no time zone on a computer that tells none', async () => {
    setTimeZone('')
    native.program = returns('2')

    await runJsEval(codeCall(), running(), context())

    expect(native.runs[0].run).not.toHaveProperty('timeZone')
  })

  it('reads the line and the console output from the pieces of both streams', async () => {
    const line = protocolLine({ type: 'result', text: '2' })
    native.program = async (_run, onOutput) => {
      onOutput({ stream: 'stdout', text: `step 1\n${line.slice(0, 9)}` })
      onOutput({ stream: 'stderr', text: 'a warning\n' })
      onOutput({ stream: 'stdout', text: line.slice(9) })
      return ENDED
    }

    expect(await runJsEval(codeCall(), running(), context())).toStrictEqual({ content: `2\n\nConsole output of the code:\nstep 1\na warning${NO_TIME}`, isError: false })
  })

  // The clock counts what the program did, not the files that Dez wrote
  // before it or kept after it.
  it('tells the time that the program ran as the last paragraph of the result, before the lines of its assets', async () => {
    native.program = taking(2400, returns('drew'))
    outputFolderHolds({ 'chart.png': PNG_BYTES })

    const result = await runJsEval(codeCall(), running(), context())

    expect(result.content.split('\n').slice(-3)).toStrictEqual(['', 'The code ran for 2.4 seconds.', `${madeAssetText('image', 'x')}.`])
  })

  it('puts the files of the output folder into the reply as assets of js_eval, and names each by its new id', async () => {
    native.program = returns('drew')
    outputFolderHolds({ 'chart.png': PNG_BYTES })

    const result = await runJsEval(codeCall(), running(), context())

    expect(written).toStrictEqual([{ source: expect.stringMatching(new RegExp(`^${APP_DIR}/assets/generated/images/.+\\.png$`)), options: { tool: 'js_eval' } }])
    expect(result.isError).toBe(false)
    expect(result.content).toMatch(/^drew\n\n.*chart\.png \(image\)/)
    expect(result.content.split('\n').at(-1)).toBe(`${madeAssetText('image', 'x')}.`)
  })

  it('gives an error result, and deletes the file, when the reply takes no asset any more', async () => {
    native.program = returns('drew')
    outputFolderHolds({ 'chart.png': PNG_BYTES })
    replyTakesAssets = false

    const result = await runJsEval(codeCall(), running(), context())

    expect(result.isError).toBe(true)
    expect(deletedImages).toStrictEqual([written[0].source])
  })

  it('runs the tool calls of the code as calls of its job: the code knows each asset that they make by its handle, and the reply gets the asset with the marks of the call that made it', async () => {
    native.program = callingProgram(['dez.tools/image/flip', 'dez.tools/jobs_wait'])
    toolRuns.tool = async (call, _signal, toolContext) => {
      if (call.name === 'image') return { content: `${madeAssetText('image', toolContext.writeImage('/x/flipped.png') ?? '')}.`, isError: false }
      // `jobs_wait` writes what the job of another tool made, as a part of
      // its work.
      toolContext.writeClip(CLIP, { tool: 'model_invoke', model: FLUX, madeBy: 'j-1', hidden: 'j-1' })
      return TOOL_DONE
    }

    const result = await runJsEval(codeCall(), running(), context())

    expect(answers()).toStrictEqual([
      { id: 1, text: 'Made the image @&1.', isError: false },
      { id: 2, text: 'done', isError: false },
    ])
    expect(written).toStrictEqual([
      { source: '/x/flipped.png', options: { tool: 'image' } },
      { source: CLIP.src, options: { tool: 'model_invoke', model: FLUX, madeBy: 'j-1', hidden: 'j-1' } },
    ])
    expect(result.isError).toBe(false)
    expect(result.content.split('\n').slice(-2)).toStrictEqual([
      `${madeAssetText('image', 'x')} (handle &1).`,
      `${madeAssetText('audio', 'y')} (handle &2).`,
    ])
    expect(result.bridged).toStrictEqual({
      calls: [
        { name: 'image', arguments: { command: 'flip', parameters: '{}' }, status: 'success', result: 'Made the image @&1.' },
        { name: 'jobs_wait', arguments: {}, status: 'success', result: 'done' },
      ],
      more: 0,
    })
  })

  it('gives the error of code that threw, with /run, /work, and /libs for the real paths of the folders of the run, and keeps no file of the output folder', async () => {
    native.canonicalPath = (path) => path.replace(/^\/home\/u\/\.(cache|config)/, '/mnt/disk/$1')
    outputFolderHolds({ 'chart.png': PNG_BYTES })
    const work = `${APP_DIR}/${CONVERSATION_WORK_FOLDER}`
    native.program = async ({ folder }, onOutput) => {
      const joined = `${CACHE_DIR}/${folder}`
      onOutput({ stream: 'stdout', text: `cwd ${native.canonicalPath(joined)}, made as ${joined}\n` })
      onOutput({ stream: 'stdout', text: `kept ${native.canonicalPath(work)}/a.json and ${work}/b.json\n` })
      onOutput({ stream: 'stdout', text: protocolLine({ type: 'error', text: `Error: x\n    at f (file://${RESOURCE_DIR}/libs/three/x.js:3:1)\n    at default (file://${native.canonicalPath(joined)}/code.ts:1:41)` }) })
      return ENDED
    }

    const result = await runJsEval(codeCall(), running(), context())

    expect(result.isError).toBe(true)
    expect(result.content).toContain('Error: x\n    at f (file:///libs/three/x.js:3:1)\n    at default (file:///run/code.ts:1:41)')
    expect(result.content).toContain('Console output of the code:\ncwd /run, made as /run\nkept /work/a.json and /work/b.json')
    expect(result.content).not.toMatch(/\/home\/u|\/mnt\/disk/)
    expect(result.content.endsWith(NO_TIME)).toBe(true)
    expect(native.listedTrees).toStrictEqual([])
    expect(written).toStrictEqual([])
    deletedWorkFolder()
  })

  it('gives the list of the tool calls of code that threw', async () => {
    native.program = callingProgram(['dez.tools/jobs_list'], { type: 'error', text: 'Error: x' })

    const result = await runJsEval(codeCall(), running(), context())

    expect(result).toMatchObject({ isError: true, bridged: { calls: [LIST_CALL], more: 0 } })
  })

  it('gives the text of the time limit, with the time that the program ran, for code that ran too long, with no console output and no list of its tool calls', async () => {
    vi.useFakeTimers()
    native.program = async (_run, onOutput) => {
      onOutput({ stream: 'stdout', text: 'step 1\n' })
      return untilCancelled()
    }

    const result = await runJsEval({ ...codeCall(), timeoutMs: 200 }, running(), context())

    expect(result).toStrictEqual({ content: `${codeTimedOutText(200)}\n\nThe code ran for 0.2 seconds.`, isError: true })
    await vi.waitFor(() => deletedWorkFolder())
  })

  // Dez's own clock of the job ends the run first in most cases.
  it('gives the text of the time limit with the run time when the program tells that its limit passed', async () => {
    native.program = taking(20_000, async () => ({ kind: 'timedOut' }))

    expect(await runJsEval(codeCall({ timeout_seconds: 20 }), running(), context())).toStrictEqual({ content: `${codeTimedOutText(20_000)}\n\nThe code ran for 20 seconds.`, isError: true })
  })

  it('gives the error of output files that Dez could not keep with the run time', async () => {
    native.program = taking(400, returns('drew'))
    native.fileTree = () => {
      throw new Error('The disk is gone.')
    }

    expect(await runJsEval(codeCall(), running(), context())).toStrictEqual({ content: `${scriptOutputNotStoredText('js_eval', 'code')}\n\nThe code ran for 0.4 seconds.`, isError: true })
  })

  it('gives the job of code that still runs at the end of the wait of its call, and the result of the job tells the whole time that the program ran', async () => {
    vi.useFakeTimers()
    native.program = async (run, onOutput) => {
      await new Promise((resolve) => setTimeout(resolve, 2400))
      return returns('2')(run, onOutput)
    }

    const call = runJsEval(codeCall(), running(), context())
    await vi.advanceTimersByTimeAsync(JS_EVAL_CALL_WAIT_MS)
    const [job] = jobs.list()

    expect(await call).toStrictEqual({ content: codeRunsAsJobText(job.id, 1), isError: false })
    expect(job).toMatchObject({ tool: 'js_eval', status: 'running', call: { number: 1, label: 'return 1 + 1' } })
    await vi.advanceTimersByTimeAsync(1400)
    expect(await jobs.wait(running())).toMatchObject([{ id: job.id, status: 'finished', text: '2\n\nThe code ran for 2.4 seconds.', call: { number: 1 } }])
    await vi.waitFor(() => deletedWorkFolder())
  })

  it('gives the jobs that the tool calls of a quick run started the first numbers, with no gap for the run', async () => {
    const invoke = { selector: 'dez.tools/model_invoke', arguments: { model: 'venice/flux', prompt: 'A fox.' } }
    native.program = callingProgram([invoke, invoke])
    toolRuns.tool = async (_call, _signal, toolContext) => {
      const { id, number } = toolContext.jobs.start('model_invoke', heldWork().work, LONG)
      return { content: jobStartedText(id, number), isError: false }
    }

    await runJsEval(codeCall(), running(), context())

    expect(jobs.list().map(({ call }) => call.number)).toStrictEqual([1, 2])
    expect(jobs.start('image', heldWork().work, LONG).number).toBe(3)
  })

  it('tells of a computer whose system cannot confine Deno as an error result, with no text of the native error', async () => {
    native.program = async () => {
      throw 'No confinement: this kernel has no Landlock, and Dez does not run this program with no confinement'
    }

    expect(await runJsEval(codeCall(), running(), context())).toStrictEqual({ content: programNotConfinedText('deno'), isError: true })
  })

  it('starts no run when the reply has the most open jobs', async () => {
    for (let count = 0; count < MAX_OPEN_JOBS; count++) jobs.start('apps', heldWork().work, LONG)

    expect(await refusalOf(runJsEval(codeCall(), running(), context()))).toBe(JOB_LIMIT_TEXT)
    expect(native.runs).toStrictEqual([])
  })

  it('cancels the job at a stop of the call during its wait: its code and its tool call stop, and the call rejects with the stop', async () => {
    const stop = new AbortController()
    native.program = async (_run, onOutput) => {
      onOutput({ stream: 'stdout', text: protocolLine({ type: 'call', id: 1, selector: 'dez.tools/jobs_wait' }) })
      return untilCancelled()
    }
    let toolSignal: AbortSignal | undefined
    toolRuns.tool = (_call, signal) => new Promise((resolve) => {
      toolSignal = signal
      signal.addEventListener('abort', () => resolve({ content: 'stopped', isError: true }))
    })

    const work = failureOf(runJsEval(codeCall(), stop.signal, context()))
    await vi.waitFor(() => expect(toolSignal).toBeDefined())
    stop.abort(STOP)

    expect(await work).toBe(STOP)
    expect(toolSignal?.aborted).toBe(true)
    // The job was never a job of the model.
    expect(jobs.list()).toStrictEqual([])
    expect(jobs.running).toBe(0)
    await vi.waitFor(() => deletedWorkFolder())
    expect(native.cancelledRuns).toStrictEqual([native.runs[0].runId])
  })
})
