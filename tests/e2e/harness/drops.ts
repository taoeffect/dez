import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect } from 'vitest'
import type { Point } from './dom'
import { appFilePath, writeTestFile } from './fixtures'
import { STRIPES_PNG } from './images'
import { clipTag, WEBM_VIDEO } from './media'
import type { MockProviderApp } from './mockProviderApp'
import type { HeldRequest, MockProvider } from './mockServer'
import type { E2EBrowser } from './session'
import { openSeededConversation, pickModel } from './thread'

const linkedDropsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../artifacts/linked-drops')

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
 *  The asset-protocol scope has every file (src-tauri/tauri.conf.json), so
 *  the app reads a dropped file at any path. The app's home is in the temp
 *  folder (app.ts), so the app copies a file from there, and links a file
 *  from any other folder (src/model/chat/linkedFiles.ts). */
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

/** A new, empty folder `name` for the files of a drop that the app links
 *  in place (src/model/chat/linkedFiles.ts). It is in the gitignored
 *  tests/e2e/artifacts/, so it is out of every temp folder (the app's home
 *  is in one: app.ts) while the repository is. The spec removes it in
 *  `afterAll`. */
export async function linkedDropDir (name: string): Promise<string> {
  const dir = path.join(linkedDropsDir, name)
  await fs.promises.rm(dir, { recursive: true, force: true })
  await fs.promises.mkdir(dir, { recursive: true })
  return dir
}

// A word of the name of each linked file of `openDroppedFiles`. No code of
// a spec holds one, so a request holds one only when the app sent the name
// of a file.
const LINKED_IMAGE_WORD = 'holiday'
const LINKED_CLIP_WORD = 'beach'

/** Opens the conversation `name` with files that the user dropped, all in
 *  its one user section, picks the model of `provider`, and gives the path
 *  of each file by its id. The next new id of the conversation is `d`.
 *  - `@a`: `STRIPES_PNG` as an image that Dez copied (a stored file);
 *  - `@b`: the same image as a file that the user linked, in `linkedDir`
 *    (`linkedDropDir`);
 *  - `@c`: `WEBM_VIDEO` as a file that the user linked. */
export async function openDroppedFiles (setup: MockProviderApp, provider: MockProvider, linkedDir: string, name: string): Promise<Record<'a' | 'b' | 'c', string>> {
  const { home } = setup.app
  const a = await writeTestFile(appFilePath(home, 'assets', 'images', `${name}-a.png`), STRIPES_PNG)
  const b = await writeTestFile(path.join(linkedDir, `${name}-${LINKED_IMAGE_WORD}.png`), STRIPES_PNG)
  const c = await writeTestFile(path.join(linkedDir, `${name}-${LINKED_CLIP_WORD}.webm`), WEBM_VIDEO)
  await openSeededConversation(setup.browser, home, name, [{
    role: 'user',
    text: [`![id=a](${a})`, `![id=b](${b})`, clipTag('video', { id: 'c', type: 'video/webm', src: c }), 'Here are my files.'].join('\n'),
  }])
  await pickModel(setup.browser, provider.name, provider.modelName)
  return { a, b, c }
}

/** Checks that no body of `requests` names a linked file of
 *  `openDroppedFiles`: not its folder `linkedDir`, and not its name. */
export function expectNoLinkedFile (requests: readonly HeldRequest[], linkedDir: string): void {
  for (const { body } of requests) {
    expect(body).not.toContain(linkedDir)
    expect(body).not.toContain(LINKED_IMAGE_WORD)
    expect(body).not.toContain(LINKED_CLIP_WORD)
  }
}
