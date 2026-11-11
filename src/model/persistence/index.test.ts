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
// The `conversations` folder as `dez.native/listAppFiles` and
// `dez.native/loadAppFileBytes` see it: the name and the bytes of each plain
// file, or the error of a folder that cannot be read.
let appFiles: Map<string, Uint8Array> | Error = new Map()
let appFileReads: string[] = []

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
  async 'dez.native/listAppFiles' (path: string): Promise<Array<{ name: string }>> {
    if (path !== 'conversations') throw new Error(`unexpected folder: ${path}`)
    if (appFiles instanceof Error) throw appFiles
    return [...appFiles.keys()].map((name) => ({ name }))
  },
  // As the native read: it follows a link, so it also gives the content of
  // a file that only the conversation listing holds.
  async 'dez.native/loadAppFileBytes' (path: string): Promise<Uint8Array> {
    appFileReads.push(path)
    const name = path.replace(/^conversations\//, '')
    const bytes = appFiles instanceof Error ? undefined : appFiles.get(name)
    if (bytes) return bytes
    const linked = diskFiles.find((file) => `${file.id}.md` === name)
    if (!linked?.content) throw new Error(`Failed to read ${path}`)
    return new TextEncoder().encode(linked.content)
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
  appFiles = new Map()
  appFileReads = []
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

describe('dez.persistence/eachConversationText', () => {
  interface Visit {
    text: string
    index: number
    count: number
  }

  async function visits(): Promise<Visit[]> {
    const seen: Visit[] = []
    await sbp('dez.persistence/eachConversationText', (text: string, index: number, count: number) => {
      seen.push({ text, index, count })
    })
    return seen
  }

  function bytes(text: string): Uint8Array {
    return new TextEncoder().encode(text)
  }

  it('gives the text of each conversation file once, with its place and the count', async () => {
    appFiles = new Map([
      ['a.md', bytes('first ü')],
      // Not a conversation that parses: its text still counts.
      ['b.md', bytes('no front matter')],
      // The temp file of a save that runs.
      ['a.md.4012.7.tmp', bytes('half')],
      ['notes.txt', bytes('other')],
    ])
    diskFiles = [
      { id: 'a', content: 'first ü', updatedAt: 1 },
      { id: 'b', content: 'no front matter', updatedAt: 2 },
    ]

    expect(await visits()).toStrictEqual([
      { text: 'first ü', index: 0, count: 2 },
      { text: 'no front matter', index: 1, count: 2 },
    ])
    expect(appFileReads).toEqual(['conversations/a.md', 'conversations/b.md'])
  })

  it('reads a conversation file that is a link, and no file that Dez cannot open', async () => {
    appFiles = new Map([['a.md', bytes('plain')]])
    diskFiles = [
      { id: 'a', content: 'plain', updatedAt: 1 },
      // A link: only the conversation listing holds it.
      { id: 'linked_1-x', content: 'linked', updatedAt: 2 },
      // No conversation id opens these files, and the app-file path rule
      // refuses the first name.
      { id: 'my notes', content: 'by hand', updatedAt: 3 },
      { id: 'a.b', content: 'by hand', updatedAt: 4 },
    ]

    expect(await visits()).toStrictEqual([
      { text: 'plain', index: 0, count: 2 },
      { text: 'linked', index: 1, count: 2 },
    ])
  })

  it('reads bytes that are not UTF-8 as replacement characters', async () => {
    appFiles = new Map([['a.md', new Uint8Array([0x61, 0xff, 0x62])]])

    expect(await visits()).toStrictEqual([{ text: 'a\uFFFDb', index: 0, count: 1 }])
  })

  it('gives nothing for no conversations', async () => {
    expect(await visits()).toEqual([])
  })

  it('rejects when the folder cannot be read, and does not take it for empty', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      appFiles = new Error('Failed to list conversations: Permission denied')

      await expect(visits()).rejects.toThrow('Permission denied')
      expect(appFileReads).toEqual([])
      expect(errorSpy).toHaveBeenCalled()
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('rejects when one file cannot be read', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      appFiles = new Map([['a.md', bytes('first')]])
      // A link with no file behind it.
      diskFiles = [{ id: 'gone', content: null, updatedAt: 1 }]

      await expect(visits()).rejects.toThrow('Failed to read conversations/gone.md')
      expect(errorSpy).toHaveBeenCalled()
    } finally {
      errorSpy.mockRestore()
    }
  })
})
