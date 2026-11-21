// Unit tests only: the helpers that several editor tests share.
import { history } from '@codemirror/commands'
import { EditorSelection, EditorState, type Transaction, type TransactionSpec } from '@codemirror/state'
import { EditorView, type WidgetType } from '@codemirror/view'
import { appTagText } from '../../model/chat/appTags'
import { mediaTagText, mediaTagTextWithKeptMark } from '../../model/chat/mediaTags'
import { HIDDEN_CLIP_PATH, HIDDEN_IMAGE_PATH, idImage } from '../../model/chat/testing'
import { toolBlockText } from '../../model/chat/toolBlocks'
import type { ModelRef, Role } from '../../model/chat/types'
import type { ModelFacts } from '../modelLabel'
import { SECTION_SEP, pillsField, promptAtomicRanges, sectionsField, setSectionsEffect, unwrapBrokenPills, type PillMetadata } from '../thread/cmEditor'
import { modelDisplayNamesField, streamingSectionField } from '../thread/modelChip'
import { markdownApps } from './apps'
import { compactionBlockRules } from './compaction'
import { compactionChip } from './compactionChip'
import { markdownImages } from './images'
import { markdownMedia } from './media'
import { mentionChips } from './mentions'
import { markdownToolCalls } from './toolCalls'

/** A tool call block: a chip in an agent section, text in a user section. */
export const CHIP = toolBlockText({ id: 'a', name: 'model_list', status: 'success', arguments: { filter: 'gemini' }, result: 'ok' })

/** A video tag: a player in a section of either role. */
export const PLAYER = mediaTagText({ kind: 'video', id: 'a', type: 'video/webm', src: 'https://cdn.example/v.webm', url: 'https://cdn.example/v.webm', expires: null, other: [] })

/** An app tag: a card in a section of either role. */
export const APP_CARD = appTagText('notes')

/** An image that a mention names as `@a`. */
export const RED = idImage('/home/u/.config/dez/assets/images/red.png', 'a')

/** An audio clip from a URL that a mention names as `@b`. */
export const SONG = mediaTagText({ kind: 'audio', id: 'b', type: 'audio/mpeg', src: null, url: 'https://cdn.example/s.mp3', expires: null, other: [] })

/** The reference of an image that a compaction keeps out of view, with the
 *  model mark of `model` when given. */
export function keptImage(id = 'b', model?: ModelRef): string {
  return idImage(HIDDEN_IMAGE_PATH, id, true, model)
}

/** The tag of a clip (a saved one, unless `src` is given) that a
 *  compaction keeps out of view. */
export function keptClip(id = 'c', src = HIDDEN_CLIP_PATH): string {
  return mediaTagTextWithKeptMark({ kind: 'audio', id, type: 'audio/wav', src, url: null, expires: null, other: [] }, true)
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

/** A state with every kind of line block (chips, players, app cards, the
 *  compaction block), images, prompt pills, mention chips, and the
 *  compaction chips, whose doc is `texts`, one section each, with the
 *  roles of `roles`, the selection `ranges` (a number is a caret, a pair
 *  is an anchor and a head; no range puts the caret at the doc start), and
 *  the prompt pill metadata `pills`. The first section is `user`, or
 *  `agent` when its text starts with a compaction tag
 *  (`normalizeSectionModels` in cmEditor.ts). The sections have no model,
 *  and the models no name (`withSectionModels`, `setModelDisplayNamesEffect`). */
export function createState(texts: string[], roles: Role[], ranges: Array<number | [number, number]> = [], pills: Record<string, PillMetadata> = {}): EditorState {
  return EditorState.create({
    doc: joinSections(texts),
    selection: ranges.length ? selectionOf(ranges) : undefined,
    extensions: [
      sectionsField.init(() => roles.map((role, index) => ({ id: `s${index}`, role }))),
      streamingSectionField.init(() => null),
      modelDisplayNamesField,
      pillsField.init(() => new Map(Object.entries(pills))),
      unwrapBrokenPills,
      promptAtomicRanges,
      markdownToolCalls(),
      markdownMedia(),
      markdownApps(),
      compactionBlockRules(),
      compactionChip(),
      markdownImages(),
      mentionChips(),
      history(),
      EditorState.allowMultipleSelections.of(true),
    ],
  })
}

/** `state` with `models[i]` as the model of section `i`; a section with no
 *  entry keeps its model. */
export function withSectionModels(state: EditorState, models: ReadonlyArray<ModelRef | undefined>): EditorState {
  const sections = state.field(sectionsField).map((section, index) => {
    const model = models[index]
    return model ? { ...section, model } : section
  })
  return state.update({ effects: setSectionsEffect.of(sections) }).state
}

/** The widgets of the decorations of `state` that no view plugin draws. */
export function drawnWidgets(state: EditorState): WidgetType[] {
  const widgets: WidgetType[] = []
  for (const source of state.facet(EditorView.decorations)) {
    if (typeof source === 'function') continue
    for (const cursor = source.iter(); cursor.value; cursor.next()) {
      const widget = cursor.value.spec.widget as WidgetType | undefined
      if (widget) widgets.push(widget)
    }
  }
  return widgets
}

/** The id of each image or player that `state` draws in place of its text,
 *  with the name that its model label shows (null for no label): the
 *  widgets with a `model` (`ImageWidget`, `MediaWidget`). */
export function drawnAssetModels(state: EditorState): Array<[string | null, string | null]> {
  return drawnWidgets(state).flatMap((widget) => {
    const asset = widget as Partial<{ id: string | null, tag: { id: string | null }, model: ModelFacts | null }>
    return asset.model === undefined ? [] : [[asset.tag?.id ?? asset.id ?? null, asset.model?.name ?? null]]
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
