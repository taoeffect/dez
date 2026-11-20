import { MapMode, StateEffect, StateField, type ChangeDesc, type EditorState, type Extension } from '@codemirror/state'
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view'
import sbp from '@sbp/sbp'
import { findAppTags, type AppTag } from '../../model/chat/appTags'
import { SENTINEL_CHAR, plainLiveText } from '../../model/chat/content'
import type { AppCardFacts } from '../../model/tools/appShow'
import { FRAME_PLACE_ATTRIBUTE, placeAppFrames, type AppRun } from '../apps/appFrameHost'
import { appIcon } from '../apps/appIcon'
import { APP_BOX_HEIGHT_PX, APP_CARD_PADDING_PX, editorSizePx, sectionsField, type SectionModel } from '../thread/cmEditor'
import { compactionBlockEnd } from './compactionBlock'
import { lineBlocks, sectionRolesChanged, sectionTexts } from './lineBlocks'
import { ROUND_STROKE, svgIcon, type IconShapes } from './svgIcon'

// The apps that Dez shows in a conversation (app tags,
// src/model/chat/appTags.ts), each shown as a card in place of its tag,
// in every section: `apps show` writes a tag into a reply, and a paste can
// bring one into a user section. The card is a line block, as a media
// player is (media.ts).
//
// An app starts only on a click on Run: the code of an app is the work of
// a model, a loop in it that never ends blocks the window of Dez, and a
// conversation with many apps must not start them all. So the card is a
// poster (the name, the description, Run) until then.
//
// The apps that run are a part of the editor state (`AppRun`): a run
// belongs to the tag whose card started it, and its place follows the tag
// through each change of the doc. The card of a tag with a run is an empty
// placeholder of the same size, and the frame host
// (view/apps/appFrameHost.ts) shows the frame of the app over it: a
// widget cannot hold the frame, as CodeMirror makes each widget again for
// a new state and takes away the DOM of one that is far out of view.

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

// The last facts that Dez read of each app, by its name: a card draws from
// them at once, with no empty frame in between, and then reads them again.
const knownFacts = new Map<string, AppCardFacts>()

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

// The reads of the facts that run now, by the name of their app: the cards
// of one app that are drawn together share one read.
const factReads = new Map<string, Promise<AppCardFacts>>()

// Reads the facts of the app `name` again; never rejects.
function readFacts(name: string): Promise<AppCardFacts> {
  let read = factReads.get(name)
  if (!read) {
    read = (sbp('dez.controller/apps/card', name) as Promise<AppCardFacts>).then((facts) => {
      knownFacts.set(name, facts)
      factReads.delete(name)
      return facts
    })
    factReads.set(name, read)
  }
  return read
}

// Run of the card `root`: starts the app only when its files are still
// those of a UI app. The files can change after the card was drawn (the
// `apps` tool, a delete), and the card then tells why there is no run.
async function runApp(view: EditorView, root: HTMLElement, name: string): Promise<void> {
  const facts = await readFacts(name)
  if (!showsPoster(root)) return
  if (facts.state !== 'ready') {
    drawPoster(view, root, name)
    return
  }
  // A program write: no `userEvent`.
  view.dispatch({ effects: runAppEffect.of(view.posAtDOM(root)) })
}

function drawPoster(view: EditorView, root: HTMLElement, name: string): void {
  boxOf(root).replaceChildren(poster(name, knownFacts.get(name), () => void runApp(view, root, name)))
}

// What a poster shows of `facts`, as one text.
function shownFacts(facts: AppCardFacts | undefined): string {
  return facts ? `${facts.state}\n${facts.state === 'ready' ? facts.description : ''}` : ''
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
  const drawn = shownFacts(knownFacts.get(name))
  drawPoster(view, root, name)
  void readFacts(name).then((facts) => {
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
    const root = document.createElement('span')
    root.className = ROOT_CLASS
    root.dataset.app = this.name
    // A press on the card moves no caret and takes no focus: the editor
    // keeps its selection, and Run gets its click. A context click on
    // macOS would select a word of the poster (see `createPlayer`,
    // media.ts).
    root.addEventListener('mousedown', (event) => event.preventDefault())
    root.addEventListener('selectstart', (event) => event.preventDefault())
    root.append(span('box'))
    drawCard(view, root, this.name, this.runId)
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

/** Makes the frames of `view` those of the apps that run in its state,
 *  each over its placeholder (`placeAppFrames`). The update listener of
 *  `markdownApps` calls it; code that gives the view a new state calls it
 *  too, as `setState` runs no listener. */
export function syncAppFrames(view: EditorView): void {
  // A program write: no `userEvent`.
  placeAppFrames(view, appRuns(view.state), (runId) => view.dispatch({ effects: stopAppEffect.of(runId) }))
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
 *  hidden text (`protectedRanges` in `find.ts`). The CSS of the card and
 *  of the frame host is in `dezTheme`. The state needs `sectionsField`. */
export function markdownApps(carried: readonly CarriedAppRun[] = []): Extension {
  return [
    carried.length === 0 ? appsField : appsField.init((state) => {
      const apps = appsOf(state)
      return appsState(apps, restoredRuns(apps, carried))
    }),
    lineBlocks(renderedApps),
    appFramesSync,
  ]
}
