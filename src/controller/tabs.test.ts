import sbp from '@sbp/sbp'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import type { Tab } from '../model/chat/types'
// Side-effect imports: register the dez.model/* selectors and the selectors
// under test.
import '../model/state/index'
import './tabs'

// The work folder of a conversation goes with the conversation, in both
// delete paths of a conversation. The rules of the tabs themselves have
// their own tests (model/state/index.test.ts).

// What the stubs saw, in order: the stop of the reply of a tab, the delete
// of a conversation file, and the delete of a folder.
let events: string[] = []
let deleteConversation: (id: string) => Promise<void>
let consoleError: MockInstance<typeof console.error>

sbp('sbp/selectors/register', {
  async 'dez.persistence/saveAppState' (): Promise<void> {},
  async 'dez.persistence/deleteConversation' (id: string): Promise<void> {
    await deleteConversation(id)
    events.push(`file ${id}`)
  },
  async 'dez.stream/stop' (tabId: string): Promise<void> {
    events.push(`stop ${tabId}`)
  },
  async 'dez.native/deleteAppFile' (path: string, root: string, { folder }: { folder: boolean }): Promise<void> {
    events.push(`${folder ? 'folder' : 'file'} ${root}:${path}`)
  },
})

function activeTab(): Tab {
  return sbp('dez.model/tab', sbp('dez.model/tabs/activeId')) as Tab
}

// A new tab, with `text` as its conversation when it is given.
function newTab(text = ''): Tab {
  const tab = sbp('dez.model/tabs/create') as Tab
  if (text) sbp('dez.model/tabs/replaceSections', tab.id, [{ id: 'u1', role: 'user', content: [{ kind: 'text', text }] }])
  return tab
}

beforeEach(() => {
  setActivePinia(createPinia())
  events = []
  deleteConversation = async () => {}
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  consoleError.mockRestore()
})

describe('dez.controller/deleteConversation', () => {
  it('deletes the file, stops the replies of its tabs, then deletes the work folder of the conversation', async () => {
    const first = activeTab()
    const tab = newTab('Some notes.')

    await sbp('dez.controller/deleteConversation', tab.conversationId)

    expect(events).toStrictEqual([`file ${tab.conversationId}`, `stop ${tab.id}`, `folder app:work/${tab.conversationId}`])
    expect(activeTab().id).toBe(first.id)
  })

  it('keeps the tabs and the work folder when the file could not go', async () => {
    const tab = newTab('Some notes.')
    deleteConversation = async () => {
      throw new Error('Permission denied')
    }

    await sbp('dez.controller/deleteConversation', tab.conversationId)

    expect(events).toStrictEqual([])
    expect(activeTab().id).toBe(tab.id)
  })

  it('deletes no folder for an id that can name none', async () => {
    await sbp('dez.controller/deleteConversation', '../apps')

    expect(events).toStrictEqual(['file ../apps'])
  })
})

describe('dez.controller/closeTab', () => {
  it('deletes the work folder with the file of an empty tab', async () => {
    const tab = newTab()

    await sbp('dez.controller/closeTab', tab.id)
    await vi.waitFor(() => expect(events).toContain(`file ${tab.conversationId}`))

    expect(events).toContain(`folder app:work/${tab.conversationId}`)
  })

  it('keeps the work folder of a tab with text, which the user can open again', async () => {
    const tab = newTab('Some notes.')

    await sbp('dez.controller/closeTab', tab.id)

    expect(events).toStrictEqual([`stop ${tab.id}`])
  })

  it('keeps the work folder of the last tab, which does not close', async () => {
    const tab = activeTab()

    await sbp('dez.controller/closeTab', tab.id)

    expect(events).toStrictEqual([`stop ${tab.id}`])
  })
})
