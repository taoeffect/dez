import sbp from '@sbp/sbp'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import type { ActiveModel, Section, SectionThinking, Tab } from '../model/chat/types'
import type { ConversationData } from '../model/persistence/types'
import type { ChatMessage, ProviderStreamChatInput, ProviderStreamChatResult } from '../model/providers'
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
})

function activeTab(): Tab {
  const id = sbp('dez.model/tabs/activeId') as string
  return (sbp('dez.model/tabs/list') as Tab[]).find((tab) => tab.id === id) as Tab
}

function agentSection(): Section {
  return activeTab().sections.find((section) => section.id === 'a1') as Section
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
  sbp('dez.model/tabs/replaceSections', activeTab().id, [
    { id: 'u1', role: 'user', content: [{ kind: 'text', text: 'Hi' }] },
    { id: 'a1', role: 'agent', content: [{ kind: 'text', text: '' }], model },
  ])
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
      await sbp('dez.stream/stop', activeTab().id)
      await input.onThinking(' after')
      return { requestId: input.requestId as string, thinkingReplay: { kind: 'field', field: 'reasoning' } }
    }

    await startStream()

    expect(agentSection().thinking).toStrictEqual({ text: 'Before' })
    expect(savedConversations.at(-1)?.sections[1].thinking).toStrictEqual({ text: 'Before' })
  })
})

describe('dez.controller/submitTab thinking send-back', () => {
  it('sends back only the replayable thinking of agent sections that the request model wrote', async () => {
    const replay = { kind: 'field', field: 'reasoning_content' } as const
    sbp('dez.model/setActiveModel', model.providerId, model.modelId, model.modelName)
    sbp('dez.model/tabs/replaceSections', activeTab().id, [
      { id: 'u1', role: 'user', content: [{ kind: 'text', text: 'Q1' }] },
      { id: 'a1', role: 'agent', content: [{ kind: 'text', text: 'Same model' }], model, thinking: { text: 'Kept', replay } },
      { id: 'a2', role: 'agent', content: [{ kind: 'text', text: 'Other model' }], model: { providerId: 'other', modelId: 'm' }, thinking: { text: 'Other', replay } },
      { id: 'a3', role: 'agent', content: [{ kind: 'text', text: 'No replay' }], model, thinking: { text: 'Pasted' } },
      { id: 'u2', role: 'user', content: [{ kind: 'text', text: 'Was agent' }], model, thinking: { text: 'Toggled', replay } },
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
