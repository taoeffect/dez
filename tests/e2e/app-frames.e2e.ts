import fs from 'node:fs'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { UI_IMPORT_MAP_TAG } from '../../src/model/tools/appTemplates'
import { startApp, type RunningApp } from './harness/app'
import {
  appFrameUrl, closeAppFrame, frameReport, frameReports, inAppFrame, openAppFrame, probePageFiles, probesScript,
  runProbesInDez, startCountingServer, type CountingServer, type FrameConfig,
} from './harness/appFrames'
import { seedApp } from './harness/apps'
import { screenshotOnFailure, waitForValue } from './harness/dom'
import { appFilePath, seedAppState, writeTestFile } from './harness/fixtures'
import { createSession, destroySession, type E2EBrowser } from './harness/session'

// The audit of the app frames, on the real app: the scheme, the policy, the
// navigation guard, the content rule list, and the link preconnect switch
// of src-tauri/src/app_frames.rs, with the sandbox of WebKit. The page of
// an app is the work of a model, so each page here tries to get out of its
// frame. A new WebKitGTK and a new Tauri must pass it too.
// - A page does its own work: its own files (a script, a module, a
//   stylesheet, an image, a `fetch`), inline code, `eval`, WebAssembly,
//   `data:` and Blob images, and a Worker from a Blob. So a page that
//   fails to get out is not a page that does nothing.
// - A page imports the libraries that Dez ships, by the names of the
//   import map of a new UI app, from `~libs/` in the folder of its own app.
// - A page has no place of its own and no reach into Dez: no storage, no
//   cookie, no document of Dez, no new window, and no page script of
//   Tauri. The policy sandboxes a frame with no `sandbox` attribute too.
// - No load of a page reaches a server: the server of the audit gets no
//   request and no TCP connection, also for a `<link rel="preconnect">`,
//   which no directive of the policy stops. The content rule list stops
//   the loads by itself too, in a blank frame of Dez's page, which has no
//   policy.
// - A page reads no file of the computer (the asset protocol, a `file:`
//   URL), no file of another app, and nothing of Dez's own page.
// - The policy of a page has each directive that another guard hides: the
//   page tells of the refusal of the policy itself, for a load that the
//   rule list, the navigation guard, or a missing loader would stop too.
// - A frame cannot leave the scheme: each way to go to another page leaves
//   it where it is, with no request and no TCP connection. A click on a
//   link to a new window is one of the ways: WebKit connects to the server
//   of such a link and asks no guard, so Dez turns the link preconnect
//   off. A frame that goes to Dez's own page gets a page with no Tauri in
//   it.
// - A post to Tauri's IPC handler runs no command without the invoke key,
//   which a frame cannot read. The key is the one guard there: the same
//   post with the key runs the command (the control).
// - The scheme serves only a regular file below the folder of an app, or
//   a file of the shipped libraries at `~libs/` in it: no link, no folder,
//   no path that goes up, no other host, and no write.
//
// The control of a try: where the same code can run in Dez's own page, it
// does. The policy, the rule list, and the sandbox do not cover that page,
// so the try works there, which shows that a guard stops it in a frame,
// and not a fault of its own code. A connection with no request has no
// control: the link preconnect is off for the whole webview.
//
// Not covered here: the name lookup of a `<link rel="dns-prefetch">`
// (nothing here counts lookups; the rule list stops it with the same rule
// as the preconnect), WebRTC (WebKitGTK has none, which the audit checks),
// the `worker-src`, `form-action`, and `webrtc` directives of the policy by
// themselves (the sandbox and WebKitGTK stop each try first, with no
// report of the policy), a page that never pauses (it stops Dez's page),
// and macOS.
//
// One app session serves the whole file. The spec adds each `<iframe>` to
// Dez's page itself (harness/appFrames.ts).

// The text of each file that a page must not get. No page of an app holds
// it, so an outcome has it only when a page read a file.
const PRIVATE = 'private text of the audit'

// What the scheme answers for each URL that names no file of an app
// (`NO_SUCH_FILE` in app_frames.rs).
const NO_SUCH_FILE = 'No such file in this app.'

const OWN_DATA = '{"own":"data"}'
const DOT_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>'
// (module (func (export "add") (param i32 i32) (result i32)
//   local.get 0 local.get 1 i32.add))
const ADD_WASM = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0, 1, 7, 1, 96, 2, 127, 127, 1, 127, 3, 2, 1, 0, 7, 7, 1, 3, 97, 100, 100, 0, 0, 10, 9, 1, 7, 0, 32, 0, 32, 1, 106, 11])

// A page that tells the window above it that it ran.
const NEW_PAGE = '<script>parent.postMessage({ probe: "a new page", result: "ran" }, "*")</script>'

// One try of a page: its name, the source of a function that does the try,
// and the outcome that the try must have in the frame of an app (`outcome`
// in harness/appFrames.ts).
type Probe = readonly [name: string, source: string, outcome: string]

// A try with its control: the outcome of the same code in Dez's own page.
// `null` for a try that Dez's page cannot do either.
type ControlledProbe = readonly [...Probe, control: string | null]

/** The source of the object of functions that `runProbes` takes. */
function probesSource (probes: ReadonlyArray<readonly [name: string, source: string, ...more: unknown[]]>): string {
  return `{\n${probes.map(([name, source]) => `${JSON.stringify(name)}: ${source}`).join(',\n')}\n}`
}

function frameOutcomes (probes: ReadonlyArray<Probe | ControlledProbe>): Record<string, string> {
  return Object.fromEntries(probes.map(([name, , outcome]) => [name, outcome]))
}

// A Worker from a Blob with the code `code`: the first message of the
// Worker, as the source of an expression.
const blobWorker = (code: string): string => `new Promise((resolve, reject) => {
  const worker = new Worker(URL.createObjectURL(new Blob([${code}], { type: 'text/javascript' })))
  worker.onmessage = (event) => resolve(event.data)
  worker.onerror = () => reject(new Error('the Worker did not start'))
})`

// The work of a page that must go on.
const OWN_WORK: readonly Probe[] = [
  ['a fetch of its own file', "() => fetch('data.json').then((response) => response.text())", OWN_DATA],
  ['a module of its own files', "() => import('./mod.js').then((module) => module.value)", 'the value of dep.js'],
  ['its own stylesheet', "() => loadElement('link', { rel: 'stylesheet', href: 'style.css' }, document.head).then((event) => event + ', ' + getComputedStyle(document.getElementById('text')).color)", 'load, rgb(1, 2, 3)'],
  ['its own image', "() => loadElement('img', { src: 'dot.svg' })", 'load'],
  ['an image from a data: URL', "() => loadElement('img', { src: 'data:image/svg+xml,' + encodeURIComponent(config.svg) })", 'load'],
  ['an image from a Blob', "() => loadElement('img', { src: URL.createObjectURL(new Blob([config.svg], { type: 'image/svg+xml' })) })", 'load'],
  ['an inline script', "() => { const script = document.createElement('script'); script.textContent = 'window.inlineScript = \"ran\"'; document.head.append(script); return window.inlineScript }", 'ran'],
  ['an inline style', "() => { const text = document.getElementById('text'); text.setAttribute('style', 'letter-spacing: 3px'); return getComputedStyle(text).letterSpacing }", '3px'],
  ['eval', "() => (0, eval)('1 + 1')", '2'],
  ['new Function', "() => new Function('return 1 + 1')()", '2'],
  ['WebAssembly from bytes', '() => WebAssembly.instantiate(new Uint8Array(config.wasm)).then(({ instance }) => instance.exports.add(2, 3))', '5'],
  ['WebAssembly from its own file', "() => WebAssembly.instantiateStreaming(fetch('add.wasm')).then(({ instance }) => instance.exports.add(2, 3))", '5'],
  [
    'a Worker from a Blob that reads a file of the app',
    `() => ${blobWorker("'fetch(' + JSON.stringify(new URL('data.json', location.href).href) + ').then((response) => response.text()).then((text) => postMessage(text), (error) => postMessage(\"threw \" + error.name))'")}`,
    OWN_DATA,
  ],
]

// The libraries that Dez ships, which a page imports by the names of the
// import map of a new UI app (`UI_IMPORT_MAP_TAG`). A library imports its
// own parts by their names too (`three` from an addon, `@kurkle/color` from
// chart.js). The page loads only the map: its scripts are not modules.
const LIBRARIES: readonly Probe[] = [
  ['three', "() => import('three').then((THREE) => new THREE.Vector3(1, 2, 2).length())", '3'],
  ['an addon of three', "() => import('three/addons/utils/BufferGeometryUtils.js').then((module) => typeof module.mergeGeometries)", 'function'],
  ['chart.js', "() => import('chart.js').then((module) => typeof module.Chart)", 'function'],
  [
    'a chart of chart.js/auto',
    `() => import('chart.js/auto').then(({ default: Chart }) => {
      const canvas = document.createElement('canvas')
      canvas.width = 40
      canvas.height = 40
      document.body.append(canvas)
      new Chart(canvas, {
        type: 'bar',
        data: { labels: ['a'], datasets: [{ data: [1], backgroundColor: 'rgb(255, 0, 0)' }] },
        options: { animation: false, responsive: false, devicePixelRatio: 1, plugins: { legend: { display: false } }, scales: { x: { display: false }, y: { display: false, min: 0 } } },
      })
      const [red, green, blue] = canvas.getContext('2d').getImageData(20, 30, 1, 1).data
      canvas.remove()
      return red === 255 && green === 0 && blue === 0 ? 'drew' : 'rgb(' + red + ', ' + green + ', ' + blue + ')'
    })`,
    'drew',
  ],
  ['fft.js', "() => import('fft.js').then(({ default: FFT }) => new FFT(8).size)", '8'],
  // A library with a native file runs only in Deno: the map has no name
  // of it.
  ['skia-canvas', "() => import('skia-canvas')", 'threw TypeError'],
  // The libraries at the route of another app are files of that app for
  // the policy of the page.
  ['a library at the route of another app', "() => import('dezapp://localhost/other/~libs/fft.js/lib/fft.esm.js')", 'threw TypeError'],
]

// What the sandbox takes from a page.
const NO_PLACE: readonly Probe[] = [
  ['its origin', '() => self.origin', 'null'],
  ['localStorage', "() => localStorage.setItem('audit', '1')", 'threw SecurityError'],
  ['sessionStorage', "() => sessionStorage.setItem('audit', '1')", 'threw SecurityError'],
  ['IndexedDB', "() => new Promise((resolve, reject) => { const request = indexedDB.open('audit'); request.onsuccess = () => resolve('opened'); request.onerror = () => reject(request.error) })", 'threw SecurityError'],
  // WebKit keeps no cookie and throws nothing; the HTML standard has an
  // error here. Both are a page with no cookie.
  ['a cookie', "() => { try { document.cookie = 'audit=1'; return document.cookie || 'no cookie' } catch (error) { return 'no cookie' } }", 'no cookie'],
  ['the cache storage', "() => caches.open('audit')", 'threw SecurityError'],
  ['a service worker', "() => navigator.serviceWorker.register('main.js')", 'threw SecurityError'],
  ['the document of Dez', '() => parent.document.title', 'threw SecurityError'],
  ['the selectors of Dez', '() => typeof parent.sbp', 'threw SecurityError'],
  ['the URL of Dez', '() => top.location.href', 'threw SecurityError'],
  ['a new window', "() => window.open('about:blank')", 'null'],
  ['the page script of Tauri', '() => typeof window.__TAURI_INTERNALS__', 'undefined'],
  // WebKitGTK has no WebRTC. A version that has it fails here: the audit
  // then needs a try that sends data with it.
  ['WebRTC', '() => typeof RTCPeerConnection', 'undefined'],
]

// Each way of a page to reach a server: the source of a function that gets
// the URL of its try on the server. The count of the server is the result,
// not the outcome of the try: `sendBeacon` gives true and sends nothing,
// and a frame that loaded nothing has a `load` event.
const NETWORK_TRIES: Readonly<Record<string, string>> = {
  fetch: '(url) => fetch(url)',
  'fetch-no-cors': "(url) => fetch(url, { mode: 'no-cors' })",
  xhr: "(url) => new Promise((resolve, reject) => { const request = new XMLHttpRequest(); request.open('GET', url); request.onload = () => resolve(request.status); request.onerror = () => reject(new Error('no answer')); request.send() })",
  beacon: "(url) => navigator.sendBeacon(url, 'data')",
  image: "(url) => loadElement('img', { src: url })",
  script: "(url) => loadElement('script', { src: url })",
  stylesheet: "(url) => loadElement('link', { rel: 'stylesheet', href: url }, document.head)",
  'css-import': "(url) => { const style = document.createElement('style'); style.textContent = '@import url(\"' + url + '\");'; madeElements.push(style); document.head.append(style) }",
  'css-background': "(url) => { const box = document.createElement('div'); box.style.cssText = 'width:10px;height:10px;background-image:url(\"' + url + '\")'; madeElements.push(box); document.body.append(box) }",
  font: "(url) => new FontFace('audit', 'url(\"' + url + '\")').load()",
  websocket: "(url) => new Promise((resolve) => { const socket = new WebSocket(url.replace('http', 'ws')); socket.onopen = () => resolve('open'); socket.onerror = () => resolve('error') })",
  'event-source': "(url) => new Promise((resolve) => { const source = new EventSource(url); source.onopen = () => { source.close(); resolve('open') }; source.onerror = () => { source.close(); resolve('error') } })",
  frame: "(url) => loadElement('iframe', { src: url })",
  object: "(url) => loadElement('object', { data: url, type: 'text/html' })",
  embed: "(url) => loadElement('embed', { src: url, type: 'text/html' })",
  audio: "(url) => loadElement('audio', { src: url })",
  video: "(url) => loadElement('video', { src: url })",
  preload: "(url) => loadElement('link', { rel: 'preload', as: 'fetch', href: url, crossorigin: 'anonymous' }, document.head)",
  'preload-image': "(url) => loadElement('link', { rel: 'preload', as: 'image', href: url }, document.head)",
  modulepreload: "(url) => loadElement('link', { rel: 'modulepreload', href: url }, document.head)",
  prefetch: "(url) => loadElement('link', { rel: 'prefetch', href: url }, document.head)",
  'module-import': '(url) => import(url)',
  'worker-fetch': `(url) => ${blobWorker("'fetch(' + JSON.stringify(url) + ').then(() => postMessage(\"fetched\"), (error) => postMessage(\"threw \" + error.name))'")}`,
  'worker-import': `(url) => ${blobWorker("'try { importScripts(' + JSON.stringify(url) + '); postMessage(\"imported\") } catch (error) { postMessage(\"threw \" + error.name) }'")}`,
  // A link to a part of the page that it is in, so the page stays. The
  // whole URL: a short `#ping` in a blank frame is a part of Dez's page,
  // which the frame then loads.
  ping: "(url) => { const link = document.createElement('a'); link.href = location.href.replace(/#.*$/, '') + '#ping'; link.setAttribute('ping', url); madeElements.push(link); document.body.append(link); link.click() }",
}

// The ways that send no request, so they get the server and no path: a
// connection, by the address and by the name of the server, and a name
// lookup.
const CONNECTION_TRIES: Readonly<Record<string, string>> = {
  preconnect: "() => loadElement('link', { rel: 'preconnect', href: config.server }, document.head)",
  'preconnect-name': "() => loadElement('link', { rel: 'preconnect', href: config.nameServer }, document.head)",
  'dns-prefetch': "() => loadElement('link', { rel: 'dns-prefetch', href: config.nameServer }, document.head)",
}

const NETWORK_PROBES = probesSource([
  ...Object.entries(NETWORK_TRIES).map(([name, source]) => [name, `() => (${source})(config.server + '/hit/${name}')`] as const),
  ...Object.entries(CONNECTION_TRIES),
])
const NETWORK_NAMES = [...Object.keys(NETWORK_TRIES), ...Object.keys(CONNECTION_TRIES)].sort()

// The tries whose request reaches the server from Dez's own page. Not in
// the list: `frame`, `object`, and `embed` (the navigation guard and the
// rule list cover each frame of the webview, also one of Dez's page), and
// `prefetch` (WebKit has the link prefetch off).
const REACHES_FROM_DEZ = Object.keys(NETWORK_TRIES).filter((name) => !['frame', 'object', 'embed', 'prefetch'].includes(name)).sort()

// A script that tells that it ran, and the try that loads it.
const scriptTry = (url: string, flag: string): string =>
  `() => loadElement('script', { src: ${url} }).then((event) => event + '; the script ' + (window.${flag} ? 'ran' : 'did not run'))`

// The places that a page must not read: the files of the computer through
// the asset protocol of Dez and through `file:`, Dez's own page, Tauri's
// IPC scheme, and the files of another app.
const OTHER_PLACES: readonly ControlledProbe[] = [
  ['a fetch of an asset: URL', '() => fetch(config.asset.text).then((response) => response.text())', 'threw TypeError', PRIVATE],
  ['a fetch of an asset: URL with no CORS', "() => fetch(config.asset.text, { mode: 'no-cors' }).then((response) => response.type)", 'threw TypeError', 'opaque'],
  ['an image from an asset: URL', "() => loadElement('img', { src: config.asset.image })", 'error', 'load'],
  ['a script from an asset: URL', scriptTry('config.asset.script', 'assetScript'), 'error; the script did not run', 'load; the script ran'],
  ['a frame with an asset: page', "() => new Promise((resolve) => { addEventListener('message', () => resolve('the page ran')); loadElement('iframe', { src: config.asset.page }) })", 'no answer', null],
  ['a fetch of a file: URL', "() => fetch('file:///etc/hostname').then((response) => response.text())", 'threw TypeError', null],
  ['an image from a file: URL', "() => loadElement('img', { src: 'file://' + config.imageFile })", 'error', null],
  ["a fetch of Dez's own page", "() => fetch('tauri://localhost/index.html').then((response) => response.status)", 'threw TypeError', '200'],
  ["a fetch of Tauri's IPC scheme", "() => fetch('ipc://localhost/get_app_dir', { method: 'POST', body: '{}' }).then((response) => 'an answer')", 'threw TypeError', 'an answer'],
  ['a fetch of a file of another app', "() => fetch('dezapp://localhost/other/secret.txt').then((response) => response.text())", 'threw TypeError', PRIVATE],
  ['a script of another app', scriptTry("'dezapp://localhost/other/secret.js'", 'otherScript'), 'error; the script did not run', 'load; the script ran'],
  ['an image of another app', "() => loadElement('img', { src: 'dezapp://localhost/other/dot.svg' })", 'error', 'load'],
  ['a stylesheet of another app', "() => loadElement('link', { rel: 'stylesheet', href: 'dezapp://localhost/other/style.css' }, document.head)", 'error', 'load'],
  // A `<base>` would make each relative URL of the page a URL of its
  // choice. The element goes at once: in the control it is in Dez's page.
  [
    'a base URL in another app',
    "() => { const base = document.createElement('base'); base.href = 'dezapp://localhost/other/'; document.head.append(base); try { return new URL('x', document.baseURI).href } finally { base.remove() } }",
    'dezapp://localhost/places/x',
    'dezapp://localhost/other/x',
  ],
]

// The directives of the policy that no other try isolates: another guard
// stops the same load too (the rule list, the navigation guard), or the
// load gives the same error with and without the policy. Each try is
// refused by one directive, and waits for the report of the policy for it
// (`refusedBy`): a policy without the directive gives `no answer`.
const POLICY_ONLY: readonly Probe[] = [
  ['a font of another app', "() => refusedBy('font-src', () => new FontFace('audit', 'url(\"dezapp://localhost/other/secret.txt\")').load())", 'refused by font-src'],
  ['a clip of another app', "() => refusedBy('media-src', () => loadElement('audio', { src: 'dezapp://localhost/other/secret.txt' }))", 'refused by media-src'],
  ['an object', "() => refusedBy('object-src', () => loadElement('object', { data: 'dezapp://localhost/other/dot.svg', type: 'image/svg+xml' }))", 'refused by object-src'],
  ['a frame in the page', "() => refusedBy('frame-src', () => loadElement('iframe', { src: 'dot.svg' }))", 'refused by frame-src'],
  ['a fetch from a server', "() => refusedBy('connect-src', () => fetch(config.server + '/hit/policy'))", 'refused by connect-src'],
]

// Each way of a frame to go to another page: the code of the move, with
// `target` (the URL of the move on the server), `link` (a click on a new
// link), and `form` (a form that is sent to `target`). A link to a new
// window is here in each of its forms: WebKit connects to the server of
// such a link at the click, and asks no guard first (the link preconnect,
// which Dez turns off).
const MOVES: Readonly<Record<string, string>> = {
  'location.href': 'location.href = target',
  'location.assign': 'location.assign(target)',
  'location.replace': 'location.replace(target)',
  'a meta refresh': "const meta = document.createElement('meta'); meta.httpEquiv = 'refresh'; meta.content = '0;url=' + target; document.head.append(meta)",
  'a link': 'link({ href: target })',
  'a link to a new window': "link({ href: target, target: '_blank' })",
  'an area link to a new window': "link({ href: target, target: '_blank' }, 'area')",
  'a link to a new window by the base target': "const base = document.createElement('base'); base.target = '_blank'; document.head.append(base); link({ href: target })",
  'a link to the top window': "link({ href: target, target: '_top' })",
  'a download link': "link({ href: target, download: 'file.txt' })",
  'a form with GET': "form('get')",
  'a form with POST': "form('post')",
  'a form to a new window': "form('get', '_blank')",
  'window.open': 'window.open(target)',
  'top.location': 'top.location = target',
  'parent.location': 'parent.location.href = target',
  'a data: page': "location.href = 'data:text/html,' + encodeURIComponent(config.newPage)",
  'a Blob page': "location.href = URL.createObjectURL(new Blob([config.newPage], { type: 'text/html' }))",
  'an asset: page': 'location.href = config.assetPage',
  'a file: URL': "location.href = 'file:///etc/hostname'",
  "Tauri's IPC scheme": "location.href = 'ipc://localhost/get_app_dir'",
}

// The moves that the guard allows, as the control: the same code with a
// page of the app as its target does leave the page.
const OWN_MOVES: Readonly<Record<string, string>> = {
  'location.href to its own page': "location.href = 'second.html'",
  'a link to its own page': "link({ href: 'second.html' })",
}

// The one move away from the app that the guard cannot stop: it gets only
// the URL of a move, and Dez's own page must load.
const MOVE_TO_DEZ = "a move to Dez's own page"

// The script of the page of a move: it does the move `config.move`, and
// reports `stayed` when its page is still there after it.
const MOVES_SCRIPT = `const target = config.server + '/hit/' + encodeURIComponent(config.move)
const link = (attributes, tag = 'a') => {
  const element = document.createElement(tag)
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value)
  document.body.append(element)
  element.click()
}
const form = (method, frame) => {
  const element = document.createElement('form')
  element.action = target
  element.method = method
  if (frame) element.target = frame
  document.body.append(element)
  element.submit()
}
const moves = {
${Object.entries({ ...MOVES, ...OWN_MOVES }).map(([name, code]) => `  ${JSON.stringify(name)}: () => { ${code} },`).join('\n')}
  ${JSON.stringify(MOVE_TO_DEZ)}: () => { location.href = 'tauri://localhost/index.html' },
}
report('started', location.pathname)
outcome(moves[config.move]).then((moved) => {
  report('moved', moved)
  setTimeout(() => report('stayed', location.pathname), 1500)
})
`

// The script of the page that posts to Tauri's IPC handler: each text of
// `config.posts`, in their order. Before them, with `config.fetchKey`, a
// `fetch` of Tauri's IPC scheme that would delete `config.fetchFile`.
const IPC_SCRIPT = `;(async () => {
  if (config.fetchKey) {
    report('fetch', await outcome(() => fetch('ipc://localhost/delete_app_file', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Tauri-Callback': '1', 'Tauri-Error': '2', 'Tauri-Invoke-Key': config.fetchKey },
      body: JSON.stringify({ root: 'app', path: config.fetchFile, folder: false }),
    }).then((response) => 'an answer')))
  }
  report('handler', typeof window.webkit.messageHandlers.ipc.postMessage)
  for (const text of config.posts) window.webkit.messageHandlers.ipc.postMessage(text)
  report('posted', config.posts.length)
})()
`

/** The message that Tauri's page script posts for the command that
 *  deletes the file `file` of the app root, with the invoke key `key`
 *  (none for `null`). */
function deleteMessage (file: string, key: string | null): string {
  return JSON.stringify({
    cmd: 'delete_app_file',
    callback: 1,
    error: 2,
    payload: { root: 'app', path: file, folder: false },
    ...(key === null ? {} : { __TAURI_INVOKE_KEY__: key }),
  })
}

describe('app frames audit', () => {
  let app: RunningApp
  let browser: E2EBrowser
  // The server that no page of an app must reach: each test leaves it
  // with no request and no connection.
  let server: CountingServer
  let secretDir: string
  let placesConfig: FrameConfig

  const assetUrl = (file: string): string => `asset://localhost/${encodeURIComponent(file)}`

  /** Opens the probe page of `appName` in a new frame, and gives the
   *  outcomes that it reports. */
  async function outcomesInFrame (appName: string, config: FrameConfig, options: { sandbox?: boolean } = {}): Promise<unknown> {
    const id = `${appName}-${options.sandbox === false ? 'open' : 'sandboxed'}`
    await openAppFrame(browser, id, appFrameUrl(appName, config), options)
    const outcomes = await frameReport(browser, id, 'outcomes')
    await closeAppFrame(browser, id)
    return outcomes
  }

  /** What Dez's own page gets for a request of the scheme: the status, the
   *  content type, and the text of the answer. */
  async function schemeAnswer (url: string, init: { method?: string, headers?: Record<string, string>, body?: string } = {}): Promise<string[]> {
    return browser.execute(async (target: string, options: RequestInit) => {
      try {
        const response = await fetch(target, options)
        return [String(response.status), response.headers.get('Content-Type') ?? '', await response.text()]
      } catch (error) {
        return [`threw ${(error as Error).name}`]
      }
    }, url, init)
  }

  /** Lets a request that is on its way arrive, then checks that the server
   *  of the audit got nothing. In the controls, a request is there within
   *  milliseconds. */
  async function expectNothingReachedTheServer (): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 1000))
    expect(server.requests).toEqual([])
    expect(server.connections()).toBe(0)
  }

  beforeAll(async () => {
    app = await startApp()
    try {
      await seedAppState(app.home)
      server = await startCountingServer()
      // The files of the computer that no page of an app must read.
      secretDir = path.join(app.home, 'private')
      const secret = {
        text: await writeTestFile(path.join(secretDir, 'secret.txt'), Buffer.from(PRIVATE)),
        script: await writeTestFile(path.join(secretDir, 'secret.js'), Buffer.from('window.assetScript = true\n')),
        image: await writeTestFile(path.join(secretDir, 'dot.svg'), Buffer.from(DOT_SVG)),
        page: await writeTestFile(path.join(secretDir, 'page.html'), Buffer.from(NEW_PAGE)),
      }
      placesConfig = {
        asset: { text: assetUrl(secret.text), script: assetUrl(secret.script), image: assetUrl(secret.image), page: assetUrl(secret.page) },
        imageFile: secret.image,
      }
      const appsDir = appFilePath(app.home, 'apps')
      const ui = (name: string) => ({ name, description: `The ${name} app of the audit`, kind: 'ui' as const })
      await seedApp(appsDir, ui('works'), {
        ...probePageFiles(probesScript(probesSource(OWN_WORK))),
        'data.json': OWN_DATA,
        'style.css': '#text { color: rgb(1, 2, 3); }\n',
        'dot.svg': DOT_SVG,
        'mod.js': "export { value } from './dep.js'\n",
        'dep.js': "export const value = 'the value of dep.js'\n",
      })
      await writeTestFile(path.join(appsDir, 'works', 'add.wasm'), ADD_WASM)
      // A link in the folder of an app, to a file and to a folder outside
      // it: the scheme must not follow one.
      fs.symlinkSync(secret.text, path.join(appsDir, 'works', 'link.txt'))
      fs.symlinkSync(secretDir, path.join(appsDir, 'works', 'linked'))
      await seedApp(appsDir, ui('libraries'), probePageFiles(probesScript(probesSource(LIBRARIES)), UI_IMPORT_MAP_TAG))
      await seedApp(appsDir, ui('sandbox'), probePageFiles(probesScript(probesSource(NO_PLACE))))
      await seedApp(appsDir, ui('network'), probePageFiles(probesScript(NETWORK_PROBES)))
      await seedApp(appsDir, ui('places'), probePageFiles(probesScript(probesSource(OTHER_PLACES))))
      await seedApp(appsDir, ui('policy'), { ...probePageFiles(probesScript(probesSource(POLICY_ONLY))), 'dot.svg': DOT_SVG })
      await seedApp(appsDir, ui('other'), {
        'secret.txt': PRIVATE,
        'secret.js': 'window.otherScript = true\n',
        'dot.svg': DOT_SVG,
        'style.css': '#text { color: rgb(4, 5, 6); }\n',
      })
      await seedApp(appsDir, ui('moves'), {
        ...probePageFiles(MOVES_SCRIPT),
        'second.html': '<!doctype html><meta charset="utf-8"><script>parent.postMessage({ probe: "second page", result: location.pathname }, "*")</script>\n',
      })
      await seedApp(appsDir, ui('ipc'), probePageFiles(IPC_SCRIPT))
      browser = await createSession(app.binary, app.port)
    } catch (err) {
      await server?.stop()
      await app.stop()
      throw err
    }
  })

  afterEach(async (ctx) => {
    await screenshotOnFailure(browser, ctx)
  })

  afterAll(async () => {
    await destroySession(browser)
    await server?.stop()
    await app?.stop()
  })

  it('lets the page of an app do its own work', async () => {
    expect(await outcomesInFrame('works', { svg: DOT_SVG, wasm: [...ADD_WASM] })).toEqual(frameOutcomes(OWN_WORK))
  })

  it('lets the page of an app import the libraries that Dez ships', async () => {
    expect(await outcomesInFrame('libraries', {})).toEqual(frameOutcomes(LIBRARIES))
  })

  it('gives the page of an app no place of its own and no reach into Dez', async () => {
    expect(await outcomesInFrame('sandbox', {})).toEqual(frameOutcomes(NO_PLACE))
    // The policy of the page sandboxes it too, with no help of the frame.
    expect(await outcomesInFrame('sandbox', {}, { sandbox: false })).toEqual(frameOutcomes(NO_PLACE))

    // Dez's page cannot read the page of an app either: no code of Dez can
    // take a value of an app for its own by mistake.
    await openAppFrame(browser, 'unread', appFrameUrl('sandbox'))
    await frameReport(browser, 'unread', 'outcomes')
    expect(await browser.execute(() => {
      const frame = document.querySelector<HTMLIFrameElement>('iframe[data-app-frame="unread"]')
      return frame === null ? 'no frame' : String(frame.contentDocument)
    })).toBe('null')
    await closeAppFrame(browser, 'unread')
  })

  it('lets no load of the page of an app reach a server', async () => {
    const config = { server: server.url, nameServer: server.nameUrl }
    const outcomes = await outcomesInFrame('network', config) as Record<string, string>
    // Each try ran to its end.
    expect(Object.keys(outcomes).sort()).toEqual(NETWORK_NAMES)
    await expectNothingReachedTheServer()

    // The content rule list by itself: the same tries in a blank frame of
    // Dez's page, which has no policy.
    const noPolicy = await runProbesInDez(browser, 'blank frame', NETWORK_PROBES, config)
    expect(Object.keys(noPolicy).sort()).toEqual(NETWORK_NAMES)
    await expectNothingReachedTheServer()

    // The control: from Dez's own page, the same tries reach a server of
    // the same kind. A connection with no request has no control: Dez
    // turns the link preconnect off for the whole webview.
    const control = await startCountingServer()
    try {
      await runProbesInDez(browser, 'page', NETWORK_PROBES, { server: control.url, nameServer: control.nameUrl })
      const reached = (name: string): boolean => control.requests.some((request) => request.endsWith(` /hit/${name}`))
      await waitForValue(browser, 'the tries that reached the control server', async () => REACHES_FROM_DEZ.filter(reached), REACHES_FROM_DEZ)
    } finally {
      await control.stop()
      // The `ping` try left a fragment in the URL of Dez's page.
      await browser.execute(() => history.replaceState(null, '', location.pathname))
    }
  })

  it('lets the page of an app read no file of the computer, of Dez, or of another app', async () => {
    expect(await outcomesInFrame('places', placesConfig)).toEqual(frameOutcomes(OTHER_PLACES))

    // The control: each place is there, and Dez's own page reads it.
    const controls = OTHER_PLACES.filter(([, , , control]) => control !== null)
    expect(await runProbesInDez(browser, 'page', probesSource(controls), placesConfig))
      .toEqual(Object.fromEntries(controls.map(([name, , , control]) => [name, control])))
    await expectNothingReachedTheServer()
  })

  it('refuses by the policy of a page each load that another guard stops too', async () => {
    expect(await outcomesInFrame('policy', { server: server.url })).toEqual(frameOutcomes(POLICY_ONLY))
    await expectNothingReachedTheServer()
  })

  it('keeps a frame in the scheme of the apps', async () => {
    const assetPage = (placesConfig.asset as { page: string }).page
    const config = (move: string): FrameConfig => ({ move, server: server.url, newPage: NEW_PAGE, assetPage })
    const names = [...Object.keys(MOVES), ...Object.keys(OWN_MOVES)]
    // Each move in a frame of its own, all at the same time.
    for (const [index, move] of names.entries()) await openAppFrame(browser, `move-${index}`, appFrameUrl('moves', config(move)))

    const reports: Record<string, string[]> = {}
    for (const [index, move] of names.entries()) {
      const id = `move-${index}`
      await frameReport(browser, id, move in MOVES ? 'stayed' : 'second page')
      reports[move] = (await frameReports(browser, id)).map(({ probe, result }) => `${probe}: ${String(result)}`)
    }
    // A move to a page of the app leaves the page.
    for (const move of Object.keys(OWN_MOVES)) expect(reports[move], move).toContain('second page: /moves/second.html')
    // Every other move leaves the frame on its page: the page is still
    // there, and no new page ran in the frame.
    for (const move of Object.keys(MOVES)) {
      expect(reports[move].filter((report) => !report.startsWith('moved: ')), move).toEqual(['started: /moves/index.html', 'stayed: /moves/index.html'])
    }
    for (const index of names.keys()) await closeAppFrame(browser, `move-${index}`)
    await expectNothingReachedTheServer()

    // The guard gets only the URL of a move, so a frame can go to Dez's
    // own page. The page that it gets there has no Tauri in it, and no
    // origin.
    await openAppFrame(browser, 'to-dez', appFrameUrl('moves', config(MOVE_TO_DEZ)))
    await waitForValue(browser, "the frame that went to Dez's own page", () => inAppFrame(browser, 'to-dez', () => browser.execute(() => ({
      url: location.href,
      origin: self.origin,
      tauri: typeof Reflect.get(window, '__TAURI_INTERNALS__'),
    }))), { url: 'tauri://localhost/index.html', origin: 'null', tauri: 'undefined' })
    await closeAppFrame(browser, 'to-dez')
  })

  it('runs no command for a post of a frame that has no invoke key', async () => {
    const canary = (name: string): string => appFilePath(app.home, name)
    const files = ['ipc-no-key.txt', 'ipc-wrong-key.txt', 'ipc-fetch.txt', 'ipc-real-key.txt']
    for (const file of files) await writeTestFile(canary(file), Buffer.from('still here\n'))

    await openAppFrame(browser, 'ipc', appFrameUrl('ipc', {
      posts: [deleteMessage('ipc-no-key.txt', null), deleteMessage('ipc-wrong-key.txt', 'wrong'), '{not JSON'],
    }))
    // A frame has the handler, so only the key keeps a command from it.
    expect(await frameReport(browser, 'ipc', 'handler')).toBe('function')
    expect(await frameReport(browser, 'ipc', 'posted')).toBe(3)

    // The control. The key goes with each IPC request of Dez's page; a
    // frame cannot read it, so the spec gives it to this frame. A `fetch`
    // of the IPC scheme stays shut by the policy also with the key. The
    // same post as above, now with the key, runs its command. It is the
    // last post, so its command also tells that the handler is through
    // with the posts before it.
    const key = await browser.execute(async () => {
      const realFetch = window.fetch
      let seen = ''
      window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
        seen = new Headers(init?.headers).get('Tauri-Invoke-Key') ?? seen
        return realFetch.call(window, input, init)
      }
      try {
        const sbp = Reflect.get(window, 'sbp') as (selector: string, ...args: unknown[]) => Promise<unknown>
        await sbp('dez.native/getAppDir')
      } finally {
        window.fetch = realFetch
      }
      return seen
    })
    expect(key).not.toBe('')
    await openAppFrame(browser, 'ipc-with-key', appFrameUrl('ipc', {
      fetchKey: key,
      fetchFile: 'ipc-fetch.txt',
      posts: [deleteMessage('ipc-real-key.txt', key)],
    }))
    expect(await frameReport(browser, 'ipc-with-key', 'fetch')).toBe('threw TypeError')
    await waitForValue(browser, 'the file of the post with the key', async () => fs.existsSync(canary('ipc-real-key.txt')), false)
    expect(files.filter((file) => fs.existsSync(canary(file)))).toEqual(['ipc-no-key.txt', 'ipc-wrong-key.txt', 'ipc-fetch.txt'])
    await closeAppFrame(browser, 'ipc')
    await closeAppFrame(browser, 'ipc-with-key')
  })

  it('serves only the files of an app, and only for a read', async () => {
    expect(await schemeAnswer('dezapp://localhost/works/data.json')).toEqual(['200', 'application/json', OWN_DATA])
    expect(await schemeAnswer('dezapp://localhost/works/index.html?a=1')).toEqual(['200', 'text/html; charset=utf-8', probePageFiles('')['index.html']])

    // A file that a model changed loads as it is now.
    await writeTestFile(appFilePath(app.home, 'apps', 'works', 'data.json'), Buffer.from('{"own":"new data"}'))
    expect(await schemeAnswer('dezapp://localhost/works/data.json')).toEqual(['200', 'application/json', '{"own":"new data"}'])

    // The test HOME has an app_state.json and the private files, so each
    // path below would give a file if the scheme went there.
    const refused = {
      'a file that is not there': 'dezapp://localhost/works/missing.txt',
      'a link to a file outside the app': 'dezapp://localhost/works/link.txt',
      'a file below a link to a folder': 'dezapp://localhost/works/linked/secret.txt',
      'the folder of an app': 'dezapp://localhost/works/',
      'the folder of an app with no slash': 'dezapp://localhost/works',
      'a file of the app root': 'dezapp://localhost/app_state.json',
      'a path that goes up': 'dezapp://localhost/works/../../app_state.json',
      'a path that goes up with escapes': 'dezapp://localhost/works/%2e%2e/%2e%2e/app_state.json',
      'a path that goes up with an escaped slash': 'dezapp://localhost/works/..%2f..%2fapp_state.json',
      'a path with an empty part': 'dezapp://localhost/works//data.json',
      'another host': 'dezapp://dez/works/data.json',
      'a port': 'dezapp://localhost:80/works/data.json',
    }
    for (const [name, url] of Object.entries(refused)) {
      // The answer tells no path and no reason: a page of an app can read it.
      expect(await schemeAnswer(url), name).toEqual(['404', 'text/plain; charset=utf-8', NO_SUCH_FILE])
    }
    expect(await schemeAnswer('dezapp://localhost/works/data.json', { method: 'POST', body: 'data' }))
      .toEqual(['405', 'text/plain; charset=utf-8', 'The files of an app can only be read.'])
    expect(await schemeAnswer('dezapp://localhost/works/data.json', { headers: { Range: 'bytes=2-4' } })).toEqual(['206', 'application/json', 'own'])
  })

  it('serves the shipped libraries in the folder of each app, and only for a read', async () => {
    const library = 'fft.js/lib/fft.esm.js'
    const shipped = fs.readFileSync(new URL(`../../src-tauri/libs/${library}`, import.meta.url), 'utf8')
    expect(await schemeAnswer(`dezapp://localhost/works/~libs/${library}`)).toEqual(['200', 'text/javascript; charset=utf-8', shipped])

    // The resource folder of the debug build has the fonts next to the
    // libraries, so a path that goes up from them would give a file.
    const refused = {
      'the route with no file': 'dezapp://localhost/works/~libs',
      'the folder of the libraries': 'dezapp://localhost/works/~libs/',
      'the folder of a library': 'dezapp://localhost/works/~libs/three',
      'a file that is not there': 'dezapp://localhost/works/~libs/fft.js/none.js',
      'a path that goes up with escapes': 'dezapp://localhost/works/~libs/%2e%2e/fonts/manifest.json',
      'a path that goes up with an escaped slash': 'dezapp://localhost/works/~libs/..%2ffonts%2fmanifest.json',
      'a path with an empty part': `dezapp://localhost/works/~libs//${library}`,
      'the route below the folder of an app': `dezapp://localhost/works/js/~libs/${library}`,
      'the route with no app': `dezapp://localhost/~libs/${library}`,
      'the route in capitals': `dezapp://localhost/works/~LIBS/${library}`,
    }
    for (const [name, url] of Object.entries(refused)) {
      expect(await schemeAnswer(url), name).toEqual(['404', 'text/plain; charset=utf-8', NO_SUCH_FILE])
    }
    expect(await schemeAnswer(`dezapp://localhost/works/~libs/${library}`, { method: 'POST', body: 'data' }))
      .toEqual(['405', 'text/plain; charset=utf-8', 'The files of an app can only be read.'])
  })

  it("leaves Dez's own page as it was", async () => {
    // No window that is not the window of a frame of the spec posted a
    // report: no page ran in a frame of a frame.
    expect(await frameReports(browser, null)).toEqual([])
    expect(await browser.execute(() => ({
      page: `${location.protocol}//${location.host}${location.pathname}`,
      tabBar: document.querySelector('header.tab-bar') !== null,
      frames: document.querySelectorAll('iframe').length,
    }))).toEqual({ page: 'tauri://localhost/', tabBar: true, frames: 0 })
  })
})
