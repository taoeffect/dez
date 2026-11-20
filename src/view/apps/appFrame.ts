import { z } from 'zod'
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

/** A message of the page of an app:
 *  - `escape`: the user pressed Escape, and the page did not take the key
 *    for itself.
 *  - `menu`: a context click that the page did not take for itself, at a
 *    place where the menu of the webview has no use (no text field, no
 *    selected text). */
const frameMessageSchema = z.discriminatedUnion('dez', [
  z.object({ dez: z.literal('escape') }),
  z.object({ dez: z.literal('menu') }),
])

export type AppFrameMessage = z.infer<typeof frameMessageSchema>

/** A message of Dez for the page of an app:
 *  - `edit`: run this edit command where the focus is in the page. */
export type AppFrameCommand = { dez: 'edit', command: 'insertLineBreak' | 'undo' | 'redo' | 'selectAll' }

/** What the owner of a frame does for it. */
export interface AppFrameOwner {
  /** A message of the page, which can hold anything: it is checked. */
  onMessage (message: AppFrameMessage): void
  /** The frame loaded a second time: close it. */
  onNavigated (): void
}

const owners = new Map<HTMLIFrameElement, AppFrameOwner>()

// The one message listener of Dez's page for all the open frames. A
// message of any other window, and one that the schema does not know, is
// dropped.
function onWindowMessage(event: MessageEvent): void {
  if (!event.source) return
  for (const [frame, owner] of owners) {
    if (frame.contentWindow !== event.source) continue
    const message = frameMessageSchema.safeParse(event.data)
    if (message.success) owner.onMessage(message.data)
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
  frame.src = `dezapp://localhost/${name}/${UI_INDEX_FILE}`
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
