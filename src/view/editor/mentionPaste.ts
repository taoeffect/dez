import sbp from '@sbp/sbp'
import type { EditorState, TransactionSpec } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { plainLiveText } from '../../model/chat/content'
import { mentionedAssets, mentionPastePlan, type MentionedAsset, type MentionPastePlan } from '../../model/chat/mentionPaste'
import { clipboardPasteTransaction, scanPills, sectionsField } from '../thread/cmEditor'
import { syncDomSelection } from './focus'
import { lineBlockRanges, sectionTexts } from './lineBlocks'
import { shownMentions } from './mentions'
import { addPendingRange, pendingRange, removePendingRange, type DocRange } from './pendingRanges'

// A paste of `@id` mentions that were copied in another conversation
// (src/model/chat/mentionPaste.ts has the rules). The clipboard holds only
// text, so a copy or a cut in the editor records here the assets that its
// mentions name, with the text and the conversation of the copy. A paste of
// that same text into another conversation asks the user whether to bring
// those assets along: Yes pastes the text with the copies of the missing
// assets and with the changed mentions, in one transaction, so one undo
// takes it all back; No pastes the text as it is. Any other paste is the
// plain paste. The record is in memory only: after a restart, or for a
// text changed in another app, a paste is the plain paste.

interface CopyRecord {
  text: string
  conversationId: string
  /** The asset that each copied mention names, by id. */
  assets: ReadonlyMap<string, MentionedAsset>
}

let lastCopy: CopyRecord | null = null

/** Records the copy or the cut of the selection of `state` as the
 *  clipboard text `text`, in the conversation `conversationId`: the assets
 *  that the mentions of the selection name (the mentions with a chip, as
 *  the user sees them). Each copy replaces the record of the one before. */
export function recordCopy(state: EditorState, text: string, conversationId: string | null): void {
  lastCopy = null
  if (conversationId === null) return
  const ranges = state.selection.ranges.filter((range) => !range.empty)
  const mentions = shownMentions(state).filter((mention) => ranges.some((range) => range.from <= mention.from && mention.to <= range.to))
  if (mentions.length === 0) return
  const texts = sectionTexts(state.doc.toString(), state.field(sectionsField))
  // The sections as `shownMentions` reads them: as a request does.
  const sections = texts.map(({ section, text }) => ({ role: section.role, text: plainLiveText(text).text }))
  const copied = mentions.map(({ from, id }) => ({ section: texts.findLastIndex((text) => text.from <= from), id }))
  const assets = mentionedAssets(sections, copied)
  if (assets.size > 0) lastCopy = { text, conversationId, assets }
}

/** Whether a paste at the selection of `state` can bring the assets of its
 *  mentions: one selection range, not in the body of a prompt pill (a
 *  paste there is plain text), and not on a line that starts inside a
 *  block of many lines (a tool call chip, the compaction block) or inside
 *  an expanded prompt pill, whose body has real line breaks: the copies go
 *  in at the start of the line, and would split the block or change the
 *  prompt's text. */
function pasteFits(state: EditorState): boolean {
  if (state.selection.ranges.length !== 1) return false
  const { from, to } = state.selection.main
  const lineStart = state.doc.lineAt(from).from
  const pills = scanPills(state.doc.toString())
  if (pills.some((pill) => (pill.bodyFrom <= from && to <= pill.bodyTo) || (pill.from < lineStart && lineStart < pill.to))) return false
  return !lineBlockRanges(state).some((block) => block.from < lineStart && lineStart <= block.to)
}

/** The plain paste of `text` at the selection of `state`, and the plan of
 *  its mentions for the assets of `record` (null: the plain paste is all).
 *  The plan reads the doc of the plain paste with no transaction filter:
 *  the `pastedMediaIds` filter (imageInsert.ts) must not give the pasted
 *  assets their new ids before the plan reads them. */
function planPaste(state: EditorState, text: string, record: CopyRecord): { paste: TransactionSpec, plan: MentionPastePlan | null } {
  const paste = clipboardPasteTransaction(state, text)
  if (!pasteFits(state)) return { paste, plan: null }
  const pasted = state.update(paste, { filter: false })
  const ranges: DocRange[] = []
  pasted.changes.iterChangedRanges((_fromA, _toA, from, to) => {
    ranges.push({ from, to })
  })
  if (ranges.length !== 1) return { paste, plan: null }
  const doc = pasted.newDoc.toString()
  const sections = sectionTexts(doc, pasted.state.field(sectionsField)).map(({ section, from, text }) => ({ role: section.role, from, text }))
  return { paste, plan: mentionPastePlan({ doc, sections, pasted: ranges[0] }, record.assets) }
}

/** The question of the prompt for `plan`. */
function promptMessage({ copies, idChanges }: MentionPastePlan): string {
  const asNo = 'Choose No to paste the text as it is.'
  if (copies.length === 0) {
    return `This conversation has the assets that the pasted text names, under other ids. Change the names in the text to these ids? ${asNo}`
  }
  const one = copies.length === 1
  const what = one ? 'an asset' : `${copies.length} assets`
  const ids = idChanges.size > 0 ? ', and change the names in the text to fit this conversation' : ''
  return `The pasted text names ${what} of another conversation. Add ${one ? 'it' : 'them'} at the top of the paste${ids}? ${asNo}`
}

function showNotPastedToast(): void {
  sbp('dez.ui/toast', 'app-global', {
    title: 'Text not pasted',
    message: 'The conversation changed while the prompt was open, so Dez did not paste the text. Paste it again.',
    variant: 'warning',
    duration: 8000,
  })
}

/** The paste of `text` (the clipboard text of a paste) in the conversation
 *  `conversationId`, when it is the text of the last copy in another
 *  conversation and its mentions name assets that need a copy or another id
 *  here (see the top of this file). Then it asks the user, pastes when the
 *  prompt closes, and returns true; else it does nothing and returns false,
 *  for the plain paste. While the prompt is open, the paste place follows
 *  the edits (`addPendingRange`). When the view no longer shows the doc of
 *  the paste (another tab, a rebuilt state), it pastes nothing, and a toast
 *  says so. */
export function pasteMentions(view: EditorView, text: string, conversationId: string | null): boolean {
  const record = lastCopy
  if (record === null || record.text !== text || conversationId === null || record.conversationId === conversationId) return false
  const { plan } = planPaste(view.state, text, record)
  if (plan === null) return false
  const { from, to } = view.state.selection.main
  const replacedText = view.state.sliceDoc(from, to)
  const rangeId = addPendingRange(view, { from, to })
  void (async () => {
    const confirmed = await sbp('dez.ui/confirm', { message: promptMessage(plan) }) as boolean
    const pending = pendingRange(view.state, rangeId)
    if (!pending) {
      showNotPastedToast()
      return
    }
    // As in `insertFiles` (imageInsert.ts): an edit while the prompt was
    // open that replaced the selection keeps its text, and the paste goes
    // after it.
    const target = view.state.sliceDoc(pending.from, pending.to) === replacedText ? pending : { from: pending.to, to: pending.to }
    // The doc can have changed while the prompt was open: the plan is read
    // again at the target.
    const targetState = view.state.update({ selection: { anchor: target.from, head: target.to }, filter: false }).state
    const { paste, plan: finalPlan } = planPaste(targetState, text, record)
    const done = { effects: removePendingRange(rangeId) }
    if (confirmed && finalPlan !== null) {
      // Every change of the plan is at or after `copiesAt`, so the copies go
      // in at `copiesAt` of the doc after the changes.
      view.dispatch(
        paste,
        { changes: finalPlan.changes, sequential: true },
        { changes: { from: finalPlan.copiesAt, insert: finalPlan.copiesText }, sequential: true },
        done,
      )
    } else {
      view.dispatch(paste, done)
    }
    // The prompt gave the focus back a few ms ago (`syncDomSelection`).
    syncDomSelection(view)
  })()
  return true
}
