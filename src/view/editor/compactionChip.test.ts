import { EditorState } from '@codemirror/state'
import { EditorView, type Decoration } from '@codemirror/view'
import { describe, expect, it } from 'vitest'
import { CARRIED_USER_ASSETS_LABEL, COMPACTION_END_LINE, compactionBlockText, compactionTagText } from '../../model/chat/compaction'
import type { ShownPicture } from '../../model/chat/shownPictures'
import type { PanelAsset } from './toolCalls'
import { compactionChip, compactionChipData, openCompactionChips, toggleCompactionChipEffect } from './compactionChip'
import { CHIP, PLAYER, createState, keptClip, keptImage } from './testing'

const PICTURES: ShownPicture[] = [{ file: 'f1.png', label: 'asset_view: the sheet of the video clip @d.', width: 64, height: 48, bytes: 300 }]
const SHOWN = '![/home/u/.config/dez/assets/images/shown.png](id=s)'
const LINKED_CLIP = '/home/u/Music/linked.wav'

interface TagOptions {
  count?: number
  dropped?: number
  pictures?: ShownPicture[]
  linked?: string[]
}

/** A compacted conversation in the layout of an older Dez, with the tag
 *  `count`, `dropped`, `pictures`, and `linked`: the block with the notes
 *  `notes`, a kept message of the user, and the section of the carried
 *  assets of the user (`carried`). */
function compactedState(notes: string[], carried: string[], { count = 1, dropped, pictures = [], linked }: TagOptions = {}): EditorState {
  const block = compactionBlockText({ count, lastId: 'z', dropped, pictures, linked }, notes.join('\n'))
  return createState([block, 'Ask.', [CARRIED_USER_ASSETS_LABEL, ...carried].join('\n')], ['agent', 'user', 'user'])
}

/** Each asset of the chip as its kind, its id, and, for a clip, whether a
 *  linked file counts for its player (`linkedSrc`). */
function assetSummaries(assets: readonly PanelAsset[]): string[] {
  return assets.map((asset) => asset.kind === 'image' ? `image ${asset.id}` : `${asset.tag.kind} ${asset.tag.id} ${asset.linkedSrc ? 'linked' : 'unlinked'}`)
}

/** The decorations of the state that are not drawn by a view plugin and
 *  that `keep` takes, as [from, to]: a widget has no doc text of its own
 *  (from = to). */
function decorationRanges(state: EditorState, keep: (from: number, spec: Decoration['spec']) => boolean): Array<[number, number]> {
  const ranges: Array<[number, number]> = []
  for (const source of state.facet(EditorView.decorations)) {
    if (typeof source === 'function') continue
    for (const cursor = source.iter(); cursor.value; cursor.next()) {
      if (keep(cursor.from, cursor.value.spec)) ranges.push([cursor.from, cursor.to])
    }
  }
  return ranges
}

describe('compactionChipData', () => {
  it('gives the count of the tag, every asset of the block and the kept assets of the user in doc order, and the pictures of the tag', () => {
    const notes = ['Notes.', '', keptImage('k'), '', keptClip('l'), '', keptClip('n', LINKED_CLIP), '', keptClip('o', '/home/u/Music/other.wav'), '', SHOWN]
    const state = compactedState(notes, [keptClip('m'), keptImage('u'), SHOWN], { count: 3, pictures: PICTURES, linked: [LINKED_CLIP] })
    const data = compactionChipData(state)

    expect(data?.count).toBe(3)
    // In the block, a linked file counts only for a clip whose src the tag
    // lists. In the carried assets of the user (an older Dez), it counts
    // for every clip. An asset of the user with no kept mark shows at its
    // place.
    expect(assetSummaries(data?.assets ?? [])).toStrictEqual(['image k', 'audio l unlinked', 'audio n linked', 'audio o unlinked', 'image s', 'audio m linked', 'image u'])
    expect(data?.pictures).toStrictEqual(PICTURES)
  })

  it('gives the assets part of the notes and every other part, each for people', () => {
    const notes = ['## Summary', 'Did a thing with @k.', '', '## Assets of the conversation', `The picture @k. ${keptImage('k')}`, '', '## Next steps', 'Go on.']
    const data = compactionChipData(compactedState(notes, []))

    expect(data?.assetsText).toBe('The picture @k. [image]')
    expect(data?.summary).toBe('## Summary\nDid a thing with @k.\n\n## Next steps\nGo on.')
  })

  it('gives chips with nothing in them for a compaction that kept nothing and wrote no notes', () => {
    expect(compactionChipData(compactedState([], [SHOWN]))).toStrictEqual({ count: 1, dropped: null, assets: [], pictures: [], assetsText: '', summary: '' })
  })

  it('gives the count of the dropped assets of the tag, also 0, and null for a tag that does not tell it', () => {
    const dropped = (count?: number) => compactionChipData(compactedState(['Notes.'], [], { dropped: count }))?.dropped

    expect([dropped(5), dropped(0), dropped()]).toStrictEqual([5, 0, null])
  })

  it('reads a block of the old form, whose notes run to the end of the section', () => {
    const tag = compactionTagText({ count: 2, lastId: 'z', pictures: [] }).replace(/>$/, '/>')
    const state = createState([`${tag}\nNotes.\n\n${keptImage('k')}`, 'Ask.'], ['agent', 'user'])

    expect(compactionChipData(state)).toStrictEqual({ count: 2, dropped: null, assets: [{ kind: 'image', path: expect.any(String), id: 'k', linked: false }], pictures: [], assetsText: '', summary: 'Notes.\n\n[image]' })
  })

  it('gives null for a doc with no compaction tag, and after a change takes the tag away', () => {
    const state = compactedState(['Notes.'], [keptImage('u')])
    const untagged = state.update({ changes: { from: 0, to: state.doc.line(2).from } }).state

    expect(compactionChipData(createState(['Notes.', 'Ask.'], ['user', 'user']))).toBeNull()
    expect(compactionChipData(untagged)).toBeNull()
  })
})

describe('the compaction chips', () => {
  it('are a block at the end of the tag line, in place of the other lines of the block, only while the doc starts with a tag', () => {
    const state = compactedState(['Notes.', 'More notes.'], [])
    const tagLine = state.doc.line(1)
    const blockEnd = state.doc.line(4).to
    const isBlock = (_from: number, spec: Decoration['spec']) => spec.block === true

    expect(decorationRanges(state, isBlock)).toStrictEqual([[tagLine.to, tagLine.to], [tagLine.to + 1, blockEnd]])
    expect(decorationRanges(createState(['Notes.', 'Ask.'], ['user', 'user']), isBlock)).toStrictEqual([])
  })

  it('draw nothing else for the text of the block: no image, player, or tool call chip', () => {
    const state = compactedState(['Notes.', '', SHOWN, '', keptImage('k'), '', PLAYER, '', CHIP], [])
    const tagLine = state.doc.line(1)
    const blockEnd = state.doc.toString().indexOf(COMPACTION_END_LINE) + COMPACTION_END_LINE.length

    expect(decorationRanges(state, (from) => from < blockEnd)).toStrictEqual([[tagLine.to, tagLine.to], [tagLine.to + 1, blockEnd]])
  })

  it('start closed, and a toggle opens and closes the panel of one chip over doc changes', () => {
    const state = compactedState(['Notes.', '', keptImage('k')], [])
    const opened = state.update({ effects: toggleCompactionChipEffect.of('summary') }).state
    const typed = opened.update({ changes: { from: opened.doc.length, insert: ' More.' } }).state
    const both = typed.update({ effects: toggleCompactionChipEffect.of('assets') }).state

    expect(openCompactionChips(state)).toStrictEqual({ assets: false, summary: false })
    expect(openCompactionChips(typed)).toStrictEqual({ assets: false, summary: true })
    expect(openCompactionChips(both)).toStrictEqual({ assets: true, summary: true })
    expect(openCompactionChips(both.update({ effects: toggleCompactionChipEffect.of('summary') }).state)).toStrictEqual({ assets: true, summary: false })
  })

  // A rebuild of the same tab (ThreadEditor.vue) gives the new state the
  // open panels of the old one.
  it('start with the panels that the extension gets open', () => {
    const state = EditorState.create({ extensions: compactionChip({ assets: true, summary: false }) })

    expect(openCompactionChips(state)).toStrictEqual({ assets: true, summary: false })
  })
})
