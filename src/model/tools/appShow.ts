import { APP_NAME_SOURCE, MANIFEST_FILE, parseAppManifest } from './appManifest'
import { appNamed, appSize, checkAppIsThere, checkedAppKind, kindName, pathIn, type AppSize, type AppsPath, type AppsTree, type PathFacts } from './appsTool'
import { UI_INDEX_FILE } from './appTemplates'
import { ToolError, type SubcommandArguments } from './types'

// `apps show` for a UI app: Dez puts the app into the reply, as one tag
// line after the blocks of the calls (`<dez:app>`, chat/appTags.ts), which
// the editor shows as the card of the app (view/editor/apps.ts). The call
// runs no code and changes no file. controller/appsTool.ts reads what is
// at the paths of the app, and the stream controller writes the line
// (`ToolRunContext.showApp`, controller/tools.ts).
//
// This module has the pure parts: the checks of a call, every text that
// the calling model reads, and what the card of an app tells the user
// (`appCardFacts`). Every text here is a tool result: it goes to the chat
// provider, and it holds virtual paths only.

// What Dez did not do for a call that it refuses.
const NOT_DONE = 'Dez shows no app.'

/** The app that a `show` call names. */
export interface ShowCall {
  /** The name of the app, which is the name of its folder. */
  name: string
  app: AppsPath
  /** The manifest file of the app, which tells its kind. */
  manifest: AppsPath
  /** The page of the app. */
  index: AppsPath
}

/** The app that an `apps show` call asks for, from its checked arguments.
 *  Throws a `ToolError` for a text that is no name of an app. It reads no
 *  file: `checkShowTarget` tells whether Dez can show the app. */
export function showCall(args: SubcommandArguments): ShowCall {
  const name = (typeof args.name === 'string' ? args.name : '').trim()
  const app = appNamed(name)
  return { name, app, manifest: pathIn(app, MANIFEST_FILE), index: pathIn(app, UI_INDEX_FILE) }
}

/** What is at the paths of an app that a call shows, each from one exact
 *  read of its path (see `InvokeTarget`, appInvoke.ts). */
export interface ShowTarget {
  app: PathFacts
  manifest: PathFacts
  /** The bytes of the manifest file; null when Dez does not read it
   *  (`isReadableManifest`). */
  manifestBytes: Uint8Array | null
  index: PathFacts
}

/** Throws a `ToolError` unless the app of `call` is a UI app that Dez can
 *  show: its folder, a manifest that tells the kind `ui`, and its page. */
export function checkShowTarget({ app, manifest, index }: ShowCall, target: ShowTarget): void {
  checkAppIsThere(app, target.app)
  if (checkedAppKind(app, manifest, target.manifest, target.manifestBytes, NOT_DONE) !== 'ui') {
    throw new ToolError(`${app.virtual} is a script app, and show shows only a UI app: an app whose ${MANIFEST_FILE} has the kind "ui", with its page in ${UI_INDEX_FILE}. `
      + `A script app has no page: run it with invoke. ${NOT_DONE}`)
  }
  if (target.index.kind === 'missing') {
    throw new ToolError(`The app ${app.virtual} has no ${UI_INDEX_FILE}, the page that Dez shows. Write ${index.virtual}. ${NOT_DONE}`)
  }
  if (target.index.kind !== 'file') {
    throw new ToolError(`${index.virtual} is ${kindName(target.index.kind)} and no file, so the app has no page to show. `
      + `Delete it with rm, and write the page of the app as that file. ${NOT_DONE}`)
  }
}

/** What the card of an app tells the user of the app (view/editor/apps.ts):
 *  - `ready`: a UI app that Dez can show, with the description of its
 *    manifest.
 *  - `missing`: there is no folder of that name, so the app is gone.
 *  - `broken`: what is there is no UI app that Dez can show.
 *  - `unreadable`: Dez could not read what is there.
 *
 *  `size` is the size of the folder of the app; null when what is there
 *  is no folder. */
export type AppCardFacts =
  | { state: 'ready', description: string, size: AppSize | null }
  | { state: 'broken', size: AppSize | null }
  | { state: 'missing' | 'unreadable' }

/** The facts of the card of the app of `call`, from what is at its paths,
 *  and from `tree`, the listing of the app with `APPS_MAX_ENTRIES`, for
 *  its size. The card follows the one rule of a `show` call
 *  (`checkShowTarget`): Dez runs for the user only an app that it would
 *  show for a model. */
export function appCardFacts(call: ShowCall, target: ShowTarget, tree: AppsTree): AppCardFacts {
  if (target.app.kind === 'missing') return { state: 'missing' }
  const size = tree.kind === 'folder' ? appSize(tree) : null
  try {
    checkShowTarget(call, target)
  } catch (error) {
    if (error instanceof ToolError) return { state: 'broken', size }
    throw error
  }
  // The check read the kind from the manifest, so its bytes are there and
  // they parse.
  const manifest = target.manifestBytes && parseAppManifest(new TextDecoder().decode(target.manifestBytes))
  return manifest ? { state: 'ready', description: manifest.description, size } : { state: 'broken', size }
}

/** The start of the sentence with which a tool result tells that Dez put
 *  the app `name` into the reply, as in "Dez shows the app notes". Every
 *  result that tells of a shown app starts a line with it (the result of
 *  `apps show`, and the result of a `js_eval` call whose code made that
 *  call). A request reads it: the result tells the model of the app, so
 *  the tag of the app in the reply does not go (`shownAppNames`;
 *  `roundRequestText`, streams/messages.ts). */
export function shownAppText(name: string): string {
  return `Dez shows the app ${name}`
}

// `shownAppText`, with the name as its one group. A name can end with `-`
// or `_`, where `\b` finds no word end, so the end of the name is the
// first char that a name cannot hold.
const SHOWN_APP_LINE_START = new RegExp(`^Dez shows the app (${APP_NAME_SOURCE})(?![a-z0-9_-])`, 'gm')

/** The names of the apps that a tool result names with `shownAppText`, in
 *  text order. Only that sentence at a line start counts, not any name of
 *  an app in the text. */
export function shownAppNames(resultText: string): string[] {
  return [...resultText.matchAll(SHOWN_APP_LINE_START)].map((match) => match[1])
}

/** The result of a `show` call whose app `name` Dez put into the reply.
 *  It tells that the app does not run yet: a model must not tell the user
 *  that the app is open. */
export function showResultText(name: string): string {
  return `${shownAppText(name)} in your reply, after this call, as a card with a Run button: the app starts when the user clicks Run. Write no tag and no link for it.`
}

/** The text of the `ToolError` of a `show` call whose reply took no text
 *  any more (the user stopped it), so Dez wrote no app into it. */
export function appNotShownText(): string {
  return `The reply stopped before Dez could put the app into it. ${NOT_DONE} This is not a fault of the call. Call show again only when the user asks for the app again.`
}
