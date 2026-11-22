import * as z from 'zod'
import { byteSizeText } from '../../utils/byteSize'
import { countOf, countText } from '../../utils/countText'
import { regExpSource } from '../../utils/regExpSource'
import { endOf, startOf } from '../../utils/textCut'
import { NATIVE_CANVAS_LIBRARY } from './appManifest'
import { shownAppNames, shownAppText } from './appShow'
import { APPS_INVOKE, APPS_TOOL, APPS_VIRTUAL_ROOT, LIBS_VIRTUAL_ROOT } from './appsTool'
import { WORK_VIRTUAL_ROOT } from './conversationWork'
import { jobStartedText, madeAssetIds, madeAssetText, type JobAssetKind } from './jobs'
import RUNNER from './jsEvalRunner.js?raw'
import { withoutLocalPaths } from './localPaths'
import type { ProgramEnd } from './programRuns'
import { ToolError, type ToolArguments, type ToolDefinition } from './types'

// `js_eval`: one run of code that a model wrote, in Deno, the JavaScript
// runtime that Dez ships (`dez-deno`). Rust gives Deno no permission but
// the work folder of the conversation (no network, no other file, no
// environment variable, no program) and writes the whole command line, and
// the OS holds the program to its run folder and that work folder
// (src-tauri/src/bundled_tools.rs, confinement.rs).
// controller/jsEval.ts does the run.
//
// The code gets the path of the work folder of its conversation
// (conversationWork.ts) as `dez.workFolder`, and its files stay from one
// run to the next. Every text for a model names that folder
// `WORK_VIRTUAL_ROOT`.
//
// The run folder is a new work folder of the cache root
// (model/tools/workFolders.ts); every text for a model names it
// `RUN_FOLDER_NAME`. It has three files: Dez's own module
// (jsEvalRunner.js), which Deno runs, the description of the run
// (`RUN_DESCRIPTION_FILE`), which tells the module what to run, and the
// code of the call, which the module imports. The module writes what the
// code gave as one protocol line to its standard output. All other output
// of the run is the console output of the code.
//
// The same module runs the code of a script app (appInvoke.ts): the
// description of that run names the `main.ts` of the app. Such a run
// shares the protocol lines (`JsEvalOutput`), the rule of the paths
// (`textForModel`), and the layout of a result (`runResultText`).
//
// The code can call the other Dez tools (`dez.sbp` of the module): the
// module writes one `call` line for each call, and reads the answer of Dez
// as one line of its standard input. toolBridge.ts tells which calls go,
// and controller/toolBridge.ts runs them.
//
// Every text here is a tool result: it goes to the chat provider. A text of
// a run can name the run folder or the program (`import.meta.url`, an
// error stack, `Deno.execPath()`), so none goes into a result before
// `textForModel` took the paths out.

/** The name of Dez's module in the run folder. */
export const JS_EVAL_RUNNER_FILE = 'runner.js'

/** The name of the code of a call in the run folder. The module of Dez
 *  imports this name as a literal (jsEvalRunner.js): keep the two the
 *  same. The ending makes Deno take the code as TypeScript: it strips the
 *  types and checks none, and plain JavaScript is TypeScript too. */
export const JS_EVAL_CODE_FILE = 'code.ts'

/** The name of the description of a run in its run folder: one JSON
 *  object that tells the kind of the run (`kind`), and for a run of an app
 *  what it runs (`appRunDescription`, appInvoke.ts). The module of Dez
 *  imports this name as a literal (jsEvalRunner.js): keep the two the
 *  same. */
export const RUN_DESCRIPTION_FILE = 'run.json'

/** The text of the description of a `js_eval` run: the module runs the
 *  code file, and gives the code the path `workFolder` of the work folder
 *  of its conversation (`dez.workFolder`). */
export function codeRunDescription(workFolder: string): string {
  return JSON.stringify({ kind: 'code', workFolder })
}

/** The text of Dez's module (jsEvalRunner.js). */
export const JS_EVAL_RUNNER: string = RUNNER

/** The most bytes that a run writes (standard output and error output
 *  together). It is also the most that one protocol line holds, so a
 *  returned value near this size ends the run with no result. The call
 *  lines of the tool calls count too: the limit ends code that writes
 *  them without end. */
export const JS_EVAL_OUTPUT_BYTES = 4 * 1024 * 1024

/** The most characters of a returned value (or of the text of an error)
 *  that a result holds. A result is in every later request of the
 *  conversation, so a value that is far larger than a model can use must
 *  not fill them. */
export const JS_EVAL_TEXT_CAP = 20_000

/** The most tool calls (`dez.sbp`) of the code of one call. Each call line
 *  of a run counts, also one that Dez refuses; each later one gets an
 *  error answer (`bridgedToolCall`, toolBridge.ts). The limit holds a loop
 *  that a model wrote wrong: a call can start a job that costs money. */
export const JS_EVAL_MAX_TOOL_CALLS = 40

// The least characters of console output that a result has room for, also
// next to a value of JS_EVAL_TEXT_CAP characters: the console output of
// code that failed tells why.
const LEAST_CONSOLE_ROOM = 2000

/** The time limit of a run with no `timeout_seconds`, and the most that a
 *  call can ask for. */
export const JS_EVAL_DEFAULT_SECONDS = 30
const MIN_SECONDS = 1
export const JS_EVAL_MAX_SECONDS = 300

// The name of the run folder in every text for a model. `/run/media/` and
// `/run/user/` are known starts of a local path (localPaths.ts), so a path
// in a folder `media` or `user` of the run folder reads as `/run/media/…`
// (the rest of its line goes too): a name that the model loses, and no
// path of the computer.
const RUN_FOLDER_NAME = '/run'

/** The parameter that holds the code of a call. The panel of the call's
 *  chip shows it as code, not as a parameter row (toolCalls.ts). */
export const JS_EVAL_CODE_PARAMETER = 'code'

// Static text only (no count that changes, no date): the tools array and
// the system prompt, which lists the tools, are in the provider's prompt
// cache.
export const JS_EVAL_TOOL: ToolDefinition = {
  name: 'js_eval',
  description: 'Run JavaScript or TypeScript code in a sandbox on the user\'s computer (Deno), and get what it returns. '
    + 'Use it when code does the work better than you: exact arithmetic, dates and times, sorting and counting, work on text and JSON. '
    + '`code` is the body of an async function, so `await` works, and the value that it gives with `return` is the result: '
    + 'a string as it is, JSON data as JSON, and any other value as Deno shows it. What the code writes with `console.log` comes after the result. '
    + 'The code has no network, no files, and no environment variables, and it can start no program; no flag and no import changes that. '
    + `The one exception: with calls of the \`${APPS_TOOL.name}\` tool (\`dez.tools/${APPS_TOOL.name}/<subcommand>\`, as below), `
    + `the code can read and change the files of the apps in \`${APPS_VIRTUAL_ROOT}/\`, and no other file. `
    + 'It can load the built-in modules with `await import("node:crypto")`, but a static `import` does not work, '
    + 'and no package of npm, of JSR, or from a URL loads. '
    + 'The code can call the other Dez tools: `await dez.sbp("dez.tools/<tool>", { …arguments })`, '
    + 'and `await dez.sbp("dez.tools/<tool>/<subcommand>", { …parameters })` for a subcommand, '
    + 'as in `await dez.sbp("dez.tools/image/scale", { image: "a", width: 1024 })`. '
    + 'A call gives the result text of the tool, the same text that a direct call gives you, and it throws an error with that text when the tool gives an error. '
    + 'The code names an image or a clip by its id, and gets no file of it. '
    + 'In each text that the code gives a tool, Dez cuts a path of a file of the user\'s computer after its start, with the rest of its line '
    + '(`/home/…`, `/tmp/…`, `~/…`): give a tool a text that needs such a path in a call of your own. '
    + `One run can make at most ${JS_EVAL_MAX_TOOL_CALLS} tool calls, and none of \`js_eval\` or of \`${APPS_TOOL.name} ${APPS_INVOKE}\`. `
    + 'The result names each image and clip that the calls made, and each job that they started and that is still open. '
    + 'The clock and the time zone are those of the user\'s computer. '
    + 'Each call is a new run: nothing stays from one call to the next. '
    + `The call waits for the end of the code. A result holds at most the first ${JS_EVAL_TEXT_CAP} characters of the value. `
    + `An error names the lines of your code as lines of \`${RUN_FOLDER_NAME}/${JS_EVAL_CODE_FILE}\`.`,
  parameters: [
    {
      name: JS_EVAL_CODE_PARAMETER,
      type: 'string',
      description: 'The code: the body of an async function, in JavaScript or TypeScript. For example: `return new Date().toISOString()`.',
      required: true,
    },
    {
      name: 'timeout_seconds',
      type: 'integer',
      description: `The most seconds that the code runs, from ${MIN_SECONDS} to ${JS_EVAL_MAX_SECONDS}. Dez stops code that runs longer, with no result. `
        + `The default is ${JS_EVAL_DEFAULT_SECONDS}.`,
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
  const { [JS_EVAL_CODE_PARAMETER]: code, timeout_seconds: seconds = JS_EVAL_DEFAULT_SECONDS } = args
  if (typeof code !== 'string' || code.trim() === '') {
    throw new ToolError('`code` is missing or blank, so Dez ran nothing. Give the code to run as `code`: the body of an async function '
      + 'that gives its result with `return`, for example `return new Date().toISOString()`.')
  }
  if (typeof seconds !== 'number' || !Number.isInteger(seconds) || seconds < MIN_SECONDS || seconds > JS_EVAL_MAX_SECONDS) {
    throw new ToolError(`\`timeout_seconds\` must be a whole number from ${MIN_SECONDS} to ${JS_EVAL_MAX_SECONDS}, so Dez ran nothing. `
      + `Leave it out for the default of ${JS_EVAL_DEFAULT_SECONDS} seconds.`)
  }
  return { code, timeoutMs: seconds * 1000 }
}

// The start of the code file: the code of a call is the body of this
// function, and the module of Dez calls it with the `dez` object of the
// run (`dez.sbp`, jsEvalRunner.js).
const CODE_HEADER = 'export default async function (dez) {'

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

// The lines that the module of Dez writes:
// - `result`: the value that the code returned as a text (none for no
//   value);
// - `error`: the text of what the code threw;
// - `call`: a tool call of the code (`dez.sbp`). `id` is the number that
//   the answer of Dez names, and `arguments` any JSON value: only
//   `bridgedToolCall` (toolBridge.ts) knows what a tool takes.
// An object with any other key is no line.
const lineSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('result'), text: z.string().optional() }),
  z.strictObject({ type: z.literal('error'), text: z.string() }),
  z.strictObject({ type: z.literal('call'), id: z.int(), selector: z.string(), arguments: z.unknown().optional() }),
])

/** A protocol line of a run. */
export type JsEvalLine = z.infer<typeof lineSchema>

/** The protocol line of a tool call of the code. */
export type JsEvalCallLine = Extract<JsEvalLine, { type: 'call' }>

/** The protocol line that tells what the code gave. */
export type JsEvalEndLine = Exclude<JsEvalLine, JsEvalCallLine>

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

/** The answer of Dez to the call line `id` of a run, as the text for the
 *  input of the program: one line of JSON, which the module of Dez reads
 *  (jsEvalRunner.js). `text` is the result text of the tool, and with
 *  `isError` the text of its error. JSON writes a line end as an escape,
 *  so the answer is one line. */
export function jsEvalAnswerLine(id: number, answer: { text: string, isError: boolean }): string {
  return `${JSON.stringify({ id, text: answer.text, isError: answer.isError })}\n`
}

/** The output of one run, read while the program writes it: the protocol
 *  lines of the run, and the console output of the code.
 *
 *  A protocol line is a record separator, one JSON object, and a line end,
 *  on the standard output. The code of a model runs in the same program as
 *  the module that writes the lines, so it can write any text there, a
 *  line too. So every line is untrusted input: one that is not a known
 *  line in full is console output, as the code wrote it. The last `result`
 *  or `error` line is the line of the run: the module writes its line as
 *  the last thing of a run, so a line that the code wrote before it does
 *  not count. A `call` line is no line of the run: `add` gives it to its
 *  caller at once, which answers it while the program runs. The length of
 *  a line has the limit of the whole output (`JS_EVAL_OUTPUT_BYTES`).
 *
 *  The console of the code is Deno's own, which writes plain text to the
 *  two streams. So all other text is the console output, in the order in
 *  which its pieces come. The order of two pieces of different streams is
 *  not exact: the program writes each stream by itself. */
export class JsEvalOutput {
  private line: JsEvalEndLine | null = null
  private log = ''
  // The stream of the last piece of the console output.
  private logStream: 'stdout' | 'stderr' | null = null
  // The text of the standard output after the last record separator, while
  // its line end has not come; null outside a line.
  private open: string | null = null

  /** Takes the next piece `text` of a stream, and gives the `call` lines
   *  that end in it, in their order. A piece is not a line: a protocol
   *  line can come in many pieces, and with other text in one. */
  add(stream: 'stdout' | 'stderr', text: string): JsEvalCallLine[] {
    if (stream === 'stderr') {
      this.addLog(stream, text)
      return []
    }
    const calls: JsEvalCallLine[] = []
    let rest = text
    while (rest !== '') {
      if (this.open === null) {
        const start = rest.indexOf(RECORD_SEPARATOR)
        if (start < 0) {
          this.addLog(stream, rest)
          return calls
        }
        this.addLog(stream, rest.slice(0, start))
        this.open = ''
        rest = rest.slice(start + 1)
        continue
      }
      const end = rest.search(/[\n\x1e]/)
      if (end < 0) {
        this.open += rest
        return calls
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
        else if (line.type === 'call') calls.push(line)
        else this.line = line
        this.open = null
      }
      rest = rest.slice(end + 1)
    }
    return calls
  }

  /** What the run gave, for the end of the run: its protocol line (null
   *  for none) and the console output of the code. A line whose line end
   *  did not come is no line. */
  ended(): { line: JsEvalEndLine | null, log: string } {
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

// The characters of a path that every writer of a file URL leaves as they
// are.
const URL_PLAIN_CHAR = /[A-Za-z0-9._~/-]/

// The regex source of the path `path` as a file URL holds it. A URL has
// any other character as it is, or as the escapes of its UTF-8 bytes (a
// space is `%20`, `é` is `%C3%A9`). Which characters get an escape differs
// from one writer to the next (Deno, the webview), and so does the case of
// the hex digits, so each such character matches in every form.
function urlPathSource(path: string): string {
  const encoder = new TextEncoder()
  return Array.from(path, (char) => {
    if (URL_PLAIN_CHAR.test(char)) return regExpSource(char)
    const escapes = Array.from(encoder.encode(char), (byte) => `%${byte.toString(16).padStart(2, '0').replace(/[a-f]/g, (digit) => `[${digit}${digit.toUpperCase()}]`)}`)
    return `(?:${regExpSource(char)}|${escapes.join('')})`
  }).join('')
}

// What must not come after the path of the apps folder or of a work
// folder: a character of a name, or the start of an escape of one in a
// URL. The path then names another folder (`apps-old`), which is not that
// folder.
const NAME_GOES_ON = '(?![A-Za-z0-9._%-])'

/** The paths of the folders of a run on this computer that a text of the
 *  run can hold, each in all its forms (`folderPathForms`,
 *  controller/programRuns.ts): the real path, which Deno names, and the
 *  path that Dez made (the two differ when a folder above is a link). */
export interface RunFolderForms {
  /** The run folder, a new work folder of the cache root. */
  run: readonly string[]
  /** The folder of the apps; only a run of an app has it (its code can
   *  open the folder of its app). */
  apps?: readonly string[]
  /** The folder of the libraries that Dez ships, in its files; the code
   *  of a run can import from it. */
  libs?: readonly string[]
  /** The work folder of the conversation (conversationWork.ts); a run
   *  with no conversation has none. */
  work?: readonly string[]
  /** The folder of the fonts that Dez ships; a run of an app reads them
   *  (`dez.fonts`). */
  fonts?: readonly string[]
}

/** `text` of a run with no path of this computer: the run folder is
 *  `RUN_FOLDER_NAME`, the folder of the apps is `APPS_VIRTUAL_ROOT`, the
 *  folder of the libraries is `LIBS_VIRTUAL_ROOT`, the work folder of the
 *  conversation is `WORK_VIRTUAL_ROOT`, a font that Dez ships is the name
 *  of its file (as `dez.fonts` names it), and any other local path goes as
 *  its known start (`withoutLocalPaths`; the path of the Deno program is
 *  one, which the code can read with no permission).
 *
 *  Deno writes a path in a URL with escapes (a space is `%20`). The URL
 *  form of the run folder is found by the name of the folder, a random id
 *  that no other text holds. The folder of the apps, the folder of the
 *  libraries, and the work folder are found in each form that a URL can
 *  give their paths, so a path of a file in them reads as the `apps` tool
 *  names it (`/apps/<app>/main.ts`, `/libs/<lib>/index.js`,
 *  `/work/data.json`), also in the stack of an error, which names a file
 *  as a URL.
 *
 *  A text goes through this as a whole, before any cut: a cut path would
 *  get past it. */
export function textForModel(text: string, folders: RunFolderForms): string {
  let result = text
  const roots = [
    ...(folders.apps ?? []).map((path) => ({ path, name: APPS_VIRTUAL_ROOT })),
    ...(folders.libs ?? []).map((path) => ({ path, name: LIBS_VIRTUAL_ROOT })),
    ...(folders.work ?? []).map((path) => ({ path, name: WORK_VIRTUAL_ROOT })),
  ]
  // The longer path first: one form of a path can be the start of another.
  for (const { path, name } of roots.sort((a, b) => b.path.length - a.path.length)) {
    result = result
      .replace(new RegExp(`file://${urlPathSource(path)}${NAME_GOES_ON}`, 'g'), `file://${name}`)
      .replace(new RegExp(`${regExpSource(path)}${NAME_GOES_ON}`, 'g'), name)
  }
  // The fonts folder has no name for a model: a path of a font in it is
  // the name of the file, with no `file://` of a URL.
  for (const path of [...folders.fonts ?? []].sort((a, b) => b.length - a.length)) {
    result = result
      .replace(new RegExp(`file://${urlPathSource(path)}/`, 'g'), '')
      .replaceAll(`${path}/`, '')
  }
  for (const folder of folders.run) {
    result = result.replaceAll(folder, RUN_FOLDER_NAME)
    const id = folder.slice(folder.lastIndexOf('/') + 1)
    // A try stops at the next `file://`, which no path holds: a lazy `\S*?`
    // alone tries each end of a long run of URLs with no white space (the
    // JSON of a list), which takes quadratic time.
    if (result.includes(id)) result = result.replace(new RegExp(`file://(?:(?!file://)\\S)*?/${regExpSource(id)}`, 'g'), `file://${RUN_FOLDER_NAME}`)
  }
  return withoutLocalPaths(result)
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

/** Whether the text of an error of a run names a flag of Deno. A model
 *  can set none, so a result tells it so. */
export function namesDenoFlag(error: string): boolean {
  return NAMES_FLAG.test(error)
}

/** Whether the text of an error of a run tells that skia-canvas could not
 *  load: Deno refused a permission (`namesDenoFlag`) in a file of the
 *  library, whose path holds `/libs/skia-canvas/` as the computer names
 *  it and as a model reads it. The library reads environment variables
 *  and loads its native file, which only a run of an app whose manifest
 *  asks for it may do (`runNativeCanvas`, appInvoke.ts). */
export function skiaCanvasRefused(error: string): boolean {
  return namesDenoFlag(error) && error.includes(`${LIBS_VIRTUAL_ROOT}/${NATIVE_CANVAS_LIBRARY}/`)
}

// The error of a static `import` in the code.
const STATIC_IMPORT = /'import', and 'export' cannot be used outside of module code/

// What a `js_eval` result tells of a Deno flag that its error names: the
// limits of the run, or that only a script app loads skia-canvas.
function flagAdvice(error: string): string {
  if (skiaCanvasRefused(error)) {
    return `The code of \`${JS_EVAL_TOOL.name}\` cannot load ${NATIVE_CANVAS_LIBRARY}: it loads a native file, which only the run of a script app may load. `
      + `Write a script app whose manifest.json has the field \`"native": ["${NATIVE_CANVAS_LIBRARY}"]\`, and run it with \`${APPS_TOOL.name} ${APPS_INVOKE}\`.`
  }
  return 'Dez runs the code with no network, no environment variables, no start of programs, and no packages, '
    + `and it opens no file but those of the work folder of this conversation (\`dez.workFolder\`, which Dez names \`${WORK_VIRTUAL_ROOT}\`). `
    + 'No flag changes that, and you can set none: do the work without them. '
    + `The code reads and changes the files of the apps in \`${APPS_VIRTUAL_ROOT}/\` only with \`dez.tools/${APPS_TOOL.name}/<subcommand>\` calls.`
}

// The advice that goes with the text of an error that the code threw, for
// the errors whose own text misleads a model.
function errorAdvice(error: string): string[] {
  return [
    ...(namesDenoFlag(error) ? [flagAdvice(error)] : []),
    ...(STATIC_IMPORT.test(error)
      ? ['The code is the body of a function, so a static `import` does not work in it. Load a built-in module with `await import("node:…")`.']
      : []),
  ]
}

/** What a result of a run of code tells before the console output of the
 *  code. */
export interface RunOutcome {
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

/** What ran, as the result of a run names it: the code of a `js_eval`
 *  call, or an app (`apps invoke`). */
export type RunSubject = 'code' | 'app'

/** The outcome of a run that failed, with the text `lead`. */
export function failedOutcome(lead: string): RunOutcome {
  return { isError: true, lead, given: null, advice: [] }
}

/** The outcome of a run of `subject` whose code returned `value`;
 *  `noValue` is the lead for no value. A string with no visible character
 *  does not go as it is: a blank result reads as a failure of the tool. */
export function returnedOutcome(value: string | undefined, subject: RunSubject, noValue: string): RunOutcome {
  const told = (lead: string): RunOutcome => ({ isError: false, lead, given: null, advice: [] })
  if (value === undefined) return told(noValue)
  if (value === '') return told(`The ${subject} returned an empty string.`)
  if (value.trim() === '') return told(`The ${subject} returned a string of only white space (${countOf(value.length, 'character')}).`)
  return { isError: false, lead: null, given: { text: value, name: 'returned value' }, advice: [] }
}

/** The outcome of a run of `subject` that ended with `end` before its code
 *  returned or threw, and that Dez did not stop at a time limit.
 *  `hasConsole` tells that the code wrote console output, which goes after
 *  it. `lost` tells what the run lost by its end, as a sentence right
 *  after the cause; blank for nothing. */
export function endedOutcome(end: Exclude<ProgramEnd, { kind: 'timedOut' }>, subject: RunSubject, hasConsole: boolean, lost: string): RunOutcome {
  const told = (cause: string, rest: string) => failedOutcome([cause, lost, rest].filter((part) => part !== '').join(' '))
  if (end.kind === 'outputTooLarge') {
    return told(`Dez stopped the ${subject}: it wrote more than ${byteSizeText(JS_EVAL_OUTPUT_BYTES)} of output.`, 'Write less to the console, and return only what you need.')
  }
  const silent = hasConsole ? '' : ` The ${subject} wrote nothing to the console.`
  // A signal that Dez did not send ended the program. V8 ends it this way
  // at the limit of its memory.
  if (end.code === null) {
    return told(`The system ended the ${subject} before it returned a value.`, 'The usual cause: the code used more memory than a run can have. '
      + `Use less memory (smaller arrays and strings, or the work in parts), and call again.${silent}`)
  }
  return told(`The ${subject} ended before it returned a value (exit code ${end.code}).`, 'The usual causes: an error in a timer or in a promise that the code did not await, '
    + `an \`await\` of a promise that never settles, or a call of \`Deno.exit\`.${hasConsole ? ' The console output tells which.' : silent}`)
}

// The outcome of a run of `call` with the end `end` and the protocol line
// `line`. `hasConsole` tells that the code wrote console output, which
// goes after it.
function runOutcome(call: JsEvalCall, end: ProgramEnd, line: JsEvalEndLine | null, hasConsole: boolean): RunOutcome {
  if (line?.type === 'result') {
    const noValue = hasConsole ? 'The code returned no value.' : 'The code returned no value, and it wrote nothing to the console. Give the result with `return`.'
    return returnedOutcome(line.text, 'code', noValue)
  }
  if (line?.type === 'error') {
    return { isError: true, lead: 'The code threw an error:', given: { text: line.text, name: 'text of the error' }, advice: errorAdvice(line.text) }
  }
  if (end.kind === 'timedOut') {
    return failedOutcome(`Dez stopped the code: it did not end within ${countOf(call.timeoutMs / 1000, 'second')}. `
      + `Make the code do less work, or give it more time with \`timeout_seconds\` (at most ${JS_EVAL_MAX_SECONDS}).`)
  }
  return endedOutcome(end, 'code', hasConsole, '')
}

/** What the tool calls of the code of a run (`dez.sbp`) left, for the
 *  result of the run (controller/toolBridge.ts). The code can leave out of
 *  its value what a call told it, so the result tells it. */
export interface JsEvalToolCalls {
  /** The images and the clips that the calls made and that Dez put into
   *  the reply, in their order. */
  assets: readonly { kind: JobAssetKind, id: string }[]
  /** The apps that the calls showed (`apps show`): Dez put each into the
   *  reply, in this order. */
  shownApps: readonly string[]
  /** The jobs that the calls started and that are still open: no call of
   *  the code took their results. Each with its number
   *  (`JobCall.number`). */
  jobs: readonly { id: string, number: number }[]
  /** How many calls had no answer when the run ended: Dez stopped the one
   *  that ran, and ran none of the calls after it. */
  unanswered: number
  /** How many pictures the calls showed the model (`asset_view`). */
  pictures: number
}

/** The lines that tell of the open jobs `jobs` that the tool calls of the
 *  code of a run started (`jobStartedText`), except a line that the given
 *  text `given` of the result holds: code often returns the text of its
 *  last call. */
export function openJobLines(jobs: readonly { id: string, number: number }[], given: string): string[] {
  return jobs.map(({ id, number }) => jobStartedText(id, number)).filter((line) => !given.includes(line))
}

/** The paragraph of a result that tells of the `unanswered` tool calls of
 *  the code that had not ended when the code ended; none for none. */
export function cutCallsParagraphs(unanswered: number): string[] {
  if (unanswered === 0) return []
  return [`${countOf(unanswered, 'tool call')} of the code had not ended when the code ended, so Dez cut ${unanswered === 1 ? 'it' : 'them'} short. `
    + '`await` each `dez.sbp` call, and give the code the time that its calls need.']
}

// What the tool calls `calls` left, as paragraphs of a result whose given
// text is `given` (blank for none):
// - A line for each made asset, each shown app, and each open job. A made
//   asset must be in the result as `madeAssetText` at the start of a line,
//   and a shown app as `shownAppText`: the readers of a tool block find
//   them there (`madeAssetIds`, `shownAppNames`), and a request sends no
//   other text of the asset or of the app. A line that the given text
//   holds does not come twice: code often returns the text of its last
//   call.
// - The calls that had no answer.
// - With `isError`, the pictures that the model does not get: only a
//   result that is no error has pictures (`ToolRunResult.pictures`).
function toolCallParagraphs(calls: JsEvalToolCalls, given: string, isError: boolean): string[] {
  const named = new Set(madeAssetIds(given))
  const namedApps = new Set(shownAppNames(given))
  const lines = [
    ...calls.assets.flatMap(({ kind, id }) => (named.has(id) ? [] : [`${madeAssetText(kind, id)}.`])),
    ...calls.shownApps.flatMap((name) => (namedApps.has(name) ? [] : [`${shownAppText(name)}.`])),
    ...openJobLines(calls.jobs, given),
  ]
  return [
    ...(lines.length === 0 ? [] : [`From the tool calls of the code:\n${lines.join('\n')}`]),
    ...cutCallsParagraphs(calls.unanswered),
    ...(isError && calls.pictures > 0
      ? [`The code failed, so Dez does not show you the ${countOf(calls.pictures, 'picture')} of its tool calls. Call asset_view yourself to see ${calls.pictures === 1 ? 'it' : 'them'}.`]
      : []),
  ]
}

/** What a run that ended with `end` and wrote `output` gave: its protocol
 *  line (null for none) and the console output of its code. The module of
 *  Dez ends the program with the code 0 right after its line, so a line of
 *  a run with another end is one that the code wrote: it does not count. */
export function endedRun(end: ProgramEnd, output: JsEvalOutput): { line: JsEvalEndLine | null, log: string } {
  const ended = output.ended()
  return { line: end.kind === 'exited' && end.code === 0 ? ended.line : null, log: ended.log }
}

/** The text of the result of a run of code with the outcome `outcome` and
 *  the console output `log`: the lead and the given text, the advice, the
 *  paragraphs of `more` (which gets the given text as the result holds
 *  it), then the console output. A first line tells of each cut.
 *  `forModel` takes the paths of this computer out of a text of the run
 *  (`textForModel`, with the folders of the run). */
export function runResultText({ lead, given, advice }: RunOutcome, log: string, forModel: (text: string) => string, more: (given: string) => string[]): string {
  const main = given === null ? null : mainPart(forModel(given.text), given.name)
  // The console output gets the room that the given text leaves.
  const written = consolePart(forModel(log), Math.max(JS_EVAL_TEXT_CAP - (main?.text.length ?? 0), LEAST_CONSOLE_ROOM))
  const paragraphs = [
    [...(lead === null ? [] : [lead]), ...(main === null ? [] : [main.text])].join('\n'),
    ...advice,
    ...more(main?.text ?? ''),
    ...(written === null ? [] : [`Console output of the code:\n${written.text}`]),
  ]
  const notes = [main, written].flatMap((part) => part?.note ?? [])
  return [...notes, paragraphs.join('\n\n')].join('\n')
}

/** The result of a run of `call` that ended with `end` and wrote `output`:
 *  the returned value, what its tool calls left (`toolCalls`), then the
 *  console output of the code. Any other end is an error result
 *  (`isError`) that tells the model what happened and what to do: the code
 *  threw an error, Dez stopped it at a limit, or it ended with no value.
 *  `folders` are the paths of the folders of the run on this computer
 *  (`textForModel`). */
export function jsEvalResult(call: JsEvalCall, end: ProgramEnd, output: JsEvalOutput, folders: RunFolderForms, toolCalls: JsEvalToolCalls): { text: string, isError: boolean } {
  const { line, log } = endedRun(end, output)
  const outcome = runOutcome(call, end, line, log.trim() !== '')
  const text = runResultText(outcome, log, (part) => textForModel(part, folders), (given) => toolCallParagraphs(toolCalls, given, outcome.isError))
  return { text, isError: outcome.isError }
}
