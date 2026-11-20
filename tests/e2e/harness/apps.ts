import path from 'node:path'
import { appManifestText, MANIFEST_FILE, type AppManifest } from '../../../src/model/tools/appManifest'
import { inFrame } from './appFrames'
import { elementCenter, type Point } from './dom'
import { writeTestFile } from './fixtures'
import { openAiToolCall } from './mockServer'
import type { E2EBrowser } from './session'

// What the specs of the apps share: the calls of the `apps` tool
// (apps-tool.e2e.ts, the file subcommands; apps-invoke.e2e.ts, the runs of
// a script app), and the cards and the frames of the apps that the editor
// shows (app-host.e2e.ts).

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
}

/** The frame hosts of the active editor, read two frames after the last
 *  change, so that the layout work of that change is done. */
export async function shownAppFrames (browser: E2EBrowser): Promise<ShownAppFrame[]> {
  return browser.execute(() => new Promise<ShownAppFrame[]>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      resolve(Array.from(document.querySelectorAll<HTMLElement>('.cm-scroller > .dez-app-frame'), (host) => {
        const place = document.querySelector(`.cm-content [data-app-frame-place="${host.dataset.run}"]`)?.getBoundingClientRect()
        const at = host.getBoundingClientRect()
        return {
          app: host.dataset.app ?? null,
          run: host.dataset.run ?? null,
          top: Math.round(at.top),
          offPlace: place ? Math.max(...(['left', 'top', 'right', 'bottom'] as const).map((edge) => Math.abs(at[edge] - place[edge]))) : null,
        }
      }))
    }))
  }))
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
