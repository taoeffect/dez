import sbp from '@sbp/sbp'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { serializeConversation } from './conversationFormat'
import { clearConversationSearchCache } from './search'
import type { ContentNodeData, ConversationData, ConversationFile, ConversationSearchOutcome, SectionData } from './types'
// Side-effect import: registers the dez.persistence/* selectors under test.
import './index'

function textNode(text: string): ContentNodeData {
  return { kind: 'text', text }
}

function section(role: SectionData['role'], nodes: ContentNodeData[]): SectionData {
  return { role, nodes }
}

function conversation(id: string, title: string, text: string): ConversationData {
  return { id, title, sections: [section('user', [textNode(text)])], activeModel: null, created_at: 1000 }
}

function fileFor(data: ConversationData, updatedAt: number): ConversationFile {
  return { id: data.id, content: serializeConversation(data), updatedAt }
}

// Fixture state read by the stub native selectors below, plus call logs the
// tests assert I/O behavior against. Reset in beforeEach.
let diskFiles: ConversationFile[] = []
let failingLoadIds = new Set<string>()
let listCalls: boolean[] = []
let loadCalls: string[] = []

// Stub the native selectors dez.persistence/searchConversations orchestrates.
// src/controller/native.ts is never imported by this test, so these are the
// only dez.native/* registrations in the test process (vitest isolates module
// registries per test file). Registered once: sbp selectors are global module
// state, and the stubs read the mutable fixture state above.
sbp('sbp/selectors/register', {
  async 'dez.native/listConversationFiles' (includeContent: boolean): Promise<ConversationFile[]> {
    listCalls.push(includeContent)
    return diskFiles.map((file) => (includeContent ? { ...file } : { ...file, content: null }))
  },
  async 'dez.native/loadConversationFile' (id: string): Promise<string> {
    loadCalls.push(id)
    if (failingLoadIds.has(id)) throw new Error(`load failed: ${id}`)
    const file = diskFiles.find((entry) => entry.id === id)
    if (!file || file.content === null) throw new Error(`missing file: ${id}`)
    return file.content
  },
})

async function search(query: string): Promise<ConversationSearchOutcome> {
  return await sbp('dez.persistence/searchConversations', query) as ConversationSearchOutcome
}

beforeEach(() => {
  clearConversationSearchCache()
  diskFiles = []
  failingLoadIds = new Set()
  listCalls = []
  loadCalls = []
})

describe('dez.persistence/searchConversations orchestration', () => {
  it('cold start: one metadata listing then one full-content listing, no per-file loads', async () => {
    diskFiles = [
      fileFor(conversation('a', 'First', 'alpha words'), 1000),
      fileFor(conversation('b', 'Second', 'beta words'), 2000),
    ]

    const outcome = await search('')
    expect(listCalls).toEqual([false, true])
    expect(loadCalls).toEqual([])
    expect(outcome.total).toBe(2)
    expect(outcome.results.map((result) => result.id)).toEqual(['b', 'a'])
  })

  it('warm cache: metadata-only listing, no content fetched at all', async () => {
    diskFiles = [
      fileFor(conversation('a', 'First', 'alpha words'), 1000),
      fileFor(conversation('b', 'Second', 'beta words'), 2000),
    ]
    await search('')
    listCalls = []
    loadCalls = []

    const outcome = await search('beta')
    expect(listCalls).toEqual([false])
    expect(loadCalls).toEqual([])
    expect(outcome.total).toBe(2)
    expect(outcome.results.map((result) => result.id)).toEqual(['b'])
  })

  it('one stale file: exactly one per-file load, no full-content listing', async () => {
    diskFiles = [
      fileFor(conversation('a', 'First', 'alpha words'), 1000),
      fileFor(conversation('b', 'Second', 'beta words'), 2000),
    ]
    await search('')
    // Simulate a save to b: new content and a bumped mtime.
    diskFiles = [diskFiles[0], fileFor(conversation('b', 'Second', 'gamma replaced'), 3000)]
    listCalls = []
    loadCalls = []

    const outcome = await search('gamma')
    expect(listCalls).toEqual([false])
    expect(loadCalls).toEqual(['b'])
    expect(outcome.total).toBe(2)
    // The loaded content was merged into the metadata row and re-parsed.
    expect(outcome.results.map((result) => result.id)).toEqual(['b'])
  })

  it('failed per-file load: that row is dropped, the rest are returned', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      diskFiles = [
        fileFor(conversation('a', 'First', 'alpha words'), 1000),
        fileFor(conversation('b', 'Second', 'beta words'), 2000),
      ]
      await search('')
      // b changes on disk but vanishes before it can be loaded (e.g. deleted
      // between the metadata listing and the per-file load).
      diskFiles = [diskFiles[0], fileFor(conversation('b', 'Second', 'gamma replaced'), 3000)]
      failingLoadIds = new Set(['b'])
      listCalls = []
      loadCalls = []

      const outcome = await search('')
      expect(loadCalls).toEqual(['b'])
      expect(outcome.total).toBe(1)
      expect(outcome.results.map((result) => result.id)).toEqual(['a'])
      expect(errorSpy).toHaveBeenCalled()
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('empty listing: returns { total: 0, results: [] } without a full-content listing', async () => {
    const outcome = await search('')
    expect(listCalls).toEqual([false])
    expect(loadCalls).toEqual([])
    expect(outcome).toEqual({ total: 0, results: [] })
  })
})
