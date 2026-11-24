import { describe, expect, it } from 'vitest'
import { codeTimedOutText, errorAdvice, JS_EVAL_TEXT_CAP, JsEvalOutput, endedRun, jsEvalAnswerLine, jsEvalCall, jsEvalCodeFile, runResultText, textForModel, type RunOutcome } from './jsEval'
import type { ProgramEnd } from './programRuns'
import { CONVERSATION_ID, JOINED_RUN_FOLDER, JOINED_WORK_FOLDER, protocolLine, REAL_RUN_FOLDER, REAL_WORK_FOLDER, RUN_FOLDER_ID, RUN_FOLDERS } from './testing'
import { ToolError, type ToolArguments } from './types'

// The start of a protocol line.
const RS = '\x1e'
const EXITED: ProgramEnd = { kind: 'exited', code: 0 }
const CONSOLE_TITLE = 'Console output of the code:'

// The output of a run that wrote `pieces` to its standard output.
function written(...pieces: string[]): JsEvalOutput {
  const output = new JsEvalOutput()
  for (const piece of pieces) output.add('stdout', piece)
  return output
}

// The outcome of a run whose code returned `text`.
function returned(text: string): RunOutcome {
  return { isError: false, lead: null, given: { text, name: 'returned value' }, advice: [] }
}

// The result text of a run with `outcome` and the console output `log`,
// with the paths of the folders of a run taken out.
function resultText(outcome: RunOutcome, log = ''): string {
  return runResultText(outcome, log, (text) => textForModel(text, RUN_FOLDERS), () => [])
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
  function codeFunction(file: string): (dez?: unknown) => Promise<unknown> {
    expect(file.startsWith('export default ')).toBe(true)
    return new Function(`return ${file.slice('export default '.length)}`)() as (dez?: unknown) => Promise<unknown>
  }

  it('makes the code the body of an async function', async () => {
    const run = codeFunction(jsEvalCodeFile('const one = await Promise.resolve(1)\nreturn one + 2'))

    expect(await run()).toBe(3)
  })

  it('closes the function after a comment at the end of the code', async () => {
    const run = codeFunction(jsEvalCodeFile('return 4 // the result'))

    expect(await run()).toBe(4)
  })

  it('gives the code the object of the run as `dez`', async () => {
    const run = codeFunction(jsEvalCodeFile('return dez.sbp("dez.tools/jobs_list")'))

    expect(await run({ sbp: (selector: string) => `called ${selector}` })).toBe('called dez.tools/jobs_list')
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
    ['a line of an unknown type', '{"type":"other","text":"x"}'],
    ['a call with no id', '{"type":"call","selector":"dez.tools/jobs_list"}'],
    ['a call whose id is no integer', '{"type":"call","id":1.5,"selector":"dez.tools/jobs_list"}'],
    ['a call whose selector is no text', '{"type":"call","id":1,"selector":["dez.tools/jobs_list"]}'],
    ['a call with a key that it does not have', '{"type":"call","id":1,"selector":"dez.tools/jobs_list","more":1}'],
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

  it('gives a call line to its caller at once, and keeps it out of the line of the run and the console output', () => {
    const output = new JsEvalOutput()
    const call = { type: 'call' as const, id: 1, selector: 'dez.tools/image/scale', arguments: { image: 'a', width: 64 } }

    expect(output.add('stdout', `before\n${protocolLine(call)}after\n`)).toStrictEqual([call])
    expect(output.add('stdout', protocolLine({ type: 'result', text: '2' }))).toStrictEqual([])
    expect(output.ended()).toStrictEqual({ line: { type: 'result', text: '2' }, log: 'before\nafter\n' })
  })

  it('gives a call line that comes in many pieces when its line end comes', () => {
    const output = new JsEvalOutput()
    const call = { type: 'call' as const, id: 7, selector: 'dez.tools/jobs_list' }
    const calls = [...protocolLine(call)].map((piece) => output.add('stdout', piece))

    expect(calls.slice(0, -1).flat()).toStrictEqual([])
    expect(calls.at(-1)).toStrictEqual([call])
  })

  it('gives the call lines of one piece in their order', () => {
    const output = new JsEvalOutput()
    const calls = [3, 1, 2].map((id) => ({ type: 'call' as const, id, selector: 'dez.tools/jobs_list' }))

    expect(output.add('stdout', calls.map(protocolLine).join('log\n'))).toStrictEqual(calls)
  })

  it('keeps the line of the run that came before a call line', () => {
    const output = written(protocolLine({ type: 'result', text: '2' }), protocolLine({ type: 'call', id: 1, selector: 'dez.tools/jobs_list' }))

    expect(output.ended().line).toStrictEqual({ type: 'result', text: '2' })
  })

  it('takes no call line from the error output', () => {
    const output = new JsEvalOutput()
    const line = protocolLine({ type: 'call', id: 1, selector: 'dez.tools/jobs_list' })

    expect(output.add('stderr', line)).toStrictEqual([])
    expect(output.ended().log).toBe(line)
  })
})

describe('jsEvalAnswerLine', () => {
  it('writes an answer as one line that reads back, also a text with line ends', () => {
    const line = jsEvalAnswerLine(3, { text: 'The call failed.\nFix it:\r\n\u2028"quoted"', isError: true })

    expect(line.endsWith('\n')).toBe(true)
    expect(line.slice(0, -1)).not.toMatch(/[\n\r]/)
    expect(JSON.parse(line)).toStrictEqual({ id: 3, text: 'The call failed.\nFix it:\r\n\u2028"quoted"', isError: true })
  })
})

describe('runResultText', () => {
  it('gives the lead and the given text, the advice, the paragraphs of the caller, then the console output', () => {
    const outcome: RunOutcome = { isError: true, lead: 'The code threw an error:', given: { text: 'Error: x', name: 'text of the error' }, advice: ['Fix x.'] }
    const text = runResultText(outcome, 'step 1\n', (part) => part, (given) => [`After ${given}.`])

    expect(text).toBe(`The code threw an error:\nError: x\n\nFix x.\n\nAfter Error: x.\n\n${CONSOLE_TITLE}\nstep 1`)
  })

  it('gives a value as it is, with no console paragraph for no console output', () => {
    expect(resultText(returned('  {\n  "a": 1\n}'))).toBe('  {\n  "a": 1\n}')
  })

  it('names the run folder /run in every text of the run', () => {
    const thrown: RunOutcome = { isError: true, lead: 'The code threw an error:', given: { text: `Error: x\n    at default (file://${REAL_RUN_FOLDER}/code.ts:3:1)`, name: 'text of the error' }, advice: [] }

    expect(resultText(thrown, `${REAL_RUN_FOLDER}/deno-dir and ${JOINED_RUN_FOLDER}\n`)).toBe(`The code threw an error:\nError: x\n    at default (file:///run/code.ts:3:1)\n\n${CONSOLE_TITLE}\n/run/deno-dir and /run`)
  })

  it('finds the run folder in a URL with escapes', () => {
    expect(resultText(returned(`at file:///home/J%C3%BCrgen%20M/.cache/dez/work/${RUN_FOLDER_ID}/code.ts:1:40 and file:///etc/hosts`))).toBe('at file:///run/code.ts:1:40 and file:///etc/hosts')
  })

  it('finds the run folder in a short time in a long list of URLs with no white space', () => {
    // The URL with escapes keeps the id of the folder in the text, so the
    // URL rule runs on the JSON of the list.
    const list = JSON.stringify(Array.from({ length: 10_000 }, (_, index) => `file:///usr/share/icons/${index}.png`))
    const started = performance.now()
    const text = textForModel(`at file:///home/J%C3%BCrgen%20M/.cache/dez/work/${RUN_FOLDER_ID}/code.ts:1:40 ${list}`, RUN_FOLDERS)

    expect(performance.now() - started).toBeLessThan(200)
    expect(text).toBe(`at file:///run/code.ts:1:40 ${list}`)
  })

  it('hides every other local path', () => {
    const text = resultText(returned('The program is /Users/u/Applications/Dez.app/Contents/MacOS/dez-deno'), '/home/u/apps/dez-deno(+0x27bc) [0xaaaa]\n')

    expect(text).toBe(`The program is /Users/…\n\n${CONSOLE_TITLE}\n/home/…`)
  })

  it('takes the paths out before it cuts a text', () => {
    const text = resultText(returned(`${'x'.repeat(JS_EVAL_TEXT_CAP - 10)}${JOINED_RUN_FOLDER}/code.ts`))

    expect(text).not.toContain('/home')
    expect(text.endsWith('x/run/code.')).toBe(true)
  })

  it('cuts a long value at its limit and tells so first', () => {
    const [note, kept] = resultText(returned(`${'x'.repeat(JS_EVAL_TEXT_CAP)}${'y'.repeat(500)}`)).split('\n')

    expect(note).toContain('20,500 characters')
    expect(kept).toBe('x'.repeat(JS_EVAL_TEXT_CAP))
  })

  it('leaves no half of a character at the cut of a value', () => {
    const text = resultText(returned(`${'x'.repeat(JS_EVAL_TEXT_CAP - 1)}😀y`))

    expect(text.endsWith(`\n${'x'.repeat(JS_EVAL_TEXT_CAP - 1)}`)).toBe(true)
  })

  it('keeps the start and the end of a long console output', () => {
    const noValue: RunOutcome = { isError: false, lead: 'The code returned no value.', given: null, advice: [] }
    const text = resultText(noValue, `start${'-'.repeat(JS_EVAL_TEXT_CAP * 2)}end\n`)
    const kept = text.slice(text.indexOf(CONSOLE_TITLE) + CONSOLE_TITLE.length + 1)
    const half = JS_EVAL_TEXT_CAP / 2

    expect(text).toMatch(/^The console output has 40,008 characters/)
    expect(kept).toBe(`start${'-'.repeat(half - 5)}\n…\n${'-'.repeat(half - 3)}end`)
  })

  it('leaves room for console output next to a value at the limit', () => {
    const text = resultText(returned('x'.repeat(JS_EVAL_TEXT_CAP)), `start${'-'.repeat(5000)}end\n`)
    const kept = text.slice(text.indexOf(CONSOLE_TITLE) + CONSOLE_TITLE.length + 1)

    expect(kept).toBe(`start${'-'.repeat(995)}\n…\n${'-'.repeat(997)}end`)
  })
})

describe('errorAdvice', () => {
  it.each([
    ['a refused permission', 'NotCapable: Requires net access to "example.com:443", run again with the --allow-net flag'],
    ['a refused package', 'TypeError: npm specifiers were requested; but --no-npm is specified'],
    ['a refused URL', 'TypeError: A remote specifier was requested: "https://example.com/a.ts", but --no-remote is specified.'],
  ])('tells the limits of the run for %s', (_name, error) => {
    const advice = errorAdvice(error)

    expect(advice).toHaveLength(1)
    expect(advice[0]).toContain('No flag changes these limits')
  })

  it('tells how code that is the body of a function imports a module, for a static import', () => {
    const advice = errorAdvice("TypeError: SyntaxError: 'import', and 'export' cannot be used outside of module code")

    expect(advice).toHaveLength(1)
    expect(advice[0]).toContain('await import(')
  })

  it('gives no advice for an error of the code itself', () => {
    expect(errorAdvice('RangeError: bad range\n    at f')).toStrictEqual([])
  })
})

describe('codeTimedOutText', () => {
  it('tells the seconds of the call, and the parameter that gives more time', () => {
    const text = codeTimedOutText(5000)

    expect(text).toContain('within 5 seconds')
    expect(text).toContain('`timeout_seconds`')
  })
})

describe('textForModel with the folder of the apps', () => {
  // The folder of the apps as Dez made its path, and its real path.
  const APPS = '/home/u/.config/dez/apps'
  const REAL_APPS = '/mnt/disk/config/dez/apps'
  const forModel = (text: string, roots: readonly string[] = [REAL_APPS, APPS]) => textForModel(text, { ...RUN_FOLDERS, apps: roots })

  it('names a file of an app as the apps tool does, for each form of the path', () => {
    expect(forModel(`open '${APPS}/notes/data.json' and ${REAL_APPS}/notes/main.ts:3`)).toBe('open \'/apps/notes/data.json\' and /apps/notes/main.ts:3')
  })

  it('names a file of an app in a URL, as the stack of an error has it', () => {
    expect(forModel(`Error: x\n    at main (file://${APPS}/notes/main.ts:3:9)\n    at file://${REAL_APPS}/notes/lib/a.ts:1:1`))
      .toBe('Error: x\n    at main (file:///apps/notes/main.ts:3:9)\n    at file:///apps/notes/lib/a.ts:1:1')
  })

  it.each([
    ['upper-case escapes', 'file:///home/J%C3%BCrgen%20M/.config/dez/apps/notes/main.ts:1:1'],
    ['lower-case escapes', 'file:///home/J%c3%bcrgen%20M/.config/dez/apps/notes/main.ts:1:1'],
    ['escapes of only some characters', 'file:///home/Jürgen%20M/.config/dez/apps/notes/main.ts:1:1'],
    ['no escapes', 'file:///home/Jürgen M/.config/dez/apps/notes/main.ts:1:1'],
  ])('finds the folder in a URL with %s', (_name, url) => {
    expect(forModel(`at ${url}`, ['/home/Jürgen M/.config/dez/apps'])).toBe('at file:///apps/notes/main.ts:1:1')
  })

  it('takes a character of a regex in the path as it is', () => {
    expect(forModel('/home/a+b (c)/.config/dez/apps/notes/x and file:///home/a+b%20(c)/.config/dez/apps/notes/x', ['/home/a+b (c)/.config/dez/apps']))
      .toBe('/apps/notes/x and file:///apps/notes/x')
  })

  it('names the folder of the apps itself', () => {
    expect(forModel(`${APPS} and ${APPS}/ and file://${APPS}`)).toBe('/apps and /apps/ and file:///apps')
  })

  it.each([`${APPS}-old/notes/x`, `${APPS}.bak/x`, `${APPS}2/x`, `file://${APPS}%20old/x`])('leaves %s, which is another folder, to the rule of the local paths', (path) => {
    const text = forModel(`see ${path}`)

    expect(text).not.toContain('/apps/')
    expect(text).toMatch(/^see (?:file:\/\/)?\/home\/…$/)
  })

  it('still names the run folder /run', () => {
    expect(forModel(`${REAL_RUN_FOLDER}/output/a.png, file://${JOINED_RUN_FOLDER}/runner.js, ${APPS}/notes/a.txt`)).toBe('/run/output/a.png, file:///run/runner.js, /apps/notes/a.txt')
  })

  it('finds the folder when one form of its path starts the other', () => {
    expect(forModel('/data/dez/apps/real/dez/apps/notes/x', ['/data/dez/apps', '/data/dez/apps/real/dez/apps'])).toBe('/apps/notes/x')
  })

  it('leaves the folder of the apps of a run with no app to the rule of the local paths', () => {
    expect(textForModel(`${APPS}/notes/x`, RUN_FOLDERS)).toBe('/home/…')
  })
})

describe('textForModel with the work folder of the conversation', () => {
  it('names the work folder /work in every form of its path, and keeps the folder of the apps and the run folder apart', () => {
    const text = [
      `wrote ${JOINED_WORK_FOLDER}/data.json and ${REAL_WORK_FOLDER}/notes/a.txt`,
      `    at load (file://${REAL_WORK_FOLDER}/lib.ts:2:5)`,
      `${JOINED_WORK_FOLDER} ${REAL_RUN_FOLDER}/output/a.png /home/u/.config/dez/apps/notes/main.ts`,
    ].join('\n')

    expect(textForModel(text, { ...RUN_FOLDERS, apps: ['/home/u/.config/dez/apps'] })).toBe([
      'wrote /work/data.json and /work/notes/a.txt',
      '    at load (file:///work/lib.ts:2:5)',
      '/work /run/output/a.png /apps/notes/main.ts',
    ].join('\n'))
  })

  it('finds the work folder in a URL with escapes', () => {
    const folder = `/home/Jürgen M/.config/dez/work/${CONVERSATION_ID}`

    expect(textForModel(`at file:///home/J%C3%BCrgen%20M/.config/dez/work/${CONVERSATION_ID}/a.ts:1:1`, { run: [], work: [folder] })).toBe('at file:///work/a.ts:1:1')
  })

  it.each([`${JOINED_WORK_FOLDER}-old/x`, `${JOINED_WORK_FOLDER}0/x`, '/home/u/.config/dez/work/other/x'])('leaves %s, which is another folder, to the rule of the local paths', (path) => {
    expect(textForModel(`see ${path}`, RUN_FOLDERS)).toBe('see /home/…')
  })

  it('leaves the work folder of a run with no conversation to the rule of the local paths', () => {
    expect(textForModel(`${JOINED_WORK_FOLDER}/x`, { run: RUN_FOLDERS.run })).toBe('/home/…')
  })
})

describe('textForModel with the folder of the libraries', () => {
  it('names the folder of the libraries /libs in every form of its path, apart from the built-in apps beside it', () => {
    const folders = { run: [], apps: ['/tmp/.mount_Dez1/usr/lib/Dez/builtin-apps'], libs: ['/tmp/.mount_Dez1/usr/lib/Dez/libs', '/usr/lib/Dez/libs'] }
    const text = [
      'Uncaught Error: no WebGL',
      '    at new WebGLRenderer (file:///tmp/.mount_Dez1/usr/lib/Dez/libs/three/build/three.module.js:10:5)',
      '    at main (file:///tmp/.mount_Dez1/usr/lib/Dez/builtin-apps/dez-media/main.ts:2:3)',
      'see /usr/lib/Dez/libs/import_map.json',
    ].join('\n')

    expect(textForModel(text, folders)).toBe([
      'Uncaught Error: no WebGL',
      '    at new WebGLRenderer (file:///libs/three/build/three.module.js:10:5)',
      '    at main (file:///apps/dez-media/main.ts:2:3)',
      'see /libs/import_map.json',
    ].join('\n'))
  })
})

describe('textForModel with the folder of the fonts', () => {
  it('names a font that Dez ships by the name of its file, as a path and as a URL', () => {
    const folders = { run: [], libs: ['/opt/Dez Mo/libs'], fonts: ['/opt/Dez Mo/fonts', '/mnt/opt/Dez Mo/fonts'] }
    const text = 'loaded /opt/Dez Mo/fonts/NotoSans-Bold.ttf, file:///mnt/opt/Dez%20Mo/fonts/NotoSansJP-Regular.otf, and /opt/Dez Mo/libs/skia-canvas/lib/index.js'

    expect(textForModel(text, folders)).toBe('loaded NotoSans-Bold.ttf, NotoSansJP-Regular.otf, and /libs/skia-canvas/lib/index.js')
  })
})

describe('endedRun', () => {
  it('gives the line of a run that ended with the code 0', () => {
    const output = written('log\n', protocolLine({ type: 'result', text: 'done' }))

    expect(endedRun(EXITED, output)).toStrictEqual({ line: { type: 'result', text: 'done' }, log: 'log\n' })
  })

  it.each<ProgramEnd>([{ kind: 'exited', code: 1 }, { kind: 'exited', code: null }, { kind: 'timedOut' }, { kind: 'outputTooLarge' }])('takes no line of a run with the end %o', (end) => {
    const output = written(protocolLine({ type: 'result', text: 'done' }))

    expect(endedRun(end, output)).toStrictEqual({ line: null, log: '' })
  })
})
