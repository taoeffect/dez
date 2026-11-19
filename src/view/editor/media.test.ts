import sbp from '@sbp/sbp'
import { history, undo } from '@codemirror/commands'
import { EditorState, type Transaction, type TransactionSpec } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mediaTagText, type MediaTagData, type MediaTagKind } from '../../model/chat/mediaTags'
import type { Role } from '../../model/chat/types'
import { PILL_OPEN, SECTION_SEP, sectionsField, setSectionThinkingEffect } from '../thread/cmEditor'
import { editsAgentText } from './agentTextEdits'
import { deleteSavedClip, markdownMedia, renderedMedia } from './media'

let confirmMessages: string[] = []
let deletedPaths: string[] = []

sbp('sbp/selectors/register', {
  async 'dez.ui/confirm' ({ message }: { message: string }): Promise<boolean> {
    confirmMessages.push(message)
    return true
  },
  async 'dez.controller/media/delete' (path: string): Promise<void> {
    deletedPaths.push(path)
  },
  'dez.model/tabs/activeId' (): string {
    return 'tab-1'
  },
})

beforeEach(() => {
  confirmMessages = []
  deletedPaths = []
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function tag(kind: MediaTagKind, id: string): string {
  return mediaTagText({ kind, id, type: `${kind}/webm`, src: `https://cdn.example/${id}.webm`, url: `https://cdn.example/${id}.webm`, expires: null, other: [] })
}

/** A state whose doc is `texts`, one section each, with the roles of
 *  `roles` (section ids `s0`, `s1`, …). The first section is `user`, as
 *  its text starts with no compaction tag (`normalizeSectionModels` in
 *  cmEditor.ts). The line rules of the players have their tests in
 *  `lineBlocks.test.ts`. */
function createState(texts: string[], roles: Role[]): EditorState {
  return EditorState.create({
    doc: texts.join(`\n${SECTION_SEP}\n`),
    extensions: [
      sectionsField.init(() => roles.map((role, index) => ({ id: `s${index}`, role }))),
      markdownMedia(),
    ],
  })
}

/** The kind, id, and source of each tag that the editor shows as a player. */
function shown(state: EditorState): [string, string, string][] {
  return renderedMedia(state).map((media) => [media.kind, media.id, state.sliceDoc(media.from, media.to)])
}

describe('renderedMedia', () => {
  it('shows the tags of every section, at their doc offsets', () => {
    const state = createState(
      [`user\n${tag('video', 'u')}`, `${tag('video', 'a')}\nafter`, tag('audio', 'v'), `before\n${tag('audio', 'b')}`],
      ['user', 'agent', 'user', 'agent'],
    )
    expect(shown(state)).toStrictEqual([
      ['video', 'u', tag('video', 'u')],
      ['video', 'a', tag('video', 'a')],
      ['audio', 'v', tag('audio', 'v')],
      ['audio', 'b', tag('audio', 'b')],
    ])
  })

  it('leaves a tag that shares its line with text as text', () => {
    const state = createState(['ask', `${tag('video', 'a')} text\ntext ${tag('video', 'b')}`], ['user', 'agent'])
    expect(shown(state)).toEqual([])
  })

  it('leaves a tag that holds a sentinel as text', () => {
    const state = createState(['ask', `<dez:video id="a" type="video/webm" note="x ${PILL_OPEN} y"/>`], ['user', 'agent'])
    expect(shown(state)).toEqual([])
  })

  // In a reply, a line of Dez ends the code of the model; in a message of
  // the user, a tag in code is text.
  it('leaves a tag in code as text, shows one after an open fence of a reply, and one in the next section', () => {
    const state = createState(
      [`\`\`\`\n${tag('video', 'a')}\n\`\`\``, `\`\`\`\n${tag('audio', 'b')}`, `\`\`\`\n${tag('video', 'c')}`, tag('video', 'd')],
      ['user', 'agent', 'user', 'user'],
    )
    expect(shown(state).map(([, id]) => id)).toEqual(['b', 'd'])
  })

  it('keeps the same array until a change can change the players', () => {
    const state = createState(['ask', tag('video', 'a')], ['user', 'agent'])
    const media = renderedMedia(state)
    const moved = state.update({ selection: { anchor: 0 } }).state
    expect(renderedMedia(moved)).toBe(media)
    const thought = moved.update({ effects: setSectionThinkingEffect.of({ sectionId: 's1', thinking: { text: 'hmm' } }) }).state
    expect(renderedMedia(thought)).toBe(media)
    const typed = thought.update({ changes: { from: 0, insert: 'x' } }).state
    expect(renderedMedia(typed)).not.toBe(media)
    expect(renderedMedia(typed)[0].from).toBe(media[0].from + 1)
  })
})

describe('deleteSavedClip (the trash of a player)', () => {
  // Each transaction that the view of the last `deleteClip` got.
  let transactions: Transaction[] = []

  /** Deletes the clip `clip`, whose tag is the middle line of a section of
   *  `role` (after a user section for an agent section), after a typed `!`
   *  that undo can take back. The view and the player root are stand-ins.
   *  Returns the state at the end. */
  async function deleteClip(clip: MediaTagData, role: Role = 'user'): Promise<EditorState> {
    const text = mediaTagText(clip)
    const before = role === 'agent' ? `ask\n${SECTION_SEP}\nbefore\n` : 'before\n'
    let state = EditorState.create({
      doc: `${before}${text}\nafter`,
      extensions: [
        sectionsField.init(() => (role === 'agent' ? [{ id: 's0', role: 'user' }, { id: 's1', role: 'agent' }] : [{ id: 's0', role: 'user' }])),
        markdownMedia(),
        history(),
      ],
    })
    state = state.update({ changes: { from: state.doc.length, insert: '!' }, userEvent: 'input.type' }).state
    transactions = []
    const view = {
      get state() {
        return state
      },
      dispatch(spec: TransactionSpec) {
        const tr = state.update(spec)
        transactions.push(tr)
        state = tr.state
      },
      hasFocus: false,
    } as unknown as EditorView
    vi.stubGlobal('document', { fullscreenElement: null })
    await deleteSavedClip(view, { contains: () => false } as unknown as HTMLElement, () => before.length, clip)
    return state
  }

  function undoOnce(state: EditorState): string {
    let undone = state
    expect(undo({ state, dispatch: (tr) => { undone = tr.state } })).toBe(true)
    return undone.doc.toString()
  }

  it('deletes a pasted clip and its tag line, in a step that undo skips', async () => {
    const path = '/home/u/.config/dez/assets/video/x.mp4'

    const state = await deleteClip({ kind: 'video', id: 'b', type: 'video/mp4', src: path, url: null, expires: null, other: [] })

    expect(confirmMessages).toStrictEqual(['Are you sure you want to delete this clip?'])
    expect(deletedPaths).toStrictEqual([path])
    expect(state.doc.toString()).toBe('before\nafter!')
    expect(undoOnce(state)).toBe('before\nafter')
  })

  it('deletes the saved file of a generated clip, and gives its tag the provider URL again', async () => {
    const path = '/home/u/.config/dez/assets/generated/video/x.mp4'
    const clip: MediaTagData = { kind: 'video', id: 'b', type: 'video/mp4', src: path, url: 'https://cdn.example/x.mp4', expires: null, other: [] }

    const state = await deleteClip(clip)

    expect(confirmMessages).toStrictEqual(['Are you sure you want to delete the saved file of this clip?'])
    expect(deletedPaths).toStrictEqual([path])
    const unsaved = mediaTagText({ ...clip, src: clip.url })
    expect(state.doc.toString()).toBe(`before\n${unsaved}\nafter!`)
    expect(undoOnce(state)).toBe(`before\n${unsaved}\nafter`)
  })

  // The edited flag of the tab (agentTextEdits.ts).
  it('makes the delete of a clip of a reply a change of the reply by the user', async () => {
    const path = '/home/u/.config/dez/assets/generated/video/x.mp4'

    const state = await deleteClip({ kind: 'video', id: 'b', type: 'video/mp4', src: path, url: 'https://cdn.example/x.mp4', expires: null, other: [] }, 'agent')

    expect(deletedPaths).toStrictEqual([path])
    expect(state.doc.toString()).toContain('src="https://cdn.example/x.mp4"')
    expect(transactions.some(editsAgentText)).toBe(true)
  })

  it('removes the tag line of a linked clip, whose file stays, in a step that undo takes back', async () => {
    const clip: MediaTagData = { kind: 'audio', id: 'b', type: 'audio/wav', src: '/home/u/Music/song.wav', url: null, expires: null, other: [] }

    const state = await deleteClip(clip)

    expect(confirmMessages).toStrictEqual(['Are you sure you want to remove this clip from the conversation? Its file stays where it is.'])
    expect(deletedPaths).toStrictEqual([])
    expect(state.doc.toString()).toBe('before\nafter!')
    expect(undoOnce(state)).toBe(`before\n${mediaTagText(clip)}\nafter!`)
  })

  it('warns at the delete of a saved file when the URL that the clip goes back to has expired', async () => {
    const path = '/home/u/.config/dez/assets/generated/video/x.mp4'
    const clip = (expires: number): MediaTagData => ({ kind: 'video', id: 'b', type: 'video/mp4', src: path, url: 'https://cdn.example/x.mp4', expires: new Date(expires).toISOString(), other: [] })

    await deleteClip(clip(Date.now() - 1000))
    await deleteClip(clip(Date.now() + 60 * 60 * 1000))

    expect(confirmMessages).toStrictEqual([
      'Are you sure you want to delete the saved file of this clip? The web address of the clip has expired, so the clip can stop playing after that.',
      'Are you sure you want to delete the saved file of this clip?',
    ])
    expect(deletedPaths).toStrictEqual([path, path])
  })
})
