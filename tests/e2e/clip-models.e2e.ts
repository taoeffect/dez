import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { click, consoleErrors, resetConsoleErrors, screenshotOnFailure, waitForValue } from './harness/dom'
import { readAppState } from './harness/fixtures'
import { MP4_VIDEO, WEBM_VIDEO, answerVeniceJob, silentWav, tempClipTag } from './harness/media'
import { expectSendRefused, startMockProviderApp, takeRequest, type MockProviderApp } from './harness/mockProviderApp'
import { answerHeld, mockModelKey, requestForm, type MockProvider } from './harness/mockServer'
import { changeParameterField, closePopup, openPopup, popupOpen, popupView, type ParameterRow } from './harness/parameterPopup'
import type { E2EBrowser } from './harness/session'
import { newTab, openSeededConversation, pickModel, submit, waitForThread } from './harness/thread'

// The models that change or write down a clip of the message, driven
// through the real app against a mock of Venice's media API
// (`mediaApi: { format: 'venice' }`), which also serves the model list with
// the entries of the live list (2026-11-12) and maps them as the built-in
// Venice provider does:
// - a transcription model gets the audio clip that the message names as
//   the file of a multipart form, and the reply's text is the transcript;
// - the voice changer gets the clip and its voice as a multipart form, and
//   its job's clip is the reply; the voice can be an id that the user
//   types in the popup ("Other…"), as the list of the model does not hold
//   the voices of the user's account;
// - a video-to-video model gets the video clip as `video_url`, and its
//   job's clip is the reply;
// - a message with no clip gets an error toast that tells what to do, and
//   no request goes.
//
// One app session serves the whole file; each test starts in a new tab.

const CLIPS: MockProvider = { id: 'clipmodels', name: 'Clip Models Mock', modelId: 'openai/whisper-large-v3', modelName: 'Whisper Large V3' }
const VOICE = { id: 'elevenlabs-voice-changer', name: 'ElevenLabs Voice Changer' }
const EDIT = { id: 'wan-2-7-video-to-video', name: 'Wan 2.7 Edit' }
const TRANSCRIBE_PATH = `/${CLIPS.id}/v1/audio/transcriptions`
const VOICE_QUEUE_PATH = `/${CLIPS.id}/v1/audio/voice-changer/queue`
const VOICE_RETRIEVE_PATH = `/${CLIPS.id}/v1/audio/voice-changer/retrieve`
const VIDEO_QUEUE_PATH = `/${CLIPS.id}/v1/video/queue`
const VIDEO_RETRIEVE_PATH = `/${CLIPS.id}/v1/video/retrieve`

// The live entries have no top-level `name`, so the picker would show ids;
// the names here are as in the other media specs.
const MODEL_LIST = {
  object: 'list',
  data: [
    { id: CLIPS.modelId, name: CLIPS.modelName, type: 'asr', model_spec: {} },
    {
      id: VOICE.id,
      name: VOICE.name,
      type: 'music',
      model_spec: {
        voice_changer: true,
        voices: ['Aria', 'Roger'],
        default_voice: 'Aria',
        supports_custom_voice_id: true,
        supports_background_noise_removal: true,
        accepted_audio_formats: ['mp3', 'wav', 'ogg', 'mp4', 'aac'],
        max_source_audio_duration_seconds: 300,
      },
    },
    {
      id: EDIT.id,
      name: EDIT.name,
      type: 'video',
      model_spec: {
        constraints: { model_type: 'video', aspect_ratios: [], resolutions: ['1080p', '720p'], durations: ['Auto'], audio_configurable: false, video_input: true },
      },
    },
  ],
}

const BEAT = silentWav(3)

describe('models that change or write down a clip', () => {
  let setup: MockProviderApp
  let browser: E2EBrowser

  // Seeds a conversation whose one reply holds the clip `tag`, with `next`
  // as the text of the user section after it, opens it, and picks the
  // model `modelName`.
  async function openClip (id: string, tag: string, next: string, modelName: string): Promise<void> {
    await openSeededConversation(browser, setup.app.home, id, [
      { role: 'user', text: 'Make a clip' },
      { role: 'agent', text: tag },
      { role: 'user', text: next },
    ])
    await pickModel(browser, CLIPS.name, modelName)
  }

  beforeAll(async () => {
    setup = await startMockProviderApp(CLIPS, {
      mediaApi: { format: 'venice' },
      fetchModels: true,
      models: [],
      modelOutputs: {
        path: 'type',
        values: {
          music: { outputs: ['audio'], request: 'music', requestBy: { path: 'model_spec.voice_changer', values: { true: 'voiceChange' } } },
          video: { outputs: ['video'], requestBy: { path: 'model_spec.constraints.model_type', values: { video: 'videoToVideo' } } },
          asr: { outputs: ['text'], request: 'transcription' },
        },
      },
    }, {
      heldPaths: [TRANSCRIBE_PATH, VOICE_QUEUE_PATH, VOICE_RETRIEVE_PATH, VIDEO_QUEUE_PATH, VIDEO_RETRIEVE_PATH],
      jsonAnswers: { [`/${CLIPS.id}/v1/models`]: MODEL_LIST },
    })
    browser = setup.browser
  })

  beforeEach(async () => {
    await newTab(browser)
    await resetConsoleErrors(browser)
  })

  afterEach(async (ctx) => {
    await screenshotOnFailure(browser, ctx)
    // A test that fails can leave the popup open.
    if (await popupOpen(browser)) await closePopup(browser)
    await setup.mock.dropOpenReplies(browser)
  })

  afterAll(async () => {
    await setup?.stop()
  })

  it('sends the named audio clip to a transcription model as a form file, and writes the transcript as the reply', async () => {
    const beat = await tempClipTag(setup.app.home, 'audio', 'a', 'speech.wav', BEAT)
    await openClip('transcribe', beat, 'Write down @a', CLIPS.modelName)
    await submit(browser, '')

    const request = await takeRequest(setup, TRANSCRIBE_PATH)
    expect(request.headers['content-type']).toMatch(/^multipart\/form-data; boundary=/)
    // No prompt: the endpoint takes none.
    expect(await requestForm(request)).toStrictEqual([
      { name: 'model', value: CLIPS.modelId },
      { name: 'response_format', value: 'json' },
      { name: 'file', fileName: 'clip.wav', type: 'audio/wav', bytes: BEAT },
    ])
    answerHeld(request.reply, 'application/json', JSON.stringify({ text: ' Hello there. ', duration: 3 }))

    await waitForThread(browser, [
      { role: 'user', text: 'Make a clip' },
      { role: 'agent', text: beat },
      { role: 'user', text: 'Write down @a' },
      { role: 'agent', text: 'Hello there.' },
      { role: 'user', text: '' },
    ])
    expect(await consoleErrors(browser)).toStrictEqual([])
  })

  it('sends the named audio clip and the default voice to the voice changer as a form, and shows the clip of its job', async () => {
    const beat = await tempClipTag(setup.app.home, 'audio', 'a', 'voice.wav', BEAT)
    await openClip('voice', beat, '@a', VOICE.name)
    await submit(browser, '')

    const queue = await takeRequest(setup, VOICE_QUEUE_PATH)
    // The noise switch is off, so it goes as no field.
    expect(await requestForm(queue)).toStrictEqual([
      { name: 'model', value: VOICE.id },
      { name: 'voice', value: 'Aria' },
      { name: 'file', fileName: 'clip.wav', type: 'audio/wav', bytes: BEAT },
    ])
    const reply = await answerVeniceJob(setup, queue, { retrievePath: VOICE_RETRIEVE_PATH, modelId: VOICE.id, queueId: 'job-1', clip: { type: 'audio/wav', bytes: silentWav(2) }, replyIndex: 3 })

    expect(reply).toMatch(new RegExp(String.raw`^<dez:audio id="b" type="audio/wav" src="[^"]+\.wav" expires="[^"]+" model="${mockModelKey(CLIPS, VOICE.id)}" job="job-1"/>$`))
    expect(await consoleErrors(browser)).toStrictEqual([])
  })

  it('sends the voice id that the user types for "Other…" to the voice changer, shows it again in the popup, and resets it', async () => {
    const ownVoice = 'laTmoAT4stwoPzthxjZT'
    const listed: ParameterRow = { name: 'voice', label: 'Voice', options: ['Aria', 'Roger', 'Other…'], picked: 'Aria' }
    const typed: ParameterRow = { ...listed, picked: 'Other…', text: ownVoice }
    const voiceRow = async () => (await popupView(browser)).rows.find((row) => row.name === 'voice')
    const storedParameters = async () => (await readAppState(setup.app.home))?.modelParameters?.[mockModelKey(CLIPS, VOICE.id)] ?? null
    const beat = await tempClipTag(setup.app.home, 'audio', 'a', 'own-voice.wav', BEAT)
    await openClip('own-voice', beat, '@a', VOICE.name)
    await openPopup(browser)
    await waitForValue(browser, 'voice row with the default', voiceRow, listed)

    // "Other…" opens the text field, and the request still gets the default
    // voice until a text comes.
    await changeParameterField(browser, 'voice', 'Other…', 'option')
    await waitForValue(browser, 'empty text field', voiceRow, { ...typed, text: '' })
    expect(await storedParameters()).toBeNull()
    await changeParameterField(browser, 'voice', ` ${ownVoice} `, 'text')
    await waitForValue(browser, 'voice row with the id', voiceRow, typed)
    await waitForValue(browser, 'stored voice', storedParameters, { voice: ownVoice })
    await closePopup(browser)

    await submit(browser, '')
    const queue = await takeRequest(setup, VOICE_QUEUE_PATH)
    expect(await requestForm(queue)).toStrictEqual([
      { name: 'model', value: VOICE.id },
      { name: 'voice', value: ownVoice },
      { name: 'file', fileName: 'clip.wav', type: 'audio/wav', bytes: BEAT },
    ])
    await answerVeniceJob(setup, queue, { retrievePath: VOICE_RETRIEVE_PATH, modelId: VOICE.id, queueId: 'job-1', clip: { type: 'audio/wav', bytes: silentWav(2) }, replyIndex: 3 })

    // A new popup shows the id, and a reset brings the default voice back
    // for the other tests.
    await openPopup(browser)
    await waitForValue(browser, 'voice row of the new popup', voiceRow, typed)
    await click(browser, '.provider-settings-reset')
    await waitForValue(browser, 'voice row after the reset', voiceRow, listed)
    await waitForValue(browser, 'stored values after the reset', storedParameters, null)
    await closePopup(browser)
    expect(await consoleErrors(browser)).toStrictEqual([])
  })

  it('sends the named video clip to a video-to-video model as video_url, and shows the clip of its job', async () => {
    const film = await tempClipTag(setup.app.home, 'video', 'a', 'film.mp4', MP4_VIDEO)
    await openClip('edit', film, 'Make @a look like a painting', EDIT.name)
    await submit(browser, '')

    // The one length (`Auto`, the length of the clip) and the lowest
    // resolution.
    const queue = await takeRequest(setup, VIDEO_QUEUE_PATH, {
      model: EDIT.id,
      prompt: 'Make @a look like a painting',
      duration: 'Auto',
      resolution: '720p',
      video_url: `data:video/mp4;base64,${MP4_VIDEO.toString('base64')}`,
    })
    const reply = await answerVeniceJob(setup, queue, { retrievePath: VIDEO_RETRIEVE_PATH, modelId: EDIT.id, queueId: 'job-1', clip: { type: 'video/webm', bytes: WEBM_VIDEO }, replyIndex: 3 })

    expect(reply).toMatch(new RegExp(String.raw`^<dez:video id="b" type="video/webm" src="[^"]+\.webm" expires="[^"]+" model="${mockModelKey(CLIPS, EDIT.id)}" job="job-1"/>$`))
    expect(await consoleErrors(browser)).toStrictEqual([])
  })

  it('refuses a message with no clip for a model that writes one down, and sends nothing', async () => {
    const refusal = `${CLIPS.modelName} writes down the speech of an audio clip, and this message has no audio clip. Paste or drop an audio clip into the message, or name one with @id.`
    await pickModel(browser, CLIPS.name, CLIPS.modelName)
    await submit(browser, 'Write this down')

    await expectSendRefused(setup, refusal, [{ role: 'user', text: 'Write this down' }])
  })
})
