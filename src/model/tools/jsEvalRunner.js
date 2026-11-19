// The main module of a `js_eval` run (jsEval.ts). Dez writes this file into
// the work folder of the run, next to the code of the call (`code.ts`), and
// Deno runs it. It runs the code once and writes what the code gave as one
// protocol line to its standard output.
//
// The code of a model runs in this same program, so it can write any line
// itself: the page (`JsEvalOutput`) trusts no line.
//
// The page gets this file as a text (`?raw` in jsEval.ts). Nothing of the
// app imports it as code, and no type check reads it.

// Taken before the code runs: code that changes a global (a stub of
// `JSON.stringify`, a `Deno.exit` that does nothing) must not break the
// result line or the end of the run.
const { stringify } = JSON
const { isArray } = Array
const { getPrototypeOf, prototype: objectPrototype } = Object
const BaseError = Error
const encoder = new TextEncoder()
const stdout = Deno.stdout
const writeSync = stdout.writeSync.bind(stdout)
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

// The stack of an error, with no line of this module: the model did not
// write it, and can change nothing of it.
function stackText(error) {
  if (typeof error.stack !== 'string') return inspect(error)
  return error.stack.split('\n').filter((line) => !line.includes(RUNNER_URL)).join('\n')
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

let line
try {
  // The name of the code file is a literal: Deno then needs no permission
  // to import it. A syntax error of the code is thrown here.
  const { default: run } = await import('./code.ts')
  line = { type: 'result', text: resultText(await run()) }
} catch (error) {
  line = { type: 'error', text: errorText(error) }
}
send(line)
// A timer or a Worker that the code left must not hold the run to its
// time limit.
exit(0)
