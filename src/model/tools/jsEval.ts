import * as z from 'zod'
import { byteSizeText } from '../../utils/byteSize'
import { countOf, countText } from '../../utils/countText'
import RUNNER from './jsEvalRunner.js?raw'
import { withoutLocalPaths } from './localPaths'
import type { ProgramEnd } from './programRuns'
import { ToolError, type ToolArguments, type ToolDefinition } from './types'

// `js_eval`: one run of code that a model wrote, in Deno, the JavaScript
// runtime that Dez ships (`dez-deno`). Rust gives Deno no permission (no
// network, no file, no environment variable, no program) and writes the
// whole command line, and the OS holds the program to its work folder
// (src-tauri/src/bundled_tools.rs, confinement.rs).
// controller/jsEval.ts does the run.
//
// A run has two files in its work folder: Dez's own module
// (jsEvalRunner.js), which Deno runs, and the code of the call, which that
// module imports. The module writes what the code gave as one protocol
// line to its standard output. All other output of the run is the console
// output of the code.
//
// Every text here is a tool result: it goes to the chat provider. A text of
// a run can name the work folder or the program (`import.meta.url`, an
// error stack, `Deno.execPath()`), so none goes into a result before
// `textForModel` took the paths out.

/** The name of Dez's module in the work folder of a run. */
export const JS_EVAL_RUNNER_FILE = 'runner.js'

/** The name of the code of a call in the work folder of a run. The module
 *  of Dez imports this name as a literal (jsEvalRunner.js): keep the two the
 *  same. The ending makes Deno take the code as TypeScript: it strips the
 *  types and checks none, and plain JavaScript is TypeScript too. */
export const JS_EVAL_CODE_FILE = 'code.ts'

/** The text of Dez's module (jsEvalRunner.js). */
export const JS_EVAL_RUNNER: string = RUNNER

/** The most bytes that a run writes (standard output and error output
 *  together). It is also the most that one protocol line holds, so a
 *  returned value near this size ends the run with no result. */
export const JS_EVAL_OUTPUT_BYTES = 4 * 1024 * 1024

/** The most characters of a returned value (or of the text of an error)
 *  that a result holds. A result is in every later request of the
 *  conversation, so a value that is far larger than a model can use must
 *  not fill them. */
export const JS_EVAL_TEXT_CAP = 20_000

// The least characters of console output that a result has room for, also
// next to a value of JS_EVAL_TEXT_CAP characters: the console output of
// code that failed tells why.
const LEAST_CONSOLE_ROOM = 2000

const DEFAULT_SECONDS = 30
const MIN_SECONDS = 1
const MAX_SECONDS = 300

// The name of the work folder of a run in every text for a model.
const WORK_FOLDER_NAME = '/work'

// Static text only (no count that changes, no date): the tools array and
// the system prompt, which lists the tools, are in the provider's prompt
// cache.
export const JS_EVAL_TOOL: ToolDefinition = {
  name: 'js_eval',
  description: 'Run JavaScript or TypeScript code in a sandbox on the user\'s computer (Deno), and get what it returns. '
    + 'Use it when code does the work better than you: exact arithmetic, dates and times, sorting and counting, work on text and JSON. '
    + '`code` is the body of an async function, so `await` works, and the value that it gives with `return` is the result: '
    + 'a string as it is, any other value as JSON. What the code writes with `console.log` comes after the result. '
    + 'The code has no network, no files, and no environment variables, and it can start no program; no flag and no import changes that. '
    + 'It can load the built-in modules with `await import("node:crypto")`, but a static `import` does not work, '
    + 'and no package of npm, of JSR, or from a URL loads. '
    + 'The clock and the time zone are those of the user\'s computer. '
    + 'Each call is a new run: nothing stays from one call to the next. '
    + `The call waits for the end of the code. A result holds at most the first ${JS_EVAL_TEXT_CAP} characters of the value. `
    + `An error names the lines of your code as lines of \`${WORK_FOLDER_NAME}/${JS_EVAL_CODE_FILE}\`.`,
  parameters: [
    {
      name: 'code',
      type: 'string',
      description: 'The code: the body of an async function, in JavaScript or TypeScript. For example: `return new Date().toISOString()`.',
      required: true,
    },
    {
      name: 'timeout_seconds',
      type: 'integer',
      description: `The most seconds that the code runs, from ${MIN_SECONDS} to ${MAX_SECONDS}. Dez stops code that runs longer, with no result. `
        + `The default is ${DEFAULT_SECONDS}.`,
      required: false,
    },
  ],
}

/** A `js_eval` call that Dez can run. */
export interface JsEvalCall {
  code: string
  timeoutMs: number
}

/** The call that the arguments `args` ask for. Throws a `ToolError` for
 *  no code and for a time limit outside the range. */
export function jsEvalCall(args: ToolArguments): JsEvalCall {
  const { code, timeout_seconds: seconds = DEFAULT_SECONDS } = args
  if (typeof code !== 'string' || code.trim() === '') {
    throw new ToolError('`code` is missing or blank, so Dez ran nothing. Give the code to run as `code`: the body of an async function '
      + 'that gives its result with `return`, for example `return new Date().toISOString()`.')
  }
  if (typeof seconds !== 'number' || !Number.isInteger(seconds) || seconds < MIN_SECONDS || seconds > MAX_SECONDS) {
    throw new ToolError(`\`timeout_seconds\` must be a whole number from ${MIN_SECONDS} to ${MAX_SECONDS}, so Dez ran nothing. `
      + `Leave it out for the default of ${DEFAULT_SECONDS} seconds.`)
  }
  return { code, timeoutMs: seconds * 1000 }
}

// The start of the code file: the code of a call is the body of this
// function, and the module of Dez calls it.
const CODE_HEADER = 'export default async function () {'

/** The text of the code file of a run (`JS_EVAL_CODE_FILE`) for the code of
 *  a call. The header has no line of its own: the first line of the code
 *  is the first line of the file, so an error names the lines of the code
 *  as the model wrote them (only a column of the first line is off, by the
 *  length of the header). */
export function jsEvalCodeFile(code: string): string {
  // The line end before the `}`: the code can end with a `//` comment.
  return `${CODE_HEADER}${code}\n}\n`
}

// The start of a protocol line: the record separator of RFC 7464. JSON
// writes this character as an escape, so the JSON of a line never holds
// it.
const RECORD_SEPARATOR = '\x1e'

// The lines that the module of Dez writes: the value that the code
// returned as a text (none for no value), or the text of what it threw. An
// object with any other key is no line.
const lineSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('result'), text: z.string().optional() }),
  z.strictObject({ type: z.literal('error'), text: z.string() }),
])

/** A protocol line of a run. */
export type JsEvalLine = z.infer<typeof lineSchema>

// The protocol line that `text` is, the text between a record separator and
// a line end; null for any other text.
function protocolLine(text: string): JsEvalLine | null {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  const line = lineSchema.safeParse(value)
  return line.success ? line.data : null
}

/** The output of one run, read while the program writes it: the protocol
 *  line of the run, and the console output of the code.
 *
 *  A protocol line is a record separator, one JSON object, and a line end,
 *  on the standard output. The code of a model runs in the same program as
 *  the module that writes the line, so it can write any text there, a line
 *  too. So every line is untrusted input: one that is not a known line in
 *  full is console output, as the code wrote it. The last line is the line
 *  of the run: the module writes its line as the last thing of a run, so a
 *  line that the code wrote before it does not count. The length of a line
 *  has the limit of the whole output (`JS_EVAL_OUTPUT_BYTES`).
 *
 *  The console of the code is Deno's own, which writes plain text to the
 *  two streams. So all other text is the console output, in the order in
 *  which its pieces come. The order of two pieces of different streams is
 *  not exact: the program writes each stream by itself. */
export class JsEvalOutput {
  private line: JsEvalLine | null = null
  private log = ''
  // The stream of the last piece of the console output.
  private logStream: 'stdout' | 'stderr' | null = null
  // The text of the standard output after the last record separator, while
  // its line end has not come; null outside a line.
  private open: string | null = null

  /** Takes the next piece `text` of a stream. A piece is not a line: a
   *  protocol line can come in many pieces, and with other text in one. */
  add(stream: 'stdout' | 'stderr', text: string): void {
    if (stream === 'stderr') {
      this.addLog(stream, text)
      return
    }
    let rest = text
    while (rest !== '') {
      if (this.open === null) {
        const start = rest.indexOf(RECORD_SEPARATOR)
        if (start < 0) {
          this.addLog(stream, rest)
          return
        }
        this.addLog(stream, rest.slice(0, start))
        this.open = ''
        rest = rest.slice(start + 1)
        continue
      }
      const end = rest.search(/[\n\x1e]/)
      if (end < 0) {
        this.open += rest
        return
      }
      const candidate = this.open + rest.slice(0, end)
      if (rest[end] === RECORD_SEPARATOR) {
        // A new start in an open line: the text before it is no line, as
        // no line holds this character. The code can write one with no
        // line end; the line of the module, which comes next, must still
        // count.
        this.addLog(stream, RECORD_SEPARATOR + candidate)
        this.open = ''
      } else {
        const line = protocolLine(candidate)
        if (line === null) this.addLog(stream, `${RECORD_SEPARATOR}${candidate}\n`)
        else this.line = line
        this.open = null
      }
      rest = rest.slice(end + 1)
    }
  }

  /** What the run gave, for the end of the run: its protocol line (null
   *  for none) and the console output of the code. A line whose line end
   *  did not come is no line. */
  ended(): { line: JsEvalLine | null, log: string } {
    if (this.open !== null) {
      this.addLog('stdout', RECORD_SEPARATOR + this.open)
      this.open = null
    }
    return { line: this.line, log: this.log }
  }

  private addLog(stream: 'stdout' | 'stderr', text: string): void {
    if (text === '') return
    // A piece after a piece of the other stream that ended in the middle
    // of a line starts on a new line: an error text of Deno must not go on
    // in a line that the code wrote.
    if (this.logStream !== null && this.logStream !== stream && !this.log.endsWith('\n')) this.log += '\n'
    this.log += text
    this.logStream = stream
  }
}

// `text` of a run with no path of this computer: the work folder of the
// run is `WORK_FOLDER_NAME`, and any other local path goes as its known
// start (`withoutLocalPaths`; the path of the Deno program is one, which
// the code can read with no permission). `workFolders` are the paths of
// the work folder that a text can hold: its real path, which Deno names,
// and the path that Dez made (the two differ when a folder above is a
// link). Deno writes a path in a URL with escapes (a space is `%20`), so
// the URL form is found by the name of the folder, a random id that no
// other text holds.
//
// A text goes through this as a whole, before any cut: a cut path would
// get past it.
function textForModel(text: string, workFolders: readonly string[]): string {
  let result = text
  for (const folder of workFolders) {
    result = result.replaceAll(folder, WORK_FOLDER_NAME)
    const name = folder.slice(folder.lastIndexOf('/') + 1).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    result = result.replace(new RegExp(`file://\\S*?/${name}`, 'g'), `file://${WORK_FOLDER_NAME}`)
  }
  return withoutLocalPaths(result)
}

// The first `length` characters of `text`, with no half of a character at
// the cut.
function startOf(text: string, length: number): string {
  return text.slice(0, length).replace(/[\uD800-\uDBFF]$/, '')
}

// The last `length` characters of `text`, with no half of a character at
// the cut.
function endOf(text: string, length: number): string {
  return text.slice(-length).replace(/^[\uDC00-\uDFFF]/, '')
}

// A text of a run as a result holds it, with the note that tells of its
// cut (null for a text that is whole).
interface ResultPart {
  text: string
  note: string | null
}

// The returned value or the error text of a run (`name` tells which), in
// at most JS_EVAL_TEXT_CAP characters.
function mainPart(text: string, name: string): ResultPart {
  if (text.length <= JS_EVAL_TEXT_CAP) return { text, note: null }
  return {
    text: startOf(text, JS_EVAL_TEXT_CAP),
    note: `The ${name} has ${countText(text.length)} characters: this result holds only its first ${countText(JS_EVAL_TEXT_CAP)}.`,
  }
}

// The console output of a run in at most `room` characters: its start and
// its end, as the end tells how the code ended. Null for no output.
function consolePart(log: string, room: number): ResultPart | null {
  const text = log.trimEnd()
  if (text.trim() === '') return null
  if (text.length <= room) return { text, note: null }
  const half = Math.floor(room / 2)
  return {
    text: `${startOf(text, half)}\n…\n${endOf(text, half)}`,
    note: `The console output has ${countText(text.length)} characters: this result holds only its start and its end, with a line of … between them.`,
  }
}

// What an error text of Deno tells a model to do that it cannot do: a
// permission error names the flag that gives the permission, and a refused
// import the flag that refuses it.
const NAMES_FLAG = /--(?:allow-[a-z]+|no-npm|no-remote)\b/

// The error of a static `import` in the code.
const STATIC_IMPORT = /'import', and 'export' cannot be used outside of module code/

// The advice that goes with the text of an error that the code threw, for
// the errors whose own text misleads a model.
function errorAdvice(error: string): string[] {
  return [
    ...(NAMES_FLAG.test(error)
      ? ['Dez runs the code with no network, no files, no environment variables, no start of programs, and no packages. '
        + 'No flag changes that, and you can set none: do the work without them.']
      : []),
    ...(STATIC_IMPORT.test(error)
      ? ['The code is the body of a function, so a static `import` does not work in it. Load a built-in module with `await import("node:…")`.']
      : []),
  ]
}

// What a result tells before the console output of the code.
interface Outcome {
  isError: boolean
  /** What Dez tells about the end of the run; null for a run that tells
   *  all with its value. */
  lead: string | null
  /** The text that the run gave, as the code made it, and what it is (the
   *  words for the note of a cut); null for none. It goes after the lead. */
  given: { text: string, name: string } | null
  /** Each one is a paragraph after the given text. */
  advice: string[]
}

// The outcome of a run whose code returned `value`. A string with no
// visible character does not go as it is: a blank result reads as a
// failure of the tool.
function returnedOutcome(value: string | undefined, hasConsole: boolean): Outcome {
  const told = (lead: string): Outcome => ({ isError: false, lead, given: null, advice: [] })
  if (value === undefined) {
    return told(hasConsole ? 'The code returned no value.' : 'The code returned no value, and it wrote nothing to the console. Give the result with `return`.')
  }
  if (value === '') return told('The code returned an empty string.')
  if (value.trim() === '') return told(`The code returned a string of only white space (${countOf(value.length, 'character')}).`)
  return { isError: false, lead: null, given: { text: value, name: 'returned value' }, advice: [] }
}

// The outcome of a run of `call` with the end `end` and the protocol line
// `line`. `hasConsole` tells that the code wrote console output, which
// goes after it.
function runOutcome(call: JsEvalCall, end: ProgramEnd, line: JsEvalLine | null, hasConsole: boolean): Outcome {
  if (line?.type === 'result') return returnedOutcome(line.text, hasConsole)
  if (line?.type === 'error') {
    return { isError: true, lead: 'The code threw an error:', given: { text: line.text, name: 'text of the error' }, advice: errorAdvice(line.text) }
  }
  const failed = (lead: string): Outcome => ({ isError: true, lead, given: null, advice: [] })
  if (end.kind === 'timedOut') {
    return failed(`Dez stopped the code: it did not end within ${countOf(call.timeoutMs / 1000, 'second')}. `
      + `Make the code do less work, or give it more time with \`timeout_seconds\` (at most ${MAX_SECONDS}).`)
  }
  if (end.kind === 'outputTooLarge') {
    return failed(`Dez stopped the code: it wrote more than ${byteSizeText(JS_EVAL_OUTPUT_BYTES)} of output. `
      + 'Write less to the console, and return only what you need.')
  }
  const silent = hasConsole ? '' : ' The code wrote nothing to the console.'
  // A signal that Dez did not send ended the program. V8 ends it this way
  // at the limit of its memory.
  if (end.code === null) {
    return failed('The system ended the code before it returned a value. The usual cause: the code used more memory than a run can have. '
      + `Use less memory (smaller arrays and strings, or the work in parts), and call again.${silent}`)
  }
  return failed(`The code ended before it returned a value (exit code ${end.code}). The usual causes: an error in a timer or in a promise that the code did not await, `
    + `an \`await\` of a promise that never settles, or a call of \`Deno.exit\`.${hasConsole ? ' The console output tells which.' : silent}`)
}

/** The result of a run of `call` that ended with `end` and wrote `output`:
 *  the returned value, then the console output of the code. Any other end
 *  is an error result (`isError`) that tells the model what happened and
 *  what to do: the code threw an error, Dez stopped it at a limit, or it
 *  ended with no value. A first line tells of each cut. `workFolders` are
 *  the paths of the work folder of the run on this computer
 *  (`textForModel`). */
export function jsEvalResult(call: JsEvalCall, end: ProgramEnd, output: JsEvalOutput, workFolders: readonly string[]): { text: string, isError: boolean } {
  const ended = output.ended()
  // The module of Dez ends the program with the code 0 right after its
  // line. A line of a run with another end is one that the code wrote.
  const line = end.kind === 'exited' && end.code === 0 ? ended.line : null
  const { isError, lead, given, advice } = runOutcome(call, end, line, ended.log.trim() !== '')
  const main = given === null ? null : mainPart(textForModel(given.text, workFolders), given.name)
  // The console output gets the room that the given text leaves.
  const log = consolePart(textForModel(ended.log, workFolders), Math.max(JS_EVAL_TEXT_CAP - (main?.text.length ?? 0), LEAST_CONSOLE_ROOM))
  const paragraphs = [
    [...(lead === null ? [] : [lead]), ...(main === null ? [] : [main.text])].join('\n'),
    ...advice,
    ...(log === null ? [] : [`Console output of the code:\n${log.text}`]),
  ]
  const notes = [main, log].flatMap((part) => part?.note ?? [])
  return { text: [...notes, paragraphs.join('\n\n')].join('\n'), isError }
}
