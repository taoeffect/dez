import sbp from '@sbp/sbp'
import { EditorSelection } from '@codemirror/state'
import { EditorView, runScopeHandlers } from '@codemirror/view'
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
import { isMacPlatform } from '../../utils/platform'

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

function handleVisibleScroll(tabId: string): void {
  if (!activeView || activeViewTabId !== tabId) return
  if (streamingScrollRestorePending) return
  followingStreamTabId = isNearScrollBottom(activeView) ? tabId : null
}

/** What `dez.editor/runKeyBinding` does while a native text field (an
 *  `<input>` or `<textarea>`, such as the find field) has focus: run the
 *  binding in the editor anyway, do nothing, or run this
 *  `document.execCommand` edit command in the field. */
export type TextFieldAction = 'editor' | 'none' | 'insertLineBreak' | 'undo' | 'redo' | 'selectAll'

const KEY_NAME_MODIFIERS: Record<string, true> = { Mod: true, Ctrl: true, Meta: true, Alt: true, Shift: true }

// A synthetic keydown for a CodeMirror key name such as `Mod-Shift-z`, for
// the platform that CodeMirror's keymaps use (`Mod` is Cmd on macOS, else
// Ctrl). `keyCode` is set for letters and digits because CodeMirror finds a
// Shift+letter binding through it: with `key` "Z" and no keyCode, no
// binding matches `Mod-Shift-z`, and with `key` "z" the `Mod-z` binding runs.
function keydownForKeyName (name: string): KeyboardEvent {
  const parts = name.split(/-(?!$)/)
  const key = parts.pop() ?? ''
  for (const modifier of parts) {
    if (Object.hasOwn(KEY_NAME_MODIFIERS, modifier)) continue
    const error = new Error(`Unknown modifier "${modifier}" in key name "${name}"`)
    console.error(error)
    throw error
  }
  const shiftKey = parts.includes('Shift')
  const mod = parts.includes('Mod')
  return new KeyboardEvent('keydown', {
    key: shiftKey && key.length === 1 ? key.toUpperCase() : key,
    keyCode: /^[a-z0-9]$/i.test(key) ? key.toUpperCase().charCodeAt(0) : 0,
    ctrlKey: parts.includes('Ctrl') || (mod && !isMacPlatform),
    metaKey: parts.includes('Meta') || (mod && isMacPlatform),
    altKey: parts.includes('Alt'),
    shiftKey,
    cancelable: true,
  })
}

export default sbp('sbp/selectors/register', {
  'dez.editor/registerActiveView' (tabId: string, view: EditorView): void {
    if (activeView && activeScrollHandler) {
      activeView.scrollDOM.removeEventListener('scroll', activeScrollHandler)
    }
    activeViewTabId = tabId
    activeView = view
    activeScrollHandler = () => handleVisibleScroll(tabId)
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

  'dez.editor/startStreamingFollowIfVisible' (tabId: string): boolean {
    if (!activeView || activeViewTabId !== tabId) return false
    followingStreamTabId = isNearScrollBottom(activeView) ? tabId : null
    return followingStreamTabId === tabId
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
    sbp('okTurtles.events/emit', 'dez.editor.stream-finished', tabId)
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

  /** Run an editor key binding (a CodeMirror key name such as `Mod-Enter`)
   *  without a key press, for the native menu. The editor keymaps stay the
   *  only definition of these keys, with all their checks (an open prompt
   *  autocomplete, several cursors, section splits). On Linux a menu
   *  accelerator takes the key before the page sees it, so the menu item
   *  must do what the key would do where focus is; see `TextFieldAction`.
   *  Without a focused text field, every action except `'editor'` focuses
   *  the editor before the binding runs. While Settings or History covers
   *  the editor, the binding runs only if the editor still has focus, as a
   *  key press would. Returns whether anything ran. */
  'dez.editor/runKeyBinding' (key: string, inTextField: TextFieldAction = 'editor'): boolean {
    const focused = document.activeElement
    if (inTextField !== 'editor' && (focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement)) {
      // execCommand is deprecated, but it is the only way for a script to
      // run the field's own edit commands (its undo stack, a line break).
      return inTextField !== 'none' && document.execCommand(inTextField)
    }
    const view = activeView
    if (!view || (isModalOpen() && !view.hasFocus)) return false
    if (inTextField !== 'editor' && !view.hasFocus) view.focus()
    return runScopeHandlers(view, keydownForKeyName(key), 'editor')
  },
})
