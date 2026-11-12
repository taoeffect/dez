import fs from 'node:fs'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { click, consoleErrors, resetConsoleErrors, screenshotOnFailure, typeKeys, waitForValue } from './harness/dom'
import { readAppState } from './harness/fixtures'
import { decodedImage, pasteImageReference, pngDataUrl, solidPng, stripedPng, type Rgb } from './harness/images'
import { WEBM_VIDEO, answerVeniceJob, shownPlayers } from './harness/media'
import { expectSendRefused, startMockProviderApp, takeRequest, type MockProviderApp } from './harness/mockProviderApp'
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
//   and a warning toast tells of a third one;
// - a model that refuses the last frame (Venice's 400 for
//   `end_image_url`) gets an error toast that tells to keep one image, and
//   the request does not go again; Dez keeps the count of the refusal, so
//   the same message sent again gets the error toast with no request;
// - an image that passes the size rules of the model's entry goes as its
//   own bytes (the tests above); one that breaks them goes as a copy that
//   passes them (the part in its middle, scaled), and the stored file and
//   the message stay as they are;
// - a reference-to-video model (only its id tells it) gets the images of
//   the message in `reference_image_urls`, not as frames, and its prompt
//   names each image by its place in that list (`@Image1`), in place of
//   the reference and of each mention.
//
// One app session serves the whole file; each test starts in a new tab.

const FILMS: MockProvider = { id: 'films', name: 'Films Mock', modelId: 'frames-model', modelName: 'Frames Model' }
const QUEUE_PATH = `/${FILMS.id}/v1/video/queue`
const RETRIEVE_PATH = `/${FILMS.id}/v1/video/retrieve`
// A Grok reference-to-video model: it takes 7 references, named `@Image1`
// and on (veniceReferences.ts).
const REFERENCES = { id: 'grok-imagine-reference-to-video-mock', name: 'References Model' }

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
        // The size rules of a frame: a ratio (width / height) between the
        // two limits. The 48 x 32 images of the tests pass them.
        reference_image_min_short_side_pixels: 32,
        reference_image_min_aspect_ratio: 0.4,
        reference_image_max_aspect_ratio: 2.5,
      },
    },
  }, {
    id: REFERENCES.id,
    name: REFERENCES.name,
    type: 'video',
    model_spec: {
      constraints: {
        model_type: 'image-to-video',
        durations: ['10s', '5s'],
        resolutions: ['720p', '480p'],
        aspect_ratios: [],
        audio_configurable: true,
      },
    },
  }],
}

const RED: Rgb = [220, 40, 40]
const GREEN: Rgb = [40, 160, 60]
const BLUE: Rgb = [40, 90, 220]
const FIRST_PNG = solidPng(48, 32, RED)
const LAST_PNG = solidPng(48, 32, BLUE)
const THIRD_PNG = solidPng(48, 32, GREEN)
// 90 x 20, in three stripes of 30 columns: wider than the model's rules
// allow, and its shorter side is too short.
const WIDE_PNG = stripedPng(30, 20, [RED, GREEN, BLUE])

describe('image-to-video models', () => {
  let setup: MockProviderApp
  let browser: E2EBrowser

  // Types `text` at the caret, then pastes `png` there and waits for its
  // reference, which gets the image id `id`.
  async function typeThenPaste (text: string, png: Buffer, id: string): Promise<void> {
    await typeKeys(browser, text)
    await pasteImageReference(browser, png, id)
  }

  // Takes the queue request of a submit and checks its body, which is for
  // the frames model unless `body` names another.
  async function queueRequest (body: Record<string, unknown>): Promise<HeldRequest> {
    return takeRequest(setup, QUEUE_PATH, { model: FILMS.modelId, ...body })
  }

  // Answers the queue request with the id of its job, and the ask for the
  // state of the job with the clip. Returns the tag of the clip, which the
  // reply `agentIndex` then holds as its whole text.
  async function answerJob (queue: HeldRequest, queueId: string, agentIndex: number, modelId = FILMS.modelId): Promise<string> {
    return answerVeniceJob(setup, queue, { retrievePath: RETRIEVE_PATH, modelId, queueId, clip: { type: 'video/webm', bytes: WEBM_VIDEO }, replyIndex: agentIndex })
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

    await expectSendRefused(setup, refusal, [{ role: 'user', text: 'The fox runs:' }])
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
      image_url: pngDataUrl(FIRST_PNG),
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
    const next = await queueRequest({ prompt: 'Now it jumps.', duration: '5s', resolution: '480p', audio: true, image_url: pngDataUrl(FIRST_PNG) })
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
      image_url: pngDataUrl(FIRST_PNG),
      end_image_url: pngDataUrl(LAST_PNG),
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

  // Keep this test after the two-frames test: after it, Dez refuses a
  // message with more than one image to the frames model.
  it('tells to keep one image when the model refuses the last frame, and refuses the same message again before any request', async () => {
    const message = `${FILMS.modelName} takes only 1 image, and this message has 2. Keep only 1 image in the message (pasted, or named with @id), and send it again.`
    await pickModel(browser, FILMS.name, FILMS.modelName)
    await focusEditor(browser)
    await typeThenPaste('From ', FIRST_PNG, 'a')
    await typeThenPaste(' to ', LAST_PNG, 'b')
    const text = (await threadSections(browser))[0].text
    await submit(browser, '')

    const queue = await queueRequest({
      prompt: 'From ![image](id=a) to ![image](id=b)',
      duration: '5s',
      resolution: '480p',
      audio: true,
      image_url: pngDataUrl(FIRST_PNG),
      end_image_url: pngDataUrl(LAST_PNG),
    })
    // The answer of Venice to a model that has no last frame.
    queue.reply.writeHead(400, { 'Content-Type': 'application/json' })
    queue.reply.end(JSON.stringify({
      details: { _errors: [], end_image_url: { _errors: ['This model does not support end_image_url'] } },
      error: 'Invalid request parameters',
    }))

    await waitForValue(browser, 'error toast', () => openToasts(browser, 'error'), [{ title: 'Request failed', message }])
    // Closed first, so that a later failure here leaves no toast for the
    // next test (`waitForThread` wants none).
    await click(browser, '.toast-card--error .toast-close')
    await waitForValue(browser, 'error toast closed', () => openToasts(browser, 'error'), [])
    await waitForThread(browser, [{ role: 'user', text }])
    expect(setup.mock.hasWaitingRequest()).toBe(false)
    expect(await consoleErrors(browser)).toStrictEqual([
      expect.stringMatching(new RegExp(`^${FILMS.name} refused the images of a request to ${FILMS.modelId}: `)),
      expect.stringMatching(/^Media request failed: /),
    ])
    await resetConsoleErrors(browser)

    // The model's entry in the list of the mock did not change, so Dez
    // keeps the count of the refusal (learnedImageLimit.ts), and the
    // provider gets no second request.
    await submit(browser, '')

    await expectSendRefused(setup, message, [{ role: 'user', text }])
  })

  it('sends a copy that passes the size rules of the model for an image that breaks them, and keeps the stored image', async () => {
    await pickModel(browser, FILMS.name, FILMS.modelName)
    await focusEditor(browser)
    await typeThenPaste('Wide: ', WIDE_PNG, 'a')
    const message = (await threadSections(browser))[0].text
    await submit(browser, '')

    const queue = await queueRequest({
      prompt: 'Wide: ![image](id=a)',
      duration: '5s',
      resolution: '480p',
      audio: true,
      image_url: expect.stringMatching(/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/),
    })
    // The copy is the 49 columns in the middle of the image (20 to 68: a
    // ratio just under 2.5), scaled until the shorter side has 32 pixels.
    // So it shows 10 red, 30 green, and 9 blue columns, each 78 / 49 times
    // as wide: the green stripe goes from column 16 to column 63. A copy
    // of the whole image, or of a part at one of its sides, has another
    // color in column 4, 24, or 54.
    const opaque = (rgb: Rgb): number[] => [...rgb, 255]
    expect(await decodedImage(browser, JSON.parse(queue.body).image_url, [4, 24, 39, 54, 73])).toStrictEqual({
      width: 78,
      height: 32,
      pixels: [opaque(RED), opaque(GREEN), opaque(GREEN), opaque(GREEN), opaque(BLUE)],
    })

    const clip = await answerJob(queue, 'queue-4', 1)
    expect(clip).toMatch(/^<dez:video id="b" type="video\/webm" src="[^"]+\.webm" expires="[^"]+" job="queue-4"\/>$/)
    await waitForThread(browser, [{ role: 'user', text: message }, { role: 'agent', text: clip }, { role: 'user', text: '' }])
    const storedPath = message.slice('Wide: !['.length, message.indexOf(']('))
    expect(await fs.promises.readFile(storedPath)).toStrictEqual(WIDE_PNG)
    expect(await consoleErrors(browser)).toStrictEqual([])
  })

  it('sends the images of a message to a reference-to-video model as its references, and names them in the prompt', async () => {
    await pickModel(browser, FILMS.name, REFERENCES.name)
    await focusEditor(browser)
    await typeThenPaste('The fox ', FIRST_PNG, 'a')
    await typeThenPaste(' meets the bird ', LAST_PNG, 'b')
    await typeThenPaste(' in the park ', THIRD_PNG, 'c')
    await typeKeys(browser, '. Keep @a in front.')
    const message = (await threadSections(browser))[0].text
    await submit(browser, '')

    const queue = await queueRequest({
      model: REFERENCES.id,
      prompt: 'The fox @Image1 meets the bird @Image2 in the park @Image3. Keep @Image1 in front.',
      duration: '5s',
      resolution: '480p',
      audio: true,
      reference_image_urls: [pngDataUrl(FIRST_PNG), pngDataUrl(LAST_PNG), pngDataUrl(THIRD_PNG)],
    })
    const clip = await answerJob(queue, 'queue-5', 1, REFERENCES.id)

    expect(clip).toMatch(/^<dez:video id="d" type="video\/webm" src="[^"]+\.webm" expires="[^"]+" job="queue-5"\/>$/)
    // The message keeps its references and its mention.
    await waitForThread(browser, [{ role: 'user', text: message }, { role: 'agent', text: clip }, { role: 'user', text: '' }])
    expect(message).toMatch(/^The fox !\[[^\]]+\]\(id=a\) meets the bird !\[[^\]]+\]\(id=b\) in the park !\[[^\]]+\]\(id=c\)\. Keep @a in front\.$/)
    expect(await openToasts(browser, 'warning')).toStrictEqual([])
    expect(await consoleErrors(browser)).toStrictEqual([])
  })
})
