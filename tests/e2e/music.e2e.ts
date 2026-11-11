import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { click, consoleErrors, resetConsoleErrors, screenshotOnFailure, waitForValue } from './harness/dom'
import { readAppState } from './harness/fixtures'
import { shownPlayers, silentWav } from './harness/media'
import { startMockProviderApp, type MockProviderApp } from './harness/mockProviderApp'
import type { MockProvider } from './harness/mockServer'
import { changeParameterField, closePopup, openPopup, popupOpen, popupView, type PopupView } from './harness/parameterPopup'
import type { E2EBrowser } from './harness/session'
import { editorDoc, newTab, openToasts, pasteText, pickModel, setCaret, submit, threadSections, waitForThread } from './harness/thread'

// Music models, driven through the real app against a mock of Venice's
// media API (`mediaApi: { format: 'venice' }`). The mock also serves the
// model list, in the form of Venice's list: what a request to a model can
// set is read from the model's entry, and a config model has no entry.
// - the provider settings popup shows the parameters of a music model (an
//   option list, a number with a step, a switch) and how to write lyrics;
//   it stores what the user sets, and "Reset to defaults" removes it;
// - a model that needs lyrics shows only the lyrics text, and no Reset;
// - a message with no lyrics to a model that needs them gets an error
//   toast, and no request goes;
// - a message with a `Lyrics:` line is one request to `/audio/queue` with
//   the text before the line as the prompt and the text after it as the
//   lyrics; the clip of the job becomes a player.
//
// One app session serves the whole file; each test starts in a new tab.

const SONGS: MockProvider = { id: 'songs', name: 'Songs Mock', modelId: 'song-model', modelName: 'Song Model' }
const LYRICS_MODEL = { id: 'lyrics-model', name: 'Lyrics Model' }
const QUEUE_PATH = `/${SONGS.id}/v1/audio/queue`
const RETRIEVE_PATH = `/${SONGS.id}/v1/audio/retrieve`

const MODEL_LIST = {
  object: 'list',
  data: [
    // Takes lyrics, and has one parameter of each kind.
    {
      id: SONGS.modelId,
      name: SONGS.modelName,
      type: 'music',
      model_spec: {
        duration_options: [60, 90],
        default_duration: 60,
        supports_speed: true,
        min_speed: 0.5,
        max_speed: 2,
        default_speed: 1,
        supports_force_instrumental: true,
        supports_lyrics: true,
        lyrics_required: false,
      },
    },
    // Makes no song without lyrics, and has no parameter.
    {
      id: LYRICS_MODEL.id,
      name: LYRICS_MODEL.name,
      type: 'music',
      model_spec: {
        supports_lyrics: true,
        lyrics_required: true,
        min_prompt_length: 10,
        prompt_character_limit: 300,
        lyrics_character_limit: 3000,
      },
    },
  ],
}

const TONE = silentWav(2)
const STYLE = 'Slow piano ballad'
const LYRICS = 'Rain on the roof\nAll night long'

describe('music models', () => {
  let setup: MockProviderApp
  let browser: E2EBrowser

  // The values that app_state.json holds for the model `modelId`, or null.
  async function storedParameters (modelId: string): Promise<unknown> {
    return (await readAppState(setup.app.home))?.modelParameters?.[`${SONGS.id}/${modelId}`] ?? null
  }

  beforeAll(async () => {
    setup = await startMockProviderApp(SONGS, {
      mediaApi: { format: 'venice' },
      // Every model comes from the list of the mock.
      fetchModels: true,
      models: [],
      modelOutputs: { path: 'type', values: { music: { outputs: ['audio'], request: 'music' } } },
    }, {
      heldPaths: [QUEUE_PATH, RETRIEVE_PATH],
      jsonAnswers: { [`/${SONGS.id}/v1/models`]: MODEL_LIST },
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

  it('shows the parameters of a music model and how to write lyrics, stores what the user sets, and resets it', async () => {
    const defaults: PopupView = {
      headers: ['Model Parameters', 'Lyrics'],
      rows: [
        { name: 'duration_seconds', label: 'Length (seconds)', options: ['60', '90'], picked: '60' },
        { name: 'speed', label: 'Speed', number: '1', min: '0.5', max: '2', step: '0.05' },
        { name: 'force_instrumental', label: 'Instrumental', on: false },
      ],
      hint: 'To give lyrics, write the style, then a line "Lyrics:", then the lyrics.',
      reset: true,
    }
    await pickModel(browser, SONGS.name, SONGS.modelName)
    await openPopup(browser)
    await waitForValue(browser, 'popup of the song model', () => popupView(browser), defaults)

    await changeParameterField(browser, 'duration_seconds', '90', 'option')
    // A number between two steps becomes the nearer step.
    await changeParameterField(browser, 'speed', '1.33', 'number')
    await click(browser, '.provider-settings-popup [data-parameter="force_instrumental"]')
    await waitForValue(browser, 'popup with the values of the user', () => popupView(browser), {
      ...defaults,
      rows: [
        { name: 'duration_seconds', label: 'Length (seconds)', options: ['60', '90'], picked: '90' },
        { name: 'speed', label: 'Speed', number: '1.35', min: '0.5', max: '2', step: '0.05' },
        { name: 'force_instrumental', label: 'Instrumental', on: true },
      ],
    })
    await waitForValue(browser, 'stored values', () => storedParameters(SONGS.modelId), {
      duration_seconds: 90,
      speed: 1.35,
      force_instrumental: true,
    })

    await click(browser, '.provider-settings-reset')
    await waitForValue(browser, 'popup after the reset', () => popupView(browser), defaults)
    await waitForValue(browser, 'stored values after the reset', () => storedParameters(SONGS.modelId), null)
    await closePopup(browser)

    // A model with no parameter has nothing to reset.
    await pickModel(browser, SONGS.name, LYRICS_MODEL.name)
    await openPopup(browser)
    await waitForValue(browser, 'popup of the model that needs lyrics', () => popupView(browser), {
      headers: ['Lyrics'],
      rows: [],
      hint: 'This model needs lyrics. Write the style, then a line "Lyrics:", then the lyrics.',
      reset: false,
    })
    await closePopup(browser)
    expect(await consoleErrors(browser)).toStrictEqual([])
  })

  it('refuses a song with no lyrics for a model that needs them, then sends the style and the lyrics of a message with a "Lyrics:" line', async () => {
    const refusal = `${LYRICS_MODEL.name} needs lyrics. Write the style, then a line "Lyrics:", then the lyrics.`
    await pickModel(browser, SONGS.name, LYRICS_MODEL.name)
    await submit(browser, STYLE)

    await waitForValue(browser, 'error toast', () => openToasts(browser, 'error'), [{ title: 'Cannot send', message: refusal }])
    expect(await threadSections(browser)).toStrictEqual([{ role: 'user', text: STYLE }])
    expect(setup.mock.hasWaitingRequest()).toBe(false)
    expect(await consoleErrors(browser)).toStrictEqual([`Cannot send: ${refusal}`])
    await click(browser, '.toast-card--error .toast-close')
    await waitForValue(browser, 'error toast closed', () => openToasts(browser, 'error'), [])
    await resetConsoleErrors(browser)

    // The lyrics go into the same message, after the style.
    const message = `${STYLE}\n\nLyrics:\n${LYRICS}`
    await setCaret(browser, (await editorDoc(browser)).length)
    await pasteText(browser, message.slice(STYLE.length))
    await waitForValue(browser, 'message with the lyrics', () => threadSections(browser), [{ role: 'user', text: message }])
    await submit(browser, '')

    const queue = await setup.mock.waitForRequest(browser)
    expect(queue.path).toBe(QUEUE_PATH)
    expect(JSON.parse(queue.body)).toStrictEqual({ model: LYRICS_MODEL.id, prompt: STYLE, lyrics_prompt: LYRICS })
    queue.reply.writeHead(200, { 'Content-Type': 'application/json' })
    queue.reply.end(JSON.stringify({ model: LYRICS_MODEL.id, queue_id: 'queue-1', status: 'QUEUED' }))

    // The app asks for the state of the job 5 seconds later. The answer of
    // a job that is done is the clip.
    const retrieve = await setup.mock.waitForRequest(browser)
    expect(retrieve.path).toBe(RETRIEVE_PATH)
    expect(JSON.parse(retrieve.body)).toStrictEqual({ model: LYRICS_MODEL.id, queue_id: 'queue-1' })
    retrieve.reply.writeHead(200, { 'Content-Type': 'audio/wav' })
    retrieve.reply.end(TONE)

    await waitForValue(browser, 'sections of the reply', async () => (await threadSections(browser)).map((section) => section.role), ['user', 'agent', 'user'])
    const reply = (await threadSections(browser))[1].text
    // The tag keeps the id of the job, the only way back to a paid clip.
    expect(reply).toMatch(/^<dez:audio id="a" type="audio\/wav" src="[^"]+\.wav" expires="[^"]+" job="queue-1"\/>$/)
    await waitForThread(browser, [
      { role: 'user', text: message },
      { role: 'agent', text: reply },
      { role: 'user', text: '' },
    ])
    await waitForValue(browser, 'player of the song', () => shownPlayers(browser), [
      { kind: 'audio', id: 'a', available: true, source: 'blob', seconds: 2, picture: null, clock: 'Not saved', save: 'save' },
    ])
    expect(await consoleErrors(browser)).toStrictEqual([])
  })
})
