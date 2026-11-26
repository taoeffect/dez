import fs from 'node:fs'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { APIMART_CONFIG, FLOW_MUSIC, GENERAL_MODEL, IMAGE_MODEL, MART, MODELS_PATH, MODEL_LIST, SUNO, WHISPER } from './harness/apimartMock'
import { click, consoleErrors, resetConsoleErrors, screenshotOnFailure, typeKeys, waitForValue } from './harness/dom'
import { filesIn, newFileIn, storedFileName } from './harness/fixtures'
import { generatedImagesDir, pasteImageReference, solidPng } from './harness/images'
import { MP4_VIDEO, shownPlayers, silentWav, startClipServer, tempClipTag, type ClipServer } from './harness/media'
import { startMockProviderApp, takeRequest, type MockProviderApp } from './harness/mockProviderApp'
import { answerHeld, mockModelKey, requestForm } from './harness/mockServer'
import { changeParameterField, closePopup, openPopup, popupOpen, popupView } from './harness/parameterPopup'
import type { E2EBrowser } from './harness/session'
import { activeTabId, closeToasts, editorDoc, focusEditor, newTab, openSeededConversation, openToasts, pasteText, pickModel, sbpCall, setCaret, submit, threadSections, waitForThread } from './harness/thread'

// Video, music, transcription, and image models of APIMart, driven
// through the real app against a mock of its API
// (`mediaApi: { format: 'apimart' }`). The mock serves the model list in
// the form of APIMart's list, with the schema of each video model's
// request (`?expand=parameters`), the account price of a request, and the
// state of each task.
// - the popup shows the rows that the docs tell for a model that Dez knows
//   (MiniMax-H3, Suno), and the rows of the schema for any other video
//   model; the Suno popup tells how lyrics turn on its Custom mode;
// - a video request is one POST to `/videos/generations` with the values
//   of the rows (a whole-number text as a number); the app asks for the
//   state of its task, copies the file of the done task, and shows a
//   player; the cost of the tab is the cost of the task, not the quote;
// - the input image of a video request goes first to `/uploads/images`
//   (3 days, a neutral file name), and the request sends its web address
//   as the first frame;
// - a task that failed shows an error toast with the task id, and costs
//   what the task tells (APIMart gives the money back);
// - a music request is one POST to `/music/generations` with the fields of
//   its model (Suno: inspiration mode for a message with no lyrics; Flow
//   Music: the style and the lyrics of the message, and the length of its
//   row); the app asks `/music/tasks/<id>` for the state, and shows one
//   player for each song of the task (a Suno task makes two), at the cost
//   of the task; a Suno length in inspiration mode, which APIMart refuses,
//   gets an error toast that tells how to send it, and no request goes;
// - a transcription sends the audio clip that the message names as the
//   file of a form to `/audio/transcriptions`, and the reply's text is the
//   transcript; its price is unknown, as the answer tells no cost;
// - an image request is a task too: one POST to `/images/generations`;
//   the app asks for the state of its task, stores the image of the done
//   task in the generated image folder, and the reply holds a reference to
//   it; an edit uploads its input images first and sends their web
//   addresses (`image_urls`).
//
// One app session serves the whole file; each test starts in a new tab.

const SUBMIT_PATH = `/${MART.id}/v1/videos/generations`
const taskPath = (taskId: string) => `/${MART.id}/v1/tasks/${taskId}?language=en`
const quotePath = (query: string) => `/${MART.id}/v1/pricing/model?${query}`
const MUSIC_PATH = `/${MART.id}/v1/music/generations`
const musicTaskPath = (taskId: string) => `/${MART.id}/v1/music/tasks/${taskId}?language=en`
const TRANSCRIBE_PATH = `/${MART.id}/v1/audio/transcriptions`
// The upload of an input image, for 3 days: the free tier.
const UPLOAD_PATH = `/${MART.id}/v1/uploads/images?retention_days=3`
// MiniMax-H3 takes an image whose shorter side is 256 pixels or more.
const FRAME_PNG = solidPng(320, 256, [220, 40, 40])
const IMAGE_PATH = `/${MART.id}/v1/images/generations`
// The image of the done image task.
const MADE_PNG = solidPng(24, 16, [40, 160, 60])

// An answer of the account price request (live, 2026-11-24).
const quote = (model: string, totalUsd: number) =>
  ({ billing_type: 'per_second', canonical_model: model, currency: 'USD', estimated: false, model, total_usd: totalUsd, unit: 'per_second' })
// An answer of the account price request of a music model (live,
// 2026-11-24).
const musicQuote = (model: string, totalUsd: number) =>
  ({ billing_type: 'fixed', canonical_model: model, currency: 'USD', estimated: false, model, quantity: 1, total_usd: totalUsd, unit: 'per_call', unit_price_usd: totalUsd })
// An answer of the account price request of an image model (live,
// 2026-11-25).
const imageQuote = (model: string, resolution: string, totalUsd: number) =>
  ({ billing_type: 'fixed', canonical_model: model, currency: 'USD', estimated: false, model, quantity: 1, spec: { resolution }, total_usd: totalUsd, unit: 'per_image', unit_price_usd: totalUsd })

const submitted = (taskId: string) => JSON.stringify({ code: 200, data: [{ status: 'submitted', task_id: taskId }] })
// The answer to a free upload of FRAME_PNG: it has no `overage` (the docs,
// 2026-11-25).
const uploaded = (url: string) => JSON.stringify({ url, filename: 'image-1.png', content_type: 'image/png', size: FRAME_PNG.length, retention_days: 3, expires_at: 1794182400 })

// A done music task (the live form, 2026-11-24, with most fields of a
// song cut).
const doneMusic = (taskId: string, cost: number, songUrls: string[]) => ({
  code: 200,
  data: {
    id: taskId,
    status: 'completed',
    progress: 100,
    cost,
    billing_status: 'settled',
    result: { music: songUrls.map((audio_url, index) => ({ audio_id: `song-${index + 1}`, title: 'Good Morning', duration: 2, audio_url })) },
  },
})

describe('APIMart media models', () => {
  let setup: MockProviderApp
  let browser: E2EBrowser
  let clips: ClipServer
  const tabCost = async () => sbpCall(browser, 'dez.model/tabs/costNumbers', await activeTabId(browser))

  beforeAll(async () => {
    clips = await startClipServer({
      'fox.mp4': { type: 'video/mp4', bytes: MP4_VIDEO },
      'song-1.wav': { type: 'audio/wav', bytes: silentWav(2) },
      'song-2.wav': { type: 'audio/wav', bytes: silentWav(3) },
      'made.png': { type: 'image/png', bytes: MADE_PNG },
    })
    setup = await startMockProviderApp(MART, APIMART_CONFIG, {
      heldPaths: [SUBMIT_PATH, MUSIC_PATH, TRANSCRIBE_PATH, UPLOAD_PATH, IMAGE_PATH],
      jsonAnswers: {
        [MODELS_PATH]: MODEL_LIST,
        // The free price request that goes before each request.
        [quotePath('model=MiniMax-H3&duration=4&resolution=768P')]: quote(MART.modelId, 0.22848),
        [quotePath('model=kling-v3&duration=5')]: quote(GENERAL_MODEL, 0.336),
        [quotePath('model=suno&version=v6')]: musicQuote(SUNO.id, 0.068),
        [quotePath('model=flowmusic')]: musicQuote(FLOW_MUSIC.id, 0.06),
        [quotePath('model=gpt-image-2&resolution=1k')]: imageQuote(IMAGE_MODEL, '1k', 0.0085),
        // The state of each task, which the app asks for 5 seconds after
        // the request.
        [taskPath('task-done')]: {
          code: 200,
          data: { id: 'task-done', status: 'completed', progress: 100, cost: 0.3, result: { videos: [{ url: [clips.clipUrl('fox.mp4')], expires_at: 1763174708 }] } },
        },
        [taskPath('task-failed')]: {
          code: 200,
          data: { id: 'task-failed', status: 'failed', progress: 0, cost: 0, error: { code: 400, message: 'The prompt breaks the content rules' } },
        },
        [musicTaskPath('task-suno')]: doneMusic('task-suno', 0.05, [clips.clipUrl('song-1.wav'), clips.clipUrl('song-2.wav')]),
        [musicTaskPath('task-flow')]: doneMusic('task-flow', 0.06, [clips.clipUrl('song-1.wav')]),
        // A done image task (the live form, 2026-11-25).
        [taskPath('task-image')]: {
          code: 200,
          data: { id: 'task-image', status: 'completed', progress: 100, cost: 0.009, result: { images: [{ url: [clips.clipUrl('made.png')], expires_at: 1794182400 }] } },
        },
      },
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
    await clips?.stop()
  })

  it('shows the rows that the docs tell for a model that Dez knows, and the rows of the schema for another model', async () => {
    await pickModel(browser, MART.name, MART.modelName)
    await openPopup(browser)
    // The lowest length and resolution are the defaults.
    await waitForValue(browser, 'popup of MiniMax-H3', () => popupView(browser), {
      headers: ['Model Parameters'],
      rows: [
        { name: 'duration', label: 'Length (seconds)', number: '4', min: '4', max: '15', step: '1' },
        { name: 'resolution', label: 'Resolution', options: ['768P', '2K'], picked: '768P' },
        { name: 'aspect_ratio', label: 'Aspect ratio', options: ['Default', '21:9', '16:9', '4:3', '1:1', '3:4', '9:16'], picked: 'Default' },
        { name: 'images_as', label: 'Images as', options: ['frames', 'references'], picked: 'frames' },
        { name: 'watermark', label: 'Watermark', on: false },
        { name: 'nsfw_check', label: 'Moderation check', on: false },
      ],
      hint: null,
      reset: true,
    })
    await closePopup(browser)

    // No row for the fields that Dez fills or never sends (the prompt, the
    // images, the webhook).
    await pickModel(browser, MART.name, GENERAL_MODEL)
    await openPopup(browser)
    await waitForValue(browser, 'popup of a model with the general schema', () => popupView(browser), {
      headers: ['Model Parameters'],
      rows: [
        { name: 'aspect_ratio', label: 'Aspect ratio', text: '' },
        { name: 'duration', label: 'Length (seconds)', text: '' },
        { name: 'generate_audio', label: 'Audio', on: false },
        { name: 'quality', label: 'Quality', text: '' },
        { name: 'resolution', label: 'Resolution', text: '' },
        { name: 'seed', label: 'Seed', text: '' },
        { name: 'timestamps', label: 'Timestamps', text: '' },
      ],
      hint: null,
      reset: true,
    })
    await closePopup(browser)
    expect(await consoleErrors(browser)).toStrictEqual([])
  })

  it('sends the values of the rows, asks for the state of the task, and shows the video of its file at the cost of the task', async () => {
    const prompt = 'A fox runs through deep snow'
    await pickModel(browser, MART.name, GENERAL_MODEL)
    await openPopup(browser)
    await changeParameterField(browser, 'duration', '5', 'text')
    await changeParameterField(browser, 'seed', '42', 'text')
    await click(browser, '.provider-settings-popup [data-parameter="generate_audio"]')
    await waitForValue(browser, 'rows with the values of the user', async () => (await popupView(browser)).rows.slice(1, 3), [
      { name: 'duration', label: 'Length (seconds)', text: '5' },
      { name: 'generate_audio', label: 'Audio', on: true },
    ])
    await closePopup(browser)
    await submit(browser, prompt)

    // The texts of the whole-number fields go as numbers.
    const request = await takeRequest(setup, SUBMIT_PATH, { duration: 5, seed: 42, generate_audio: true, model: GENERAL_MODEL, prompt })
    answerHeld(request.reply, 'application/json', submitted('task-done'))
    await waitForValue(browser, 'sections after the reply', async () => (await threadSections(browser)).length, 3)
    const reply = (await threadSections(browser))[1].text
    // The tag keeps the task id, the only way back to a paid clip.
    expect(reply).toMatch(new RegExp(String.raw`^<dez:video id="a" type="video/mp4" src="[^"]+\.mp4" expires="[^"]+" model="${mockModelKey(MART, GENERAL_MODEL)}" job="task-done"/>$`))
    await waitForThread(browser, [
      { role: 'user', text: prompt },
      { role: 'agent', text: reply },
      { role: 'user', text: '' },
    ])
    await waitForValue(browser, 'player of the video', () => shownPlayers(browser), [
      { kind: 'video', id: 'a', available: true, source: 'blob', seconds: 2, picture: { width: 48, height: 36 }, clock: 'Not saved', save: 'save' },
    ])
    // The cost of the task, not the quote ($0.336).
    expect(await tabCost()).toEqual({ cost: { usd: 0.3, requests: 1, unpriced: 0 } })
    expect(await consoleErrors(browser)).toStrictEqual([])
  })

  it('tells the user about a task that failed, with its id, and counts the cost that the task tells', async () => {
    const prompt = 'A fox in the rain'
    await pickModel(browser, MART.name, MART.modelName)
    await submit(browser, prompt)

    // The lowest length and resolution of the model go with no choice.
    const request = await takeRequest(setup, SUBMIT_PATH, { duration: 4, resolution: '768P', model: MART.modelId, prompt })
    answerHeld(request.reply, 'application/json', submitted('task-failed'))
    await waitForValue(browser, 'error toast of the task', async () => {
      const [toast] = await openToasts(browser, 'error')
      return toast !== undefined && toast.message.includes('Mart Mock did not make the clip.') && toast.message.includes('task-failed') && toast.message.includes('State: failed: The prompt breaks the content rules')
    }, true)
    // APIMart gave the money back: the quote ($0.22848) does not count.
    expect(await tabCost()).toEqual({ cost: { usd: 0, requests: 1, unpriced: 0 } })
    await closeToasts(browser)
  })

  it('uploads the input image of a video request, and sends its web address as the first frame', async () => {
    const uploadedUrl = 'https://cdn.example.com/uploads/frame.png'
    await pickModel(browser, MART.name, MART.modelName)
    await focusEditor(browser)
    await typeKeys(browser, 'The fox runs from ')
    await pasteImageReference(browser, FRAME_PNG, 'a')
    await submit(browser, '')

    // The file has a neutral name: it names no file of the user.
    const upload = await takeRequest(setup, UPLOAD_PATH)
    expect(upload.headers['content-type']).toMatch(/^multipart\/form-data; boundary=/)
    expect(await requestForm(upload)).toStrictEqual([{ name: 'file', fileName: 'image-1.png', type: 'image/png', bytes: FRAME_PNG }])
    answerHeld(upload.reply, 'application/json', uploaded(uploadedUrl))

    const request = await takeRequest(setup, SUBMIT_PATH, {
      duration: 4,
      resolution: '768P',
      image_with_roles: [{ url: uploadedUrl, role: 'first_frame' }],
      model: MART.modelId,
      prompt: 'The fox runs from ![id=a](image)',
    })
    answerHeld(request.reply, 'application/json', submitted('task-done'))
    await waitForValue(browser, 'player of the video', async () => (await shownPlayers(browser)).length, 1)
    // The cost of the task; the free upload counts nothing.
    expect(await tabCost()).toEqual({ cost: { usd: 0.3, requests: 1, unpriced: 0 } })
    expect(await consoleErrors(browser)).toStrictEqual([])
  })

  it('shows the rows of Suno and how lyrics turn on its Custom mode, sends a message with no lyrics in inspiration mode, and shows each song of the task at the cost of the task', async () => {
    const prompt = 'A cheerful ukulele jingle about the morning'
    await pickModel(browser, MART.name, SUNO.name)
    await openPopup(browser)
    await waitForValue(browser, 'popup of Suno', () => popupView(browser), {
      headers: ['Model Parameters', 'Lyrics'],
      rows: [
        { name: 'version', label: 'Version', options: ['v6', 'v6-wild', 'v6-mini'], picked: 'v6' },
        { name: 'custom', label: 'Custom mode', on: false },
        { name: 'instrumental', label: 'Instrumental', on: false },
        { name: 'title', label: 'Title (Custom mode)', text: '' },
        { name: 'negative_tags', label: 'Styles to avoid (Custom mode)', text: '' },
        { name: 'auto_lyrics', label: 'Rewrite the lyrics', on: false },
        { name: 'vocal_gender', label: 'Voice', options: ['Default', 'Male', 'Female'], picked: 'Default' },
        { name: 'duration', label: 'Target length (seconds, Custom mode)', number: '', min: '10', max: '360', step: '1' },
        { name: 'persona_id', label: 'Persona id (Custom mode)', text: '' },
        { name: 'custom_model_id', label: 'Custom model id', text: '' },
        { name: 'variety', label: 'Variety', options: ['Default', 'off', 'normal', 'high', 'extra', 'max'], picked: 'Default' },
        { name: 'max_mode', label: 'Max mode (Custom mode, 2× price)', on: false },
        { name: 'style_weight', label: 'Style weight', number: '', min: '0', max: '1', step: '0.1' },
        { name: 'weirdness_constraint', label: 'Weirdness', number: '', min: '0', max: '1', step: '0.1' },
        { name: 'audio_weight', label: 'Audio weight', number: '', min: '0', max: '1', step: '0.1' },
        { name: 'audio_format', label: 'File type', options: ['Default', 'mp3', 'm4a', 'wav'], picked: 'Default' },
      ],
      hint: 'To give lyrics, write the style, then a line "Lyrics:", then the lyrics. Lyrics turn on Custom mode: the text before the "Lyrics:" line is then the style (at most 1000 characters). With no lyrics, the message tells what song to make; with Custom mode and Instrumental on, it is the style of the instrumental.',
      reset: true,
    })
    await closePopup(browser)
    await submit(browser, prompt)

    // The version has a default: a request needs a version or a custom
    // model id.
    const request = await takeRequest(setup, MUSIC_PATH, { version: 'v6', custom: false, prompt, model: SUNO.id })
    answerHeld(request.reply, 'application/json', submitted('task-suno'))
    await waitForValue(browser, 'sections after the reply', async () => (await threadSections(browser)).length, 3)
    const reply = (await threadSections(browser))[1].text
    const songTag = (id: string) => String.raw`<dez:audio id="${id}" type="audio/wav" src="[^"]+\.wav" expires="[^"]+" model="${mockModelKey(MART, SUNO.id)}" job="task-suno"/>`
    expect(reply).toMatch(new RegExp(`^${songTag('a')}\n\n${songTag('b')}$`))
    await waitForThread(browser, [
      { role: 'user', text: prompt },
      { role: 'agent', text: reply },
      { role: 'user', text: '' },
    ])
    await waitForValue(browser, 'players of the two songs', () => shownPlayers(browser), [
      { kind: 'audio', id: 'a', available: true, source: 'blob', seconds: 2, picture: null, clock: 'Not saved', save: 'save' },
      { kind: 'audio', id: 'b', available: true, source: 'blob', seconds: 3, picture: null, clock: 'Not saved', save: 'save' },
    ])
    // The cost of the task counts one time, and the quote ($0.068) does not.
    expect(await tabCost()).toEqual({ cost: { usd: 0.05, requests: 1, unpriced: 0 } })
    expect(await consoleErrors(browser)).toStrictEqual([])
  })

  it('refuses a Suno length in inspiration mode before any request, with a text that tells how to send it', async () => {
    const prompt = 'make a short song about love.'
    const lengthRow = async () => (await popupView(browser)).rows.find((row) => row.name === 'duration')
    await pickModel(browser, MART.name, SUNO.name)
    await openPopup(browser)
    await changeParameterField(browser, 'duration', '30', 'number')
    await waitForValue(browser, 'length row of the user', lengthRow, { name: 'duration', label: 'Target length (seconds, Custom mode)', number: '30', min: '10', max: '360', step: '1' })
    await closePopup(browser)
    await submit(browser, prompt)

    await waitForValue(browser, 'error toast of the refusal', () => openToasts(browser, 'error'), [{
      title: 'Request failed',
      message: 'This model takes a length only in Custom mode. Write the style, then a line "Lyrics:", then the lyrics; or turn on Custom mode and Instrumental, or clear Target length, in the model parameters.',
    }])
    await waitForValue(browser, 'thread after the refusal', () => threadSections(browser), [{ role: 'user', text: prompt }])
    expect(setup.mock.hasWaitingRequest()).toBe(false)
    await closeToasts(browser)
    await waitForValue(browser, 'error toast closed', () => openToasts(browser, 'error'), [])
    // The stored length would refuse each later Suno request of the file.
    await openPopup(browser)
    await click(browser, '.provider-settings-reset')
    await waitForValue(browser, 'length row after the reset', lengthRow, { name: 'duration', label: 'Target length (seconds, Custom mode)', number: '', min: '10', max: '360', step: '1' })
    await closePopup(browser)
  })

  it('sends the style and the lyrics of a message, and the length of its row, to Flow Music', async () => {
    const message = 'Upbeat synth pop\nLyrics:\nLa la la, the city lights'
    await pickModel(browser, MART.name, FLOW_MUSIC.name)
    await openPopup(browser)
    await changeParameterField(browser, 'length', '30', 'number')
    await waitForValue(browser, 'length row of the user', async () => (await popupView(browser)).rows.find((row) => row.name === 'length'), { name: 'length', label: 'Target length (seconds)', number: '30', min: '1', max: '240', step: '1' })
    await closePopup(browser)
    await setCaret(browser, (await editorDoc(browser)).length)
    await pasteText(browser, message)
    await waitForValue(browser, 'message with the lyrics', () => threadSections(browser), [{ role: 'user', text: message }])
    await submit(browser, '')

    const request = await takeRequest(setup, MUSIC_PATH, { length: 30, sound_prompt: 'Upbeat synth pop', lyrics: 'La la la, the city lights', model: FLOW_MUSIC.id })
    answerHeld(request.reply, 'application/json', submitted('task-flow'))
    await waitForValue(browser, 'player of the song', () => shownPlayers(browser), [
      { kind: 'audio', id: 'a', available: true, source: 'blob', seconds: 2, picture: null, clock: 'Not saved', save: 'save' },
    ])
    expect((await threadSections(browser))[1].text).toMatch(new RegExp(String.raw`^<dez:audio id="a" type="audio/wav" src="[^"]+\.wav" expires="[^"]+" model="${mockModelKey(MART, FLOW_MUSIC.id)}" job="task-flow"/>$`))
    expect(await tabCost()).toEqual({ cost: { usd: 0.06, requests: 1, unpriced: 0 } })
    expect(await consoleErrors(browser)).toStrictEqual([])
  })

  it('sends the named audio clip to a transcription model as a form file, writes the transcript as the reply, and counts its price as unknown', async () => {
    const speech = silentWav(3)
    const tag = await tempClipTag(setup.app.home, 'audio', 'a', 'speech.wav', speech)
    await openSeededConversation(browser, setup.app.home, 'apimart-transcribe', [
      { role: 'user', text: 'Make a clip' },
      { role: 'agent', text: tag },
      { role: 'user', text: 'Write down @a' },
    ])
    await pickModel(browser, MART.name, WHISPER)
    await submit(browser, '')

    const request = await takeRequest(setup, TRANSCRIBE_PATH)
    expect(request.headers['content-type']).toMatch(/^multipart\/form-data; boundary=/)
    // No prompt, and no times: only a `model_invoke` call asks for them.
    expect(await requestForm(request)).toStrictEqual([
      { name: 'model', value: WHISPER },
      { name: 'response_format', value: 'json' },
      { name: 'file', fileName: 'clip.wav', type: 'audio/wav', bytes: speech },
    ])
    // The live answer of `json` (2026-11-24).
    answerHeld(request.reply, 'application/json', JSON.stringify({ text: 'Hello from Ben. This is a short test.', usage: { type: 'duration', seconds: 4 } }))

    await waitForThread(browser, [
      { role: 'user', text: 'Make a clip' },
      { role: 'agent', text: tag },
      { role: 'user', text: 'Write down @a' },
      { role: 'agent', text: 'Hello from Ben. This is a short test.' },
      { role: 'user', text: '' },
    ])
    expect(await tabCost()).toEqual({ cost: { usd: 0, requests: 1, unpriced: 1 } })
    expect(await consoleErrors(browser)).toStrictEqual([])
  })

  it('shows the rows that the docs tell for an image model, sends its request as a task, and stores the image of the done task at the cost of the task', async () => {
    const prompt = 'Draw a green box'
    const before = await filesIn(generatedImagesDir(setup.app.home))
    await pickModel(browser, MART.name, IMAGE_MODEL)
    await openPopup(browser)
    await waitForValue(browser, 'popup of gpt-image-2', () => popupView(browser), {
      headers: ['Model Parameters'],
      rows: [
        { name: 'size', label: 'Aspect ratio', options: ['Default', 'auto', '1:1', '3:2', '2:3', '4:3', '3:4', '5:4', '4:5', '16:9', '9:16', '2:1', '1:2', '3:1', '1:3', '21:9', '9:21'], picked: 'Default' },
        { name: 'resolution', label: 'Resolution', options: ['1k', '2k', '4k'], picked: '1k' },
        { name: 'nsfw_check', label: 'Moderation check', on: false },
      ],
      hint: null,
      reset: true,
    })
    await closePopup(browser)
    await submit(browser, prompt)

    // The lowest resolution goes with no choice.
    const request = await takeRequest(setup, IMAGE_PATH, { resolution: '1k', model: IMAGE_MODEL, prompt })
    answerHeld(request.reply, 'application/json', submitted('task-image'))
    const name = await newFileIn(browser, generatedImagesDir(setup.app.home), before)
    expect(name).toMatch(storedFileName('png'))
    const file = path.join(generatedImagesDir(setup.app.home), name)
    expect(await fs.promises.readFile(file)).toEqual(MADE_PNG)
    await waitForThread(browser, [
      { role: 'user', text: prompt },
      { role: 'agent', text: `![id=a|model=${mockModelKey(MART, IMAGE_MODEL)}](${file})` },
      { role: 'user', text: '' },
    ])
    // The cost of the task, not the quote ($0.0085).
    expect(await tabCost()).toEqual({ cost: { usd: 0.009, requests: 1, unpriced: 0 } })
    expect(await consoleErrors(browser)).toStrictEqual([])
  })

  it('uploads the input image of an image edit, and sends its web address in the request of the task', async () => {
    const uploadedUrl = 'https://cdn.example.com/uploads/box.png'
    const before = await filesIn(generatedImagesDir(setup.app.home))
    await pickModel(browser, MART.name, IMAGE_MODEL)
    await focusEditor(browser)
    await typeKeys(browser, 'Make it green: ')
    await pasteImageReference(browser, FRAME_PNG, 'a')
    await submit(browser, '')

    const upload = await takeRequest(setup, UPLOAD_PATH)
    expect(await requestForm(upload)).toStrictEqual([{ name: 'file', fileName: 'image-1.png', type: 'image/png', bytes: FRAME_PNG }])
    answerHeld(upload.reply, 'application/json', uploaded(uploadedUrl))

    const request = await takeRequest(setup, IMAGE_PATH, { resolution: '1k', image_urls: [uploadedUrl], model: IMAGE_MODEL, prompt: 'Make it green: ![id=a](image)' })
    answerHeld(request.reply, 'application/json', submitted('task-image'))
    const name = await newFileIn(browser, generatedImagesDir(setup.app.home), before)
    const file = path.join(generatedImagesDir(setup.app.home), name)
    await waitForValue(browser, 'reply with the image of the task', async () => (await threadSections(browser))[1]?.text, `![id=b|model=${mockModelKey(MART, IMAGE_MODEL)}](${file})`)
    // The cost of the task; the free upload counts nothing.
    expect(await tabCost()).toEqual({ cost: { usd: 0.009, requests: 1, unpriced: 0 } })
    expect(await consoleErrors(browser)).toStrictEqual([])
  })
})
