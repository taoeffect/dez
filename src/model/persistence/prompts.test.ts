import { describe, expect, it } from 'vitest'
import { parsePromptsJson, serializePromptsJson } from './prompts'

describe('prompts persistence format', () => {
  it('falls back to an empty prompt list when JSON is malformed', () => {
    expect(parsePromptsJson('{')).toEqual([])
  })

  it('filters invalid prompt entries and serializes valid prompts', () => {
    const prompts = parsePromptsJson(JSON.stringify([
      { id: '1', name: 'a', content: 'body' },
      { id: '2', name: 'missing content' },
      null,
    ]))

    expect(prompts).toEqual([{ id: '1', name: 'a', content: 'body' }])
    expect(serializePromptsJson(prompts)).toBe(JSON.stringify(prompts, null, 2))
  })
})
