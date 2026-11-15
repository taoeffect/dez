// Unit tests only: the helpers that several editor tests share.
import { history } from '@codemirror/commands'
import { EditorSelection, EditorState, type Transaction, type TransactionSpec } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { mediaTagText, mediaTagTextWithKeptMark } from '../../model/chat/mediaTags'
import { HIDDEN_CLIP_PATH, HIDDEN_IMAGE_PATH, idImage } from '../../model/chat/testing'
import { toolBlockText } from '../../model/chat/toolBlocks'
import type { Role } from '../../model/chat/types'
import { SECTION_SEP, pillsField, promptAtomicRanges, sectionsField, unwrapBrokenPills, type PillMetadata } from '../thread/cmEditor'
import { streamingSectionField } from '../thread/modelChip'
import { compactionTagLine } from './compaction'
import { compactionChip } from './compactionChip'
import { markdownImages } from './images'
import { markdownMedia } from './media'
import { mentionChips } from './mentions'
import { markdownToolCalls } from './toolCalls'

/** A tool call block: a chip in an agent section, text in a user section. */
export const CHIP = toolBlockText({ id: 'a', name: 'model_list', status: 'success', arguments: { filter: 'gemini' }, result: 'ok' })

/** A video tag: a player in a section of either role. */
export const PLAYER = mediaTagText({ kind: 'video', id: 'a', type: 'video/webm', src: 'https://cdn.example/v.webm', url: 'https://cdn.example/v.webm', expires: null, other: [] })

/** The reference of an image that a compaction keeps out of view. */
export function keptImage(id = 'b'): string {
  return idImage(HIDDEN_IMAGE_PATH, id, true)
}

/** The tag of a saved clip that a compaction keeps out of view. */
export function keptClip(id = 'c'): string {
  return mediaTagTextWithKeptMark({ kind: 'audio', id, type: 'audio/wav', src: HIDDEN_CLIP_PATH, url: null, expires: null, other: [] }, true)
}

/** The doc of `texts`, one section each. */
export function joinSections(texts: string[]): string {
  return texts.join(`\n${SECTION_SEP}\n`)
}

/** The selection of `ranges`: a number is a caret, a pair is an anchor and
 *  a head. */
export function selectionOf(ranges: ReadonlyArray<number | [number, number]>): EditorSelection {
  return EditorSelection.create(ranges.map((range) =>
    typeof range === 'number' ? EditorSelection.cursor(range) : EditorSelection.range(range[0], range[1])))
}

/** A state with every kind of line block (chips, players, the tag line of
 *  a compaction section), images, prompt pills, mention chips, and the
 *  compaction chip, whose doc is `texts`, one section each, with the roles
 *  of `roles`, the selection `ranges` (a number is a caret, a pair is an
 *  anchor and a head; no range puts the caret at the doc start), and the
 *  prompt pill metadata `pills`. The first section is `user`, or `agent`
 *  when its text starts with a compaction tag (`normalizeSectionModels` in
 *  cmEditor.ts). */
export function createState(texts: string[], roles: Role[], ranges: Array<number | [number, number]> = [], pills: Record<string, PillMetadata> = {}): EditorState {
  return EditorState.create({
    doc: joinSections(texts),
    selection: ranges.length ? selectionOf(ranges) : undefined,
    extensions: [
      sectionsField.init(() => roles.map((role, index) => ({ id: `s${index}`, role }))),
      streamingSectionField.init(() => null),
      pillsField.init(() => new Map(Object.entries(pills))),
      unwrapBrokenPills,
      promptAtomicRanges,
      markdownToolCalls(),
      markdownMedia(),
      compactionTagLine(),
      compactionChip(),
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
