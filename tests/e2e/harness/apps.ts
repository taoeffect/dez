import path from 'node:path'
import { appManifestText, MANIFEST_FILE, type AppManifest } from '../../../src/model/tools/appManifest'
import { writeTestFile } from './fixtures'
import { openAiToolCall } from './mockServer'
import type { E2EBrowser } from './session'

// What the specs of the `apps` tool share (apps-tool.e2e.ts, the file
// subcommands; apps-invoke.e2e.ts, the runs of a script app).

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

/** One app card of the editor: the app that it names, and its text. */
export interface ShownAppCard {
  app: string | null
  text: string
}

/** The app cards that the active editor shows, in doc order. */
export async function shownAppCards (browser: E2EBrowser): Promise<ShownAppCard[]> {
  return browser.execute(() => Array.from(document.querySelectorAll<HTMLElement>('.cm-content .dez-app'), (card) => ({
    app: card.getAttribute('data-app'),
    // The parts of a card are inline boxes with no text between them.
    text: Array.from(card.querySelectorAll('.dez-app__label, .dez-app__name'), (part) => part.textContent ?? '').join(' '),
  })))
}
