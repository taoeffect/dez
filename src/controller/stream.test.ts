import sbp from '@sbp/sbp'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import type { ActiveModel, Section, SectionThinking, Tab, ThinkingReplay } from '../model/chat/types'
import { appTagText } from '../model/chat/appTags'
import { compactionTagText, sectionCompactionBlock, sectionTextParts } from '../model/chat/compaction'
import { compactionNotesText, notesLeftOutMessages, notesMessages } from '../model/chat/compactionNotes'
import { sectionVisibleText } from '../model/chat/content'
import type { ContextSize } from '../model/chat/contextSize'
import type { DrawnImage, DrawnMediaType, ImageDrawing, ImageSize } from '../model/chat/imageDrawing'
import { findMediaTags, mediaTagText } from '../model/chat/mediaTags'
import { HIDDEN_IMAGE_PATH, hiddenImage, notesData } from '../model/chat/testing'
import { agentTextForRequest, findToolBlocks } from '../model/chat/toolBlocks'
import type { ConversationData } from '../model/persistence/types'
import { missingImageProblem, TooManyImagesError, type InputImageRules } from '../model/providers/clipImages'
import { missingClipProblem, type ClipAttachment, type InputClipRules } from '../model/providers/clipInputs'
import type { ClipTextRules } from '../model/providers/clipText'
import { customProviderConfigSchema } from '../model/providers/config'
import { ProviderHttpError } from '../model/providers/errors'
import { unstoredOutputMessage } from '../model/providers/unusableModel'
import type { GeneratedClip, ProviderChatInputMessage, ProviderGenerateMediaInput, ProviderGenerateMediaResult, ProviderInfo, ProviderStreamChatInput, ProviderStreamChatResult } from '../model/providers'
import { providerInfo } from '../model/providers/testing'
import { CLIP_KINDS, isClipKind, isTextKind, ProviderNotConfiguredError, type MediaKind } from '../model/providers/types'
import type { CompactionLeftFiles } from '../model/streams/compactionFiles'
import { compactionInstruction } from '../model/streams/compactionRequest'
import type { RequestMessages, StreamMessage } from '../model/streams/types'
import { STOPPED_TOOL_RESULT, stoppedToolResult } from '../model/streams/toolRound'
import { showResultText } from '../model/tools/appShow'
import { systemPromptErrorText } from '../model/systemPrompt'
import { PICTURE_ROUND_FULL_NOTE, pictureBudgetLeftText } from '../model/tools/assetView'
import { jobsWaitText, jobTimedOutText, startedJobId } from '../model/tools/jobs'
import { INVOCATION_READS_INPUTS, invocationFailedText } from '../model/tools/modelInvoke'
import { NO_MODELS_TEXT } from '../model/tools/modelList'
import { TOOL_DEFINITIONS, unknownToolText } from '../model/tools/registry'
import type { ToastData } from '../view/toast/selectors'
import { ExplainedError, UNEXPECTED_ERROR } from '../utils/errorText'
import { APP_DIR, appFiles, audioProgress, CACHE_DIR, fakeAppFiles, native, resetNative, settled, writes } from './testing'
import type { RequestLogRow } from './diagnostics/requestLog'
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
// The toast groups that were closed.
let closedToasts: { area: string, group: string }[] = []
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
// The tab of each editor rebuild that a compaction asked for.
let editorRebuilds: string[] = []
// The files that each compaction left with no text, as it gave them to the
// delete.
let leftFiles: CompactionLeftFiles[] = []
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
  'dez.editor/rebuildIfVisible' (tabId: string): boolean {
    editorRebuilds.push(tabId)
    return false
  },
  async 'dez.controller/unusedFiles/deleteUnnamed' (files: CompactionLeftFiles): Promise<void> {
    leftFiles.push(files)
  },
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
  'dez.ui/closeToasts' (area: string, group: string): void {
    closedToasts.push({ area, group })
  },
  async 'dez.controller/alertReplyEnded' (tabId: string, status: string): Promise<void> {
    alerts.push({ tabId, status })
  },
})

function activeTab(): Tab {
  const id = sbp('dez.model/tabs/activeId') as string
  return (sbp('dez.model/tabs/list') as Tab[]).find((tab) => tab.id === id) as Tab
}

function agentSection(id = 'a1'): Section {
  return activeTab().sections.find((section) => section.id === id) as Section
}

function sectionTexts(): Array<{ role: string, text: string }> {
  return activeTab().sections.map((section) => ({ role: section.role, text: sectionVisibleText(section) }))
}

// Starts the reply of the section `sectionId`. `messages` are the messages
// of its first request, which hold the conversation before the reply.
async function startStream({ sendTools = false, sectionId = 'a1', newestUserMessage = 'Hi', messages = [{ role: 'user', content: newestUserMessage }] as StreamMessage[] } = {}): Promise<void> {
  await sbp('dez.stream/start', {
    tabId: activeTab().id,
    sectionId,
    model,
    request: 'chat',
    messages,
    imagesOverLimit: 0,
    newestUserMessage,
    sendTools,
    imageOutput: false,
    audioOutput: false,
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

// The first line of the instruction of a compaction request.
const COMPACTION_INSTRUCTION_START = compactionInstruction({ middleMessages: [], assetTable: '', apps: [], jobs: [], cost: undefined, tools: false }).split('\n')[0]

// Whether `input` is a compaction request: its last message is the
// instruction of Dez.
function isCompactionRequest(input: ProviderStreamChatInput): boolean {
  const last = input.messages.at(-1)
  return last?.role === 'user' && typeof last.content === 'string' && last.content.startsWith(COMPACTION_INSTRUCTION_START)
}

// The tokens of a chat round after which the next request is due for a
// compaction: the model `m` is of no family, so its window is 200,000
// tokens.
const LARGE_USAGE = { inputTokens: 135_000, outputTokens: 10 }
// What the provider counted for a compaction request.
const COMPACTION_USAGE = { inputTokens: 136_000, outputTokens: 40 }
const NOTES_REQUIREMENTS = 'The user wants a model.'

// Answers a compaction request with notes: `text`, by default the
// requirements.
async function notesAnswer(input: ProviderStreamChatInput, text = `## Requirements and decisions\n${NOTES_REQUIREMENTS}\n`): Promise<ProviderStreamChatResult> {
  input.onSent?.()
  await input.onToken(text)
  return { requestId: input.requestId as string, usage: COMPACTION_USAGE, cost: 0.5 }
}

// A `model_list` call that finds no model (the provider list is empty).
const geminiCall = { id: 'c1', name: 'model_list', argumentsText: '{"filter":"gemini"}' }

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
  closedToasts = []
  alerts = []
  editorRebuilds = []
  leftFiles = []
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
      data: { variant: 'error', title: 'Request failed', message: 'Venice refused the API key.\n\nDetails: HTTP 401: Authentication failed', group: expect.any(String) },
    }])
    expect(consoleError).toHaveBeenCalled()
  })

  // The toast tells of a reply that the user went on from.
  it('closes the error toasts of the tab\'s earlier replies at the start of a reply, and no toast of another tab', async () => {
    streamChat = async () => {
      throw failure
    }
    await startStream()
    const { group } = toasts[0].data
    // The start of the failed reply closed that group too.
    closedToasts = []

    const first = activeTab().id
    const sections = [
      { id: 'u1', role: 'user', content: [{ kind: 'text', text: 'Hi' }] },
      { id: 'a1', role: 'agent', content: [{ kind: 'text', text: '' }], model },
    ]
    sbp('dez.model/tabs/create')
    sbp('dez.model/tabs/replaceSections', activeTab().id, sections)
    await startStream()
    expect(toasts[1].data.group).not.toBe(group)
    expect(closedToasts).toStrictEqual([{ area: 'app-global', group: toasts[1].data.group }])

    sbp('dez.model/tabs/switch', first)
    sbp('dez.model/tabs/replaceSections', first, sections)
    await startStream()
    expect(closedToasts.at(-1)).toStrictEqual({ area: 'app-global', group })
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

describe('conversation cost', () => {
  it('adds the price of each round of a reply, a round with no price as unpriced, and saves the total with the conversation', async () => {
    replyRounds([
      async (input) => ({ requestId: input.requestId as string, toolCalls: [{ id: 'c1', name: 'model_list', argumentsText: '{}' }], cost: 0.25 }),
      async (input) => {
        await input.onToken('None.')
        return { requestId: input.requestId as string }
      },
    ])

    await startStream({ sendTools: true })

    const cost = { usd: 0.25, requests: 2, unpriced: 1 }
    expect(activeTab().cost).toStrictEqual(cost)
    expect(savedConversations.at(-1)?.cost).toStrictEqual(cost)
  })

  // A provider takes no money for a request that it refused. An answer
  // that broke off can have cost money. A request that failed before it
  // went (here: no API key) costs nothing.
  it('counts 0 for a request that the provider refused, no known price for one that broke off, and nothing for one that did not go', async () => {
    for (const [sent, failure] of [
      [true, new ProviderHttpError(model.providerId, 400, true, '', undefined, 'Thinker refused the request.', 'Thinker refused the request.')],
      [true, new Error('connection reset')],
      [false, new ProviderNotConfiguredError(model.providerId, 'Thinker', false)],
    ] as const) {
      sbp('dez.model/tabs/replaceSections', activeTab().id, [
        { id: 'u1', role: 'user', content: [{ kind: 'text', text: 'Hi' }] },
        { id: 'a1', role: 'agent', content: [{ kind: 'text', text: '' }], model },
      ])
      streamChat = async (input) => {
        if (sent) input.onSent?.()
        throw failure
      }
      await startStream()
    }

    expect(activeTab().cost).toStrictEqual({ usd: 0, requests: 2, unpriced: 1 })
  })

  // The stop saves the conversation before the stopped round gives its
  // price.
  it('saves the conversation again with the price of a round that the user stopped', async () => {
    streamChat = async (input) => {
      await input.onToken('Partial')
      await sbp('dez.stream/stop', activeTab().id)
      return { requestId: input.requestId as string, cost: 0.25 }
    }

    await startStream()

    await vi.waitFor(() => expect(savedConversations.at(-1)?.cost).toStrictEqual({ usd: 0.25, requests: 1, unpriced: 0 }))
  })
})

describe('context size of a conversation', () => {
  const size = () => sbp('dez.model/tabs/contextSize', activeTab().id) as ContextSize

  // The count is exact only for the model of the tab.
  beforeEach(() => {
    sbp('dez.model/setActiveModel', model.providerId, model.modelId, model.modelName)
  })

  it('keeps the tokens of a reply as the size of its tab, exact until the tab changes, and saves them with the conversation', async () => {
    replyRounds([
      async (input) => {
        await input.onThinking('Plan.')
        await input.onToken('Answer')
        return { requestId: input.requestId as string, thinkingReplay: { kind: 'field', field: 'reasoning' }, usage: { inputTokens: 1200, outputTokens: 300 } }
      },
    ])

    await startStream()

    expect(size()).toStrictEqual({ tokens: 1500, estimated: false })
    expect(activeTab().context?.tokens).toBe(1500)
    expect(savedConversations.at(-1)?.context).toStrictEqual(activeTab().context)

    // 25 characters of a model of no family (2.5 characters per token).
    const sections = activeTab().sections
    sbp('dez.model/tabs/replaceSections', activeTab().id, [...sections.slice(0, -1), { ...sections.at(-1) as Section, content: [{ kind: 'text', text: 'x'.repeat(25) }] }])
    expect(size()).toStrictEqual({ tokens: 1510, estimated: true })
  })

  // The calls of an answer are in its tokens, so only the results of the
  // tools come on top, as an estimate, until the next round counts them.
  it('counts each round of a reply, and adds only the results of its tools to the count of the round before', async () => {
    let afterTools: ContextSize | undefined
    replyRounds([
      async (input) => ({ requestId: input.requestId as string, toolCalls: [{ id: 'c1', name: 'model_list', argumentsText: '{}' }], usage: { inputTokens: 1000, outputTokens: 50 } }),
      async (input) => {
        afterTools = size()
        await input.onToken('None.')
        return { requestId: input.requestId as string, usage: { inputTokens: 1100, outputTokens: 20 } }
      },
    ])

    await startStream({ sendTools: true })

    expect(afterTools?.estimated).toBe(true)
    const resultTokens = NO_MODELS_TEXT.length / 2.5
    expect([Math.floor(resultTokens), Math.ceil(resultTokens)]).toContain((afterTools?.tokens ?? 0) - 1050)
    expect(size()).toStrictEqual({ tokens: 1120, estimated: false })
  })

  it('keeps the count of the request before when a provider tells no tokens, or only a part of them', async () => {
    replyRounds([
      async (input) => ({ requestId: input.requestId as string, toolCalls: [{ id: 'c1', name: 'model_list', argumentsText: '{}' }], usage: { inputTokens: 1000, outputTokens: 50 } }),
      async (input) => ({ requestId: input.requestId as string, toolCalls: [{ id: 'c2', name: 'model_list', argumentsText: '{}' }], usage: { inputTokens: 1100 } }),
      async (input) => ({ requestId: input.requestId as string }),
    ])

    await startStream({ sendTools: true })

    expect(activeTab().context?.tokens).toBe(1050)
    expect(size().estimated).toBe(true)
  })

  // The text of a stopped answer is cut off, and its request tells the
  // tokens of the whole answer, if any.
  it('keeps no count of a round that the user stopped', async () => {
    streamChat = async (input) => {
      await input.onToken('Partial')
      await sbp('dez.stream/stop', activeTab().id)
      return { requestId: input.requestId as string, cost: 0.25, usage: { inputTokens: 1200, outputTokens: 300 } }
    }

    await startStream()

    // The result of the round came: its price is counted.
    expect(activeTab().cost?.requests).toBe(1)
    expect(activeTab()).not.toHaveProperty('context')
    expect(size().estimated).toBe(true)
  })
})

// The numbers that a developer reads to check the prompt cache.
describe('request log', () => {
  const start = Date.UTC(2026, 10, 6, 12)
  // Each test has a new tab, and the log holds the rows of the tests
  // before it too.
  const rows = () => (sbp('dez.diagnostics/requestLog') as RequestLogRow[]).filter((row) => row.tabId === activeTab().id)

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(start)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('has one row for each chat round of a reply, with the tokens and the price that the provider told, and the time since the round before', async () => {
    replyRounds([
      async (input) => {
        vi.setSystemTime(start + 7000)
        return { requestId: input.requestId as string, toolCalls: [{ id: 'c1', name: 'model_list', argumentsText: '{}' }], cost: 0.25, usage: { inputTokens: 1000, cacheWriteTokens: 900, outputTokens: 50 } }
      },
      async (input) => {
        await input.onToken('None.')
        return { requestId: input.requestId as string, cost: 0.02, usage: { inputTokens: 1100, cachedInputTokens: 900, outputTokens: 20 } }
      },
    ])

    await startStream({ sendTools: true })

    const round = { tabId: activeTab().id, providerId: model.providerId, modelId: model.modelId, kind: 'chat', contextEstimated: false, imageCount: 0 }
    expect(rows()).toStrictEqual([
      { ...round, startedAt: start, uncachedInputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 900, outputTokens: 50, cost: 0.25, contextTokens: 1050, sincePreviousMs: null },
      { ...round, startedAt: start + 7000, uncachedInputTokens: 200, cacheReadTokens: 900, cacheWriteTokens: 0, outputTokens: 20, cost: 0.02, contextTokens: 1120, sincePreviousMs: 7000 },
    ])
  })

  // The rows of a tab are the requests that its cost counts.
  it('has a row with no tokens for a request that failed after it went, and no row for one that did not go', async () => {
    for (const [sent, failure] of [
      [true, new ProviderHttpError(model.providerId, 400, true, '', undefined, 'Thinker refused the request.', 'Thinker refused the request.')],
      [false, new ProviderNotConfiguredError(model.providerId, 'Thinker', false)],
    ] as const) {
      sbp('dez.model/tabs/replaceSections', activeTab().id, [
        { id: 'u1', role: 'user', content: [{ kind: 'text', text: 'Hi' }] },
        { id: 'a1', role: 'agent', content: [{ kind: 'text', text: '' }], model },
      ])
      streamChat = async (input) => {
        if (sent) input.onSent?.()
        throw failure
      }
      await startStream()
    }

    expect(rows()).toMatchObject([{ kind: 'chat', uncachedInputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, outputTokens: null, cost: 0 }])
  })
})

describe('dez.stream/start tool loop', () => {
  const running = '<dez:tool id="c1" name="model_list" status="running" filter="gemini">\n</dez:tool>\n'
  const done = `<dez:tool id="c1" name="model_list" filter="gemini">\n${NO_MODELS_TEXT}\n</dez:tool>\n`
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

  // An older Dez ended a reply after 40 tool rounds, and told the model in
  // the results of the last ones how many rounds were left.
  it('runs the tool rounds of a reply with no limit of their count, and adds nothing to their results', async () => {
    const rounds = 60
    streamChat = async (input) => {
      requests.push(input)
      if (requests.length > rounds) return { requestId: input.requestId as string }
      return { requestId: input.requestId as string, toolCalls: [{ ...geminiCall, id: `c${requests.length}` }] }
    }

    await startStream({ sendTools: true })

    expect(requests).toHaveLength(rounds + 1)
    expect(runs).toBe(rounds)
    expect(blocks().map(({ status, result }) => [status, result])).toStrictEqual(Array(rounds).fill(['success', NO_MODELS_TEXT]))
    expect(toasts).toStrictEqual([])
    expect(alerts).toStrictEqual([{ tabId: activeTab().id, status: 'finished' }])
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
      data: { variant: 'error', title: 'Request failed', message: 'Dez could not reach Venice.\n\nDetails: connection reset', group: expect.any(String) },
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
      { id: 'u1', role: 'user', content: [{ kind: 'text', text: `Look:\n![id=a](${image('one.png')})\n![id=b](${image('two.jpg')})\nWhich is brighter?` }] },
      { id: 'a1', role: 'agent', content: [{ kind: 'text', text: `This one: ![id=a](${image('one.png')})` }], model },
      {
        id: 'u2',
        role: 'user',
        content: [
          // The second reference lost its `)` to the Backspace rule.
          { kind: 'text', text: `![id=c](${image('three.webp')}) and ![id=b](${image('two.jpg')}\n` },
          { kind: 'prompt', id: 'p1', promptId: null, name: 'Compare', body: `Compare with ![id=a](${image('one.png')})`, expanded: false },
          { kind: 'text', text: '' },
        ],
      },
    ])
  })

  it('sends the images of each user message as parts after their reference text with no path, each image one time, and the images of a reply as that text only', async () => {
    await sbp('dez.controller/submitTab', activeTab().id)

    expect(sent[0]).toStrictEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Look:\n![id=a](image)' },
          { type: 'image', path: image('one.png') },
          { type: 'text', text: '\n![id=b](image)' },
          { type: 'image', path: image('two.jpg') },
          { type: 'text', text: '\nWhich is brighter?' },
        ],
      },
      { role: 'agent', content: 'This one: ![id=a](image)' },
      {
        role: 'user',
        content: [
          { type: 'text', text: '![id=c](image)' },
          { type: 'image', path: image('three.webp') },
          { type: 'text', text: ' and ![id=b](image\nCompare with ![id=a](image)' },
        ],
      },
    ])
    expect(toasts).toEqual([])
  })

  it('sends the newest images as text only when the conversation holds more images than a request to the model takes, and tells the user', async () => {
    sbp('dez.model/modelCache/applyProviderResult', model.providerId, {
      ok: true,
      models: [{ id: model.modelId, name: model.modelName, provider: model.providerId, imageLimit: 2 }],
    })
    // With no reply before it, the conversation is not compacted.
    sbp('dez.model/tabs/replaceSections', activeTab().id, [
      { id: 'u1', role: 'user', content: [{ kind: 'text', text: `![id=a](${image('one.png')}) ![id=b](${image('two.jpg')}) ![id=c](${image('three.webp')})` }] },
    ])

    await sbp('dez.controller/submitTab', activeTab().id)

    expect(sent).toStrictEqual([[{
      role: 'user',
      content: [
        { type: 'text', text: '![id=a](image)' },
        { type: 'image', path: image('one.png') },
        { type: 'text', text: ' ![id=b](image)' },
        { type: 'image', path: image('two.jpg') },
        { type: 'text', text: ' ![id=c](image)' },
      ],
    }]])
    expect(toasts).toStrictEqual([{
      area: 'app-global',
      data: {
        variant: 'warning',
        title: 'Image not sent',
        message: expect.stringContaining('M takes at most 2 images in one request, so the newest image '),
        duration: 8000,
      },
    }])
  })

  // Venice counts the images of each message, not of the request.
  it('sends the last images of a message as text only when the message holds more images than the model takes in one message, and tells the user that limit', async () => {
    sbp('dez.model/modelCache/applyProviderResult', model.providerId, {
      ok: true,
      models: [{ id: model.modelId, name: model.modelName, provider: model.providerId, imageLimit: 20, messageImageLimit: 2 }],
    })
    sbp('dez.model/tabs/replaceSections', activeTab().id, [
      { id: 'u1', role: 'user', content: [{ kind: 'text', text: `![id=a](${image('one.png')}) ![id=b](${image('two.jpg')}) ![id=c](${image('three.webp')})` }] },
      { id: 'r1', role: 'agent', content: [{ kind: 'text', text: 'Three foxes.' }], model },
      { id: 'u2', role: 'user', content: [{ kind: 'text', text: `![id=d](${image('four.png')})` }] },
    ])

    await sbp('dez.controller/submitTab', activeTab().id)

    const imagesOf = (message: ProviderChatInputMessage) =>
      (message.role === 'user' && Array.isArray(message.content) ? message.content.flatMap((part) => (part.type === 'image' ? [part.path] : [])) : [])
    // The next message has its own count.
    expect(sent[0].map(imagesOf)).toStrictEqual([[image('one.png'), image('two.jpg')], [], [image('four.png')]])
    expect(toasts).toHaveLength(1)
    expect(toasts[0].data.message).toContain('at most 2 images in one message')
    expect(toasts[0].data.message).toContain('20 images in one request')
    expect(toasts[0].data.message).toContain('so 1 image ')
  })

  it('sends only the reference text with no path to a model that does not read images, and counts the images of the newest user message', async () => {
    sbp('dez.model/modelCache/applyProviderResult', model.providerId, {
      ok: true,
      models: [{ id: model.modelId, name: model.modelName, provider: model.providerId, imageInput: false }],
    })

    await sbp('dez.controller/submitTab', activeTab().id)

    expect(sent[0]).toStrictEqual([
      { role: 'user', content: 'Look:\n![id=a](image)\n![id=b](image)\nWhich is brighter?' },
      { role: 'agent', content: 'This one: ![id=a](image)' },
      { role: 'user', content: '![id=c](image) and ![id=b](image\nCompare with ![id=a](image)' },
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
      agent('a2', { text: 'Blocks.', replay: blocks(`![id=a](${image('one.png')}) is a cat.`) }),
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
    { role: 'user', text: `A fox: ![id=a](${image('fox.png')})` },
    { role: 'agent', text: `![id=b](${generated('old.png')})` },
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
      onProgress: expect.any(Function),
    }])
    expect(saves).toStrictEqual([{ folder: 'generated' }, { folder: 'generated' }])
    expect(sectionTexts()).toStrictEqual([
      ...conversation(),
      { role: 'agent', text: `![id=c](${generated('g1.png')})\n\n![id=d](${generated('g2.png')})` },
      { role: 'user', text: '' },
    ])
    expect(savedConversations.at(-1)?.sections).toHaveLength(5)
    expect(alerts).toStrictEqual([{ tabId: activeTab().id, status: 'finished' }])
    expect(toasts).toStrictEqual([])
    expect(deletedImages).toStrictEqual([])
  })

  it('edits the images of the last user message, with their stand-ins in the prompt', async () => {
    useRequest('imageEdit')
    setConversation(conversation(`Make ![id=c](${image('cat.png')}) red.`))

    await sbp('dez.controller/submitTab', activeTab().id)

    expect(mediaInputs[0]).toMatchObject({ kind: 'imageEdit', prompt: 'Make ![id=c](image) red.', images: [image('cat.png')] })
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
    setConversation(conversation(`Make ![id=c](${image('cat.png')}) look like @a.`))

    await sbp('dez.controller/submitTab', activeTab().id)

    expect(mediaInputs.map(({ prompt, images }) => ({ prompt, images }))).toStrictEqual([{ prompt: 'Make ![id=c](image) look like @a.', images }])
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
    expect(toasts).toStrictEqual([{ area: 'app-global', data: { variant: 'error', title: 'Request failed', message: failure.message, group: expect.any(String) } }])
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

  // A provider takes no money for a request that it refused. A stop does
  // not end the provider's work, and a provider bills a request that it
  // took (its job, an answer that Dez cannot use), so they keep the quote.
  it('adds the price of each request that went to the cost of the conversation: 0 for one that the provider refused, the quote for one that failed after the provider took it or that the user stopped', async () => {
    const send = (input: ProviderGenerateMediaInput, quote?: number) => input.onProgress?.({ phase: 'sent', jobId: null, ...(quote !== undefined && { quote }) })
    const refusal = new ProviderHttpError(model.providerId, 400, true, '', undefined, 'Venice refused the request.', 'Venice refused the request.')
    for (const answer of [
      async (input: ProviderGenerateMediaInput) => {
        send(input, 0.5)
        return { media: [png], clips: [], cost: 0.25 }
      },
      async (input: ProviderGenerateMediaInput) => {
        send(input, 0.5)
        throw refusal
      },
      // A poll of the provider's job that it refused.
      async (input: ProviderGenerateMediaInput) => {
        send(input, 0.5)
        input.onProgress?.({ phase: 'queued', jobId: 'q-17' })
        throw new ExplainedError('Venice refused the request. To ask Venice about this clip, give its job id: q-17.', '', { cause: refusal })
      },
      async (input: ProviderGenerateMediaInput) => {
        send(input, 0.5)
        throw new ExplainedError('Venice sent an answer that Dez cannot use.')
      },
      async (input: ProviderGenerateMediaInput) => {
        send(input, 0.5)
        await sbp('dez.stream/stop', activeTab().id)
        throw input.signal?.reason
      },
      async () => { throw new ExplainedError('Dez cannot read cat.png.') },
      async (input: ProviderGenerateMediaInput) => {
        send(input)
        return { media: [png], clips: [] }
      },
    ]) {
      generateMedia = answer
      setConversation(conversation())
      await sbp('dez.controller/submitTab', activeTab().id)
    }

    const cost = { usd: 1.75, requests: 6, unpriced: 1 }
    expect(activeTab().cost).toStrictEqual(cost)
    expect(savedConversations.at(-1)?.cost).toStrictEqual(cost)
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
      { role: 'agent', text: `![id=c](${generated('g1.png')})` },
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
    const twoImages = `From ![id=c](${image('cat.png')}) to @a.`

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
        .toStrictEqual([{ kind: 'imageToVideo', prompt: 'From ![id=c](image) to @a.', images: [image('cat.png'), image('fox.png')] }])
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
          group: expect.any(String),
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
      expect([findMediaTags(reply, 'agent'), agentTextForRequest(reply)]).toStrictEqual([[], transcript])
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
      { id: 'u1', role: 'user', content: [{ kind: 'text', text: `A fox: ![id=a](${image('fox.png')})` }] },
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

    const text = `Two views.\n\n![id=b](${generated('g1.png')})\n\n![id=c](${generated('g2.png')})\n\nThe last one:\n\n![id=d](${generated('g3.png')})`
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

    expect(sectionVisibleText(agentSection())).toBe(`See <dez\n\n![id=b](${generated('g1.png')})\n\n:tool id="x" name="y">`)
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

    expect(sectionVisibleText(agentSection())).toBe(`First. Second.\n\n![id=b](${generated('g2.png')})`)
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

    expect(sectionVisibleText(agentSection())).toBe(`![id=b](${generated('g1.png')})\n${block}None.`)
    expect(JSON.stringify(sent[1])).toContain('![id=b](image)')
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

    expect(sectionVisibleText(agentSection())).toBe(`![id=b](${generated('g1.png')})`)
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

describe('dez.stream/start audio of a chat reply', () => {
  // A temp copy of the audio of the answer, as dez.provider/streamChat
  // gives it.
  const song = { kind: 'audio', mediaType: 'audio/mpeg', src: `${CACHE_DIR}/media/song.mp3`, url: null, expires: '2026-12-01T00:00:00.000Z', jobId: null } as const
  const songTag = (id: string) => mediaTagText({ kind: 'audio', id, type: 'audio/mpeg', src: song.src, url: null, expires: song.expires, other: [] })

  it('writes the tag of the clip, with a new id, as a whole line after the answer text', async () => {
    sbp('dez.model/tabs/replaceSections', activeTab().id, [
      { id: 'u1', role: 'user', content: [{ kind: 'text', text: `A fox: ![id=a](${image('fox.png')})` }] },
      { id: 'a1', role: 'agent', content: [{ kind: 'text', text: '' }], model },
    ])
    streamChat = async (input) => {
      await input.onToken('<instrumental>')
      await input.onClip(song)
      return { requestId: input.requestId as string }
    }

    await startStream()

    expect(sectionVisibleText(agentSection())).toBe(`<instrumental>\n\n${songTag('b')}`)
    expect(savedConversations).toHaveLength(1)
    expect(native.deletedFiles).toStrictEqual([])
  })

  it('asks for audio output only when the model makes audio', async () => {
    const asked: unknown[] = []
    streamChat = async (input) => {
      asked.push([input.imageOutput, input.audioOutput])
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

    await sbp('dez.controller/submitTab', activeTab().id)
    await submitWithOutputs(['text', 'image'])
    await submitWithOutputs(['text', 'audio'])

    expect(asked).toStrictEqual([[false, false], [true, false], [false, true]])
  })

  // A stop keeps the late text of its request, but takes no late clip.
  it('deletes the temp copy of a clip that comes after the user stopped the reply', async () => {
    streamChat = async (input) => {
      await input.onToken('Before.')
      cancelStream = async () => {
        await input.onClip(song)
        await input.onToken(' Late.')
      }
      await sbp('dez.stream/stop', activeTab().id)
      throw new Error('cancelled')
    }

    await startStream()

    expect(sectionVisibleText(agentSection())).toBe('Before. Late.')
    expect(native.deletedFiles).toStrictEqual([{ root: 'cache', path: 'media/song.mp3', folder: false }])
  })
})

describe('dez.stream/start images that a tool makes', () => {
  const reference = (name: string, id: string) => `![id=${id}|tool=image](${generated(name)})`
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
      { id: 'u1', role: 'user', content: [{ kind: 'text', text: `A fox: ![id=a](${image('fox.png')})` }] },
      { id: 'a1', role: 'agent', content: [{ kind: 'text', text: '' }], model },
    ])
  })

  // The reference is the start of the text of the round after the tool's
  // group, and no request holds it: the result of the call names the image.
  // That round calls a tool too: the request after it must hold its
  // thinking, and no request may end with an agent message.
  it('puts the image after the blocks of its round, and sends the next round with its thinking and with no text of the image', async () => {
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
        content: '',
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

describe('dez.stream/start pictures that a tool shows', () => {
  const viewCall = { id: 'c1', name: 'asset_view', argumentsText: JSON.stringify({ assets: '@a' }) }
  const listCall = { id: 'c2', name: 'model_list', argumentsText: '{"filter":"gemini"}' }
  // The copy of the picture of a view of @a, as its block names it. The
  // stub reads an empty PNG file of 1000 by 500 pixels, which goes as it
  // is.
  const copyOf = (saved: { file: { path: string } }) =>
    ({ file: saved.file.path.slice('assets/generated/views/'.length), label: 'asset_view: the image @a.', width: 1000, height: 500, bytes: 0 })
  // The last line of the result of each call of the reply.
  const budgetLines = () => findToolBlocks(sectionVisibleText(agentSection())).map(({ result }) => result.split('\n').at(-1))
  // That line for a conversation whose budget has `pictures` and `tokens`
  // left, in a round that takes as many pictures.
  const budgetLine = (pictures: number, tokens: number, megabytes = 20) =>
    pictureBudgetLeftText({ left: { pictures, tokens, bytes: megabytes * 1024 ** 2 }, roundPictures: pictures })

  beforeEach(() => {
    sbp('dez.model/tabs/replaceSections', activeTab().id, [
      { id: 'u1', role: 'user', content: [{ kind: 'text', text: `A fox: ![id=a](${image('fox.png')})` }] },
      { id: 'a1', role: 'agent', content: [{ kind: 'text', text: '' }], model },
    ])
  })

  it('sends the picture of a view as its saved copy, after the results of its round, in each later request of the reply and in the request of the next reply', async () => {
    replyRounds([
      async (input) => ({ requestId: input.requestId as string, toolCalls: [viewCall] }),
      async (input) => ({ requestId: input.requestId as string, toolCalls: [listCall] }),
      async (input) => {
        await input.onToken('Done.')
        return { requestId: input.requestId as string }
      },
    ])

    await startStream({ sendTools: true })

    const [, second, third] = requests.map((input) => input.messages)
    expect(native.savedFiles).toHaveLength(1)
    expect(second.map(({ role }) => role)).toStrictEqual(['user', 'agent', 'tool', 'user'])
    expect(second[3]).toStrictEqual({
      role: 'user',
      content: [{ type: 'text', text: 'asset_view: the image @a.' }, { type: 'picture', picture: copyOf(native.savedFiles[0]) }],
    })
    // The same copy again, so the same bytes: the prompt cache needs them.
    expect(third.slice(0, 4)).toStrictEqual(second)
    expect(third.map(({ role }) => role)).toStrictEqual(['user', 'agent', 'tool', 'user', 'agent', 'tool'])
    // The next reply sends the rounds of the section with the same
    // picture message at the same place.
    const stored = (sbp('dez.model/streamMessagesForTab', activeTab().id, model) as RequestMessages).messages
    expect(stored.slice(1, 6)).toStrictEqual(third.slice(1))
  })

  // The limits of a model of no family: 20 pictures, 52,000 tokens, and
  // 20 MiB of base64. A picture of 1000 by 500 pixels costs 648 tokens.
  it('gives a call the budget that the pictures of the rounds before, and of the earlier calls of its round, leave', async () => {
    replyRounds([
      async (input) => ({ requestId: input.requestId as string, toolCalls: [viewCall] }),
      async (input) => ({ requestId: input.requestId as string, toolCalls: [{ ...viewCall, id: 'c3' }, { ...viewCall, id: 'c4' }] }),
      async (input) => ({ requestId: input.requestId as string }),
    ])

    await startStream({ sendTools: true })

    expect(budgetLines()).toStrictEqual([budgetLine(19, 51_352), budgetLine(18, 50_704), budgetLine(17, 50_056)])
    expect(requests[2].messages.map(({ role }) => role)).toStrictEqual(['user', 'agent', 'tool', 'user', 'agent', 'tool', 'user'])
  })

  // The pictures of a round go in one message, so a round shows at most
  // as many pictures as the model takes images in one message.
  it('gives the calls of a round no picture over the image limit of one message, and the calls of the next round that count again', async () => {
    sbp('dez.model/modelCache/applyProviderResult', model.providerId, {
      ok: true,
      models: [{ id: model.modelId, name: model.modelName, provider: model.providerId, messageImageLimit: 2 }],
    })
    replyRounds([
      async (input) => ({ requestId: input.requestId as string, toolCalls: [viewCall, { ...viewCall, id: 'c3' }, { ...viewCall, id: 'c4' }] }),
      async (input) => ({ requestId: input.requestId as string, toolCalls: [{ ...viewCall, id: 'c5' }] }),
      async (input) => ({ requestId: input.requestId as string }),
    ])

    await startStream({ sendTools: true })

    const results = findToolBlocks(sectionVisibleText(agentSection())).map(({ result }) => result)
    expect(results.map((result) => result.includes(PICTURE_ROUND_FULL_NOTE))).toStrictEqual([false, false, true, false])
    expect(native.savedFiles).toHaveLength(3)
    const pictureCounts = requests[2].messages.map((message) =>
      (message.role === 'user' && Array.isArray(message.content) ? message.content.filter((part) => part.type === 'picture').length : 0))
    expect(pictureCounts).toStrictEqual([0, 0, 0, 2, 0, 0, 1])
  })

  it('takes each image of the request off the budget, as one picture of the assumed size with the bytes that a request sends for it, which it asks for one time in a reply', async () => {
    const sizeReads: string[] = []
    // 3 MiB are 4 MiB of base64.
    native.sentImageBytes = (path) => {
      sizeReads.push(path)
      return 3 * 1024 ** 2
    }
    replyRounds([
      async (input) => ({ requestId: input.requestId as string, toolCalls: [viewCall] }),
      async (input) => ({ requestId: input.requestId as string, toolCalls: [{ ...viewCall, id: 'c3' }] }),
      async (input) => ({ requestId: input.requestId as string }),
    ])

    await startStream({
      sendTools: true,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'A fox: ![id=a](image)' }, { type: 'image', path: image('fox.png') }] }],
    })

    // The image counts as 3,136 tokens.
    expect(budgetLines()).toStrictEqual([budgetLine(18, 48_216, 16), budgetLine(17, 47_568, 16)])
    expect(sizeReads).toStrictEqual([image('fox.png')])
  })

  it('names the copy of each picture in the block of its call', async () => {
    replyRounds([
      async (input) => ({ requestId: input.requestId as string, toolCalls: [viewCall] }),
      async (input) => {
        await input.onToken('Done.')
        return { requestId: input.requestId as string }
      },
    ])

    await startStream({ sendTools: true })

    const [saved] = native.savedFiles
    const [block] = findToolBlocks(sectionVisibleText(agentSection()))
    expect(block.pictures).toStrictEqual([copyOf(saved)])
    expect(native.deletedFiles).toStrictEqual([])
  })

  // A round runs its calls one after the other, and can take longer than
  // the age rule of Delete Unused Files.
  it('tells Delete Unused Files the copies of the calls that ended while their round runs', async () => {
    const held: string[][] = []
    native.saveAppFile = async () => {
      held.push(sbp('dez.stream/unnamedMadeFiles') as string[])
    }
    replyRounds([
      async (input) => ({ requestId: input.requestId as string, toolCalls: [viewCall, { ...viewCall, id: 'c3' }] }),
      async (input) => ({ requestId: input.requestId as string }),
    ])

    await startStream({ sendTools: true })

    const names = native.savedFiles.map(({ file }) => file.path.slice('assets/generated/views/'.length))
    expect(held).toStrictEqual([[], [names[0]]])
    expect(sbp('dez.stream/unnamedMadeFiles')).toStrictEqual([])
  })

  it('deletes the copies of a call that the user stopped while Dez saved them', async () => {
    native.saveAppFile = async () => {
      await sbp('dez.stream/stop', activeTab().id)
    }
    replyRounds([async (input) => ({ requestId: input.requestId as string, toolCalls: [viewCall] })])

    await startStream({ sendTools: true })

    const [stopped] = findToolBlocks(sectionVisibleText(agentSection()))
    expect(stopped).toMatchObject({ status: 'error', result: 'Stopped.' })
    expect(stopped.pictures).toBeUndefined()
    expect(native.deletedFiles).toStrictEqual([{ ...native.savedFiles[0].file, folder: false }])
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

  it('puts the clip\'s tag after the blocks of its round, with a new id and the tool\'s name, and sends the id only in the result of the call', async () => {
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
      content: '',
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

describe('dez.stream/start apps that a tool shows', () => {
  const showCall = (id: string, name: string) => ({ id, name: 'apps', argumentsText: JSON.stringify({ command: 'show', parameters: JSON.stringify({ name }) }) })
  const listCall = { id: 'c2', name: 'model_list', argumentsText: '{"filter":"gemini"}' }
  const listBlock = `<dez:tool id="c2" name="model_list" filter="gemini">\n${NO_MODELS_TEXT}\n</dez:tool>\n`

  // The text of the reply after the block of its first call.
  function textAfterFirstBlock(): string {
    const text = sectionVisibleText(agentSection())
    const blockEnd = '</dez:tool>\n'
    return text.slice(text.indexOf(blockEnd) + blockEnd.length)
  }

  beforeEach(() => {
    fakeAppFiles({ ...appFiles('notes', { 'index.html': '<p>Notes</p>\n' }, 'ui'), ...appFiles('sum', { 'main.ts': 'export default () => 1\n' }) })
    sbp('dez.model/tabs/replaceSections', activeTab().id, [
      { id: 'u1', role: 'user', content: [{ kind: 'text', text: 'Hi' }] },
      { id: 'a1', role: 'agent', content: [{ kind: 'text', text: '' }], model },
    ])
  })

  it('puts the tag of the app after the blocks of its round, and sends the app only in the result of the call', async () => {
    replyRounds([
      async (input) => {
        await input.onToken('Here.')
        return { requestId: input.requestId as string, toolCalls: [showCall('c1', 'notes')] }
      },
      async (input) => ({ requestId: input.requestId as string, toolCalls: [listCall] }),
      async (input) => {
        await input.onToken('Try it.')
        return { requestId: input.requestId as string }
      },
    ])

    await startStream({ sendTools: true })

    expect(textAfterFirstBlock()).toBe(`\n${appTagText('notes')}\n${listBlock}Try it.`)
    expect(sent[1].at(-1)).toStrictEqual({ role: 'tool', results: [{ callId: 'c1', content: showResultText('notes'), isError: false }] })
    expect(sent[2].at(-2)).toStrictEqual({ role: 'agent', content: '', toolCalls: [{ id: 'c2', name: 'model_list', arguments: { filter: 'gemini' } }] })
    // A later request sends the reply with the same bytes, and no tag.
    const stored = (sbp('dez.model/streamMessagesForTab', activeTab().id, model) as RequestMessages).messages
    expect(stored.slice(0, sent[2].length)).toStrictEqual(sent[2])
    expect(JSON.stringify(stored)).not.toContain('dez:app')
  })

  it('starts the next text in a new paragraph after the tag, so that the tag stays a whole line', async () => {
    replyRounds([
      async (input) => ({ requestId: input.requestId as string, toolCalls: [showCall('c1', 'notes')] }),
      async (input) => {
        await input.onToken('Try it.')
        return { requestId: input.requestId as string }
      },
    ])

    await startStream({ sendTools: true })

    expect(textAfterFirstBlock()).toBe(`\n${appTagText('notes')}\n\nTry it.`)
  })

  it('writes no tag for a call that Dez refuses', async () => {
    replyRounds([
      async (input) => ({ requestId: input.requestId as string, toolCalls: [showCall('c1', 'sum')] }),
      async (input) => {
        await input.onToken('It has no page.')
        return { requestId: input.requestId as string }
      },
    ])

    await startStream({ sendTools: true })

    expect(findToolBlocks(sectionVisibleText(agentSection()))[0]).toMatchObject({ status: 'error' })
    expect(textAfterFirstBlock()).toBe('It has no page.')
  })
})

describe('dez.stream/start jobs', () => {
  const PAINTER = `${model.providerId}/painter`
  const FILMER = `${model.providerId}/filmer`
  const PROMPT = 'A fox in the snow.'
  // A `model_invoke` call, which starts a job.
  const invokeCall = (id: string, target = PAINTER) => ({ id, name: 'model_invoke', argumentsText: JSON.stringify({ model: target, prompt: PROMPT }) })
  const fox = generated('fox.png')
  // The reference of the image of the job of the call `callId`.
  const foxReference = (callId: string) => `![id=a|tool=model_invoke|made-by=${jobId(callId)}](${fox})`
  // A clip that the provider made as its job `q-17`, in a temp copy.
  const run: GeneratedClip = { kind: 'video', mediaType: 'video/mp4', src: '/home/u/.cache/dez/media/run.mp4', url: null, expires: '2026-12-01T00:00:00.000Z', jobId: 'q-17' }
  // The requests of the jobs, in the order of the starts: the signal of
  // the request, and the provider's answer or refusal, which only the test
  // gives.
  let jobs: Array<{ signal: AbortSignal, end: (result: ProviderGenerateMediaResult) => void, fail: (error: Error) => void }> = []

  // The result of the call `callId` of the reply in the section
  // `sectionId`, and the id of the job that it started.
  function callResult(callId: string, sectionId = 'a1'): string {
    return findToolBlocks(sectionVisibleText(agentSection(sectionId))).find((block) => block.id === callId)?.result ?? ''
  }
  const jobId = (callId: string, sectionId = 'a1') => startedJobId(callResult(callId, sectionId)) as string
  // The block of a `model_invoke` call of the reply.
  const invokeBlock = (id: string, target = PAINTER) => `<dez:tool id="${id}" name="model_invoke" model="${target}" prompt="${PROMPT}">\n${callResult(id)}\n</dez:tool>\n`

  // Starts the next chat reply of the tab, in the section `sectionId`,
  // after the user message `text`, as a submit after a stop does.
  async function nextReply(sectionId: string, text = 'No, make it a hare.'): Promise<void> {
    const sections = activeTab().sections.filter((section) => section.role === 'agent' || sectionVisibleText(section) !== '')
    sbp('dez.model/tabs/replaceSections', activeTab().id, [
      ...sections,
      { id: `u-${sectionId}`, role: 'user', content: [{ kind: 'text', text }] },
      { id: sectionId, role: 'agent', content: [{ kind: 'text', text: '' }], model },
    ])
    await startStream({ sectionId, sendTools: true, newestUserMessage: text })
  }

  // A reply whose first round starts the job of `call`, and whose second
  // request the user stops.
  function stoppedRounds(call: ReturnType<typeof invokeCall>): Array<(input: ProviderStreamChatInput) => Promise<ProviderStreamChatResult>> {
    return [
      async (input) => ({ requestId: input.requestId as string, toolCalls: [call] }),
      async () => {
        await sbp('dez.stream/stop', activeTab().id)
        throw new Error('cancelled')
      },
    ]
  }

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

  afterEach(async () => {
    // The jobs that a stopped reply left outlive the test: end them, as a
    // close of the tab does.
    for (const tab of sbp('dez.model/tabs/list') as Tab[]) await sbp('dez.stream/stop', tab.id, { endJobs: true })
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

    const result = jobsWaitText([{ id: jobId('c1'), tool: 'model_invoke', status: 'finished', text: 'Made the image @a.', call: { number: 1, label: PROMPT } }], 0)
    // The request after the call ends with its result: the reference of
    // the image after it would be a prefill.
    expect(sent[2].at(-1)).toStrictEqual({ role: 'tool', results: [{ callId: 'c2', content: result, isError: false }] })
    const text = sectionVisibleText(agentSection())
    expect(callResult('c2')).toBe(result)
    expect(text.slice(text.lastIndexOf('</dez:tool>\n'))).toBe(`</dez:tool>\n\n${foxReference('c1')}\n\nHere it is.`)
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

    const tag = `<dez:video id="a" type="video/mp4" src="${run.src}" expires="${run.expires}" tool="model_invoke" job="q-17" made-by="${jobId('c1')}"/>`
    expect(sectionTexts()).toStrictEqual([
      { role: 'user', text: 'Hi' },
      { role: 'agent', text: `${invokeBlock('c1', FILMER)}I started it.\n\n${tag}` },
      { role: 'user', text: '' },
    ])
    expect(native.deletedFiles).toStrictEqual([])
    expect(toasts).toStrictEqual([])
    expect(alerts).toStrictEqual([{ tabId: activeTab().id, status: 'finished' }])
  })

  // Both readers of a job's result write the markers: a `jobs_wait` call,
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
    expect(callResult('c3')).toBe(jobsWaitText([{ id: jobId('c1'), tool: 'model_invoke', status: 'finished', text: 'Made the image @a.', call: { number: 1, label: PROMPT } }], 1))
    const text = sectionVisibleText(agentSection())
    expect(text.slice(text.lastIndexOf('</dez:tool>\n'))).toBe(
      `</dez:tool>\n\n![id=a|tool=model_invoke|made-by=${jobId('c1')}|hidden=${jobId('c1')}](${fox})\n\nDone.\n\n`
      + `<dez:video id="b" type="video/mp4" src="${run.src}" expires="${run.expires}" tool="model_invoke" job="q-17" made-by="${jobId('c2')}" hidden="${jobId('c2')}"/>`,
    )
    expect(toasts).toStrictEqual([])
  })

  // The reply does not tell of these jobs, so only the toast does. One
  // toast for all of them: the toast area shows only a few at a time. The
  // result text of a job is for the model, so only the console gets it.
  it('tells the user in one sticky error toast of the jobs that failed or timed out and whose results the model did not get', async () => {
    const timedCall = { id: 'c2', name: 'model_invoke', argumentsText: JSON.stringify({ model: PAINTER, prompt: PROMPT, timeout_seconds: 10 }) }
    replyRounds([
      async (input) => ({ requestId: input.requestId as string, toolCalls: [invokeCall('c1'), timedCall] }),
      async (input) => {
        jobs[0].fail(new ExplainedError('The provider refused the prompt.'))
        vi.advanceTimersByTime(10_000)
        await input.onToken('Both run now.')
        return { requestId: input.requestId as string }
      },
    ])

    await startStream({ sendTools: true })

    expect(toasts).toStrictEqual([{
      area: 'app-global',
      data: { variant: 'error', title: '2 jobs failed', message: expect.any(String), group: expect.any(String) },
    }])
    const { message } = toasts[0].data
    expect(message).toContain(`The model_invoke job ${jobId('c1')} failed.`)
    expect(message).toContain(`The model_invoke job ${jobId('c2')} timed out.`)
    const failedText = invocationFailedText('Painter', 'The provider refused the prompt.')
    const timedOutText = jobTimedOutText(10_000, INVOCATION_READS_INPUTS)
    expect(message).not.toContain('The provider refused the prompt.')
    expect(message).not.toContain(timedOutText)
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining(jobId('c1')), failedText)
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining(jobId('c2')), timedOutText)
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

    expect(sectionVisibleText(agentSection())).toBe(`${invokeBlock('c1')}\n${foxReference('c1')}`)
    expect(toasts.map((toast) => toast.data)).toStrictEqual([
      { variant: 'error', title: 'Request failed', message: 'Venice refused the API key.\n\nDetails: HTTP 401: Authentication failed', group: expect.any(String) },
    ])
    expect(alerts).toStrictEqual([{ tabId: activeTab().id, status: 'error' }])
  })

  // A section with only tool blocks is not empty, so the stop keeps it:
  // the blocks tell which calls ran. The user stops a reply to correct the
  // model, and its paid jobs must not go to waste.
  it('lets the jobs of a reply that the user stops run on: the next reply of the tab gets their results with jobs_wait, and its jobs count on', async () => {
    replyRounds([
      ...stoppedRounds(invokeCall('c1', FILMER)),
      async (input) => ({ requestId: input.requestId as string, toolCalls: [invokeCall('c3')] }),
      async (input) => ({ requestId: input.requestId as string, toolCalls: [{ id: 'c4', name: 'jobs_wait', argumentsText: '{"all":true}' }] }),
      async (input) => {
        await input.onToken('Here they are.')
        return { requestId: input.requestId as string }
      },
    ])

    await startStream({ sendTools: true })

    expect(jobs[0].signal.aborted).toBe(false)
    expect(sectionTexts()).toStrictEqual([
      { role: 'user', text: 'Hi' },
      { role: 'agent', text: invokeBlock('c1', FILMER) },
      { role: 'user', text: '' },
    ])
    expect(toasts).toStrictEqual([])
    expect(alerts).toStrictEqual([])
    const first = jobId('c1')

    const next = nextReply('a2')
    await settled()
    // The wait of the next reply waits for both jobs.
    expect(requests).toHaveLength(4)
    jobs[0].end({ media: [], clips: [run] })
    jobs[1].end({ media: [png], clips: [] })
    await next

    const second = jobId('c3', 'a2')
    expect(callResult('c4', 'a2')).toBe(jobsWaitText([
      { id: first, tool: 'model_invoke', status: 'finished', text: 'Made the video clip @a.', call: { number: 1, label: PROMPT } },
      { id: second, tool: 'model_invoke', status: 'finished', text: 'Made the image @b.', call: { number: 2, label: PROMPT } },
    ], 0))
    expect(sectionVisibleText(agentSection('a2'))).toContain(`made-by="${first}"/>`)
    expect(sectionVisibleText(agentSection('a2'))).toContain(`![id=b|tool=model_invoke|made-by=${second}](${fox})`)
    expect(sectionVisibleText(agentSection('a1'))).toBe(invokeBlock('c1', FILMER))
    expect(toasts).toStrictEqual([])
  })

  it('ends a reply that waits for its jobs as a stop when the user stops it, and leaves the jobs and their results to the next reply', async () => {
    replyRounds([
      async (input) => ({ requestId: input.requestId as string, toolCalls: [invokeCall('c1')] }),
      async (input) => {
        await input.onToken('I started it.')
        return { requestId: input.requestId as string }
      },
      async (input) => ({ requestId: input.requestId as string, toolCalls: [{ id: 'c2', name: 'jobs_wait', argumentsText: '{}' }] }),
      async (input) => ({ requestId: input.requestId as string }),
    ])

    const stream = startStream({ sendTools: true })
    await settled()
    await sbp('dez.stream/stop', activeTab().id)
    await stream

    expect(jobs[0].signal.aborted).toBe(false)
    expect(sbp('dez.model/streams/isStreaming', activeTab().id)).toBe(false)
    expect(sectionVisibleText(agentSection('a1'))).toBe(`${invokeBlock('c1')}I started it.`)
    expect(savedConversations).toHaveLength(1)
    expect(toasts).toStrictEqual([])
    expect(alerts).toStrictEqual([])

    // A job that ends while no reply runs keeps its image for the next
    // reply, also through Delete Unused Files.
    jobs[0].end({ media: [png], clips: [] })
    await settled()
    expect(sectionVisibleText(agentSection('a1'))).toBe(`${invokeBlock('c1')}I started it.`)
    expect(deletedImages).toStrictEqual([])
    expect(sbp('dez.stream/unnamedMadeFiles')).toStrictEqual([fox])

    await nextReply('a2')

    expect(callResult('c2', 'a2')).toBe(jobsWaitText([{ id: jobId('c1'), tool: 'model_invoke', status: 'finished', text: 'Made the image @a.', call: { number: 1, label: PROMPT } }], 0))
    expect(sectionVisibleText(agentSection('a2'))).toContain(foxReference('c1'))
  })

  it('tells the model in the result of a jobs_wait that a stop cut that the jobs go on', async () => {
    replyRounds([
      async (input) => ({ requestId: input.requestId as string, toolCalls: [invokeCall('c1')] }),
      async (input) => ({ requestId: input.requestId as string, toolCalls: [{ id: 'c2', name: 'jobs_wait', argumentsText: '{}' }] }),
    ])

    const stream = startStream({ sendTools: true })
    await settled()
    // The call waits for the job.
    expect(requests).toHaveLength(2)
    await sbp('dez.stream/stop', activeTab().id)
    await stream

    expect(callResult('c2')).toBe(stoppedToolResult('jobs_wait').content)
    expect(jobs[0].signal.aborted).toBe(false)
  })

  // With no calls to send back, the reply cannot go on, so it ends as a stop
  // does. The jobs that it carried from a stopped reply go on too.
  it('hands the jobs of a reply on to the next reply when the user deletes its running blocks', async () => {
    replyRounds([
      ...stoppedRounds(invokeCall('c1')),
      async (input) => ({ requestId: input.requestId as string, toolCalls: [{ ...geminiCall, id: 'c3' }] }),
      async (input) => ({ requestId: input.requestId as string, toolCalls: [{ id: 'c4', name: 'jobs_wait', argumentsText: '{}' }] }),
      async (input) => ({ requestId: input.requestId as string }),
    ])
    await startStream({ sendTools: true })
    const tabId = activeTab().id
    const started = jobId('c1')
    // The `model_list` call of the next reply reads the providers while its
    // block runs.
    providerInfos = async () => {
      sbp('dez.model/tabs/replaceSections', tabId, activeTab().sections.map((section) => section.id === 'a2' ? { ...section, content: [{ kind: 'text', text: '' }] } : section))
      return []
    }

    await nextReply('a2')

    expect(requests).toHaveLength(3)
    expect(sbp('dez.model/streams/isStreaming', tabId)).toBe(false)
    expect(jobs[0].signal.aborted).toBe(false)
    expect(alerts).toStrictEqual([])

    jobs[0].end({ media: [png], clips: [] })
    await settled()
    await nextReply('a3')

    expect(callResult('c4', 'a3')).toBe(jobsWaitText([{ id: started, tool: 'model_invoke', status: 'finished', text: 'Made the image @a.', call: { number: 1, label: PROMPT } }], 0))
    expect(sectionVisibleText(agentSection('a3'))).toContain(foxReference('c1'))
  })

  // A runner reads the providers before it starts its job, and the user
  // can stop the reply meanwhile.
  it('starts no job for a call of a reply that the user stopped before the job started', async () => {
    providerInfos = async () => {
      if (requests.length === 1) await sbp('dez.stream/stop', activeTab().id)
      return [providerInfo(model.providerId, 'Thinker')]
    }
    replyRounds([async (input) => ({ requestId: input.requestId as string, toolCalls: [invokeCall('c1')] })])

    await startStream({ sendTools: true })
    await settled()

    expect(jobs).toHaveLength(0)
    expect(callResult('c1')).toBe(STOPPED_TOOL_RESULT.content)
  })

  // A media reply runs no tool, so it takes no jobs and ends none.
  it('leaves the jobs of a stopped reply to the chat reply after a media reply', async () => {
    replyRounds([
      ...stoppedRounds(invokeCall('c1')),
      async (input) => ({ requestId: input.requestId as string, toolCalls: [{ id: 'c2', name: 'jobs_wait', argumentsText: '{}' }] }),
      async (input) => ({ requestId: input.requestId as string }),
    ])
    await startStream({ sendTools: true })

    const tabId = activeTab().id
    sbp('dez.model/tabs/replaceSections', tabId, [...activeTab().sections.slice(0, -1), { id: 'u2', role: 'user', content: [{ kind: 'text', text: 'Draw a hare.' }] }])
    sbp('dez.model/setActiveModel', model.providerId, 'painter', 'Painter')
    const media = sbp('dez.controller/submitTab', tabId) as Promise<void>
    await settled()
    expect(jobs).toHaveLength(2)
    jobs[1].end({ media: [png], clips: [] })
    await media
    expect(jobs[0].signal.aborted).toBe(false)

    jobs[0].end({ media: [png], clips: [] })
    await nextReply('a2')

    expect(callResult('c2', 'a2')).toBe(jobsWaitText([{ id: jobId('c1'), tool: 'model_invoke', status: 'finished', text: 'Made the image @b.', call: { number: 1, label: PROMPT } }], 0))
  })

  it('ends the jobs that a stopped reply left when the tab closes, and deletes what a job still makes', async () => {
    replyRounds(stoppedRounds(invokeCall('c1', FILMER)))
    await startStream({ sendTools: true })
    expect(jobs[0].signal.aborted).toBe(false)

    await sbp('dez.stream/stop', activeTab().id, { endJobs: true })

    expect(jobs[0].signal.aborted).toBe(true)
    // A request that does not end at the abort still gives its clip.
    jobs[0].end({ media: [], clips: [run] })
    await settled()
    expect(native.deletedFiles).toStrictEqual([{ root: 'cache', path: 'media/run.mp4', folder: false }])
    expect(toasts).toStrictEqual([])
  })

  // A job adds its price at its end, also when no reply runs. A job that a
  // close of the tab ends adds its quote.
  it('adds the price of each job to the cost of the conversation, and the quote of a job that a close of the tab ended', async () => {
    const heldRequest = generateMedia
    generateMedia = (input) => {
      input.onProgress?.({ phase: 'sent', jobId: null, quote: 0.5 })
      return heldRequest(input)
    }
    replyRounds([
      async (input) => ({ requestId: input.requestId as string, toolCalls: [invokeCall('c1'), invokeCall('c2', FILMER)] }),
      async (input) => {
        await input.onToken('I started them.')
        return { requestId: input.requestId as string }
      },
    ])

    const stream = startStream({ sendTools: true })
    await settled()
    jobs[0].end({ media: [png], clips: [], cost: 0.25 })
    await settled()
    await sbp('dez.stream/stop', activeTab().id)
    await stream
    expect(activeTab().cost).toStrictEqual({ usd: 0.25, requests: 3, unpriced: 2 })

    await sbp('dez.stream/stop', activeTab().id, { endJobs: true })
    await settled()

    const cost = { usd: 0.75, requests: 4, unpriced: 2 }
    expect(activeTab().cost).toStrictEqual(cost)
    expect(savedConversations.at(-1)?.cost).toStrictEqual(cost)
  })

  it('hands the jobs of a reply that a new submit in the tab ends to the new reply', async () => {
    const tabId = activeTab().id
    sbp('dez.model/setActiveModel', model.providerId, model.modelId, model.modelName)
    replyRounds([
      async (input) => ({ requestId: input.requestId as string, toolCalls: [invokeCall('c1')] }),
      async (input) => {
        await input.onToken('I started it.')
        await sbp('dez.controller/submitTab', tabId)
        throw new Error('cancelled')
      },
      async (input) => ({ requestId: input.requestId as string, toolCalls: [{ id: 'c2', name: 'jobs_wait', argumentsText: '{}' }] }),
      async (input) => {
        await input.onToken('Here it is.')
        return { requestId: input.requestId as string }
      },
    ])

    const stream = startStream({ sendTools: true })
    await settled()
    // The new reply waits for the job of the reply that the submit ended.
    expect(requests).toHaveLength(3)
    expect(jobs).toHaveLength(1)
    expect(jobs[0].signal.aborted).toBe(false)
    jobs[0].end({ media: [png], clips: [] })
    await stream

    const newReply = activeTab().sections.filter((section) => section.role === 'agent').at(-1) as Section
    expect(newReply.id).not.toBe('a1')
    expect(callResult('c2', newReply.id)).toBe(jobsWaitText([{ id: jobId('c1'), tool: 'model_invoke', status: 'finished', text: 'Made the image @a.', call: { number: 1, label: PROMPT } }], 0))
    expect(sectionVisibleText(agentSection(newReply.id))).toContain(foxReference('c1'))
    expect(toasts).toStrictEqual([])
  })

  it('keeps the open jobs of a reply over a compaction, so a jobs_wait call after it gets their results', async () => {
    let startedId = ''
    replyRounds([
      async (input) => ({ requestId: input.requestId as string, toolCalls: [invokeCall('c1')], usage: LARGE_USAGE }),
      async (input) => {
        // The compaction takes the block of the call out of the reply.
        startedId = jobId('c1')
        return await notesAnswer(input)
      },
      async (input) => ({ requestId: input.requestId as string, toolCalls: [{ id: 'c2', name: 'jobs_wait', argumentsText: '{}' }] }),
      async (input) => {
        await input.onToken('Here it is.')
        return { requestId: input.requestId as string }
      },
    ])

    const stream = startStream({ sendTools: true })
    await settled()
    // The call after the compaction waits for the job.
    expect(requests.map(isCompactionRequest)).toStrictEqual([false, true, false])
    expect(jobs[0].signal.aborted).toBe(false)
    jobs[0].end({ media: [png], clips: [] })
    await stream

    expect(callResult('c1')).toBe('')
    expect(callResult('c2')).toBe(jobsWaitText([{ id: startedId, tool: 'model_invoke', status: 'finished', text: 'Made the image @a.', call: { number: 1, label: PROMPT } }], 0))
    expect(sectionVisibleText(agentSection())).toContain(`![id=a|tool=model_invoke|made-by=${startedId}](${fox})`)
    // The notes tell the model of the job that still ran.
    expect(sectionVisibleText(activeTab().sections[0])).toContain(startedId)
    expect(toasts).toStrictEqual([])
  })
})

describe('dez.stream/start compaction', () => {
  const text = (value: string) => ({ kind: 'text' as const, text: value })
  const failure = new ExplainedError('Dez could not reach Thinker.', 'connection reset')

  // A round of the reply that calls a tool. Its tokens make the next
  // request due for a compaction.
  async function largeRound(input: ProviderStreamChatInput): Promise<ProviderStreamChatResult> {
    input.onSent?.()
    await input.onToken('Checking.')
    return { requestId: input.requestId as string, toolCalls: [geminiCall], usage: LARGE_USAGE, cost: 0.25 }
  }

  // The round that ends the reply.
  async function lastRound(input: ProviderStreamChatInput): Promise<ProviderStreamChatResult> {
    input.onSent?.()
    await input.onToken('None.')
    return { requestId: input.requestId as string, cost: 0.25 }
  }

  // A request that went, and that the provider did not answer.
  async function failedRequest(input: ProviderStreamChatInput): Promise<ProviderStreamChatResult> {
    input.onSent?.()
    throw failure
  }

  // Puts a conversation with one reply and a new message in the tab, with
  // a counted context that is over the threshold of the model `m`, and
  // makes `active` the model of the next reply.
  function setLargeConversation(active: ActiveModel = model): void {
    sbp('dez.model/setActiveModel', active.providerId, active.modelId, active.modelName)
    setConversation([{ text: 'Hi' }, { text: 'An earlier answer.' }, { text: 'More' }])
    sbp('dez.model/tabs/countRequestContext', activeTab().id, model, 140_000)
  }
  const largeConversationTexts = [{ role: 'user', text: 'Hi' }, { role: 'agent', text: 'An earlier answer.' }, { role: 'user', text: 'More' }]
  // The text after the block of the compaction section, and the end of the
  // block in its text.
  const replyText = () => sectionTextParts(activeTab().sections[0], 0).text
  const blockEnd = () => sectionCompactionBlock(activeTab().sections[0])!.to

  it('asks the model of the reply for notes between two rounds, and goes on from the notes in the same reply', async () => {
    const tabId = activeTab().id
    const replay = { kind: 'field', field: 'reasoning_content' } as const
    const compacting: boolean[] = []
    replyRounds([
      async (input) => {
        await input.onThinking('Look.')
        return await largeRound(input)
      },
      async (input) => {
        compacting.push(sbp('dez.model/streams/isCompacting', tabId) as boolean)
        return await notesAnswer(input)
      },
      async (input) => {
        compacting.push(sbp('dez.model/streams/isCompacting', tabId) as boolean)
        await input.onThinking('Found.')
        return { ...await lastRound(input), thinkingReplay: replay }
      },
    ])

    await startStream({ sendTools: true })

    // The compaction request is the request that was due, with the
    // instruction of Dez after it, so it reads the prompt cache of the
    // reply.
    expect(requests.map(isCompactionRequest)).toStrictEqual([false, true, false])
    expect(sent[1].slice(0, -1)).toStrictEqual([
      { role: 'user', content: 'Hi' },
      { role: 'agent', content: 'Checking.', toolCalls: [{ id: 'c1', name: 'model_list', arguments: { filter: 'gemini' } }] },
      { role: 'tool', results: [{ callId: 'c1', content: NO_MODELS_TEXT, isError: false }] },
    ])
    expect(requests[1].system).toBe(requests[0].system)
    expect(requests[1].tools).toStrictEqual(requests[0].tools)
    expect(compacting).toStrictEqual([true, false])

    // The request after it holds the notes, with the message of the user
    // in them, and nothing of the rounds before.
    expect(sent[2].map((message) => message.role)).toStrictEqual(['user'])
    const next = JSON.stringify(sent[2])
    expect(next).toContain(NOTES_REQUIREMENTS)
    expect(next).toContain('Hi')
    expect(next).not.toContain('Checking.')

    // The reply goes on in its own section, after the block, on a line of
    // its own. No section of the user stays: its message is in the notes.
    const [first, ...rest] = activeTab().sections
    expect(first.id).toBe('a1')
    expect(sectionCompactionBlock(first)?.count).toBe(1)
    expect(first.model).toMatchObject({ providerId: model.providerId, modelId: model.modelId })
    expect(sectionVisibleText(first).slice(blockEnd())).toBe('\nNone.')
    expect(rest.map((section) => ({ role: section.role, text: sectionVisibleText(section) }))).toStrictEqual([{ role: 'user', text: '' }])
    // The thinking of the rounds before went with their text.
    expect(agentSection().thinking).toStrictEqual({ text: 'Found.', replay })
    expect(agentSection().durationMs).toEqual(expect.any(Number))
    expect(activeTab().compactions).toMatchObject({ count: 1, tokens: COMPACTION_USAGE.inputTokens })
    expect(activeTab().cost).toStrictEqual({ usd: 1, requests: 3, unpriced: 0 })
    expect(editorRebuilds).toStrictEqual([tabId])
    // A save at the swap, before the delete of the files that the
    // compaction left, and the save at the end of the reply.
    expect(savedConversations.map((data) => data.sections.map((section) => section.role))).toStrictEqual([
      ['agent'],
      ['agent', 'user'],
    ])
    expect(savedConversations[0].compactions?.count).toBe(1)
    expect(leftFiles).toStrictEqual([{ sources: [], pictures: [] }])
    expect(toasts).toStrictEqual([])
  })

  // A request in the reply sends the compaction message of the block, then
  // the rounds of the reply after the block. The second compaction reads
  // the first one in the reply's own section, and takes its place. The
  // first count after a compaction sets the size that it left, so a small
  // round comes first, and the large round after it makes the next request
  // due.
  it('sends the rounds after the block after the compaction message, and compacts the same reply again', async () => {
    const tabId = activeTab().id
    const listCall = (id: string) => ({ id, name: 'model_list', arguments: { filter: 'gemini' } })
    const listResult = (callId: string) => ({ role: 'tool', results: [{ callId, content: NO_MODELS_TEXT, isError: false }] })
    replyRounds([
      largeRound,
      notesAnswer,
      async (input) => {
        input.onSent?.()
        await input.onToken('Small.')
        return { requestId: input.requestId as string, toolCalls: [{ ...geminiCall, id: 'c2' }], usage: { inputTokens: 20_000, outputTokens: 10 } }
      },
      largeRound,
      notesAnswer,
      lastRound,
    ])

    await startStream({ sendTools: true })

    expect(requests.map(isCompactionRequest)).toStrictEqual([false, true, false, false, true, false])
    const [compactionMessage] = sent[2]
    expect(sent[2]).toStrictEqual([compactionMessage])
    expect(compactionMessage.role).toBe('user')
    // The same bytes, then the rounds after the block.
    const small = [{ role: 'agent', content: 'Small.', toolCalls: [listCall('c2')] }, listResult('c2')]
    expect(sent[3]).toStrictEqual([compactionMessage, ...small])
    expect(sent[4].slice(0, -1)).toStrictEqual([
      compactionMessage,
      ...small,
      { role: 'agent', content: 'Checking.', toolCalls: [listCall('c1')] },
      listResult('c1'),
    ])
    expect(sent[5]).toHaveLength(1)
    expect(sent[5][0]).not.toStrictEqual(compactionMessage)

    expect(activeTab().sections.map(({ id, role }) => [id, role])).toStrictEqual([['a1', 'agent'], [expect.any(String), 'user']])
    expect(sectionCompactionBlock(activeTab().sections[0])?.count).toBe(2)
    expect(replyText()).toBe('None.')
    expect(editorRebuilds).toStrictEqual([tabId, tabId])
    expect(toasts).toStrictEqual([])
  })

  it('writes an image of the round right after the compaction on the line after the block', async () => {
    saveImage = async () => generated('g1.png')
    replyRounds([
      largeRound,
      notesAnswer,
      async (input) => {
        await input.onImage(png)
        await input.onToken('Here.')
        return { requestId: input.requestId as string }
      },
    ])

    await startStream({ sendTools: true })

    expect(sectionVisibleText(activeTab().sections[0]).slice(blockEnd())).toBe(`\n![id=a](${generated('g1.png')})\n\nHere.`)
  })

  // The notes hold the message of the user, so the section stays, and the
  // next message needs a user section.
  it('keeps the block, with no line after it, and adds a user section when the user stops the reply right after the compaction', async () => {
    const tabId = activeTab().id
    replyRounds([
      largeRound,
      notesAnswer,
      async (input) => {
        await input.onThinking('Look.')
        await sbp('dez.stream/stop', tabId)
        return { requestId: input.requestId as string }
      },
    ])

    await startStream({ sendTools: true })

    const [first] = activeTab().sections
    expect(sectionVisibleText(first)).toHaveLength(blockEnd())
    expect(first.thinking).toBeUndefined()
    expect(first.durationMs).toBeUndefined()
    expect(sectionTexts().slice(1)).toStrictEqual([{ role: 'user', text: '' }])
    expect(sbp('dez.model/streams/isStreaming', tabId)).toBe(false)
  })

  it('compacts a conversation that is too large before the first request of a new reply', async () => {
    setLargeConversation()
    replyRounds([notesAnswer, lastRound])

    await sbp('dez.controller/submitTab', activeTab().id)

    expect(requests.map(isCompactionRequest)).toStrictEqual([true, false])
    expect(sent[0].slice(0, -1)).toStrictEqual([
      { role: 'user', content: 'Hi' },
      { role: 'agent', content: 'An earlier answer.' },
      { role: 'user', content: 'More' },
    ])
    // The first and the final message of the user stay word for word, in
    // the notes.
    expect(sent[1].map((message) => message.role)).toStrictEqual(['user'])
    const next = JSON.stringify(sent[1])
    for (const kept of [NOTES_REQUIREMENTS, 'Hi', 'More']) expect(next).toContain(kept)
    expect(next).not.toContain('An earlier answer.')
    expect(sectionCompactionBlock(activeTab().sections[0])?.count).toBe(1)
    expect(replyText()).toBe('None.')
    expect(sectionTexts().slice(1)).toStrictEqual([{ role: 'user', text: '' }])
    const parts = notesMessages(sectionCompactionBlock(activeTab().sections[0])!.notes).map(({ text }) => text)
    expect(parts).toStrictEqual(['Hi', 'More'])
    expect(toasts).toStrictEqual([])
  })

  // The messages of the user between the first and the final one: the
  // model keeps or drops each one.
  it('lists the middle messages in the instruction, and quotes in the notes only the ones that the answer keeps', async () => {
    sbp('dez.model/setActiveModel', model.providerId, model.modelId, model.modelName)
    sbp('dez.model/tabs/replaceSections', activeTab().id, [
      { id: 'u1', role: 'user', content: [text('Hi')] },
      { id: 'r1', role: 'agent', content: [text('Hello.')], model },
      { id: 'u2', role: 'user', content: [text('Always answer in French.')] },
      { id: 'r2', role: 'agent', content: [text('Oui.')], model },
      { id: 'u3', role: 'user', content: [text('Thanks!')] },
      { id: 'r3', role: 'agent', content: [text('De rien.')], model },
      { id: 'u4', role: 'user', content: [text('More')] },
    ])
    sbp('dez.model/tabs/countRequestContext', activeTab().id, model, 140_000)
    replyRounds([
      (input) => notesAnswer(input, `## Requirements and decisions\n${NOTES_REQUIREMENTS}\n\n## Middle messages\nm1: keep\nm2: drop\n`),
      lastRound,
    ])

    await sbp('dez.controller/submitTab', activeTab().id)

    expect(requests.map(isCompactionRequest)).toStrictEqual([true, false])
    const instruction = requests[0].messages.at(-1)
    expect(instruction?.role === 'user' ? instruction.content : '').toContain('m1: "Always answer in French."\nm2: "Thanks!"')
    const notes = sectionCompactionBlock(activeTab().sections[0])!.notes
    expect(notesMessages(notes).map(({ text }) => text)).toStrictEqual(['Hi', 'Always answer in French.', 'More'])
    expect(notesLeftOutMessages(notes)).toBe(1)
    // The next request holds the kept message, and not the dropped one.
    const next = JSON.stringify(sent[1])
    expect(next).toContain('Always answer in French.')
    expect(next).not.toContain('Thanks!')
    expect(toasts).toStrictEqual([])
  })

  it('sends a first message with no compaction, however large the counted context is', async () => {
    sbp('dez.model/tabs/countRequestContext', activeTab().id, model, 190_000)
    replyRounds([lastRound])

    await startStream()

    expect(requests.map(isCompactionRequest)).toStrictEqual([false])
    expect(activeTab().compactions).toBeUndefined()
  })

  // A tool round of the reply with no count of the provider: the context
  // size is Dez's estimate.
  async function uncountedToolRound(input: ProviderStreamChatInput): Promise<ProviderStreamChatResult> {
    return { ...await largeRound(input), usage: undefined }
  }

  // The newest message stays word for word, so the conversation is still
  // over the threshold after the compaction, and also after the next round
  // of the reply. A compaction before that next round would take nothing
  // out.
  it.each([
    ['counted', largeRound],
    ['did not count', uncountedToolRound],
  ])('compacts one time only for a newest message that alone is over the threshold, with a tool round that the provider %s', async (_counted, toolRound) => {
    sbp('dez.model/tabs/replaceSections', activeTab().id, [
      { id: 'u1', role: 'user', content: [text('Hi')] },
      { id: 'r1', role: 'agent', content: [text('An earlier answer.')], model },
      { id: 'u2', role: 'user', content: [text('word '.repeat(80_000))] },
      { id: 'a1', role: 'agent', content: [text('')], model },
    ])
    replyRounds([notesAnswer, toolRound, lastRound])

    await startStream({ sendTools: true })

    expect(requests.map(isCompactionRequest)).toStrictEqual([true, false, false])
    expect(activeTab().compactions?.count).toBe(1)
    expect(sectionVisibleText(agentSection())).toContain('None.')
    expect(toasts).toStrictEqual([])
  })

  it('sends a failed compaction request one more time, with no toast when that request passes', async () => {
    replyRounds([largeRound, failedRequest, notesAnswer, lastRound])

    await startStream({ sendTools: true })

    expect(requests.map(isCompactionRequest)).toStrictEqual([false, true, true, false])
    expect(requests[2].requestId).not.toBe(requests[1].requestId)
    expect(activeTab().compactions?.count).toBe(1)
    expect(replyText()).toBe('None.')
    expect(toasts).toStrictEqual([])
    expect(consoleError).toHaveBeenCalled()
  })

  it('ends the reply with an error toast after two failed compaction requests, and leaves the conversation as it was', async () => {
    const tabId = activeTab().id
    replyRounds([largeRound, failedRequest, failedRequest])

    await startStream({ sendTools: true })

    expect(requests.map(isCompactionRequest)).toStrictEqual([false, true, true])
    expect(toasts).toHaveLength(1)
    expect(toasts[0]).toMatchObject({ area: 'app-global', data: { variant: 'error', title: 'Compaction failed' } })
    expect(toasts[0].data.message).toContain(failure.explanation)
    expect(toasts[0].data.message).toContain(failure.details)
    expect(consoleError).toHaveBeenCalled()
    // The reply keeps what it wrote.
    expect(sectionTexts().map((section) => section.role)).toStrictEqual(['user', 'agent', 'user'])
    const reply = sectionVisibleText(agentSection())
    expect(reply.startsWith('Checking.')).toBe(true)
    expect(findToolBlocks(reply).map(({ id, status, result }) => ({ id, status, result }))).toStrictEqual([{ id: 'c1', status: 'success', result: NO_MODELS_TEXT }])
    expect(activeTab().compactions).toBeUndefined()
    expect(editorRebuilds).toStrictEqual([])
    expect(leftFiles).toStrictEqual([])
    expect(sbp('dez.model/streams/isStreaming', tabId)).toBe(false)
  })

  it('leaves the tab as it was before the submit when the compaction for the new reply fails', async () => {
    setLargeConversation()
    replyRounds([failedRequest, failedRequest])

    await sbp('dez.controller/submitTab', activeTab().id)

    expect(requests).toHaveLength(2)
    expect(toasts.map((toast) => toast.data.title)).toStrictEqual(['Compaction failed'])
    expect(sectionTexts()).toStrictEqual(largeConversationTexts)
    expect(activeTab().compactions).toBeUndefined()
  })

  it('takes a stop during the compaction request as a stop of the reply, with no second request, no toast, and no change of the conversation', async () => {
    const tabId = activeTab().id
    replyRounds([
      largeRound,
      async (input) => {
        await sbp('dez.stream/stop', tabId)
        // The answer can still come whole.
        return await notesAnswer(input)
      },
    ])

    await startStream({ sendTools: true })

    expect(requests).toHaveLength(2)
    expect(toasts).toStrictEqual([])
    expect(activeTab().compactions).toBeUndefined()
    expect(editorRebuilds).toStrictEqual([])
    expect(sectionVisibleText(agentSection()).startsWith('Checking.')).toBe(true)
    expect(sbp('dez.model/streams/isStreaming', tabId)).toBe(false)
  })

  // A second compaction: the tag of the compaction before has a picture,
  // which the new tag does not carry.
  it('gives the files that the compaction left with no text to the delete: a dropped intermediate image, and the pictures of the tag before', async () => {
    const oldPicture = { file: 'old-sheet.jpg', label: 'A frame sheet.', width: 800, height: 200, bytes: 3000 }
    const oldNotes = compactionNotesText(notesData({
      assets: [{ id: 'b', kind: 'image', facts: 'PNG, 1024x768, 1.2 MB', origin: 'made by the model_invoke job 1 of its reply: "A fox"', sentence: 'A draft of the fox.', byReply: false, text: hiddenImage('j-aaaa', 'b') }],
    }))
    sbp('dez.model/tabs/replaceSections', activeTab().id, [
      { id: 'n', role: 'agent', content: [text(`${compactionTagText({ count: 1, lastId: 'b', pictures: [oldPicture] })}\n${oldNotes}`)], model },
      { id: 'u1', role: 'user', content: [text('Make a fox.')] },
      { id: 'r1', role: 'agent', content: [text('The fox is done.')], model },
      { id: 'u2', role: 'user', content: [text('Now a wolf.')] },
      { id: 'a1', role: 'agent', content: [text('')], model },
    ])
    sbp('dez.model/tabs/countRequestContext', activeTab().id, model, 140_000)
    replyRounds([
      (input) => notesAnswer(input, '## Summary\nThe fox is done, and a wolf is next.\n\n## Assets\n@b: drop - The wolf needs no fox draft.\n'),
      lastRound,
    ])

    await startStream()

    const notes = activeTab().sections[0]
    expect(sectionCompactionBlock(notes)?.count).toBe(2)
    expect(sectionVisibleText(notes)).not.toContain(HIDDEN_IMAGE_PATH)
    expect(leftFiles).toStrictEqual([{ sources: [HIDDEN_IMAGE_PATH], pictures: [oldPicture.file] }])
  })

  // A toast at the submit would be false: the compaction keeps each image
  // that is over what it leaves as its text, with the kept mark. It leaves
  // at most half of the image limit as parts.
  it('tells the user of no image over the image limit of the model when a compaction before the first request leaves none', async () => {
    sbp('dez.model/modelCache/applyProviderResult', model.providerId, {
      ok: true,
      models: [{ id: model.modelId, name: model.modelName, provider: model.providerId, imageLimit: 4 }],
    })
    sbp('dez.model/setActiveModel', model.providerId, model.modelId, model.modelName)
    sbp('dez.model/tabs/replaceSections', activeTab().id, [
      {
        id: 'u1',
        role: 'user',
        content: [text(['one.png', 'two.jpg', 'three.webp', 'four.png', 'five.png'].map((name, n) => `![id=${'abcde'[n]}](${image(name)})`).join(' '))],
      },
      { id: 'r1', role: 'agent', content: [text('Five foxes.')], model },
      { id: 'u2', role: 'user', content: [text('More')] },
    ])
    sbp('dez.model/tabs/countRequestContext', activeTab().id, model, 140_000)
    expect((sbp('dez.model/streamMessagesForTab', activeTab().id, model) as RequestMessages).imagesOverLimit).toBe(1)
    replyRounds([notesAnswer, lastRound])

    await sbp('dez.controller/submitTab', activeTab().id)

    expect(requests.map(isCompactionRequest)).toStrictEqual([true, false])
    expect(toasts).toStrictEqual([])
    expect(sent[1].map((message) => message.role)).toStrictEqual(['user'])
    const [first] = sent[1]
    const parts = first.role === 'user' && Array.isArray(first.content) ? first.content : []
    expect(parts.flatMap((part) => (part.type === 'image' ? [part.path] : []))).toStrictEqual([image('one.png'), image('two.jpg')])
    expect(JSON.stringify(parts)).toContain('![id=c|kept=compaction](image)')
    expect(JSON.stringify(parts)).toContain('![id=e|kept=compaction](image)')
  })

  describe('for a new reply of a model whose window is smaller than the conversation', () => {
    const small: ActiveModel = { providerId: model.providerId, modelId: 'small', modelName: 'Small' }

    beforeEach(() => {
      sbp('dez.model/modelCache/applyProviderResult', model.providerId, {
        ok: true,
        models: [
          { id: model.modelId, name: model.modelName, provider: model.providerId },
          { id: small.modelId, name: small.modelName, provider: model.providerId, contextWindow: 100_000 },
        ],
      })
    })

    it('asks the model of the newest reply for the notes, with the system prompt of that model', async () => {
      sbp('dez.model/settings/setSystemPrompt', 'You are {{model_id}}.')
      setLargeConversation(small)
      replyRounds([notesAnswer, lastRound])

      await sbp('dez.controller/submitTab', activeTab().id)

      expect(requests.map((input) => ({ modelId: input.modelId, system: input.system, compaction: isCompactionRequest(input) }))).toStrictEqual([
        { modelId: model.modelId, system: 'You are m.', compaction: true },
        { modelId: small.modelId, system: 'You are small.', compaction: false },
      ])
      // The section is the one of the reply, with its model.
      expect(activeTab().sections[0].model).toMatchObject({ providerId: small.providerId, modelId: small.modelId })
      expect(toasts).toStrictEqual([])
    })

    it('sends no request when Dez cannot ask the model of the newest reply, and names both models in the error toast', async () => {
      setLargeConversation(small)
      const [u1, , u2] = activeTab().sections
      sbp('dez.model/tabs/replaceSections', activeTab().id, [
        u1,
        { id: 'a1', role: 'agent', content: [text('An earlier answer.')], model: { providerId: 'gone', modelId: 'old-model' } },
        u2,
      ])
      replyRounds([])

      await sbp('dez.controller/submitTab', activeTab().id)

      expect(requests).toStrictEqual([])
      expect(toasts.map((toast) => toast.data.title)).toStrictEqual(['Compaction failed'])
      expect(toasts[0].data.message).toContain(small.modelName)
      expect(toasts[0].data.message).toContain('old-model')
      expect(consoleError).toHaveBeenCalled()
      expect(sectionTexts()).toStrictEqual(largeConversationTexts)
      expect(activeTab().compactions).toBeUndefined()
    })
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
