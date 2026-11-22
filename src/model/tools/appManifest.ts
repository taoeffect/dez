import * as z from 'zod'

// The manifest of an app: the file `manifest.json` in the folder of the app
// (`apps/<name>/` of the app root), which tells what the app is. `apps
// init` writes it (appsTool.ts). After that a model, the code of an app, or
// the user can write any text into it, so every reader takes it through
// `parseAppManifest`.
//
// The folder name is what names an app, in every call and every list. The
// `name` of the manifest is the name that the app had when it was made.

/** Regex source of the name of an app: 1 to 64 characters, each a
 *  lower-case letter, a digit, `-`, or `_`, and the first one a letter or a
 *  digit. So a name is safe as it is in a path, in a URL, in HTML, and in
 *  an attribute of a tag (`<dez:app>`, chat/appTags.ts). */
export const APP_NAME_SOURCE = '[a-z0-9][a-z0-9_-]{0,63}'

const APP_NAME = new RegExp(`^${APP_NAME_SOURCE}$`)

/** Whether `name` can name an app, which is the name of its folder. */
export function isAppName(name: string): boolean {
  return APP_NAME.test(name)
}

/** The start of the name of every built-in app of Dez. */
export const BUILT_IN_APP_PREFIX = 'dez-'

/** Whether `name` is the name of a built-in app of Dez: the apps that Dez
 *  ships, read only, in its resource folder (`builtin-apps/`). The prefix
 *  is reserved, so no app of the user can have such a name, and a path of
 *  `/apps/` goes to the bundle by its name alone (`pathOf`, appsTool.ts). */
export function isBuiltInApp(name: string): boolean {
  return name.startsWith(BUILT_IN_APP_PREFIX)
}

/** What an app is: code that runs with no page (`script`), or a web page
 *  (`ui`). */
export const APP_KINDS = ['script', 'ui'] as const
export type AppKind = typeof APP_KINDS[number]

/** The kind of an app in a list for a model when no manifest tells it
 *  (`manifestColumns`, appsTool.ts). */
export const UNKNOWN_APP_KIND = '?'
export type ListedAppKind = AppKind | typeof UNKNOWN_APP_KIND

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

/** The one native library that the manifest of a script app can ask for,
 *  with the field `"native": ["skia-canvas"]`: a run of the app then may
 *  load the native file of skia-canvas in /libs (`nativeCanvas`,
 *  bundled_tools.rs). `manifestSchema` does not read the field, so a list
 *  of the apps still lists an app whose field is not valid; only a run
 *  checks it (`runNativeCanvas`, appInvoke.ts). */
export const NATIVE_CANVAS_LIBRARY = 'skia-canvas'

/** The field of the manifest of a script app that asks for
 *  `NATIVE_CANVAS_LIBRARY`, as the texts for a model write it. */
export const NATIVE_FIELD_EXAMPLE = `"native": ["${NATIVE_CANVAS_LIBRARY}"]`

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
