import { invertedEffects, isolateHistory } from '@codemirror/commands'
import { EditorState, Facet, StateEffect, type Extension, type Transaction } from '@codemirror/state'
import sbp from '@sbp/sbp'
import type { TabCostNumbers } from '../../model/chat/conversationCost'
import { editsAgentText } from './agentTextEdits'

// Select All, then a delete (Backspace, Delete, Cut, Delete Line), empties
// the conversation of a tab, and its cost numbers start again from $0, as
// in a new tab (`dez.model/tabs/resetCost`). An undo puts back the text and
// the numbers together.
//
// The numbers are store state, not doc text, so the history of the editor
// carries them as effects: the delete gets `resetCostEffect`, and its
// inverse is `restoreCostEffect` with the numbers that the reset removes.
// The history computes that inverse when it takes in the transaction, which
// is before the update listener applies the reset, so the source still
// gives the numbers of the tab. A redo resets again, and its inverse reads
// the numbers again: they can differ from the first ones. A restore adds
// the numbers to what the tab counted since the delete (`withRestoredCost`),
// because a reply or a job can count a request between the delete and the
// undo.
//
// Only a delete by the user resets: a write of the program has no
// `userEvent`, and an undo or a redo carries the effects of the history.

/** Gives the cost numbers of the tab that a state shows. */
export type TabCostSource = () => TabCostNumbers

const NO_COST_NUMBERS: TabCostSource = () => ({})

/** Where the cost numbers of a state come from: ThreadEditor gives the read
 *  of the tab that the state shows. With none, an undo puts back no
 *  numbers. */
export const tabCostSource = Facet.define<TabCostSource, TabCostSource>({
  combine: (sources) => sources[0] ?? NO_COST_NUMBERS,
})

// Neither effect holds a position, so neither needs a `map`.
const resetCostEffect = StateEffect.define<null>()
const restoreCostEffect = StateEffect.define<TabCostNumbers>()

/** Whether `tr` is a delete by the user that empties a doc that had text,
 *  from a selection of the whole doc. A delete from a caret (Backspace on
 *  the last character), typing or a paste over the whole doc, and a write
 *  of the program are not. */
export function deletesWholeDoc(tr: Transaction): boolean {
  if (!tr.isUserEvent('delete') || tr.newDoc.length > 0) return false
  const { from, to } = tr.startState.selection.main
  return from === 0 && to > 0 && to === tr.startState.doc.length
}

/** The cost change of `tr`: a reset, a restore of the numbers that a reset
 *  removed, or none. */
export function costChange(tr: Transaction): 'reset' | { restore: TabCostNumbers } | null {
  for (const effect of tr.effects) {
    if (effect.is(resetCostEffect)) return 'reset'
    if (effect.is(restoreCostEffect)) return { restore: effect.value }
  }
  return null
}

/** The rule of the reset: a delete of the whole doc gets the reset effect,
 *  and is an undo step of its own, so that typing right after it is not
 *  undone with it. */
export function costReset(): Extension {
  return [
    EditorState.transactionExtender.of((tr) => deletesWholeDoc(tr)
      ? { effects: resetCostEffect.of(null), annotations: isolateHistory.of('full') }
      : null),
    invertedEffects.of((tr) => {
      const change = costChange(tr)
      if (change === 'reset') return [restoreCostEffect.of(tr.startState.facet(tabCostSource)())]
      return change ? [resetCostEffect.of(null)] : []
    }),
  ]
}

/** Applies the cost changes of `transactions`, in order, to the tab
 *  `tabId`, before the editor saves it: a reset, a restore, or else the
 *  edited mark of a change of a reply (`editsAgentText`). A reset or a
 *  restore sets no mark: it removes or puts back replies, and the numbers
 *  that it sets already belong to that text. */
export function applyCostChanges(tabId: string, transactions: readonly Transaction[]): void {
  for (const tr of transactions) {
    const change = costChange(tr)
    if (change === 'reset') sbp('dez.model/tabs/resetCost', tabId)
    else if (change) sbp('dez.model/tabs/restoreCost', tabId, change.restore)
    else if (!sbp('dez.model/tabs/agentTextEdited', tabId) && editsAgentText(tr)) sbp('dez.model/tabs/markAgentTextEdited', tabId)
  }
}
