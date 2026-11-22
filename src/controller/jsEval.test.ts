import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SHOWN_PICTURE_FOLDER, type ShownPicture } from '../model/chat/shownPictures'
import { madeAssetText } from '../model/tools/jobs'
import {
  JS_EVAL_CODE_FILE,
  JS_EVAL_OUTPUT_BYTES,
  JS_EVAL_RUNNER,
  JS_EVAL_RUNNER_FILE,
  JS_EVAL_TOOL,
  jsEvalAnswerLine,
  jsEvalCodeFile,
  RUN_DESCRIPTION_FILE,
  type JsEvalCall,
} from '../model/tools/jsEval'
import { programNotConfinedText, programNotStartedText } from '../model/tools/programRuns'
import { protocolLine } from '../model/tools/testing'
import { runJsEval } from './jsEval'
import type { BundledToolEnd } from './nativeTypes'
import {
  CACHE_DIR,
  callContext,
  callingProgram,
  deletedWorkFolder,
  ENDED,
  failureOf,
  native,
  refusalOf,
  resetNative,
  running,
  STOP,
  stubToolRuns,
  TOOL_DONE,
  toolRuns,
  writes,
} from './testing'

const CALL: JsEvalCall = { code: 'return 1 + 1', timeoutMs: 30_000 }
const PICTURE: ShownPicture = { file: 'p1.jpg', label: 'The image @a', width: 512, height: 512, bytes: 3000 }
// The delete of the copy of `PICTURE`.
const PICTURE_DELETE = { root: 'app', path: `${SHOWN_PICTURE_FOLDER}/${PICTURE.file}`, folder: false }
// The entry of a `jobs_list` call of the code that gave `TOOL_DONE`.
const LIST_CALL = { name: 'jobs_list', arguments: {}, status: 'success', result: TOOL_DONE.content }

// Makes `timeZone` the time zone of this computer.
function setTimeZone(timeZone: string): void {
  vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({ timeZone } as Intl.ResolvedDateTimeFormatOptions)
}

beforeEach(() => {
  resetNative()
  stubToolRuns()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  setTimeZone('Europe/Berlin')
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('runJsEval', () => {
  it('writes the module of Dez, the description of the run, and the code into a new work folder, and runs the module with Deno, with an input', async () => {
    native.program = writes('stdout', protocolLine({ type: 'result', text: '2' }))

    const result = await runJsEval(CALL, running(), callContext())

    const folder = deletedWorkFolder()
    expect(result).toStrictEqual({ content: '2', isError: false })
    expect(native.savedFiles).toStrictEqual([
      { file: { root: 'cache', path: `${folder}/${JS_EVAL_RUNNER_FILE}` }, content: JS_EVAL_RUNNER },
      { file: { root: 'cache', path: `${folder}/${RUN_DESCRIPTION_FILE}` }, content: '{"kind":"code"}' },
      { file: { root: 'cache', path: `${folder}/${JS_EVAL_CODE_FILE}` }, content: jsEvalCodeFile(CALL.code) },
    ])
    expect(native.runs.map(({ run }) => run)).toStrictEqual([{
      tool: 'dez-deno',
      args: [JS_EVAL_RUNNER_FILE],
      folder,
      inputs: [],
      timeoutMs: CALL.timeoutMs,
      maxOutputBytes: JS_EVAL_OUTPUT_BYTES,
      stdin: true,
      timeZone: 'Europe/Berlin',
    }])
  })

  it('gives the run no time zone on a computer that tells none', async () => {
    setTimeZone('')
    native.program = writes('stdout', protocolLine({ type: 'result', text: '2' }))

    await runJsEval(CALL, running(), callContext())

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

    expect(await runJsEval(CALL, running(), callContext())).toStrictEqual({ content: '2\n\nConsole output of the code:\nstep 1\na warning', isError: false })
  })

  it('gives the error result of code that threw, with /run for the real path of the run folder and for the path that Dez made', async () => {
    native.canonicalPath = (path) => path.replace('/home/u/.cache', '/mnt/disk/cache')
    native.program = async ({ folder }, onOutput) => {
      const joined = `${CACHE_DIR}/${folder}`
      onOutput({ stream: 'stdout', text: `cwd ${native.canonicalPath(joined)}, made as ${joined}\n` })
      onOutput({ stream: 'stdout', text: protocolLine({ type: 'error', text: `Error: x\n    at default (file://${native.canonicalPath(joined)}/code.ts:1:41)` }) })
      return ENDED
    }

    const result = await runJsEval(CALL, running(), callContext())

    expect(result).toStrictEqual({
      content: 'The code threw an error:\nError: x\n    at default (file:///run/code.ts:1:41)\n\nConsole output of the code:\ncwd /run, made as /run',
      isError: true,
    })
    deletedWorkFolder()
  })

  it('runs a tool call of the code with the context of the call, gives the code its answer, and tells the model what the call made and the user what the call was', async () => {
    native.program = callingProgram(['dez.tools/image/flip'])
    toolRuns.tool = async (_call, _signal, context) => ({ content: `${madeAssetText('image', context.writeImage('/x/flipped.png') ?? '')}.`, isError: false })

    const result = await runJsEval(CALL, running(), callContext({ writeImage: () => 'b' }))

    expect(toolRuns.calls).toStrictEqual([{ name: 'image', arguments: { command: 'flip', parameters: '{}' } }])
    expect(native.inputWrites).toStrictEqual([{ runId: native.runs[0].runId, text: jsEvalAnswerLine(1, { text: 'Made the image @b.', isError: false }) }])
    expect(result).toStrictEqual({
      content: 'ok\n\nFrom the tool calls of the code:\nMade the image @b.',
      isError: false,
      bridged: { calls: [{ name: 'image', arguments: { command: 'flip', parameters: '{}' }, status: 'success', result: 'Made the image @b.' }], more: 0 },
    })
    deletedWorkFolder()
  })

  it('gives the pictures that the tool calls of the code showed', async () => {
    native.program = callingProgram(['dez.tools/jobs_list'])
    toolRuns.tool = async () => ({ ...TOOL_DONE, pictures: [PICTURE] })

    const result = await runJsEval(CALL, running(), callContext())

    expect(result).toStrictEqual({ content: 'ok', isError: false, pictures: [PICTURE], bridged: { calls: [LIST_CALL], more: 0 } })
    expect(native.deletedFiles).not.toContainEqual(PICTURE_DELETE)
  })

  it('gives the error result of code that failed with the tool calls of the code, and deletes their pictures', async () => {
    native.program = callingProgram(['dez.tools/jobs_list'], { type: 'error', text: 'Error: x' })
    toolRuns.tool = async () => ({ ...TOOL_DONE, pictures: [PICTURE] })

    const result = await runJsEval(CALL, running(), callContext())

    expect(result).toMatchObject({ isError: true, bridged: { calls: [LIST_CALL], more: 0 } })
    expect(result).not.toHaveProperty('pictures')

    expect(native.deletedFiles).toContainEqual(PICTURE_DELETE)
    deletedWorkFolder()
  })

  it('starts no run when Dez cannot write a file of the run', async () => {
    native.saveAppFile = async () => {
      throw new Error('No space left on /home/u/.cache')
    }

    const refusal = await refusalOf(runJsEval(CALL, running(), callContext()))

    expect(refusal).toBe(programNotStartedText('deno', JS_EVAL_TOOL.name))
    expect(native.runs).toStrictEqual([])
    deletedWorkFolder()
  })

  it('starts no run when Dez cannot get the real path of the work folder', async () => {
    native.canonicalPath = () => {
      throw new Error('No such file: /home/u/.cache/dez/work')
    }

    const refusal = await refusalOf(runJsEval(CALL, running(), callContext()))

    expect(refusal).toBe(programNotStartedText('deno', JS_EVAL_TOOL.name))
    expect(native.runs).toStrictEqual([])
    deletedWorkFolder()
  })

  it('tells of a computer whose system cannot confine Deno, with no text of the native error', async () => {
    native.program = async () => {
      throw 'No confinement: this kernel has no Landlock, and Dez does not run this program with no confinement'
    }

    const refusal = await refusalOf(runJsEval(CALL, running(), callContext()))

    expect(refusal).toBe(programNotConfinedText('deno'))
    deletedWorkFolder()
  })

  it('tells of any other run that did not start as a program that Dez could not start', async () => {
    native.program = async () => {
      throw 'The program dez-deno is missing in /usr/lib/Dez'
    }

    expect(await refusalOf(runJsEval(CALL, running(), callContext()))).toBe(programNotStartedText('deno', JS_EVAL_TOOL.name))
  })

  it('stops the code and its tool call at a stop of the call, and deletes the pictures of its tool calls', async () => {
    const stop = new AbortController()
    let end: (end: BundledToolEnd) => void = () => {}
    native.program = (_run, onOutput) => {
      onOutput({ stream: 'stdout', text: protocolLine({ type: 'call', id: 1, selector: 'dez.tools/jobs_list' }) })
      onOutput({ stream: 'stdout', text: protocolLine({ type: 'call', id: 2, selector: 'dez.tools/jobs_wait' }) })
      return new Promise((resolve) => { end = resolve })
    }
    // The reason of the stop of the tool call that waits.
    let toolStop: unknown
    toolRuns.tool = (call, signal) => {
      if (call.name === 'jobs_list') return Promise.resolve({ ...TOOL_DONE, pictures: [PICTURE] })
      return new Promise((resolve) => {
        signal.addEventListener('abort', () => {
          toolStop = signal.reason
          resolve({ content: 'stopped', isError: true })
        })
      })
    }

    const work = failureOf(runJsEval(CALL, stop.signal, callContext()))
    await vi.waitFor(() => expect(toolRuns.calls).toHaveLength(2))
    stop.abort(STOP)
    end({ kind: 'cancelled' })

    expect(toolStop).toBe(STOP)
    expect(await work).toBe(STOP)
    expect(native.cancelledRuns).toStrictEqual([native.runs[0].runId])
    expect(native.deletedFiles).toContainEqual(PICTURE_DELETE)
    deletedWorkFolder()
  })
})
