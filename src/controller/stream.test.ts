import sbp from '@sbp/sbp'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import type { ActiveModel, Section, SectionThinking, Tab, ThinkingReplay } from '../model/chat/types'
import { sectionVisibleText } from '../model/chat/content'
import { findToolBlocks } from '../model/chat/toolBlocks'
import type { ConversationData } from '../model/persistence/types'
import { customProviderConfigSchema } from '../model/providers/config'
import type { GeneratedClip, ModelRequest, ProviderChatInputMessage, ProviderGenerateMediaInput, ProviderGenerateMediaResult, ProviderInfo, ProviderStreamChatInput, ProviderStreamChatResult } from '../model/providers'
import type { RequestMessages } from '../model/streams/types'
import { TOOL_DEFINITIONS } from '../model/tools/registry'
import type { ToastData } from '../view/toast/selectors'
// Side-effect imports: register the dez.model/* selectors and the selectors
// under test.
import '../model/state/index'
import './stream'
import './thread'
import './tools'

const model: ActiveModel = { providerId: 'thinker', modelId: 'm', modelName: 'M' }

// What the stub provider does with a request. Set by each test.
let streamChat: (input: ProviderStreamChatInput) => Promise<ProviderStreamChatResult>
// Each thinking that the editor got, as it was at the call.
let editorThinking: (SectionThinking | undefined)[] = []
let editorTokens: string[] = []
// Each tail replace that the editor got.
let editorReplaces: { tail: string, text: string }[] = []
let savedConversations: ConversationData[] = []
let toasts: Array<{ area: string, data: ToastData }> = []
// The tab and end status of each reply-end alert.
let alerts: { tabId: string, status: string }[] = []
// What the `model_list` tool reads as the provider list. Set by each test.
let providerInfos: () => Promise<ProviderInfo[]>
// Runs while `dez.http/cancelStream` cancels a request, as the late output
// of that request does. Set by a test.
let cancelStream: () => Promise<void>
// What the stub media API and image store do. Set by the media tests.
let generateMedia: (input: ProviderGenerateMediaInput) => Promise<ProviderGenerateMediaResult>
let saveImage: (mediaType: string, options: unknown) => Promise<string>
let deletedImages: string[] = []
// Each file that was deleted from an app folder (the temp copies of clips).
let deletedFiles: { path: string, root: string }[] = []
let consoleError: MockInstance<typeof console.error>

// Stand-ins for the provider, the editor and the disk. The editor stub
// returns false, as for a tab in the background: the store must keep the
// thinking all the same.
sbp('sbp/selectors/register', {
  async 'dez.provider/streamChat' (input: ProviderStreamChatInput): Promise<ProviderStreamChatResult> {
    return await streamChat(input)
  },
  async 'dez.provider/generateMedia' (input: ProviderGenerateMediaInput): Promise<ProviderGenerateMediaResult> {
    return await generateMedia(input)
  },
  async 'dez.controller/images/save' (_bytes: Uint8Array, mediaType: string, options: unknown): Promise<string> {
    return await saveImage(mediaType, options)
  },
  async 'dez.controller/images/delete' (path: string): Promise<void> {
    deletedImages.push(path)
  },
  async 'dez.native/getAppDir' (root = 'app'): Promise<string> {
    return root === 'cache' ? '/home/u/.cache/dez' : '/home/u/.config/dez'
  },
  async 'dez.native/deleteAppFile' (path: string, root = 'app'): Promise<void> {
    deletedFiles.push({ path, root })
  },
  'dez.editor/startStreamingFollowIfVisible' (): boolean {
    return false
  },
  'dez.editor/appendTokenIfVisible' (_tabId: string, _sectionId: string, token: string): boolean {
    editorTokens.push(token)
    return false
  },
  'dez.editor/replaceStreamTailIfVisible' (_tabId: string, _sectionId: string, tail: string, text: string): boolean {
    editorReplaces.push({ tail, text })
    return false
  },
  async 'dez.provider/infos' (): Promise<ProviderInfo[]> {
    return await providerInfos()
  },
  'dez.editor/setSectionThinkingIfVisible' (_tabId: string, _sectionId: string, thinking?: SectionThinking): boolean {
    // The store's thinking is a reactive proxy, which structuredClone refuses.
    editorThinking.push(thinking && JSON.parse(JSON.stringify(thinking)) as SectionThinking)
    return false
  },
  'dez.editor/reconcileAfterStreamFinish' (): void {},
  async 'dez.http/cancelStream' (): Promise<void> {
    await cancelStream()
  },
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

async function startStream({ sendTools = false } = {}): Promise<void> {
  await sbp('dez.stream/start', {
    tabId: activeTab().id,
    sectionId: 'a1',
    model,
    request: 'chat',
    messages: [{ role: 'user', content: 'Hi' }],
    sendTools,
    imageOutput: false,
  })
}

beforeEach(() => {
  setActivePinia(createPinia())
  editorThinking = []
  editorTokens = []
  editorReplaces = []
  savedConversations = []
  toasts = []
  alerts = []
  providerInfos = async () => []
  cancelStream = async () => {}
  deletedImages = []
  deletedFiles = []
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
  // `dez.stream/start` names the provider in the system prompt, so the stub
  // model's provider must exist.
  sbp('dez.model/customProviders/save', customProviderConfigSchema.parse({ id: model.providerId, name: 'Thinker', baseUrl: 'http://localhost:8080/v1' }))
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

describe('reply duration', () => {
  const start = Date.UTC(2026, 10, 6, 12)

  // 'none' marks a section without a `durationMs` key.
  function durations(sections: { durationMs?: number }[] = []): (number | 'none' | undefined)[] {
    return sections.map((section) => ('durationMs' in section ? section.durationMs : 'none'))
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(start)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // Each reply takes 4213 ms, and its end keeps the agent section.
  const keptReplies: Record<string, typeof streamChat> = {
    'finishes': async (input) => {
      await input.onToken('Answer')
      vi.setSystemTime(start + 4213)
      return { requestId: input.requestId as string }
    },
    'fails after answer text': async (input) => {
      await input.onToken('Partial')
      vi.setSystemTime(start + 4213)
      throw new Error('connection reset')
    },
    'fails after only thinking': async (input) => {
      await input.onThinking('Plan')
      vi.setSystemTime(start + 4213)
      throw new Error('connection reset')
    },
    'the user stops after answer text': async (input) => {
      await input.onToken('Partial')
      vi.setSystemTime(start + 4213)
      await sbp('dez.stream/stop', activeTab().id)
      throw new Error('cancelled')
    },
  }

  it.each(Object.entries(keptReplies))('stamps the agent section of a reply that %s, and saves it', async (_name, reply) => {
    streamChat = reply

    await startStream()

    expect(durations(activeTab().sections)).toStrictEqual(['none', 4213, 'none'])
    expect(durations(savedConversations.at(-1)?.sections)).toStrictEqual(['none', 4213, 'none'])
  })

  it('stamps 0 when the system clock was set back during the reply', async () => {
    streamChat = async (input) => {
      await input.onToken('Answer')
      vi.setSystemTime(start - 60_000)
      return { requestId: input.requestId as string }
    }

    await startStream()

    expect(agentSection().durationMs).toBe(0)
  })

  // A new start in the tab cancels the earlier request with no stream end,
  // so only the new stream's start and end count.
  it('stamps the time of the stream that replaced an earlier one in the tab', async () => {
    streamChat = async (first) => {
      streamChat = async (second) => {
        await second.onToken('Answer')
        vi.setSystemTime(start + 3500)
        return { requestId: second.requestId as string }
      }
      vi.setSystemTime(start + 1000)
      await startStream()
      // The earlier request returns last.
      vi.setSystemTime(start + 9000)
      return { requestId: first.requestId as string }
    }

    await startStream()

    expect(agentSection().durationMs).toBe(2500)
    expect(durations(savedConversations.at(-1)?.sections)).toStrictEqual(['none', 2500, 'none'])
  })
})

describe('dez.stream/start tool loop', () => {
  const running = '<dez:tool id="c1" name="model_list" status="running" filter="gemini">\n</dez:tool>\n'
  const done = '<dez:tool id="c1" name="model_list" filter="gemini">\nNo models are available.\n</dez:tool>\n'
  const geminiCall = { id: 'c1', name: 'model_list', argumentsText: '{"filter":"gemini"}' }
  // The request messages of each round, as plain data at the call.
  let sent: ProviderChatInputMessage[][] = []
  let requests: ProviderStreamChatInput[] = []
  // How many times a `model_list` call ran.
  let runs = 0

  // `rounds[n]` answers the request of round n.
  function replyRounds(rounds: Array<(input: ProviderStreamChatInput) => Promise<ProviderStreamChatResult>>): void {
    streamChat = async (input) => {
      requests.push(input)
      sent.push(JSON.parse(JSON.stringify(input.messages)) as ProviderChatInputMessage[])
      return await rounds[requests.length - 1](input)
    }
  }

  function blocks(): Array<{ id: string, status: string, result: string }> {
    return findToolBlocks(sectionVisibleText(agentSection())).map(({ id, status, result }) => ({ id, status, result }))
  }

  beforeEach(() => {
    sent = []
    requests = []
    runs = 0
    providerInfos = async () => {
      runs++
      return []
    }
  })

  it('runs the calls of a round, sends the reply so far in the next round, and finalizes once', async () => {
    const replay = { kind: 'field', field: 'reasoning_content' } as const
    const roundReplay = { kind: 'field', field: 'reasoning' } as const
    let savesBeforeLastRound = -1
    replyRounds([
      async (input) => {
        await input.onThinking('Look.')
        await input.onToken('Checking.')
        return { requestId: input.requestId as string, thinkingReplay: replay, toolCalls: [geminiCall] }
      },
      async (input) => {
        savesBeforeLastRound = savedConversations.length
        await input.onThinking('Found.')
        await input.onToken('None.')
        return { requestId: input.requestId as string, thinkingReplay: roundReplay }
      },
    ])

    await startStream({ sendTools: true })

    const toolNames = TOOL_DEFINITIONS.map((tool) => tool.name)
    expect(requests.map((input) => input.tools?.map((tool) => tool.name))).toStrictEqual([toolNames, toolNames])
    expect(requests[0].requestId).not.toBe(requests[1].requestId)
    // The prompt cache needs the same system prompt and tools in each round.
    expect(requests[0].system).toEqual(expect.any(String))
    expect(requests[1].system).toBe(requests[0].system)
    expect(requests[1].tools).toStrictEqual(requests[0].tools)
    expect(sent[1]).toStrictEqual([
      { role: 'user', content: 'Hi' },
      {
        role: 'agent',
        content: 'Checking.',
        thinking: { text: 'Look.', replay },
        toolCalls: [{ id: 'c1', name: 'model_list', arguments: { filter: 'gemini' } }],
      },
      { role: 'tool', results: [{ callId: 'c1', content: 'No models are available.', isError: false }] },
    ])
    expect(sectionTexts()).toStrictEqual([
      { role: 'user', text: 'Hi' },
      { role: 'agent', text: `Checking.\n${done}None.` },
      { role: 'user', text: '' },
    ])
    expect(editorReplaces).toStrictEqual([{ tail: running, text: done }])
    const thinking = { text: 'Look.Found.', replay, rounds: [{ afterToolCall: 'c1', from: 5, replay: roundReplay }] }
    expect(agentSection().thinking).toStrictEqual(thinking)
    expect(editorThinking.at(-1)).toStrictEqual(thinking)
    expect(savesBeforeLastRound).toBe(0)
    expect(savedConversations).toHaveLength(1)
    expect(alerts).toStrictEqual([{ tabId: activeTab().id, status: 'finished' }])
  })

  it('escapes a tag that the model splits across tokens', async () => {
    replyRounds([
      async (input) => {
        await input.onToken('See <dez')
        await input.onToken(':tool id="x" name="y">')
        await input.onToken(' and <')
        return { requestId: input.requestId as string }
      },
    ])

    await startStream()

    expect(sectionVisibleText(agentSection())).toBe('See <\\dez:tool id="x" name="y"> and <')
    expect(editorTokens.join('')).toBe('See <\\dez:tool id="x" name="y"> and <')
  })

  // The escaper holds back a text end that can still grow into a tag, such
  // as a final `<`; a reply that ends with no round end must write it.
  it.each([
    ['a stop', async (tabId: string) => {
      await sbp('dez.stream/stop', tabId)
      throw new Error('cancelled')
    }],
    ['an error', async () => {
      throw new Error('connection reset')
    }],
  ])('keeps the text that the escaper holds at %s', async (_end, endReply) => {
    replyRounds([
      async (input) => {
        await input.onToken('Is a <')
        return await endReply(activeTab().id)
      },
    ])

    await startStream()

    expect(sectionVisibleText(agentSection())).toBe('Is a <')
    expect(editorTokens.join('')).toBe('Is a <')
    expect(savedConversations.at(-1)?.sections[1].nodes).toStrictEqual(agentSection().content)
  })

  it('sends and keeps the text that the escaper holds when a new submit in the tab ends the reply', async () => {
    const tabId = activeTab().id
    sbp('dez.model/setActiveModel', model.providerId, model.modelId, model.modelName)
    replyRounds([
      async (input) => {
        await input.onToken('Is a <')
        await sbp('dez.controller/submitTab', tabId)
        throw new Error('cancelled')
      },
      async (input) => {
        await input.onToken('Answer.')
        return { requestId: input.requestId as string }
      },
    ])

    await startStream()

    expect(requests).toHaveLength(2)
    expect(sent[1].at(-1)).toStrictEqual({ role: 'agent', content: 'Is a <' })
    expect(sectionVisibleText(agentSection())).toBe('Is a <')
    const stored = (sbp('dez.model/streamMessagesForTab', tabId, model) as RequestMessages).messages
    expect(stored.slice(0, sent[1].length)).toStrictEqual(sent[1])
  })

  // `dez.http/cancelStream` closes the byte stream at once, and the parser
  // then gives the text that it still held while the new start waits for
  // the cancel. The new request already holds the old section, so that
  // output must not reach it, and the flushed escaper must not let a split
  // tag through.
  it('drops the output of the old request that comes after a new submit in the tab ended the reply', async () => {
    const tabId = activeTab().id
    sbp('dez.model/setActiveModel', model.providerId, model.modelId, model.modelName)
    replyRounds([
      async (input) => {
        await input.onThinking('Plan.')
        await input.onToken('See <dez')
        cancelStream = async () => {
          await input.onToken(':tool id="x" name="y">')
          await input.onThinking(' Late.')
        }
        await sbp('dez.controller/submitTab', tabId)
        throw new Error('cancelled')
      },
      async (input) => {
        await input.onToken('Answer.')
        return { requestId: input.requestId as string }
      },
    ])

    await startStream()

    expect(requests).toHaveLength(2)
    expect(sectionTexts()).toStrictEqual([
      { role: 'user', text: 'Hi' },
      { role: 'agent', text: 'See <dez' },
      { role: 'agent', text: 'Answer.' },
      { role: 'user', text: '' },
    ])
    expect(agentSection().thinking).toStrictEqual({ text: 'Plan.' })
    expect(editorTokens.join('')).toBe('See <dezAnswer.')
    const stored = (sbp('dez.model/streamMessagesForTab', tabId, model) as RequestMessages).messages
    expect(stored.slice(0, sent[1].length)).toStrictEqual(sent[1])
  })

  it('ignores tool calls when the request offered no tools', async () => {
    replyRounds([
      async (input) => {
        await input.onToken('Answer')
        return { requestId: input.requestId as string, toolCalls: [geminiCall] }
      },
    ])

    await startStream()

    expect(requests[0].tools).toStrictEqual([])
    expect(runs).toBe(0)
    expect(sectionVisibleText(agentSection())).toBe('Answer')
    expect(alerts).toStrictEqual([{ tabId: activeTab().id, status: 'finished' }])
  })

  it('runs no unknown tool or call with invalid arguments, and gives a taken call id a new one', async () => {
    replyRounds([
      async (input) => ({
        requestId: input.requestId as string,
        toolCalls: [
          { id: 'c1', name: 'web_search', argumentsText: '{}' },
          { id: 'c2', name: 'model_list', argumentsText: '{"filter":1}' },
          { id: 'c1', name: 'model_list', argumentsText: '' },
        ],
      }),
      async (input) => {
        await input.onToken('Sorry.')
        return { requestId: input.requestId as string }
      },
    ])

    await startStream({ sendTools: true })

    expect(runs).toBe(1)
    const [unknown, invalid, renamed] = blocks()
    expect(unknown).toStrictEqual({ id: 'c1', status: 'error', result: 'Unknown tool: "web_search".' })
    expect(invalid.status).toBe('error')
    expect(invalid.result).toMatch(/^Invalid arguments: .+\. Received: \{"filter":1\}$/)
    expect(renamed.id).toMatch(/^call_[0-9a-f]{12}$/)
    expect(renamed.status).toBe('success')
    expect(sent[1].at(-1)).toStrictEqual({
      role: 'tool',
      results: [
        { callId: 'c1', content: unknown.result, isError: true },
        { callId: 'c2', content: invalid.result, isError: true },
        { callId: renamed.id, content: 'No models are available.', isError: false },
      ],
    })
  })

  it('ends a stop during a tool as a stop: ended calls keep their results, the others get "Stopped."', async () => {
    providerInfos = async () => {
      runs++
      if (runs === 2) await sbp('dez.stream/stop', activeTab().id)
      return []
    }
    replyRounds([
      async (input) => {
        await input.onToken('Checking.')
        return { requestId: input.requestId as string, toolCalls: [geminiCall, { ...geminiCall, id: 'c2' }] }
      },
    ])

    await startStream({ sendTools: true })

    expect(requests).toHaveLength(1)
    expect(blocks()).toStrictEqual([
      { id: 'c1', status: 'success', result: 'No models are available.' },
      { id: 'c2', status: 'error', result: 'Stopped.' },
    ])
    expect(savedConversations).toHaveLength(1)
    expect(savedConversations[0].sections[1].nodes).toStrictEqual(agentSection().content)
    expect(toasts).toStrictEqual([])
    expect(alerts).toStrictEqual([])
  })

  // The submit builds its messages while the running blocks are still in the
  // section; `dez.stream/endOutput` then writes the final blocks. The request
  // must send what the tab stores, or the next request changes earlier bytes.
  it('sends the final blocks of a tool run that a new submit in the tab stopped', async () => {
    const tabId = activeTab().id
    sbp('dez.model/setActiveModel', model.providerId, model.modelId, model.modelName)
    providerInfos = async () => {
      runs++
      if (runs === 2) await sbp('dez.controller/submitTab', tabId)
      return []
    }
    replyRounds([
      async (input) => {
        await input.onToken('Checking.')
        return { requestId: input.requestId as string, toolCalls: [geminiCall, { ...geminiCall, id: 'c2' }] }
      },
      async (input) => {
        await input.onToken('Answer.')
        return { requestId: input.requestId as string }
      },
    ])

    await startStream({ sendTools: true })

    expect(requests).toHaveLength(2)
    expect(sent[1].at(-1)).toStrictEqual({
      role: 'tool',
      results: [
        { callId: 'c1', content: 'No models are available.', isError: false },
        { callId: 'c2', content: 'Stopped.', isError: true },
      ],
    })
    const stored = (sbp('dez.model/streamMessagesForTab', tabId, model) as RequestMessages).messages
    expect(stored.slice(0, sent[1].length)).toStrictEqual(sent[1])
  })

  it('ends the reply as a stop when the user deletes the running blocks', async () => {
    providerInfos = async () => {
      runs++
      sbp('dez.model/tabs/replaceSections', activeTab().id, [
        { id: 'u1', role: 'user', content: [{ kind: 'text', text: 'Hi' }] },
        { id: 'a1', role: 'agent', content: [{ kind: 'text', text: 'Checking.\n' }], model },
      ])
      return []
    }
    replyRounds([
      async (input) => {
        await input.onToken('Checking.')
        return { requestId: input.requestId as string, toolCalls: [geminiCall] }
      },
    ])

    await startStream({ sendTools: true })

    expect(requests).toHaveLength(1)
    expect(sectionVisibleText(agentSection())).toBe('Checking.\n')
    expect(sbp('dez.model/streams/isStreaming', activeTab().id)).toBe(false)
    expect(savedConversations).toHaveLength(1)
    expect(toasts).toStrictEqual([])
    expect(alerts).toStrictEqual([])
  })

  it('runs 20 tool rounds, then ends with an error and runs no call of the next request', async () => {
    streamChat = async (input) => {
      requests.push(input)
      return { requestId: input.requestId as string, toolCalls: [{ ...geminiCall, id: `c${requests.length}` }] }
    }

    await startStream({ sendTools: true })

    expect(requests).toHaveLength(21)
    expect(runs).toBe(20)
    expect(blocks().map((block) => block.result)).toStrictEqual([
      ...Array<string>(20).fill('No models are available.'),
      'Not run: the reply reached the limit of 20 tool rounds.',
    ])
    expect(blocks().at(-1)?.status).toBe('error')
    expect(toasts).toStrictEqual([{
      area: 'app-global',
      data: {
        variant: 'error',
        title: 'Tool limit reached',
        message: 'The reply reached the limit of 20 tool rounds, so Dez did not run its last tool calls.',
      },
    }])
    expect(alerts).toStrictEqual([{ tabId: activeTab().id, status: 'error' }])
  })

  it('keeps the blocks of earlier rounds when a later round fails, and shows an error toast', async () => {
    replyRounds([
      async (input) => {
        await input.onToken('Checking.')
        return { requestId: input.requestId as string, toolCalls: [geminiCall] }
      },
      async () => {
        throw new Error('connection reset')
      },
    ])

    await startStream({ sendTools: true })

    expect(sectionTexts()).toStrictEqual([
      { role: 'user', text: 'Hi' },
      { role: 'agent', text: `Checking.\n${done}` },
      { role: 'user', text: '' },
    ])
    expect(toasts).toStrictEqual([{
      area: 'app-global',
      data: { variant: 'error', title: 'Request failed', message: 'connection reset' },
    }])
    expect(alerts).toStrictEqual([{ tabId: activeTab().id, status: 'error' }])
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
      { id: 'u2', role: 'user', content: [{ kind: 'text', text: 'Q2' }], model, thinking: { text: 'Not sent', replay }, durationMs: 900 },
    ])
    let sent: ProviderChatInputMessage[] = []
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
      { role: 'user', content: 'Q2' },
    ])
  })
})

describe('dez.controller/submitTab images', () => {
  const image = (name: string) => `/home/u/.config/dez/assets/images/${name}`
  let sent: ProviderChatInputMessage[] = []

  beforeEach(() => {
    sent = []
    streamChat = async (input) => {
      sent = input.messages
      return { requestId: input.requestId as string }
    }
    sbp('dez.model/setActiveModel', model.providerId, model.modelId, model.modelName)
    sbp('dez.model/tabs/replaceSections', activeTab().id, [
      { id: 'u1', role: 'user', content: [{ kind: 'text', text: `Look:\n![${image('one.png')}](id=a)\n![${image('two.jpg')}](id=b)\nWhich is brighter?` }] },
      { id: 'a1', role: 'agent', content: [{ kind: 'text', text: `This one: ![${image('one.png')}](id=a)` }], model },
      {
        id: 'u2',
        role: 'user',
        content: [
          // The second reference lost its `)` to the Backspace rule.
          { kind: 'text', text: `![${image('three.webp')}](id=c) and ![${image('two.jpg')}](id=b\n` },
          { kind: 'prompt', id: 'p1', promptId: null, name: 'Compare', body: `Compare with ![${image('one.png')}](id=a)`, expanded: false },
          { kind: 'text', text: '' },
        ],
      },
    ])
  })

  it('sends each user image as a part after its reference text with no path, and agent images as that text only', async () => {
    await sbp('dez.controller/submitTab', activeTab().id)

    expect(sent).toStrictEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Look:\n![image](id=a)' },
          { type: 'image', path: image('one.png') },
          { type: 'text', text: '\n![image](id=b)' },
          { type: 'image', path: image('two.jpg') },
          { type: 'text', text: '\nWhich is brighter?' },
        ],
      },
      { role: 'agent', content: 'This one: ![image](id=a)' },
      {
        role: 'user',
        content: [
          { type: 'text', text: '![image](id=c)' },
          { type: 'image', path: image('three.webp') },
          { type: 'text', text: ' and ![image](id=b\nCompare with ![image](id=a)' },
          { type: 'image', path: image('one.png') },
        ],
      },
    ])
    expect(toasts).toEqual([])
  })

  it('sends only the reference text with no path to a model that does not read images, and counts only the user images', async () => {
    sbp('dez.model/modelCache/applyProviderResult', model.providerId, {
      ok: true,
      models: [{ id: model.modelId, name: model.modelName, provider: model.providerId, imageInput: false }],
    })

    await sbp('dez.controller/submitTab', activeTab().id)

    expect(sent).toStrictEqual([
      { role: 'user', content: 'Look:\n![image](id=a)\n![image](id=b)\nWhich is brighter?' },
      { role: 'agent', content: 'This one: ![image](id=a)' },
      { role: 'user', content: '![image](id=c) and ![image](id=b\nCompare with ![image](id=a)' },
    ])
    expect(toasts).toStrictEqual([{
      area: 'app-global',
      data: {
        variant: 'warning',
        title: 'Images not sent',
        message: 'M does not read images, so 4 images were left out of the request.',
        duration: 8000,
      },
    }])
  })

  it('sends back no thinking that holds an image path, in its text or in its replay', async () => {
    const field = { kind: 'field', field: 'reasoning_content' } as const
    const blocks = (thinking: string): ThinkingReplay => ({ kind: 'anthropicBlocks', blocks: [{ type: 'thinking', thinking, signature: 's' }], prefixHash: 'h' })
    const agent = (id: string, thinking: SectionThinking): Section => ({ id, role: 'agent', content: [{ kind: 'text', text: 'A cat.' }], model, thinking })
    const user = (id: string): Section => ({ id, role: 'user', content: [{ kind: 'text', text: 'And?' }] })
    sbp('dez.model/tabs/replaceSections', activeTab().id, [
      user('u1'),
      agent('a1', { text: `The user sent ${image('one.png')}.`, replay: field }),
      user('u2'),
      agent('a2', { text: 'Blocks.', replay: blocks(`![${image('one.png')}](id=a) is a cat.`) }),
      user('u3'),
      agent('a3', { text: 'It is a cat.', replay: field }),
      user('u4'),
      agent('a4', { text: 'Blocks.', replay: blocks('It is a cat.') }),
      user('u5'),
    ])

    await sbp('dez.controller/submitTab', activeTab().id)

    expect(sent.map((message) => message.role === 'agent' ? message.thinking : undefined)).toStrictEqual([
      undefined, undefined,
      undefined, undefined,
      undefined, { text: 'It is a cat.', replay: field },
      undefined, { text: 'Blocks.', replay: blocks('It is a cat.') },
      undefined,
    ])
  })
})

describe('dez.stream/start media round', () => {
  const image = (name: string) => `/home/u/.config/dez/assets/images/${name}`
  const generated = (name: string) => `/home/u/.config/dez/assets/generated/images/${name}`
  const png = { bytes: new Uint8Array([1, 2, 3]), mediaType: 'image/png' } as const
  const EXPIRES = '2026-11-11T09:30:00.000Z'
  const FILM_URL = 'https://cdn.example.com/v/clip.mp4?sig=1'
  // A clip that plays from a temp copy, and one that plays from the URL of
  // a job of the provider.
  const speech: GeneratedClip = { kind: 'audio', mediaType: 'audio/mpeg', src: '/home/u/.cache/dez/media/s1.mp3', url: null, expires: EXPIRES, jobId: null }
  const film: GeneratedClip = { kind: 'video', mediaType: 'video/mp4', src: FILM_URL, url: FILM_URL, expires: EXPIRES, jobId: 'q-1' }
  const speechTag = (id: string) => `<dez:audio id="${id}" type="audio/mpeg" src="${speech.src}" expires="${EXPIRES}"/>`
  const conversation = (lastUserText = 'Make it red.') => [
    { role: 'user', text: `A fox: ![${image('fox.png')}](id=a)` },
    { role: 'agent', text: `![${generated('old.png')}](id=b)` },
    { role: 'user', text: lastUserText },
  ]
  let mediaInputs: ProviderGenerateMediaInput[] = []
  // The options of each save; the saves give the files g1.png, g2.png, ….
  let saves: unknown[] = []

  function useRequest(request: ModelRequest): void {
    sbp('dez.model/modelCache/applyProviderResult', model.providerId, {
      ok: true,
      models: [{ id: model.modelId, name: model.modelName, provider: model.providerId, outputs: ['image'], request }],
    })
  }

  function setConversation(lastUserText?: string): void {
    const [u1, a1, u2] = conversation(lastUserText)
    sbp('dez.model/tabs/replaceSections', activeTab().id, [
      { id: 'u1', role: 'user', content: [{ kind: 'text', text: u1.text }] },
      { id: 'a1', role: 'agent', content: [{ kind: 'text', text: a1.text }], model },
      { id: 'u2', role: 'user', content: [{ kind: 'text', text: u2.text }] },
    ])
  }

  beforeEach(() => {
    mediaInputs = []
    saves = []
    generateMedia = async (input) => {
      mediaInputs.push(input)
      return { media: [png, png], clips: [] }
    }
    saveImage = async (_mediaType, options) => {
      saves.push(options)
      return generated(`g${saves.length}.png`)
    }
    sbp('dez.model/setActiveModel', model.providerId, model.modelId, model.modelName)
    useRequest('image')
    setConversation()
  })

  it('saves each image in the generated folder, writes its reference with a new id, and finishes the reply', async () => {
    await sbp('dez.controller/submitTab', activeTab().id)

    expect(mediaInputs).toStrictEqual([{
      providerId: model.providerId,
      modelId: model.modelId,
      kind: 'image',
      prompt: 'Make it red.',
      images: [],
      requestId: expect.any(String),
      signal: expect.any(AbortSignal),
    }])
    expect(saves).toStrictEqual([{ folder: 'generated' }, { folder: 'generated' }])
    expect(sectionTexts()).toStrictEqual([
      ...conversation(),
      { role: 'agent', text: `![${generated('g1.png')}](id=c)\n\n![${generated('g2.png')}](id=d)` },
      { role: 'user', text: '' },
    ])
    expect(savedConversations.at(-1)?.sections).toHaveLength(5)
    expect(alerts).toStrictEqual([{ tabId: activeTab().id, status: 'finished' }])
    expect(toasts).toStrictEqual([])
    expect(deletedImages).toStrictEqual([])
  })

  it('edits the images of the last user message, with their stand-ins in the prompt', async () => {
    useRequest('imageEdit')
    setConversation(`Make ![${image('cat.png')}](id=c) red.`)

    await sbp('dez.controller/submitTab', activeTab().id)

    expect(mediaInputs[0]).toMatchObject({ kind: 'imageEdit', prompt: 'Make ![image](id=c) red.', images: [image('cat.png')] })
  })

  it('edits the newest image of the conversation when the last user message has none', async () => {
    useRequest('imageEdit')

    await sbp('dez.controller/submitTab', activeTab().id)

    expect(mediaInputs[0]).toMatchObject({ kind: 'imageEdit', prompt: 'Make it red.', images: [generated('old.png')] })
  })

  it('removes the section and shows an error toast when the request fails', async () => {
    generateMedia = async () => {
      throw new Error('No image to edit')
    }

    await sbp('dez.controller/submitTab', activeTab().id)

    expect(sectionTexts()).toStrictEqual(conversation())
    expect(toasts).toStrictEqual([{ area: 'app-global', data: { variant: 'error', title: 'Request failed', message: 'No image to edit' } }])
    expect(consoleError).toHaveBeenCalledWith('Media request failed:', new Error('No image to edit'))
    expect(saves).toStrictEqual([])
  })

  it('saves nothing when the user stops the request', async () => {
    generateMedia = async () => {
      await sbp('dez.stream/stop', activeTab().id)
      return { media: [png], clips: [] }
    }

    await sbp('dez.controller/submitTab', activeTab().id)

    expect(saves).toStrictEqual([])
    expect(sectionTexts()).toStrictEqual(conversation())
    expect(toasts).toStrictEqual([])
  })

  it('drops the images of a request that a new submit in the tab ended', async () => {
    const tabId = activeTab().id
    generateMedia = async (input) => {
      mediaInputs.push(input)
      if (mediaInputs.length === 1) await sbp('dez.controller/submitTab', tabId)
      return { media: [png], clips: [] }
    }

    await sbp('dez.controller/submitTab', tabId)

    expect(mediaInputs).toHaveLength(2)
    expect(saves).toHaveLength(1)
    // The new submit told the first request to stop.
    expect(mediaInputs.map((input) => input.signal?.aborted)).toStrictEqual([true, false])
    expect(sectionTexts()).toStrictEqual([
      ...conversation(),
      { role: 'agent', text: `![${generated('g1.png')}](id=c)` },
      { role: 'user', text: '' },
    ])
  })

  it('ends the reply as an error and deletes the saved images when a save fails', async () => {
    saveImage = async (_mediaType, options) => {
      saves.push(options)
      if (saves.length === 2) throw new Error('Disk full')
      return generated('g1.png')
    }

    await sbp('dez.controller/submitTab', activeTab().id)

    expect(deletedImages).toStrictEqual([generated('g1.png')])
    expect(sectionTexts()).toStrictEqual(conversation())
    expect(alerts).toStrictEqual([{ tabId: activeTab().id, status: 'error' }])
    // images/save shows its own toast.
    expect(toasts).toStrictEqual([])
  })

  it.each([
    ['the user stops the reply', () => sbp('dez.stream/stop', activeTab().id)],
    ['the user merges the section into the one before', () => sbp('dez.model/tabs/replaceSections', activeTab().id, activeTab().sections.slice(0, -1))],
  ])('deletes the saved images when %s during the save', async (_case, during) => {
    saveImage = async (_mediaType, options) => {
      saves.push(options)
      if (saves.length === 2) await during()
      return generated(`g${saves.length}.png`)
    }

    await sbp('dez.controller/submitTab', activeTab().id)

    expect(deletedImages).toStrictEqual([generated('g1.png'), generated('g2.png')])
    expect(sectionTexts()).toStrictEqual(conversation())
    expect(toasts).toStrictEqual([])
  })

  it('writes a tag for each clip, with a new id, its source, and the id of its job', async () => {
    useRequest('video')
    generateMedia = async () => ({ media: [], clips: [film, speech] })

    await sbp('dez.controller/submitTab', activeTab().id)

    expect(sectionTexts()).toStrictEqual([
      ...conversation(),
      { role: 'agent', text: `<dez:video id="c" type="video/mp4" src="${FILM_URL}" url="${FILM_URL}" expires="${EXPIRES}" job="q-1"/>\n\n${speechTag('d')}` },
      { role: 'user', text: '' },
    ])
    expect(alerts).toStrictEqual([{ tabId: activeTab().id, status: 'finished' }])
    expect(deletedFiles).toStrictEqual([])
  })

  it('sends the values that the user chose for the model, and no value of another model', async () => {
    useRequest('video')
    sbp('dez.model/settings/setModelParameter', { providerId: model.providerId, modelId: model.modelId }, 'duration', '8s')
    sbp('dez.model/settings/setModelParameter', { providerId: model.providerId, modelId: 'other' }, 'resolution', '4k')

    await sbp('dez.controller/submitTab', activeTab().id)

    expect(mediaInputs.map(({ kind, parameters }) => ({ kind, parameters }))).toStrictEqual([{ kind: 'video', parameters: { duration: '8s' } }])
  })

  // A clip can take minutes, and a tag counts only as a whole line.
  it.each(['My note', 'My note\n', 'My note\n\n'])('puts the tag in a paragraph of its own after %j, which the user typed during the request', async (typed) => {
    useRequest('tts')
    generateMedia = async () => {
      const tab = activeTab()
      sbp('dez.model/tabs/replaceSections', tab.id, tab.sections.map((section, index) =>
        index === tab.sections.length - 1 ? { ...section, content: [{ kind: 'text', text: typed }] } : section))
      return { media: [], clips: [speech] }
    }

    await sbp('dez.controller/submitTab', activeTab().id)

    expect(sectionTexts().at(-2)).toStrictEqual({ role: 'agent', text: `My note\n\n${speechTag('c')}` })
  })

  it.each([
    ['the user stops the request', () => sbp('dez.stream/stop', activeTab().id)],
    ['the user merges the section into the one before', () => sbp('dez.model/tabs/replaceSections', activeTab().id, activeTab().sections.slice(0, -1))],
  ])('deletes the temp copy of a clip that gets no tag, and no other file, when %s', async (_case, during) => {
    useRequest('video')
    generateMedia = async () => {
      await during()
      return { media: [], clips: [speech, film] }
    }

    await sbp('dez.controller/submitTab', activeTab().id)

    expect(deletedFiles).toStrictEqual([{ path: 'media/s1.mp3', root: 'cache' }])
    expect(sectionTexts()).toStrictEqual(conversation())
    expect(toasts).toStrictEqual([])
  })

  it('tells the request to stop when the user stops the reply, and shows no error for the request that then fails', async () => {
    useRequest('music')
    let abortedAtStart: boolean | undefined
    generateMedia = async (input) => {
      mediaInputs.push(input)
      abortedAtStart = input.signal?.aborted
      await sbp('dez.stream/stop', activeTab().id)
      // As the provider layer does for a job that was stopped.
      throw input.signal?.reason
    }

    await sbp('dez.controller/submitTab', activeTab().id)

    expect([abortedAtStart, mediaInputs[0].signal?.aborted]).toStrictEqual([false, true])
    expect(sectionTexts()).toStrictEqual(conversation())
    expect(toasts).toStrictEqual([])
    expect(consoleError).not.toHaveBeenCalled()
  })
})

describe('dez.stream/start images of a chat reply', () => {
  const image = (name: string) => `/home/u/.config/dez/assets/images/${name}`
  const generated = (name: string) => `/home/u/.config/dez/assets/generated/images/${name}`
  const png = { bytes: new Uint8Array([1, 2, 3]), mediaType: 'image/png' } as const
  // The options of each save; the saves give the files g1.png, g2.png, ….
  let saves: unknown[] = []

  beforeEach(() => {
    saves = []
    saveImage = async (_mediaType, options) => {
      saves.push(options)
      return generated(`g${saves.length}.png`)
    }
    sbp('dez.model/tabs/replaceSections', activeTab().id, [
      { id: 'u1', role: 'user', content: [{ kind: 'text', text: `A fox: ![${image('fox.png')}](id=a)` }] },
      { id: 'a1', role: 'agent', content: [{ kind: 'text', text: '' }], model },
    ])
  })

  it('saves each image in the generated folder and writes its reference, with a new id, as a paragraph between the text around it', async () => {
    streamChat = async (input) => {
      await input.onToken('Two views.')
      await input.onImage(png)
      await input.onImage(png)
      await input.onToken('\nThe last one:\n')
      await input.onImage(png)
      await input.onToken('\n')
      return { requestId: input.requestId as string }
    }

    await startStream()

    const text = `Two views.\n\n![${generated('g1.png')}](id=b)\n\n![${generated('g2.png')}](id=c)\n\nThe last one:\n\n![${generated('g3.png')}](id=d)`
    expect(saves).toStrictEqual([{ folder: 'generated' }, { folder: 'generated' }, { folder: 'generated' }])
    expect(sectionVisibleText(agentSection())).toBe(text)
    expect(editorTokens.join('')).toBe(text)
    expect(savedConversations).toHaveLength(1)
    expect(alerts).toStrictEqual([{ tabId: activeTab().id, status: 'finished' }])
    expect(deletedImages).toStrictEqual([])
  })

  // The text that the escaper holds came before the image, and the
  // reference between the two parts keeps them from forming a tag.
  it('writes the text that the escaper holds before the image', async () => {
    streamChat = async (input) => {
      await input.onToken('See <dez')
      await input.onImage(png)
      await input.onToken(':tool id="x" name="y">')
      return { requestId: input.requestId as string }
    }

    await startStream()

    expect(sectionVisibleText(agentSection())).toBe(`See <dez\n\n![${generated('g1.png')}](id=b)\n\n:tool id="x" name="y">`)
    expect(findToolBlocks(sectionVisibleText(agentSection()))).toStrictEqual([])
  })

  it('asks for image output only when the model makes images', async () => {
    const asked: unknown[] = []
    streamChat = async (input) => {
      asked.push(input.imageOutput)
      return { requestId: input.requestId as string }
    }
    const submitWithOutputs = async (outputs: string[]) => {
      sbp('dez.model/modelCache/applyProviderResult', model.providerId, {
        ok: true,
        models: [{ id: model.modelId, name: model.modelName, provider: model.providerId, outputs, request: 'chat' }],
      })
      await sbp('dez.controller/submitTab', activeTab().id)
    }
    sbp('dez.model/setActiveModel', model.providerId, model.modelId, model.modelName)

    // A model that the cache does not have is a text model.
    await sbp('dez.controller/submitTab', activeTab().id)
    await submitWithOutputs(['text'])
    await submitWithOutputs(['text', 'image'])

    expect(asked).toStrictEqual([false, false, true])
  })

  // images/save logs the failure and shows its own toast.
  it('leaves out an image whose save fails, and goes on with the reply', async () => {
    saveImage = async (_mediaType, options) => {
      saves.push(options)
      if (saves.length === 1) throw new Error('Disk full')
      return generated(`g${saves.length}.png`)
    }
    streamChat = async (input) => {
      await input.onToken('First.')
      await input.onImage(png)
      await input.onToken(' Second.')
      await input.onImage(png)
      return { requestId: input.requestId as string }
    }

    await startStream()

    expect(sectionVisibleText(agentSection())).toBe(`First. Second.\n\n![${generated('g2.png')}](id=b)`)
    expect(alerts).toStrictEqual([{ tabId: activeTab().id, status: 'finished' }])
    expect(toasts).toStrictEqual([])
    expect(deletedImages).toStrictEqual([])
  })

  it.each([
    ['the user stops the reply', () => sbp('dez.stream/stop', activeTab().id)],
    ['the user merges the section into the one before', () => sbp('dez.model/tabs/replaceSections', activeTab().id, activeTab().sections.slice(0, -1))],
  ])('deletes the saved image and writes no reference when %s during the save', async (_case, during) => {
    saveImage = async () => {
      await during()
      return generated('g1.png')
    }
    streamChat = async (input) => {
      await input.onToken('Before.')
      await input.onImage(png)
      return { requestId: input.requestId as string }
    }

    await startStream()

    expect(deletedImages).toStrictEqual([generated('g1.png')])
    expect(sectionTexts().map(({ text }) => text).join('')).not.toContain('g1.png')
    expect(toasts).toStrictEqual([])
  })

  // A stop keeps the late text of its request, but takes no late image.
  it('saves no image that comes after the user stopped the reply', async () => {
    streamChat = async (input) => {
      await input.onToken('Before.')
      cancelStream = async () => {
        await input.onImage(png)
        await input.onToken(' Late.')
      }
      await sbp('dez.stream/stop', activeTab().id)
      throw new Error('cancelled')
    }

    await startStream()

    expect(saves).toStrictEqual([])
    expect(sectionVisibleText(agentSection())).toBe('Before. Late.')
  })

  it('sends the image of a tool round back as text with no path, and starts no new paragraph after the tool blocks', async () => {
    const block = '<dez:tool id="c1" name="model_list" filter="gemini">\nNo models are available.\n</dez:tool>\n'
    const sent: string[] = []
    streamChat = async (input) => {
      sent.push(JSON.stringify(input.messages))
      if (sent.length === 2) {
        await input.onToken('None.')
        return { requestId: input.requestId as string }
      }
      await input.onImage(png)
      return { requestId: input.requestId as string, toolCalls: [{ id: 'c1', name: 'model_list', argumentsText: '{"filter":"gemini"}' }] }
    }

    await startStream({ sendTools: true })

    expect(sectionVisibleText(agentSection())).toBe(`![${generated('g1.png')}](id=b)\n${block}None.`)
    expect(sent[1]).toContain('![image](id=b)')
    expect(sent[1]).not.toContain('/home/u')
  })
})

describe('dez.controller/submitTab with a model that Dez cannot use', () => {
  it('shows an error toast that names its outputs, and leaves the running reply and the sections alone', async () => {
    const message = 'Dez cannot use M yet. It makes image and video output through an API that Dez does not support.'
    sbp('dez.model/setActiveModel', model.providerId, model.modelId, model.modelName)
    streamChat = async (input) => {
      await input.onToken('Before.')
      sbp('dez.model/modelCache/applyProviderResult', model.providerId, {
        ok: true,
        models: [{ id: model.modelId, name: model.modelName, provider: model.providerId, outputs: ['video', 'image'], request: 'none' }],
      })
      await sbp('dez.controller/submitTab', activeTab().id)
      await input.onToken(' After.')
      return { requestId: input.requestId as string }
    }

    await startStream()

    expect(sectionTexts()).toStrictEqual([
      { role: 'user', text: 'Hi' },
      { role: 'agent', text: 'Before. After.' },
      { role: 'user', text: '' },
    ])
    expect(toasts).toStrictEqual([{ area: 'app-global', data: { variant: 'error', title: 'Cannot send', message } }])
    expect(consoleError).toHaveBeenCalledWith(`Cannot send: ${message}`)
  })
})
