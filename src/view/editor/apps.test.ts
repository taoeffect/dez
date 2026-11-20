import type { EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { appTagText } from '../../model/chat/appTags'
import { compactionBlockText } from '../../model/chat/compaction'
import { PILL_OPEN, setSectionThinkingEffect } from '../thread/cmEditor'
import { renderedApps } from './apps'
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
