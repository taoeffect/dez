import sbp from '@sbp/sbp'
import { StateEffect, StateField, type EditorState, type Extension } from '@codemirror/state'
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
 *  holds the old tab's state for a tick, and its edits would go to the new
 *  tab (`syncDocToStore` in ThreadEditor.vue): so each range keeps its tab,
 *  and `pendingRange` gives no range while another tab is active. */
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

/** The field for `addPendingRange`; each editor extension that uses it
 *  includes it (CodeMirror keeps one copy). */
export function pendingRanges(): Extension {
  return pendingRangesField
}
