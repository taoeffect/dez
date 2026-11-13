import sbp from '@sbp/sbp'
import { isolateHistory } from '@codemirror/commands'
import { StateEffect, StateField, Transaction, type ChangeSpec, type EditorState, type Extension } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'

export interface DocRange {
  from: number
  to: number
}

interface PendingRange {
  range: DocRange
  /** The tab that was active when the range was added. */
  tabId: string
}

const addPendingRangeEffect = StateEffect.define<{ id: string, pending: PendingRange }>()
const removePendingRangeEffect = StateEffect.define<string>()

/** The doc ranges that async editor work changes once it ends (an image
 *  insert after its files are saved, an image delete after its prompt and
 *  file delete), by id. A range moves with the edits made meanwhile; text
 *  typed at either edge stays out of it, so text typed at the point of an
 *  empty range goes before it. But a change that replaces text from the
 *  start of a range puts its new text in the range (`ChangeDesc.mapPos`),
 *  so check the range's text before replacing it. A new state (tab switch,
 *  the rebuild at the end of a stream) starts with no ranges, so work whose
 *  id is gone knows that its doc is gone. Right after a tab switch, the view
 *  holds the old tab's state for a tick, until the `activeTabId` watcher in
 *  ThreadEditor.vue rebuilds it: so each range keeps its tab, and
 *  `pendingRange` gives no range while another tab is active. Work that
 *  ends in that tick then acts as it does after the rebuild. */
const pendingRangesField = StateField.define<ReadonlyMap<string, PendingRange>>({
  create: () => new Map(),
  update(ranges, tr) {
    let next = ranges
    if (tr.docChanged && next.size > 0) {
      next = new Map(Array.from(next, ([id, { range, tabId }]) => {
        const from = tr.changes.mapPos(range.from, 1)
        return [id, { range: { from, to: Math.max(from, tr.changes.mapPos(range.to, -1)) }, tabId }]
      }))
    }
    for (const effect of tr.effects) {
      if (effect.is(addPendingRangeEffect)) {
        next = new Map(next).set(effect.value.id, effect.value.pending)
      } else if (effect.is(removePendingRangeEffect) && next.has(effect.value)) {
        const copy = new Map(next)
        copy.delete(effect.value)
        next = copy
      }
    }
    return next
  },
})

/** Starts to follow `range` in the view's doc, for the active tab, and
 *  returns its id. */
export function addPendingRange(view: EditorView, range: DocRange): string {
  const id = crypto.randomUUID()
  const tabId = sbp('dez.model/tabs/activeId') as string
  view.dispatch({ effects: addPendingRangeEffect.of({ id, pending: { range, tabId } }) })
  return id
}

/** Where the range of `id` is now in `state`; undefined when `state` is not
 *  the one that the range was added to, when another tab is active, or
 *  after `removePendingRange`. */
export function pendingRange(state: EditorState, id: string): DocRange | undefined {
  const pending = state.field(pendingRangesField, false)?.get(id)
  return pending && pending.tabId === sbp('dez.model/tabs/activeId') ? pending.range : undefined
}

/** Stops following the range of `id`: put it in the transaction that
 *  changes the range, or dispatch it alone when the work changes nothing. */
export function removePendingRange(id: string): StateEffect<string> {
  return removePendingRangeEffect.of(id)
}

/** Follows the shown item `start` (an image reference, a media tag) while
 *  async work on it runs (a prompt, a file save or delete). `shown` gives
 *  the items that a state shows, and `isSame` tells which of them are
 *  `start`. The doc can change meanwhile (a stream), so the item's range is
 *  a pending range. A new state of the same tab (the rebuild at the end of
 *  a stream) has no pending ranges: there the item is found again when
 *  exactly one shown item `isSame`. */
export function followShownRange<T extends DocRange>(
  view: EditorView,
  start: T,
  shown: (state: EditorState) => readonly T[],
  isSame: (item: T) => boolean,
) {
  const tabId = sbp('dez.model/tabs/activeId') as string
  let rangeId = addPendingRange(view, start)
  /** The item in the state of now; null when it is gone (its text changed,
   *  another tab is active, no single match). */
  const current = (): T | null => {
    const range = pendingRange(view.state, rangeId)
    if (range) return shown(view.state).find((item) => item.from === range.from && item.to === range.to && isSame(item)) ?? null
    // `pendingRange` gives no range while another tab is active either, and
    // right after a tab switch the view still holds this tab's state: find
    // the item again only while this tab is active.
    if (sbp('dez.model/tabs/activeId') !== tabId) return null
    const matches = shown(view.state).filter(isSame)
    if (matches.length !== 1) return null
    rangeId = addPendingRange(view, matches[0])
    return matches[0]
  }
  /** Ends the work: makes `change` (a rewrite or the removal of the item),
   *  if given. A change that tells of a file change (a save, a delete) is
   *  not in the undo history: the file change stays, so an undo could only
   *  bring back text that names a file that is gone. An `undoable` change
   *  changes no file (the removal of a linked file's text), so it is a
   *  normal edit, in its own undo step. */
  const end = (change?: ChangeSpec, { undoable = false } = {}): void => {
    // In another state, or while another tab is active, there is no range.
    if (!pendingRange(view.state, rangeId)) return
    view.dispatch({
      ...(change && {
        changes: change,
        annotations: undoable ? isolateHistory.of('full') : Transaction.addToHistory.of(false),
      }),
      effects: removePendingRange(rangeId),
    })
  }
  return { current, end }
}

/** The field for `addPendingRange`; each editor extension that uses it
 *  includes it (CodeMirror keeps one copy). */
export function pendingRanges(): Extension {
  return pendingRangesField
}
