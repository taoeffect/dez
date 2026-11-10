import { beforeEach, describe, expect, it, vi } from 'vitest'
import { parseModelRefKey } from '../chat/modelRef'
import { toolBlockText } from '../chat/toolBlocks'
import { serializeConversation } from './conversationFormat'
import { clearConversationSearchCache, conversationPlainText, searchConversationFiles, staleConversationIds } from './search'
import type { ContentNodeData, ConversationData, ConversationFile, SectionData, SnippetSegment } from './types'

function textNode(text: string): ContentNodeData {
  return { kind: 'text', text }
}

function promptNode(name: string, body: string): ContentNodeData {
  return { kind: 'prompt', id: 'p1', promptId: null, name, body, expanded: false }
}

function section(role: SectionData['role'], nodes: ContentNodeData[]): SectionData {
  return { role, nodes }
}

function conversation(id: string, title: string, sections: SectionData[], model: string | null = null): ConversationData {
  const ref = model ? parseModelRefKey(model) : null
  return {
    id,
    title,
    sections,
    activeModel: ref ? { ...ref, modelName: ref.modelId } : null,
    created_at: 1000,
  }
}

// Fixtures go through serializeConversation so tests exercise the real
// on-disk format, proving <dez:…> markers never leak into search text.
function fileFor(data: ConversationData, updatedAt: number): ConversationFile {
  return { id: data.id, content: serializeConversation(data), updatedAt }
}

function joined(snippet: SnippetSegment[] | null): string {
  return (snippet ?? []).map((segment) => segment.text).join('')
}

beforeEach(() => {
  clearConversationSearchCache()
})

describe('conversationPlainText', () => {
  it('flattens text and prompt name/body with normalized whitespace', () => {
    const sections = [
      section('user', [textNode('Hello\n  there')]),
      section('agent', [promptNode('greeting', 'Prompt body\nwith spacing')]),
    ]
    expect(conversationPlainText(sections)).toBe('Hello there greeting Prompt body with spacing')
  })

  it('leaves out the tool blocks of agent text and keeps the same text in user text', () => {
    const block = toolBlockText({ id: 'call_1', name: 'model_list', status: 'success', arguments: { filter: 'gemini' }, result: 'venice/gemini-3-pro' })
    const sections = [
      section('user', [textNode(`Like:\n${block}`)]),
      section('agent', [textNode(`Checking.\n${block}\nFound it.`)]),
    ]

    expect(conversationPlainText(sections))
      .toBe('Like: <dez:tool id="call_1" name="model_list" filter="gemini"> venice/gemini-3-pro </dez:tool> Checking. Found it.')
  })

  it('leaves out the media tags of agent text, with no label, and keeps the same text in user text', () => {
    const tag = '<dez:video id="b" type="video/mp4" src="/home/u/.config/dez/assets/generated/video/v1.mp4"/>'
    const sections = [
      section('user', [textNode(`Like:\n<dez:audio id="c" type="audio/mpeg"/>`)]),
      section('agent', [textNode(`Here it is.\n${tag}\nDone.`)]),
    ]

    expect(conversationPlainText(sections)).toBe('Like: <dez:audio id="c" type="audio/mpeg"/> Here it is. Done.')
  })
})

describe('searchConversationFiles', () => {
  it('returns every conversation sorted by updatedAt desc for an empty query', () => {
    const older = fileFor(conversation('a', 'Old', [section('user', [textNode('first')])]), 2000)
    const newer = fileFor(conversation('b', 'New', [section('user', [textNode('second')])]), 3000)

    const results = searchConversationFiles([older, newer], '   ')
    expect(results.map((result) => result.id)).toEqual(['b', 'a'])
    expect(results.every((result) => result.snippet === null)).toBe(true)
  })

  it('requires every term to match title, model, or content (AND semantics)', () => {
    const file = fileFor(
      conversation('a', 'Trip notes', [section('user', [textNode('remember the itinerary')])], 'openai/gpt-4o'),
      1000,
    )

    expect(searchConversationFiles([file], 'trip itinerary').length).toBe(1)
    expect(searchConversationFiles([file], 'gpt-4o itinerary').length).toBe(1)
    expect(searchConversationFiles([file], 'itinerary missing').length).toBe(0)
  })

  it('matches the raw provider/model key of the header model, and returns the ref', () => {
    const file = fileFor(
      conversation('a', 'Notes', [section('user', [textNode('hello')])], 'openrouter/anthropic/claude-sonnet-4.5'),
      1000,
    )

    const [result] = searchConversationFiles([file], 'openrouter/anthropic/claude')
    expect(result?.model).toStrictEqual({ providerId: 'openrouter', modelId: 'anthropic/claude-sonnet-4.5' })
  })

  it('matches case-insensitively', () => {
    const file = fileFor(conversation('a', 'Notes', [section('user', [textNode('CamelCase Word')])]), 1000)
    expect(searchConversationFiles([file], 'camelcase WORD').length).toBe(1)
  })

  it('returns a null snippet when only the title matched', () => {
    const file = fileFor(conversation('a', 'Rust discussion', [section('user', [textNode('about lifetimes')])]), 1000)
    const results = searchConversationFiles([file], 'rust')
    expect(results.length).toBe(1)
    expect(results[0].snippet).toBeNull()
  })

  it('highlights content matches and keeps short conversations untruncated', () => {
    const file = fileFor(conversation('a', 'Notes', [section('user', [textNode('the needle is here')])]), 1000)
    const [result] = searchConversationFiles([file], 'needle')
    expect(result.snippet).not.toBeNull()
    expect(joined(result.snippet)).toBe('the needle is here')
    expect(result.snippet!.filter((segment) => segment.match).map((segment) => segment.text)).toEqual(['needle'])
  })

  it('windows long content around the match with ellipses and a ~160 char cap', () => {
    const text = 'word '.repeat(50) + 'needle sentence here ' + 'tail '.repeat(50)
    const file = fileFor(conversation('a', 'Notes', [section('user', [textNode(text)])]), 1000)
    const [result] = searchConversationFiles([file], 'needle')

    const snippetText = joined(result.snippet)
    expect(snippetText.startsWith('…')).toBe(true)
    expect(snippetText.endsWith('…')).toBe(true)
    expect(snippetText).toContain('needle')
    expect([...snippetText].length).toBeLessThanOrEqual(162)
    expect(result.snippet!.some((segment) => segment.match && segment.text === 'needle')).toBe(true)
  })

  it('searches prompt names and bodies without leaking dez markers', () => {
    const file = fileFor(
      conversation('a', 'Notes', [
        section('user', [textNode('intro')]),
        section('agent', [promptNode('greeting', 'Hello searchable world')]),
      ]),
      1000,
    )

    const [result] = searchConversationFiles([file], 'searchable')
    expect(result.snippet).not.toBeNull()
    expect(joined(result.snippet)).not.toContain('<dez:')
    expect(joined(result.snippet)).toContain('searchable')

    const [byName] = searchConversationFiles([file], 'greeting')
    expect(joined(byName.snippet)).toContain('greeting')
  })

  it('neither searches nor previews agent thinking', () => {
    const file = fileFor(
      conversation('a', 'Notes', [
        section('user', [textNode('question')]),
        { role: 'agent', nodes: [textNode('answer')], thinking: { text: 'hiddenreasoning', replay: { kind: 'field', field: 'reasoning' } } },
        { role: 'agent', nodes: [], thinking: { text: 'thinkingonly' } },
      ]),
      1000,
    )

    expect(searchConversationFiles([file], 'hiddenreasoning')).toEqual([])
    expect(searchConversationFiles([file], 'thinkingonly')).toEqual([])
    const [result] = searchConversationFiles([file], 'answer')
    expect(result.preview).toBe('question answer')
    expect(result.messageCount).toBe(2)
  })

  it('neither searches image paths nor shows them in snippets and previews', () => {
    const image = (name: string) => `/home/user/.config/dez/assets/images/${name}.png`
    const file = fileFor(
      conversation('a', 'Notes', [
        section('user', [
          textNode(`Look at![${image('3f2a9c1e')}]()this chart`),
          promptNode('compare', `with ![${image('7d4b0e52')}]()`),
        ]),
      ]),
      1000,
    )

    for (const term of ['png', 'images', 'config', '3f2a9c1e', '7d4b0e52', 'image', '![']) {
      expect(searchConversationFiles([file], term), term).toEqual([])
    }
    const [result] = searchConversationFiles([file], 'chart')
    expect(joined(result.snippet)).toBe('Look at this chart compare with')
    expect(result.preview).toBe('Look at[image]this chart with [image]')
  })

  it('merges overlapping term highlights into one segment', () => {
    const file = fileFor(conversation('a', 'Notes', [section('user', [textNode('the foundation stands')])]), 1000)
    const [result] = searchConversationFiles([file], 'foun undation')
    const matches = result.snippet!.filter((segment) => segment.match)
    expect(matches.map((segment) => segment.text)).toEqual(['foundation'])
  })

  it('reuses the cached parse while updatedAt is unchanged', () => {
    const stale = fileFor(conversation('a', 'Notes', [section('user', [textNode('original words')])]), 1000)
    searchConversationFiles([stale], '')

    const changed = { ...fileFor(conversation('a', 'Notes', [section('user', [textNode('replaced words')])]), 1000) }
    expect(searchConversationFiles([changed], 'original').length).toBe(1)
    expect(searchConversationFiles([changed], 'replaced').length).toBe(0)
  })

  it('re-parses when updatedAt changes', () => {
    const stale = fileFor(conversation('a', 'Notes', [section('user', [textNode('original words')])]), 1000)
    searchConversationFiles([stale], '')

    const changed = fileFor(conversation('a', 'Notes', [section('user', [textNode('replaced words')])]), 2000)
    expect(searchConversationFiles([changed], 'replaced').length).toBe(1)
    expect(searchConversationFiles([changed], 'original').length).toBe(0)
  })

  it('prunes ids missing from the listing so re-added files re-parse', () => {
    const original = fileFor(conversation('a', 'Notes', [section('user', [textNode('original words')])]), 1000)
    searchConversationFiles([original], '')
    searchConversationFiles([], '')

    // Same updatedAt as the pruned entry: a surviving cache entry would win.
    const readded = fileFor(conversation('a', 'Notes', [section('user', [textNode('replaced words')])]), 1000)
    expect(searchConversationFiles([readded], 'replaced').length).toBe(1)
  })

  it('serves metadata-only rows from the cache while updatedAt is unchanged', () => {
    const full = fileFor(conversation('a', 'Notes', [section('user', [textNode('needle content')])]), 1000)
    searchConversationFiles([full], '')

    const metaOnly: ConversationFile = { id: 'a', content: null, updatedAt: 1000 }
    const [result] = searchConversationFiles([metaOnly], 'needle')
    expect(joined(result.snippet)).toContain('needle')
  })

  it('skips stale metadata-only rows instead of failing the search', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const full = fileFor(conversation('a', 'Notes', [section('user', [textNode('needle content')])]), 1000)
      searchConversationFiles([full], '')

      const staleMeta: ConversationFile = { id: 'a', content: null, updatedAt: 2000 }
      const fresh = fileFor(conversation('b', 'Other', [section('user', [textNode('needle too')])]), 3000)
      expect(searchConversationFiles([staleMeta, fresh], '').map((result) => result.id)).toEqual(['b'])
      expect(errorSpy).toHaveBeenCalled()
    } finally {
      errorSpy.mockRestore()
    }
  })
})

describe('staleConversationIds', () => {
  it('reports every id when nothing is cached and only changed ids after', () => {
    const a = fileFor(conversation('a', 'A', [section('user', [textNode('one')])]), 1000)
    const b = fileFor(conversation('b', 'B', [section('user', [textNode('two')])]), 2000)
    expect(staleConversationIds([a, b])).toEqual(['a', 'b'])

    searchConversationFiles([a, b], '')
    expect(staleConversationIds([a, b])).toEqual([])

    const bChanged: ConversationFile = { id: 'b', content: null, updatedAt: 3000 }
    const c: ConversationFile = { id: 'c', content: null, updatedAt: 4000 }
    expect(staleConversationIds([a, bChanged, c])).toEqual(['b', 'c'])
  })
})
