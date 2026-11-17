import { describe, expect, it } from 'vitest'
import { compactionBlockText } from '../chat/compaction'
import { sectionPlainText } from '../chat/content'
import type { Section } from '../chat/types'
import { endStreamSection } from './sections'
import { reply, user } from './testing'

describe('endStreamSection', () => {
  const BLOCK = compactionBlockText({ count: 1, lastId: null, pictures: [] }, '## Summary\nA fox.')
  // The compaction section of a reply that a compaction ran in, with
  // `replyText` after the block, and thinking.
  const compacted = (replyText: string): Section => ({ ...reply('r', `${BLOCK}\n${replyText}`), thinking: { text: 'Plan.' } })
  const ended = (section: Section, status: 'finished' | 'error' | 'cancelled') => {
    const sections = [section]
    endStreamSection(sections, section, status, 900)
    return sections.map((each) => ({ id: each.id, role: each.role, text: sectionPlainText(each), thinking: each.thinking, durationMs: each.durationMs }))
  }

  it('removes the section of a stopped reply with no text, and adds no user section', () => {
    const sections = [user('u', 'Hi'), reply('r', '  ')]
    endStreamSection(sections, sections[1], 'cancelled', 900)

    expect(sections.map(({ id }) => id)).toStrictEqual(['u'])
  })

  it('keeps the compaction section of a reply with its text and thinking, with the time, and adds a user section', () => {
    expect(ended(compacted('Done.'), 'finished')).toStrictEqual([
      { id: 'r', role: 'agent', text: `${BLOCK}\nDone.`, thinking: { text: 'Plan.' }, durationMs: 900 },
      { id: expect.any(String), role: 'user', text: '', thinking: undefined, durationMs: undefined },
    ])
  })

  it('keeps the block of a reply with no text, with no line after it, and adds a user section', () => {
    expect(ended(compacted(' \n'), 'finished')).toStrictEqual([
      { id: 'r', role: 'agent', text: BLOCK, thinking: { text: 'Plan.' }, durationMs: 900 },
      { id: expect.any(String), role: 'user', text: '', thinking: undefined, durationMs: undefined },
    ])
  })

  // The notes hold the message of the user: the section never goes, and
  // the next message needs a user section.
  it('keeps the block of a stopped reply with no text, with no thinking and no time, and adds a user section', () => {
    expect(ended(compacted(''), 'cancelled')).toStrictEqual([
      { id: 'r', role: 'agent', text: BLOCK, thinking: undefined, durationMs: undefined },
      { id: expect.any(String), role: 'user', text: '', thinking: undefined, durationMs: undefined },
    ])
  })
})
