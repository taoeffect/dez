import { Transaction, type EditorState } from '@codemirror/state'
import { sectionsField } from '../thread/cmEditor'
import { agentSectionTexts } from './lineBlocks'

// The text of each agent section of `state`, by section id.
function agentTexts(state: EditorState): Map<string, string> {
  const sections = state.field(sectionsField, false) ?? []
  if (!sections.some((section) => section.role === 'agent')) return new Map()
  return new Map(agentSectionTexts(state.doc.toString(), sections).map(({ section, text }) => [section.id, text]))
}

/** Whether `tr` is a change of a reply by the user, for the edited flag of
 *  the tab (`dez.model/tabs/markAgentTextEdited`): after it, an agent
 *  section has another text, or a section with text stopped or started to
 *  be an agent section (a delete, a role switch, a merge, a paste of
 *  agent sections).
 *
 *  Only a transaction with a `userEvent` counts: typing, a delete, a cut, a
 *  paste, a drop, a drag, a replace, an undo or redo, a split, a role
 *  switch, a prompt insert, and the trash of an image or a clip. The
 *  stream, the tools, the store-to-view syncs, the open and close of a
 *  prompt pill, and the Save of a clip have none, so they never count.
 *
 *  Sections are matched by id, and a section that is not an agent section
 *  counts as an empty text: so a merge of an empty message into a reply,
 *  or the delete of an empty reply, does not count. */
export function editsAgentText(tr: Transaction): boolean {
  if (tr.annotation(Transaction.userEvent) === undefined) return false
  if (!tr.docChanged && tr.state.field(sectionsField, false) === tr.startState.field(sectionsField, false)) return false
  const before = agentTexts(tr.startState)
  const after = agentTexts(tr.state)
  for (const id of new Set([...before.keys(), ...after.keys()])) {
    if ((before.get(id) ?? '') !== (after.get(id) ?? '')) return true
  }
  return false
}
