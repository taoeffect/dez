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
// The page loads its own script with `crossorigin` (`UI_OWN_SCRIPT_TAG`).
// The page of an app has no origin, so the webview takes each file of the
// app for a file of another origin, and hides the error of a script that
// was loaded without it: the result of a run would tell only "Script
// error.", with no message and no line.

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

/** The tag with which the page of a UI app loads a script file of its
 *  own, here the script of a new app. */
export const UI_OWN_SCRIPT_TAG = '<script src="main.js" crossorigin></script>'

function scriptFiles(name: string): TemplateFile[] {
  return [{
    name: SCRIPT_MAIN_FILE,
    content: `// The code of the app "${name}".
//
// A run of the app (apps invoke) calls the function that this file exports
// as its default, with the parameters of the run (a JSON object) and the
// \`dez\` object of the run. The value that the function returns is the
// result of the run.

/** What a run gives the code. Each path is absolute: build the path of a
 *  file from one of them. */
interface Dez {
  /** A copy of each image and clip of the run, in the order of the call. */
  inputs: readonly { id: string, kind: 'image' | 'audio' | 'video', type: string, path: string }[]
  /** Dez keeps the images and the clips that the run writes into this
   *  folder. */
  outputFolder: string
  /** The folder of this app. Its files stay from one run to the next. */
  appFolder: string
}

export default async function main(parameters: Record<string, unknown>, dez: Dez): Promise<string> {
  return \`Hello from ${name}. The parameters of this run: \${JSON.stringify(parameters)}. The run has \${dez.inputs.length} input files.\`
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
</head>
<body>
  <main>
    <h1>${name}</h1>
    <p id="output"></p>
  </main>
  ${UI_CLIENT_SCRIPT_TAG}
  ${UI_OWN_SCRIPT_TAG}
</body>
</html>
`,
    },
    {
      name: 'main.js',
      content: `// The code of the page of the app "${name}" (index.html loads it).
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
    return \`Hello from ${name}. The parameters of this run: \${JSON.stringify(parameters)}. The run has \${run.inputs.length} input files.\`
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
