import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { click, consoleErrors, resetConsoleErrors, screenshotOnFailure, typeKeys, waitForValue } from './harness/dom'
import { readAppState } from './harness/fixtures'
import { pasteImage, solidPng } from './harness/images'
import { WEBM_VIDEO, shownPlayers } from './harness/media'
import { startMockProviderApp, type MockProviderApp } from './harness/mockProviderApp'
import type { HeldRequest, MockProvider } from './harness/mockServer'
import { closePopup, openPopup, popupOpen, popupView, type PopupView } from './harness/parameterPopup'
import type { E2EBrowser } from './harness/session'
import { editorDoc, focusEditor, newTab, openToasts, pickModel, setCaret, submit, threadSections, waitForThread } from './harness/thread'

// Image-to-video models, driven through the real app against a mock of
// Venice's media API (`mediaApi: { format: 'venice' }`). The mock also
// serves the model list, in the form of Venice's list: the request kind of
// a video model and what a request to it can set are read from its entry.
// - a message to an image-to-video model in a conversation with no image
//   gets an error toast, and no request goes;
// - an image that the user pastes into the message goes to `/video/queue`
//   as the first frame, as a data URL with no path; the clip of the job
//   becomes a player;
// - a later message with no image makes its video from the newest image
//   of the conversation;
// - the provider settings popup shows the parameters of the model: no row
//   for a list that is empty, and an "Audio" switch that is on until the
//   user turns it off;
// - the first two images of a message go as the first and the last frame,
//   and a warning toast tells of a third one.
//
// One app session serves the whole file; each test starts in a new tab.

const FILMS: MockProvider = { id: 'films', name: 'Films Mock', modelId: 'frames-model', modelName: 'Frames Model' }
const QUEUE_PATH = `/${FILMS.id}/v1/video/queue`
const RETRIEVE_PATH = `/${FILMS.id}/v1/video/retrieve`

const MODEL_LIST = {
  object: 'list',
  data: [{
    id: FILMS.modelId,
    name: FILMS.modelName,
    type: 'video',
    model_spec: {
      constraints: {
        model_type: 'image-to-video',
        durations: ['10s', '5s'],
        resolutions: ['720p', '480p'],
        // As for a model whose clip takes the shape of its first frame.
        aspect_ratios: [],
        audio_configurable: true,
      },
    },
  }],
}

const FIRST_PNG = solidPng(48, 32, [220, 40, 40])
const LAST_PNG = solidPng(48, 32, [40, 90, 220])
const THIRD_PNG = solidPng(48, 32, [40, 160, 60])
const dataUrl = (png: Buffer): string => `data:image/png;base64,${png.toString('base64')}`

describe('image-to-video models', () => {
  let setup: MockProviderApp
  let browser: E2EBrowser

  // Types `text` at the caret, then pastes `png` there and waits for its
  // reference, which gets the image id `id`.
  async function typeThenPaste (text: string, png: Buffer, id: string): Promise<void> {
    await typeKeys(browser, text)
    await pasteImage(browser, png)
    await waitForValue(browser, `reference of the image ${id}`, async () => (await threadSections(browser)).at(-1)?.text.endsWith(`](id=${id})`), true)
  }

  // Takes the queue request of a submit and checks its body.
  async function queueRequest (body: Record<string, unknown>): Promise<HeldRequest> {
    const queue = await setup.mock.waitForRequest(browser)
    expect(queue.path).toBe(QUEUE_PATH)
    expect(JSON.parse(queue.body)).toStrictEqual({ model: FILMS.modelId, ...body })
    expect(queue.body).not.toContain(setup.app.home)
    return queue
  }

  // Answers the queue request with the id of its job. The app asks for the
  // state of the job 5 seconds later, and the answer of a job that is done
  // is the clip. Returns the tag of the clip, which the reply `agentIndex`
  // then holds as its whole text.
  async function answerJob (queue: HeldRequest, queueId: string, agentIndex: number): Promise<string> {
    queue.reply.writeHead(200, { 'Content-Type': 'application/json' })
    queue.reply.end(JSON.stringify({ model: FILMS.modelId, queue_id: queueId, status: 'QUEUED' }))

    const retrieve = await setup.mock.waitForRequest(browser)
    expect(retrieve.path).toBe(RETRIEVE_PATH)
    expect(JSON.parse(retrieve.body)).toStrictEqual({ model: FILMS.modelId, queue_id: queueId })
    retrieve.reply.writeHead(200, { 'Content-Type': 'video/webm' })
    retrieve.reply.end(WEBM_VIDEO)

    await waitForValue(browser, 'sections after the reply', async () => (await threadSections(browser)).length, agentIndex + 2)
    return (await threadSections(browser))[agentIndex].text
  }

  beforeAll(async () => {
    setup = await startMockProviderApp(FILMS, {
      mediaApi: { format: 'venice' },
      // Every model comes from the list of the mock.
      fetchModels: true,
      models: [],
      modelOutputs: {
        path: 'type',
        values: {
          video: {
            outputs: ['video'],
            requestBy: { path: 'model_spec.constraints.model_type', values: { 'text-to-video': 'video', 'image-to-video': 'imageToVideo' } },
          },
        },
      },
    }, {
      heldPaths: [QUEUE_PATH, RETRIEVE_PATH],
      jsonAnswers: { [`/${FILMS.id}/v1/models`]: MODEL_LIST },
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

  it('refuses a video in a conversation with no image, then makes one from the pasted image, and the next from the newest image', async () => {
    const refusal = `${FILMS.modelName} makes a video from an image. Paste an image, or name one with @id.`
    await pickModel(browser, FILMS.name, FILMS.modelName)
    await submit(browser, 'The fox runs:')

    await waitForValue(browser, 'error toast', () => openToasts(browser, 'error'), [{ title: 'Cannot send', message: refusal }])
    expect(await threadSections(browser)).toStrictEqual([{ role: 'user', text: 'The fox runs:' }])
    expect(setup.mock.hasWaitingRequest()).toBe(false)
    expect(await consoleErrors(browser)).toStrictEqual([`Cannot send: ${refusal}`])
    await click(browser, '.toast-card--error .toast-close')
    await waitForValue(browser, 'error toast closed', () => openToasts(browser, 'error'), [])
    await resetConsoleErrors(browser)

    // The image goes into the same message, after its text.
    await focusEditor(browser)
    await setCaret(browser, (await editorDoc(browser)).length)
    await typeThenPaste(' ', FIRST_PNG, 'a')
    const message = (await threadSections(browser))[0].text
    await submit(browser, '')

    // The length and the resolution are the lowest of the model's lists.
    const queue = await queueRequest({
      prompt: 'The fox runs: ![image](id=a)',
      duration: '5s',
      resolution: '480p',
      audio: true,
      image_url: dataUrl(FIRST_PNG),
    })
    const clip = await answerJob(queue, 'queue-1', 1)

    // The tag keeps the id of the job, the only way back to a paid clip.
    expect(clip).toMatch(/^<dez:video id="b" type="video\/webm" src="[^"]+\.webm" expires="[^"]+" job="queue-1"\/>$/)
    const first = [{ role: 'user', text: message }, { role: 'agent', text: clip }]
    await waitForThread(browser, [...first, { role: 'user', text: '' }])
    await waitForValue(browser, 'player of the video', () => shownPlayers(browser), [
      { kind: 'video', id: 'b', available: true, source: 'blob', seconds: 2, picture: { width: 48, height: 36 }, clock: 'Not saved', save: 'save' },
    ])

    // The new message has no image: the clip is not one, so the pasted
    // image is the newest.
    await submit(browser, 'Now it jumps.')
    const next = await queueRequest({ prompt: 'Now it jumps.', duration: '5s', resolution: '480p', audio: true, image_url: dataUrl(FIRST_PNG) })
    const nextClip = await answerJob(next, 'queue-2', 3)

    expect(nextClip).toMatch(/^<dez:video id="c" type="video\/webm" src="[^"]+\.webm" expires="[^"]+" job="queue-2"\/>$/)
    await waitForThread(browser, [...first, { role: 'user', text: 'Now it jumps.' }, { role: 'agent', text: nextClip }, { role: 'user', text: '' }])
    expect(await consoleErrors(browser)).toStrictEqual([])
  })

  it('shows the parameters of an image-to-video model, and sends the first two images of a message as the first and the last frame', async () => {
    const defaults: PopupView = {
      headers: ['Model Parameters'],
      // The model's list of aspect ratios is empty, so it has no row.
      rows: [
        { name: 'duration', label: 'Length', options: ['5s', '10s'], picked: '5s' },
        { name: 'resolution', label: 'Resolution', options: ['480p', '720p'], picked: '480p' },
        { name: 'audio', label: 'Audio', on: true },
      ],
      hint: null,
      reset: true,
    }
    const storedParameters = async () => (await readAppState(setup.app.home))?.modelParameters?.[`${FILMS.id}/${FILMS.modelId}`] ?? null
    await pickModel(browser, FILMS.name, FILMS.modelName)
    await openPopup(browser)
    await waitForValue(browser, 'popup of the video model', () => popupView(browser), defaults)

    await click(browser, '.provider-settings-popup [data-parameter="audio"]')
    await waitForValue(browser, 'popup with the sound off', () => popupView(browser), {
      ...defaults,
      rows: [...defaults.rows.slice(0, 2), { name: 'audio', label: 'Audio', on: false }],
    })
    await waitForValue(browser, 'stored values', storedParameters, { audio: false })
    await closePopup(browser)

    await focusEditor(browser)
    await typeThenPaste('From ', FIRST_PNG, 'a')
    await typeThenPaste(' to ', LAST_PNG, 'b')
    await typeThenPaste(', not ', THIRD_PNG, 'c')
    await submit(browser, '')

    const queue = await queueRequest({
      prompt: 'From ![image](id=a) to ![image](id=b), not ![image](id=c)',
      duration: '5s',
      resolution: '480p',
      audio: false,
      image_url: dataUrl(FIRST_PNG),
      end_image_url: dataUrl(LAST_PNG),
    })
    await waitForValue(browser, 'warning toast', () => openToasts(browser, 'warning'), [{
      title: 'Image not sent',
      message: `${FILMS.modelName} takes only 2 images, so 1 image was left out of the request.`,
    }])
    expect(await answerJob(queue, 'queue-3', 1)).toMatch(/^<dez:video id="d" type="video\/webm" src="[^"]+\.webm" expires="[^"]+" job="queue-3"\/>$/)

    // The other tests send the default of the switch.
    await openPopup(browser)
    await click(browser, '.provider-settings-reset')
    await waitForValue(browser, 'popup after the reset', () => popupView(browser), defaults)
    await waitForValue(browser, 'stored values after the reset', storedParameters, null)
    await closePopup(browser)
    expect(await consoleErrors(browser)).toStrictEqual([])
  })
})
