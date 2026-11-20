import type { EditorView } from '@codemirror/view'
import sbp from '@sbp/sbp'
import { focusKeepingScroll } from '../editor/focus'
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
// This module knows nothing of the editor state. The editor tells it which
// apps run (`AppRun`), and takes back a run that ends here (`stop`).

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

/** The attribute of the element that the frame of a run covers (the
 *  placeholder of the run). Its value is the id of the run. */
export const FRAME_PLACE_ATTRIBUTE = 'data-app-frame-place'

// A place in the scroller, in px from the start of its scrollable area.
interface Box {
  left: number
  top: number
  width: number
  height: number
}

interface HostedFrame {
  element: HTMLDivElement
  frame: HTMLIFrameElement
  /** The place that the styles of `element` have now; null before the
   *  first one. */
  box: Box | null
}

// The hosted frames of each editor, by the id of their run.
const framesOfView = new WeakMap<EditorView, Map<string, HostedFrame>>()

// The host element of the run `run`, not yet in the page. `stop` ends the
// run in the editor state, which then takes the frame away.
function hostFrame(view: EditorView, run: AppRun, stop: (runId: string) => void): HostedFrame {
  const element = document.createElement('div')
  element.className = HOST_CLASS
  element.dataset.app = run.name
  element.dataset.run = run.id

  const bar = document.createElement('div')
  bar.className = `${HOST_CLASS}__bar`
  // A press on the bar takes the keyboard from no one: not from the app,
  // and not from the editor.
  bar.addEventListener('mousedown', (event) => event.preventDefault())
  const icon = document.createElement('span')
  icon.className = `${HOST_CLASS}__icon`
  icon.append(appIcon())
  const name = document.createElement('span')
  name.className = `${HOST_CLASS}__name`
  name.textContent = run.name
  const stopButton = document.createElement('button')
  stopButton.type = 'button'
  stopButton.className = `${HOST_CLASS}__stop`
  stopButton.textContent = 'Stop'
  stopButton.title = `Stop the app ${run.name}`
  stopButton.addEventListener('click', () => stop(run.id))
  bar.append(icon, name, stopButton)

  const frame = openAppFrame(run.name, {
    onMessage(message) {
      // Escape in the app gives the keyboard back to the editor. A frame
      // that is far out of view runs slowly, so its message can come after
      // the user gave the keyboard to something else.
      if (message.dez === 'escape' && document.activeElement === frame) focusKeepingScroll(view)
    },
    onNavigated() {
      stop(run.id)
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
  return { element, frame, box: null }
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

// Writes only the styles that change: a write of the same place would
// still make the browser check the layout again.
function place(hosted: HostedFrame, box: Box): void {
  const { style } = hosted.element
  for (const side of ['left', 'top', 'width', 'height'] as const) {
    if (hosted.box?.[side] !== box[side]) style[side] = `${box[side]}px`
  }
  hosted.box = box
}

// Takes the frames of the runs that `keep` does not hold out of the page.
// True when one of them had the keyboard (its app, or a control of its
// bar).
function removeFrames(frames: Map<string, HostedFrame>, keep: ReadonlySet<string>): boolean {
  let hadFocus = false
  for (const [id, hosted] of frames) {
    if (keep.has(id)) continue
    hadFocus ||= hosted.element.contains(document.activeElement)
    closeAppFrame(hosted.frame)
    hosted.element.remove()
    frames.delete(id)
  }
  return hadFocus
}

/** Makes the frames of `view` those of `runs`, each at the place of its
 *  run: starts the frame of a new run, with the keyboard in it, and takes
 *  away each frame whose run is not in `runs`. The editor then gets the
 *  keyboard back, when such a frame had it. Call it after each change of
 *  the runs or of the layout of the text, when the DOM of the editor is up
 *  to date. `stop` ends a run, by its id, in the state that gives `runs`. */
export function placeAppFrames(view: EditorView, runs: readonly AppRun[], stop: (runId: string) => void): void {
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
      hosted = hostFrame(view, run, stop)
      frames.set(run.id, hosted)
    }
    place(hosted, boxOf(view, run, hosted.box))
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
