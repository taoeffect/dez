// Unit tests only: the helpers that several editor tests share.
import { history } from '@codemirror/commands'
import { EditorSelection, EditorState, type Transaction, type TransactionSpec } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { mediaTagText } from '../../model/chat/mediaTags'
import { toolBlockText } from '../../model/chat/toolBlocks'
import type { Role } from '../../model/chat/types'
import { SECTION_SEP, pillsField, promptAtomicRanges, sectionsField, unwrapBrokenPills, type PillMetadata } from '../thread/cmEditor'
import { streamingSectionField } from '../thread/modelChip'
import { markdownImages } from './images'
import { markdownMedia } from './media'
import { mentionChips } from './mentions'
import { markdownToolCalls } from './toolCalls'

/** A tool call block: a chip in an agent section, text in a user section. */
export const CHIP = toolBlockText({ id: 'a', name: 'model_list', status: 'success', arguments: { filter: 'gemini' }, result: 'ok' })

/** A video tag: a player in a section of either role. */
export const PLAYER = mediaTagText({ kind: 'video', id: 'a', type: 'video/webm', src: 'https://cdn.example/v.webm', url: 'https://cdn.example/v.webm', expires: null, other: [] })

/** The doc of `texts`, one section each. */
export function joinSections(texts: string[]): string {
  return texts.join(`\n${SECTION_SEP}\n`)
}

/** A state with both kinds of line blocks, images, prompt pills, and
 *  mention chips, whose doc is
 *  `texts`, one section each, with the roles of `roles`, the selection
 *  `ranges` (a number is a caret, a pair is an anchor and a head; no range
 *  puts the caret at the doc start), and the prompt pill metadata `pills`.
 *  The first section is always `user` (`normalizeSectionModels` in
 *  cmEditor.ts). */
export function createState(texts: string[], roles: Role[], ranges: Array<number | [number, number]> = [], pills: Record<string, PillMetadata> = {}): EditorState {
  return EditorState.create({
    doc: joinSections(texts),
    selection: ranges.length
      ? EditorSelection.create(ranges.map((range) =>
        typeof range === 'number' ? EditorSelection.cursor(range) : EditorSelection.range(range[0], range[1])))
      : undefined,
    extensions: [
      sectionsField.init(() => roles.map((role, index) => ({ id: `s${index}`, role }))),
      streamingSectionField.init(() => null),
      pillsField.init(() => new Map(Object.entries(pills))),
      unwrapBrokenPills,
      promptAtomicRanges,
      markdownToolCalls(),
      markdownMedia(),
      markdownImages(),
      mentionChips(),
      history(),
      EditorState.allowMultipleSelections.of(true),
    ],
  })
}

/** Runs a key command on a fake view; the next state is unchanged when the
 *  command does not handle the key. */
export function runCommand(state: EditorState, command: (view: EditorView) => boolean): { handled: boolean, state: EditorState } {
  let next = state
  const view = {
    get state() {
      return next
    },
    dispatch(...specs: [Transaction] | TransactionSpec[]) {
      next = 'startState' in specs[0] ? specs[0].state : next.update(...specs as TransactionSpec[]).state
    },
  } as EditorView
  const handled = command(view)
  return { handled, state: next }
}
