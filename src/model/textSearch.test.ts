import { describe, expect, it } from 'vitest'
import { searchTerms, textMatches } from './textSearch'

describe('searchTerms', () => {
  it('splits a query into lower-case words of letters and digits', () => {
    expect(searchTerms('  Llama-3.1_70B  gpt/4o ')).toStrictEqual(['llama', '3', '1', '70b', 'gpt', '4o'])
  })

  it('gives no words for a blank or punctuation-only query', () => {
    expect(searchTerms('')).toStrictEqual([])
    expect(searchTerms(' -- / ')).toStrictEqual([])
    expect(searchTerms('*')).toStrictEqual([])
  })
})

describe('textMatches', () => {
  // The fields of a model in the picker: provider name, provider id, model
  // name, model id.
  const MINI = ['Acme Cloud', 'acme-cloud', 'GPT-4o Mini', 'gpt-4o-mini']
  const matches = (fields: readonly string[], query: string) => textMatches(fields, searchTerms(query))

  it('matches every text when there are no terms', () => {
    expect(textMatches(MINI, [])).toBe(true)
    expect(textMatches([], [])).toBe(true)
  })

  it('needs every term, in any order', () => {
    expect(matches(MINI, 'mini 4o')).toBe(true)
    expect(matches(MINI, '4o mini')).toBe(true)
    expect(matches(MINI, 'mini max')).toBe(false)
  })

  it('matches a term that is a substring of one field', () => {
    expect(textMatches(MINI, ['ini'])).toBe(true)
    expect(textMatches(MINI, ['me'])).toBe(true)
    expect(textMatches(['Cobalt', 'c3'], ['c3'])).toBe(true)
  })

  it('matches a term made of the starts of consecutive words of one field', () => {
    expect(textMatches(MINI, ['acmecloud'])).toBe(true)
    expect(textMatches(MINI, ['gpt4omini'])).toBe(true)
    expect(textMatches(MINI, ['gp4om'])).toBe(true)
    expect(textMatches(MINI, ['4pg'])).toBe(false)
  })

  it('starts a word at a lower-to-upper case change and at a letter-digit change', () => {
    expect(textMatches(['DeepSeek V3.1'], ['dsv31'])).toBe(true)
    expect(textMatches(['Qwen3 Coder'], ['q3c'])).toBe(true)
    expect(textMatches(['unit-converter/src/MainView.vue'], ['ucsmv'])).toBe(true)
  })

  it('never lets a term skip a word or span two fields', () => {
    // `g4m` skips the `o` of `gpt-4o-mini`; `cloudgpt` spans the provider
    // name and the model name.
    expect(textMatches(MINI, ['g4m'])).toBe(false)
    expect(textMatches(MINI, ['cloudgpt'])).toBe(false)
    // Junk that looser rules give on a real model list.
    expect(textMatches(['Pareto Code Router', 'pareto-code-router'], ['pro'])).toBe(false)
    expect(textMatches(['OpenRouter', 'openrouter', 'OpenAI: GPT-5 Mini', 'openai/gpt-5-mini'], ['gemini'])).toBe(false)
  })

  it('ignores case and punctuation in the query and the fields', () => {
    expect(matches(['Llama 3.1 70B'], 'LLAMA 3 1')).toBe(true)
    expect(matches(['meta/llama-3.1-70b'], 'llama-3.1')).toBe(true)
  })
})
