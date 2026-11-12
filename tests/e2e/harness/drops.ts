import type { Point } from './dom'
import type { E2EBrowser } from './session'

/** A file for `dropFiles`. */
export interface DroppedFile {
  name: string
  type: string
  base64: string
}

/** Drags `files` over `point` and drops them there, on the element at that
 *  point, as an HTML5 drop (macOS) gives them. Returns whether a handler
 *  canceled each event: a canceled dragover accepts the drag, and a
 *  canceled drop keeps the webview from opening the file. */
export async function dropFiles (browser: E2EBrowser, point: Point, files: DroppedFile[]): Promise<{ dragover: boolean, drop: boolean }> {
  return browser.execute((at: Point, dropped: DroppedFile[]) => {
    const target = document.elementFromPoint(at.x, at.y)
    if (!target) throw new Error(`dropFiles: nothing at ${at.x}, ${at.y}`)
    const data = new DataTransfer()
    for (const file of dropped) {
      data.items.add(new File([Uint8Array.from(atob(file.base64), (char) => char.charCodeAt(0))], file.name, { type: file.type }))
    }
    const send = (type: 'dragover' | 'drop'): boolean => {
      const event = new DragEvent(type, { dataTransfer: data, clientX: at.x, clientY: at.y, bubbles: true, cancelable: true })
      target.dispatchEvent(event)
      return event.defaultPrevented
    }
    return { dragover: send('dragover'), drop: send('drop') }
  }, point, files)
}

/** Sends the drop event of Tauri's native file drop to the page, as wry
 *  sends it when a file manager drops `paths` at `point` (CSS px). The
 *  native drop is on only on Linux (src-tauri/tauri.linux.conf.json), and
 *  WebDriver cannot drive an OS drag, so the page emits the event itself.
 *  Unlike a real drop, this event adds no path to the asset-protocol
 *  scope: a dropped file must be in a folder of stored files (images,
 *  pasted clips), which are always in the scope. */
export async function nativeDrop (browser: E2EBrowser, point: Point, paths: string[]): Promise<void> {
  await browser.execute(async (at: Point, dropped: string[]) => {
    const internals = Reflect.get(window, '__TAURI_INTERNALS__') as { invoke: (command: string, args: unknown) => Promise<unknown> }
    await internals.invoke('plugin:event|emit_to', {
      target: { kind: 'Webview', label: 'main' },
      event: 'tauri://drag-drop',
      payload: { paths: dropped, position: at },
    })
  }, point, paths)
}
