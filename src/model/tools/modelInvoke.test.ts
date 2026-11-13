import { describe, expect, it } from 'vitest'
import { mediaTagText, type MediaTagData } from '../chat/mediaTags'
import type { Section } from '../chat/types'
import type { ModelCache } from '../persistence/types'
import type { ParameterValues } from '../providers/modelParameters'
import { providerInfo } from '../providers/testing'
import type { ModelInfo } from '../providers/types'
import { reply, user } from '../streams/testing'
import { answerIsCut, DEFAULT_INVOKE_TIMEOUT_SECONDS, INVOCATION_TEXT_CAP, invocationAnswerStateText, invocationAnswerText, invocationFailedText, invocationInputsText, invocationStateText, invocationTextResult, MODEL_INVOKE_TOOL, modelInvocation, type ChatInvocation, type MediaInvocation, type ModelInvocation } from './modelInvoke'
import { ToolError, type ToolArguments } from './types'

const VENICE = providerInfo('venice', 'Venice')

const PAINTER: ModelInfo = { id: 'painter', name: 'Painter', provider: VENICE.id, outputs: ['image'], request: 'image', images: { maxImages: 2 } }
const SPEAKER: ModelInfo = { id: 'speaker', name: 'Speaker', provider: VENICE.id, outputs: ['audio'], request: 'tts' }
const SCRIBE: ModelInfo = { id: 'scribe', name: 'Scribe', provider: VENICE.id, outputs: ['text'], request: 'transcription', clips: { audio: { use: 'source', maxClips: 1 } } }
// A video model that takes 2 frames, or 3 references when the request sets
// `images_as`.
const FILMER: ModelInfo = {
  id: 'filmer',
  name: 'Filmer',
  provider: VENICE.id,
  outputs: ['video'],
  request: 'video',
  parameters: [
    { name: 'duration', label: 'Length', options: ['5s', '10s'], default: '5s' },
    { name: 'images_as', label: 'Images as', options: ['frames', 'references'], default: 'frames' },
  ],
  images: { maxImages: 2, whenParameter: { name: 'images_as', value: 'references', rules: { maxImages: 3, references: {} } } },
}
// Text models: one with no known facts, one that is known not to read
// images, and one that makes images too.
const CHATTER: ModelInfo = { id: 'chatter', name: 'Chatter', provider: VENICE.id }
const BLIND: ModelInfo = { id: 'blind', name: 'Blind', provider: VENICE.id, imageInput: false }
const SKETCHER: ModelInfo = { id: 'sketcher', name: 'Sketcher', provider: VENICE.id, outputs: ['text', 'image'] }
const OTHER_API: ModelInfo = { id: 'other-api', name: 'Other', provider: VENICE.id, outputs: ['image'], request: 'none' }
const TIFF_ONLY: ModelInfo = { id: 'tiff-only', name: 'Tiffer', provider: VENICE.id, outputs: ['image'], request: 'image', unstoredOutput: 'TIFF' }

const CACHE: ModelCache = {
  version: 1,
  providers: { venice: { models: [PAINTER, SPEAKER, SCRIBE, FILMER, CHATTER, BLIND, SKETCHER, OTHER_API, TIFF_ONLY], working: true, updatedAt: 0, lastCheckedAt: 0 } },
}

const RED = '/home/u/.config/dez/assets/images/red.png'
const FOX = '/home/u/.config/dez/assets/generated/images/fox.webp'
const SKY = '/home/u/.config/dez/assets/images/sky.png'
const SONG: MediaTagData = { kind: 'audio', id: 'c', type: 'audio/mpeg', src: '/home/u/.cache/dez/media/s1.mp3', url: null, expires: null, other: [] }

// A conversation with the images `a`, `b`, and `d`, and the audio clip `c`.
const CONVERSATION = [
  user('u1', `Like ![${RED}](id=b) and ![${SKY}](id=d)`),
  reply('a1', `![${FOX}](id=a)\n${mediaTagText(SONG)}`),
]

// What a test knows besides the call; the rest is as in the conversation
// above, with no choice of the user.
interface CallFacts {
  sections?: Section[]
  modelParameters?: Record<string, ParameterValues>
  providerSettings?: Record<string, Record<string, boolean>>
}

function anyInvocation(args: ToolArguments, { sections = CONVERSATION, modelParameters = {}, providerSettings = {} }: CallFacts = {}): ModelInvocation {
  return modelInvocation(args, { cache: CACHE, providers: [VENICE], modelParameters, providerSettings, sections })
}

// The request of a call to a media model.
function invocation(args: ToolArguments, facts?: CallFacts): MediaInvocation {
  const call = anyInvocation(args, facts)
  if (call.kind === 'chat') throw new Error('The call went to a text model.')
  return call
}

// The request of a call to a text model.
function chatInvocation(args: ToolArguments, facts?: CallFacts): ChatInvocation {
  const call = anyInvocation(args, facts)
  if (call.kind !== 'chat') throw new Error('The call went to a media model.')
  return call
}

// The text of the refusal of a call.
function refusal(args: ToolArguments, facts?: CallFacts): string {
  try {
    anyInvocation(args, facts)
  } catch (error) {
    if (error instanceof ToolError) return error.message
    throw error
  }
  throw new Error('The call was not refused.')
}

describe('MODEL_INVOKE_TOOL', () => {
  it('takes the model and the prompt, and tells the default time limit in words', () => {
    expect(MODEL_INVOKE_TOOL.parameters.map(({ name, required }) => [name, required])).toStrictEqual([
      ['model', true], ['prompt', true], ['parameters', false], ['is_intermediate', false], ['timeout_seconds', false],
    ])
    expect(DEFAULT_INVOKE_TIMEOUT_SECONDS).toBe(30 * 60)
    expect(MODEL_INVOKE_TOOL.parameters.at(-1)?.description).toContain('30 minutes')
  })
})

describe('modelInvocation', () => {
  it('gives the request of the model, with the inputs that the prompt names in text order', () => {
    const { provider, model, kind, request, inputs, imageIds, timeoutMs } = invocation({ model: 'venice/painter', prompt: 'A fox as in @a, in the red of @b.' })

    expect([provider, model, kind]).toStrictEqual([VENICE, PAINTER, 'image'])
    expect(request).toMatchObject({ prompt: 'A fox as in @a, in the red of @b.', images: [FOX, RED], clips: [] })
    expect(inputs).toStrictEqual([{ id: 'a', kind: 'image' }, { id: 'b', kind: 'image' }])
    expect([...imageIds]).toStrictEqual([[FOX, 'a'], [RED, 'b']])
    expect(timeoutMs).toBe(30 * 60 * 1000)
  })

  // No newest-image rule: a model gets only what the prompt names.
  it('sends no image and no clip that the prompt does not name', () => {
    const { request, inputs } = invocation({ model: 'venice/painter', prompt: 'A fox.' })

    expect([request.images, request.clips, inputs]).toStrictEqual([[], [], []])
  })

  it('sends the clip that the prompt of a model with no text names', () => {
    const { request, inputs } = invocation({ model: 'venice/scribe', prompt: '@c' })

    expect(request.clips.map((clip) => clip.id)).toStrictEqual(['c'])
    expect(inputs).toStrictEqual([{ id: 'c', kind: 'audio' }])
  })

  it('refuses a model that the user cannot use, and points to model_list', () => {
    const text = refusal({ model: 'venice/gone', prompt: 'A fox.' })

    expect(text).toContain('"venice/gone"')
    expect(text).toContain('model_list')
    // The advice of `model_info`, whose `model` is optional.
    expect(text).not.toContain('Leave out')
    expect(refusal({ prompt: 'A fox.' })).toContain('is not a full model id')
  })

  it.each([
    ['a model that Dez has no request for', 'venice/other-api', 'Other', 'cannot use'],
    ['a model whose images Dez cannot store', 'venice/tiff-only', 'Tiffer', 'TIFF'],
  ])('refuses %s, and points to model_list', (_name, model, modelName, cause) => {
    const text = refusal({ model, prompt: 'A fox.' })

    expect(text).toContain(modelName)
    expect(text).toContain(cause)
    expect(text).toContain('model_list')
  })

  it.each([[10, 10_000], [3600, 3_600_000]])('takes a time limit of %i seconds', (seconds, timeoutMs) => {
    expect(invocation({ model: 'venice/painter', prompt: 'A fox.', timeout_seconds: seconds }).timeoutMs).toBe(timeoutMs)
  })

  it.each([9, 3601, 0, -5, 60.5])('refuses a time limit of %d seconds, and tells the range', (seconds) => {
    const text = refusal({ model: 'venice/painter', prompt: 'A fox.', timeout_seconds: seconds })

    expect(text).toContain('`timeout_seconds`')
    expect(text).toContain('10 to 3600')
  })

  it('sets the values of the call over the values that the user chose', () => {
    const modelParameters = { 'venice/filmer': { duration: '10s', images_as: 'references' } }

    expect(invocation({ model: 'venice/filmer', prompt: 'A fox runs.' }, { modelParameters }).parameters).toStrictEqual({ duration: '10s', images_as: 'references' })
    expect(invocation({ model: 'venice/filmer', prompt: 'A fox runs.', parameters: '{"duration": "5s"}' }, { modelParameters }).parameters)
      .toStrictEqual({ duration: '5s', images_as: 'references' })
  })

  it('refuses a parameter value that the model does not take', () => {
    expect(refusal({ model: 'venice/filmer', prompt: 'A fox runs.', parameters: '{"duration": "7s"}' })).toContain('"duration"')
  })

  // More inputs than the model takes would leave out one that the caller
  // meant, so nothing is cut.
  it('checks the inputs against the image rules of the request\'s parameter values', () => {
    const prompt = 'A film of @a, @b, and @d.'

    expect(refusal({ model: 'venice/filmer', prompt })).toContain('2 images')
    expect(invocation({ model: 'venice/filmer', prompt, parameters: '{"images_as": "references"}' }).request.images).toStrictEqual([FOX, RED, SKY])
    expect(invocation({ model: 'venice/filmer', prompt }, { modelParameters: { 'venice/filmer': { images_as: 'references' } } }).request.images).toStrictEqual([FOX, RED, SKY])
  })

  it('refuses an input that the model does not take', () => {
    expect(refusal({ model: 'venice/speaker', prompt: 'Read the sign of @a.' })).toContain('Speaker takes no input image')
    expect(refusal({ model: 'venice/scribe', prompt: 'Write it down.' })).toContain('audio clip')
  })

  it('refuses an @id that names nothing, and tells the ids of the conversation', () => {
    const text = refusal({ model: 'venice/painter', prompt: 'A fox as in @z, with @a.' })

    expect(text).toContain('@z names no image and no clip')
    expect(text).toContain('the image @b, the image @d, the image @a, the audio clip @c')
    expect(text).not.toContain('/home')
  })

  it('tells a prompt with an @id that the conversation has no image and no clip', () => {
    expect(refusal({ model: 'venice/painter', prompt: 'A fox as in @a.' }, { sections: [user('u1', 'Hello')] })).toContain('it has none')
  })

  // The next free id of the conversation is `e`: a longer word is no id.
  it.each(['Tag @everyone in the picture.', 'Mail bob@a.com about @a-team.'])('takes a prompt with an @ word that is no id: %s', (prompt) => {
    expect(invocation({ model: 'venice/painter', prompt }).request.prompt).toBe(prompt)
  })

  it.each(['', '  \n'])('refuses the blank prompt %j for a model that needs a text', (prompt) => {
    expect(refusal({ model: 'venice/painter', prompt })).toContain('`prompt` has no text')
    expect(refusal({ model: 'venice/painter' })).toContain('`prompt` has no text')
  })
})

describe('modelInvocation for a text model', () => {
  it('gives one user message, which is the prompt as it is when it names no image', () => {
    const { provider, model, kind, content, inputs, imageIds, timeoutMs } = chatInvocation({ model: 'venice/chatter', prompt: ' Name three foxes.\n', timeout_seconds: 60 })

    expect([provider, model, kind]).toStrictEqual([VENICE, CHATTER, 'chat'])
    expect(content).toBe(' Name three foxes.\n')
    expect([inputs, [...imageIds]]).toStrictEqual([[], []])
    expect(timeoutMs).toBe(60_000)
  })

  it('puts each image once, right after the text that names it first', () => {
    const { content, inputs, imageIds } = chatInvocation({ model: 'venice/chatter', prompt: 'Is @a as red as @b? And is @a new?' })

    expect(content).toStrictEqual([
      { type: 'text', text: 'Is @a' },
      { type: 'image', path: FOX },
      { type: 'text', text: ' as red as @b' },
      { type: 'image', path: RED },
      { type: 'text', text: '? And is @a new?' },
    ])
    expect(inputs).toStrictEqual([{ id: 'a', kind: 'image' }, { id: 'b', kind: 'image' }])
    expect([...imageIds]).toStrictEqual([[FOX, 'a'], [RED, 'b']])
  })

  // The Anthropic format refuses a text part with only white space.
  it('sends no blank text part after the last image', () => {
    expect(chatInvocation({ model: 'venice/chatter', prompt: 'What does this show? @a \n' }).content)
      .toStrictEqual([{ type: 'text', text: 'What does this show? @a' }, { type: 'image', path: FOX }])
  })

  // Only an @id sends an image: a path that the model wrote reads no file
  // and does not go.
  it('sends no path of a stored file that the prompt holds', () => {
    const { content, inputs } = chatInvocation({ model: 'venice/chatter', prompt: `What is ![${RED}](id=b)?` })

    expect(content).toBeTypeOf('string')
    expect(content).not.toContain('/home')
    expect(inputs).toStrictEqual([])
  })

  it('asks for images only from a model that makes them', () => {
    expect(chatInvocation({ model: 'venice/chatter', prompt: 'A fox.' }).imageOutput).toBe(false)
    expect(chatInvocation({ model: 'venice/sketcher', prompt: 'A fox.' }).imageOutput).toBe(true)
  })

  it('takes the toggles that the user set for the provider of the model', () => {
    const providerSettings = { venice: { webSearch: false }, openrouter: { thinking: false } }

    expect(chatInvocation({ model: 'venice/chatter', prompt: 'A fox.' }, { providerSettings }).providerSettings).toStrictEqual({ webSearch: false })
    expect(chatInvocation({ model: 'venice/chatter', prompt: 'A fox.' }).providerSettings).toBeUndefined()
  })

  it('refuses a clip, which no chat request carries', () => {
    const text = refusal({ model: 'venice/chatter', prompt: 'What does @c say about @a?' })

    expect(text).toContain('Chatter takes no audio clip')
    expect(text).toContain('`prompt`')
  })

  // A user message sends such a model the reference as text; a calling
  // model would get an answer about an image that the model never got.
  it('refuses an image for a model that is known not to read images', () => {
    expect(refusal({ model: 'venice/blind', prompt: 'What does @a show?' })).toContain('Blind takes no input image')
    expect(chatInvocation({ model: 'venice/blind', prompt: 'Name three foxes.' }).content).toBe('Name three foxes.')
  })

  it('refuses an @id that names nothing', () => {
    expect(refusal({ model: 'venice/chatter', prompt: 'What does @z show?' })).toContain('@z names no image and no clip')
  })

  it.each(['', '  \n'])('refuses the blank prompt %j', (prompt) => {
    expect(refusal({ model: 'venice/chatter', prompt })).toContain('`prompt` has no text')
  })

  it('refuses a parameter value, as a text model has no parameters', () => {
    expect(refusal({ model: 'venice/chatter', prompt: 'A fox.', parameters: '{"temperature": 1}' })).toContain('leave out `parameters`')
    expect(chatInvocation({ model: 'venice/chatter', prompt: 'A fox.', parameters: '{}' }).content).toBe('A fox.')
  })
})

describe('the texts of a call', () => {
  it('names the inputs that go, or says that none goes', () => {
    expect(invocationInputsText([{ id: 'a', kind: 'image' }, { id: 'd', kind: 'video' }, { id: 'c', kind: 'audio' }]))
      .toContain('the image @a, the video clip @d, the audio clip @c')
    expect(invocationInputsText([])).toContain('no input image and no input clip')
  })

  // The provider took the money for its job: the user needs the id.
  it('names the provider\'s job id in the state as soon as there is one', () => {
    expect(invocationStateText('Venice', { phase: 'sent', jobId: null })).toContain('Venice')
    expect(invocationStateText('Venice', { phase: 'queued', jobId: 'q-17' })).toContain('q-17')
    expect(invocationStateText('Venice', { phase: 'downloading', jobId: 'q-17' })).toContain('q-17')
  })

  it('gives the text of the model as it is, and says so when there is none', () => {
    expect(invocationTextResult('  Hello there.\nSecond line. \n')).toMatch(/\nHello there\.\nSecond line\.$/)
    expect(invocationTextResult(' \n')).toContain('no text')
  })

  it('tells how much text a text model gave so far', () => {
    expect(invocationAnswerStateText(0)).toContain('no text yet')
    expect(invocationAnswerStateText(1234)).toContain('1234 characters')
  })

  it('gives the answer of a text model as it is, and says so when there is none', () => {
    expect(invocationAnswerText('  A fox.\nA red one. \n')).toMatch(/\nA fox\.\nA red one\.$/)
    expect(invocationAnswerText(' \n')).toBe('The model gave no text.')
  })

  describe(`an answer over ${INVOCATION_TEXT_CAP} characters`, () => {
    const full = 'x'.repeat(INVOCATION_TEXT_CAP)

    it('is whole up to the limit', () => {
      expect(answerIsCut(full)).toBe(false)
      expect(invocationAnswerText(full).endsWith(`:\n${full}`)).toBe(true)
      expect(invocationAnswerText(full)).not.toContain('lost')
    })

    it('is cut to the limit, and the text tells that first', () => {
      const text = invocationAnswerText(`${full}yz`)

      expect(answerIsCut(`${full}y`)).toBe(true)
      expect(text.endsWith(`:\n${full}`)).toBe(true)
      expect(text.slice(0, text.indexOf('\n'))).toContain(`more than ${INVOCATION_TEXT_CAP} characters`)
    })

    // Half of a character pair is no text: a provider can refuse it.
    it('is not cut inside a character pair', () => {
      const text = invocationAnswerText(`${full.slice(1)}🦊 and more`)

      expect(text.endsWith(`:\n${full.slice(1)}`)).toBe(true)
    })
  })

  it('keeps the text of a failed request, with a stand-in for a local path', () => {
    const text = invocationFailedText('Painter', 'Venice refused the request.\n\nDetails: no file /home/alice/models/painter.bin')

    expect(text).toContain('Painter')
    expect(text).toContain('Venice refused the request.')
    expect(text).toContain('Details: no file /home/…')
    expect(text).not.toContain('alice')
  })
})
