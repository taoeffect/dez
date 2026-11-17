import type { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { describe, expect, it } from 'vitest'
import { CARRIED_USER_ASSETS_LABEL, compactionBlockText, compactionTagText } from '../../model/chat/compaction'
import { hiddenClip, hiddenImage, invokeBlock } from '../../model/chat/testing'
import type { Role } from '../../model/chat/types'
import { PILL_OPEN, setSectionsEffect } from '../thread/cmEditor'
import { HiddenAssetWidget, hiddenAssetLines, hiddenAssets, hiddenLineStarts, revealHiddenLineBackward, revealHiddenLineForward } from './hiddenAssets'
import { renderedImages } from './images'
import { renderedMedia } from './media'
import { CHIP, createState, joinSections, keptClip, keptImage, runCommand } from './testing'

const INVOKE = invokeBlock('j-aaaa')
const IMAGE = hiddenImage('j-aaaa')
const CLIP = hiddenClip('j-aaaa')

const TAG_DATA = { count: 2, lastId: 'z', pictures: [] }
const TAG = compactionTagText(TAG_DATA)
const KEPT_IMAGE = keptImage('k')
const KEPT_CLIP = keptClip('l')
const KEPT_USER_IMAGE = keptImage('u')
// An image with no mark, in the folder of the stored images: it shows at
// its place in a section of either role.
const SHOWN = '![/home/u/.config/dez/assets/images/shown.png](id=s)'

/** A state with an agent section of the entries `lines` (a chip is one
 *  entry of several doc lines), each on its own lines, after a user
 *  section. `caret` puts a caret at that offset of the entry `caret.line`
 *  (0 is the first). */
function agentState(lines: string[], caret?: { line: number, offset: number }): EditorState {
  const ranges = caret ? [entryStart(lines, caret.line) + caret.offset] : []
  return createState(['ask', lines.join('\n')], ['user', 'agent'], ranges)
}

/** Where the entry `index` of the agent section of `agentState(lines)`
 *  starts in the doc. */
function entryStart(lines: string[], index: number): number {
  return joinSections(['ask', '']).length + lines.slice(0, index).join('\n').length + (index > 0 ? 1 : 0)
}

/** Which entries of the agent section `lines` the hidden assets take out
 *  of view (0 is the first). */
function linesOutOfView(lines: string[]): number[] {
  const starts = lines.map((_, index) => entryStart(lines, index))
  return hiddenLineStarts(agentState(lines)).map((from) => starts.indexOf(from))
}

/** The text that goes out of the doc with each hidden asset of the agent
 *  section `lines`. */
function removals(lines: string[]): (string | null)[] {
  const state = agentState(lines)
  return hiddenAssets(state).map((asset) => {
    const range = hiddenAssetLines(state, asset.from)
    return range && state.sliceDoc(range.from, range.to)
  })
}

/** The placeholders of hidden assets that the editor draws, each as its
 *  kind, its id, and the kind of its owner. */
function placeholders(state: EditorState): string[] {
  const found: string[] = []
  for (const source of state.facet(EditorView.decorations)) {
    if (typeof source === 'function') continue
    for (const cursor = source.iter(); cursor.value; cursor.next()) {
      const widget: unknown = cursor.value.spec.widget
      if (widget instanceof HiddenAssetWidget) found.push(`${widget.kind} ${widget.id} ${widget.owner}`)
    }
  }
  return found
}

/** A compacted conversation in the layout of an older Dez: the compaction
 *  block with the notes `notes`, a kept message of the user, the section
 *  of the carried assets of the user (`carried`, after its first line),
 *  then the sections `more`, each as its role and its text. */
function compactedState(notes: string[], carried: string[], more: Array<[Role, string]> = [], ranges: number[] = []): EditorState {
  const texts = [compactionBlockText(TAG_DATA, notes.join('\n')), 'Ask.', [CARRIED_USER_ASSETS_LABEL, ...carried].join('\n'), ...more.map(([, text]) => text)]
  return createState(texts, ['agent', 'user', 'user', ...more.map(([role]) => role)], ranges)
}

/** The line numbers of the lines that the hidden assets of `state` take
 *  out of view. */
function lineNumbersOutOfView(state: EditorState): number[] {
  return hiddenLineStarts(state).map((from) => state.doc.lineAt(from).number)
}

describe('hiddenAssets', () => {
  it('gives the assets that a chip of their section hides, at their doc offsets', () => {
    const state = agentState([INVOKE, '', CLIP, '', IMAGE, '', 'Done.'])

    expect(hiddenAssets(state).map((asset) => [asset.kind, state.sliceDoc(asset.from, asset.to)])).toStrictEqual([['clip', CLIP], ['image', IMAGE]])
  })

  it('keeps a hidden asset an image or a clip of the editor, with a placeholder as its widget', () => {
    const state = agentState([INVOKE, '', CLIP, '', IMAGE, '', 'Done.'])

    expect(renderedImages(state).map((image) => state.sliceDoc(image.from, image.to))).toStrictEqual([IMAGE])
    expect(renderedMedia(state).map((tag) => state.sliceDoc(tag.from, tag.to))).toStrictEqual([CLIP])
    expect(placeholders(state)).toStrictEqual(['audio c job', 'image b job'])
  })

  it('hides nothing while no chip shows the call: a user section, and a block that stays text', () => {
    const user = createState([[INVOKE, '', IMAGE, '', CLIP].join('\n')], ['user'])
    // A user section after the reply whose chip started the job.
    const afterChip = createState(['ask', INVOKE, [IMAGE, '', CLIP].join('\n')], ['user', 'agent', 'user'])
    const pillBlock = INVOKE.replace('A cat', `A ${PILL_OPEN} cat`)
    const text = agentState([pillBlock, '', IMAGE, '', CLIP])

    for (const state of [user, afterChip, text]) {
      expect(hiddenAssets(state)).toStrictEqual([])
      expect(hiddenLineStarts(state)).toStrictEqual([])
      expect(placeholders(state)).toStrictEqual([])
    }
    expect(renderedImages(afterChip).map((image) => afterChip.sliceDoc(image.from, image.to))).toStrictEqual([IMAGE])
  })

  it('hides an asset of a later reply, past a user section, under the chip of the earlier reply that started its job, and gives its trash its lines there', () => {
    const state = createState(['ask', [INVOKE, '', 'Working.'].join('\n'), 'Go on.', ['Done.', '', IMAGE, '', CLIP].join('\n')], ['user', 'agent', 'user', 'agent'])
    const owner = { kind: 'job', jobId: 'j-aaaa', callId: 'call_1' }

    expect(hiddenAssets(state).map((asset) => [asset.owner, state.sliceDoc(asset.from, asset.to)])).toStrictEqual([[owner, IMAGE], [owner, CLIP]])
    expect(placeholders(state).sort()).toStrictEqual(['audio c job', 'image b job'])
    expect(hiddenAssets(state).map((asset) => {
      const range = hiddenAssetLines(state, asset.from)
      return range && state.sliceDoc(range.from, range.to)
    })).toStrictEqual([`\n${IMAGE}`, `\n${CLIP}`])
  })

  it('gives the asset to the chip of the nearest reply that started its job', () => {
    const state = createState(['ask', INVOKE, 'Again.', invokeBlock('j-aaaa', { id: 'call_2' }), 'Go on.', IMAGE], ['user', 'agent', 'user', 'agent', 'user', 'agent'])

    expect(hiddenAssets(state).map((asset) => asset.owner)).toStrictEqual([{ kind: 'job', jobId: 'j-aaaa', callId: 'call_2' }])
  })

  it('hides no asset that the editor leaves as source text: a clip tag with a sentinel, an image on a table row', () => {
    const pillClip = CLIP.replace('hidden=', `x="${PILL_OPEN}" hidden=`)
    const table = ['| a | b |', '| - | - |', IMAGE]

    expect(hiddenAssets(agentState([INVOKE, '', pillClip]))).toStrictEqual([])
    expect(hiddenAssets(agentState([INVOKE, '', ...table]))).toStrictEqual([])
  })

  it('follows a doc change and a role change, and keeps the same array over any other change', () => {
    const state = agentState([INVOKE, '', IMAGE])
    const typed = state.update({ changes: { from: 0, insert: 'x' } }).state

    expect(hiddenAssets(typed)[0].from).toBe(hiddenAssets(state)[0].from + 1)
    expect(hiddenAssets(typed.update({ selection: { anchor: 0 } }).state)).toBe(hiddenAssets(typed))

    const user = state.update({ effects: setSectionsEffect.of([{ id: 's0', role: 'user' }, { id: 's1', role: 'user' }]) }).state

    expect(hiddenAssets(user)).toStrictEqual([])
    expect(placeholders(user)).toStrictEqual([])
  })
})

describe('the lines that go out of view with a hidden asset', () => {
  it('takes the asset line and one blank line when blank lines or a section edge are on both sides', () => {
    // The blank line before the asset goes.
    expect(linesOutOfView([INVOKE, 'text', '', IMAGE, '', 'more'])).toStrictEqual([2, 3])
    expect(linesOutOfView([INVOKE, '', IMAGE, '', 'text'])).toStrictEqual([1, 2])
    expect(linesOutOfView([INVOKE, 'text', '', IMAGE])).toStrictEqual([2, 3])
    // At the section start, the one after it.
    expect(linesOutOfView([IMAGE, '', 'text', INVOKE])).toStrictEqual([0, 1])
    expect(linesOutOfView([IMAGE, INVOKE])).toStrictEqual([0])
  })

  it('takes only the asset line next to text: the blank line on the other side keeps the text apart', () => {
    expect(linesOutOfView([INVOKE, '', IMAGE, 'text'])).toStrictEqual([2])
    expect(linesOutOfView([INVOKE, 'text', IMAGE, '', 'more'])).toStrictEqual([2])
    expect(linesOutOfView([INVOKE, 'text', IMAGE, 'more'])).toStrictEqual([2])
    // The first line of a chip is text too.
    expect(linesOutOfView([INVOKE, '', IMAGE, CHIP])).toStrictEqual([2])
  })

  it('gives each of two assets its own blank line, so that one blank line stays', () => {
    expect(linesOutOfView([INVOKE, '', CLIP, '', IMAGE, '', 'text'])).toStrictEqual([1, 2, 3, 4])
  })

  it('takes assets on lines that follow each other as one', () => {
    expect(linesOutOfView([INVOKE, '', CLIP, IMAGE, '', 'text'])).toStrictEqual([1, 2, 3])
    expect(linesOutOfView([INVOKE, 'text', CLIP, IMAGE, '', 'more'])).toStrictEqual([2, 3])
  })
})

describe('hiddenAssetLines (what the trash of a hidden asset takes out)', () => {
  it('gives the asset line with the blank line that went out of view with it', () => {
    expect(removals([INVOKE, '', IMAGE, '', 'text'])).toStrictEqual([`\n${IMAGE}`])
    expect(removals([IMAGE, '', 'text', INVOKE])).toStrictEqual([`${IMAGE}\n`])
    expect(removals([INVOKE, '', CLIP, '', IMAGE, '', 'text'])).toStrictEqual([`\n${CLIP}`, `\n${IMAGE}`])
  })

  it('gives only the asset line when no blank line went with it, or another asset needs that line', () => {
    expect(removals([INVOKE, '', IMAGE, 'text'])).toStrictEqual([IMAGE])
    expect(removals([INVOKE, '', CLIP, IMAGE, '', 'text'])).toStrictEqual([CLIP, IMAGE])
  })

  it('gives null where no hidden asset starts', () => {
    const state = agentState([INVOKE, '', IMAGE])

    expect(hiddenAssetLines(state, 0)).toBeNull()
    expect(hiddenAssetLines(state, hiddenAssets(state)[0].from + 1)).toBeNull()
  })
})

describe('revealHiddenLineBackward and revealHiddenLineForward', () => {
  const lines = [INVOKE, '', IMAGE, 'text']
  const imageLine = (state: EditorState) => state.doc.lineAt(hiddenAssets(state)[0].from)

  it('puts the caret onto the line of the hidden asset, and changes no text', () => {
    const below = agentState(lines, { line: 3, offset: 0 })
    const backward = runCommand(below, revealHiddenLineBackward)

    expect(backward.handled).toBe(true)
    expect(backward.state.doc.eq(below.doc)).toBe(true)
    expect(backward.state.selection.main.head).toBe(imageLine(below).to)

    const above = agentState(lines, { line: 1, offset: 0 })
    const forward = runCommand(above, revealHiddenLineForward)

    expect(forward.handled).toBe(true)
    expect(forward.state.doc.eq(above.doc)).toBe(true)
    expect(forward.state.selection.main.head).toBe(imageLine(above).from)
  })

  it('leaves the key to the other rules when the caret is not next to the hidden line', () => {
    const inText = agentState(lines, { line: 3, offset: 2 })
    const atLineEnd = agentState(lines, { line: 3, offset: 4 })
    const onHiddenLine = agentState(lines, { line: 2, offset: IMAGE.length })

    expect(runCommand(inText, revealHiddenLineBackward).handled).toBe(false)
    expect(runCommand(atLineEnd, revealHiddenLineForward).handled).toBe(false)
    expect(runCommand(onHiddenLine, revealHiddenLineBackward).handled).toBe(false)
    expect(runCommand(onHiddenLine, revealHiddenLineForward).handled).toBe(false)
  })

  it('leaves a selection, two carets, and a line next to a shown image to the other rules', () => {
    const start = agentState(lines, { line: 3, offset: 0 }).selection.main.head
    const selected = createState(['ask', lines.join('\n')], ['user', 'agent'], [[start, start + 2]])
    const twoCarets = createState(['ask', lines.join('\n')], ['user', 'agent'], [start, start + 2])
    const shown = createState([[INVOKE, '', IMAGE, 'text'].join('\n')], ['user'], [[INVOKE, '', IMAGE, ''].join('\n').length])

    for (const state of [selected, twoCarets, shown]) {
      expect(runCommand(state, revealHiddenLineBackward)).toStrictEqual({ handled: false, state })
    }
  })
})

describe('the assets that a compaction keeps', () => {
  it('gives every asset of the block and the kept assets of the carried assets, in doc order with the assets of a job, and draws only the ones out of the block', () => {
    const notes = ['Notes.', '', KEPT_IMAGE, 'After the image.', '', KEPT_CLIP, '', SHOWN]
    const state = compactedState(notes, [KEPT_USER_IMAGE, SHOWN], [['agent', [INVOKE, '', IMAGE, '', 'Done.'].join('\n')]])

    expect(hiddenAssets(state).map((asset) => [asset.owner.kind, state.sliceDoc(asset.from, asset.to)])).toStrictEqual([
      ['compaction', KEPT_IMAGE],
      ['compaction', KEPT_CLIP],
      ['compaction', SHOWN],
      ['compaction', KEPT_USER_IMAGE],
      ['job', IMAGE],
    ])
    expect(renderedImages(state).map((image) => state.sliceDoc(image.from, image.to))).toStrictEqual([KEPT_IMAGE, SHOWN, KEPT_USER_IMAGE, SHOWN, IMAGE])
    expect(placeholders(state).sort()).toStrictEqual(['image b job', 'image u compaction'])
  })

  it('takes only the kept lines of the carried assets out of view, and gives the trash of each asset its whole lines', () => {
    // 1 tag, 2 kept image, 3 blank, 4 Notes., 5 blank, 6 kept clip, 7 blank,
    // 8 More., 9 end line, 10 separator, 11 Ask., 12 separator, 13 label,
    // 14 kept image, 15 shown image.
    const state = compactedState([KEPT_IMAGE, '', 'Notes.', '', KEPT_CLIP, '', 'More.'], [KEPT_USER_IMAGE, SHOWN])

    expect(lineNumbersOutOfView(state)).toStrictEqual([14])
    expect(hiddenAssets(state).map((asset) => {
      const range = hiddenAssetLines(state, asset.from)
      return range && state.sliceDoc(range.from, range.to)
    })).toStrictEqual([`${KEPT_IMAGE}\n`, `\n${KEPT_CLIP}`, KEPT_USER_IMAGE])
  })

  it('puts the caret onto a kept line with Backspace and Delete, and changes no text', () => {
    // 7 label, 8 kept image, 9 shown image.
    const { doc } = compactedState(['Notes.'], [KEPT_USER_IMAGE, SHOWN])
    const below = compactedState(['Notes.'], [KEPT_USER_IMAGE, SHOWN], [], [doc.line(9).from])
    const above = compactedState(['Notes.'], [KEPT_USER_IMAGE, SHOWN], [], [doc.line(7).to])
    const backward = runCommand(below, revealHiddenLineBackward)
    const forward = runCommand(above, revealHiddenLineForward)

    expect([backward.handled, backward.state.doc.eq(doc), backward.state.selection.main.head]).toStrictEqual([true, true, doc.line(8).to])
    expect([forward.handled, forward.state.doc.eq(doc), forward.state.selection.main.head]).toStrictEqual([true, true, doc.line(8).from])
  })

  it('shows a marked asset that no compaction keeps: after a reply, in a kept message, in an agent section, or with no tag', () => {
    const afterReply = compactedState(['Notes.'], [SHOWN], [['agent', 'Reply.'], ['user', `See:\n${KEPT_USER_IMAGE}`], ['user', `${CARRIED_USER_ASSETS_LABEL}\n${KEPT_USER_IMAGE}`]])
    const keptMessage = createState([[TAG, 'Notes.'].join('\n'), KEPT_USER_IMAGE], ['agent', 'user'])
    const laterAgent = compactedState(['Notes.'], [SHOWN], [['agent', KEPT_IMAGE]])
    const noTag = createState([['Notes.', '', KEPT_IMAGE].join('\n'), 'Ask.', [CARRIED_USER_ASSETS_LABEL, KEPT_USER_IMAGE].join('\n')], ['user', 'user', 'user'])

    for (const state of [afterReply, keptMessage, laterAgent, noTag]) {
      expect(hiddenAssets(state)).toStrictEqual([])
      expect(hiddenLineStarts(state)).toStrictEqual([])
      expect(placeholders(state)).toStrictEqual([])
      expect(renderedImages(state).length).toBeGreaterThan(0)
    }
  })

  it('shows an asset with both marks under the chip of its call, and one of a call in the block in the assets chip', () => {
    const both = `${IMAGE.slice(0, -1)}|kept=compaction)`
    const later = compactedState(['Notes.'], [], [['agent', [INVOKE, '', both, '', 'Done.'].join('\n')]])
    const inBlock = compactedState([INVOKE, '', both, '', 'Done.'], [])
    // The call in the block shows no chip, so it hides no asset of a later
    // reply.
    const afterBlock = compactedState([INVOKE, '', 'Done.'], [], [['agent', IMAGE]])

    expect(hiddenAssets(later).map((asset) => asset.owner)).toStrictEqual([{ kind: 'job', jobId: 'j-aaaa', callId: 'call_1' }])
    expect(hiddenAssets(inBlock).map((asset) => asset.owner)).toStrictEqual([{ kind: 'compaction' }])
    expect(hiddenAssets(afterBlock)).toStrictEqual([])
  })
})
