import { undo } from '@codemirror/commands'
import { EditorState, type Transaction, type TransactionSpec } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import sbp from '@sbp/sbp'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appTagText } from '../../model/chat/appTags'
import { compactionBlockText } from '../../model/chat/compaction'
import type { Role } from '../../model/chat/types'
import type { AppCardFacts } from '../../model/tools/appShow'
import { PILL_OPEN, sectionsField, setSectionThinkingEffect } from '../thread/cmEditor'
import { editsAgentText } from './agentTextEdits'
import { appRuns, carriedAppRuns, deleteApp, markdownApps, renderedApps, runAppEffect, stopAppEffect, type CarriedAppRun } from './apps'
import { createState, joinSections } from './testing'

// The line rules of the cards have their tests in `lineBlocks.test.ts`.

const NOTES = appTagText('notes')
const TIMER = appTagText('timer')

/** The name and the source of each tag that the editor shows as a card. */
function shown(state: EditorState): [string, string][] {
  return renderedApps(state).map((app) => [app.name, state.sliceDoc(app.from, app.to)])
}

describe('renderedApps', () => {
  it('shows the tags of every section, at their doc offsets, and one app more than once', () => {
    const stored = '<dez:app name="timer" open="1"/>'
    const texts = [`user\n${NOTES}`, `${stored}\nafter`, NOTES, `before\n${NOTES}`]
    const state = createState(texts, ['user', 'agent', 'user', 'agent'])

    expect(shown(state)).toStrictEqual([['notes', NOTES], ['timer', stored], ['notes', NOTES], ['notes', NOTES]])
    expect(renderedApps(state)[0].from).toBe(joinSections(texts).indexOf(NOTES))
  })

  it('leaves a tag that shares its line with text, and a tag with no valid name, as text', () => {
    const lines = [`${NOTES} text`, `text ${NOTES}`, '<dez:app name="My App"/>', '<dez:app name="../notes"/>', '<dez:app/>', '<dez:apps name="notes"/>']
    const state = createState(['ask', lines.join('\n')], ['user', 'agent'])

    expect(shown(state)).toStrictEqual([])
  })

  it('leaves a tag that holds a sentinel as text', () => {
    const state = createState(['ask', `<dez:app name="notes" note="x ${PILL_OPEN} y"/>`], ['user', 'agent'])

    expect(shown(state)).toStrictEqual([])
  })

  // In a reply, a line of Dez ends the code of the model; in a message of
  // the user, a tag in code is text.
  it('leaves a tag in code as text, shows one after an open fence of a reply, and one in the next section', () => {
    const state = createState(
      [`\`\`\`\n${NOTES}\n\`\`\``, `\`\`\`\n${TIMER}`, `\`\`\`\n${NOTES}`, appTagText('calc')],
      ['user', 'agent', 'user', 'user'],
    )

    expect(shown(state).map(([name]) => name)).toStrictEqual(['timer', 'calc'])
  })

  it('shows no card for a tag in the compaction block, which is out of view as a whole', () => {
    const block = compactionBlockText({ count: 1, lastId: 'c', pictures: [] }, `Notes of the work.\n${NOTES}`)
    const state = createState([`${block}\n${TIMER}\nThe reply.`, `ask\n${NOTES}`], ['agent', 'user'])

    expect(shown(state)).toStrictEqual([['timer', TIMER], ['notes', NOTES]])
    expect(renderedApps(state)[0].from).toBe(block.length + 1)
  })

  it('keeps the same array until a change can change the cards', () => {
    const state = createState(['ask', NOTES], ['user', 'agent'])
    const apps = renderedApps(state)
    const moved = state.update({ selection: { anchor: 0 } }).state
    expect(renderedApps(moved)).toBe(apps)
    const thought = moved.update({ effects: setSectionThinkingEffect.of({ sectionId: 's1', thinking: { text: 'hmm' } }) }).state
    expect(renderedApps(thought)).toBe(apps)
    const typed = thought.update({ changes: { from: 0, insert: 'x' } }).state
    expect(renderedApps(typed)).not.toBe(apps)
    expect(renderedApps(typed)[0].from).toBe(apps[0].from + 1)
  })
})

/** The state after a click on Run of each card of `cards` (indexes in doc
 *  order), in that order. */
function started(state: EditorState, ...cards: number[]): EditorState {
  return cards.reduce((next, card) => next.update({ effects: runAppEffect.of(renderedApps(next)[card].from) }).state, state)
}

/** The app and the source text at the place of each run. */
function running(state: EditorState): [string, string][] {
  return appRuns(state).map((run) => [run.name, state.sliceDoc(run.from, run.from + appTagText(run.name).length)])
}

describe('appRuns', () => {
  it('starts the app of a card once, and no app where no card is', () => {
    const state = createState(['ask', `text\n${NOTES}`], ['user', 'agent'])
    expect(appRuns(state)).toStrictEqual([])

    const once = started(state, 0)
    expect(running(once)).toStrictEqual([['notes', NOTES]])
    expect(appRuns(started(once, 0))).toBe(appRuns(once))
    expect(appRuns(state.update({ effects: runAppEffect.of(0) }).state)).toStrictEqual([])
  })

  it('runs two cards of one app on their own, and a stop ends only its run', () => {
    const state = started(createState(['ask', `${NOTES}\n${TIMER}\n${NOTES}`], ['user', 'agent']), 2, 0)
    const [last, first] = appRuns(state)
    expect(first.id).not.toBe(last.id)
    expect(first.from).toBe(renderedApps(state)[0].from)
    expect(last.from).toBe(renderedApps(state)[2].from)

    const stopped = state.update({ effects: stopAppEffect.of(last.id) }).state
    expect(appRuns(stopped)).toStrictEqual([first])
    expect(appRuns(stopped.update({ effects: stopAppEffect.of(last.id) }).state)).toBe(appRuns(stopped))
  })

  it('keeps a run at its tag through the changes around it', () => {
    const state = started(createState(['ask', `text\n${NOTES}\nend`], ['user', 'agent']), 0)
    const [run] = appRuns(state)

    const typedBefore = state.update({ changes: { from: 0, insert: 'More. ' } }).state
    expect(appRuns(typedBefore)).toStrictEqual([{ ...run, from: run.from + 6 }])
    expect(running(typedBefore)).toStrictEqual([['notes', NOTES]])
    // The text of a stream replaces text before the tag, up to its line.
    const replacedBefore = state.update({ changes: { from: run.from - 5, to: run.from - 1, insert: 'a longer text' } }).state
    expect(running(replacedBefore)).toStrictEqual([['notes', NOTES]])
    expect(appRuns(replacedBefore)[0].id).toBe(run.id)
    const typedAfter = state.update({ changes: { from: state.doc.length, insert: ' more' } }).state
    expect(appRuns(typedAfter)).toBe(appRuns(state))
    expect(appRuns(state.update({ selection: { anchor: 0 } }).state)).toBe(appRuns(state))
  })

  it('ends a run whose tag is deleted, names another app, or is replaced', () => {
    const doc = `${NOTES}\n${NOTES}`
    const state = started(createState(['ask', doc], ['user', 'agent']), 0)
    const [{ from }] = appRuns(state)
    const to = from + NOTES.length

    expect(appRuns(state.update({ changes: { from, to: to + 1 } }).state)).toStrictEqual([])
    expect(appRuns(state.update({ changes: { from: from + NOTES.indexOf('notes'), to: from + NOTES.indexOf('notes') + 5, insert: 'timer' } }).state)).toStrictEqual([])
    // The second card is at the old place of the first one now, and it is
    // not the card that the user started.
    const joined = state.update({ changes: { from: from - 1, to: to + 1, insert: '\n' } }).state
    expect(renderedApps(joined).map((app) => app.from)).toStrictEqual([from])
    expect(appRuns(joined)).toStrictEqual([])
  })
})

describe('carriedAppRuns', () => {
  function stateWith(texts: string[], roles: Role[], carried: readonly CarriedAppRun[]): EditorState {
    return EditorState.create({
      doc: joinSections(texts),
      extensions: [sectionsField.init(() => roles.map((role, index) => ({ id: `s${index}`, role }))), markdownApps(carried)],
    })
  }

  // The end of a stream and a compaction give the editor a new state, whose
  // doc can have other text before the tag of a run.
  it('gives each run to its card in a new state of the conversation', () => {
    const before = started(createState(['ask', `${NOTES}\ntext\n${TIMER}\n${NOTES}`], ['user', 'agent']), 0, 1, 2)
    const [first, timer, last] = appRuns(before)
    const carried = carriedAppRuns(before)
    expect(carried).toStrictEqual([{ id: first.id, name: 'notes', later: 1 }, { id: timer.id, name: 'timer', later: 0 }, { id: last.id, name: 'notes', later: 0 }])

    const same = stateWith(['ask', `A longer start.\n${NOTES}\ntext\n${TIMER}\n${NOTES}`, 'next'], ['user', 'agent', 'user'], carried)
    expect(appRuns(same).map((run) => run.id)).toStrictEqual([first.id, timer.id, last.id])
    expect(appRuns(same).map((run) => run.from)).toStrictEqual(renderedApps(same).map((app) => app.from))

    // The first card went into the notes of a compaction: its run ends.
    const block = compactionBlockText({ count: 1, lastId: 'c', pictures: [] }, `Notes of the work.\n${NOTES}`)
    const compacted = stateWith([`${block}\n${TIMER}\n${NOTES}`, 'next'], ['agent', 'user'], carried)
    expect(appRuns(compacted).map((run) => run.id)).toStrictEqual([timer.id, last.id])
    expect(running(compacted)).toStrictEqual([['timer', TIMER], ['notes', NOTES]])

    expect(appRuns(stateWith(['another conversation'], ['user'], carried))).toStrictEqual([])
  })
})

describe('deleteApp (the trash of an app)', () => {
  const READY: AppCardFacts = { state: 'ready', description: 'Keeps notes.', size: { bytes: 2048, more: false } }

  // What the stub selectors do, and what they got.
  let facts: Record<string, AppCardFacts> = {}
  let answer: () => boolean = () => true
  let deleteFolder: () => Promise<void> = async () => {}
  let confirmMessages: string[] = []
  let deletedApps: string[] = []
  let toastTitles: string[] = []
  // The state and each transaction of the stand-in view.
  let state: EditorState
  let transactions: Transaction[] = []

  sbp('sbp/selectors/register', {
    async 'dez.ui/confirm' ({ message }: { message: string }): Promise<boolean> {
      confirmMessages.push(message)
      return answer()
    },
    async 'dez.controller/apps/card' (name: string): Promise<AppCardFacts> {
      return facts[name] ?? { state: 'missing' }
    },
    async 'dez.controller/apps/delete' (name: string): Promise<void> {
      deletedApps.push(name)
      await deleteFolder()
    },
    'dez.ui/toast' (_area: string, toast: { title: string }): void {
      toastTitles.push(toast.title)
    },
    'dez.model/tabs/activeId' (): string {
      return 'tab-1'
    },
  })

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
    dom: { contains: () => false },
    // The editor draws no card here.
    contentDOM: { querySelectorAll: () => [] },
  } as unknown as EditorView

  /** A conversation whose reply shows the notes app two times and the
   *  timer app once, with a run of each card, after a typed `!` that undo
   *  can take back. */
  function open(): void {
    state = started(createState(['ask', `before\n${NOTES}\n${TIMER}\n${NOTES}\nafter`], ['user', 'agent']), 0, 1, 2)
    state = state.update({ changes: { from: state.doc.length, insert: '!' }, userEvent: 'input.type' }).state
    transactions = []
  }

  /** The trash of the card `card` (an index in doc order). */
  function trash(card: number): Promise<void> {
    return deleteApp(view, renderedApps(state)[card].from)
  }

  function sectionText(): string {
    return state.doc.toString().slice(state.doc.toString().indexOf('before'))
  }

  function undoOnce(): string {
    let undone = state
    expect(undo({ state, dispatch: (tr) => { undone = tr.state } })).toBe(true)
    return undone.doc.toString().slice(undone.doc.toString().indexOf('before'))
  }

  beforeEach(() => {
    facts = { notes: READY, timer: READY }
    answer = () => true
    deleteFolder = async () => {}
    confirmMessages = []
    deletedApps = []
    toastTitles = []
    vi.stubGlobal('document', { fullscreenElement: null })
    open()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('deletes the app, ends each run of it, and takes only the line of its card out, in a step that undo skips', async () => {
    await trash(0)

    expect(confirmMessages).toStrictEqual(['Are you sure you want to delete the app notes? Dez deletes the folder of the app with all its files. No conversation can run the app after that.'])
    expect(deletedApps).toStrictEqual(['notes'])
    expect(sectionText()).toBe(`before\n${TIMER}\n${NOTES}\nafter!`)
    expect(running(state)).toStrictEqual([['timer', TIMER]])
    expect(undoOnce()).toBe(`before\n${TIMER}\n${NOTES}\nafter`)
    expect(toastTitles).toStrictEqual([])
    // The edited flag of the tab (agentTextEdits.ts).
    expect(transactions.some(editsAgentText)).toBe(true)
  })

  it('changes nothing when the user answers "No"', async () => {
    answer = () => false
    const runs = appRuns(state)

    await trash(0)

    expect(deletedApps).toStrictEqual([])
    expect(sectionText()).toBe(`before\n${NOTES}\n${TIMER}\n${NOTES}\nafter!`)
    expect(appRuns(state)).toBe(runs)
  })

  it('keeps the card and the runs when the delete fails', async () => {
    deleteFolder = async () => { throw new Error('Permission denied') }
    const runs = appRuns(state)

    await trash(2)

    expect(deletedApps).toStrictEqual(['notes'])
    expect(sectionText()).toBe(`before\n${NOTES}\n${TIMER}\n${NOTES}\nafter!`)
    expect(appRuns(state)).toBe(runs)
  })

  it('deletes no file for the card of an app that is gone, and takes its line out in a step that undo takes back', async () => {
    delete facts.timer

    await trash(1)

    expect(confirmMessages).toStrictEqual(['Are you sure you want to remove the card of the app timer from the conversation? The app is gone, so Dez deletes no file.'])
    expect(deletedApps).toStrictEqual([])
    expect(sectionText()).toBe(`before\n${NOTES}\n${NOTES}\nafter!`)
    expect(undoOnce()).toBe(`before\n${NOTES}\n${TIMER}\n${NOTES}\nafter!`)
  })

  it('deletes no file when the card went while the prompt was open, and tells the user', async () => {
    answer = () => {
      const [card] = renderedApps(state)
      view.dispatch({ changes: { from: card.from, to: card.to, insert: 'text' } })
      return true
    }

    await trash(0)

    expect(deletedApps).toStrictEqual([])
    expect(toastTitles).toStrictEqual(['App not deleted'])
    expect(sectionText()).toBe(`before\ntext\n${TIMER}\n${NOTES}\nafter!`)
  })

  // A stream can move the card while the prompt is open.
  it('follows its card through a change before it, and deletes that card, not the other one of the app', async () => {
    answer = () => {
      view.dispatch({ changes: { from: state.doc.toString().indexOf('before'), insert: 'More text. ' } })
      return true
    }

    await trash(2)

    expect(deletedApps).toStrictEqual(['notes'])
    expect(sectionText()).toBe(`before\n${NOTES}\n${TIMER}\nafter!`)
  })
})
