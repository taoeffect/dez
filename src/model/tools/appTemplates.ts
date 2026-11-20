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
// not give the keyboard back to Dez.

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
  <script src="~dez.js"></script>
  <script src="main.js"></script>
</body>
</html>
`,
    },
    {
      name: 'main.js',
      content: `// The code of the page of the app "${name}" (index.html loads it).
document.getElementById('output').textContent = 'Hello from ${name}.'
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
