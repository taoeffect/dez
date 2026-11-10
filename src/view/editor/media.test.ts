import { EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { mediaTagText, type MediaTagKind } from '../../model/chat/mediaTags'
import type { Role } from '../../model/chat/types'
import { PILL_OPEN, SECTION_SEP, sectionsField, setSectionsEffect, setSectionThinkingEffect } from '../thread/cmEditor'
import { markdownMedia, renderedMedia } from './media'

function tag(kind: MediaTagKind, id: string): string {
  return mediaTagText({ kind, id, type: `${kind}/webm`, src: `https://cdn.example/${id}.webm`, url: `https://cdn.example/${id}.webm`, expires: null, other: [] })
}

/** A state whose doc is `texts`, one section each, with the roles of
 *  `roles` (section ids `s0`, `s1`, …). The first section is always `user`
 *  (`normalizeSectionModels` in cmEditor.ts). The line rules of the players
 *  have their tests in `lineBlocks.test.ts`. */
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
  it('shows tags of agent sections only, at their doc offsets', () => {
    const state = createState(
      [`user\n${tag('video', 'u')}`, `${tag('video', 'a')}\nafter`, tag('audio', 'v'), `before\n${tag('audio', 'b')}`],
      ['user', 'agent', 'user', 'agent'],
    )
    expect(shown(state)).toEqual([
      ['video', 'a', tag('video', 'a')],
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

  it('shows and hides the players when only the section roles change', () => {
    const state = createState(['ask', tag('audio', 'a')], ['user', 'user'])
    expect(shown(state)).toEqual([])
    const agent = state.update({ effects: setSectionsEffect.of([{ id: 's0', role: 'user' }, { id: 's1', role: 'agent' }]) }).state
    expect(shown(agent)).toEqual([['audio', 'a', tag('audio', 'a')]])
    const user = agent.update({ effects: setSectionsEffect.of([{ id: 's0', role: 'user' }, { id: 's1', role: 'user' }]) }).state
    expect(shown(user)).toEqual([])
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
