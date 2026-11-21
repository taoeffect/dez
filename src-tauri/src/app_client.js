// Dez's client script of the page of an app. The scheme of the app frames
// serves it as `~dez.js` in the folder of each app (app_frames.rs), and a
// page loads it before its own scripts: `<script src="~dez.js"></script>`.
// It is the half of the frame messages (src/view/apps/appFrame.ts) that
// runs in the frame. A frame takes its keys and its clicks for itself: none
// of them reaches Dez's page. So this script tells Dez of the key and of
// the click that are for Dez, and runs the edit commands that Dez's menu
// took from the page.
//
// It is also the half of the frame bridge (src/model/tools/appBridge.ts)
// that runs in the frame, `window.dez.sbp`:
// - `dez.sbp(selector, ...args)` calls Dez, and gives a promise of the
//   answer. Dez checks each call; this script knows no selector of Dez.
// - `dez.sbp('sbp/selectors/register', { 'app/…': fn })` registers the
//   handlers that Dez can call, such as the handler of an `apps invoke`
//   run.
// - It keeps the console output of the page and the errors that nothing
//   caught, and gives them to Dez with the end of each call of Dez.
//
// Each message is an object whose `dez` field is its type. The page of an
// app has no origin (the sandbox), so a post has the target `*`, and each
// side trusts a message only by its `source`.
(() => {
  'use strict'
  const host = window.parent
  // A page that is in no frame (a new window of the webview).
  if (host === window) return
  // The URL of this script: a stack line with it names no code of the app.
  const CLIENT_URL = document.currentScript?.src ?? ''

  // Escape gives the keyboard back to Dez, unless the page took the key
  // for itself with `preventDefault`, or the key ends an IME composition.
  // This listener runs before those of the page (the capture phase of the
  // window), and its timer reads the event after all of them ran.
  window.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || event.isComposing) return
    setTimeout(() => {
      if (!event.defaultPrevented) host.postMessage({ dez: 'escape' }, '*')
    })
  }, true)

  // A context click shows Dez's menu of the app in place of the menu of the
  // webview, whose items are for a web page (Reload would end the app).
  // The page keeps the click when it cancels the event, for a menu of its
  // own. The webview keeps its menu where it has a use: in a text field and
  // on selected text (copy, paste).
  const showDezMenu = (event) => {
    if (event.defaultPrevented || !(event.target instanceof Element)) return
    const inTextField = event.target.isContentEditable || event.target.closest('input, textarea, select') !== null
    if (inTextField || !window.getSelection().isCollapsed) return
    event.preventDefault()
    host.postMessage({ dez: 'menu' }, '*')
  }
  // `showDezMenu` must run after every listener of the page, to read
  // whether one of them canceled the event. The listeners of one target run
  // in the order in which they were added, so this capture listener, the
  // first one of each click, puts `showDezMenu` at the end of the bubble
  // listeners of the window again.
  window.addEventListener('contextmenu', () => {
    window.removeEventListener('contextmenu', showDezMenu)
    window.addEventListener('contextmenu', showDezMenu)
  }, true)

  // On Linux the menu of Dez takes the keys of its items before a page
  // sees them (Undo, Redo, Select All, a line break). Dez sends such a
  // command to the app that has the keyboard, and it runs where the focus
  // is in this page, as the key would. `execCommand` is deprecated, but it
  // is the only way for a script to run the edit commands of a text field
  // (its undo history, a line break).
  const EDIT_COMMANDS = ['undo', 'redo', 'selectAll', 'insertLineBreak']

  // The text of any value, also of one that has no text form (an object
  // with no prototype).
  const plainText = (value) => {
    try {
      return String(value)
    } catch {
      return Object.prototype.toString.call(value)
    }
  }

  // Whether JSON keeps what `value` holds: an array, a plain object, or an
  // object that tells its own JSON form. JSON gives `{}` for a `Map`, a
  // `Set`, and an `Error`, and loses the class of an instance.
  const isJsonData = (value) => {
    if (value === null || typeof value !== 'object') return false
    if (Array.isArray(value) || typeof value.toJSON === 'function') return true
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
  }

  // The text of a value, by the rule of the value that the code of a
  // script app returns (`resultText`, src/model/tools/jsEvalRunner.js): a
  // string as it is, JSON data as JSON with the indent `indent`, and any
  // other value as its plain text (a number too, as JSON gives `null` for
  // `NaN`). No text for no value. A value that JSON refuses (a cycle, a
  // BigInt in it) goes as its plain text. Unlike `resultText`, it checks
  // only the top value: the page has no `Deno.inspect`, and the plain text
  // of an object is `[object Object]`, so an array or a plain object goes
  // as JSON also when JSON loses a value in it (a `Map` gives `{}`).
  const valueText = (value, indent) => {
    if (typeof value === 'string' || value === undefined) return value
    let json
    if (isJsonData(value)) {
      try {
        json = JSON.stringify(value, null, indent)
      } catch {
        // Not JSON data after all.
      }
    }
    return json ?? plainText(value)
  }

  // The name, the message, and the stack of an error. The stack of WebKit
  // has only the places (`draw@dezapp://localhost/notes/main.js:4:9`), so
  // the name and the message go before it. A line of this script is left
  // out: the model did not write it.
  const stackText = (error) => {
    const head = plainText(error)
    if (typeof error.stack !== 'string') return head
    const lines = error.stack.split('\n').filter((line) => line.trim() !== '' && (CLIENT_URL === '' || !line.includes(CLIENT_URL)))
    if (lines.length === 0) return head
    return lines[0].startsWith(head) ? lines.join('\n') : `${head}\n${lines.join('\n')}`
  }

  // The most causes of an error that the error text names: a cause can
  // name itself.
  const MAX_CAUSES = 5

  // The text of a thrown value: the stack of an error, then each of its
  // causes.
  const errorText = (thrown) => {
    if (!(thrown instanceof Error)) return valueText(thrown) ?? 'undefined'
    let text = stackText(thrown)
    let cause = thrown.cause
    for (let count = 0; cause !== undefined && count < MAX_CAUSES; count++) {
      const isError = cause instanceof Error
      text += `\nCaused by: ${isError ? stackText(cause) : valueText(cause)}`
      cause = isError ? cause.cause : undefined
    }
    return text
  }

  // The console output of the page and its errors that nothing caught,
  // since the last answer to Dez. Dez shows a model only the start and the
  // end of a long output, so this keeps at most LOG_MAX_CHARS characters:
  // the start, a line of …, and the end.
  const LOG_MAX_CHARS = 64000
  let log = ''
  const cutLog = (text) => (text.length <= LOG_MAX_CHARS ? text : `${text.slice(0, LOG_MAX_CHARS / 2)}\n…\n${text.slice(-LOG_MAX_CHARS / 2)}`)
  const addLog = (line) => {
    log += `${cutLog(line)}\n`
    // Not at each line: a cut copies the whole log.
    if (log.length > 2 * LOG_MAX_CHARS) log = cutLog(log)
  }
  const takeLog = () => {
    const taken = cutLog(log)
    log = ''
    return taken
  }

  // Each console method also writes its line to the log.
  for (const method of ['debug', 'log', 'info', 'warn', 'error']) {
    const write = console[method]
    console[method] = (...values) => {
      addLog(values.map((value) => (value instanceof Error ? errorText(value) : valueText(value) ?? 'undefined')).join(' '))
      write.apply(console, values)
    }
  }

  // The page of an app has no origin (the sandbox), so each script file of
  // the app is of another origin for it. The webview hides an error of
  // such a script from the page: the event has only this message, with no
  // error and no place. It hides nothing of a file that the page loads
  // with `crossorigin` or as a module (the scheme of the app frames lets
  // every origin read its files).
  const HIDDEN_ERROR_MESSAGE = 'Script error.'
  const HIDDEN_ERROR_NOTE = 'Uncaught error in a script file of the page. The webview hides its details, because the page loads that file without `crossorigin`. '
    + 'Load each script file as in <script src="main.js" crossorigin></script>, or with type="module", to get the error.'

  // The URL of the file that `element` could not load; blank for none.
  // The `src` and the `href` of an HTML element are absolute URLs. Those
  // of an SVG element (`<image>`, `<script>`) are an `SVGAnimatedString`
  // of the text of the attribute, made absolute here as an HTML one is.
  const fileUrl = (element) => {
    const url = element.src || element.href
    if (!(url instanceof SVGAnimatedString)) return url
    if (url.baseVal === '') return ''
    try {
      return new URL(url.baseVal, element.baseURI).href
    } catch {
      return url.baseVal
    }
  }

  // An error that no code of the page caught, and a file that an element
  // of the page could not load (its error event does not bubble: the
  // capture phase gets it).
  window.addEventListener('error', (event) => {
    if (event.target instanceof Element) {
      addLog(`The page could not load ${fileUrl(event.target) || `the file of a <${event.target.localName}>`}`)
    } else if (event.error !== null && event.error !== undefined) {
      addLog(`Uncaught ${errorText(event.error)}`)
    } else if (event.message === HIDDEN_ERROR_MESSAGE && !event.filename) {
      addLog(HIDDEN_ERROR_NOTE)
    } else {
      addLog(`Uncaught ${event.message}${event.filename ? ` (${event.filename}:${event.lineno}:${event.colno})` : ''}`)
    }
  }, true)
  window.addEventListener('unhandledrejection', (event) => {
    addLog(`Uncaught (in a promise) ${errorText(event.reason)}`)
  })

  // The calls of Dez that wait for their answers, by the id of the call:
  // `{ resolve, reject, ended, end }`.
  const waiting = new Map()
  let lastCallId = 0
  // APP_SELECTOR_MAX_CHARS of appBridge.ts: Dez drops a longer one.
  const SELECTOR_MAX_CHARS = 100

  // Calls the selector `selector` of Dez with `args`. The promise rejects
  // with an error whose message is the text of Dez, and whose stack names
  // the place of the call: the error is made here, as the answer comes in
  // a later task, where a new error has no stack of the page.
  const callDez = (selector, args) => {
    const failure = new Error()
    const call = {}
    const answer = new Promise((resolve, reject) => {
      call.resolve = resolve
      call.reject = (text) => {
        failure.message = text
        reject(failure)
      }
    })
    if (typeof selector !== 'string' || selector === '' || selector.length > SELECTOR_MAX_CHARS) {
      call.reject('dez.sbp takes the name of a selector of Dez and its arguments, as in dez.sbp(\'dez.app/readAsset\', \'a\').')
      return answer
    }
    // Ends at the answer of Dez, and never rejects (`runHandler`).
    call.ended = new Promise((resolve) => {
      call.end = resolve
    })
    const id = ++lastCallId
    waiting.set(id, call)
    try {
      host.postMessage({ dez: 'call', id, selector, args }, '*')
    } catch (error) {
      // An argument that a message cannot hold (a function, a DOM node).
      waiting.delete(id)
      call.reject(`Dez cannot take the arguments of ${selector}: ${plainText(error?.message)}`)
    }
    return answer
  }

  const endCall = ({ id, ok, value, error }) => {
    const call = waiting.get(id)
    if (call === undefined) return
    waiting.delete(id)
    if (ok) call.resolve(value)
    else call.reject(plainText(error))
    call.end()
  }

  // The handlers that the page registered, by their selectors. Dez can
  // call only them, and only a name of the domain `app`.
  const REGISTER = 'sbp/selectors/register'
  const HANDLER_PREFIX = 'app/'
  const handlers = new Map()

  // Registers the handlers of `given` (selector: function), and gives the
  // names that are new. As in SBP, the first handler of a name stays.
  const register = (given) => {
    if (given === null || typeof given !== 'object') {
      throw new TypeError(`${REGISTER} takes an object of functions, as in dez.sbp('${REGISTER}', { 'app/invoke': async (parameters, run) => { } }).`)
    }
    const entries = Object.entries(given)
    for (const [name, handler] of entries) {
      if (!name.startsWith(HANDLER_PREFIX)) throw new TypeError(`An app registers only selectors whose names start with "${HANDLER_PREFIX}", such as "app/invoke". ${JSON.stringify(name)} does not.`)
      if (typeof handler !== 'function') throw new TypeError(`The selector ${JSON.stringify(name)} needs a function.`)
    }
    const added = []
    for (const [name, handler] of entries) {
      if (handlers.has(name)) {
        console.warn(`The selector ${JSON.stringify(name)} has a handler already: the page keeps the first one.`)
        continue
      }
      handlers.set(name, handler)
      added.push(name)
    }
    return added
  }

  window.dez = Object.freeze({
    sbp: (selector, ...args) => (selector === REGISTER ? register(args[0]) : callDez(selector, args)),
  })

  // Ends when the page has loaded and each script of it has run, also the
  // `load` listeners of the page (this one is the first, and its timer
  // runs after them all): a handler can be registered until then.
  const pageLoaded = new Promise((resolve) => {
    const afterLoad = () => setTimeout(resolve)
    if (document.readyState === 'complete') afterLoad()
    else window.addEventListener('load', afterLoad, { once: true })
  })

  // Runs the handler of a call of Dez, and answers Dez with the text of
  // its value or of what it threw, and with the log. A handler that ends
  // with no error can have calls of Dez that it did not wait for (a save
  // with no `await`): the answer waits for those that wait then, as Dez
  // closes a run at its answer. This script adds no handler to the promise
  // of such a call, so one that Dez refused, and that no code of the page
  // caught, comes to the log as any other rejected promise does. The last
  // timer lets those errors reach the log first (each comes in a task of
  // its own).
  const runHandler = async ({ id, selector, args }) => {
    await pageLoaded
    const handler = handlers.get(selector)
    let end
    if (handler === undefined) {
      end = { ok: false, noHandler: true }
    } else {
      try {
        end = { ok: true, value: valueText(await handler(...args), 2) }
        await Promise.all(Array.from(waiting.values(), (call) => call.ended))
      } catch (error) {
        end = { ok: false, error: errorText(error) }
      }
    }
    await new Promise((resolve) => setTimeout(resolve))
    host.postMessage({ dez: 'answer', id, ...end, log: takeLog() }, '*')
  }

  window.addEventListener('message', (event) => {
    const message = event.data
    if (event.source !== host || message === null || typeof message !== 'object') return
    if (message.dez === 'edit' && EDIT_COMMANDS.includes(message.command)) document.execCommand(message.command)
    else if (message.dez === 'answer') endCall(message)
    else if (message.dez === 'call') void runHandler(message)
  })

  // Tells Dez that this script runs in the page, and which page it is: Dez
  // closes a frame whose script runs in another page than that of its app.
  // Dez can call a handler from now on: the call waits until the page has
  // loaded (`runHandler`).
  host.postMessage({ dez: 'ready', page: location.pathname }, '*')
})()
