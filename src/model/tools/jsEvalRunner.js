// The main module of a `js_eval` run (jsEval.ts). Dez writes this file into
// the work folder of the run, next to the code of the call (`code.ts`), and
// Deno runs it. It runs the code once and writes what the code gave as one
// protocol line to its standard output.
//
// The code gets one object, `dez`. With `dez.sbp` it calls the other Dez
// tools: this module writes one `call` line for each call, and Dez writes
// the answer as one line to the standard input (`jsEvalAnswerLine`).
//
// The code of a model runs in this same program, so it can write any line
// itself: the page (`JsEvalOutput`, `bridgedToolCall`) trusts no line, and
// nothing here is a guard.
//
// The page gets this file as a text (`?raw` in jsEval.ts). Nothing of the
// app imports it as code, and no type check reads it.

// Taken before the code runs: code that changes a global (a stub of
// `JSON.stringify`, a `Deno.exit` that does nothing) must not break the
// result line, a tool call, or the end of the run.
const { stringify, parse } = JSON
const { isArray } = Array
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

// Whether JSON keeps what `value` holds: an array, a plain object, or an
// object that tells its own JSON form. JSON gives `{}` for a `Map`, a
// `Set`, and an `Error`, and loses the class of an instance.
function isJsonData(value) {
  if (value === null || typeof value !== 'object') return false
  if (isArray(value) || typeof value.toJSON === 'function') return true
  const prototype = getPrototypeOf(value)
  return prototype === objectPrototype || prototype === null
}

// The text of the value that the code returned: a string as it is, JSON
// data as JSON, and any other value as Deno shows it (a number too, as
// JSON gives `null` for `NaN`). No text for no value. A value that JSON
// refuses (a cycle, a BigInt in it) goes as Deno shows it.
function resultText(value) {
  if (typeof value === 'string' || value === undefined) return value
  let json
  if (isJsonData(value)) {
    try {
      json = stringify(value, null, 2)
    } catch {
      // Not JSON data after all.
    }
  }
  return json ?? inspect(value)
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

const dez = freeze({ sbp })

let line
try {
  // The name of the code file is a literal: Deno then needs no permission
  // to import it. A syntax error of the code is thrown here.
  const { default: run } = await import('./code.ts')
  line = { type: 'result', text: resultText(await run(dez)) }
} catch (error) {
  line = { type: 'error', text: errorText(error) }
}
send(line)
// A timer or a Worker that the code left must not hold the run to its
// time limit.
exit(0)
