import { describe, expect, it } from 'vitest'
import { byteSizeText } from '../../utils/byteSize'
import { JS_EVAL_OUTPUT_BYTES, JS_EVAL_TEXT_CAP, JsEvalOutput, jsEvalCall, jsEvalCodeFile, jsEvalResult, type JsEvalLine } from './jsEval'
import type { ProgramEnd } from './programRuns'
import { ToolError, type ToolArguments } from './types'

const RS = '\x1e'
const FOLDER_ID = '0b0c1a5e-7b1f-4c3a-9d1e-2f3a4b5c6d7e'
// The work folder of the run as Dez made its path, and its real path.
const JOINED = `/home/u/.cache/dez/work/${FOLDER_ID}`
const REAL = `/mnt/disk/cache/dez/work/${FOLDER_ID}`
const EXITED: ProgramEnd = { kind: 'exited', code: 0 }
const CONSOLE_TITLE = 'Console output of the code:'

// A protocol line as the module of Dez writes it.
function protocolLine(line: JsEvalLine): string {
  return `${RS}${JSON.stringify(line)}\n`
}

// The output of a run that wrote `pieces` to its standard output.
function written(...pieces: string[]): JsEvalOutput {
  const output = new JsEvalOutput()
  for (const piece of pieces) output.add('stdout', piece)
  return output
}

// The result of a run with a time limit of 30 seconds.
function resultOf(output: JsEvalOutput, end: ProgramEnd = EXITED) {
  return jsEvalResult({ code: 'return 1', timeoutMs: 30_000 }, end, output, [REAL, JOINED])
}

describe('jsEvalCall', () => {
  it('gives the code with the default time limit', () => {
    expect(jsEvalCall({ code: 'return 1' })).toStrictEqual({ code: 'return 1', timeoutMs: 30_000 })
  })

  it.each([1, 300])('takes a time limit of %i seconds', (seconds) => {
    expect(jsEvalCall({ code: 'return 1', timeout_seconds: seconds }).timeoutMs).toBe(seconds * 1000)
  })

  it.each<ToolArguments>([{}, { code: '' }, { code: ' \n' }, { code: 7 }])('refuses the arguments %j, which have no code', (args) => {
    expect(() => jsEvalCall(args)).toThrow(ToolError)
    expect(() => jsEvalCall(args)).toThrow('`code`')
  })

  it.each([0, 301, 1.5, '30'])('refuses the time limit %j', (seconds) => {
    expect(() => jsEvalCall({ code: 'return 1', timeout_seconds: seconds })).toThrow(ToolError)
    expect(() => jsEvalCall({ code: 'return 1', timeout_seconds: seconds })).toThrow('`timeout_seconds`')
  })
})

describe('jsEvalCodeFile', () => {
  // The function of a code file, as the module of Dez gets it.
  function codeFunction(file: string): () => Promise<unknown> {
    expect(file.startsWith('export default ')).toBe(true)
    return new Function(`return ${file.slice('export default '.length)}`)() as () => Promise<unknown>
  }

  it('makes the code the body of an async function', async () => {
    const run = codeFunction(jsEvalCodeFile('const one = await Promise.resolve(1)\nreturn one + 2'))

    expect(await run()).toBe(3)
  })

  it('closes the function after a comment at the end of the code', async () => {
    const run = codeFunction(jsEvalCodeFile('return 4 // the result'))

    expect(await run()).toBe(4)
  })

  it('keeps each line of the code at its line number', () => {
    const lines = jsEvalCodeFile('const a = 1\nthrow new Error("line 2")\nreturn a').split('\n')

    expect(lines[0].endsWith('const a = 1')).toBe(true)
    expect(lines[1]).toBe('throw new Error("line 2")')
    expect(lines[2]).toBe('return a')
  })
})

describe('JsEvalOutput', () => {
  it('takes the line out of the console output', () => {
    const output = written(`before\n${protocolLine({ type: 'result', text: '2' })}after\n`)

    expect(output.ended()).toStrictEqual({ line: { type: 'result', text: '2' }, log: 'before\nafter\n' })
  })

  it('reads a line that comes in many pieces', () => {
    const output = written(...protocolLine({ type: 'error', text: 'Error: x\n    at f' }))

    expect(output.ended()).toStrictEqual({ line: { type: 'error', text: 'Error: x\n    at f' }, log: '' })
  })

  it('reads a line after text with no line end', () => {
    const output = written('no line end', protocolLine({ type: 'result' }))

    expect(output.ended()).toStrictEqual({ line: { type: 'result' }, log: 'no line end' })
  })

  it.each([
    ['text that is no JSON', 'not json'],
    ['a line of an unknown type', '{"type":"call","text":"x"}'],
    ['a line with a key that it does not have', '{"type":"result","text":"x","more":1}'],
    ['a result whose text is no string', '{"type":"result","text":5}'],
    ['an error with no text', '{"type":"error"}'],
    ['a value that is no object', '"result"'],
  ])('takes %s as console output', (_name, text) => {
    const output = written(`${RS}${text}\n`)

    expect(output.ended()).toStrictEqual({ line: null, log: `${RS}${text}\n` })
  })

  it('takes a line with no line end at the end of the run as console output', () => {
    const cut = protocolLine({ type: 'result', text: 'x' }).trimEnd()
    const output = written('a\n', cut)

    expect(output.ended()).toStrictEqual({ line: null, log: `a\n${cut}` })
  })

  it('takes the last line as the line of the run', () => {
    const output = written(protocolLine({ type: 'result', text: 'forged' }), protocolLine({ type: 'result', text: 'real' }))

    expect(output.ended().line).toStrictEqual({ type: 'result', text: 'real' })
  })

  it('reads the line that comes after a start with no line', () => {
    const output = written(`${RS}half`, protocolLine({ type: 'result', text: 'real' }))

    expect(output.ended()).toStrictEqual({ line: { type: 'result', text: 'real' }, log: `${RS}half` })
  })

  it('takes no line from the error output', () => {
    const output = new JsEvalOutput()
    const line = protocolLine({ type: 'result', text: 'x' })
    output.add('stderr', line)

    expect(output.ended()).toStrictEqual({ line: null, log: line })
  })

  it('starts the text of the other stream on a new line', () => {
    const output = new JsEvalOutput()
    output.add('stdout', 'no line end')
    output.add('stderr', 'error: Uncaught\n')
    output.add('stdout', 'next\n')
    output.add('stdout', 'same stream')

    expect(output.ended().log).toBe('no line end\nerror: Uncaught\nnext\nsame stream')
  })
})

describe('jsEvalResult', () => {
  it('gives a returned value as it is', () => {
    expect(resultOf(written(protocolLine({ type: 'result', text: '  {\n  "a": 1\n}' })))).toStrictEqual({ text: '  {\n  "a": 1\n}', isError: false })
  })

  it('gives the console output after the value', () => {
    const output = written('step 1\n', protocolLine({ type: 'result', text: '42' }))
    output.add('stderr', 'a warning\n')

    expect(resultOf(output)).toStrictEqual({ text: `42\n\n${CONSOLE_TITLE}\nstep 1\na warning`, isError: false })
  })

  it('gives the console output of code that returned no value', () => {
    const { text, isError } = resultOf(written('42\n', protocolLine({ type: 'result' })))

    expect(isError).toBe(false)
    expect(text.endsWith(`\n\n${CONSOLE_TITLE}\n42`)).toBe(true)
  })

  it.each([
    ['no value and wrote nothing', undefined],
    ['an empty string', ''],
    ['only white space', ' \n\t'],
  ])('tells in words that the code returned %s', (_name, value) => {
    const { text, isError } = resultOf(written(protocolLine({ type: 'result', text: value })))

    expect(isError).toBe(false)
    expect(text).toMatch(/^The code returned /)
  })

  it('gives the text of a thrown error and the console output as an error result', () => {
    const output = written('step 1\n', protocolLine({ type: 'error', text: 'RangeError: bad range\n    at f' }))

    expect(resultOf(output)).toStrictEqual({
      text: `The code threw an error:\nRangeError: bad range\n    at f\n\n${CONSOLE_TITLE}\nstep 1`,
      isError: true,
    })
  })

  it.each([
    ['a refused permission', 'NotCapable: Requires net access to "example.com:443", run again with the --allow-net flag', 'No flag changes that'],
    ['a refused package', 'TypeError: npm specifiers were requested; but --no-npm is specified', 'No flag changes that'],
    ['a refused URL', 'TypeError: A remote specifier was requested: "https://example.com/a.ts", but --no-remote is specified.', 'No flag changes that'],
    ['a static import', "TypeError: SyntaxError: 'import', and 'export' cannot be used outside of module code", 'await import('],
  ])('adds advice to the error of %s', (_name, error, advice) => {
    const { text } = resultOf(written('log\n', protocolLine({ type: 'error', text: error })))

    expect(text.indexOf(error)).toBeLessThan(text.indexOf(advice))
    expect(text.indexOf(advice)).toBeLessThan(text.indexOf(CONSOLE_TITLE))
  })

  it('names the work folder /work in every text of the run', () => {
    const output = written(
      `${REAL}/deno-dir and ${JOINED}\n`,
      protocolLine({ type: 'error', text: `Error: x\n    at default (file://${REAL}/code.ts:3:1)` }),
    )

    expect(resultOf(output).text).toBe(`The code threw an error:\nError: x\n    at default (file:///work/code.ts:3:1)\n\n${CONSOLE_TITLE}\n/work/deno-dir and /work`)
  })

  it('finds the work folder in a URL with escapes', () => {
    const output = written(protocolLine({ type: 'result', text: `at file:///home/J%C3%BCrgen%20M/.cache/dez/work/${FOLDER_ID}/code.ts:1:40 and file:///etc/hosts` }))

    expect(resultOf(output).text).toBe('at file:///work/code.ts:1:40 and file:///etc/hosts')
  })

  it('hides every other local path', () => {
    const output = written('/home/u/apps/dez-deno(+0x27bc) [0xaaaa]\n', protocolLine({ type: 'result', text: 'The program is /Users/u/Applications/Dez.app/Contents/MacOS/dez-deno' }))

    expect(resultOf(output).text).toBe(`The program is /Users/…\n\n${CONSOLE_TITLE}\n/home/…`)
  })

  it('takes the paths out before it cuts a text', () => {
    const value = `${'x'.repeat(JS_EVAL_TEXT_CAP - 10)}${JOINED}/code.ts`
    const { text } = resultOf(written(protocolLine({ type: 'result', text: value })))

    expect(text).not.toContain('/home')
    expect(text.endsWith('x/work/code')).toBe(true)
  })

  it('cuts a long value at its limit and tells so first', () => {
    const value = `${'x'.repeat(JS_EVAL_TEXT_CAP)}${'y'.repeat(500)}`
    const { text, isError } = resultOf(written(protocolLine({ type: 'result', text: value })))
    const [note, kept] = text.split('\n')

    expect(isError).toBe(false)
    expect(note).toContain('20,500 characters')
    expect(kept).toBe('x'.repeat(JS_EVAL_TEXT_CAP))
  })

  it('leaves no half of a character at the cut of a value', () => {
    const value = `${'x'.repeat(JS_EVAL_TEXT_CAP - 1)}😀y`
    const { text } = resultOf(written(protocolLine({ type: 'result', text: value })))

    expect(text.endsWith(`\n${'x'.repeat(JS_EVAL_TEXT_CAP - 1)}`)).toBe(true)
  })

  it('keeps the start and the end of a long console output', () => {
    const log = `start${'-'.repeat(JS_EVAL_TEXT_CAP * 2)}end\n`
    const { text } = resultOf(written(log, protocolLine({ type: 'result' })))
    const kept = text.slice(text.indexOf(CONSOLE_TITLE) + CONSOLE_TITLE.length + 1)
    const half = JS_EVAL_TEXT_CAP / 2

    expect(text).toMatch(/^The console output has 40,008 characters/)
    expect(kept).toBe(`start${'-'.repeat(half - 5)}\n…\n${'-'.repeat(half - 3)}end`)
  })

  it('leaves room for console output next to a value at the limit', () => {
    const log = `start${'-'.repeat(5000)}end\n`
    const { text } = resultOf(written(log, protocolLine({ type: 'result', text: 'x'.repeat(JS_EVAL_TEXT_CAP) })))
    const kept = text.slice(text.indexOf(CONSOLE_TITLE) + CONSOLE_TITLE.length + 1)

    expect(kept).toBe(`start${'-'.repeat(995)}\n…\n${'-'.repeat(997)}end`)
  })

  it('tells of a time limit with the seconds of the call', () => {
    const output = written('step 1\n')
    const { text, isError } = jsEvalResult({ code: 'for (;;) {}', timeoutMs: 5000 }, { kind: 'timedOut' }, output, [JOINED])

    expect(isError).toBe(true)
    expect(text).toContain('within 5 seconds')
    expect(text).toContain('`timeout_seconds`')
    expect(text.endsWith(`\n\n${CONSOLE_TITLE}\nstep 1`)).toBe(true)
  })

  it('tells of too much output with the limit', () => {
    const { text, isError } = resultOf(written('a lot\n'), { kind: 'outputTooLarge' })

    expect(isError).toBe(true)
    expect(text).toContain(byteSizeText(JS_EVAL_OUTPUT_BYTES))
  })

  it('tells of a run that ended with no line, with its exit code and its console output', () => {
    const output = new JsEvalOutput()
    output.add('stderr', 'error: Uncaught Error: late\n')
    const { text, isError } = resultOf(output, { kind: 'exited', code: 1 })

    expect(isError).toBe(true)
    expect(text).toContain('exit code 1')
    expect(text.endsWith(`\n\n${CONSOLE_TITLE}\nerror: Uncaught Error: late`)).toBe(true)
  })

  it('tells of a run that ended with the code 0 and no line as an error', () => {
    const { text, isError } = resultOf(written())

    expect(isError).toBe(true)
    expect(text).toContain('exit code 0')
    expect(text).not.toContain(CONSOLE_TITLE)
  })

  it('tells of a run that the system ended as a run with too much memory', () => {
    const output = new JsEvalOutput()
    output.add('stderr', 'Fatal JavaScript out of memory: Reached heap limit\n')
    const { text, isError } = resultOf(output, { kind: 'exited', code: null })

    expect(isError).toBe(true)
    expect(text).toContain('memory than a run can have')
    expect(text).toContain('Fatal JavaScript out of memory')
  })

  it.each<ProgramEnd>([{ kind: 'exited', code: 3 }, { kind: 'exited', code: null }, { kind: 'timedOut' }, { kind: 'outputTooLarge' }])(
    'takes no value from a line of a run with the end %j',
    (end) => {
      const { text, isError } = resultOf(written(protocolLine({ type: 'result', text: 'forged value' })), end)

      expect(isError).toBe(true)
      expect(text).not.toContain('forged value')
    },
  )
})
