// The main module of every run of code in Deno: a `js_eval` run (jsEval.ts)
// and a run of a script app (appInvoke.ts). Dez writes this file into the
// run folder, next to the description of the run (`run.json`),
// and Deno runs it. It runs the code once and writes what the code gave as
// one protocol line to its standard output.
//
// The code of a `js_eval` call (`code.ts`, next to this file) gets one
// object, `dez`. With `dez.sbp` it calls the other Dez tools: this module
// writes one `call` line for each call, and Dez writes the answer as one
// line to the standard input (`jsEvalAnswerLine`). `dez.workFolder` is the
// path of the work folder of its conversation, which it can read and
// change.
//
// The code of an app (the default export of its `main.ts`) gets the
// parameters of the run and its own `dez` object, with the input files and
// the folders of the run (`appDez`).
//
// The code of a model runs in this same program, so it can write any line
// itself: the page (`JsEvalOutput`, `bridgedToolCall`) trusts no line, and
// nothing here is a guard.
//
// The page gets this file as a text (`?raw` in jsEval.ts). Nothing of the
// app imports it as code, and no type check reads it.

// The description of the run (`CODE_RUN_DESCRIPTION`, jsEval.ts;
// `appRunDescription`, appInvoke.ts). The name is a literal
// (`RUN_DESCRIPTION_FILE`), and the import is static: Deno then needs no
// permission to read the file.
import RUN from './run.json' with { type: 'json' }

// Taken before the code runs: code that changes a global (a stub of
// `JSON.stringify`, a `Deno.exit` that does nothing) must not break the
// result line, a tool call, or the end of the run.
const { stringify, parse } = JSON
const { isArray } = Array
const { isFinite } = Number
const { getPrototypeOf, prototype: objectPrototype, freeze } = Object
const BaseError = Error
const BasePromise = Promise
const { captureStackTrace } = Error
const encoder = new TextEncoder()
const decoder = new TextDecoder()
const stdout = Deno.stdout
const writeSync = stdout.writeSync.bind(stdout)
const readInput = Deno.stdin.read.bind(Deno.stdin)
const exit = Deno.exit
const inspect = Deno.inspect
const RUNNER_URL = import.meta.url

// The most causes of an error that the error text names: a cause can name
// itself.
const MAX_CAUSES = 5

// Writes one protocol line: RS (as in RFC 7464), one JSON object, and a
// line end. JSON escapes RS and line ends, so the object holds neither,
// and the page finds the line in any other text that the code wrote.
// `writeSync` can write only a part of the bytes.
function send(line) {
  let bytes = encoder.encode(`\x1e${stringify(line)}\n`)
  while (bytes.length > 0) bytes = bytes.subarray(writeSync(bytes))
}

// Whether JSON keeps all of `item`, one value of a result as the replacer
// of `JSON.stringify` gets it: after its own `toJSON`, which JSON does not
// call again. JSON gives `null` for `NaN`, `Infinity`, and a hole of an
// array, leaves out `undefined`, a function, and a symbol, gives `{}` for a
// `Map`, a `Set`, and an `Error`, and loses the class of an instance.
function keepsItem(item) {
  if (item === null || typeof item === 'string' || typeof item === 'boolean') return true
  if (typeof item === 'number') return isFinite(item)
  if (typeof item !== 'object') return false
  if (isArray(item)) return true
  const prototype = getPrototypeOf(item)
  return prototype === objectPrototype || prototype === null
}

// The replacer of the JSON form of a result: it stops `JSON.stringify` at
// the first value that JSON loses, so that a `Map` in an object does not
// go as `{}`. A `Date` in the data stays JSON (its `toJSON` gives a string).
function keptItem(key, item) {
  if (!keepsItem(item)) throw new BaseError('JSON loses a value of the result')
  return item
}

// How Deno shows a result: all of it, as JSON does. By default Deno shows
// only 4 levels, and 100 entries of a list.
const WHOLE_VALUE = { depth: Infinity, iterableLimit: Infinity }

// The text of the value that the code returned: a string as it is, JSON
// data as JSON, and any other value as Deno shows it. JSON data has no
// value that JSON loses at any depth (`keepsItem`), so a list with a `NaN`
// or an object with a `Map` goes as Deno shows it, and so does a value
// that JSON refuses (a cycle, a BigInt in it). No text for no value.
function resultText(value) {
  if (typeof value === 'string' || value === undefined) return value
  try {
    return stringify(value, keptItem, 2)
  } catch {
    // JSON loses or refuses a part of the value.
  }
  return inspect(value, WHOLE_VALUE)
}

// `lines` of a stack, with no line of this module: the model did not write
// it, and can change nothing of it.
function ownLines(lines) {
  return lines.filter((line) => !line.includes(RUNNER_URL))
}

// The stack of an error (`ownLines`).
function stackText(error) {
  if (typeof error.stack !== 'string') return inspect(error)
  return ownLines(error.stack.split('\n')).join('\n')
}

// The text of what the code threw, as Deno prints an error that nothing
// caught: the stack of an error, then each of its causes.
function errorText(error) {
  if (!(error instanceof BaseError)) return `Uncaught ${inspect(error)}`
  let text = stackText(error)
  let cause = error.cause
  for (let count = 0; cause !== undefined && count < MAX_CAUSES; count++) {
    const isError = cause instanceof BaseError
    text += `\nCaused by: ${isError ? stackText(cause) : inspect(cause)}`
    cause = isError ? cause.cause : undefined
  }
  return text
}

// The tool calls of the code that wait for their answers, by the id of
// their call lines: `{ resolve, reject, frames }`.
const waiting = { __proto__: null }
let waitingCount = 0
let nextCallId = 1
let readsAnswers = false
// The text of the input after its last line end: the start of a line whose
// end did not come yet.
let inputRest = ''

// The error that ends a waiting call: its message is `text`, and its stack
// names the place of the call in the code (`call.frames`). The end of a
// call comes in a later turn of the event loop, where a new error has no
// frame of the code.
function callError(call, text, options) {
  const error = new BaseError(text, options)
  error.stack = `${error.name}: ${text}${call.frames}`
  return error
}

// Ends each call that waits with an error: no answer comes any more.
function failWaitingCalls(cause) {
  for (const id in waiting) {
    const call = waiting[id]
    delete waiting[id]
    waitingCount--
    call.reject(callError(call, 'The tool call got no result: Dez closed the input of the run.', { cause }))
  }
}

// Gives the call that the answer line `text` names its result: the result
// text of the tool, or an error with the error text of the tool.
function takeAnswer(text) {
  let answer
  try {
    answer = parse(text)
  } catch {
    return
  }
  const call = waiting[answer?.id]
  if (!call) return
  delete waiting[answer.id]
  waitingCount--
  if (answer.isError) call.reject(callError(call, answer.text))
  else call.resolve(answer.text)
}

// Reads the answers of Dez, one JSON object in each line of the standard
// input, while a call waits for one. A read that waits holds the program
// open, so this reads only then: code with no open call ends as code
// that makes no call (Deno ends a program whose main module awaits
// something that never comes).
async function readAnswers() {
  if (readsAnswers) return
  readsAnswers = true
  const buffer = new Uint8Array(65536)
  try {
    while (waitingCount > 0) {
      const count = await readInput(buffer)
      // The end of the input.
      if (count === null) return failWaitingCalls()
      inputRest += decoder.decode(buffer.subarray(0, count), { stream: true })
      let end
      while ((end = inputRest.indexOf('\n')) >= 0) {
        takeAnswer(inputRest.slice(0, end))
        inputRest = inputRest.slice(end + 1)
      }
    }
  } catch (error) {
    failWaitingCalls(error)
  } finally {
    readsAnswers = false
  }
}

// The lines of the stack at a call of `dez.sbp`, each after a line end.
function callFrames() {
  const trace = {}
  captureStackTrace(trace, sbp)
  return ownLines(`${trace.stack}`.split('\n').slice(1)).map((line) => `\n${line}`).join('')
}

// `dez.sbp`: a call of a Dez tool, `dez.tools/<tool>` with the arguments
// of the tool, or `dez.tools/<tool>/<subcommand>` with the parameters of
// the subcommand. It gives a promise of the result text of the tool, which
// rejects with the error text of the tool. It is the star selector
// `dez.tools/*` of an SBP with no other selector: Dez reads the name of
// the tool (`bridgedToolCall`), so a new tool needs no change here. Any
// other selector throws as in SBP.
//
// Arguments that JSON cannot write (a cycle, a BigInt) reject the promise
// before a line goes, so no call waits for an answer that never comes.
function sbp(selector, args) {
  if (typeof selector !== 'string' || !selector.startsWith('dez.tools/')) {
    throw new BaseError(`SBP: selector not registered: ${typeof selector === 'string' ? selector : inspect(selector)}. `
      + '`dez.sbp` has only the selectors "dez.tools/<tool>" and "dez.tools/<tool>/<subcommand>", which call a Dez tool.')
  }
  const frames = callFrames()
  return new BasePromise((resolve, reject) => {
    const id = nextCallId++
    send({ type: 'call', id, selector, arguments: args })
    waiting[id] = { resolve, reject, frames }
    waitingCount++
    readAnswers()
  })
}

// Runs the code of a `js_eval` call.
async function runCode() {
  // The name of the code file is a literal: Deno then needs no permission
  // to import it. A syntax error of the code is thrown here.
  const { default: run } = await import('./code.ts')
  return run(freeze({ sbp, workFolder: RUN.workFolder }))
}

// The `dez` object of a run of an app: the copies of the input assets
// (`inputs`, each with the path of its file), the folder for the files
// that the run gives back (`outputFolder`), the folder of the app
// (`appFolder`), and the work folder of the conversation (`workFolder`).
// It has no `sbp`: the code of an app calls no Dez tool.
function appDez({ inputs, outputFolder, appFolder, workFolder }) {
  return freeze({ inputs: freeze(inputs.map((input) => freeze({ ...input }))), outputFolder, appFolder, workFolder })
}

// Runs an app: the default export of its `main.ts`, with the parameters of
// the run. The `dez` object is made first, before code of the app can
// change a global. A syntax error of the app is thrown at the import.
async function runApp() {
  const dez = appDez(RUN)
  const { default: main } = await import(RUN.main)
  if (typeof main !== 'function') {
    throw new BaseError('main.ts has no default export that is a function. '
      + 'Export the function of the app as the default, as in `export default async function main(parameters, dez) { … }`.')
  }
  return main(RUN.parameters, dez)
}

let line
try {
  line = { type: 'result', text: resultText(await (RUN.kind === 'app' ? runApp() : runCode())) }
} catch (error) {
  line = { type: 'error', text: errorText(error) }
}
send(line)
// A timer or a Worker that the code left must not hold the run to its
// time limit.
exit(0)
