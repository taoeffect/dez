import * as z from 'zod'

// The manifest of an app: the file `manifest.json` in the folder of the app
// (`apps/<name>/` of the app root), which tells what the app is. `apps
// init` writes it (appsTool.ts). After that a model, the code of an app, or
// the user can write any text into it, so every reader takes it through
// `parseAppManifest`.
//
// The folder name is what names an app, in every call and every list. The
// `name` of the manifest is the name that the app had when it was made.

/** What an app is: code that runs with no page (`script`), or a web page
 *  (`ui`). */
export const APP_KINDS = ['script', 'ui'] as const
export type AppKind = typeof APP_KINDS[number]

export const MANIFEST_FILE = 'manifest.json'

/** Dez reads no manifest that is larger: a good one is a few lines. */
export const MANIFEST_MAX_BYTES = 16 * 1024

/** The most characters of the description that `apps init` takes. */
export const MAX_DESCRIPTION_LENGTH = 200

const manifestSchema = z.object({
  name: z.string(),
  description: z.string(),
  kind: z.enum(APP_KINDS),
})

export type AppManifest = z.infer<typeof manifestSchema>

/** The text of the manifest file of an app. */
export function appManifestText({ name, description, kind }: AppManifest): string {
  return `${JSON.stringify({ name, description, kind }, null, 2)}\n`
}

/** The manifest that the text of a manifest file holds; null for a text
 *  that is no JSON, or that lacks a field or has one of a wrong type. More
 *  fields than Dez knows are no error: they are left out. */
export function parseAppManifest(text: string): AppManifest | null {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  const parsed = manifestSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}
