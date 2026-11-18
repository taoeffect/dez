import sbp from '@sbp/sbp'
import { undo } from '@codemirror/commands'
import { StateEffect, type EditorState, type TransactionSpec } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { beforeEach, describe, expect, it } from 'vitest'
import { idImage } from '../../model/chat/testing'
import type { Role } from '../../model/chat/types'
import { serializeSelectionForClipboard } from '../thread/cmEditor'
import { filePasteAndDrop } from './imageInsert'
import { pasteMentions, recordCopy } from './mentionPaste'
import { CHIP, createState, joinSections } from './testing'

interface ConfirmCall {
  message: string
  answer: (confirmed: boolean) => void
}

let confirmCalls: ConfirmCall[] = []
let toasts: { title?: string }[] = []

// Each prompt waits until the test answers it.
sbp('sbp/selectors/register', {
  'dez.ui/confirm' ({ message }: { message: string }): Promise<boolean> {
    return new Promise((resolve) => {
      confirmCalls.push({ message, answer: resolve })
    })
  },
  'dez.ui/toast' (_area: string, toast: { title?: string }): void {
    toasts.push(toast)
  },
  'dez.model/tabs/activeId' (): string {
    return 'tab-2'
  },
})

const image = (name: string) => `/home/u/.config/dez/assets/images/${name}.png`
const DUCK = image('duck')
const CAT = image('cat')

/** The clipboard text of a copy of `copied`, the end of a user section of
 *  the conversation `conv-1` whose image `@a` is `DUCK`, after a record of
 *  that copy. */
function copy(copied: string): string {
  const texts = [`${idImage(DUCK, 'a')}\n${copied}`]
  const end = joinSections(texts).length
  const state = createState(texts, ['user'], [[end - copied.length, end]])
  const text = serializeSelectionForClipboard(state)
  recordCopy(state, text, 'conv-1')
  return text
}

/** The state of the editor for `texts`, one section each, with the caret
 *  at `caret` (by default the doc end), and with the paste rules. */
function pasteState(texts: string[], roles: Role[], caret = joinSections(texts).length): EditorState {
  return createState(texts, roles, [caret]).update({ effects: StateEffect.appendConfig.of(filePasteAndDrop()) }).state
}

/** A view stand-in for the tab of the conversation `conv-2`. */
function createEditor(texts: string[], roles: Role[] = texts.map(() => 'user'), caret?: number) {
  let state = pasteState(texts, roles, caret)
  const view = {
    get state() {
      return state
    },
    dispatch(...specs: TransactionSpec[]) {
      state = state.update(...specs).state
    },
    hasFocus: false,
  } as unknown as EditorView
  return {
    view,
    doc: () => state.doc.toString(),
    caret: () => state.selection.main.head,
    undo: () => undo(view),
    /** Stands for `view.setState` on a tab switch or a stream-end rebuild. */
    replaceState(next: EditorState) {
      state = next
    },
  }
}

/** Answers the open prompt, and waits for the paste that follows. */
async function answer(confirmed: boolean): Promise<void> {
  expect(confirmCalls).toHaveLength(1)
  confirmCalls[0].answer(confirmed)
  await new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => {
  confirmCalls = []
  toasts = []
  // A copy with no mention clears the record of the test before.
  copy('no names')
})

describe('pasteMentions', () => {
  it('on Yes, puts a copy of a missing image at the top of the paste with a free id, and the mention follows; one undo takes it all back', async () => {
    const text = copy('Make @a blue')
    const before = `${idImage(CAT, 'a')}\nNote: `
    const editor = createEditor([before])

    expect(pasteMentions(editor.view, text, 'conv-2')).toBe(true)
    expect(editor.doc()).toBe(before)
    expect(confirmCalls[0].message).toBe('The pasted text names an asset of another conversation. Add it at the top of the paste, '
      + 'and the names in the text change to fit this conversation? No pastes the text as it is.')
    await answer(true)

    expect(editor.doc()).toBe(`${idImage(CAT, 'a')}\n${idImage(DUCK, 'b')}\nNote: Make @b blue`)
    expect(editor.caret()).toBe(editor.doc().length)
    expect(editor.undo()).toBe(true)
    expect(editor.doc()).toBe(before)
  })

  it('on Yes, gives a mention the id of the same image in this conversation, and puts no copy in', async () => {
    const text = copy('Make @a blue')
    const editor = createEditor([`${idImage(CAT, 'a')}\n${idImage(DUCK, 'b')}\n`])

    expect(pasteMentions(editor.view, text, 'conv-2')).toBe(true)
    expect(confirmCalls[0].message).toBe('This conversation has the assets that the pasted text names, under other ids. '
      + 'Change the names in the text to these ids? No pastes the text as it is.')
    await answer(true)

    expect(editor.doc()).toBe(`${idImage(CAT, 'a')}\n${idImage(DUCK, 'b')}\nMake @b blue`)
  })

  it('on No, pastes the text as it is', async () => {
    const text = copy('Make @a blue')
    const editor = createEditor([`${idImage(CAT, 'a')}\n`])

    expect(pasteMentions(editor.view, text, 'conv-2')).toBe(true)
    await answer(false)

    expect(editor.doc()).toBe(`${idImage(CAT, 'a')}\nMake @a blue`)
    expect(editor.caret()).toBe(editor.doc().length)
  })

  it('leaves to the plain paste a paste with nothing to change, in the same conversation, or of another text', () => {
    const text = copy('Make @a blue')
    const editor = createEditor([`${idImage(DUCK, 'a')}\n`])

    expect(pasteMentions(editor.view, text, 'conv-2')).toBe(false)
    expect(pasteMentions(createEditor([`${idImage(CAT, 'a')}\n`]).view, text, 'conv-1')).toBe(false)
    expect(pasteMentions(createEditor([`${idImage(CAT, 'a')}\n`]).view, 'Make @a red', 'conv-2')).toBe(false)
    expect(confirmCalls).toHaveLength(0)
  })

  it('leaves to the plain paste a paste right after a tool call chip, which the copies would split', () => {
    const text = copy('Make @a blue')
    const texts = ['Hi', `Done:\n${CHIP}`]

    expect(pasteMentions(createEditor(texts, ['user', 'agent']).view, text, 'conv-2')).toBe(false)
    expect(pasteMentions(createEditor(texts, ['user', 'agent'], joinSections(texts).length - CHIP.length).view, text, 'conv-2')).toBe(true)
  })

  it('pastes at the place that the edits made while the prompt was open moved', async () => {
    const text = copy('Make @a blue')
    const editor = createEditor(['Note: '])

    expect(pasteMentions(editor.view, text, 'conv-2')).toBe(true)
    editor.view.dispatch({ changes: { from: 0, insert: 'Hi\n' } })
    await answer(true)

    expect(editor.doc()).toBe(`Hi\n${idImage(DUCK, 'a')}\nNote: Make @a blue`)
  })

  it('pastes nothing in a rebuilt state, and a toast tells it', async () => {
    const text = copy('Make @a blue')
    const editor = createEditor(['Note: '])

    expect(pasteMentions(editor.view, text, 'conv-2')).toBe(true)
    editor.replaceState(pasteState(['Note: '], ['user']))
    await answer(true)

    expect(editor.doc()).toBe('Note: ')
    expect(toasts.map((toast) => toast.title)).toStrictEqual(['Text not pasted'])
  })
})
