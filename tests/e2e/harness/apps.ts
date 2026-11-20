import fs from 'node:fs'
import path from 'node:path'
import { appManifestText, MANIFEST_FILE, type AppManifest } from '../../../src/model/tools/appManifest'
import { appSizeText } from '../../../src/model/tools/appsTool'
import { inFrame } from './appFrames'
import { elementCenter, type Point } from './dom'
import { writeTestFile } from './fixtures'
import { openAiToolCall } from './mockServer'
import type { E2EBrowser } from './session'

// What the specs of the apps share: the calls of the `apps` tool
// (apps-tool.e2e.ts, the file subcommands; apps-invoke.e2e.ts, the runs of
// a script app and of a UI app), and the cards and the frames of the apps
// that the editor shows (app-host.e2e.ts).

/** An `apps` call of the mock model: the subcommand `command` with
 *  `parameters`, in the form of a subcommand tool. */
export function appsCall (id: string, command: string, parameters: Record<string, unknown> = {}): Record<string, unknown> {
  return openAiToolCall(id, 'apps', { command, parameters: JSON.stringify(parameters) })
}

/** Writes an app into `appsDir`, the folder of the apps of a test HOME, as
 *  `init` and `write` calls leave one: its manifest, and each of `files`,
 *  the text of a file by its path in the folder of the app. */
export async function seedApp (appsDir: string, manifest: AppManifest, files: Readonly<Record<string, string>> = {}): Promise<void> {
  const folder = path.join(appsDir, manifest.name)
  await writeTestFile(path.join(folder, MANIFEST_FILE), Buffer.from(appManifestText(manifest)))
  for (const [name, text] of Object.entries(files)) await writeTestFile(path.join(folder, name), Buffer.from(text))
}

/** Gives the folder of the app `name` of `appsDir`, and each file and
 *  folder in it, a file time of `ageMs` ago: Delete Unused Files takes an
 *  app only when all of them are old. */
export async function ageApp (appsDir: string, name: string, ageMs: number): Promise<void> {
  const folder = path.join(appsDir, name)
  const time = new Date(Date.now() - ageMs)
  for (const entry of await fs.promises.readdir(folder, { recursive: true, withFileTypes: true })) {
    await fs.promises.utimes(path.join(entry.parentPath, entry.name), time, time)
  }
  await fs.promises.utimes(folder, time, time)
}

/** The files of a UI app for `seedApp`: a page with the elements `body`
 *  that loads Dez's client script, then `script` as `main.js`, as the page
 *  that `init` makes does. */
export function uiAppFiles (script: string, body = ''): Record<string, string> {
  return {
    'index.html': [
      '<!doctype html>',
      '<html><head><meta charset="utf-8"><title>app</title></head>',
      '<body>',
      body,
      '<script src="~dez.js"></script>',
      '<script src="main.js" crossorigin></script>',
      '</body></html>',
      '',
    ].join('\n'),
    'main.js': script,
  }
}

/** The files of a UI app for `seedApp` whose page goes to the page of the
 *  app `to` while it loads, before any other script of it runs. The
 *  webview gives the frame of such a page only one load, that of the page
 *  of `to`. */
export function movingAppFiles (to: string): Record<string, string> {
  return {
    'index.html': [
      '<!doctype html>',
      `<script>location.href = "../${to}/index.html"</script>`,
      '<script src="~dez.js"></script>',
      '',
    ].join('\n'),
  }
}

/** How many frames Dez's page has: one for each app that runs in the
 *  editor, and one for each run of a UI app that goes on (`apps invoke`),
 *  which the user does not see. */
export async function pageFrameCount (browser: E2EBrowser): Promise<number> {
  return browser.execute(() => document.querySelectorAll('iframe').length)
}

/** The frames of Dez's page, each with the two attributes that keep the
 *  page of an app apart from Dez: its sandbox, and the URL that it loads.
 *  The audit of the guards (app-frames.e2e.ts) makes its frames itself, so
 *  a spec of the real frames reads them here. */
export async function pageFrameGuards (browser: E2EBrowser): Promise<Array<{ sandbox: string | null, src: string | null }>> {
  return browser.execute(() => Array.from(document.querySelectorAll('iframe'), (frame) => ({ sandbox: frame.getAttribute('sandbox'), src: frame.getAttribute('src') })))
}

/** The size of the folder of the app `name` of `appsDir`, as Dez tells
 *  it: the bytes of all its files. */
export async function appFolderSize (appsDir: string, name: string): Promise<string> {
  const folder = path.join(appsDir, name)
  let bytes = 0
  for (const entry of await fs.promises.readdir(folder, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) bytes += (await fs.promises.stat(path.join(entry.parentPath, entry.name))).size
  }
  return appSizeText({ bytes, more: false })
}

/** One app card of the editor. */
export interface ShownAppCard {
  /** The app that the card names. */
  app: string | null
  /** What the card is: a poster with Run (`run`), a poster that tells why
   *  Dez cannot start the app (`note`), a poster of an app whose files Dez
   *  reads for the first time (`reading`), or the empty placeholder of an
   *  app that runs (`running`). */
  state: 'run' | 'note' | 'reading' | 'running'
  /** The texts of the poster, one part per line: the name, then the
   *  description or the note. */
  text: string
}

/** The app cards that the active editor shows, in doc order. */
export async function shownAppCards (browser: E2EBrowser): Promise<ShownAppCard[]> {
  return browser.execute(() => Array.from(document.querySelectorAll<HTMLElement>('.cm-content .dez-app'), (card): ShownAppCard => ({
    app: card.getAttribute('data-app'),
    state: card.querySelector('[data-app-frame-place]')
      ? 'running'
      : card.querySelector('.dez-app__run') ? 'run' : card.querySelector('.dez-app__note') ? 'note' : 'reading',
    text: Array.from(card.querySelectorAll('.dez-app__name, .dez-app__description, .dez-app__note'), (part) => part.textContent ?? '').join('\n'),
  })))
}

/** The tools in the corner of one poster. */
export interface ShownAppCorner {
  app: string | null
  /** The size of the folder of the app; null when the corner tells none. */
  size: string | null
  /** The tooltip of the trash. */
  trash: string | null
}

/** The corner tools of the posters that the active editor shows, in doc
 *  order. A card of an app that runs has none. */
export async function shownAppCorners (browser: E2EBrowser): Promise<ShownAppCorner[]> {
  return browser.execute(() => Array.from(document.querySelectorAll<HTMLElement>('.cm-content .dez-app .dez-app__tools'), (tools): ShownAppCorner => ({
    app: tools.closest('.dez-app')?.getAttribute('data-app') ?? null,
    size: tools.querySelector('.dez-app__size')?.textContent ?? null,
    trash: tools.querySelector('.dez-app__trash')?.getAttribute('title') ?? null,
  })))
}

/** The frame host of one app that runs in the editor. */
export interface ShownAppFrame {
  app: string | null
  /** The id of the run: a new one for each start. */
  run: string | null
  /** The top of the host in the viewport, in whole px. */
  top: number
  /** How far the host is from the placeholder of its run, in px: the
   *  largest distance of two edges. Null when the editor does not draw the
   *  placeholder (it is far out of view). */
  offPlace: number | null
  /** The size that the host shows in: over its card (`card`), over the
   *  conversation view (`expanded`), or over the screen (`fullscreen`). */
  view: 'card' | 'expanded' | 'fullscreen'
  /** How far the host is from the box that it must cover, in px, as
   *  `offPlace` tells it: the box of the scroller for `expanded`, the
   *  window for `fullscreen`. Null for `card`. */
  offCover: number | null
}

/** The frame hosts of the active editor, read two frames after the last
 *  change, so that the layout work of that change is done. */
export async function shownAppFrames (browser: E2EBrowser): Promise<ShownAppFrame[]> {
  return browser.execute(() => new Promise<ShownAppFrame[]>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const EDGES = ['left', 'top', 'right', 'bottom'] as const
      const windowBox = { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight }
      resolve(Array.from(document.querySelectorAll<HTMLElement>('.cm-scroller > .dez-app-frame'), (host) => {
        const place = document.querySelector(`.cm-content [data-app-frame-place="${host.dataset.run}"]`)?.getBoundingClientRect()
        const at = host.getBoundingClientRect()
        const off = (box: Record<typeof EDGES[number], number>): number => Math.max(...EDGES.map((edge) => Math.abs(at[edge] - box[edge])))
        const view = document.fullscreenElement === host ? 'fullscreen' : host.hasAttribute('data-expanded') ? 'expanded' : 'card'
        const scroller = host.parentElement?.getBoundingClientRect()
        return {
          app: host.dataset.app ?? null,
          run: host.dataset.run ?? null,
          top: Math.round(at.top),
          offPlace: place ? off(place) : null,
          view,
          offCover: view === 'fullscreen' ? off(windowBox) : view === 'expanded' && scroller ? off(scroller) : null,
        }
      }))
    }))
  }))
}

/** The bar of the frame host of one app that runs. */
export interface ShownAppBar {
  app: string | null
  /** The texts of the bar, one part per line: the name of the app, then
   *  the size of its folder. */
  text: string
  /** The tooltip of each button of the bar, in order. */
  buttons: string[]
}

/** The bars of the frame hosts of the active editor. */
export async function shownAppBars (browser: E2EBrowser): Promise<ShownAppBar[]> {
  return browser.execute(() => Array.from(document.querySelectorAll<HTMLElement>('.cm-scroller > .dez-app-frame'), (host): ShownAppBar => ({
    app: host.dataset.app ?? null,
    text: Array.from(host.querySelectorAll('.dez-app-frame__name, .dez-app-frame__size'), (part) => part.textContent ?? '').join('\n'),
    buttons: Array.from(host.querySelectorAll('.dez-app-frame__bar button'), (button) => button.getAttribute('title') ?? ''),
  })))
}

/** Waits until the app `app` that runs fills the screen (`on`), or until
 *  nothing does. The page is ready for a click only when the layout is at
 *  rest: the fullscreen button of the bar has its new state (the host sets
 *  it at `fullscreenchange`), and two reads of the window size agree,
 *  because the window gets its new size in steps. */
export async function waitForAppFullscreen (browser: E2EBrowser, app: string, on: boolean): Promise<void> {
  let state: { host: boolean, button: boolean, size: string } | undefined
  let sizeBefore = ''
  try {
    await browser.waitUntil(async () => {
      state = await browser.execute((name: string) => ({
        host: document.fullscreenElement?.matches(`.cm-scroller > .dez-app-frame[data-app="${name}"]`) ?? false,
        button: document.querySelector(`.cm-scroller > .dez-app-frame[data-app="${name}"][data-fullscreen]`) !== null,
        size: `${window.innerWidth}x${window.innerHeight}`,
      }), app)
      const atRest = state.host === on && state.button === on && state.size === sizeBefore
      sizeBefore = state.size
      return atRest
    }, { timeout: 10_000, interval: 150 })
  } catch (err) {
    throw new Error(`app fullscreen: expected ${on}, got ${JSON.stringify(state)}`, { cause: err })
  }
}

// The frame of the app `app` that runs in the active editor (the first one,
// when more than one card of the app runs).
function runningAppFrame (app: string): string {
  return `.cm-scroller > .dez-app-frame[data-app="${app}"] iframe`
}

/** Runs `work` in the page of the app `app` that runs in the active editor
 *  (`inFrame`). */
export function inRunningApp<T> (browser: E2EBrowser, app: string, work: () => Promise<T>): Promise<T> {
  return inFrame(browser, runningAppFrame(app), work)
}

/** The center of the element `selector` of the page of the app `app` that
 *  runs, as a point of Dez's page: pointer actions do not work in the page
 *  of a frame, so a spec clicks there with `pointerClickAt`. */
export async function runningAppPoint (browser: E2EBrowser, app: string, selector: string): Promise<Point> {
  // The frame has no border, so its page starts at its corner.
  const corner = await browser.execute((frame: string) => {
    const rect = document.querySelector(frame)?.getBoundingClientRect()
    if (!rect) throw new Error(`runningAppPoint: no frame ${frame}`)
    return { x: rect.left, y: rect.top }
  }, runningAppFrame(app))
  const inPage = await inRunningApp(browser, app, () => elementCenter(browser, selector))
  return { x: Math.round(corner.x + inPage.x), y: Math.round(corner.y + inPage.y) }
}
