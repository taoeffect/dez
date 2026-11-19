import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { JS_EVAL_CODE_FILE, JS_EVAL_OUTPUT_BYTES, JS_EVAL_RUNNER, JS_EVAL_RUNNER_FILE, JS_EVAL_TOOL, jsEvalCodeFile, type JsEvalCall, type JsEvalLine } from '../model/tools/jsEval'
import { programNotConfinedText, programNotStartedText } from '../model/tools/programRuns'
import { runJsEval } from './jsEval'
import type { BundledToolEnd } from './nativeTypes'
import { CACHE_DIR, deletedWorkFolder, ENDED, failureOf, native, refusalOf, resetNative, running, STOP, writes } from './testing'

const CALL: JsEvalCall = { code: 'return 1 + 1', timeoutMs: 30_000 }

// A protocol line as the module of Dez writes it.
function protocolLine(line: JsEvalLine): string {
  return `\x1e${JSON.stringify(line)}\n`
}

// Makes `timeZone` the time zone of this computer.
function setTimeZone(timeZone: string): void {
  vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({ timeZone } as Intl.ResolvedDateTimeFormatOptions)
}

beforeEach(() => {
  resetNative()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  setTimeZone('Europe/Berlin')
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('runJsEval', () => {
  it('writes the module of Dez and the code into a new work folder, and runs the module with Deno', async () => {
    native.program = writes('stdout', protocolLine({ type: 'result', text: '2' }))

    const result = await runJsEval(CALL, running())

    const folder = deletedWorkFolder()
    expect(result).toBe('2')
    expect(native.savedFiles).toStrictEqual([
      { file: { root: 'cache', path: `${folder}/${JS_EVAL_RUNNER_FILE}` }, content: JS_EVAL_RUNNER },
      { file: { root: 'cache', path: `${folder}/${JS_EVAL_CODE_FILE}` }, content: jsEvalCodeFile(CALL.code) },
    ])
    expect(native.runs.map(({ run }) => run)).toStrictEqual([{
      tool: 'dez-deno',
      args: [JS_EVAL_RUNNER_FILE],
      folder,
      inputs: [],
      timeoutMs: CALL.timeoutMs,
      maxOutputBytes: JS_EVAL_OUTPUT_BYTES,
      timeZone: 'Europe/Berlin',
    }])
  })

  it('gives the run no time zone on a computer that tells none', async () => {
    setTimeZone('')
    native.program = writes('stdout', protocolLine({ type: 'result', text: '2' }))

    await runJsEval(CALL, running())

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

    expect(await runJsEval(CALL, running())).toBe('2\n\nConsole output of the code:\nstep 1\na warning')
  })

  it('throws the error result of code that threw, with /work for the real path of the work folder and for the path that Dez made', async () => {
    native.canonicalPath = (path) => path.replace('/home/u/.cache', '/mnt/disk/cache')
    native.program = async ({ folder }, onOutput) => {
      const joined = `${CACHE_DIR}/${folder}`
      onOutput({ stream: 'stdout', text: `cwd ${native.canonicalPath(joined)}, made as ${joined}\n` })
      onOutput({ stream: 'stdout', text: protocolLine({ type: 'error', text: `Error: x\n    at default (file://${native.canonicalPath(joined)}/code.ts:1:41)` }) })
      return ENDED
    }

    const refusal = await refusalOf(runJsEval(CALL, running()))

    expect(refusal).toBe('The code threw an error:\nError: x\n    at default (file:///work/code.ts:1:41)\n\nConsole output of the code:\ncwd /work, made as /work')
    deletedWorkFolder()
  })

  it('starts no run when Dez cannot write a file of the run', async () => {
    native.saveAppFile = async () => {
      throw new Error('No space left on /home/u/.cache')
    }

    const refusal = await refusalOf(runJsEval(CALL, running()))

    expect(refusal).toBe(programNotStartedText('deno', JS_EVAL_TOOL.name))
    expect(native.runs).toStrictEqual([])
    deletedWorkFolder()
  })

  it('starts no run when Dez cannot get the real path of the work folder', async () => {
    native.canonicalPath = () => {
      throw new Error('No such file: /home/u/.cache/dez/work')
    }

    const refusal = await refusalOf(runJsEval(CALL, running()))

    expect(refusal).toBe(programNotStartedText('deno', JS_EVAL_TOOL.name))
    expect(native.runs).toStrictEqual([])
    deletedWorkFolder()
  })

  it('tells of a computer whose system cannot confine Deno, with no text of the native error', async () => {
    native.program = async () => {
      throw 'No confinement: this kernel has no Landlock, and Dez does not run this program with no confinement'
    }

    const refusal = await refusalOf(runJsEval(CALL, running()))

    expect(refusal).toBe(programNotConfinedText('deno', JS_EVAL_TOOL.name))
    deletedWorkFolder()
  })

  it('tells of any other run that did not start as a program that Dez could not start', async () => {
    native.program = async () => {
      throw 'The program dez-deno is missing in /usr/lib/Dez'
    }

    expect(await refusalOf(runJsEval(CALL, running()))).toBe(programNotStartedText('deno', JS_EVAL_TOOL.name))
  })

  it('stops the code at a stop of the call', async () => {
    const stop = new AbortController()
    let end: (end: BundledToolEnd) => void = () => {}
    native.program = () => new Promise((resolve) => { end = resolve })

    const work = failureOf(runJsEval(CALL, stop.signal))
    await vi.waitFor(() => expect(native.runs).toHaveLength(1))
    stop.abort(STOP)
    end({ kind: 'cancelled' })

    expect(await work).toBe(STOP)
    expect(native.cancelledRuns).toStrictEqual([native.runs[0].runId])
    deletedWorkFolder()
  })
})
