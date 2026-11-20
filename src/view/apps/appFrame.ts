import { z } from 'zod'
import { APP_CALL_FAILED_TEXT, APP_FRAME_ROOT_URL, APP_SELECTOR_MAX_CHARS, appCall, AppCallError, type AppCall } from '../../model/tools/appBridge'
import { UI_INDEX_FILE } from '../../model/tools/appTemplates'

// One frame of an app: the `<iframe>` of Dez's page that shows the page of
// a UI app. The page is the work of a model, so each frame follows the
// rules that keep it apart from Dez (the guards of the webview are in
// src-tauri/src/app_frames.rs):
//
// - It loads only from the scheme of the app frames, never from the asset
//   protocol, with `sandbox="allow-scripts"` and never `allow-same-origin`.
// - It shows one page. The navigation guard of the webview cannot tell
//   where a frame goes (the page of another app, a blank page), so a frame
//   that loads a second time may not show the app that the user started:
//   the owner of the frame closes it (`onNavigated`).
// - An `<iframe>` that moves in the DOM loads again. So the owner puts the
//   frame into the page once, and never moves it.
//
// The page and Dez talk with `postMessage`. The half of the page is Dez's
// client script (src-tauri/src/app_client.js): change the two together.
// Each message is an object whose `dez` field is its type. The page has no
// origin (the sandbox), so Dez finds the frame of a message by its `source`
// only, and posts with the target `*`.
//
// Each side can call the other (the frame bridge, model/tools/appBridge.ts):
// a `call` message has an id, and its `answer` message has the same id.
// This module answers each call of a page (`answerCall`); the owner of the
// frame does the work of the call.

/** A message of the page of an app, which can hold anything: Dez drops
 *  one that this schema does not know.
 *  - `ready`: Dez's client script runs in the page.
 *  - `escape`: the user pressed Escape, and the page did not take the key
 *    for itself.
 *  - `menu`: a context click that the page did not take for itself, at a
 *    place where the menu of the webview has no use (no text field, no
 *    selected text).
 *  - `call`: the code of the page calls Dez (`dez.sbp`).
 *  - `answer`: the end of a call of Dez (`AppFrameCommand`): the text of
 *    the value that the handler of the page returned (none for no value),
 *    the text of what it threw, or `noHandler` for a page that registered
 *    no handler for the call. `log` is the console output of the page
 *    since its last answer. The texts have no size limit here: the client
 *    script cuts the log, and each reader cuts what it shows. A dropped
 *    answer would leave the call with no end. */
const frameMessageSchema = z.discriminatedUnion('dez', [
  z.object({ dez: z.literal('ready') }),
  z.object({ dez: z.literal('escape') }),
  z.object({ dez: z.literal('menu') }),
  z.object({ dez: z.literal('call'), id: z.number(), selector: z.string().max(APP_SELECTOR_MAX_CHARS), args: z.array(z.unknown()) }),
  z.object({
    dez: z.literal('answer'),
    id: z.number(),
    ok: z.boolean(),
    value: z.string().optional(),
    error: z.string().optional(),
    noHandler: z.boolean().optional(),
    log: z.string(),
  }),
])

type FrameMessage = z.infer<typeof frameMessageSchema>
type PageCall = Extract<FrameMessage, { dez: 'call' }>

/** A message of the page that the owner of its frame gets. */
export type AppFrameMessage = Exclude<FrameMessage, PageCall>

/** A message of Dez for the page of an app:
 *  - `edit`: run this edit command where the focus is in the page.
 *  - `call`: run the handler that the page registered for `selector`. The
 *    page ends the call with an `answer` message that has its `id`. */
export type AppFrameCommand =
  | { dez: 'edit', command: 'insertLineBreak' | 'undo' | 'redo' | 'selectAll' }
  | { dez: 'call', id: number, selector: string, args: readonly unknown[] }

/** What the owner of a frame does for it. */
export interface AppFrameOwner {
  /** A checked message of the page. */
  onMessage (message: AppFrameMessage): void
  /** Does a checked call of the page, and gives the value for its answer.
   *  An `AppCallError` tells the page why Dez refuses the call. */
  onCall (call: AppCall): Promise<unknown>
  /** The frame loaded a second time: close it. */
  onNavigated (): void
}

const owners = new Map<HTMLIFrameElement, AppFrameOwner>()

// Does the call `call` of the page of `frame`, and posts its answer. The
// page gets the text of an `AppCallError` as it is. Any other error is a
// fault of Dez: its text can hold a path, so the page gets a fixed text.
// The frame can close while the call runs: then no page waits for the
// answer.
async function answerCall(frame: HTMLIFrameElement, owner: AppFrameOwner, { id, selector, args }: PageCall): Promise<void> {
  let answer: { ok: true, value: unknown } | { ok: false, error: string }
  try {
    answer = { ok: true, value: await owner.onCall(appCall(selector, args)) }
  } catch (error) {
    if (!(error instanceof AppCallError)) console.error(`The call ${selector} of an app failed:`, error)
    answer = { ok: false, error: error instanceof AppCallError ? error.message : APP_CALL_FAILED_TEXT }
  }
  frame.contentWindow?.postMessage({ dez: 'answer', id, ...answer }, '*')
}

// The one message listener of Dez's page for all the open frames. A
// message of any other window, and one that the schema does not know, is
// dropped.
function onWindowMessage(event: MessageEvent): void {
  if (!event.source) return
  for (const [frame, owner] of owners) {
    if (frame.contentWindow !== event.source) continue
    const message = frameMessageSchema.safeParse(event.data)
    if (!message.success) return
    if (message.data.dez === 'call') void answerCall(frame, owner, message.data)
    else owner.onMessage(message.data)
    return
  }
}

/** A new frame for the page of the app `name`. It starts to load when the
 *  caller puts it into the page. Close it with `closeAppFrame`. */
export function openAppFrame(name: string, owner: AppFrameOwner): HTMLIFrameElement {
  const frame = document.createElement('iframe')
  frame.setAttribute('sandbox', 'allow-scripts')
  frame.title = `The app ${name}`
  // Before the frame is in the page, so that it loads nothing else first.
  frame.src = `${APP_FRAME_ROOT_URL}${name}/${UI_INDEX_FILE}`
  let loads = 0
  frame.addEventListener('load', () => {
    loads += 1
    if (loads > 1 && owners.has(frame)) owner.onNavigated()
  })
  if (owners.size === 0) window.addEventListener('message', onWindowMessage)
  owners.set(frame, owner)
  return frame
}

/** Takes `frame` out of the page, which ends the code of its app. */
export function closeAppFrame(frame: HTMLIFrameElement): void {
  frame.remove()
  if (owners.delete(frame) && owners.size === 0) window.removeEventListener('message', onWindowMessage)
}

/** Sends `command` to the page of `frame`. A page without Dez's client
 *  script does nothing with it. */
export function postToAppFrame(frame: HTMLIFrameElement, command: AppFrameCommand): void {
  frame.contentWindow?.postMessage(command, '*')
}
