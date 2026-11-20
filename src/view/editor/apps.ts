import { MapMode, StateEffect, StateField, type ChangeDesc, type EditorState, type Extension } from '@codemirror/state'
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view'
import sbp from '@sbp/sbp'
import { findAppTags, type AppTag } from '../../model/chat/appTags'
import { SENTINEL_CHAR, plainLiveText } from '../../model/chat/content'
import type { Section } from '../../model/chat/types'
import { APP_STOPPED_TEXT, AppCallError, SAVE_NEEDS_DRAFT_TEXT, SaveNotStoredError, type SavedAppFile, type SavedAssetAnswer } from '../../model/tools/appBridge'
import type { AppCardFacts } from '../../model/tools/appShow'
import { appSizeLabel, knownAppFacts, readAppFacts, setAppDeleted } from '../apps/appFacts'
import { FRAME_PLACE_ATTRIBUTE, placeAppFrames, type AppFrameActions, type AppRun } from '../apps/appFrameHost'
import { appIcon } from '../apps/appIcon'
import { leaveFullscreen } from '../fullscreen'
import { APP_BOX_HEIGHT_PX, APP_CARD_PADDING_PX, docToSections, editorSizePx, pillsField, sectionsField, type SectionModel } from '../thread/cmEditor'
import { compactionBlockEnd } from './compactionBlock'
import { syncDomSelection } from './focus'
import { insertSavedFile } from './imageInsert'
import { linesRemovalRange } from './images'
import { lineBlocks, sectionRolesChanged, sectionTexts } from './lineBlocks'
import { followShownRange, pendingRanges } from './pendingRanges'
import { ROUND_STROKE, svgIcon, trashIcon, type IconShapes } from './svgIcon'

// The apps that Dez shows in a conversation (app tags,
// src/model/chat/appTags.ts), each shown as a card in place of its tag,
// in every section: `apps show` writes a tag into a reply, and a paste can
// bring one into a user section. The card is a line block, as a media
// player is (media.ts).
//
// An app starts only on a click on Run: the code of an app is the work of
// a model, a loop in it that never ends blocks the window of Dez, and a
// conversation with many apps must not start them all. So the card is a
// poster (the name, the description, Run) until then. A corner of the
// poster has the size of the folder of the app, and the trash that
// deletes the app (`deleteApp`).
//
// The apps that run are a part of the editor state (`AppRun`): a run
// belongs to the tag whose card started it, and its place follows the tag
// through each change of the doc. The card of a tag with a run is an empty
// placeholder of the same size, and the frame host
// (view/apps/appFrameHost.ts) shows the frame of the app over it: a
// widget cannot hold the frame, as CodeMirror makes each widget again for
// a new state and takes away the DOM of one that is far out of view.
//
// The facts of an app (its description, its size, whether Dez can show
// it) are in view/apps/appFacts.ts: a card draws from the last ones at
// once, and then reads them again.

const ROOT_CLASS = 'dez-app'

// A triangle that points right, as on a play button.
const RUN_ICON_SHAPES: IconShapes = [
  ['path', { d: 'M5.2 3.4v9.2L12.6 8z', ...ROUND_STROKE, fill: 'currentColor', 'stroke-width': '1.3' }],
]

// What a card tells in place of Run, for an app that Dez cannot start.
const NO_RUN_NOTES: Record<Exclude<AppCardFacts['state'], 'ready'>, string> = {
  missing: 'This app is gone: its folder is not there any more.',
  broken: 'Dez cannot show this app. It has no valid manifest.json with the kind "ui", or no index.html.',
  unreadable: 'Dez could not read the files of this app.',
}

/** Starts the app of the card whose tag starts at this doc position, as
 *  the Run of the card does. No effect for a position with no card, and
 *  for a card whose app runs. */
export const runAppEffect = StateEffect.define<number>({ map: (from, changes) => changes.mapPos(from, 1) })

/** Stops the run with this id, as the Stop of its frame does. */
export const stopAppEffect = StateEffect.define<string>()

interface AppsState {
  /** The tags that show as cards, in doc order. */
  apps: readonly AppTag[]
  /** The apps that run, in the order of their starts. The array is the
   *  same object until a run starts, ends, or moves. */
  runs: readonly AppRun[]
  decorations: DecorationSet
}

function span(part: string, text = ''): HTMLSpanElement {
  const element = document.createElement('span')
  element.className = `${ROOT_CLASS}__${part}`
  element.textContent = text
  return element
}

// The poster of the app `name`: its name, and with `facts` its description
// and Run, or the reason why Dez cannot start it.
function poster(name: string, facts: AppCardFacts | undefined, run: () => void): HTMLElement {
  const made = span('poster')
  const title = span('title')
  const icon = span('icon')
  icon.append(appIcon())
  title.append(icon, span('name', name))
  made.append(title)
  if (!facts) return made
  if (facts.state !== 'ready') {
    made.append(span('note', NO_RUN_NOTES[facts.state]))
    return made
  }
  if (facts.description) made.append(span('description', facts.description))
  const button = document.createElement('button')
  button.type = 'button'
  button.className = `${ROOT_CLASS}__run`
  button.append(svgIcon('0 0 16 16', RUN_ICON_SHAPES), 'Run')
  button.addEventListener('click', run)
  made.append(button)
  return made
}

// The corner of the poster of the app `name`: the size of its folder, when
// `facts` have it, and the trash. The trash is out of the Tab order, as
// the trash of an image is: Tab in the editor never lands in a card.
function cornerTools(view: EditorView, root: HTMLElement, name: string, facts: AppCardFacts | undefined): HTMLElement {
  const tools = span('tools')
  const size = appSizeLabel(facts)
  if (size) tools.append(span('size', size))
  const button = document.createElement('button')
  button.type = 'button'
  button.className = `${ROOT_CLASS}__trash`
  button.title = facts?.state === 'missing' ? `Remove the card of the app ${name}` : `Delete the app ${name}`
  button.setAttribute('aria-label', button.title)
  button.tabIndex = -1
  button.append(trashIcon())
  button.addEventListener('click', () => void deleteApp(view, view.posAtDOM(root)))
  tools.append(button)
  return tools
}

// The box of the card `root`: the poster is in it, or the frame of a run
// is over it.
function boxOf(root: HTMLElement): HTMLElement {
  return root.firstElementChild as HTMLElement
}

// Whether the card `root` is in the page and shows a poster: no run has
// its place.
function showsPoster(root: HTMLElement): boolean {
  return root.isConnected && !boxOf(root).hasAttribute(FRAME_PLACE_ATTRIBUTE)
}

// Run of the card `root`: starts the app only when its files are still
// those of a UI app. The files can change after the card was drawn (the
// `apps` tool, a delete), and the card then tells why there is no run.
async function runApp(view: EditorView, root: HTMLElement, name: string): Promise<void> {
  const facts = await readAppFacts(name)
  if (!showsPoster(root)) return
  if (facts.state !== 'ready') {
    drawPoster(view, root, name)
    return
  }
  // A program write: no `userEvent`.
  view.dispatch({ effects: runAppEffect.of(view.posAtDOM(root)) })
}

function drawPoster(view: EditorView, root: HTMLElement, name: string): void {
  const facts = knownAppFacts(name)
  boxOf(root).replaceChildren(poster(name, facts, () => void runApp(view, root, name)), cornerTools(view, root, name, facts))
}

// Draws again each poster of the app `name` that the editor shows now,
// from the facts that Dez has. The name of an app is safe in a selector
// (lower-case letters, digits, `-`, and `_`).
function redrawPosters(view: EditorView, name: string): void {
  for (const root of view.contentDOM.querySelectorAll<HTMLElement>(`.${ROOT_CLASS}[data-app="${name}"]`)) {
    if (showsPoster(root)) drawPoster(view, root, name)
  }
}

// What a poster shows of `facts`, as one text.
function shownFacts(facts: AppCardFacts | undefined): string {
  return facts ? `${facts.state}\n${facts.state === 'ready' ? facts.description : ''}\n${appSizeLabel(facts)}` : ''
}

// Draws the card `root` for the app `name`: empty for the run `runId`, as
// the frame of the run covers it, else the poster, from the facts that Dez
// has, and again when a new read gives other facts.
function drawCard(view: EditorView, root: HTMLElement, name: string, runId: string | null): void {
  const box = boxOf(root)
  if (runId !== null) {
    box.setAttribute(FRAME_PLACE_ATTRIBUTE, runId)
    box.replaceChildren()
    return
  }
  box.removeAttribute(FRAME_PLACE_ATTRIBUTE)
  const drawn = shownFacts(knownAppFacts(name))
  drawPoster(view, root, name)
  void readAppFacts(name).then((facts) => {
    if (shownFacts(facts) !== drawn && showsPoster(root)) drawPoster(view, root, name)
  })
}

/** The card of one app, in place of its tag: the poster of the app, or the
 *  placeholder of the run `runId`. The root has the name of the app
 *  (`data-app`); the box in it has the same size in both forms, so a start
 *  and a stop move no text. */
class AppWidget extends WidgetType {
  constructor(readonly name: string, readonly runId: string | null) {
    super()
  }
  eq(other: WidgetType): boolean {
    return other instanceof AppWidget && other.name === this.name && other.runId === this.runId
  }
  toDOM(view: EditorView): HTMLElement {
    const { name } = this
    const root = document.createElement('span')
    root.className = ROOT_CLASS
    root.dataset.app = name
    // A press on the card moves no caret and takes no focus: the editor
    // keeps its selection, and Run gets its click. A context click on
    // macOS would select a word of the poster (see `createPlayer`,
    // media.ts).
    root.addEventListener('mousedown', (event) => event.preventDefault())
    root.addEventListener('selectstart', (event) => event.preventDefault())
    // A context click shows Dez's menu of the app, in place of the menu of
    // the webview.
    root.addEventListener('contextmenu', (event) => {
      event.preventDefault()
      void sbp('dez.controller/apps/popupMenu', name)
    })
    root.append(span('box'))
    drawCard(view, root, name, this.runId)
    return root
  }
  // A start and a stop change the card in place.
  updateDOM(dom: HTMLElement, view: EditorView): boolean {
    if (dom.dataset.app !== this.name) return false
    drawCard(view, dom, this.name, this.runId)
    return true
  }
  // The card has one size, so CM knows the height of a card that it has
  // not drawn yet.
  get estimatedHeight(): number {
    return editorSizePx(APP_BOX_HEIGHT_PX + 2 * APP_CARD_PADDING_PX)
  }
  // The card takes its own events; CM leaves them all alone.
  ignoreEvent(): boolean {
    return true
  }
}

/** The tags that the editor shows as cards, in doc order, as doc ranges.
 *  Each section is read on its own (`sectionTexts`). Left as text: a line
 *  that is not a valid tag, a tag that holds a sentinel (a prompt pill),
 *  whose widgets and atomic ranges must stay the only ones there, a tag in
 *  Markdown code of the section's plain text (`plainLiveText`), which a
 *  request reads, and a tag before `blockEnd`, the end of the compaction
 *  block, which is out of view as a whole. */
function findRenderedApps(doc: string, sections: readonly SectionModel[], blockEnd: number): AppTag[] {
  const apps: AppTag[] = []
  if (!doc.includes('<dez:app')) return apps
  for (const { section, from, text } of sectionTexts(doc, sections)) {
    const tags = findAppTags(text, section.role, { inCode: true }).filter((tag) => !SENTINEL_CHAR.test(text.slice(tag.from, tag.to)))
    if (tags.length === 0) continue
    const plain = plainLiveText(text)
    const outOfCode = new Set(findAppTags(plain.text, section.role).map((tag) => plain.liveOffset(tag.from)))
    for (const tag of tags) {
      if (outOfCode.has(tag.from) && from + tag.from >= blockEnd) apps.push({ name: tag.name, from: from + tag.from, to: from + tag.to })
    }
  }
  return apps
}

function appsOf(state: EditorState): AppTag[] {
  return findRenderedApps(state.doc.toString(), state.field(sectionsField, false) ?? [], compactionBlockEnd(state.doc))
}

function appsState(apps: readonly AppTag[], runs: readonly AppRun[]): AppsState {
  const runAt = new Map(runs.map((run) => [run.from, run.id]))
  const decorations = Decoration.set(apps.map((tag) => Decoration.replace({ widget: new AppWidget(tag.name, runAt.get(tag.from) ?? null) }).range(tag.from, tag.to)))
  return { apps, runs, decorations }
}

/** A run in the form that a new editor state of the same conversation
 *  takes (`markdownApps`). The new doc can have other text before the tag
 *  of the run and after it, so the form names the tag by its app and by
 *  `later`, the count of the cards of that app after it. */
export interface CarriedAppRun {
  id: string
  name: string
  later: number
}

// The runs of `carried` whose tags are among `apps`, at the places of those
// tags. The count is from the doc end: a compaction puts other text in the
// place of the doc start, and a run whose tag went with it ends.
function restoredRuns(apps: readonly AppTag[], carried: readonly CarriedAppRun[]): AppRun[] {
  const runs: AppRun[] = []
  for (const { id, name, later } of carried) {
    const sameApp = apps.filter((tag) => tag.name === name)
    const tag = sameApp[sameApp.length - 1 - later]
    if (tag && !runs.some((run) => run.from === tag.from)) runs.push({ id, name, from: tag.from })
  }
  return runs
}
// The runs after a change of the doc or of the sections: each at the new
// place of its tag. A run ends when its tag is no card of its app any more
// (deleted, changed, in code now, or text of another role). A change that
// takes away the first character of the tag ends the run too
// (`TrackAfter`): another tag of the same app can start at the place where
// the change ends, and it is not the card of the run.
function movedRuns(runs: readonly AppRun[], apps: readonly AppTag[], changes: ChangeDesc): readonly AppRun[] {
  if (runs.length === 0) return runs
  const nameAt = new Map(apps.map((tag) => [tag.from, tag.name]))
  const moved = runs.flatMap((run) => {
    const from = changes.mapPos(run.from, 1, MapMode.TrackAfter)
    if (from === null || nameAt.get(from) !== run.name) return []
    return [from === run.from ? run : { ...run, from }]
  })
  return moved.length === runs.length && moved.every((run, index) => run === runs[index]) ? runs : moved
}

function startedRun(runs: readonly AppRun[], apps: readonly AppTag[], from: number): readonly AppRun[] {
  const tag = apps.find((app) => app.from === from)
  if (!tag || runs.some((run) => run.from === from)) return runs
  return [...runs, { id: crypto.randomUUID(), name: tag.name, from }]
}

/** The cards and the runs of the apps. Each app tag is replaced by its
 *  card. The ranges are atomic, so the caret is never inside the hidden
 *  text. */
const appsField = StateField.define<AppsState>({
  create: (state) => appsState(appsOf(state), []),
  update(value, tr) {
    const reread = tr.docChanged || sectionRolesChanged(tr)
    const apps = reread ? appsOf(tr.state) : value.apps
    let runs = reread ? movedRuns(value.runs, apps, tr.changes) : value.runs
    for (const effect of tr.effects) {
      if (effect.is(runAppEffect)) {
        runs = startedRun(runs, apps, effect.value)
      } else if (effect.is(stopAppEffect) && runs.some((run) => run.id === effect.value)) {
        runs = runs.filter((run) => run.id !== effect.value)
      }
    }
    return reread || runs !== value.runs ? appsState(apps, runs) : value
  },
  provide: (field) => [
    EditorView.decorations.from(field, (value) => value.decorations),
    EditorView.atomicRanges.of((view) => view.state.field(field).decorations),
  ],
})

const NO_APPS: readonly AppTag[] = []
const NO_RUNS: readonly AppRun[] = []

/** The tags that the editor shows as cards in `state`, in doc order; none
 *  for a state without `markdownApps()`. The array is the same object
 *  until the doc or the sections change, so callers can cache by it. */
export function renderedApps(state: EditorState): readonly AppTag[] {
  return state.field(appsField, false)?.apps ?? NO_APPS
}

/** The apps that run in `state`; none for a state without
 *  `markdownApps()`. The array is the same object until a run starts,
 *  ends, or moves. */
export function appRuns(state: EditorState): readonly AppRun[] {
  return state.field(appsField, false)?.runs ?? NO_RUNS
}

/** The runs of `state`, for the next state of the same conversation
 *  (`markdownApps`). */
export function carriedAppRuns(state: EditorState): CarriedAppRun[] {
  const apps = renderedApps(state)
  return appRuns(state).map(({ id, name, from }) => ({ id, name, later: apps.filter((tag) => tag.name === name && tag.from > from).length }))
}

/** Dez deleted the app `name`: its facts are those of an app that is gone
 *  (`setAppDeleted`), so a card that any conversation draws later tells
 *  so. In `view`, the editor that shows a conversation now (null: none),
 *  each run of the app ends, as its page shows files that are gone, and
 *  each card of the app is drawn again. */
export function showAppDeleted(view: EditorView | null, name: string): void {
  setAppDeleted(name)
  if (!view) return
  // A program write: no `userEvent`.
  const stops = appRuns(view.state).filter((run) => run.name === name).map((run) => stopAppEffect.of(run.id))
  if (stops.length > 0) view.dispatch({ effects: stops })
  redrawPosters(view, name)
}

/** The trash of an app (on its card, and on the bar of a run): asks
 *  whether to delete the app of the card whose tag starts at `from`, and
 *  on "Yes" deletes the folder of the app (`dez.controller/apps/delete`),
 *  ends each run of the app, and takes the line of the tag out of the doc
 *  (`linesRemovalRange`). The other cards of the app stay, and tell that
 *  the app is gone. That removal is not in the undo history: the files do
 *  not come back, so an undo could only bring back the card of an app
 *  that is gone.
 *
 *  The card of an app that is gone has a trash too. It deletes no file,
 *  and takes only the line out, in a normal edit that an undo takes back.
 *  The prompt tells which of the two the trash does, from the files as
 *  they are when it opens: they can have changed since the card was drawn.
 *
 *  The doc can change while the prompt is open or the folder is being
 *  deleted (a stream), so the tag is followed (`followShownRange`). When
 *  the tag is gone after the prompt, no file is deleted, and a toast tells
 *  the user. A failed delete (the controller has shown a toast) keeps the
 *  tag. If the tag goes while the folder is being deleted, its text stays,
 *  and its card tells that the app is gone. */
export async function deleteApp(view: EditorView, from: number): Promise<void> {
  const tag = renderedApps(view.state).find((app) => app.from === from)
  if (!tag) return
  const { name } = tag
  const followed = followShownRange(view, tag, renderedApps, (other) => other.name === name)
  // The prompt is outside of an app that fills the screen.
  const [facts] = await Promise.all([readAppFacts(name), leaveFullscreen(view.dom)])
  const gone = facts.state === 'missing'
  const message = gone
    ? `Are you sure you want to remove the card of the app ${name} from the conversation? The app is gone, so Dez deletes no file.`
    : `Are you sure you want to delete the app ${name}? Dez deletes the folder of the app with all its files. No conversation can run the app after that.`
  const confirmed = await sbp('dez.ui/confirm', { message }) as boolean
  if (!confirmed) {
    followed.end()
    return
  }
  if (!followed.current()) {
    followed.end()
    sbp('dez.ui/toast', 'app-global', {
      title: gone ? 'Card not removed' : 'App not deleted',
      message: 'The conversation changed while the prompt was open. Try again.',
      variant: 'warning',
      duration: 8000,
    })
    return
  }
  if (!gone) {
    try {
      await sbp('dez.controller/apps/delete', name)
    } catch {
      // The controller has logged the failure and shown a toast. The user
      // can have gone to fullscreen again after the prompt.
      void leaveFullscreen(view.dom)
      followed.end()
      // A delete that failed can have deleted a part of the files.
      void readAppFacts(name).then(() => redrawPosters(view, name))
      return
    }
    showAppDeleted(view, name)
  }
  const range = followed.current()
  followed.end(range ? linesRemovalRange(view.state.doc, range) : undefined, { undoable: gone, userEvent: 'delete' })
  // The prompt gave the focus back a few ms ago (`syncDomSelection`).
  if (range) syncDomSelection(view)
}

// The sections of the conversation that `state` shows, with the text as it
// is in the editor now: the store gets an edit a moment later.
function shownSections(state: EditorState): Section[] {
  return docToSections(state.doc.toString(), state.field(sectionsField), state.field(pillsField))
}

// Why the conversation of `view` cannot take a save of the page of the run
// `runId` now; null when it can. The app can have stopped while Dez stored
// the file (a Stop, a tab switch). A save goes into the message that the
// user writes, the last section: while a reply runs, the last section is
// that reply, and the user can make the last section an agent section.
function saveProblem(view: EditorView, runId: string): string | null {
  if (!appRuns(view.state).some((run) => run.id === runId)) return APP_STOPPED_TEXT
  return view.state.field(sectionsField).at(-1)?.role === 'user' ? null : SAVE_NEEDS_DRAFT_TEXT
}

// What the controls of the bar of a run and the calls of its page do in
// the editor state.
const FRAME_ACTIONS: AppFrameActions = {
  // A program write: no `userEvent`.
  stop: (view, runId) => view.dispatch({ effects: stopAppEffect.of(runId) }),
  remove(view, runId) {
    const run = appRuns(view.state).find((run) => run.id === runId)
    if (run) void deleteApp(view, run.from)
  },
  // A shown app reads the images and the clips that its user sees: those
  // of the conversation that shows it.
  readAsset: (view, id) => sbp('dez.controller/apps/readAsset', id, shownSections(view.state)) as Promise<Blob>,
  async saveAsset(view, runId, blob, saves) {
    // Before the store, so that a save that cannot go writes no file.
    const problem = saveProblem(view, runId)
    if (problem !== null) throw new AppCallError(problem)
    try {
      return await sbp('dez.controller/apps/saveAsset', blob, saves, (file: SavedAppFile) => {
        // The store took time: the conversation can have changed.
        const problemNow = saveProblem(view, runId)
        if (problemNow !== null) throw new AppCallError(problemNow)
        return insertSavedFile(view, file)
      }) as SavedAssetAnswer
    } catch (error) {
      // The controller has logged the failed write and shown a toast,
      // which is outside of an app that fills the screen.
      if (error instanceof SaveNotStoredError) void leaveFullscreen(view.dom)
      throw error
    }
  },
}

/** Makes the frames of `view` those of the apps that run in its state,
 *  each over its placeholder (`placeAppFrames`). The update listener of
 *  `markdownApps` calls it; code that gives the view a new state calls it
 *  too, as `setState` runs no listener. */
export function syncAppFrames(view: EditorView): void {
  placeAppFrames(view, appRuns(view.state), FRAME_ACTIONS)
}

// The frames follow the runs, and their places follow the layout of the
// text. The listener runs after the editor changed its DOM, so the place
// of a frame is right in the same frame of the screen as the text.
const appFramesSync = EditorView.updateListener.of((update) => {
  const runsChanged = appRuns(update.state) !== appRuns(update.startState)
  if (runsChanged || update.docChanged || update.geometryChanged || update.heightChanged || update.viewportChanged) syncAppFrames(update.view)
})

/** App cards for the thread editor (`buildState()` in `ThreadEditor.vue`),
 *  with the runs `carried` of the state before it. The cards are line
 *  blocks (`lineBlocks.ts`), as the media players are. Find skips the
 *  hidden text (`protectedRanges` in `find.ts`). The trash follows its tag
 *  as a pending range. The CSS of the card and of the frame host is in
 *  `dezTheme`. The state needs `sectionsField`. */
export function markdownApps(carried: readonly CarriedAppRun[] = []): Extension {
  return [
    carried.length === 0 ? appsField : appsField.init((state) => {
      const apps = appsOf(state)
      return appsState(apps, restoredRuns(apps, carried))
    }),
    lineBlocks(renderedApps),
    pendingRanges(),
    appFramesSync,
  ]
}
