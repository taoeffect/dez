import type { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { describe, expect, it } from 'vitest'
import { CARRIED_USER_ASSETS_LABEL, compactionTagText } from '../../model/chat/compaction'
import type { ShownPicture } from '../../model/chat/shownPictures'
import type { PanelAsset } from './toolCalls'
import { compactionChipData, openCompactionChip, toggleCompactionChipEffect } from './compactionChip'
import { createState, keptClip, keptImage } from './testing'

const PICTURES: ShownPicture[] = [{ file: 'f1.png', label: 'asset_view: the sheet of the video clip @d.', width: 64, height: 48, bytes: 300 }]
const SHOWN = '![/home/u/.config/dez/assets/images/shown.png](id=s)'

/** A compacted conversation with the tag `count`, `dropped`, and
 *  `pictures`, the compaction section `notes`, a kept message of the user,
 *  and the section of the carried assets of the user (`carried`). */
function compactedState(notes: string[], carried: string[], { count = 1, dropped, pictures = [] }: { count?: number, dropped?: number, pictures?: ShownPicture[] } = {}): EditorState {
  const tag = compactionTagText({ count, lastId: 'z', dropped, pictures })
  return createState([[tag, ...notes].join('\n'), 'Ask.', [CARRIED_USER_ASSETS_LABEL, ...carried].join('\n')], ['agent', 'user', 'user'])
}

/** Each kept asset of the chip as its kind, its id, and, for a clip, the
 *  role that its player gets. */
function assetSummaries(assets: readonly PanelAsset[]): string[] {
  return assets.map((asset) => asset.kind === 'image' ? `image ${asset.id}` : `${asset.tag.kind} ${asset.tag.id} ${asset.role}`)
}

/** Where the state draws a block widget with no doc text of its own. */
function blockWidgetPlaces(state: EditorState): number[] {
  const places: number[] = []
  for (const source of state.facet(EditorView.decorations)) {
    if (typeof source === 'function') continue
    for (const cursor = source.iter(); cursor.value; cursor.next()) {
      if (cursor.value.spec.block && cursor.from === cursor.to) places.push(cursor.from)
    }
  }
  return places
}

describe('compactionChipData', () => {
  it('gives the count of the tag, the kept assets in doc order, and the pictures of the tag', () => {
    const notes = ['Notes.', '', keptImage('k'), '', keptClip('l'), '', SHOWN]
    const state = compactedState(notes, [keptClip('m'), keptImage('u'), SHOWN], { count: 3, pictures: PICTURES })
    const data = compactionChipData(state)

    expect(data?.count).toBe(3)
    // A clip of the carried assets of the user plays as a clip of a user.
    expect(assetSummaries(data?.assets ?? [])).toStrictEqual(['image k', 'audio l agent', 'audio m user', 'image u'])
    expect(data?.pictures).toStrictEqual(PICTURES)
  })

  it('gives a chip with nothing in it for a compaction that kept nothing', () => {
    expect(compactionChipData(compactedState(['Notes.', '', SHOWN], [SHOWN]))).toStrictEqual({ count: 1, dropped: null, assets: [], pictures: [] })
  })

  it('gives the count of the dropped assets of the tag, also 0, and null for a tag that does not tell it', () => {
    const dropped = (count?: number) => compactionChipData(compactedState(['Notes.'], [], { dropped: count }))?.dropped

    expect([dropped(5), dropped(0), dropped()]).toStrictEqual([5, 0, null])
  })

  it('gives null for a doc with no compaction tag, and after a change takes the tag away', () => {
    const state = compactedState(['Notes.'], [keptImage('u')])
    const untagged = state.update({ changes: { from: 0, to: state.doc.line(2).from } }).state

    expect(compactionChipData(createState(['Notes.', 'Ask.'], ['user', 'user']))).toBeNull()
    expect(compactionChipData(untagged)).toBeNull()
  })
})

describe('the compaction chip', () => {
  it('is a block at the end of the tag line, only while the doc starts with a tag', () => {
    const state = compactedState(['Notes.'], [])

    expect(blockWidgetPlaces(state)).toStrictEqual([state.doc.line(1).to])
    expect(blockWidgetPlaces(createState(['Notes.', 'Ask.'], ['user', 'user']))).toStrictEqual([])
  })

  it('starts closed, and a toggle opens and closes its panel over doc changes', () => {
    const state = compactedState(['Notes.', '', keptImage('k')], [])
    const opened = state.update({ effects: toggleCompactionChipEffect.of(null) }).state
    const typed = opened.update({ changes: { from: opened.doc.length, insert: ' More.' } }).state

    expect(openCompactionChip(state)).toBe(false)
    expect(openCompactionChip(typed)).toBe(true)
    expect(openCompactionChip(typed.update({ effects: toggleCompactionChipEffect.of(null) }).state)).toBe(false)
  })
})
