import sbp from '@sbp/sbp'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import type { ActiveModel, Section, SectionThinking, Tab, ThinkingReplay } from '../model/chat/types'
import { sectionVisibleText } from '../model/chat/content'
import type { DrawnImage, DrawnMediaType, ImageDrawing, ImageSize } from '../model/chat/imageDrawing'
import { findMediaTags } from '../model/chat/mediaTags'
import { agentTextForRequest, findToolBlocks } from '../model/chat/toolBlocks'
import type { ConversationData } from '../model/persistence/types'
import { missingImageProblem, TooManyImagesError, type InputImageRules } from '../model/providers/clipImages'
import { missingClipProblem, type ClipAttachment, type InputClipRules } from '../model/providers/clipInputs'
import type { ClipTextRules } from '../model/providers/clipText'
import { customProviderConfigSchema } from '../model/providers/config'
import { unstoredOutputMessage } from '../model/providers/unusableModel'
import type { GeneratedClip, ProviderChatInputMessage, ProviderGenerateMediaInput, ProviderGenerateMediaResult, ProviderInfo, ProviderStreamChatInput, ProviderStreamChatResult } from '../model/providers'
import { providerInfo } from '../model/providers/testing'
import { CLIP_KINDS, isClipKind, isTextKind, type MediaKind } from '../model/providers/types'
import type { RequestMessages } from '../model/streams/types'
import { systemPromptErrorText } from '../model/systemPrompt'
import { jobsWaitText, startedJobId } from '../model/tools/jobs'
import { NO_MODELS_TEXT } from '../model/tools/modelList'
import { TOOL_DEFINITIONS, unknownToolText } from '../model/tools/registry'
import type { ToastData } from '../view/toast/selectors'
import { ExplainedError, UNEXPECTED_ERROR } from '../utils/errorText'
import { APP_DIR, audioProgress, native, resetNative, writes } from './testing'
// Side-effect imports: register the dez.model/* selectors and the selectors
// under test.
import '../model/state/index'
import './stream'
import './thread'
import './tools'

const model: ActiveModel = { providerId: 'thinker', modelId: 'm', modelName: 'M' }
// The path of a pasted image and of a made image, and a made image.
const image = (name: string) => `/home/u/.config/dez/assets/images/${name}`
const generated = (name: string) => `/home/u/.config/dez/assets/generated/images/${name}`
const png = { bytes: new Uint8Array([1, 2, 3]), mediaType: 'image/png' } as const

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
// The path of each stored image that an `image` tool call read.
let readImages: string[] = []
// The clip files that were deleted. The native side (the deleted files of
// the app folders, and the ffmpeg runs of an `audio` call with their
// files) is the stub of testing.ts.
let deletedClips: string[] = []
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
  async 'dez.controller/images/readFile' (path: string): Promise<Blob> {
    readImages.push(path)
    return new Blob([])
  },
  // Every stored image is 1000 by 500 pixels.
  async 'dez.controller/images/redraw' (_file: Blob, plan: (size: ImageSize) => ImageDrawing | null, mediaType: DrawnMediaType): Promise<DrawnImage | null> {
    const drawing = plan({ width: 1000, height: 500 })
    return drawing && { bytes: new Uint8Array([1]), mediaType: drawing.mediaType ?? mediaType, width: drawing.width, height: drawing.height }
  },
  async 'dez.controller/media/delete' (path: string): Promise<void> {
    deletedClips.push(path)
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

// The input of each request that `replyRounds` answers, and its messages as
// plain data at the call.
let requests: ProviderStreamChatInput[] = []
let sent: ProviderChatInputMessage[][] = []

// `rounds[n]` answers the request of round n.
function replyRounds(rounds: Array<(input: ProviderStreamChatInput) => Promise<ProviderStreamChatResult>>): void {
  streamChat = async (input) => {
    requests.push(input)
    sent.push(JSON.parse(JSON.stringify(input.messages)) as ProviderChatInputMessage[])
    return await rounds[requests.length - 1](input)
  }
}

// Puts a user message, an earlier reply, and the last user message in the
// tab, with the texts of `conversation`.
function setConversation(conversation: Array<{ text: string }>): void {
  const [u1, a1, u2] = conversation
  sbp('dez.model/tabs/replaceSections', activeTab().id, [
    { id: 'u1', role: 'user', content: [{ kind: 'text', text: u1.text }] },
    { id: 'a1', role: 'agent', content: [{ kind: 'text', text: a1.text }], model },
    { id: 'u2', role: 'user', content: [{ kind: 'text', text: u2.text }] },
  ])
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
  readImages = []
  resetNative()
  requests = []
  sent = []
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
  const failure = new ExplainedError('Venice refused the API key.', 'HTTP 401: Authentication failed')

  it('removes the agent section of a request that fails before any output, and shows the text of the error in a sticky error toast', async () => {
    streamChat = async () => {
      throw failure
    }

    await startStream()

    expect(sectionTexts()).toEqual([{ role: 'user', text: 'Hi' }])
    expect(savedConversations.at(-1)?.sections).toHaveLength(1)
    expect(toasts).toStrictEqual([{
      area: 'app-global',
      data: { variant: 'error', title: 'Request failed', message: 'Venice refused the API key.\n\nDetails: HTTP 401: Authentication failed' },
    }])
    expect(consoleError).toHaveBeenCalled()
  })

  it('keeps the answer text that came before the error, with no error text, and adds a user section', async () => {
    streamChat = async (input) => {
      await input.onToken('Partial answer')
      throw failure
    }

    await startStream()

    expect(sectionTexts()).toEqual([
      { role: 'user', text: 'Hi' },
      { role: 'agent', text: 'Partial answer' },
      { role: 'user', text: '' },
    ])
    expect(toasts.map((toast) => toast.data.message)).toEqual([failure.message])
  })

  // No text of Dez explains an error that Dez did not expect, so the toast
  // asks for a report and shows the raw text last.
  it.each([
    ['an error that Dez did not expect', new Error('Cannot read properties of undefined'), 'Cannot read properties of undefined'],
    ['a failure with no text', new Error(''), 'The error has no text. Help › Developer Console shows it.'],
  ])('tells the user to try again and report %s', async (_name, error, details) => {
    streamChat = async () => {
      throw error
    }

    await startStream()

    expect(toasts.map((toast) => toast.data.message)).toEqual([`${UNEXPECTED_ERROR}\n\nDetails: ${details}`])
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
      throw failure
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
  const done = `<dez:tool id="c1" name="model_list" filter="gemini">\n${NO_MODELS_TEXT}\n</dez:tool>\n`
  const geminiCall = { id: 'c1', name: 'model_list', argumentsText: '{"filter":"gemini"}' }
  // How many times a `model_list` call ran.
  let runs = 0

  function blocks(): Array<{ id: string, status: string, result: string }> {
    return findToolBlocks(sectionVisibleText(agentSection())).map(({ id, status, result }) => ({ id, status, result }))
  }

  beforeEach(() => {
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
      { role: 'tool', results: [{ callId: 'c1', content: NO_MODELS_TEXT, isError: false }] },
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
    expect(unknown).toStrictEqual({
      id: 'c1',
      status: 'error',
      result: unknownToolText('web_search'),
    })
    expect(invalid.status).toBe('error')
    expect(invalid.result).toMatch(/^Dez did not run this call\. .+\n\nDetails: The call sent \{"filter":1\}$/)
    expect(renamed.id).toMatch(/^call_[0-9a-f]{12}$/)
    expect(renamed.status).toBe('success')
    expect(sent[1].at(-1)).toStrictEqual({
      role: 'tool',
      results: [
        { callId: 'c1', content: unknown.result, isError: true },
        { callId: 'c2', content: invalid.result, isError: true },
        { callId: renamed.id, content: NO_MODELS_TEXT, isError: false },
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
      { id: 'c1', status: 'success', result: NO_MODELS_TEXT },
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
        { callId: 'c1', content: NO_MODELS_TEXT, isError: false },
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
      ...Array<string>(20).fill(NO_MODELS_TEXT),
      'Not run: the reply reached the limit of 20 tool rounds.',
    ])
    expect(blocks().at(-1)?.status).toBe('error')
    expect(toasts).toStrictEqual([{
      area: 'app-global',
      data: {
        variant: 'error',
        title: 'Tool limit reached',
        message: 'The reply reached the limit of 20 tool rounds, so Dez did not run its last tool calls. To let the model go on, send a new message (for example "Go on").',
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
        throw new ExplainedError('Dez could not reach Venice.', 'connection reset')
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
      data: { variant: 'error', title: 'Request failed', message: 'Dez could not reach Venice.\n\nDetails: connection reset' },
    }])
    expect(alerts).toStrictEqual([{ tabId: activeTab().id, status: 'error' }])
  })
})

describe('dez.controller/submitTab without a model', () => {
  it('shows an error toast and adds no section', async () => {
    sbp('dez.model/tabs/replaceSections', activeTab().id, [{ id: 'u1', role: 'user', content: [{ kind: 'text', text: 'Hi' }] }])

    await sbp('dez.controller/submitTab', activeTab().id)

    expect(sectionTexts()).toEqual([{ role: 'user', text: 'Hi' }])
    expect(toasts).toStrictEqual([{ area: 'app-global', data: { variant: 'error', title: 'Cannot send', message: 'No model is selected. Choose a model in the bottom bar, and send again.' } }])
  })
})

describe('dez.controller/submitTab system prompt', () => {
  beforeEach(() => {
    replyRounds([async (input) => ({ requestId: input.requestId as string })])
    sbp('dez.model/setActiveModel', model.providerId, model.modelId, model.modelName)
    sbp('dez.model/tabs/replaceSections', activeTab().id, [{ id: 'u1', role: 'user', content: [{ kind: 'text', text: 'Hi' }] }])
  })

  it('sends the user template with its values', async () => {
    sbp('dez.model/settings/setSystemPrompt', 'You are {{model_id}} of {{provider_name}}.')

    await sbp('dez.controller/submitTab', activeTab().id)

    expect(requests.map((input) => input.system)).toStrictEqual(['You are m of Thinker.'])
  })

  it('sends no system prompt for a template of only white space', async () => {
    sbp('dez.model/settings/setSystemPrompt', ' \n ')

    await sbp('dez.controller/submitTab', activeTab().id)

    expect(requests).toHaveLength(1)
    expect(requests[0].system).toBeUndefined()
  })

  it('sends no chat request for a template with a problem, and names the problem and the fix', async () => {
    sbp('dez.model/settings/setSystemPrompt', 'Hi.\n{{model_name}}')
    const message = systemPromptErrorText('Line 2: {{model_name}} is not a variable.')

    await sbp('dez.controller/submitTab', activeTab().id)

    expect(requests).toStrictEqual([])
    expect(sectionTexts()).toStrictEqual([{ role: 'user', text: 'Hi' }])
    expect(toasts).toStrictEqual([{ area: 'app-global', data: { variant: 'error', title: 'Cannot send', message } }])
    expect(consoleError).toHaveBeenCalledWith(`Cannot send: ${message}`)
  })

  it('sends a media request all the same, as it has no system prompt', async () => {
    const mediaInputs: ProviderGenerateMediaInput[] = []
    generateMedia = async (input) => {
      mediaInputs.push(input)
      return { media: [], clips: [] }
    }
    sbp('dez.model/modelCache/applyProviderResult', model.providerId, {
      ok: true,
      models: [{ id: model.modelId, name: model.modelName, provider: model.providerId, outputs: ['image'], request: 'image' }],
    })
    sbp('dez.model/settings/setSystemPrompt', '{{model_name}}')

    await sbp('dez.controller/submitTab', activeTab().id)

    expect(mediaInputs.map((input) => input.prompt)).toStrictEqual(['Hi'])
    expect(toasts.filter((toast) => toast.data.title === 'Cannot send')).toStrictEqual([])
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
      { role: 'user', content: 'Was agent' },
    ])
  })
})

describe('dez.controller/submitTab images', () => {
  beforeEach(() => {
    replyRounds([async (input) => ({ requestId: input.requestId as string })])
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

  it('sends the images of the newest user message as parts after their reference text with no path, and every other image as that text only', async () => {
    await sbp('dez.controller/submitTab', activeTab().id)

    expect(sent[0]).toStrictEqual([
      { role: 'user', content: 'Look:\n![image](id=a)\n![image](id=b)\nWhich is brighter?' },
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

  it('sends only the reference text with no path to a model that does not read images, and counts the images of the newest user message', async () => {
    sbp('dez.model/modelCache/applyProviderResult', model.providerId, {
      ok: true,
      models: [{ id: model.modelId, name: model.modelName, provider: model.providerId, imageInput: false }],
    })

    await sbp('dez.controller/submitTab', activeTab().id)

    expect(sent[0]).toStrictEqual([
      { role: 'user', content: 'Look:\n![image](id=a)\n![image](id=b)\nWhich is brighter?' },
      { role: 'agent', content: 'This one: ![image](id=a)' },
      { role: 'user', content: '![image](id=c) and ![image](id=b\nCompare with ![image](id=a)' },
    ])
    expect(toasts).toStrictEqual([{
      area: 'app-global',
      data: {
        variant: 'warning',
        title: 'Images not sent',
        message: 'M does not read images, so 2 images were left out of the request.',
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

    expect(sent[0].map((message) => message.role === 'agent' ? message.thinking : undefined)).toStrictEqual([
      undefined, undefined,
      undefined, undefined,
      undefined, { text: 'It is a cat.', replay: field },
      undefined, { text: 'Blocks.', replay: blocks('It is a cat.') },
      undefined,
    ])
  })
})

describe('dez.stream/start media round', () => {
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
  const leftOut = (title: string, message: string) => [{ area: 'app-global', data: { variant: 'warning', title, message, duration: 8000 } }]
  let mediaInputs: ProviderGenerateMediaInput[] = []
  // The options of each save; the saves give the files g1.png, g2.png, ….
  let saves: unknown[] = []

  // What a model of this request kind makes.
  const outputsOf = (request: MediaKind) => isClipKind(request) ? [CLIP_KINDS[request]] : isTextKind(request) ? ['text'] : ['image']

  // Puts the model in the cache with this request kind, and with the frames
  // that a video model takes.
  function useRequest(request: MediaKind, maxImages?: number): void {
    sbp('dez.model/modelCache/applyProviderResult', model.providerId, {
      ok: true,
      models: [{
        id: model.modelId,
        name: model.modelName,
        provider: model.providerId,
        outputs: outputsOf(request),
        request,
        ...(maxImages !== undefined && { images: { maxImages } }),
      }],
    })
  }

  // Puts the model in the cache as a song model with these text rules.
  function useSongModel(text: ClipTextRules): void {
    sbp('dez.model/modelCache/applyProviderResult', model.providerId, {
      ok: true,
      models: [{ id: model.modelId, name: model.modelName, provider: model.providerId, outputs: ['audio'], request: 'music', text }],
    })
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
    setConversation(conversation())
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
    setConversation(conversation(`Make ![${image('cat.png')}](id=c) red.`))

    await sbp('dez.controller/submitTab', activeTab().id)

    expect(mediaInputs[0]).toMatchObject({ kind: 'imageEdit', prompt: 'Make ![image](id=c) red.', images: [image('cat.png')] })
  })

  it('edits the newest image of the conversation when the last user message has none', async () => {
    useRequest('imageEdit')

    await sbp('dez.controller/submitTab', activeTab().id)

    expect(mediaInputs[0]).toMatchObject({ kind: 'imageEdit', prompt: 'Make it red.', images: [generated('old.png')] })
  })

  // A model that does not read images gets the message as text only, but a
  // model that needs one image still gets the newest image of the
  // conversation, here an image of the message (`mediaRequestInput`).
  it.each([
    ['an edit model that does not read images the newest image', 'imageEdit', [image('cat.png')], leftOut('Only the newest image sent', 'M does not read images, so only the newest image of the conversation went with the request.')],
    ['an image model that does not read images no image', 'image', [], leftOut('Images not sent', 'M does not read images, so 2 images were left out of the request.')],
  ] as const)('sends %s, and tells the user', async (_name, request, images, warnings) => {
    sbp('dez.model/modelCache/applyProviderResult', model.providerId, {
      ok: true,
      models: [{ id: model.modelId, name: model.modelName, provider: model.providerId, outputs: ['image'], request, imageInput: false }],
    })
    setConversation(conversation(`Make ![${image('cat.png')}](id=c) look like @a.`))

    await sbp('dez.controller/submitTab', activeTab().id)

    expect(mediaInputs.map(({ prompt, images }) => ({ prompt, images }))).toStrictEqual([{ prompt: 'Make ![image](id=c) look like @a.', images }])
    expect(toasts).toStrictEqual(warnings)
  })

  // The reply would start, and then fail with an error of the request.
  it.each([
    ['an edit', 'imageEdit', undefined],
    ['a new image of a model that needs a reference image', 'image', { maxImages: 1, minImages: 1 }],
  ] as const)('sends no request for %s and shows an error toast when the conversation has no image', async (_name, request, images) => {
    const message = missingImageProblem(model.modelName, request, 0, images)
    sbp('dez.model/modelCache/applyProviderResult', model.providerId, {
      ok: true,
      models: [{ id: model.modelId, name: model.modelName, provider: model.providerId, outputs: ['image'], request, ...(images && { images }) }],
    })
    sbp('dez.model/tabs/replaceSections', activeTab().id, [{ id: 'u1', role: 'user', content: [{ kind: 'text', text: 'Make it red.' }] }])

    await sbp('dez.controller/submitTab', activeTab().id)

    expect(mediaInputs).toStrictEqual([])
    expect(sectionTexts()).toStrictEqual([{ role: 'user', text: 'Make it red.' }])
    expect(toasts).toStrictEqual([{ area: 'app-global', data: { variant: 'error', title: 'Cannot send', message } }])
    expect(consoleError).toHaveBeenCalledWith(`Cannot send: ${message}`)
    expect(alerts).toStrictEqual([])
  })

  // The conversation has an image before the message, but one image cannot
  // meet the count, so the toast counts only the images of the message.
  it('sends no request to a model that needs more images than the message has, and tells the count of the message', async () => {
    const message = 'M needs at least 2 images, and this message has 0. Paste more images, or name them with @id.'
    sbp('dez.model/modelCache/applyProviderResult', model.providerId, {
      ok: true,
      models: [{ id: model.modelId, name: model.modelName, provider: model.providerId, outputs: ['image'], request: 'image', images: { maxImages: 4, minImages: 2 } }],
    })

    await sbp('dez.controller/submitTab', activeTab().id)

    expect(mediaInputs).toStrictEqual([])
    expect(toasts).toStrictEqual([{ area: 'app-global', data: { variant: 'error', title: 'Cannot send', message } }])
  })

  it('removes the section and shows an error toast when the request fails', async () => {
    const failure = new ExplainedError('Venice refused the request.', 'HTTP 400: No image to edit')
    generateMedia = async () => {
      throw failure
    }

    await sbp('dez.controller/submitTab', activeTab().id)

    expect(sectionTexts()).toStrictEqual(conversation())
    expect(toasts).toStrictEqual([{ area: 'app-global', data: { variant: 'error', title: 'Request failed', message: failure.message } }])
    expect(consoleError).toHaveBeenCalledWith('Media request failed:', failure)
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
    expect(native.deletedFiles).toStrictEqual([])
  })

  it('sends the values that the user chose for the model, and no value of another model', async () => {
    useRequest('video')
    sbp('dez.model/settings/setModelParameter', { providerId: model.providerId, modelId: model.modelId }, 'duration', '8s')
    sbp('dez.model/settings/setModelParameter', { providerId: model.providerId, modelId: 'other' }, 'resolution', '4k')

    await sbp('dez.controller/submitTab', activeTab().id)

    expect(mediaInputs.map(({ kind, parameters }) => ({ kind, parameters }))).toStrictEqual([{ kind: 'video', parameters: { duration: '8s' } }])
  })

  describe('the frames of a video', () => {
    const twoImages = `From ![${image('cat.png')}](id=c) to @a.`

    beforeEach(() => {
      generateMedia = async (input) => {
        mediaInputs.push(input)
        return { media: [], clips: [film] }
      }
    })

    it('makes a video from the images of the last user message, as the first and the last frame', async () => {
      useRequest('imageToVideo', 2)
      setConversation(conversation(twoImages))

      await sbp('dez.controller/submitTab', activeTab().id)

      expect(mediaInputs.map(({ kind, prompt, images }) => ({ kind, prompt, images })))
        .toStrictEqual([{ kind: 'imageToVideo', prompt: 'From ![image](id=c) to @a.', images: [image('cat.png'), image('fox.png')] }])
      expect(sectionTexts().at(-2)?.text).toContain('<dez:video id="d"')
      expect(toasts).toStrictEqual([])
    })

    it('makes a video from the newest image of the conversation when the last user message has none', async () => {
      useRequest('imageToVideo', 2)
      setConversation(conversation('Make it run.'))

      await sbp('dez.controller/submitTab', activeTab().id)

      expect(mediaInputs.map(({ prompt, images }) => ({ prompt, images }))).toStrictEqual([{ prompt: 'Make it run.', images: [generated('old.png')] }])
      expect(toasts).toStrictEqual([])
    })

    // The request would cost money, or get an error text of the provider
    // that names its own field.
    it('sends no image-to-video request and shows an error toast when the conversation has no image', async () => {
      const message = 'M makes a video from an image. Paste an image, or name one with @id.'
      useRequest('imageToVideo', 2)
      sbp('dez.model/tabs/replaceSections', activeTab().id, [{ id: 'u1', role: 'user', content: [{ kind: 'text', text: 'Make it run.' }] }])

      await sbp('dez.controller/submitTab', activeTab().id)

      expect(mediaInputs).toStrictEqual([])
      expect(sectionTexts()).toStrictEqual([{ role: 'user', text: 'Make it run.' }])
      expect(toasts).toStrictEqual([{ area: 'app-global', data: { variant: 'error', title: 'Cannot send', message } }])
      expect(consoleError).toHaveBeenCalledWith(`Cannot send: ${message}`)
    })

    it('tells the user to keep only the images that the model takes when the provider refuses the rest', async () => {
      useRequest('imageToVideo', 2)
      setConversation(conversation(twoImages))
      generateMedia = async () => {
        throw new TooManyImagesError(1, 2)
      }

      await sbp('dez.controller/submitTab', activeTab().id)

      expect(sectionTexts()).toStrictEqual(conversation(twoImages))
      expect(toasts).toStrictEqual([{
        area: 'app-global',
        data: {
          variant: 'error',
          title: 'Request failed',
          message: 'M takes only 1 image, and this message has 2. Keep only 1 image in the message (pasted, or named with @id), and send it again.',
        },
      }])
    })

    describe('after a refusal that told the count of images', () => {
      // An image-to-video model with two frames in its rules, of which a
      // refusal of the provider told that it takes one (learnedImageLimit.ts).
      beforeEach(() => {
        sbp('dez.model/modelCache/applyProviderResult', model.providerId, {
          ok: true,
          models: [{ id: model.modelId, name: model.modelName, provider: model.providerId, outputs: ['video'], request: 'imageToVideo', images: { maxImages: 2 } }],
          entries: new Map([[model.modelId, { id: model.modelId }]]),
        })
        sbp('dez.model/modelCache/learnImageLimit', model.providerId, model.modelId, 1)
      })

      // The rules take two of the three images, but the message is refused,
      // not cut: the user chooses the image.
      it('sends no request for a message with more images, and counts the images that the rules leave out too', async () => {
        const message = 'M takes only 1 image, and this message has 3. Keep only 1 image in the message (pasted, or named with @id), and send it again.'
        setConversation(conversation(`${twoImages} Not @b.`))

        await sbp('dez.controller/submitTab', activeTab().id)

        expect(mediaInputs).toStrictEqual([])
        expect(sectionTexts()).toStrictEqual(conversation(`${twoImages} Not @b.`))
        expect(toasts).toStrictEqual([{ area: 'app-global', data: { variant: 'error', title: 'Cannot send', message } }])
        expect(consoleError).toHaveBeenCalledWith(`Cannot send: ${message}`)
      })

      it('sends a message with as many images as the refusal told', async () => {
        setConversation(conversation('From @a.'))

        await sbp('dez.controller/submitTab', activeTab().id)

        expect(mediaInputs.map((input) => input.images)).toStrictEqual([[image('fox.png')]])
        expect(toasts).toStrictEqual([])
      })
    })

    it.each([
      ['an image-to-video model that takes one frame', 'imageToVideo', 1, [image('cat.png')], 'Image not sent', 'M takes only 1 image, so 1 image was left out of the request.'],
      ['an edit model that takes one image', 'imageEdit', 1, [image('cat.png')], 'Image not sent', 'M takes only 1 image, so 1 image was left out of the request.'],
      // The cache does not tell how many frames the model takes.
      ['an image-to-video model with no frame count', 'imageToVideo', undefined, [image('cat.png')], 'Image not sent', 'M takes only 1 image, so 1 image was left out of the request.'],
      ['a text-to-video model that takes one frame', 'video', 1, [image('cat.png')], 'Image not sent', 'M takes only 1 image, so 1 image was left out of the request.'],
      ['a text-to-video model that takes no frame', 'video', undefined, [], 'Images not sent', 'M takes no image, so 2 images were left out of the request.'],
    ] as const)('sends %s the images that it takes, and tells the user of the rest', async (_name, request, maxImages, images, title, message) => {
      useRequest(request, maxImages)
      setConversation(conversation(twoImages))

      await sbp('dez.controller/submitTab', activeTab().id)

      expect(mediaInputs.map((input) => input.images)).toStrictEqual([images])
      expect(toasts).toStrictEqual(leftOut(title, message))
    })

    it('tells the user of a third image that a model with two frames does not take', async () => {
      useRequest('imageToVideo', 2)
      setConversation(conversation(`${twoImages} Not @b.`))

      await sbp('dez.controller/submitTab', activeTab().id)

      expect(mediaInputs.map((input) => input.images)).toStrictEqual([[image('cat.png'), image('fox.png')]])
      expect(toasts).toStrictEqual(leftOut('Image not sent', 'M takes only 2 images, so 1 image was left out of the request.'))
    })

    // A text-to-video model works with no image.
    it('gives a text-to-video model no image of an earlier message', async () => {
      useRequest('video', 2)
      setConversation(conversation('Make it run.'))

      await sbp('dez.controller/submitTab', activeTab().id)

      expect(mediaInputs.map((input) => input.images)).toStrictEqual([[]])
      expect(toasts).toStrictEqual([])
    })

    // An OpenRouter video model: two frames, or 16 references when the
    // user chose them (mediaFormats.ts).
    it.each([
      ['frames by default', undefined, [image('cat.png'), image('fox.png')], leftOut('Image not sent', 'M takes only 2 images, so 1 image was left out of the request.')],
      ['references that the user chose', 'references', [image('cat.png'), image('fox.png'), generated('old.png')], []],
    ])('sends a model that takes its images as %s the images of those rules', async (_name, imagesAs, images, warnings) => {
      sbp('dez.model/modelCache/applyProviderResult', model.providerId, {
        ok: true,
        models: [{
          id: model.modelId,
          name: model.modelName,
          provider: model.providerId,
          outputs: ['video'],
          request: 'video',
          parameters: [{ name: 'images_as', label: 'Images as', options: ['frames', 'references'], default: 'frames' }],
          images: { maxImages: 2, whenParameter: { name: 'images_as', value: 'references', rules: { maxImages: 16, references: {} } } },
        }],
      })
      if (imagesAs !== undefined) sbp('dez.model/settings/setModelParameter', { providerId: model.providerId, modelId: model.modelId }, 'images_as', imagesAs)
      setConversation(conversation(`${twoImages} Not @b.`))

      await sbp('dez.controller/submitTab', activeTab().id)

      expect(mediaInputs.map((input) => input.images)).toStrictEqual([images])
      expect(toasts).toStrictEqual(warnings)
    })
  })

  describe('the clips that a message names', () => {
    const speechClip = (id: string): ClipAttachment => ({ kind: 'audio', id, type: 'audio/mpeg', src: speech.src, url: null, expires: EXPIRES })
    const filmClip: ClipAttachment = { kind: 'video', id: 'e', type: 'video/mp4', src: FILM_URL, url: FILM_URL, expires: EXPIRES }
    const referenceClips: InputClipRules = { audio: { use: 'reference' }, video: { use: 'reference' } }
    // Two audio clips (c, d) and a video clip (e) of an earlier reply, and
    // no image.
    const clipConversation = (lastUserText: string) => [
      { role: 'user', text: 'Make a song, a voice, and a film.' },
      { role: 'agent', text: `${speechTag('c')}\n\n${speechTag('d')}\n\n<dez:video id="e" type="video/mp4" src="${FILM_URL}" url="${FILM_URL}" expires="${EXPIRES}"/>` },
      { role: 'user', text: lastUserText },
    ]

    function useClipModel(request: MediaKind, clips?: InputClipRules, images?: InputImageRules): void {
      sbp('dez.model/modelCache/applyProviderResult', model.providerId, {
        ok: true,
        models: [{
          id: model.modelId,
          name: model.modelName,
          provider: model.providerId,
          outputs: outputsOf(request),
          request,
          ...(clips && { clips }),
          ...(images && { images }),
        }],
      })
    }

    beforeEach(() => {
      generateMedia = async (input) => {
        mediaInputs.push(input)
        return { media: [], clips: [film] }
      }
    })

    it('sends a video model that takes clips the audio and the video clip that the message names, in text order', async () => {
      useClipModel('video', referenceClips)
      setConversation(clipConversation('Make @e move to the beat of @c.'))

      await sbp('dez.controller/submitTab', activeTab().id)

      expect(mediaInputs.map((input) => input.clips)).toStrictEqual([[filmClip, speechClip('c')]])
      expect(toasts).toStrictEqual([])
    })

    it.each([
      ['@c', 'Clip not sent', 'M takes no clip, so 1 clip was left out of the request.'],
      ['@c and @e', 'Clips not sent', 'M takes no clip, so 2 clips were left out of the request.'],
    ])('sends a video model with no clip rules a request with no clip of %s, and tells the user', async (mentions, title, message) => {
      useClipModel('video')
      setConversation(clipConversation(`Make it move like ${mentions}.`))

      await sbp('dez.controller/submitTab', activeTab().id)

      expect(mediaInputs).toHaveLength(1)
      expect(mediaInputs[0]).not.toHaveProperty('clips')
      expect(toasts).toStrictEqual(leftOut(title, message))
    })

    it.each([
      [
        'one audio clip',
        { audio: { use: 'reference', maxClips: 1 }, video: { use: 'reference' } },
        'Mix @c with @d.',
        [speechClip('c')],
        'Clip not sent',
        'M takes only 1 audio clip, so 1 clip was left out of the request.',
      ],
      [
        'one audio clip and no video clip',
        { audio: { use: 'background', maxClips: 1 } },
        'Put @d and @c under @e.',
        [speechClip('d')],
        'Clips not sent',
        'M takes only 1 audio clip and takes no video clip, so 2 clips were left out of the request.',
      ],
    ] as const)('sends a model that takes %s the clips that it takes, and tells the user of the rest', async (_name, clips, lastUserText, sent, title, message) => {
      useClipModel('video', clips)
      setConversation(clipConversation(lastUserText))

      await sbp('dez.controller/submitTab', activeTab().id)

      expect(mediaInputs.map((input) => input.clips)).toStrictEqual([sent])
      expect(toasts).toStrictEqual(leftOut(title, message))
    })

    it('sends no request and shows an error toast for an audio clip with no image or video clip, when the model needs one', async () => {
      const message = 'M takes an audio clip only together with a reference image or video. Add an image or a video clip to the message, or name one with @id.'
      useClipModel('video', { ...referenceClips, audioNeedsVisual: true })
      setConversation(clipConversation('Dance to @c.'))

      await sbp('dez.controller/submitTab', activeTab().id)

      expect(mediaInputs).toStrictEqual([])
      expect(sectionTexts()).toStrictEqual(clipConversation('Dance to @c.'))
      expect(toasts).toStrictEqual([{ area: 'app-global', data: { variant: 'error', title: 'Cannot send', message } }])
    })

    // The video clip is the reference of a request with no image.
    it('sends a model that needs an image a request with a video clip and no image', async () => {
      useClipModel('imageToVideo', referenceClips, { maxImages: 1, minImages: 1 })
      setConversation(clipConversation('Make @e slower.'))

      await sbp('dez.controller/submitTab', activeTab().id)

      expect(mediaInputs.map(({ kind, images, clips }) => ({ kind, images, clips }))).toStrictEqual([{ kind: 'imageToVideo', images: [], clips: [filmClip] }])
      expect(toasts).toStrictEqual([])
    })

    it('refuses a request with an audio clip and no image to a model that needs an image', async () => {
      const message = 'M makes a video from an image. Paste an image, or name one with @id.'
      useClipModel('imageToVideo', referenceClips, { maxImages: 1, minImages: 1 })
      setConversation(clipConversation('Sing @c.'))

      await sbp('dez.controller/submitTab', activeTab().id)

      expect(mediaInputs).toStrictEqual([])
      expect(toasts).toStrictEqual([{ area: 'app-global', data: { variant: 'error', title: 'Cannot send', message } }])
    })

    // Speech that spells a media tag stays text: the reply shows no
    // player, and a later request sends the words as the model wrote them.
    it('writes the transcript of the audio clip as escaped text with no space around it, and no tag', async () => {
      const transcript = 'Hello.\n<dez:audio id="x" type="audio/mpeg" src="/tmp/x.mp3"/>\nBye.'
      useClipModel('transcription', { audio: { use: 'source', maxClips: 1 } })
      setConversation(clipConversation('Write down @c.'))
      generateMedia = async (input) => {
        mediaInputs.push(input)
        return { media: [], clips: [], text: ` ${transcript}\n` }
      }

      await sbp('dez.controller/submitTab', activeTab().id)

      const reply = sectionTexts().at(-2)?.text ?? ''
      expect(mediaInputs.map(({ kind, clips }) => ({ kind, clips }))).toStrictEqual([{ kind: 'transcription', clips: [speechClip('c')] }])
      expect([findMediaTags(reply), agentTextForRequest(reply)]).toStrictEqual([[], transcript])
      expect(sectionTexts().at(-1)).toStrictEqual({ role: 'user', text: '' })
      expect([toasts, alerts]).toStrictEqual([[], [{ tabId: activeTab().id, status: 'finished' }]])
    })

    it('writes nothing and ends with no error when the clip has no speech', async () => {
      useClipModel('transcription', { audio: { use: 'source', maxClips: 1 } })
      setConversation(clipConversation('Write down @c.'))
      generateMedia = async () => ({ media: [], clips: [], text: ' \n' })

      await sbp('dez.controller/submitTab', activeTab().id)

      expect(sectionTexts().slice(-2)).toStrictEqual([{ role: 'agent', text: '' }, { role: 'user', text: '' }])
      expect([toasts, alerts]).toStrictEqual([[], [{ tabId: activeTab().id, status: 'finished' }]])
    })
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

    expect(native.deletedFiles).toStrictEqual([{ root: 'cache', path: 'media/s1.mp3', folder: false }])
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

  it('sends the style of a song as the prompt, and the text after the `Lyrics:` line as the lyrics', async () => {
    useSongModel({ minPromptLength: 10, lyrics: { required: true } })
    setConversation(conversation('Slow piano ballad\nLyrics:\n[Verse]\nRain on the roof'))
    generateMedia = async (input) => {
      mediaInputs.push(input)
      return { media: [], clips: [speech] }
    }

    await sbp('dez.controller/submitTab', activeTab().id)

    expect(mediaInputs.map(({ kind, prompt, lyrics }) => ({ kind, prompt, lyrics })))
      .toStrictEqual([{ kind: 'music', prompt: 'Slow piano ballad', lyrics: '[Verse]\nRain on the roof' }])
    expect(sectionTexts().at(-2)).toStrictEqual({ role: 'agent', text: speechTag('c') })
  })

  it('sends the whole message as the prompt, with no lyrics, when a model that can take lyrics gets none', async () => {
    useSongModel({ lyrics: { required: false } })
    setConversation(conversation('Rain on a tin roof'))

    await sbp('dez.controller/submitTab', activeTab().id)

    expect(mediaInputs).toHaveLength(1)
    expect(mediaInputs[0]).toMatchObject({ kind: 'music', prompt: 'Rain on a tin roof' })
    expect(mediaInputs[0]).not.toHaveProperty('lyrics')
  })

  // The provider would answer with an error text that names its own
  // field (`lyrics_prompt`), or make a paid clip of a cut prompt.
  it.each([
    ['needs lyrics and the message has none', { lyrics: { required: true } }, 'Slow piano ballad', 'M needs lyrics. Write the style, then a line "Lyrics:", then the lyrics.'],
    [
      'gets a style that is too short',
      { minPromptLength: 10, lyrics: { required: true } },
      'Jazz\nLyrics:\nLa la',
      'M needs a prompt (the text before the "Lyrics:" line) of at least 10 characters. This one has 4. Write a longer prompt.',
    ],
    ['gets a prompt that is too long', { maxPromptLength: 5 }, 'A long rain', 'M takes a prompt of at most 5 characters. This one has 11. Make the prompt shorter.'],
  ])('sends no request and shows an error toast when the model %s', async (_name, text, lastUserText, message) => {
    useSongModel(text)
    setConversation(conversation(lastUserText))

    await sbp('dez.controller/submitTab', activeTab().id)

    expect(mediaInputs).toStrictEqual([])
    expect(sectionTexts()).toStrictEqual(conversation(lastUserText))
    expect(toasts).toStrictEqual([{ area: 'app-global', data: { variant: 'error', title: 'Cannot send', message } }])
    expect(consoleError).toHaveBeenCalledWith(`Cannot send: ${message}`)
    expect(alerts).toStrictEqual([])
  })
})

describe('dez.stream/start images of a chat reply', () => {
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
    const block = `<dez:tool id="c1" name="model_list" filter="gemini">\n${NO_MODELS_TEXT}\n</dez:tool>\n`
    replyRounds([
      async (input) => {
        await input.onImage(png)
        return { requestId: input.requestId as string, toolCalls: [{ id: 'c1', name: 'model_list', argumentsText: '{"filter":"gemini"}' }] }
      },
      async (input) => {
        await input.onToken('None.')
        return { requestId: input.requestId as string }
      },
    ])

    await startStream({ sendTools: true })

    expect(sectionVisibleText(agentSection())).toBe(`![${generated('g1.png')}](id=b)\n${block}None.`)
    expect(JSON.stringify(sent[1])).toContain('![image](id=b)')
    expect(JSON.stringify(sent[1])).not.toContain('/home/u')
  })

  // The replay of a round with an image is the provider's signature of
  // the image: about 1 MB that the conversation file and each later request
  // would hold.
  it('keeps no thinking for an image reply whose only thinking is its replay', async () => {
    streamChat = async (input) => {
      await input.onImage(png)
      const thinkingReplay: ThinkingReplay = { kind: 'reasoningDetails', details: [{ type: 'reasoning.encrypted', data: 'signature' }], prefixHash: 'h' }
      return { requestId: input.requestId as string, thinkingReplay }
    }

    await startStream()

    expect(sectionVisibleText(agentSection())).toBe(`![${generated('g1.png')}](id=b)`)
    expect(agentSection().thinking).toBeUndefined()
    expect(savedConversations.at(-1)?.sections[1].thinking).toBeUndefined()
    expect(editorThinking).toStrictEqual([])
  })

  it('keeps the thinking text of a round that made an image with no replay, and the replay of each other round at its own round', async () => {
    const replay = (opaque: string): ThinkingReplay => ({ kind: 'copilot', opaque, prefixHash: 'h' })
    const call = (id: string) => ({ id, name: 'model_list', argumentsText: '{"filter":"gemini"}' })
    replyRounds([
      async (input) => {
        await input.onThinking('Plan.')
        return { requestId: input.requestId as string, thinkingReplay: replay('one'), toolCalls: [call('c1')] }
      },
      async (input) => {
        await input.onThinking('Draw.')
        await input.onImage(png)
        return { requestId: input.requestId as string, thinkingReplay: replay('two'), toolCalls: [call('c2')] }
      },
      async (input) => {
        await input.onThinking('Check.')
        await input.onToken('Done.')
        return { requestId: input.requestId as string, thinkingReplay: replay('three') }
      },
    ])

    await startStream({ sendTools: true })

    const thinking = {
      text: 'Plan.Draw.Check.',
      replay: replay('one'),
      rounds: [{ afterToolCall: 'c1', from: 5 }, { afterToolCall: 'c2', from: 10, replay: replay('three') }],
    }
    expect(agentSection().thinking).toStrictEqual(thinking)
    expect(savedConversations.at(-1)?.sections[1].thinking).toStrictEqual(thinking)
    // The agent messages of the last round's request: the round with the
    // image has no thinking.
    expect(sent[2].flatMap((message) => message.role === 'agent' ? [message.thinking ?? null] : [])).toStrictEqual([
      { text: 'Plan.', replay: replay('one') }, null,
    ])
  })
})

describe('dez.stream/start images that a tool makes', () => {
  const reference = (name: string, id: string) => `![${generated(name)}](id=${id}|tool=image)`
  const replay = (opaque: string): ThinkingReplay => ({ kind: 'copilot', opaque, prefixHash: 'h' })
  // An `image scale` call with these parameters, as the model sends it, and
  // its block in the reply.
  const scaleArguments = (parameters: Record<string, unknown>) => ({ command: 'scale', parameters: JSON.stringify(parameters) })
  const scaleCall = (id: string, parameters: Record<string, unknown>) => ({ id, name: 'image', argumentsText: JSON.stringify(scaleArguments(parameters)) })
  const scaleBlock = (id: string, parameters: Record<string, unknown>, result: string, status?: 'error') =>
    `<dez:tool id="${id}" name="image"${status ? ` status="${status}"` : ''} command="scale" parameters="${JSON.stringify(parameters).replaceAll('"', '&quot;')}">\n${result}\n</dez:tool>\n`
  const widthCall = scaleCall('c1', { image: '@a', width: 400 })
  const widthBlock = scaleBlock('c1', { image: '@a', width: 400 }, 'Made the image @b from @a. The image @b is 400x200 pixels.')
  // The saves give the files g1.png, g2.png, ….
  let saves = 0

  beforeEach(() => {
    saves = 0
    saveImage = async () => generated(`g${++saves}.png`)
    sbp('dez.model/tabs/replaceSections', activeTab().id, [
      { id: 'u1', role: 'user', content: [{ kind: 'text', text: `A fox: ![${image('fox.png')}](id=a)` }] },
      { id: 'a1', role: 'agent', content: [{ kind: 'text', text: '' }], model },
    ])
  })

  // The reference is the start of the text of the round after the tool's
  // group. That round calls a tool too: the request after it must hold its
  // thinking, and no request may end with an agent message.
  it('puts the image after the blocks of its round, and sends it at the start of the next round, which keeps its thinking', async () => {
    const listBlock = `<dez:tool id="c2" name="model_list" filter="gemini">\n${NO_MODELS_TEXT}\n</dez:tool>\n`
    replyRounds([
      async (input) => {
        await input.onThinking('Plan.')
        await input.onToken('Cropping.')
        return { requestId: input.requestId as string, thinkingReplay: replay('one'), toolCalls: [widthCall] }
      },
      async (input) => {
        await input.onThinking('List.')
        return { requestId: input.requestId as string, thinkingReplay: replay('two'), toolCalls: [{ id: 'c2', name: 'model_list', argumentsText: '{"filter":"gemini"}' }] }
      },
      async (input) => {
        await input.onToken('Done.')
        return { requestId: input.requestId as string }
      },
    ])

    await startStream({ sendTools: true })

    expect(readImages).toStrictEqual([image('fox.png')])
    expect(sectionVisibleText(agentSection())).toBe(`Cropping.\n${widthBlock}\n${reference('g1.png', 'b')}\n${listBlock}Done.`)
    const firstRound: ProviderChatInputMessage[] = [
      {
        role: 'agent',
        content: 'Cropping.',
        thinking: { text: 'Plan.', replay: replay('one') },
        toolCalls: [{ id: 'c1', name: 'image', arguments: scaleArguments({ image: '@a', width: 400 }) }],
      },
      { role: 'tool', results: [{ callId: 'c1', content: 'Made the image @b from @a. The image @b is 400x200 pixels.', isError: false }] },
    ]
    expect(sent[1]).toStrictEqual([{ role: 'user', content: 'Hi' }, ...firstRound])
    expect(sent[2]).toStrictEqual([
      { role: 'user', content: 'Hi' },
      ...firstRound,
      {
        role: 'agent',
        content: '\n![image](id=b|tool=image)',
        thinking: { text: 'List.', replay: replay('two') },
        toolCalls: [{ id: 'c2', name: 'model_list', arguments: { filter: 'gemini' } }],
      },
      { role: 'tool', results: [{ callId: 'c2', content: NO_MODELS_TEXT, isError: false }] },
    ])
    // A later request sends the reply with the same bytes.
    const stored = (sbp('dez.model/streamMessagesForTab', activeTab().id, model) as RequestMessages).messages
    expect(stored.slice(1, sent[2].length)).toStrictEqual(sent[2].slice(1))
    expect(deletedImages).toStrictEqual([])
  })

  // The second call names the image that the first call made: it is in the
  // section of the reply itself.
  it('keeps the images of two calls of one group after the group, each with a new id, and starts the next text in a new paragraph', async () => {
    const heightBlock = scaleBlock('c2', { image: 'b', height: 100 }, 'Made the image @c from @b. The image @c is 200x100 pixels.')
    replyRounds([
      async (input) => ({
        requestId: input.requestId as string,
        toolCalls: [widthCall, scaleCall('c2', { image: 'b', height: 100 })],
      }),
      async (input) => {
        await input.onToken('Both.')
        return { requestId: input.requestId as string }
      },
    ])

    await startStream({ sendTools: true })

    expect(readImages).toStrictEqual([image('fox.png'), generated('g1.png')])
    const text = `${widthBlock}${heightBlock}\n${reference('g1.png', 'b')}\n\n${reference('g2.png', 'c')}\n\nBoth.`
    expect(sectionVisibleText(agentSection())).toBe(text)
    expect(savedConversations.at(-1)?.sections[1].nodes).toStrictEqual([{ kind: 'text', text }])
    expect(sent[1].map((message) => message.role)).toStrictEqual(['user', 'agent', 'tool'])
  })

  it('keeps the image of a call that ended, and deletes the file of a call that the user stopped', async () => {
    saveImage = async () => {
      saves++
      if (saves === 2) await sbp('dez.stream/stop', activeTab().id)
      return generated(`g${saves}.png`)
    }
    replyRounds([
      async (input) => ({
        requestId: input.requestId as string,
        toolCalls: [widthCall, scaleCall('c2', { image: 'a', height: 100 })],
      }),
    ])

    await startStream({ sendTools: true })

    const stopped = scaleBlock('c2', { image: 'a', height: 100 }, 'Stopped.', 'error')
    expect(sectionVisibleText(agentSection())).toBe(`${widthBlock}${stopped}\n${reference('g1.png', 'b')}`)
    expect(deletedImages).toStrictEqual([generated('g2.png')])
    expect(sent).toHaveLength(1)
  })
})

describe('dez.stream/start clips that a tool makes', () => {
  const song = '/home/u/.config/dez/assets/generated/audio/song.mp3'
  // The new clip of the `audio` call: the file that Dez stored.
  const madeClip = () => `${APP_DIR}/${native.moves[0].to.path}`
  const clipTag = (id: string) => `<dez:audio id="${id}" type="audio/wav" src="${madeClip()}" tool="audio"/>`
  const clipCall = { id: 'c1', name: 'audio', argumentsText: JSON.stringify({ command: 'clip', parameters: JSON.stringify({ clip: 'a', end: 2 }) }) }
  const clipResult = 'Made the audio clip @b from @a, from second 0 to second 2. The audio clip @b is 2 seconds long.'
  const listCall = { id: 'c2', name: 'model_list', argumentsText: '{"filter":"gemini"}' }
  const listBlock = `<dez:tool id="c2" name="model_list" filter="gemini">\n${NO_MODELS_TEXT}\n</dez:tool>\n`

  // The text of the reply after the block of the `audio` call.
  function textAfterClipBlock(): string {
    const text = sectionVisibleText(agentSection())
    const blockEnd = '</dez:tool>\n'
    return text.slice(text.indexOf(blockEnd) + blockEnd.length)
  }

  beforeEach(() => {
    // An ffmpeg that wrote 2 seconds of audio into the new file.
    native.program = writes('stdout', audioProgress(2))
    native.folderFiles = ['a.mp3', 'new_clip.wav']
    deletedClips = []
    sbp('dez.model/tabs/replaceSections', activeTab().id, [
      { id: 'u0', role: 'user', content: [{ kind: 'text', text: 'A song.' }] },
      { id: 'a0', role: 'agent', content: [{ kind: 'text', text: `<dez:audio id="a" type="audio/mpeg" src="${song}"/>` }], model },
      { id: 'u1', role: 'user', content: [{ kind: 'text', text: 'Cut it.' }] },
      { id: 'a1', role: 'agent', content: [{ kind: 'text', text: '' }], model },
    ])
  })

  it('puts the clip\'s tag after the blocks of its round, with a new id and the tool\'s name, and sends only its id and type', async () => {
    replyRounds([
      async (input) => ({ requestId: input.requestId as string, toolCalls: [clipCall] }),
      async (input) => ({ requestId: input.requestId as string, toolCalls: [listCall] }),
      async (input) => {
        await input.onToken('Done.')
        return { requestId: input.requestId as string }
      },
    ])

    await startStream({ sendTools: true })

    expect(textAfterClipBlock()).toBe(`\n${clipTag('b')}\n${listBlock}Done.`)
    expect(sent[1].at(-1)).toStrictEqual({ role: 'tool', results: [{ callId: 'c1', content: clipResult, isError: false }] })
    expect(sent[2].at(-2)).toStrictEqual({
      role: 'agent',
      content: '\n<dez:audio id="b" type="audio/wav"/>',
      toolCalls: [{ id: 'c2', name: 'model_list', arguments: { filter: 'gemini' } }],
    })
    expect(deletedClips).toStrictEqual([])
  })

  it('starts the next text in a new paragraph after the tag, so that the tag stays a whole line', async () => {
    replyRounds([
      async (input) => ({ requestId: input.requestId as string, toolCalls: [clipCall] }),
      async (input) => {
        await input.onToken('Done.')
        return { requestId: input.requestId as string }
      },
    ])

    await startStream({ sendTools: true })

    expect(textAfterClipBlock()).toBe(`\n${clipTag('b')}\n\nDone.`)
  })

  it('deletes the file of a clip whose call the user stopped', async () => {
    native.moveAppFile = async () => {
      await sbp('dez.stream/stop', activeTab().id)
    }
    replyRounds([async (input) => ({ requestId: input.requestId as string, toolCalls: [clipCall] })])

    await startStream({ sendTools: true })

    expect(sectionVisibleText(agentSection())).not.toContain('<dez:audio')
    expect(deletedClips).toStrictEqual([madeClip()])
    expect(sent).toHaveLength(1)
  })
})

describe('dez.stream/start jobs', () => {
  const PAINTER = `${model.providerId}/painter`
  const FILMER = `${model.providerId}/filmer`
  const PROMPT = 'A fox in the snow.'
  // A `model_invoke` call, which starts a job.
  const invokeCall = (id: string, target = PAINTER) => ({ id, name: 'model_invoke', argumentsText: JSON.stringify({ model: target, prompt: PROMPT }) })
  const fox = generated('fox.png')
  const foxReference = `![${fox}](id=a|tool=model_invoke)`
  // A clip that the provider made as its job `q-17`, in a temp copy.
  const run: GeneratedClip = { kind: 'video', mediaType: 'video/mp4', src: '/home/u/.cache/dez/media/run.mp4', url: null, expires: '2026-12-01T00:00:00.000Z', jobId: 'q-17' }
  // The requests of the jobs, in the order of the starts: the signal of
  // the request, and the provider's answer or refusal, which only the test
  // gives.
  let jobs: Array<{ signal: AbortSignal, end: (result: ProviderGenerateMediaResult) => void, fail: (error: Error) => void }> = []

  // Lets the promise callbacks that are due run, on the fake clock: the
  // reply then waits for something that only the test ends.
  const settled = () => vi.advanceTimersByTimeAsync(0)

  // The result of the call `callId` of the reply, and the id of the job
  // that it started.
  function callResult(callId: string): string {
    return findToolBlocks(sectionVisibleText(agentSection())).find((block) => block.id === callId)?.result ?? ''
  }
  const jobId = (callId: string) => startedJobId(callResult(callId)) as string
  // The block of a `model_invoke` call of the reply.
  const invokeBlock = (id: string, target = PAINTER) => `<dez:tool id="${id}" name="model_invoke" model="${target}" prompt="${PROMPT}">\n${callResult(id)}\n</dez:tool>\n`

  beforeEach(() => {
    vi.useFakeTimers()
    jobs = []
    providerInfos = async () => [providerInfo(model.providerId, 'Thinker')]
    sbp('dez.model/modelCache/applyProviderResult', model.providerId, {
      ok: true,
      models: [
        { id: model.modelId, name: model.modelName, provider: model.providerId },
        { id: 'painter', name: 'Painter', provider: model.providerId, outputs: ['image'], request: 'image' },
        { id: 'filmer', name: 'Filmer', provider: model.providerId, outputs: ['video'], request: 'video' },
      ],
    })
    saveImage = async () => fox
    generateMedia = (input) => new Promise((resolve, reject) => {
      jobs.push({ signal: input.signal as AbortSignal, end: resolve, fail: reject })
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('gives the result of a job to a jobs_wait call, and puts the image of the job after the blocks of that call', async () => {
    replyRounds([
      async (input) => ({ requestId: input.requestId as string, toolCalls: [invokeCall('c1')] }),
      async (input) => ({ requestId: input.requestId as string, toolCalls: [{ id: 'c2', name: 'jobs_wait', argumentsText: '{}' }] }),
      async (input) => {
        await input.onToken('Here it is.')
        return { requestId: input.requestId as string }
      },
    ])

    const stream = startStream({ sendTools: true })
    await settled()
    // The call waits for the job.
    expect(requests).toHaveLength(2)
    jobs[0].end({ media: [png], clips: [] })
    await stream

    const result = jobsWaitText([{ id: jobId('c1'), tool: 'model_invoke', status: 'finished', text: 'Made the image @a.' }], 0)
    // The request after the call ends with its result: the reference of
    // the image after it would be a prefill.
    expect(sent[2].at(-1)).toStrictEqual({ role: 'tool', results: [{ callId: 'c2', content: result, isError: false }] })
    const text = sectionVisibleText(agentSection())
    expect(callResult('c2')).toBe(result)
    expect(text.slice(text.lastIndexOf('</dez:tool>\n'))).toBe(`</dez:tool>\n\n${foxReference}\n\nHere it is.`)
    expect(toasts).toStrictEqual([])
  })

  it('waits for a job that still runs at the end of the reply, then puts its clip at the section end with the name of its tool and the provider\'s job id', async () => {
    replyRounds([
      async (input) => ({ requestId: input.requestId as string, toolCalls: [invokeCall('c1', FILMER)] }),
      async (input) => {
        await input.onToken('I started it.')
        return { requestId: input.requestId as string }
      },
    ])

    const stream = startStream({ sendTools: true })
    await settled()
    // The model ended its reply, and the job still runs.
    expect(requests).toHaveLength(2)
    expect(sbp('dez.model/streams/isStreaming', activeTab().id)).toBe(true)
    expect(savedConversations).toHaveLength(0)
    jobs[0].end({ media: [], clips: [run] })
    await stream

    const tag = `<dez:video id="a" type="video/mp4" src="${run.src}" expires="${run.expires}" tool="model_invoke" job="q-17"/>`
    expect(sectionTexts()).toStrictEqual([
      { role: 'user', text: 'Hi' },
      { role: 'agent', text: `${invokeBlock('c1', FILMER)}I started it.\n\n${tag}` },
      { role: 'user', text: '' },
    ])
    expect(native.deletedFiles).toStrictEqual([])
    expect(toasts).toStrictEqual([])
    expect(alerts).toStrictEqual([{ tabId: activeTab().id, status: 'finished' }])
  })

  // Both readers of a job's result write the marker: a `jobs_wait` call,
  // and the end of the reply.
  it('marks the assets of a call with `is_intermediate` as hidden assets of its job, at the place of any other asset', async () => {
    const intermediateCall = (id: string, target: string) => ({ id, name: 'model_invoke', argumentsText: JSON.stringify({ model: target, prompt: PROMPT, is_intermediate: true }) })
    replyRounds([
      async (input) => ({ requestId: input.requestId as string, toolCalls: [intermediateCall('c1', PAINTER), intermediateCall('c2', FILMER)] }),
      async (input) => ({ requestId: input.requestId as string, toolCalls: [{ id: 'c3', name: 'jobs_wait', argumentsText: '{}' }] }),
      async (input) => {
        await input.onToken('Done.')
        return { requestId: input.requestId as string }
      },
    ])

    const stream = startStream({ sendTools: true })
    await settled()
    jobs[0].end({ media: [png], clips: [] })
    await settled()
    // The model ended its reply, and the job of the clip still runs.
    expect(requests).toHaveLength(3)
    jobs[1].end({ media: [], clips: [run] })
    await stream

    // The model reads the same result as for a call that hides nothing.
    expect(callResult('c3')).toBe(jobsWaitText([{ id: jobId('c1'), tool: 'model_invoke', status: 'finished', text: 'Made the image @a.' }], 1))
    const text = sectionVisibleText(agentSection())
    expect(text.slice(text.lastIndexOf('</dez:tool>\n'))).toBe(
      `</dez:tool>\n\n![${fox}](id=a|tool=model_invoke|hidden=${jobId('c1')})\n\nDone.\n\n`
      + `<dez:video id="b" type="video/mp4" src="${run.src}" expires="${run.expires}" tool="model_invoke" job="q-17" hidden="${jobId('c2')}"/>`,
    )
    expect(toasts).toStrictEqual([])
  })

  // The reply does not tell of these jobs, so only the toast does. One
  // toast for all of them: the toast area shows only a few at a time.
  it('tells the user in one sticky error toast of the jobs that failed and whose results the model did not get', async () => {
    replyRounds([
      async (input) => ({ requestId: input.requestId as string, toolCalls: [invokeCall('c1'), invokeCall('c2')] }),
      async (input) => {
        jobs[0].fail(new ExplainedError('The provider refused the prompt.'))
        jobs[1].fail(new ExplainedError('The provider has no credit left.'))
        await input.onToken('Both run now.')
        return { requestId: input.requestId as string }
      },
    ])

    await startStream({ sendTools: true })

    expect(toasts).toStrictEqual([{
      area: 'app-global',
      data: { variant: 'error', title: '2 jobs failed', message: expect.any(String) },
    }])
    const details = toasts[0].data.message.split('\n\n').filter((part) => part.includes('model_invoke job'))
    expect(details).toHaveLength(2)
    expect(details[0]).toContain(`${jobId('c1')} failed`)
    expect(details[0]).toContain('The provider refused the prompt.')
    expect(details[1]).toContain(`${jobId('c2')} failed`)
    expect(details[1]).toContain('The provider has no credit left.')
    expect(alerts).toStrictEqual([{ tabId: activeTab().id, status: 'finished' }])
  })

  it('takes the image of a job that still runs when the request fails, then shows the error', async () => {
    replyRounds([
      async (input) => ({ requestId: input.requestId as string, toolCalls: [invokeCall('c1')] }),
      async () => {
        throw new ExplainedError('Venice refused the API key.', 'HTTP 401: Authentication failed')
      },
    ])

    const stream = startStream({ sendTools: true })
    await settled()
    expect(toasts).toStrictEqual([])
    jobs[0].end({ media: [png], clips: [] })
    await stream

    expect(sectionVisibleText(agentSection())).toBe(`${invokeBlock('c1')}\n${foxReference}`)
    expect(toasts.map((toast) => toast.data)).toStrictEqual([
      { variant: 'error', title: 'Request failed', message: 'Venice refused the API key.\n\nDetails: HTTP 401: Authentication failed' },
    ])
    expect(alerts).toStrictEqual([{ tabId: activeTab().id, status: 'error' }])
  })

  // A section with only tool blocks is not empty, so the stop keeps it:
  // the blocks tell which calls ran.
  it('stops the jobs when the user stops the reply, keeps a section that holds only tool blocks, and deletes what a job still makes', async () => {
    replyRounds([
      async (input) => ({ requestId: input.requestId as string, toolCalls: [invokeCall('c1', FILMER)] }),
      async () => {
        await sbp('dez.stream/stop', activeTab().id)
        throw new Error('cancelled')
      },
    ])

    await startStream({ sendTools: true })

    expect(jobs[0].signal.aborted).toBe(true)
    // A request that does not end at the abort still gives its clip.
    jobs[0].end({ media: [], clips: [run] })
    await settled()
    expect(native.deletedFiles).toStrictEqual([{ root: 'cache', path: 'media/run.mp4', folder: false }])
    expect(sectionTexts()).toStrictEqual([
      { role: 'user', text: 'Hi' },
      { role: 'agent', text: invokeBlock('c1', FILMER) },
      { role: 'user', text: '' },
    ])
    expect(toasts).toStrictEqual([])
    expect(alerts).toStrictEqual([])
  })

  it('ends a reply that waits for its jobs as a stop when the user stops it', async () => {
    replyRounds([
      async (input) => ({ requestId: input.requestId as string, toolCalls: [invokeCall('c1')] }),
      async (input) => {
        await input.onToken('I started it.')
        return { requestId: input.requestId as string }
      },
    ])

    const stream = startStream({ sendTools: true })
    await settled()
    await sbp('dez.stream/stop', activeTab().id)
    await stream

    expect(jobs[0].signal.aborted).toBe(true)
    expect(sbp('dez.model/streams/isStreaming', activeTab().id)).toBe(false)
    expect(sectionVisibleText(agentSection())).toBe(`${invokeBlock('c1')}I started it.`)
    expect(savedConversations).toHaveLength(1)
    expect(toasts).toStrictEqual([])
    expect(alerts).toStrictEqual([])
  })

  it('stops the jobs of a reply that a new submit in the tab ends', async () => {
    const tabId = activeTab().id
    sbp('dez.model/setActiveModel', model.providerId, model.modelId, model.modelName)
    replyRounds([
      async (input) => ({ requestId: input.requestId as string, toolCalls: [invokeCall('c1')] }),
      async (input) => {
        await input.onToken('I started it.')
        await sbp('dez.controller/submitTab', tabId)
        throw new Error('cancelled')
      },
      async (input) => {
        await input.onToken('Answer.')
        return { requestId: input.requestId as string }
      },
    ])

    await startStream({ sendTools: true })

    expect(requests).toHaveLength(3)
    expect(jobs).toHaveLength(1)
    expect(jobs[0].signal.aborted).toBe(true)
    expect(toasts).toStrictEqual([])
  })
})

describe('dez.controller/submitTab with a model that Dez cannot use', () => {
  it('shows an error toast that names its outputs, and leaves the running reply and the sections alone', async () => {
    const message = 'Dez cannot use M yet. It makes image and video output through an API that Dez does not support. Choose another model.'
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

  // The model can be used, but it makes nothing without a clip, which the
  // message does not have.
  it('refuses a model that writes down a clip when the message has no audio clip', async () => {
    const message = missingClipProblem(model.modelName, 'transcription', [])
    sbp('dez.model/setActiveModel', model.providerId, model.modelId, model.modelName)
    sbp('dez.model/modelCache/applyProviderResult', model.providerId, {
      ok: true,
      models: [{ id: model.modelId, name: model.modelName, provider: model.providerId, outputs: ['text'], request: 'transcription' }],
    })
    sbp('dez.model/tabs/replaceSections', activeTab().id, [{ id: 'u1', role: 'user', content: [{ kind: 'text', text: 'Write this down.' }] }])

    await sbp('dez.controller/submitTab', activeTab().id)

    expect(sectionTexts()).toStrictEqual([{ role: 'user', text: 'Write this down.' }])
    expect(toasts).toStrictEqual([{ area: 'app-global', data: { variant: 'error', title: 'Cannot send', message } }])
    expect(consoleError).toHaveBeenCalledWith(`Cannot send: ${message}`)
  })

  // The provider would bill an image that Dez cannot store.
  it('refuses a model that makes only a file type that Dez does not store', async () => {
    const message = unstoredOutputMessage(model.modelName, 'TIFF')
    sbp('dez.model/setActiveModel', model.providerId, model.modelId, model.modelName)
    sbp('dez.model/modelCache/applyProviderResult', model.providerId, {
      ok: true,
      models: [{ id: model.modelId, name: model.modelName, provider: model.providerId, outputs: ['image'], request: 'image', unstoredOutput: 'TIFF' }],
    })
    sbp('dez.model/tabs/replaceSections', activeTab().id, [{ id: 'u1', role: 'user', content: [{ kind: 'text', text: 'Draw a fox.' }] }])

    await sbp('dez.controller/submitTab', activeTab().id)

    expect(sectionTexts()).toStrictEqual([{ role: 'user', text: 'Draw a fox.' }])
    expect(toasts).toStrictEqual([{ area: 'app-global', data: { variant: 'error', title: 'Cannot send', message } }])
    expect(consoleError).toHaveBeenCalledWith(`Cannot send: ${message}`)
  })
})
