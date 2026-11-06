import sbp from '@sbp/sbp'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import type { ActiveModel, Section, SectionThinking, Tab } from '../model/chat/types'
import { sectionVisibleText } from '../model/chat/content'
import type { ConversationData } from '../model/persistence/types'
import type { ChatMessage, ProviderStreamChatInput, ProviderStreamChatResult } from '../model/providers'
import type { ToastData } from '../view/toast/selectors'
// Side-effect imports: register the dez.model/* selectors and the selectors
// under test.
import '../model/state/index'
import './stream'
import './thread'

const model: ActiveModel = { providerId: 'thinker', modelId: 'm', modelName: 'M' }

// What the stub provider does with a request. Set by each test.
let streamChat: (input: ProviderStreamChatInput) => Promise<ProviderStreamChatResult>
// Each thinking that the editor got, as it was at the call.
let editorThinking: (SectionThinking | undefined)[] = []
let editorTokens: string[] = []
let savedConversations: ConversationData[] = []
let toasts: Array<{ area: string, data: ToastData }> = []
// The tab and end status of each reply-end alert.
let alerts: { tabId: string, status: string }[] = []
let consoleError: MockInstance<typeof console.error>

// Stand-ins for the provider, the editor and the disk. The editor stub
// returns false, as for a tab in the background: the store must keep the
// thinking all the same.
sbp('sbp/selectors/register', {
  async 'dez.provider/streamChat' (input: ProviderStreamChatInput): Promise<ProviderStreamChatResult> {
    return await streamChat(input)
  },
  'dez.editor/startStreamingFollowIfVisible' (): boolean {
    return false
  },
  'dez.editor/appendTokenIfVisible' (_tabId: string, _sectionId: string, token: string): boolean {
    editorTokens.push(token)
    return false
  },
  'dez.editor/setSectionThinkingIfVisible' (_tabId: string, _sectionId: string, thinking?: SectionThinking): boolean {
    // The store's thinking is a reactive proxy, which structuredClone refuses.
    editorThinking.push(thinking && JSON.parse(JSON.stringify(thinking)) as SectionThinking)
    return false
  },
  'dez.editor/reconcileAfterStreamFinish' (): void {},
  async 'dez.http/cancelStream' (): Promise<void> {},
  async 'dez.persistence/saveConversation' (data: ConversationData): Promise<void> {
    savedConversations.push(structuredClone(data))
  },
  async 'dez.persistence/saveAppState' (): Promise<void> {},
  async 'dez.persistence/deleteConversation' (): Promise<void> {},
  'dez.ui/toast' (area: string, data: ToastData): void {
    toasts.push({ area, data })
  },
  async 'dez.controller/alertReplyEnded' (tabId: string, status: string): Promise<void> {
    alerts.push({ tabId, status })
  },
})

function activeTab(): Tab {
  const id = sbp('dez.model/tabs/activeId') as string
  return (sbp('dez.model/tabs/list') as Tab[]).find((tab) => tab.id === id) as Tab
}

function agentSection(): Section {
  return activeTab().sections.find((section) => section.id === 'a1') as Section
}

function sectionTexts(): Array<{ role: string, text: string }> {
  return activeTab().sections.map((section) => ({ role: section.role, text: sectionVisibleText(section) }))
}

async function startStream(): Promise<void> {
  await sbp('dez.stream/start', {
    tabId: activeTab().id,
    sectionId: 'a1',
    model,
    messages: [{ role: 'user', content: 'Hi' }],
  })
}

beforeEach(() => {
  setActivePinia(createPinia())
  editorThinking = []
  editorTokens = []
  savedConversations = []
  toasts = []
  alerts = []
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
  sbp('dez.model/tabs/replaceSections', activeTab().id, [
    { id: 'u1', role: 'user', content: [{ kind: 'text', text: 'Hi' }] },
    { id: 'a1', role: 'agent', content: [{ kind: 'text', text: '' }], model },
  ])
})

afterEach(() => {
  consoleError.mockRestore()
})

describe('dez.stream/start thinking', () => {
  it('keeps the thinking in the section, shows it, and saves it with the replay', async () => {
    const replay = { kind: 'field', field: 'reasoning_content' } as const
    streamChat = async (input) => {
      await input.onThinking('Plan')
      await input.onThinking(' it.')
      await input.onToken('Answer')
      return { requestId: input.requestId as string, thinkingReplay: replay }
    }

    await startStream()

    expect(agentSection().thinking).toStrictEqual({ text: 'Plan it.', replay })
    expect(editorThinking).toStrictEqual([
      { text: 'Plan' },
      { text: 'Plan it.' },
      { text: 'Plan it.', replay },
    ])
    expect(editorTokens).toEqual(['Answer'])
    expect(savedConversations.at(-1)?.sections[1].thinking).toStrictEqual({ text: 'Plan it.', replay })
  })

  it('drops thinking and the replay that come after the user stopped the stream', async () => {
    streamChat = async (input) => {
      await input.onThinking('Before')
      await input.onToken('Answer')
      await sbp('dez.stream/stop', activeTab().id)
      await input.onThinking(' after')
      return { requestId: input.requestId as string, thinkingReplay: { kind: 'field', field: 'reasoning' } }
    }

    await startStream()

    expect(agentSection().thinking).toStrictEqual({ text: 'Before' })
    expect(savedConversations.at(-1)?.sections[1].thinking).toStrictEqual({ text: 'Before' })
  })
})

describe('dez.stream/start errors', () => {
  const message = 'Venice returned HTTP 401: {"error":"Authentication failed"}'

  it('removes the agent section of a request that fails before any output, and shows a sticky error toast', async () => {
    streamChat = async () => {
      throw new Error(message)
    }

    await startStream()

    expect(sectionTexts()).toEqual([{ role: 'user', text: 'Hi' }])
    expect(savedConversations.at(-1)?.sections).toHaveLength(1)
    expect(toasts).toStrictEqual([{ area: 'app-global', data: { variant: 'error', title: 'Request failed', message } }])
    expect(consoleError).toHaveBeenCalled()
  })

  it('keeps the answer text that came before the error, with no error text, and adds a user section', async () => {
    streamChat = async (input) => {
      await input.onToken('Partial answer')
      throw new Error('connection reset')
    }

    await startStream()

    expect(sectionTexts()).toEqual([
      { role: 'user', text: 'Hi' },
      { role: 'agent', text: 'Partial answer' },
      { role: 'user', text: '' },
    ])
    expect(toasts.map((toast) => toast.data.message)).toEqual(['connection reset'])
  })

  it('keeps a section that got only thinking before the error', async () => {
    streamChat = async (input) => {
      await input.onThinking('Plan')
      throw new Error('connection reset')
    }

    await startStream()

    expect(sectionTexts()).toEqual([
      { role: 'user', text: 'Hi' },
      { role: 'agent', text: '' },
      { role: 'user', text: '' },
    ])
    expect(agentSection().thinking).toStrictEqual({ text: 'Plan' })
  })

  it('names the tab in the toast title when the tab is in the background', async () => {
    streamChat = async () => {
      sbp('dez.model/tabs/create')
      throw new Error(message)
    }

    await startStream()

    expect(toasts.map((toast) => toast.data.title)).toEqual(['Request failed in "Hi"'])
  })

  it('shows no toast when the user stops the stream, and keeps the answer so far', async () => {
    streamChat = async (input) => {
      await input.onToken('Partial')
      await sbp('dez.stream/stop', activeTab().id)
      throw new Error('cancelled')
    }

    await startStream()

    expect(sectionTexts()).toEqual([
      { role: 'user', text: 'Hi' },
      { role: 'agent', text: 'Partial' },
      { role: 'user', text: '' },
    ])
    expect(toasts).toEqual([])
  })

  it('removes the agent section of a stream stopped before any answer text, also when it had thinking', async () => {
    streamChat = async (input) => {
      await input.onThinking('Plan')
      await input.onToken('\n')
      await sbp('dez.stream/stop', activeTab().id)
      throw new Error('cancelled')
    }

    await startStream()

    expect(sectionTexts()).toEqual([{ role: 'user', text: 'Hi' }])
    expect(savedConversations.at(-1)?.sections).toHaveLength(1)
    expect(toasts).toEqual([])
  })
})

describe('tab activity', () => {
  function activity(): Record<string, string> {
    return sbp('dez.model/tabs/activity') as Record<string, string>
  }

  it('shows busy while the reply streams, in the active tab and in the background', async () => {
    const tabId = activeTab().id
    const seen: Array<Record<string, string>> = []
    streamChat = async (input) => {
      seen.push(activity())
      sbp('dez.model/tabs/create')
      seen.push(activity())
      return { requestId: input.requestId as string }
    }

    await startStream()

    expect(seen).toEqual([{ [tabId]: 'busy' }, { [tabId]: 'busy' }])
  })

  it('marks a tab done when its reply ends in the background, until the tab is active', async () => {
    const tabId = activeTab().id
    streamChat = async (input) => {
      sbp('dez.model/tabs/create')
      return { requestId: input.requestId as string }
    }

    await startStream()
    expect(activity()).toEqual({ [tabId]: 'done' })

    sbp('dez.model/tabs/switch', tabId)
    expect(activity()).toEqual({})
    sbp('dez.model/tabs/cycle', 1)
    expect(activity()).toEqual({})
  })

  it('clears the mark when the tab becomes active because the active tab next to it closed', async () => {
    const tabId = activeTab().id
    streamChat = async (input) => {
      sbp('dez.model/tabs/create')
      return { requestId: input.requestId as string }
    }

    await startStream()
    sbp('dez.model/tabs/close', activeTab().id)

    expect(activeTab().id).toBe(tabId)
    expect(activity()).toEqual({})
  })

  it('marks a tab done when its request fails in the background', async () => {
    const tabId = activeTab().id
    streamChat = async () => {
      sbp('dez.model/tabs/create')
      throw new Error('connection reset')
    }

    await startStream()

    expect(activity()).toEqual({ [tabId]: 'done' })
  })

  it('adds no mark when the reply ends in the active tab', async () => {
    streamChat = async (input) => {
      await input.onToken('Answer')
      return { requestId: input.requestId as string }
    }

    await startStream()

    expect(activity()).toEqual({})
  })

  it('adds no mark when the user stops the reply of a tab in the background', async () => {
    const tabId = activeTab().id
    streamChat = async () => {
      sbp('dez.model/tabs/create')
      await sbp('dez.stream/stop', tabId)
      throw new Error('cancelled')
    }

    await startStream()

    expect(activity()).toEqual({})
  })
})

describe('reply-end alerts', () => {
  it('alerts for a reply that finishes', async () => {
    streamChat = async (input) => {
      await input.onToken('Answer')
      return { requestId: input.requestId as string }
    }

    await startStream()

    expect(alerts).toEqual([{ tabId: activeTab().id, status: 'finished' }])
  })

  it('alerts for a reply that fails', async () => {
    streamChat = async () => {
      throw new Error('connection reset')
    }

    await startStream()

    expect(alerts).toEqual([{ tabId: activeTab().id, status: 'error' }])
  })

  // A stop is the user's own act.
  it('gives no alert when the user stops the reply', async () => {
    streamChat = async (input) => {
      await input.onToken('Partial')
      await sbp('dez.stream/stop', activeTab().id)
      throw new Error('cancelled')
    }

    await startStream()

    expect(alerts).toEqual([])
  })
})

describe('dez.controller/submitTab without a model', () => {
  it('shows an error toast and adds no section', async () => {
    sbp('dez.model/tabs/replaceSections', activeTab().id, [{ id: 'u1', role: 'user', content: [{ kind: 'text', text: 'Hi' }] }])

    await sbp('dez.controller/submitTab', activeTab().id)

    expect(sectionTexts()).toEqual([{ role: 'user', text: 'Hi' }])
    expect(toasts).toStrictEqual([{ area: 'app-global', data: { variant: 'error', title: 'Cannot send', message: 'No model selected' } }])
  })
})

describe('dez.controller/submitTab thinking send-back', () => {
  it('sends back only the replayable thinking of agent sections that the request model wrote, and no durations', async () => {
    const replay = { kind: 'field', field: 'reasoning_content' } as const
    sbp('dez.model/setActiveModel', model.providerId, model.modelId, model.modelName)
    sbp('dez.model/tabs/replaceSections', activeTab().id, [
      { id: 'u1', role: 'user', content: [{ kind: 'text', text: 'Q1' }] },
      { id: 'a1', role: 'agent', content: [{ kind: 'text', text: 'Same model' }], model, thinking: { text: 'Kept', replay }, durationMs: 4213 },
      { id: 'a2', role: 'agent', content: [{ kind: 'text', text: 'Other model' }], model: { providerId: 'other', modelId: 'm' }, thinking: { text: 'Other', replay } },
      { id: 'a3', role: 'agent', content: [{ kind: 'text', text: 'No replay' }], model, thinking: { text: 'Pasted' } },
      { id: 'u2', role: 'user', content: [{ kind: 'text', text: 'Was agent' }], model, thinking: { text: 'Toggled', replay }, durationMs: 900 },
    ])
    let sent: ChatMessage[] = []
    streamChat = async (input) => {
      sent = input.messages
      return { requestId: input.requestId as string }
    }

    await sbp('dez.controller/submitTab', activeTab().id)

    expect(sent).toStrictEqual([
      { role: 'user', content: 'Q1' },
      { role: 'agent', content: 'Same model', thinking: { text: 'Kept', replay } },
      { role: 'agent', content: 'Other model' },
      { role: 'agent', content: 'No replay' },
      { role: 'user', content: 'Was agent' },
    ])
  })
})
