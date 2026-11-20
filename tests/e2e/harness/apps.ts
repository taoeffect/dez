import path from 'node:path'
import { appManifestText, MANIFEST_FILE, type AppManifest } from '../../../src/model/tools/appManifest'
import { writeTestFile } from './fixtures'
import { openAiToolCall } from './mockServer'

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
