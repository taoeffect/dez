import sbp from '@sbp/sbp'
import '@sbp/okturtles.eventqueue'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import type { Tab } from '../model/chat/types'
import { CONVERSATION_ID } from '../model/tools/testing'
import { CONVERSATION_WORK_FOLDER, fakeAppFiles, resetNative } from './testing'
// Side-effect import: registers the selector under test.
import './dataFiles'

interface Toast {
  title?: string
  message: string
  variant?: string
}

let tabs: Map<string, Tab>
let toasts: Toast[]
let consoleError: MockInstance<typeof console.error>

sbp('sbp/selectors/register', {
  'dez.model/tab' (tabId: string): Tab | null {
    return tabs.get(tabId) ?? null
  },
  'dez.ui/toast' (_area: string, toast: Toast): void {
    toasts.push(toast)
  },
})

function tabWith(text: string): Tab {
  return { id: 'tab-1', title: '', conversationId: CONVERSATION_ID, sections: [{ id: 'u1', role: 'user', content: [{ kind: 'text', text }] }] } as unknown as Tab
}

function save(bytes: string, extension: 'csv' | 'tsv'): Promise<string> {
  return sbp('dez.controller/dataFiles/save', 'tab-1', new TextEncoder().encode(bytes), extension) as Promise<string>
}

beforeEach(() => {
  resetNative()
  tabs = new Map([['tab-1', tabWith('Plot /work/data-4.json')]])
  toasts = []
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  consoleError.mockRestore()
})

describe('dez.controller/dataFiles/save', () => {
  it('copies each file of a drop under its own new name, past the names of the folder and of the conversation', async () => {
    const files = fakeAppFiles({ [`${CONVERSATION_WORK_FOLDER}/data-1.csv`]: 'old', [`${CONVERSATION_WORK_FOLDER}/data-2.csv`]: null })

    const texts = await Promise.all([save('a,b\n1,2\n', 'csv'), save('a\tb\n', 'tsv')])

    expect(texts).toStrictEqual(['/work/data-5.csv', '/work/data-6.tsv'])
    expect(new TextDecoder().decode(files.get(`${CONVERSATION_WORK_FOLDER}/data-5.csv`) ?? undefined)).toBe('a,b\n1,2\n')
    expect(new TextDecoder().decode(files.get(`${CONVERSATION_WORK_FOLDER}/data-6.tsv`) ?? undefined)).toBe('a\tb\n')
    expect(new TextDecoder().decode(files.get(`${CONVERSATION_WORK_FOLDER}/data-1.csv`) ?? undefined)).toBe('old')
    expect(toasts).toStrictEqual([])
  })

  it('keeps no file of a tab that was closed, and says so', async () => {
    const files = fakeAppFiles()
    tabs.clear()

    await expect(save('a,b\n', 'csv')).rejects.toThrow('The tab was closed before Dez could copy the file')

    expect([...files.keys()]).toStrictEqual([])
    expect(toasts).toStrictEqual([expect.objectContaining({ title: 'Could not add the data file', variant: 'error' })])
  })
})
