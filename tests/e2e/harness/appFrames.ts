import http from 'node:http'
import type { AddressInfo } from 'node:net'
import type { E2EBrowser } from './session'

// What the audit of the app frames is made of (app-frames.e2e.ts): a server
// that counts what reaches it, the frames that a spec opens in Dez's page,
// the reports of the pages in them, and the probes that a page runs.
//
// A spec adds each `<iframe>` to Dez's page itself, with the one `sandbox`
// value that Dez gives the frame of an app. The audit is of the guards of
// the frames (src-tauri/src/app_frames.rs), not of the part of Dez that
// shows an app.

export interface CountingServer {
  /** `http://127.0.0.1:<port>`, with no trailing slash. */
  url: string
  /** The same server by a name: `http://localhost:<port>`. To the webview
   *  this is another server, so no connection to `url` serves it. */
  nameUrl: string
  /** The method and the path of each request that came. A WebSocket
   *  handshake is a GET. */
  requests: string[]
  /** How many TCP connections came. A preconnect opens a connection and
   *  sends no request. */
  connections: () => number
  stop: () => Promise<void>
}

/** Starts a server on a free port that answers each request with an empty
 *  text that every origin can read, and keeps what came. So only a guard
 *  of the webview keeps a page from it. */
export async function startCountingServer (): Promise<CountingServer> {
  const requests: string[] = []
  let connections = 0
  const listen = (host: string, port: number): Promise<http.Server> => new Promise((resolve, reject) => {
    const server = http.createServer((request, response) => {
      requests.push(`${request.method} ${request.url}`)
      response.writeHead(200, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': '*',
        'Content-Type': 'text/plain',
      })
      response.end()
    })
    // Node gives a request that asks for an upgrade (a WebSocket) only to
    // this listener.
    server.on('upgrade', (request, socket) => {
      requests.push(`${request.method} ${request.url}`)
      socket.destroy()
    })
    server.on('connection', () => { connections++ })
    server.once('error', reject)
    server.listen(port, host, () => resolve(server))
  })
  const server = await listen('127.0.0.1', 0)
  const { port } = server.address() as AddressInfo
  // The name `localhost` can give the IPv6 address first, so the same port
  // listens there too. A computer with no IPv6 has only the first server.
  const servers = [server, await listen('::1', port).catch(() => null)].filter((made) => made !== null)
  return {
    url: `http://127.0.0.1:${port}`,
    nameUrl: `http://localhost:${port}`,
    requests,
    connections: () => connections,
    async stop () {
      await Promise.all(servers.map((made) => new Promise<void>((resolve) => {
        // A webview keeps its connections open, and close() waits for them.
        made.closeAllConnections()
        made.close(() => resolve())
      })))
    },
  }
}

/** The values that a spec gives the page of a frame. */
export type FrameConfig = Readonly<Record<string, unknown>>

/** The URL of the file `file` of the app `app` in the scheme of the app
 *  frames, with `config` in its fragment (`FRAME_LIBRARY` reads it). */
export function appFrameUrl (app: string, config: FrameConfig = {}, file = 'index.html'): string {
  return `dezapp://localhost/${app}/${file}#${encodeURIComponent(JSON.stringify(config))}`
}

// What a probe page works with. The code needs a `config` in its scope.
// - `report(probe, result)` gives Dez's page one report of this page.
// - `outcome(work)` is the result of one try as a text: the value that
//   `work` gave, `threw <name>` for an error, and `no answer` for a try
//   that does not end.
// - `loadElement(tag, attributes, parent)` adds an element, and gives the
//   name of its first `load` or `error` event.
// - `runProbes(probes)` runs each function of `probes` at the same time,
//   and gives the outcome of each by its name. It removes the elements
//   that the probes made, so a run in Dez's own page leaves none.
const PROBE_HELPERS = `
const report = (probe, result) => parent.postMessage({ probe, result }, '*')
const NO_ANSWER = {}
const outcome = async (work) => {
  try {
    const value = await Promise.race([
      Promise.resolve().then(work),
      new Promise((resolve) => setTimeout(() => resolve(NO_ANSWER), 2500)),
    ])
    return value === NO_ANSWER ? 'no answer' : String(value)
  } catch (error) {
    return 'threw ' + (error && error.name)
  }
}
const madeElements = []
const loadElement = (tag, attributes, parentNode = document.body) => new Promise((resolve) => {
  const element = document.createElement(tag)
  element.onload = () => resolve('load')
  element.onerror = () => resolve('error')
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value)
  madeElements.push(element)
  parentNode.append(element)
})
const runProbes = async (probes) => {
  const names = Object.keys(probes)
  const outcomes = await Promise.all(names.map((name) => outcome(probes[name])))
  for (const element of madeElements.splice(0)) element.remove()
  return Object.fromEntries(names.map((name, index) => [name, outcomes[index]]))
}
`

/** The script that each probe page of an app loads first: the config of
 *  the page from the fragment of its URL (`appFrameUrl`), then `report`,
 *  `outcome`, `loadElement`, and `runProbes`. */
export const FRAME_LIBRARY = `'use strict'
const config = JSON.parse(decodeURIComponent(location.hash.slice(1)))
${PROBE_HELPERS}`

/** The files of a probe page of an app: a page that loads `FRAME_LIBRARY`,
 *  then `script`. */
export function probePageFiles (script: string): Record<string, string> {
  return {
    'index.html': '<!doctype html><meta charset="utf-8"><title>probe</title><p id="text">text</p><script src="lib.js"></script><script src="main.js"></script>\n',
    'lib.js': FRAME_LIBRARY,
    'main.js': script,
  }
}

/** The script of a probe page that runs `probes` (the source of an object
 *  of functions, see `runProbes`), and reports their outcomes as
 *  `outcomes`. */
export function probesScript (probes: string): string {
  return `runProbes(${probes}).then((outcomes) => report('outcomes', outcomes))\n`
}

/** Where `runProbesInDez` runs its probes: Dez's own page, or a new frame
 *  of it that stays on `about:blank`. */
export type ProbePlace = 'page' | 'blank frame'

/**
 * Runs `probes` in code of Dez's own origin, and gives their outcomes.
 * - In `page`, no guard of the app frames holds. This is the control of a
 *   probe: it shows what the same code does when nothing stops it.
 * - In `blank frame`, no policy holds (Dez's page has none to give), so
 *   only the guards of the webview that cover each child frame do.
 */
export async function runProbesInDez (browser: E2EBrowser, place: ProbePlace, probes: string, config: FrameConfig): Promise<Record<string, string>> {
  return browser.execute(async (helpers: string, source: string, given: FrameConfig, where: ProbePlace) => {
    const frame = where === 'blank frame' ? document.createElement('iframe') : null
    if (frame) document.body.append(frame)
    try {
      // A function of the `Function` of a window runs with the globals of
      // that window, so the probes of a frame work in the page of it.
      const home = (frame ? frame.contentWindow : window) as (Window & { Function: FunctionConstructor }) | null
      if (!home) throw new Error('runProbesInDez: the frame has no window')
      const run = new home.Function('config', `'use strict'\n${helpers}\nreturn runProbes(${source})`) as (config: FrameConfig) => Promise<Record<string, string>>
      // A copy: the object of a frame that is gone is not for WebDriver.
      return { ...await run(given) }
    } finally {
      frame?.remove()
    }
  }, PROBE_HELPERS, probes, config, place)
}

/** One report of the page of a frame (`report` in `FRAME_LIBRARY`). */
export interface FrameReport {
  probe: string
  result: unknown
}

export interface FrameOptions {
  /** False leaves out the `sandbox` attribute, which Dez never does: only
   *  the policy of the page then sandboxes it. */
  sandbox?: boolean
}

/**
 * Adds a frame with the page `src` to Dez's page, as `id`. From the first
 * frame on, Dez's page keeps each report that a window posts to it, with
 * the id of the frame of that window.
 */
export async function openAppFrame (browser: E2EBrowser, id: string, src: string, options: FrameOptions = {}): Promise<void> {
  await browser.execute((frameId: string, frameSrc: string, { sandbox = true }: FrameOptions) => {
    interface Kept {
      frames: Record<string, HTMLIFrameElement>
      reports: Array<{ frame: string | null, probe: string, result: unknown }>
    }
    let kept = Reflect.get(window, '__e2eAppFrames') as Kept | undefined
    if (!kept) {
      const made: Kept = { frames: {}, reports: [] }
      kept = made
      Reflect.set(window, '__e2eAppFrames', made)
      window.addEventListener('message', (event) => {
        const data = event.data as { probe?: unknown, result?: unknown } | null
        if (typeof data?.probe !== 'string') return
        // The window of a frame stays the same object when the frame goes
        // to another page, so a report of that page has the id too.
        const frame = Object.keys(made.frames).find((name) => made.frames[name].contentWindow === event.source) ?? null
        made.reports.push({ frame, probe: data.probe, result: data.result })
      })
    }
    const frame = document.createElement('iframe')
    if (sandbox) frame.setAttribute('sandbox', 'allow-scripts')
    frame.dataset.appFrame = frameId
    // Above the UI of Dez, so a screenshot of a failure shows the frame.
    frame.style.cssText = 'position:fixed;left:20px;top:80px;width:400px;height:300px;z-index:9999;background:white'
    frame.src = frameSrc
    kept.frames[frameId] = frame
    document.body.append(frame)
  }, id, src, options)
}

/** Removes the frame `id` from Dez's page. Its reports stay. */
export async function closeAppFrame (browser: E2EBrowser, id: string): Promise<void> {
  await browser.execute((frameId: string) => {
    const kept = Reflect.get(window, '__e2eAppFrames') as { frames: Record<string, HTMLIFrameElement> } | undefined
    kept?.frames[frameId]?.remove()
    delete kept?.frames[frameId]
  }, id)
}

/** The reports that the frame `id` posted, in their order: those of each
 *  page that the frame had. `null` gives the reports of the windows that
 *  are the window of no frame, such as a frame in a frame. */
export async function frameReports (browser: E2EBrowser, id: string | null): Promise<FrameReport[]> {
  return browser.execute((frameId: string | null) => {
    const kept = Reflect.get(window, '__e2eAppFrames') as { reports: Array<FrameReport & { frame: string | null }> } | undefined
    return (kept?.reports ?? []).filter((report) => report.frame === frameId).map(({ probe, result }) => ({ probe, result }))
  }, id)
}

/** Waits for the report `probe` of the frame `id`, and gives its result. */
export async function frameReport (browser: E2EBrowser, id: string, probe: string): Promise<unknown> {
  let reports: FrameReport[] = []
  try {
    await browser.waitUntil(async () => {
      reports = await frameReports(browser, id)
      return reports.some((report) => report.probe === probe)
    }, { timeout: 30_000, interval: 50 })
  } catch (err) {
    throw new Error(`frameReport: the frame "${id}" gave no report "${probe}"; it gave ${JSON.stringify(reports)}`, { cause: err })
  }
  return reports.find((report) => report.probe === probe)?.result
}

/** Runs `work` with the page of the frame `id` as the page that WebDriver
 *  works in, then goes back to Dez's page. */
export async function inAppFrame<T> (browser: E2EBrowser, id: string, work: () => Promise<T>): Promise<T> {
  await browser.switchFrame(await browser.$(`iframe[data-app-frame="${id}"]`))
  try {
    return await work()
  } finally {
    await browser.switchFrame(null)
  }
}
