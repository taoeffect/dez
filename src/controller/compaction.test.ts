import sbp from '@sbp/sbp'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { sectionCompactionTag } from '../model/chat/compaction'
import { notesAssetLines, notesJobLines } from '../model/chat/compactionNotes'
import { sectionPlainText } from '../model/chat/content'
import { withRequestCost, type ConversationCost } from '../model/chat/conversationCost'
import type { ImageDrawing, ImageSize } from '../model/chat/imageDrawing'
import { findMediaTags, isKeptClip, mediaTagText } from '../model/chat/mediaTags'
import { SHOWN_PICTURE_FOLDER } from '../model/chat/shownPictures'
import { idImage, invokeBlock, jpegHeader } from '../model/chat/testing'
import type { Section } from '../model/chat/types'
import type { ChatUsage } from '../model/providers/chatUsage'
import type { ProviderStreamChatInput, ProviderStreamChatResult } from '../model/providers/streamTypes'
import type { StreamMessage } from '../model/streams/types'
import { model, reply, user } from '../model/streams/testing'
import { probeOutput } from '../model/tools/testing'
import type { ToolDefinition } from '../model/tools/types'
import { ExplainedError } from '../utils/errorText'
import { compactConversation, NO_COMPACTION_NOTES_TEXT, type Compaction, type CompactionInput } from './compaction'
import type { RequestLogRow } from './diagnostics/requestLog'
import { APP_DIR, CACHE_DIR, CLIP_FORMAT, ENDED, failureOf, FILE_ID, H264_STREAM, native, resetNative, showinfoLog, STOP } from './testing'
// Side-effect import: registers the dez.model/* selectors.
import '../model/state/index'

const FOX = `${APP_DIR}/assets/images/fox.png`
const DRAFT = `${APP_DIR}/assets/generated/images/draft.png`
const SCENE = `${APP_DIR}/assets/generated/video/scene.mp4`
const SCENE_TAG = mediaTagText({ kind: 'video', id: 'c', type: 'video/mp4', src: SCENE, url: null, expires: null, other: [] })

/** A conversation with the image `a` of the user, and the image `b` and
 *  the video clip `c` that the model made, in a reply (`r`) that runs. */
const SECTIONS: Section[] = [
  user('u1', `Make a fox film like ${idImage(FOX, 'a')}`),
  reply('r1', `A draft:\n${idImage(DRAFT, 'b')}\n${SCENE_TAG}`),
  user('u2', 'Make it longer.'),
  reply('r', 'I look at the film first.'),
]
const MESSAGES: StreamMessage[] = [{ role: 'user', content: 'Make a fox film.' }, { role: 'agent', content: 'A draft.' }]
const TOOLS: ToolDefinition[] = [{ name: 'model_list', description: 'Lists the models.', parameters: [] }]
const NOTES = '## Summary\nThe user wants a fox film.\n\n## Next steps\nMake the film longer.'
const USAGE: ChatUsage = { inputTokens: 900, outputTokens: 50 }
// The frame sheet that ffmpeg makes of the clip `c`.
const SHEET_JPEG = jpegHeader(968, 364)
const SHEET_FILE = new RegExp(`^${SHOWN_PICTURE_FOLDER}/${FILE_ID.source}\\.jpg$`)

// The stub chat API: each request, and what the provider does with one (it
// calls the callbacks of the request, as the answer comes). The stub image
// store: the paths of the files that were read. Set in beforeEach and by
// the tests.
let chatRequests: ProviderStreamChatInput[] = []
let streamChat: (input: ProviderStreamChatInput) => Promise<Pick<ProviderStreamChatResult, 'cost' | 'usage'> | void>
let readImages: string[] = []

sbp('sbp/selectors/register', {
  async 'dez.provider/streamChat' (input: ProviderStreamChatInput): Promise<ProviderStreamChatResult> {
    chatRequests.push(input)
    return { requestId: input.requestId ?? '', ...await streamChat(input) ?? {} }
  },
  async 'dez.controller/images/readFile' (path: string): Promise<Blob> {
    readImages.push(path)
    return new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' })
  },
  // Every image is 1000 by 500 pixels.
  async 'dez.controller/images/redraw' (_file: Blob, plan: (size: ImageSize) => ImageDrawing | null): Promise<null> {
    plan({ width: 1000, height: 500 })
    return null
  },
})

// A provider that writes `text` as its answer.
const answers = (text: string) => async (input: ProviderStreamChatInput) => {
  input.onSent?.()
  input.onToken(text)
  return { cost: 0.25, usage: USAGE }
}

let consoleError: MockInstance<typeof console.error>
let tabId: string
// The cost of the tab, and each price that the compaction counted.
let cost: ConversationCost | undefined
let counted: (number | null)[]

function compactionInput(input: Partial<CompactionInput> = {}): CompactionInput {
  return {
    tabId,
    conversationId: 'conversation',
    sections: SECTIONS,
    replySectionId: 'r',
    model,
    messages: MESSAGES,
    system: 'You are Dez.',
    tools: TOOLS,
    imageOutput: false,
    audioOutput: false,
    providerSettings: { webSearch: false },
    requestId: 'request',
    signal: new AbortController().signal,
    jobs: [],
    cost: () => cost,
    countCost: (usd) => {
      counted.push(usd)
      cost = withRequestCost(cost, usd)
    },
    ...input,
  }
}

// The instruction of the compaction request `index`: its last message.
function instruction(index = 0): string {
  const message = chatRequests[index].messages.at(-1)
  return message?.role === 'user' && typeof message.content === 'string' ? message.content : ''
}

const notesOf = (compaction: Compaction) => sectionPlainText(compaction.sections[0])
const logRows = () => (sbp('dez.diagnostics/requestLog') as RequestLogRow[]).filter((row) => row.tabId === tabId)
const programRuns = (tool: string) => native.runs.filter(({ run }) => run.tool === tool)
const savedPictures = () => native.savedFiles.filter(({ file }) => file.path.startsWith(`${SHOWN_PICTURE_FOLDER}/`))

beforeEach(() => {
  setActivePinia(createPinia())
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
  resetNative()
  tabId = crypto.randomUUID()
  cost = { usd: 1, requests: 4, unpriced: 0 }
  counted = []
  chatRequests = []
  streamChat = answers(NOTES)
  readImages = []
  // The probe of the clip, then the frame sheet of three frames.
  native.program = async (run, onOutput) => {
    if (run.tool === 'dez-ffprobe') {
      onOutput({ stream: 'stdout', text: probeOutput([H264_STREAM], CLIP_FORMAT) })
      return ENDED
    }
    onOutput({ stream: 'stderr', text: showinfoLog([0.4167, 1.25, 2.0833]) })
    return ENDED
  }
  native.fileBytes = () => SHEET_JPEG
})

afterEach(() => {
  consoleError.mockRestore()
})

describe('compactConversation', () => {
  it('asks the model of the reply for the notes in one more user message, with the system prompt, the tools, and the settings of the next request', async () => {
    const signal = new AbortController().signal

    await compactConversation(compactionInput({ signal }))

    expect(chatRequests).toHaveLength(1)
    expect(chatRequests[0]).toMatchObject({
      providerId: model.providerId,
      modelId: model.modelId,
      conversationId: 'conversation',
      system: 'You are Dez.',
      tools: TOOLS,
      imageOutput: false,
      audioOutput: false,
      providerSettings: { webSearch: false },
      requestId: 'request',
      signal,
      messages: [...MESSAGES, { role: 'user', content: expect.any(String) }],
    })
  })

  it('tells the model the facts that it read of the file of each asset, and the cost before the request', async () => {
    await compactConversation(compactionInput())

    const lines = instruction().split('\n')
    expect(lines.find((line) => line.startsWith('@a '))).toContain('1000x500')
    expect(lines.find((line) => line.startsWith('@b '))).toContain('1000x500')
    expect(lines.find((line) => line.startsWith('@c '))).toContain('854x480')
    expect(instruction()).toContain('for 4 requests')
    // No path of a stored file goes to the provider.
    expect(instruction()).not.toContain(APP_DIR)
  })

  it('gives the notes, the messages of the user that stay, and the empty reply as the new sections', async () => {
    const compaction = await compactConversation(compactionInput())

    expect(compaction.sections.map(({ id, role }) => ({ id, role }))).toStrictEqual([
      { id: expect.any(String), role: 'agent' },
      { id: 'u1', role: 'user' },
      { id: 'u2', role: 'user' },
      { id: 'r', role: 'agent' },
    ])
    expect(sectionCompactionTag(compaction.sections[0])).toMatchObject({ count: 1, lastId: 'c', pictures: [] })
    expect(compaction.sections[0].model).toStrictEqual(model)
    expect(notesOf(compaction)).toContain('The user wants a fox film.')
    expect(notesOf(compaction)).toContain('Make the film longer.')
    expect([...notesAssetLines(notesOf(compaction)).keys()]).toStrictEqual(['a', 'b', 'c'])
    expect(compaction.sections.slice(1, 3)).toStrictEqual([SECTIONS[0], SECTIONS[2]])
    expect(compaction.sections[3]).toStrictEqual(reply('r', ''))
    expect(compaction.dropped).toStrictEqual([])
    expect(compaction.usage).toStrictEqual(USAGE)
  })

  it('counts the price of the request once, logs it as a compaction request, and writes the cost with it into the notes', async () => {
    const compaction = await compactConversation(compactionInput())

    expect(counted).toStrictEqual([0.25])
    expect(logRows()).toMatchObject([{ kind: 'compaction', providerId: model.providerId, modelId: model.modelId, cost: 0.25, outputTokens: 50, imageCount: 0 }])
    expect(notesOf(compaction)).toContain('for 5 requests')
  })

  it('takes an asset out of the conversation that the answer drops, and keeps as text the ones that it keeps', async () => {
    streamChat = answers(`${NOTES}\n\n## Assets\n@b: drop - An old draft.\n@c: keep - The first film.`)

    const compaction = await compactConversation(compactionInput())

    expect(compaction.dropped.map(({ asset }) => asset.id)).toStrictEqual(['b'])
    expect([...notesAssetLines(notesOf(compaction)).keys()]).toStrictEqual(['a', 'c'])
    expect(notesOf(compaction)).not.toContain(DRAFT)
    expect(findMediaTags(notesOf(compaction)).map((tag) => ({ id: tag.id, kept: isKeptClip(tag) }))).toStrictEqual([{ id: 'c', kept: true }])
    expect(sectionCompactionTag(compaction.sections[0])).toMatchObject({ count: 1, dropped: 1 })
  })

  it('drops a made asset of an earlier reply that the answer has no line for, but not one that an open job of the reply uses', async () => {
    const job = { id: 'j-aaaa', tool: 'model_invoke', status: 'running', delivered: false, elapsedMs: 0, state: '', call: { number: 1, label: 'Make @c longer' } } as const
    const started = invokeBlock(job.id, { prompt: 'Make @c longer', intermediate: false, inputs: [{ id: 'c', kind: 'video' }] })
    const sections = [...SECTIONS.slice(0, 3), reply('r', `I make the film longer.\n\n${started}`)]
    streamChat = answers(`${NOTES}\n\n## Assets\n@a: keep - The photo of the user.`)

    const compaction = await compactConversation(compactionInput({ sections, jobs: [job] }))

    expect(instruction().split('\n').find((line) => line.startsWith('@c '))).toMatch(/ \| open job$/)
    expect(compaction.dropped.map(({ asset }) => asset.id)).toStrictEqual(['b'])
    expect([...notesAssetLines(notesOf(compaction)).keys()]).toStrictEqual(['a', 'c'])
    // The next compaction of the reply reads the inputs of the job here:
    // the block that started it is gone.
    expect(notesJobLines(notesOf(compaction)).get(job.id)?.inputs).toStrictEqual(['c'])
  })

  it('reads no file for the facts of an asset that the notes of the compaction before tell', async () => {
    const first = await compactConversation(compactionInput())
    const NEW = `${APP_DIR}/assets/generated/images/new.png`
    const sections = [...first.sections.slice(0, 3), reply('r', `A new draft:\n${idImage(NEW, 'd')}`), user('u3', 'And now?'), reply('r2', '')]
    readImages = []
    native.runs = []

    await compactConversation(compactionInput({ sections, replySectionId: 'r2' }))

    expect(readImages).toStrictEqual([NEW])
    expect(programRuns('dez-ffprobe')).toStrictEqual([])
    const lines = instruction(1).split('\n')
    expect(lines.find((line) => line.startsWith('@c '))).toContain('854x480')
    expect(lines.find((line) => line.startsWith('@d '))).toContain('1000x500')
  })

  it('keeps an asset whose file Dez cannot read, with a text in place of its facts', async () => {
    native.program = async () => { throw new Error('No such program.') }

    const compaction = await compactConversation(compactionInput())

    expect([...notesAssetLines(notesOf(compaction)).keys()]).toStrictEqual(['a', 'b', 'c'])
    expect(notesAssetLines(notesOf(compaction)).get('c')?.facts).not.toContain('854x480')
  })

  describe('the picture of a clip that the answer shows', () => {
    const SHOW = `${NOTES}\n\n## Assets\n@c: show - The first film.`

    it('is saved as a copy that the compaction tag names, and the tag of the clip has no kept mark', async () => {
      streamChat = answers(SHOW)

      const compaction = await compactConversation(compactionInput())

      const saved = savedPictures()
      expect(saved).toHaveLength(1)
      expect(saved[0].file.path).toMatch(SHEET_FILE)
      expect(saved[0].content).toStrictEqual(SHEET_JPEG)
      const pictures = [{ file: saved[0].file.path.slice(SHOWN_PICTURE_FOLDER.length + 1), label: expect.stringMatching(/^The frame sheet of the video clip @c.*\.$/), width: 968, height: 364, bytes: SHEET_JPEG.length }]
      expect(compaction.pictures).toStrictEqual(pictures)
      expect(sectionCompactionTag(compaction.sections[0])?.pictures).toStrictEqual(pictures)
      expect(findMediaTags(notesOf(compaction)).map((tag) => ({ id: tag.id, kept: isKeptClip(tag) }))).toStrictEqual([{ id: 'c', kept: false }])
      expect(native.deletedFiles.filter(({ folder }) => !folder)).toStrictEqual([])
    })

    it('is not made for a clip that the answer keeps', async () => {
      streamChat = answers(`${NOTES}\n\n## Assets\n@c: keep - The first film.`)

      const compaction = await compactConversation(compactionInput())

      expect(programRuns('dez-ffmpeg')).toStrictEqual([])
      expect(savedPictures()).toStrictEqual([])
      expect(findMediaTags(notesOf(compaction)).map((tag) => isKeptClip(tag))).toStrictEqual([true])
    })

    it('is not made for a model that reads no images', async () => {
      sbp('dez.model/modelCache/applyProviderResult', model.providerId, { ok: true, models: [{ id: model.modelId, name: 'M', provider: model.providerId, imageInput: false }] })
      streamChat = answers(SHOW)

      const compaction = await compactConversation(compactionInput())

      expect(programRuns('dez-ffmpeg')).toStrictEqual([])
      expect(compaction.pictures).toStrictEqual([])
      expect(findMediaTags(notesOf(compaction)).map((tag) => isKeptClip(tag))).toStrictEqual([true])
    })

    it('is deleted when it does not fit in the picture limits of the model, and the clip is kept as text', async () => {
      // A window whose pictures can take 520 tokens, and the `show` assets
      // half of them: the frame sheet costs 455.
      sbp('dez.model/modelCache/applyProviderResult', model.providerId, { ok: true, models: [{ id: model.modelId, name: 'M', provider: model.providerId, contextWindow: 2000 }] })
      streamChat = answers(SHOW)

      const compaction = await compactConversation(compactionInput())

      const saved = savedPictures()
      expect(saved).toHaveLength(1)
      expect(native.deletedFiles.filter(({ folder }) => !folder)).toStrictEqual([{ root: 'app', path: saved[0].file.path, folder: false }])
      expect(compaction.pictures).toStrictEqual([])
      expect(sectionCompactionTag(compaction.sections[0])?.pictures).toStrictEqual([])
      expect(findMediaTags(notesOf(compaction)).map((tag) => isKeptClip(tag))).toStrictEqual([true])
    })

    it('is left out, with the clip kept as text, when ffmpeg makes none', async () => {
      streamChat = answers(SHOW)
      native.fileBytes = () => { throw new Error('No such file.') }

      const compaction = await compactConversation(compactionInput())

      expect(savedPictures()).toStrictEqual([])
      expect(compaction.pictures).toStrictEqual([])
      expect(findMediaTags(notesOf(compaction)).map((tag) => isKeptClip(tag))).toStrictEqual([true])
    })
  })

  it('saves no image of the answer, and deletes the temp copy of its audio', async () => {
    const audio = `${CACHE_DIR}/media/answer.wav`
    streamChat = async (input) => {
      input.onSent?.()
      input.onImage({ mediaType: 'image/png', bytes: new Uint8Array([1]) })
      await input.onClip({ kind: 'audio', mediaType: 'audio/wav', src: audio, url: null, expires: '2026-11-16T00:00:00.000Z', jobId: null })
      input.onToken(NOTES)
    }

    const compaction = await compactConversation(compactionInput())

    expect(native.deletedFiles.filter(({ folder }) => !folder)).toStrictEqual([{ root: 'cache', path: 'media/answer.wav', folder: false }])
    expect(native.savedFiles).toStrictEqual([])
    expect(compaction.sections.map(sectionPlainText).join('\n')).not.toContain('answer.wav')
  })

  describe('a compaction that fails', () => {
    it('rejects with the error of a request that failed, and counts a request that went with no known price', async () => {
      const failure = new Error('The connection broke.')
      streamChat = async (input) => {
        input.onSent?.()
        throw failure
      }

      expect(await failureOf(compactConversation(compactionInput()))).toBe(failure)

      expect(counted).toStrictEqual([null])
      expect(logRows()).toMatchObject([{ kind: 'compaction', cost: null }])
    })

    it('counts nothing for a request that did not go', async () => {
      const failure = new Error('The provider has no key.')
      streamChat = async () => { throw failure }

      expect(await failureOf(compactConversation(compactionInput()))).toBe(failure)

      expect(counted).toStrictEqual([])
      expect(logRows()).toStrictEqual([])
    })

    it.each([
      ['an empty answer', ''],
      ['an answer with only asset lines', '## Assets\n@b: keep - A draft.\n@c: show - The film.'],
    ])('rejects with an explained error for %s, with the request counted and no picture made', async (_name, text) => {
      streamChat = answers(text)

      const error = await failureOf(compactConversation(compactionInput()))

      expect(error).toBeInstanceOf(ExplainedError)
      expect((error as ExplainedError).explanation).toBe(NO_COMPACTION_NOTES_TEXT)
      expect(counted).toStrictEqual([0.25])
      expect(programRuns('dez-ffmpeg')).toStrictEqual([])
      expect(native.savedFiles).toStrictEqual([])
    })
  })

  describe('a stop', () => {
    it('before the compaction sends no request', async () => {
      const stop = new AbortController()
      stop.abort(STOP)

      expect(await failureOf(compactConversation(compactionInput({ signal: stop.signal })))).toBe(STOP)

      expect(chatRequests).toStrictEqual([])
      expect(readImages).toStrictEqual([])
    })

    // A request that a stop cuts off ends with no error and half an answer.
    it('while the answer comes rejects with the stop, with the request counted and no notes taken', async () => {
      const stop = new AbortController()
      streamChat = async (input) => {
        input.onSent?.()
        input.onToken('## Summary\nThe user wa')
        stop.abort(STOP)
      }

      expect(await failureOf(compactConversation(compactionInput({ signal: stop.signal })))).toBe(STOP)

      expect(counted).toStrictEqual([null])
      expect(native.savedFiles).toStrictEqual([])
    })

    it('while ffmpeg makes the picture of a clip rejects with the stop, and saves no picture', async () => {
      const stop = new AbortController()
      streamChat = answers(`${NOTES}\n\n## Assets\n@c: show - The first film.`)
      const probe = native.program
      native.program = async (run, onOutput) => {
        if (run.tool === 'dez-ffprobe') return probe(run, onOutput)
        stop.abort(STOP)
        return { kind: 'cancelled' }
      }

      expect(await failureOf(compactConversation(compactionInput({ signal: stop.signal })))).toBe(STOP)

      expect(savedPictures()).toStrictEqual([])
    })

    it('while a picture is saved rejects with the stop, and deletes the saved copy', async () => {
      const stop = new AbortController()
      streamChat = answers(`${NOTES}\n\n## Assets\n@c: show - The first film.`)
      native.saveAppFile = async () => stop.abort(STOP)

      expect(await failureOf(compactConversation(compactionInput({ signal: stop.signal })))).toBe(STOP)

      const saved = savedPictures()
      expect(saved).toHaveLength(1)
      expect(native.deletedFiles.filter(({ folder }) => !folder)).toStrictEqual([{ root: 'app', path: saved[0].file.path, folder: false }])
    })
  })
})
