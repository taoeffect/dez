import sbp from '@sbp/sbp'
import type { EditorView } from '@codemirror/view'

const STREAM_FINISHED_EVENT = 'dez.editor.stream-finished'
const BOTTOM_FOLLOW_THRESHOLD_PX = 96

let activeView: EditorView | null = null
let activeViewTabId: string | null = null
let activeScrollHandler: (() => void) | null = null
let followingStreamTabId: string | null = null
let streamingScrollRestorePending = false

function isNearScrollBottom(view: EditorView): boolean {
  const scroll = view.scrollDOM
  return scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight <= BOTTOM_FOLLOW_THRESHOLD_PX
}

function scrollViewToBottomAfterLayout(view: EditorView): void {
  requestAnimationFrame(() => {
    if (activeView !== view) return
    view.scrollDOM.scrollTop = view.scrollDOM.scrollHeight
  })
}

function restoreScrollAfterLayout(view: EditorView, scrollTop: number): void {
  streamingScrollRestorePending = true
  requestAnimationFrame(() => {
    if (activeView === view) view.scrollDOM.scrollTop = scrollTop
    streamingScrollRestorePending = false
  })
}

export default sbp('sbp/selectors/register', {
  'dez.editor/registerActiveView' (tabId: string, view: EditorView): void {
    if (activeView && activeScrollHandler) {
      activeView.scrollDOM.removeEventListener('scroll', activeScrollHandler)
    }
    activeViewTabId = tabId
    activeView = view
    activeScrollHandler = () => sbp('dez.editor/handleVisibleScroll', tabId)
    view.scrollDOM.addEventListener('scroll', activeScrollHandler, { passive: true })
    followingStreamTabId = null
  },

  'dez.editor/unregisterActiveView' (tabId: string): void {
    if (activeViewTabId !== tabId) return
    if (activeView && activeScrollHandler) {
      activeView.scrollDOM.removeEventListener('scroll', activeScrollHandler)
    }
    activeViewTabId = null
    activeView = null
    activeScrollHandler = null
    followingStreamTabId = null
  },

  'dez.editor/activeTabId' (): string | null {
    return activeViewTabId
  },

  'dez.editor/startStreamingFollowIfVisible' (tabId: string): boolean {
    if (!activeView || activeViewTabId !== tabId) return false
    followingStreamTabId = isNearScrollBottom(activeView) ? tabId : null
    return followingStreamTabId === tabId
  },

  'dez.editor/handleVisibleScroll' (tabId: string): void {
    if (!activeView || activeViewTabId !== tabId) return
    if (streamingScrollRestorePending) return
    followingStreamTabId = isNearScrollBottom(activeView) ? tabId : null
  },

  'dez.editor/appendTokenIfVisible' (tabId: string, _sectionId: string, token: string): boolean {
    if (!activeView || activeViewTabId !== tabId) return false
    const view = activeView
    const scrollTop = view.scrollDOM.scrollTop
    const followBottom = followingStreamTabId === tabId
    view.dispatch({
      changes: { from: view.state.doc.length, insert: token },
    })
    if (followBottom) scrollViewToBottomAfterLayout(view)
    else restoreScrollAfterLayout(view, scrollTop)
    return true
  },

  'dez.editor/reconcileAfterStreamFinish' (tabId: string): void {
    if (followingStreamTabId === tabId && activeView && activeViewTabId === tabId) {
      scrollViewToBottomAfterLayout(activeView)
    }
    if (followingStreamTabId === tabId) followingStreamTabId = null
    if (activeViewTabId !== tabId) return
    sbp('okTurtles.events/emit', STREAM_FINISHED_EVENT, tabId)
  },

  'dez.editor/onStreamFinished' (handler: (tabId: string) => void): void {
    sbp('okTurtles.events/on', STREAM_FINISHED_EVENT, handler)
  },

  'dez.editor/offStreamFinished' (handler: (tabId: string) => void): void {
    sbp('okTurtles.events/off', STREAM_FINISHED_EVENT, handler)
  },
})
