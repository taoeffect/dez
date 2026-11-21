import type { EditorView } from '@codemirror/view'
import sbp from '@sbp/sbp'
import { APP_READ_ASSET, AppCallError, SAVE_NEEDS_USER_TEXT, type SavedAssetAnswer } from '../../model/tools/appBridge'
import { SaveCount } from '../../model/tools/appInvoke'
import { focusKeepingScroll } from '../editor/focus'
import { ROUND_STROKE, svgIcon, trashIcon } from '../editor/svgIcon'
import { leaveFullscreen } from '../fullscreen'
import { closeTopPanel } from '../panels'
import { appSizeLabel, knownAppFacts } from './appFacts'
import { closeAppFrame, openAppFrame } from './appFrame'
import { appIcon } from './appIcon'

// The frame host of the editor: the frames of the apps that run in the
// conversation that the editor shows. The card of an app is a widget of the
// editor (view/editor/apps.ts), and CodeMirror makes each widget again for
// a new editor state, and takes its DOM away when it scrolls far out of
// view. A frame that leaves the page ends its app, and one that moves in
// the page loads again. So a frame is never in a widget: the widget of an
// app that runs is an empty placeholder, and the frame is in a host
// element here, over the placeholder.
//
// A host element is a child of the scroller of the editor
// (`view.scrollDOM`), which no editor state replaces, with an absolute
// place. So it scrolls with the text with no code, and this module only
// gives it a new place when the layout of the text changes
// (`placeAppFrames`). The host has a bar above the frame: events in a
// frame do not reach Dez's page, so the controls of an app that runs must
// be outside of its frame.
//
// A host shows in three sizes. Only its CSS changes between them, so the
// frame never moves in the page and the app keeps its state:
// - over its card, in the text;
// - expanded (`data-expanded`): over the whole conversation view. The host
//   has a fixed place then, the box of the scroller in the window. At most
//   one host is expanded. The conversation under it takes no key and no
//   wheel turn: the expanded view counts as a modal (`isAppExpanded`;
//   `isModalOpen`, composables/useKeyboardShortcuts.ts);
// - fullscreen (`data-fullscreen`): the Fullscreen API on the host element,
//   from each of the two other sizes, to which it goes back.
//
// This module knows nothing of the editor state. The editor tells it which
// apps run (`AppRun`), and does what a control of the bar and a call of
// the page of an app (the frame bridge, model/tools/appBridge.ts) ask for
// in its state (`AppFrameActions`).

const HOST_CLASS = 'dez-app-frame'

/** One run of an app in the editor: from a click on Run to a Stop. */
export interface AppRun {
  /** A new id for each start. */
  id: string
  /** The name of the app. */
  name: string
  /** The doc position of the tag whose card started the run. */
  from: number
}

/** What the editor does for a control of the bar of a run of `view` and
 *  for a call of its page, by the id of the run, in the state that gives
 *  the runs. A call that the editor refuses rejects with an `AppCallError`,
 *  whose text the page gets. */
export interface AppFrameActions {
  /** Ends the run. */
  stop (view: EditorView, runId: string): void
  /** The trash: deletes the app of the run, after a prompt. */
  remove (view: EditorView, runId: string): void
  /** The bytes of the image or the clip `id` of the conversation. */
  readAsset (view: EditorView, id: string): Promise<Blob>
  /** Puts the save `blob` of the page of the run into the conversation.
   *  `saves` counts the saves of the run. */
  saveAsset (view: EditorView, runId: string, blob: Blob, saves: SaveCount): Promise<SavedAssetAnswer>
}

/** The attribute of the element that the frame of a run covers (the
 *  placeholder of the run). Its value is the id of the run. */
export const FRAME_PLACE_ATTRIBUTE = 'data-app-frame-place'

// A place in px: of a host over its card, from the start of the scrollable
// area of the scroller; of an expanded host, in the window.
interface Box {
  left: number
  top: number
  width: number
  height: number
}

interface HostedFrame {
  element: HTMLDivElement
  frame: HTMLIFrameElement
  expandButton: HTMLButtonElement
  fullscreenButton: HTMLButtonElement
  /** The place of the host over its card, to which an expanded host goes
   *  back; null before the first one. */
  box: Box | null
  /** The place that the styles of `element` have now. */
  styled: Box | null
}

// The hosted frames of each editor, by the id of their run.
const framesOfView = new WeakMap<EditorView, Map<string, HostedFrame>>()

// The host that covers the conversation view now, with its editor; null
// when none is expanded. `onEditorFocus` is the listener that closes the
// view when the editor gets the keyboard.
let expanded: { view: EditorView, hosted: HostedFrame, onEditorFocus: () => void } | null = null

// The icons of the bar. The corner marks of fullscreen are those of the
// media player (media/MediaPlayer.vue).
const BAR_ICON_PATHS = {
  // Two arrows that point out of the box.
  expand: 'M9.5 2.5h4v4M13.5 2.5L9 7M6.5 13.5h-4v-4M2.5 13.5L7 9',
  // Two arrows that point into the box.
  collapse: 'M13.5 6.5h-4v-4M9.5 6.5L14 2M2.5 9.5h4v4M6.5 9.5L2 14',
  fullscreen: 'M2.6 6V2.6H6M10 2.6h3.4V6M13.4 10v3.4H10M6 13.4H2.6V10',
  leaveFullscreen: 'M6 2.6V6H2.6M13.4 6H10V2.6M10 13.4V10h3.4M2.6 10H6v3.4',
}

function barPart(part: string, text = ''): HTMLSpanElement {
  const element = document.createElement('span')
  element.className = `${HOST_CLASS}__${part}`
  element.textContent = text
  return element
}

// A button of the bar that shows only an icon. `label` is its tooltip and
// its name for a screen reader.
function showIconButton(button: HTMLButtonElement, icon: SVGSVGElement, label: string): void {
  button.replaceChildren(icon)
  button.title = label
  button.setAttribute('aria-label', label)
}

function iconButton(action: string): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = `${HOST_CLASS}__button`
  button.dataset.action = action
  return button
}

function barIcon(icon: keyof typeof BAR_ICON_PATHS): SVGSVGElement {
  return svgIcon('0 0 16 16', [['path', { d: BAR_ICON_PATHS[icon], ...ROUND_STROKE, 'stroke-width': '1.4' }]])
}

// Shows on the host whether it is expanded: the attribute that its CSS
// reads, and the button that then closes the view.
function showExpanded(hosted: HostedFrame, on: boolean): void {
  hosted.element.toggleAttribute('data-expanded', on)
  showIconButton(hosted.expandButton, barIcon(on ? 'collapse' : 'expand'), on ? 'Close the expanded view' : 'Expand the app over the conversation')
}

function showFullscreen(hosted: HostedFrame, on: boolean): void {
  hosted.element.toggleAttribute('data-fullscreen', on)
  showIconButton(hosted.fullscreenButton, barIcon(on ? 'leaveFullscreen' : 'fullscreen'), on ? 'Leave fullscreen' : 'Fullscreen')
}

// Writes only the styles that change: a write of the same place would
// still make the browser check the layout again.
function place(hosted: HostedFrame, box: Box): void {
  const { style } = hosted.element
  for (const side of ['left', 'top', 'width', 'height'] as const) {
    if (hosted.styled?.[side] !== box[side]) style[side] = `${box[side]}px`
  }
  hosted.styled = box
}

// The place of a host that covers the conversation view of `view`: the box
// of the scroller in the window, with its scrollbar.
function coverBox(view: EditorView): Box {
  const { left, top, width, height } = view.scrollDOM.getBoundingClientRect()
  return { left, top, width, height }
}

// Puts the expanded host back over its card. The keyboard stays where it
// is.
function collapse(): void {
  if (!expanded) return
  const { view, hosted, onEditorFocus } = expanded
  expanded = null
  view.contentDOM.removeEventListener('focusin', onEditorFocus)
  showExpanded(hosted, false)
  if (hosted.box) place(hosted, hosted.box)
}

// Shows `hosted` over the whole conversation view of `view`, with the
// keyboard in its app.
function expand(view: EditorView, hosted: HostedFrame): void {
  collapse()
  // Find has no text to show under an app, and its dropdown would cover
  // the buttons of the bar. The close gives the keyboard to the editor,
  // before the listener below is there.
  sbp('dez.editor/closeFind')
  // The user must never type into text that the app covers: the view
  // closes when the editor gets the keyboard (Shift+Tab from the bar, a
  // key of Dez that goes to the editor).
  const onEditorFocus = () => collapse()
  view.contentDOM.addEventListener('focusin', onEditorFocus)
  expanded = { view, hosted, onEditorFocus }
  showExpanded(hosted, true)
  place(hosted, coverBox(view))
  hosted.frame.focus({ preventScroll: true })
}

/** Whether an app covers the conversation view (the expanded view). */
export function isAppExpanded(): boolean {
  return expanded !== null
}

/** Closes the expanded view, for Escape in Dez's page. Returns whether one
 *  was open. */
export function closeExpandedApp(): boolean {
  if (!expanded) return false
  collapse()
  return true
}

/** Whether `element` is a part of the host of an app that runs: its frame,
 *  or a control of its bar. Such an element takes the focus on its own;
 *  the editor around it does not stand in for it. */
export function inAppFrameHost(element: Element): boolean {
  return element.closest(`.${HOST_CLASS}`) !== null
}

function toggleFullscreen({ element }: HostedFrame): void {
  if (document.fullscreenElement === element) {
    void leaveFullscreen(element)
    return
  }
  element.requestFullscreen().catch((error: unknown) => console.error('Failed to show an app in fullscreen:', error))
}

// Escape in the app of `hosted`, which has the keyboard: one step out for
// each key. Out of fullscreen, then out of the expanded view, then the
// keyboard goes back to the editor. A panel or a prompt of Dez that is
// over the app closes before the last two steps, as it does for Escape in
// Dez's page (`closeOnEscape`, composables/useKeyboardShortcuts.ts): a
// button of Dez that opens a panel leaves the keyboard in the app.
//
// On Linux the first step is the work of WebKitGTK, which takes Escape for
// itself while a page shows in fullscreen (`webkitWebViewBaseKeyPressed`
// in its WebKitWebViewBase.cpp): the page of the app does not get the key,
// also when a field of the app would keep Escape for itself. It takes `f`
// and `F` the same way, so an app in fullscreen cannot get those two
// letters there: the key leaves fullscreen, and a text field gets no
// letter.
function stepOut(view: EditorView, hosted: HostedFrame): void {
  if (document.fullscreenElement === hosted.element) void leaveFullscreen(hosted.element)
  else if (closeTopPanel()) return
  else if (expanded?.hosted === hosted) collapse()
  else focusKeepingScroll(view)
}

// The host element of the run `run`, not yet in the page. `actions` change
// the editor state, which then takes the frame away.
function hostFrame(view: EditorView, run: AppRun, actions: AppFrameActions): HostedFrame {
  const element = document.createElement('div')
  element.className = HOST_CLASS
  element.dataset.app = run.name
  element.dataset.run = run.id

  const bar = document.createElement('div')
  bar.className = `${HOST_CLASS}__bar`
  // A press on the bar takes the keyboard from no one: not from the app,
  // and not from the editor.
  bar.addEventListener('mousedown', (event) => event.preventDefault())
  // A context click shows Dez's menu of the app, in place of the menu of
  // the webview.
  bar.addEventListener('contextmenu', (event) => {
    event.preventDefault()
    void sbp('dez.controller/apps/popupMenu', run.name)
  })
  const icon = barPart('icon')
  icon.append(appIcon())
  const expandButton = iconButton('expand')
  const fullscreenButton = iconButton('fullscreen')
  const stopButton = document.createElement('button')
  stopButton.type = 'button'
  stopButton.className = `${HOST_CLASS}__stop`
  stopButton.textContent = 'Stop'
  stopButton.title = `Stop the app ${run.name}`
  stopButton.addEventListener('click', () => actions.stop(view, run.id))
  const trashButton = iconButton('delete')
  showIconButton(trashButton, trashIcon(), `Delete the app ${run.name}`)
  trashButton.addEventListener('click', () => actions.remove(view, run.id))
  // The size is that of the start of the run: the card read the files of
  // the app then.
  bar.append(icon, barPart('name', run.name), barPart('size', appSizeLabel(knownAppFacts(run.name))), expandButton, fullscreenButton, stopButton, trashButton)

  const saves = new SaveCount()
  const frame = openAppFrame(run.name, {
    // `ready` and `answer` are for a run that calls a handler of the page
    // (hiddenAppFrame.ts): a shown app has no such call.
    onMessage(message) {
      // A frame that is far out of view runs slowly, so its message can
      // come after the user gave the keyboard to something else, or moved
      // the pointer away. The page of an app can also send a message that
      // no key and no click made.
      if (message.dez === 'escape') {
        if (document.activeElement === frame) stepOut(view, hosted)
      } else if (message.dez === 'menu' && frame.matches(':hover')) {
        // The menu shows at the pointer, so only while it is over the app.
        void sbp('dez.controller/apps/popupMenu', run.name)
      }
    },
    async onCall(call) {
      if (call.selector === APP_READ_ASSET) return await actions.readAsset(view, call.id)
      // A save puts a file into the message that the user writes. The page
      // of an app can ask for one at any time (a timer, a model's code
      // that runs on its own), so Dez takes it only while the user works
      // in the app: the app has the keyboard, or the pointer is over it.
      // Dez's page cannot read whether a key or a click made the call.
      // The frame stays the active element while the user works in another
      // program, so the keyboard rule also needs Dez's window to have the
      // focus (`hasFocus()` is true while a frame of the page has it). The
      // pointer rule has no such check, so that the click that brings Dez's
      // window to the front can save: Dez does not know whether WebKit
      // tells the page of the focus before that click.
      const hasKeyboard = document.hasFocus() && document.activeElement === frame
      if (!hasKeyboard && !frame.matches(':hover')) throw new AppCallError(SAVE_NEEDS_USER_TEXT)
      return await actions.saveAsset(view, run.id, call.blob, saves)
    },
    onNavigated() {
      // The toast is outside of an app that fills the screen.
      void leaveFullscreen(element)
      actions.stop(view, run.id)
      sbp('dez.ui/toast', 'app-global', {
        title: `Dez stopped the app ${run.name}`,
        message: 'The app went to another page, or loaded its page again. Dez shows only the one page of an app. Start the app again with Run.',
        variant: 'warning',
        duration: 10000,
      })
    },
  })
  frame.className = `${HOST_CLASS}__page`
  element.append(bar, frame)

  const hosted: HostedFrame = { element, frame, expandButton, fullscreenButton, box: null, styled: null }
  showExpanded(hosted, false)
  showFullscreen(hosted, false)
  expandButton.addEventListener('click', () => (expanded?.hosted === hosted ? collapse() : expand(view, hosted)))
  fullscreenButton.addEventListener('click', () => toggleFullscreen(hosted))
  element.addEventListener('fullscreenchange', () => {
    const on = document.fullscreenElement === element
    showFullscreen(hosted, on)
    // The user went to fullscreen for the app, so the keys go to it, and
    // not to an editor that is out of view.
    if (on) frame.focus({ preventScroll: true })
  })
  // The scroller is the scroll parent of the host: a wheel turn that the
  // app does not take scrolls the conversation. Under a host that covers
  // it, the user would not see the text go, and would find it at another
  // place later. WebKit gives the wheel event of a frame that did not
  // scroll to the `<iframe>` element, so this listener gets it too.
  element.addEventListener('wheel', (event) => {
    if (expanded?.hosted === hosted || document.fullscreenElement === element) event.preventDefault()
  }, { passive: false })
  return hosted
}

// Where the host of `run` goes: over the placeholder of the run when the
// editor draws it, else at the place that the editor keeps for the line of
// the tag (its height map), with the size that the host had before.
//
// The place is counted from the box of the editor content, which scrolls
// with the host: so a scroll position is no part of it.
function boxOf(view: EditorView, run: AppRun, last: Box | null): Box {
  const content = view.contentDOM
  const contentRect = content.getBoundingClientRect()
  const placeholder = content.querySelector(`[${FRAME_PLACE_ATTRIBUTE}="${run.id}"]`)
  if (placeholder) {
    const rect = placeholder.getBoundingClientRect()
    return {
      left: rect.left - contentRect.left + content.offsetLeft,
      top: rect.top - contentRect.top + content.offsetTop,
      width: rect.width,
      height: rect.height,
    }
  }
  const block = view.lineBlockAt(run.from)
  const blockTop = block.top + view.documentTop - contentRect.top + content.offsetTop
  // The placeholder is in the middle of its line.
  if (last) return { ...last, top: blockTop + (block.height - last.height) / 2 }
  return { left: content.offsetLeft, top: blockTop, width: contentRect.width, height: block.height }
}

// Takes the frames of the runs that `keep` does not hold out of the page.
// True when the editor must get the keyboard: one of the frames had it
// (its app, or a control of its bar), or the expanded view went and
// nothing has it.
function removeFrames(frames: Map<string, HostedFrame>, keep: ReadonlySet<string>): boolean {
  let editorGetsFocus = false
  for (const [id, hosted] of frames) {
    if (keep.has(id)) continue
    editorGetsFocus ||= hosted.element.contains(document.activeElement)
    if (expanded?.hosted === hosted) {
      collapse()
      // While the view was open, the editor took no focus that Dez gave it
      // (`dez.editor/focus` does nothing under a modal): that of a switch
      // to another tab, which ends the run, is lost.
      editorGetsFocus ||= !document.activeElement || document.activeElement === document.body
    }
    void leaveFullscreen(hosted.element)
    closeAppFrame(hosted.frame)
    hosted.element.remove()
    frames.delete(id)
  }
  return editorGetsFocus
}

/** Makes the frames of `view` those of `runs`, each at the place of its
 *  run: starts the frame of a new run, with the keyboard in it, and takes
 *  away each frame whose run is not in `runs`. The editor then gets the
 *  keyboard back, when such a frame had it. Call it after each change of
 *  the runs or of the layout of the text, when the DOM of the editor is up
 *  to date. `actions` is what the controls of a bar do in the state that
 *  gives `runs`. */
export function placeAppFrames(view: EditorView, runs: readonly AppRun[], actions: AppFrameActions): void {
  let frames = framesOfView.get(view)
  if (!frames) {
    if (runs.length === 0) return
    frames = new Map()
    framesOfView.set(view, frames)
  }
  if (removeFrames(frames, new Set(runs.map((run) => run.id)))) focusKeepingScroll(view)
  for (const run of runs) {
    let hosted = frames.get(run.id)
    const started = !hosted
    if (!hosted) {
      hosted = hostFrame(view, run, actions)
      frames.set(run.id, hosted)
    }
    hosted.box = boxOf(view, run, hosted.box)
    place(hosted, expanded?.hosted === hosted ? coverBox(view) : hosted.box)
    if (started) {
      // After its first place, so that the page loads at its size.
      view.scrollDOM.append(hosted.element)
      // The user started the app, so the keys go to it at once. The frame
      // is in view (the click was on its card), and no focus may scroll
      // the editor. The keys go to the page as a whole, and Tab goes to
      // its first field: WebKit ignores a `focus()` call of the page's own
      // script until the first key or click of the user in the frame.
      hosted.frame.focus({ preventScroll: true })
    }
  }
}

/** Takes every frame of `view` out of the page, for an editor that goes
 *  away. */
export function removeAppFrames(view: EditorView): void {
  const frames = framesOfView.get(view)
  if (frames) removeFrames(frames, new Set())
}

/** The frame of `view` that has the keyboard; null when the keys go
 *  anywhere else. */
export function focusedAppFrame(view: EditorView): HTMLIFrameElement | null {
  const focused = document.activeElement
  for (const hosted of framesOfView.get(view)?.values() ?? []) {
    if (hosted.frame === focused) return hosted.frame
  }
  return null
}
