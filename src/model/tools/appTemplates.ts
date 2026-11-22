import shippedImportMap from '../../../src-tauri/libs/import_map.json'
import { libraries as shippedLibraries } from '../../../src-tauri/libs/manifest.json'
import { APP_INVOKE_HANDLER, APP_READ_ASSET, APP_SAVE_ASSET } from './appBridge'
import { appManifestText, MANIFEST_FILE, type AppManifest } from './appManifest'

// The first files of a new app (`apps init`, appsTool.ts): the manifest,
// and a small app of its kind that works as it is, so that a model changes
// a file that runs and does not start from nothing. The main file of a
// script app also tells what a run gives its code (the `dez` object of
// `appDez`, jsEvalRunner.js): keep the two the same.
//
// The name of the app goes into the files as it is: `apps init` takes only
// a name of lower-case letters, digits, `-`, and `_`, which is safe in
// HTML, in a script, and in a text of a script. The description goes only
// into the manifest, as JSON: it is free text.
//
// The page of a UI app loads its script and its style from files of their
// own, so that a model reads and edits each on its own. Before its own
// script it loads `~dez.js`: Dez's client script, which is no file of the
// app (src-tauri/src/app_client.js). Without it, Escape in the app does
// not give the keyboard back to Dez, a context click in the app shows the
// menu of the webview, and the page has no `dez` object: no run of the
// app (`apps invoke`), no read and no save of an asset. The script of the
// page tells what `dez` gives (the frame bridge, appBridge.ts): keep the
// two the same.
//
// The page loads its own script as a module (`UI_MAIN_MODULE_TAG`), after
// its import map (`UI_IMPORT_MAP_TAG`), so that the script imports the
// libraries that Dez ships by their names. The page of an app has no
// origin, so the webview takes each file of the app for a file of another
// origin, and hides the error of a classic script that was loaded without
// `crossorigin` (`UI_OWN_SCRIPT_TAG`): the result of a run would tell only
// "Script error.", with no message and no line. A module always loads in
// the CORS mode, so its errors show.

/** One file of a template: its name in the folder of the app, and its
 *  text. */
export interface TemplateFile {
  name: string
  content: string
}

/** The file of a script app whose default export a run of the app calls
 *  (`apps invoke`, appInvoke.ts). */
export const SCRIPT_MAIN_FILE = 'main.ts'

/** The file of a UI app that is its page: what Dez shows for the app
 *  (`apps show`, appShow.ts). */
export const UI_INDEX_FILE = 'index.html'

/** The tag with which the page of a UI app loads Dez's client script. It
 *  goes before the scripts of the page, which use the `dez` object. */
export const UI_CLIENT_SCRIPT_TAG = '<script src="~dez.js"></script>'

/** The tag with which the page of a UI app loads a classic script file of
 *  its own: with `crossorigin`, so that the webview tells its errors. */
export const UI_OWN_SCRIPT_TAG = '<script src="main.js" crossorigin></script>'

/** The tag with which the page of a new UI app loads its script: as a
 *  module, which imports the shipped libraries by the names of the import
 *  map of the page (`UI_IMPORT_MAP_TAG`). */
export const UI_MAIN_MODULE_TAG = '<script type="module" src="main.js"></script>'

/** The route of the libraries that Dez ships, in the folder of each app
 *  (`LIBS_ROUTE` in src-tauri/src/app_frames.rs): the page
 *  `dezapp://localhost/<name>/index.html` gets the file `<path>` of the
 *  shipped libs folder at `~libs/<path>`. */
export const UI_LIBS_ROUTE = '~libs'

// The names of Dez's own modules (`OWN_LIBRARIES`, scripts/update-libs.js)
// that a page cannot load: one that imports a library with a native file
// (dez-media/canvas), and one that writes files with node:fs
// (dez-media/frames).
const DENO_ONLY_IMPORTS: readonly string[] = ['dez-media/canvas', 'dez-media/frames']

// The import map of the page of a UI app: the names of the import map of
// the runs of Deno (src-tauri/libs/import_map.json, whose entries are
// `./<folder>/<path>` of the libs folder), at the route of the libraries.
// A library with a native file (skia-canvas) runs only in Deno, so the
// page gets no name of it, and no name of a module of Dez that imports it
// (`DENO_ONLY_IMPORTS`). The entries are relative to the page, so they
// hold for each name of the app, also after `apps mv`.
function pageImportMap(): { imports: Record<string, string> } {
  const denoOnly = Object.entries(shippedLibraries).filter(([, library]) => 'native' in library).map(([folder]) => `./${folder}/`)
  const imports = Object.entries(shippedImportMap.imports)
    .filter(([name, target]) => !DENO_ONLY_IMPORTS.includes(name) && !denoOnly.some((folder) => target.startsWith(folder)))
    .map(([name, target]) => [name, `./${UI_LIBS_ROUTE}/${target.slice('./'.length)}`])
  return { imports: Object.fromEntries(imports) }
}

/** The import map of the page of a new UI app, inline in its `<head>`: a
 *  module of the page imports the shipped libraries by their names, as in
 *  `import * as THREE from 'three'`. A browser takes no import map from a
 *  file, and a map after the first module of a page does nothing. */
export const UI_IMPORT_MAP_TAG = `<script type="importmap">\n${JSON.stringify(pageImportMap(), null, 2)}\n</script>`

function scriptFiles(name: string): TemplateFile[] {
  return [{
    name: SCRIPT_MAIN_FILE,
    content: `// The code of the app "${name}".
//
// A run of the app (apps invoke) calls the function that this file exports
// as its default, with the parameters of the run (a JSON object) and the
// \`dez\` object of the run. The value that the function returns is the
// result of the run.
//
// The code imports the libraries that Dez ships by name, as in
// \`import { beatGrid } from 'dez-media'\`. /libs/<name>/SKILL.md tells each
// library (apps read).

/** What a run gives the code. Each path is absolute: build the path of a
 *  file from one of them. */
interface Dez {
  /** Calls a Dez tool: 'dez.tools/<tool>' with the arguments of the tool,
   *  or 'dez.tools/<tool>/<subcommand>' with its parameters. Gives the
   *  result text of the tool, or rejects with its error text. An image or
   *  a clip that a call makes has a handle ('&1', '&2', …), which a later
   *  call takes in place of an id. The help of apps invoke tells the
   *  rules. */
  sbp(selector: string, args?: object): Promise<string>
  /** A copy of each image and clip of the run, in the order of the call. */
  inputs: readonly {
    id: string
    kind: 'image' | 'audio' | 'video'
    type: string
    path: string
    /** The decoded sound of a clip (the decode of apps invoke): float32
     *  samples, one channel. Absent when the decode asks for none, and null
     *  for a clip with no sound. */
    audio?: { path: string, rate: number, count: number } | null
    /** The decoded frames of a clip: RGB pixels, frame by frame. Absent
     *  when the decode asks for none, and null for a clip with no video. */
    frames?: { path: string, width: number, height: number, fps: number | null, count: number } | null
  }[]
  /** Dez keeps the images and the clips that the run writes into this
   *  folder. */
  outputFolder: string
  /** The folder of this app. Its files stay from one run to the next. */
  appFolder: string
  /** The work folder of the conversation (/work/ in the apps tool). */
  workFolder: string
  /** The fonts that Dez ships. The run sees no other font: a canvas of
   *  skia-canvas draws text only after useShippedFonts(dez.fonts) of
   *  'dez-media/canvas'. */
  fonts: readonly { file: string, family: string, weight: number, scripts: string, path: string }[]
}

export default async function main(parameters: Record<string, unknown>, dez: Dez): Promise<string> {
  const count = dez.inputs.length
  return \`Hello from ${name}. The parameters of this run: \${JSON.stringify(parameters)}. The run has \${count} input \${count === 1 ? 'file' : 'files'}.\`
}
`,
  }]
}

function uiFiles(name: string): TemplateFile[] {
  return [
    {
      name: UI_INDEX_FILE,
      content: `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${name}</title>
  <link rel="stylesheet" href="style.css">
  ${UI_IMPORT_MAP_TAG.replaceAll('\n', '\n  ')}
</head>
<body>
  <main>
    <h1>${name}</h1>
    <p id="output"></p>
  </main>
  ${UI_CLIENT_SCRIPT_TAG}
  ${UI_MAIN_MODULE_TAG}
</body>
</html>
`,
    },
    {
      name: 'main.js',
      content: `// The code of the page of the app "${name}". index.html loads it as a
// module, after its import map: the module imports the libraries that Dez
// ships by the names of the map, as in \`import * as THREE from 'three'\`.
//
// \`dez\` is the object of Dez's script, which index.html loads first:
// - \`await dez.sbp('${APP_READ_ASSET}', 'a')\` gives the image or the clip
//   @a of the conversation as a Blob.
// - \`await dez.sbp('${APP_SAVE_ASSET}', blob)\` saves the bytes of a Blob
//   as a new image or clip, and gives \`{ id, kind, type }\`.

document.getElementById('output').textContent = 'Hello from ${name}.'

// A run of the app (apps invoke) loads this page in a frame that the user
// does not see, and calls this handler with the parameters of the run (a
// JSON object). \`run.inputs\` has one \`{ id, kind, type }\` for each image
// and clip of the run: read each with \`${APP_READ_ASSET}\`. The value that
// the handler returns is the result of the run. Register the handler
// here, while the page loads.
dez.sbp('sbp/selectors/register', {
  '${APP_INVOKE_HANDLER}': async (parameters, run) => {
    const count = run.inputs.length
    return \`Hello from ${name}. The parameters of this run: \${JSON.stringify(parameters)}. The run has \${count} input \${count === 1 ? 'file' : 'files'}.\`
  },
})
`,
    },
    {
      name: 'style.css',
      content: `:root {
  color-scheme: light dark;
  font-family: system-ui, sans-serif;
}

body {
  margin: 0;
  padding: 1rem;
}
`,
    },
  ]
}

/** The files of a new app, the manifest first. */
export function appTemplateFiles(manifest: AppManifest): TemplateFile[] {
  const files = manifest.kind === 'script' ? scriptFiles(manifest.name) : uiFiles(manifest.name)
  return [{ name: MANIFEST_FILE, content: appManifestText(manifest) }, ...files]
}
