import { describe, expect, it } from 'vitest'
import type { ModelOutput } from '../../model/modelOutputs'
import { searchTerms } from '../../model/modelSearch'
import { providerInfo } from '../../model/providers/testing'
import type { ModelInfo } from '../../model/providers'
import { pickerRows, type PickerRow, type PickerRowsInput } from './pickerRows'

const ACME = providerInfo('acme', 'Acme Cloud')
const BETA = providerInfo('beta', 'Beta Hub')
const MODELS: ModelInfo[] = [
  { id: 'gpt-4o', name: 'GPT-4o', provider: ACME.id, outputs: ['text'] },
  { id: 'painter', name: 'Painter', provider: ACME.id, outputs: ['image'] },
  { id: 'llama', name: 'Llama', provider: BETA.id },
  // The same model id as a model of Acme Cloud.
  { id: 'gpt-4o', name: 'GPT-4o (Beta)', provider: BETA.id },
]
const GPT_ACME = { providerId: ACME.id, modelId: 'gpt-4o' }
const GPT_BETA = { providerId: BETA.id, modelId: 'gpt-4o' }
const PAINTER = { providerId: ACME.id, modelId: 'painter' }

function rows (input: Partial<PickerRowsInput> & { search?: string, outputs?: ModelOutput[] } = {}): PickerRow[] {
  const { search = '', outputs = [], ...rest } = input
  return pickerRows({
    providers: [ACME, BETA],
    models: MODELS,
    query: { terms: searchTerms(search), outputs },
    favorites: null,
    none: false,
    ...rest,
  })
}

/** The rows as one line each: `none`, `# <header>`, or `<provider name> ›
 *  <model name>`. */
function lines (list: PickerRow[]): string[] {
  return list.map((row) => {
    if (row.kind === 'none') return 'none'
    if (row.kind === 'header') return `# ${row.label}`
    return `${row.providerName} › ${row.model.name}`
  })
}

describe('pickerRows', () => {
  it('lists the None row, the Favorites group in favorites order, then one group per provider', () => {
    expect(lines(rows({ none: true, favorites: [PAINTER, GPT_BETA] }))).toStrictEqual([
      'none',
      '# Favorites',
      'Acme Cloud › Painter',
      'Beta Hub › GPT-4o (Beta)',
      '# Acme Cloud',
      'Acme Cloud › GPT-4o',
      'Acme Cloud › Painter',
      '# Beta Hub',
      'Beta Hub › Llama',
      'Beta Hub › GPT-4o (Beta)',
    ])
  })

  it('has no None row and no Favorites group unless the picker asks for them', () => {
    expect(lines(rows())).toStrictEqual([
      '# Acme Cloud',
      'Acme Cloud › GPT-4o',
      'Acme Cloud › Painter',
      '# Beta Hub',
      'Beta Hub › Llama',
      'Beta Hub › GPT-4o (Beta)',
    ])
    // Favorites are on, but there is none: no header.
    expect(lines(rows({ favorites: [] }))[0]).toBe('# Acme Cloud')
  })

  it('applies the search and the output filter to every group, and leaves out a group with no match', () => {
    expect(lines(rows({ none: true, favorites: [PAINTER, GPT_BETA], search: 'gpt' }))).toStrictEqual([
      'none',
      '# Favorites',
      'Beta Hub › GPT-4o (Beta)',
      '# Acme Cloud',
      'Acme Cloud › GPT-4o',
      '# Beta Hub',
      'Beta Hub › GPT-4o (Beta)',
    ])
    expect(lines(rows({ favorites: [GPT_ACME, GPT_BETA], outputs: ['image'] }))).toStrictEqual([
      '# Acme Cloud',
      'Acme Cloud › Painter',
    ])
  })

  it('keeps only the None row when no model matches', () => {
    expect(lines(rows({ none: true, favorites: [PAINTER], search: 'no such model' }))).toStrictEqual(['none'])
    expect(rows({ search: 'no such model' })).toStrictEqual([])
  })

  it('leaves out a favorite whose model or provider is not in the lists', () => {
    const favorites = [{ providerId: ACME.id, modelId: 'gone' }, { providerId: 'removed', modelId: 'gpt-4o' }, PAINTER]
    expect(lines(rows({ favorites })).slice(0, 3)).toStrictEqual([
      '# Favorites',
      'Acme Cloud › Painter',
      '# Acme Cloud',
    ])
    expect(lines(rows({ favorites: favorites.slice(0, 2) }))[0]).toBe('# Acme Cloud')
  })

  it('gives every row its own key, also for one model id of two providers and for a favorite in its provider group', () => {
    const list = rows({ none: true, favorites: [GPT_ACME, GPT_BETA] })
    expect(lines(list).slice(0, 4)).toStrictEqual([
      'none',
      '# Favorites',
      'Acme Cloud › GPT-4o',
      'Beta Hub › GPT-4o (Beta)',
    ])
    const keys = list.map((row) => row.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('lists a model once per group when the favorites or a provider name it twice', () => {
    const list = rows({
      models: [...MODELS, { id: 'llama', name: 'Llama again', provider: BETA.id }],
      favorites: [PAINTER, PAINTER],
    })
    expect(lines(list)).toStrictEqual([
      '# Favorites',
      'Acme Cloud › Painter',
      '# Acme Cloud',
      'Acme Cloud › GPT-4o',
      'Acme Cloud › Painter',
      '# Beta Hub',
      'Beta Hub › Llama',
      'Beta Hub › GPT-4o (Beta)',
    ])
  })

  it('keeps the key of a row when a search moves it', () => {
    const all = rows({ none: true, favorites: [PAINTER] })
    const found = rows({ none: true, favorites: [PAINTER], search: 'beta' })
    expect(lines(found)).toStrictEqual(['none', '# Beta Hub', 'Beta Hub › Llama', 'Beta Hub › GPT-4o (Beta)'])
    // Each found row is, with the same key, a row of the full list.
    expect(all.filter((row) => found.some((other) => other.key === row.key))).toStrictEqual(found)
  })

  it('starts the tooltip of a model with its id, then gives a pretty name in parentheses when the model has one', () => {
    const titles = pickerRows({
      providers: [ACME],
      models: [
        // As Venice lists a model: named by its id, with a readable name.
        { id: 'venice-uncensored', name: 'venice-uncensored', readableName: 'Venice Uncensored', provider: ACME.id },
        // As OpenRouter lists a model: a pretty name and no readable name.
        { id: 'anthropic/claude-sonnet-4.5', name: 'Anthropic: Claude Sonnet 4.5', provider: ACME.id },
        // The row shows the name, so the tooltip adds the readable name.
        { id: 'both', name: 'Both Name', readableName: 'Both Readable', provider: ACME.id },
        { id: 'echo', name: 'Echo', readableName: 'echo', provider: ACME.id },
        { id: 'blank', name: ' ', provider: ACME.id },
        { id: 'plain', name: 'plain', readableName: 'plain', provider: ACME.id },
      ],
      query: { terms: [], outputs: [] },
      favorites: null,
      none: false,
    }).flatMap((row) => row.kind === 'model' ? [row.title] : [])

    expect(titles).toStrictEqual([
      'venice-uncensored (Venice Uncensored)',
      'anthropic/claude-sonnet-4.5 (Anthropic: Claude Sonnet 4.5)',
      'both (Both Readable)',
      'echo (Echo)',
      'blank',
      'plain',
    ])
  })
})
