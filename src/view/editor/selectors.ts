import sbp from '@sbp/sbp'
import { EditorSelection, Transaction, type TransactionSpec } from '@codemirror/state'
import { EditorView, runScopeHandlers } from '@codemirror/view'
import type { SectionThinking } from '../../model/chat/types'
import { SCROLLER_PADDING_PX, serializeSelectionAsMarkdown, setSectionThinkingEffect } from '../thread/cmEditor'
import {
  createFindQuery,
  findMatchAt,
  findNextMatch,
  findPrefillText,
  findPreviousMatch,
  findQueryField,
  replaceAllMatchesTransaction,
  replaceMatchTransaction,
  selectMatchSpec,
  setFindQueryEffect,
} from './find'
import { findHistory } from './findHistory'
import { findState } from './findState'
import { isModalOpen } from '../composables/useKeyboardShortcuts'
import { currentShortcutPlatform, findShortcut, keyEventInit, resolveShortcuts, type ShortcutIdOfScope } from '../../model/shortcuts'

/** Scroll positions can be fractions of a pixel: a view this close to its
 *  bottom is at its bottom. */
const AT_BOTTOM_PX = 1

/** A scroll down that ends this close to the bottom starts the follow
 *  again: the last line then shows in full. Ctrl+End stops in this zone,
 *  because CodeMirror scrolls the caret into view with a 5 px margin,
 *  which is less than the scroller's bottom padding. */
const RESUME_FOLLOW_PX = SCROLLER_PADDING_PX

let activeView: EditorView | null = null
let activeViewTabId: string | null = null
let activeScrollHandler: (() => void) | null = null
/** The tab whose registered view follows the text that its stream adds. */
let followingStreamTabId: string | null = null
/** The scrollTop of the registered view at its last scroll event. */
let lastScrollTop = 0
let followFrameRequested = false

// In the next frame, after the browser laid out the changes, scroll the
// registered view to its bottom if it still follows its stream then: a user
// scroll up in between wins. One frame serves all changes before it.
function followToBottomNextFrame(): void {
  if (followFrameRequested) return
  followFrameRequested = true
  requestAnimationFrame(() => {
    followFrameRequested = false
    if (!activeView || followingStreamTabId === null || followingStreamTabId !== activeViewTabId) return
    activeView.scrollDOM.scrollTop = activeView.scrollDOM.scrollHeight
  })
}

// A scroll up by the user stops the follow, and a scroll down to the bottom
// starts it again. Only the user moves a view up while it is not at its
// bottom: new text, the follow scroll, and CodeMirror's scroll anchoring
// (it keeps the top line in place when the doc grows below it) never do.
// So this one rule covers the wheel, the scrollbar, keys and find jumps.
// The distance from the bottom alone cannot tell a user scroll from new
// text, because a scroll event can come after more text arrived.
// So code that runs without a user action must not scroll a view up, or
// scroll a view that does not follow: that looks like a user scroll, and
// stops or starts the follow.
// `tests/e2e/stream-follow.e2e.ts` covers the rules.
function handleVisibleScroll(tabId: string): void {
  if (!activeView || activeViewTabId !== tabId) return
  const scroll = activeView.scrollDOM
  const previousScrollTop = lastScrollTop
  lastScrollTop = scroll.scrollTop
  const fromBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight
  if (followingStreamTabId === tabId) {
    // A shorter doc also moves a view up, but leaves it at its bottom.
    if (scroll.scrollTop < previousScrollTop && fromBottom > AT_BOTTOM_PX) followingStreamTabId = null
  } else if (scroll.scrollTop > previousScrollTop && fromBottom <= RESUME_FOLLOW_PX) {
    followingStreamTabId = tabId
  }
}

// A streamed change makes the doc taller. A view that follows the stream
// then scrolls to the new bottom; any other view stays where it is.
function dispatchStreamChange(view: EditorView, tabId: string, spec: TransactionSpec): void {
  view.dispatch(spec)
  if (followingStreamTabId === tabId) followToBottomNextFrame()
}

/** What `dez.editor/runKeyBinding` does while a native text field (an
 *  `<input>` or `<textarea>`, such as the find field) has focus: run the
 *  binding in the editor anyway, do nothing, or run this
 *  `document.execCommand` edit command in the field. */
export type TextFieldAction = 'editor' | 'none' | 'insertLineBreak' | 'undo' | 'redo' | 'selectAll'

export default sbp('sbp/selectors/register', {
  /** A view that becomes visible does not follow a stream until the user
   *  scrolls it to the bottom. */
  'dez.editor/registerActiveView' (tabId: string, view: EditorView): void {
    if (activeView && activeScrollHandler) {
      activeView.scrollDOM.removeEventListener('scroll', activeScrollHandler)
    }
    activeViewTabId = tabId
    activeView = view
    activeScrollHandler = () => handleVisibleScroll(tabId)
    view.scrollDOM.addEventListener('scroll', activeScrollHandler, { passive: true })
    followingStreamTabId = null
    lastScrollTop = view.scrollDOM.scrollTop
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

  /** When a reply starts in the visible tab, its view follows the reply,
   *  wherever the user had scrolled to: the next frame scrolls it to the
   *  bottom. Returns whether the tab is visible. */
  'dez.editor/startStreamingFollowIfVisible' (tabId: string): boolean {
    if (!activeView || activeViewTabId !== tabId) return false
    followingStreamTabId = tabId
    followToBottomNextFrame()
    return true
  },

  /** Appends a streamed token to the registered view of `tabId`. Does
   *  nothing and returns false when another tab is visible; the store
   *  already has the token. The token goes at the doc end, so `sectionId`
   *  is not used: at stream start the streaming agent section is the last
   *  section (`dez.model/ensureTrailingAgentSectionForTab`). */
  'dez.editor/appendTokenIfVisible' (tabId: string, _sectionId: string, token: string): boolean {
    if (!activeView || activeViewTabId !== tabId) return false
    dispatchStreamChange(activeView, tabId, {
      changes: { from: activeView.state.doc.length, insert: token },
    })
    return true
  },

  /** Shows the new thinking of a streaming section in the registered view
   *  of `tabId`, or removes it when `thinking` is absent. Does nothing and
   *  returns false when another tab is visible. The store holds thinking
   *  separately: the editor writes sections back to the store only on doc
   *  changes, and this changes no doc text. Not an undo step: an undo must
   *  not remove thinking that the stream still writes. */
  'dez.editor/setSectionThinkingIfVisible' (tabId: string, sectionId: string, thinking?: SectionThinking): boolean {
    if (!activeView || activeViewTabId !== tabId) return false
    dispatchStreamChange(activeView, tabId, {
      effects: setSectionThinkingEffect.of({ sectionId, ...(thinking && { thinking }) }),
      annotations: Transaction.addToHistory.of(false),
    })
    return true
  },

  /** Ends the follow of the stream of `tabId`, and lets the editor of a
   *  visible tab rebuild its state from the store. The event tells the
   *  editor whether the view still followed the stream: only then does the
   *  rebuild scroll to the bottom, else it keeps the user's scroll
   *  position. */
  'dez.editor/reconcileAfterStreamFinish' (tabId: string): void {
    const following = followingStreamTabId === tabId
    if (following) followingStreamTabId = null
    if (activeViewTabId !== tabId) return
    sbp('okTurtles.events/emit', 'dez.editor.stream-finished', tabId, following)
  },

  /** Cmd/Ctrl+F: open the find dropdown (or refocus it), prefilled from the
   *  editor selection when `findPrefillText` allows it. Does nothing while
   *  Settings or History covers the editor. Returns whether it opened. */
  'dez.editor/openFind' (): boolean {
    const view = activeView
    if (!view || isModalOpen()) return false
    const { state } = view
    const prefill = findPrefillText(state, findState.regexp)
    findState.origin = state.selection.main.from
    if (prefill !== null) findState.search = prefill
    findState.open = true
    findState.focusRequest++
    // ArrowUp in the field starts a new browse from the shown text.
    findHistory.resetBrowse()
    return true
  },

  /** Close the dropdown, add the search to the history, clear the match
   *  marks, and return focus to the editor. A selected match collapses to a
   *  cursor at its end, so no highlighted text is left behind. */
  'dez.editor/closeFind' (): void {
    if (!findState.open) return
    findHistory.commit(findState.search)
    findState.open = false
    findState.status = null
    const view = activeView
    if (!view) return
    const { state } = view
    const query = state.field(findQueryField, false)
    const { main } = state.selection
    const selectedMatch = query ? findMatchAt(state, query, main.from, main.to) : null
    view.dispatch({
      effects: setFindQueryEffect.of(null),
      ...(selectedMatch && {
        selection: state.selection.replaceRange(EditorSelection.cursor(main.to)),
        userEvent: 'select',
      }),
    })
    view.focus()
  },

  /** Next/previous match from the main selection, wrapping around the doc.
   *  The match becomes the new origin for typing in the search field. The
   *  search goes into the history even without a match. Does nothing while
   *  find is closed or Settings or History covers the editor. Returns
   *  whether it searched. */
  'dez.editor/selectFindMatch' (direction: 'next' | 'previous'): boolean {
    const view = activeView
    if (!view || !findState.open || isModalOpen()) return false
    findHistory.commit(findState.search)
    const { state } = view
    const query = state.field(findQueryField, false)
    if (!query) return true
    const { main } = state.selection
    const match = direction === 'next'
      ? findNextMatch(state, query, main.to)
      : findPreviousMatch(state, query, main.from)
    if (!match) return true
    findState.origin = match.from
    view.dispatch(selectMatchSpec(match))
    return true
  },

  /** "Replace" ('current') or "Replace all" ('all') with the replace field
   *  text; see `replaceMatchTransaction` / `replaceAllMatchesTransaction`.
   *  Each call is one transaction, so one undo step and one store sync.
   *  The search goes into the history. */
  'dez.editor/replaceFindMatches' (scope: 'current' | 'all'): void {
    const view = activeView
    if (!view || !findState.open) return
    findHistory.commit(findState.search)
    const query = createFindQuery(findState, findState.replace)
    if (scope === 'all') {
      const spec = replaceAllMatchesTransaction(view.state, query)
      if (spec) view.dispatch(spec)
    } else {
      const spec = replaceMatchTransaction(view.state, query)
      if (!spec?.selection) return
      // The spec's selection is already in post-change positions, which is
      // what effects in the same spec refer to.
      view.dispatch({ ...spec, effects: EditorView.scrollIntoView(spec.selection.main) })
    }
    // Typing in the search field next searches from the replaced spot.
    findState.origin = view.state.selection.main.from
  },

  /** Run an editor shortcut (`src/model/shortcuts.ts`) through its current
   *  key without a key press, for the native menu and the Submit button.
   *  The editor keymap stays the only definition of these actions, with all
   *  their checks (an open prompt autocomplete, several cursors, section
   *  splits). On Linux a menu accelerator takes the key before the page
   *  sees it, so the menu item must do what the key would do where focus
   *  is; see `TextFieldAction`. Without a focused text field, every action
   *  except `'editor'` focuses the editor before the binding runs. While
   *  Settings or History covers the editor, the binding runs only if the
   *  editor still has focus, as a key press would. Returns whether anything
   *  ran. */
  'dez.editor/runKeyBinding' (id: ShortcutIdOfScope<'editor'>, inTextField: TextFieldAction = 'editor'): boolean {
    const focused = document.activeElement
    if (inTextField !== 'editor' && (focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement)) {
      // execCommand is deprecated, but it is the only way for a script to
      // run the field's own edit commands (its undo stack, a line break).
      return inTextField !== 'none' && document.execCommand(inTextField)
    }
    const view = activeView
    if (!view || (isModalOpen() && !view.hasFocus)) return false
    const { key } = findShortcut(resolveShortcuts(currentShortcutPlatform), id)
    if (inTextField !== 'editor' && !view.hasFocus) view.focus()
    return runScopeHandlers(view, new KeyboardEvent('keydown', { ...keyEventInit(key), cancelable: true }), 'editor')
  },

  /** Copy Markdown (Cmd/Ctrl+Shift+C): copy the editor selection as the
   *  Markdown of Save As Markdown (`serializeSelectionAsMarkdown`). On Linux
   *  the menu accelerator takes this key from every field, so a focused text
   *  field (the find field, a thinking panel) copies its own selected text as
   *  is. A password field gives nothing, as it does to a normal copy. Focus
   *  decides, not an open modal: with focus anywhere else, nothing is
   *  copied. Returns whether it copied. */
  'dez.editor/copyMarkdown' (): boolean {
    const focused = document.activeElement
    let text = ''
    if (focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement) {
      const { selectionStart, selectionEnd } = focused
      if (focused.type !== 'password' && selectionStart !== null && selectionEnd !== null) {
        text = focused.value.slice(selectionStart, selectionEnd)
      }
    } else if (activeView?.hasFocus) {
      text = serializeSelectionAsMarkdown(activeView.state)
    }
    if (text === '') return false
    sbp('dez.ui/copyText', text).catch((error: unknown) => console.error('Copy Markdown failed:', error))
    return true
  },
})
