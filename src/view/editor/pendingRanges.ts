import { StateEffect, StateField, type EditorState, type Extension } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'

export interface DocRange {
  from: number
  to: number
}

const addPendingRangeEffect = StateEffect.define<{ id: string, range: DocRange }>()
const removePendingRangeEffect = StateEffect.define<string>()

/** The doc ranges that async editor work changes once it ends (an image
 *  insert after its files are saved, an image delete after its prompt and
 *  file delete), by id. A range moves with the edits made meanwhile; text
 *  typed at either edge stays out of it, so text typed at the point of an
 *  empty range goes before it. A new state (tab switch, the rebuild at the
 *  end of a stream) starts with no ranges, so work whose id is gone knows
 *  that its doc is gone. */
const pendingRangesField = StateField.define<ReadonlyMap<string, DocRange>>({
  create: () => new Map(),
  update(ranges, tr) {
    let next = ranges
    if (tr.docChanged && next.size > 0) {
      next = new Map(Array.from(next, ([id, range]) => {
        const from = tr.changes.mapPos(range.from, 1)
        return [id, { from, to: Math.max(from, tr.changes.mapPos(range.to, -1)) }]
      }))
    }
    for (const effect of tr.effects) {
      if (effect.is(addPendingRangeEffect)) {
        next = new Map(next).set(effect.value.id, effect.value.range)
      } else if (effect.is(removePendingRangeEffect) && next.has(effect.value)) {
        const copy = new Map(next)
        copy.delete(effect.value)
        next = copy
      }
    }
    return next
  },
})

/** Starts to follow `range` in the view's doc, and returns its id. */
export function addPendingRange(view: EditorView, range: DocRange): string {
  const id = crypto.randomUUID()
  view.dispatch({ effects: addPendingRangeEffect.of({ id, range }) })
  return id
}

/** Where the range of `id` is now in `state`; undefined when `state` is not
 *  the one that the range was added to, or after `removePendingRange`. */
export function pendingRange(state: EditorState, id: string): DocRange | undefined {
  return state.field(pendingRangesField, false)?.get(id)
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
