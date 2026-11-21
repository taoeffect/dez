import fs from 'node:fs'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Key } from 'webdriverio'
import { stoppedToolResult } from '../../src/model/streams/toolRound'
import { jobCancelText, jobStartedText, jobsWaitText, startedJobId, type JobInfo } from '../../src/model/tools/jobs'
import { invocationAnswerText } from '../../src/model/tools/modelInvoke'
import { click, consoleErrors, movePointer, pointerClick, pointerClickAt, promptMessage, resetConsoleErrors, screenshotOnFailure, typeKeys, waitForValue } from './harness/dom'
import { appFilePath, conversationFilePath, filesIn, mediaTempDir, newFileIn, readModelCache, storedFileName } from './harness/fixtures'
import { generatedImagesDir, pasteImageReference, pngDataUrl, shownImages, solidPng } from './harness/images'
import { startedJob, waitCall } from './harness/jobs'
import { finishVeniceJob, shownPlayers, silentWav, type ShownPlayer } from './harness/media'
import { startMockProviderApp, takeRequestTo, type MockProviderApp } from './harness/mockProviderApp'
import { answerHeld, mockChatPath, openAiToolCall, replyText, sendChatReply, sendToolCalls, startEventStream, toolResult, writeChatFrame, type HeldRequest, type MockProvider } from './harness/mockServer'
import type { E2EBrowser } from './harness/session'
import { activeConversationId, activeTabStreaming, assetModelLabels, assetPartPoint, busyDotsShown, docPos, editorDoc, endedReply, focusEditor, newTab, openToasts, setCaret, submit, threadSections, waitForThread } from './harness/thread'
import { hiddenAssetNotes, hiddenPart, hidingPart, intermediateParts, pressToolChip, revealingPart, toolChips, toolPanel } from './harness/toolChips'

// The `model_invoke` tool, driven through the real app against a mock chat
// model (the caller), a mock of Venice's media API
// (`mediaApi: { format: 'venice' }`), and a second mock chat model (the
// helper, a text model that a call names) in this process:
// - a call starts a job and returns its job id at once, with the inputs
//   that go; the request of the job holds the prompt and the image that the
//   prompt names with `@id`, as a data URL with no path;
// - `jobs_wait` gives the result of the job, and the image goes into the
//   reply after the blocks of that call, with a new id and the name of the
//   tool;
// - the busy dots under the editor show while `jobs_wait` waits for a job,
//   and while a reply that ended waits for its jobs;
// - two jobs run at the same time, each `jobs_wait` gives the jobs that
//   ended, and the clip of a provider's job keeps the provider's job id;
// - the start text of a job tells its number in the reply, each result
//   names its call (the number and the start of the prompt), and
//   `jobs_wait` with `all` waits for every job and gives the results in
//   the order of the job ends;
// - a call that cannot work is refused at once and starts no job, and a
//   refusal of the provider is the result of its job;
// - a `voice` parameter takes a voice id that the model's list does not
//   hold when the model's list entry says so: the request holds the id, and
//   a refusal of the provider is the result of its job. A model whose list
//   is complete refuses the id at once, with the list;
// - a job that runs longer than `timeout_seconds` ends with no result, and
//   Dez closes its request;
// - a stop of the user (Escape) leaves the jobs, with their requests, to
//   the next reply of the tab: its `jobs_wait` gets their results and
//   their images, and the result of the `jobs_wait` that the stop broke
//   tells that the jobs go on;
// - that next reply can cancel one of those jobs with `job_cancel`: its
//   request closes, `jobs_wait` gives only the other result, `jobs_list`
//   shows it as cancelled, and it leaves no file;
// - the request to a text model holds only the prompt and the image that
//   the prompt names (no tools, no system prompt, nothing of the
//   conversation), its answer is the result of the job, and a close of the
//   tab ends it;
// - a reply that ends while a job runs waits for it and takes its image;
// - a job that failed and that no `jobs_wait` read shows an error toast;
// - the image or the clip of a call with `is_intermediate` does not show
//   at its place in the reply: the chip of the call names it (an eye, a
//   type symbol, a label), and shows it in its panel while it is open,
//   with its trash and its Save. The model gets the same result, the
//   asset keeps its id, and an `@id` mention of it sends it. It stays
//   hidden after a relaunch, and under the chip of a stopped reply when the
//   next reply takes its job. A new call of the same tool that changes the
//   summary of the chip keeps the chip and its player;
// - the answer of a text model to such a call shows in the panel too.
// No request holds a path of the test HOME.
//
// One app session serves the whole file; each test starts in a new tab.
// The last test starts the app again.

const CALLER: MockProvider = { id: 'caller', name: 'Caller Mock', modelId: 'caller-model', modelName: 'Caller Model' }
const STUDIO: MockProvider = { id: 'studio', name: 'Studio Mock', modelId: 'paint-model', modelName: 'Paint Model' }
const HELPER: MockProvider = { id: 'helper', name: 'Helper Mock', modelId: 'helper-model', modelName: 'Helper Model' }
const EDIT_MODEL = { id: 'edit-model', name: 'Edit Model' }
const SONG_MODEL = { id: 'song-model', name: 'Song Model' }
// The model marks of the images and the clips of the jobs of the studio's
// models.
const PAINT_MARK = `model=${STUDIO.id}/${STUDIO.modelId}`
const EDIT_MARK = `model=${STUDIO.id}/${EDIT_MODEL.id}`
const SONG_MARK = `model="${STUDIO.id}/${SONG_MODEL.id}"`
const CHAT_PATH = mockChatPath(CALLER)
const HELPER_PATH = mockChatPath(HELPER)
const GENERATE_PATH = `/${STUDIO.id}/v1/image/generate`
const EDIT_PATH = `/${STUDIO.id}/v1/image/multi-edit`
const QUEUE_PATH = `/${STUDIO.id}/v1/audio/queue`
const RETRIEVE_PATH = `/${STUDIO.id}/v1/audio/retrieve`

// A provider whose models come from its list, as only a list entry gives a
// model its parameters: two speech models of `/audio/queue` with the same
// voices. Only the first one also takes a voice id that the list does not
// hold (`supports_custom_voice_id`, as the ElevenLabs models of Venice).
const VOICES: MockProvider = { id: 'voices', name: 'Voices Mock', modelId: 'open-voice-model', modelName: 'Open Voice Model' }
const CLOSED_VOICE_MODEL = { id: 'closed-voice-model', name: 'Closed Voice Model' }
const VOICE_SPEC = { voices: ['Aria', 'Roger'], default_voice: 'Aria' }
const VOICE_LIST = {
  object: 'list',
  data: [
    { id: VOICES.modelId, name: VOICES.modelName, type: 'music', model_spec: { ...VOICE_SPEC, supports_custom_voice_id: true } },
    { id: CLOSED_VOICE_MODEL.id, name: CLOSED_VOICE_MODEL.name, type: 'music', model_spec: { ...VOICE_SPEC, supports_custom_voice_id: false } },
  ],
}
const VOICE_QUEUE_PATH = `/${VOICES.id}/v1/audio/queue`
const VOICE_RETRIEVE_PATH = `/${VOICES.id}/v1/audio/retrieve`

// The shorter side has the 256 pixels that Venice's edit API asks for, so
// the image goes as it is.
const PASTED_PNG = solidPng(320, 256, [40, 160, 60])
const MADE_PNG = solidPng(48, 36, [200, 120, 20])
const SONG_WAV = silentWav(2)

const PAINT_PROMPT = 'A fox in the snow'
const paintCall = (id: string, more: Record<string, unknown> = {}) => openAiToolCall(id, 'model_invoke', { model: `${STUDIO.id}/${STUDIO.modelId}`, prompt: PAINT_PROMPT, ...more })
const askCall = (id: string, prompt: string, more: Record<string, unknown> = {}) => openAiToolCall(id, 'model_invoke', { model: `${HELPER.id}/${HELPER.modelId}`, prompt, ...more })
const PAINT_BODY = { model: STUDIO.modelId, prompt: PAINT_PROMPT, format: 'webp', hide_watermark: true, safe_mode: false }

describe('model_invoke', () => {
  let setup: MockProviderApp
  let browser: E2EBrowser
  let generatedDir: string

  // A chat request and the request of a job go at the same time, so the
  // test takes each request by its path.
  const requestTo = (requestPath: string, json?: unknown): Promise<HeldRequest> => takeRequestTo(setup, requestPath, json)

  beforeAll(async () => {
    setup = await startMockProviderApp(CALLER, {}, {
      moreProviders: [
        {
          provider: STUDIO,
          config: {
            mediaApi: { format: 'venice' },
            models: [
              { id: STUDIO.modelId, name: STUDIO.modelName, outputs: ['image'], request: 'image' },
              { id: EDIT_MODEL.id, name: EDIT_MODEL.name, outputs: ['image'], request: 'imageEdit' },
              { id: SONG_MODEL.id, name: SONG_MODEL.name, outputs: ['audio'], request: 'music' },
            ],
          },
        },
        { provider: HELPER },
        {
          provider: VOICES,
          config: {
            mediaApi: { format: 'venice' },
            fetchModels: true,
            models: [],
            modelOutputs: { path: 'type', values: { music: { outputs: ['audio'], request: 'music' } } },
          },
        },
      ],
      heldPaths: [GENERATE_PATH, EDIT_PATH, QUEUE_PATH, RETRIEVE_PATH, VOICE_QUEUE_PATH, VOICE_RETRIEVE_PATH],
      jsonAnswers: {
        [`/${VOICES.id}/v1/models`]: VOICE_LIST,
        // The free price request that goes before each request of a song.
        [`/${STUDIO.id}/v1/audio/quote`]: { quote: 0.05 },
        [`/${VOICES.id}/v1/audio/quote`]: { quote: 0.05 },
      },
    })
    browser = setup.browser
    generatedDir = generatedImagesDir(setup.app.home)
  })

  beforeEach(async () => {
    await newTab(browser)
    await resetConsoleErrors(browser)
  })

  afterEach(async (ctx) => {
    await screenshotOnFailure(browser, ctx)
    await setup.mock.dropOpenReplies(browser)
  })

  afterAll(async () => {
    await setup?.stop()
  })

  it('sends the image that the prompt names to the model as a job, and puts the image of the job into the reply at jobs_wait', async () => {
    const before = await filesIn(generatedDir)
    await focusEditor(browser)
    await typeKeys(browser, 'Change ')
    await pasteImageReference(browser, PASTED_PNG, 'a')
    await submit(browser, '')
    const first = await requestTo(CHAT_PATH)
    sendToolCalls(first.reply, [openAiToolCall('call_edit', 'model_invoke', { model: `${STUDIO.id}/${EDIT_MODEL.id}`, prompt: 'Make @a orange' })])

    // The call returns at once, while the request of its job waits for the
    // answer of the provider.
    const edit = await requestTo(EDIT_PATH, { modelId: EDIT_MODEL.id, prompt: 'Make @a orange', images: [pngDataUrl(PASTED_PNG)], safe_mode: false })
    const second = await requestTo(CHAT_PATH)
    const jobId = startedJob(second, 'call_edit')
    expect(toolResult(second, 'call_edit')).toContain('the image @a')
    expect(await filesIn(generatedDir)).toStrictEqual(before)

    // The busy dots show while `jobs_wait` waits for the job: the reply
    // runs, though its text does not change.
    sendToolCalls(second.reply, [waitCall('call_wait')])
    await waitForValue(browser, 'block of the wait', async () => (await threadSections(browser))[1]?.text.includes('id="call_wait"') ?? false, true)
    await waitForValue(browser, 'busy dots while the job runs', () => busyDotsShown(browser), true)
    answerHeld(edit.reply, 'image/png', MADE_PNG)
    const third = await requestTo(CHAT_PATH)
    expect(toolResult(third, 'call_wait')).toBe(jobsWaitText([{ id: jobId, tool: 'model_invoke', status: 'finished', text: 'Made the image @b.', call: { number: 1, label: 'Make @a orange' } }], 0))
    await sendChatReply(third.reply, CALLER.modelName)

    // The image comes after the blocks of the call that gave it.
    const reply = await endedReply(browser)
    const madeName = await newFileIn(browser, generatedDir, before)
    expect(madeName).toMatch(storedFileName('png'))
    const madePath = path.join(generatedDir, madeName)
    expect(await fs.promises.readFile(madePath)).toEqual(MADE_PNG)
    expect(reply.endsWith(`</dez:tool>\n\n![id=b|tool=model_invoke|${EDIT_MARK}|made-by=${jobId}](${madePath})\n\n${replyText(CALLER.modelName)}`)).toBe(true)
    await waitForValue(browser, 'shown images', async () => (await shownImages(browser)).map(({ width, height }) => ({ width, height })), [
      { width: 320, height: 256 },
      { width: 48, height: 36 },
    ])
    expect(await openToasts(browser, 'error')).toStrictEqual([])
    expect(await consoleErrors(browser)).toStrictEqual([])
  })

  it('runs two jobs at the same time, gives each result to the jobs_wait after its end, and keeps the job id of the provider on the clip', async () => {
    await submit(browser, 'Make a picture and a song.')
    const first = await requestTo(CHAT_PATH)
    sendToolCalls(first.reply, [
      paintCall('call_paint'),
      openAiToolCall('call_song', 'model_invoke', { model: `${STUDIO.id}/${SONG_MODEL.id}`, prompt: 'A slow song' }),
    ])

    // Both requests wait for their answers at the same time.
    const paint = await requestTo(GENERATE_PATH, PAINT_BODY)
    const queue = await requestTo(QUEUE_PATH, { model: SONG_MODEL.id, prompt: 'A slow song' })
    const second = await requestTo(CHAT_PATH)
    const paintJob = startedJob(second, 'call_paint')
    const songJob = startedJob(second, 'call_song')
    expect(songJob).not.toBe(paintJob)
    // Each start tells the number of its job, which its result repeats.
    expect(['call_paint', 'call_song'].map((callId) => toolResult(second, callId).split('\n')[0])).toStrictEqual([jobStartedText(paintJob, 1), jobStartedText(songJob, 2)])

    // The first wait ends with the first job that ends.
    sendToolCalls(second.reply, [waitCall('call_wait_1')])
    answerHeld(paint.reply, 'application/json', JSON.stringify({ images: [MADE_PNG.toString('base64')] }))
    const third = await requestTo(CHAT_PATH)
    expect(toolResult(third, 'call_wait_1')).toBe(jobsWaitText([{ id: paintJob, tool: 'model_invoke', status: 'finished', text: 'Made the image @a.', call: { number: 1, label: PAINT_PROMPT } }], 1))

    sendToolCalls(third.reply, [waitCall('call_wait_2')])
    await finishVeniceJob(setup, queue, { retrievePath: RETRIEVE_PATH, modelId: SONG_MODEL.id, queueId: 'queue-1', clip: { type: 'audio/wav', bytes: SONG_WAV } })
    const fourth = await requestTo(CHAT_PATH)
    expect(toolResult(fourth, 'call_wait_2')).toBe(jobsWaitText([{ id: songJob, tool: 'model_invoke', status: 'finished', text: 'Made the audio clip @b.', call: { number: 2, label: 'A slow song' } }], 0))
    await sendChatReply(fourth.reply, CALLER.modelName)

    // Each asset comes after the blocks of the call that gave it.
    const reply = await endedReply(browser)
    const image = new RegExp(String.raw`<\/dez:tool>\n\n!\[id=a\|tool=model_invoke\|${PAINT_MARK}\|made-by=${paintJob}\]\([^)]+\)\n`).exec(reply)
    expect(image).not.toBeNull()
    expect(image?.index).toBeLessThan(reply.indexOf('id="call_wait_2"'))
    const clip = new RegExp(String.raw`<\/dez:tool>\n\n<dez:audio id="b" type="audio\/wav" src="([^"]+\.wav)" expires="[^"]+" tool="model_invoke" ${SONG_MARK} job="queue-1" made-by="${songJob}"\/>\n\n([^\n]+)$`).exec(reply)
    expect(clip?.[2]).toBe(replyText(CALLER.modelName))
    expect(path.dirname(clip?.[1] ?? '')).toBe(mediaTempDir(setup.app.home))
    await waitForValue(browser, 'player of the song', () => shownPlayers(browser), [
      { kind: 'audio', id: 'b', available: true, source: 'blob', seconds: 2, picture: null, clock: 'Not saved', save: 'save' },
    ])
    expect(await openToasts(browser, 'error')).toStrictEqual([])
    expect(await consoleErrors(browser)).toStrictEqual([])
  })

  // The ids of the new assets follow the order of the job ends, so each
  // result names its call.
  it('waits for every job with `all`, and gives the results in one call, in the order of the job ends, each with the number and the prompt of its call', async () => {
    const tempDir = mediaTempDir(setup.app.home)
    const clipsBefore = await filesIn(tempDir)
    await submit(browser, 'Make a picture and a song.')
    const first = await requestTo(CHAT_PATH)
    sendToolCalls(first.reply, [
      paintCall('call_paint'),
      openAiToolCall('call_song', 'model_invoke', { model: `${STUDIO.id}/${SONG_MODEL.id}`, prompt: 'A slow song' }),
    ])
    const paint = await requestTo(GENERATE_PATH, PAINT_BODY)
    const queue = await requestTo(QUEUE_PATH, { model: SONG_MODEL.id, prompt: 'A slow song' })
    const second = await requestTo(CHAT_PATH)
    const paintJob = startedJob(second, 'call_paint')
    const songJob = startedJob(second, 'call_song')

    // The second job ends first. The wait goes on, as a job still runs.
    sendToolCalls(second.reply, [waitCall('call_wait', true)])
    await finishVeniceJob(setup, queue, { retrievePath: RETRIEVE_PATH, modelId: SONG_MODEL.id, queueId: 'queue-1', clip: { type: 'audio/wav', bytes: SONG_WAV } })
    await waitForValue(browser, 'temp copy of the song', async () => (await filesIn(tempDir)).filter((name) => name.endsWith('.wav') && !clipsBefore.includes(name)).length, 1)
    expect(setup.mock.hasWaitingRequest()).toBe(false)

    answerHeld(paint.reply, 'application/json', JSON.stringify({ images: [MADE_PNG.toString('base64')] }))
    const third = await requestTo(CHAT_PATH)
    expect(toolResult(third, 'call_wait')).toBe(jobsWaitText([
      { id: songJob, tool: 'model_invoke', status: 'finished', text: 'Made the audio clip @a.', call: { number: 2, label: 'A slow song' } },
      { id: paintJob, tool: 'model_invoke', status: 'finished', text: 'Made the image @b.', call: { number: 1, label: PAINT_PROMPT } },
    ], 0))
    await sendChatReply(third.reply, CALLER.modelName)

    await endedReply(browser)
    expect(await openToasts(browser, 'error')).toStrictEqual([])
    expect(await consoleErrors(browser)).toStrictEqual([])
  })

  it('refuses a call that cannot work at once with no job, and gives a refusal of the provider as the result of its job', async () => {
    const before = await filesIn(generatedDir)
    await submit(browser, 'Make a picture.')
    const first = await requestTo(CHAT_PATH)
    sendToolCalls(first.reply, [
      // The conversation has no image and no clip, so `@z` names nothing.
      askCall('call_ask', 'What does @z show?'),
      paintCall('call_paint'),
    ])

    const paint = await requestTo(GENERATE_PATH, PAINT_BODY)
    const second = await requestTo(CHAT_PATH)
    expect(startedJobId(toolResult(second, 'call_ask'))).toBeNull()
    expect(toolResult(second, 'call_ask')).toContain('@z')
    const jobId = startedJob(second, 'call_paint')

    sendToolCalls(second.reply, [waitCall('call_wait')])
    paint.reply.writeHead(400, { 'Content-Type': 'application/json' })
    paint.reply.end(JSON.stringify({ error: 'The prompt breaks the content rules' }))
    const third = await requestTo(CHAT_PATH)
    const result = toolResult(third, 'call_wait')
    // The failure text is for the model: what a new call can change.
    expect(result).toContain(`<job id="${jobId}" number="1" tool="model_invoke" status="failed" call="${PAINT_PROMPT}">`)
    expect(result).toContain(`${STUDIO.name} refused the request. ${STUDIO.name} tells its reason in the details below. The cause can be \`prompt\`, the inputs, \`parameters\`, or the request that Dez made.`)
    expect(result).toContain('Details: HTTP 400: The prompt breaks the content rules')
    await sendChatReply(third.reply, CALLER.modelName)

    // The model got the failure, so no toast tells of it.
    const reply = await endedReply(browser)
    expect(reply.endsWith(`</dez:tool>\n${replyText(CALLER.modelName)}`)).toBe(true)
    expect(setup.mock.hasWaitingRequest()).toBe(false)
    expect(await filesIn(generatedDir)).toStrictEqual(before)
    expect(await openToasts(browser, 'error')).toStrictEqual([])
    expect(await consoleErrors(browser)).toContainEqual(expect.stringContaining(`The model_invoke job ${jobId} failed`))
  })

  // The voices of a user's account at the provider are in no model list
  // (issue `voice-selection-bugfix`).
  it('sends a voice id that the list of the model does not hold, gives a refusal of the provider as the result of its job, and refuses the id at once for a model whose list is complete', async () => {
    const speech = 'Hello there'
    const speakCall = (id: string, modelId: string, voice: string) => openAiToolCall(id, 'model_invoke', { model: `${VOICES.id}/${modelId}`, prompt: speech, parameters: JSON.stringify({ voice }) })
    // The list comes with the model check of the app start.
    await waitForValue(browser, 'model list of the voice provider', async () => (await readModelCache(setup.app.home))?.providers[VOICES.id]?.models.map((model) => model.id) ?? [], [VOICES.modelId, CLOSED_VOICE_MODEL.id])
    await submit(browser, 'Say hello in my voice.')
    const first = await requestTo(CHAT_PATH)
    sendToolCalls(first.reply, [
      speakCall('call_closed', CLOSED_VOICE_MODEL.id, 'laTmoAT4stwoPzthxjZT'),
      speakCall('call_own', VOICES.modelId, 'laTmoAT4stwoPzthxjZT'),
    ])

    const own = await requestTo(VOICE_QUEUE_PATH, { model: VOICES.modelId, prompt: speech, voice: 'laTmoAT4stwoPzthxjZT' })
    const second = await requestTo(CHAT_PATH)
    // The refusal names the voices that the model takes.
    const refusal = toolResult(second, 'call_closed')
    expect(startedJobId(refusal)).toBeNull()
    expect(['"voice"', '"Aria"', '"Roger"'].filter((part) => !refusal.includes(part))).toStrictEqual([])
    const ownJob = startedJob(second, 'call_own')

    // Dez cannot check an id, so the provider does.
    sendToolCalls(second.reply, [speakCall('call_gone', VOICES.modelId, 'goneVoiceId')])
    const gone = await requestTo(VOICE_QUEUE_PATH, { model: VOICES.modelId, prompt: speech, voice: 'goneVoiceId' })
    const third = await requestTo(CHAT_PATH)
    const goneJob = startedJob(third, 'call_gone')

    sendToolCalls(third.reply, [waitCall('call_wait', true)])
    await finishVeniceJob(setup, own, { retrievePath: VOICE_RETRIEVE_PATH, modelId: VOICES.modelId, queueId: 'queue-1', clip: { type: 'audio/wav', bytes: SONG_WAV } })
    gone.reply.writeHead(400, { 'Content-Type': 'application/json' })
    gone.reply.end(JSON.stringify({ error: 'The voice goneVoiceId does not exist' }))
    const fourth = await requestTo(CHAT_PATH)
    const result = toolResult(fourth, 'call_wait')
    expect(result).toContain(`<job id="${ownJob}" number="1" tool="model_invoke" status="finished" call="${speech}">\nMade the audio clip @a.`)
    expect(result).toContain(`<job id="${goneJob}" number="2" tool="model_invoke" status="failed" call="${speech}">`)
    expect(result).toContain('Details: HTTP 400: The voice goneVoiceId does not exist')
    await sendChatReply(fourth.reply, CALLER.modelName)

    await endedReply(browser)
    expect(setup.mock.hasWaitingRequest()).toBe(false)
    expect(await openToasts(browser, 'error')).toStrictEqual([])
    const errors = await consoleErrors(browser)
    expect(errors).toContainEqual(expect.stringContaining('The tool model_invoke failed'))
    expect(errors).toContainEqual(expect.stringContaining(`The model_invoke job ${goneJob} failed`))
  })

  it('ends a job that runs longer than its time limit with no result, and closes its request', async () => {
    const before = await filesIn(generatedDir)
    await submit(browser, 'Make a picture.')
    const first = await requestTo(CHAT_PATH)
    // The shortest limit that the tool takes.
    sendToolCalls(first.reply, [paintCall('call_paint', { timeout_seconds: 10 })])

    const paint = await requestTo(GENERATE_PATH, PAINT_BODY)
    const second = await requestTo(CHAT_PATH)
    const jobId = startedJob(second, 'call_paint')
    sendToolCalls(second.reply, [waitCall('call_wait')])

    // The provider never answers. The wait is longer than `waitForValue`
    // takes.
    await browser.waitUntil(async () => paint.closed, { timeout: 30_000, interval: 100, timeoutMsg: 'the app did not close the request of the job' })
    const third = await requestTo(CHAT_PATH)
    const result = toolResult(third, 'call_wait')
    expect(result).toContain(`<job id="${jobId}" number="1" tool="model_invoke" status="timed out" call="${PAINT_PROMPT}">`)
    expect(result).toContain('10 seconds')
    await sendChatReply(third.reply, CALLER.modelName)

    const reply = await endedReply(browser)
    expect(reply.endsWith(`</dez:tool>\n${replyText(CALLER.modelName)}`)).toBe(true)
    expect(await filesIn(generatedDir)).toStrictEqual(before)
    expect(await openToasts(browser, 'error')).toStrictEqual([])
  })

  // The case of the user: the model started jobs, and the user wants to
  // correct it. Escape stops the reply while its `jobs_wait` waits; the
  // reply to the correction takes the jobs over.
  it('keeps the jobs of a reply that the user stops with Escape, and the reply to the next message waits for them and takes their results and image', async () => {
    const before = await filesIn(generatedDir)
    const prompt = 'Tell a long story.'
    await submit(browser, 'Make a picture, and ask the helper for a story.')
    const first = await requestTo(CHAT_PATH)
    sendToolCalls(first.reply, [paintCall('call_paint'), askCall('call_ask', prompt)])
    const paint = await requestTo(GENERATE_PATH, PAINT_BODY)
    const asked = await requestTo(HELPER_PATH, { model: HELPER.modelId, stream: true, messages: [{ role: 'user', content: prompt }] })
    const second = await requestTo(CHAT_PATH)
    const paintJob = startedJob(second, 'call_paint')
    const askJob = startedJob(second, 'call_ask')
    // The answer of the helper has begun.
    startEventStream(asked.reply)
    writeChatFrame(asked.reply, { content: 'Once' })
    sendToolCalls(second.reply, [waitCall('call_wait', true)])
    await waitForValue(browser, 'jobs_wait that waits', async () => (await threadSections(browser))[1]?.text.includes('id="call_wait"') ?? false, true)

    await focusEditor(browser)
    await browser.keys([Key.Escape])
    await waitForValue(browser, 'sections after the stop', async () => (await threadSections(browser)).map(({ role }) => role), ['user', 'agent', 'user'])
    await waitForValue(browser, 'streaming', () => activeTabStreaming(browser), false)
    const stopped = stoppedToolResult('jobs_wait').content
    expect((await threadSections(browser))[1].text).toContain(`\n${stopped}\n</dez:tool>`)
    // The requests of both jobs go on, and a job can end while no reply
    // runs.
    expect([paint.closed, asked.closed]).toStrictEqual([false, false])
    answerHeld(paint.reply, 'application/json', JSON.stringify({ images: [MADE_PNG.toString('base64')] }))

    await submit(browser, 'Use the other style.')
    const third = await requestTo(CHAT_PATH)
    expect(toolResult(third, 'call_wait')).toBe(stopped)
    sendToolCalls(third.reply, [waitCall('call_wait_2', true)])
    writeChatFrame(asked.reply, { content: ' upon a time.' })
    asked.reply.end('data: [DONE]\n\n')
    const fourth = await requestTo(CHAT_PATH)
    expect(toolResult(fourth, 'call_wait_2')).toBe(jobsWaitText([
      { id: paintJob, tool: 'model_invoke', status: 'finished', text: 'Made the image @a.', call: { number: 1, label: PAINT_PROMPT } },
      { id: askJob, tool: 'model_invoke', status: 'finished', text: invocationAnswerText('Once upon a time.'), call: { number: 2, label: prompt } },
    ], 0))
    await sendChatReply(fourth.reply, CALLER.modelName)

    // The image goes into the reply that took the job over.
    const reply = await endedReply(browser, 3)
    const madePath = path.join(generatedDir, await newFileIn(browser, generatedDir, before))
    expect(reply.endsWith(`</dez:tool>\n\n![id=a|tool=model_invoke|${PAINT_MARK}|made-by=${paintJob}](${madePath})\n\n${replyText(CALLER.modelName)}`)).toBe(true)
    await waitForValue(browser, 'shown image', async () => (await shownImages(browser)).map(({ width, height }) => ({ width, height })), [{ width: 48, height: 36 }])
    expect(setup.mock.hasWaitingRequest()).toBe(false)
    expect(await openToasts(browser, 'error')).toStrictEqual([])
    expect(await consoleErrors(browser)).toStrictEqual([])
  })

  // The case of the user, with a correction that makes a job of no use:
  // the reply to the correction cancels that job with `job_cancel`, and
  // waits only for the other one. Image jobs only: the abort of a clip job
  // logs an error, which would fail the spec.
  it('cancels a job of a reply that the user stopped when the next reply names it in job_cancel: its request closes, and it gives no result and no file', async () => {
    const before = await filesIn(generatedDir)
    const rainPrompt = 'A fox in the rain'
    await submit(browser, 'Make two pictures.')
    const first = await requestTo(CHAT_PATH)
    sendToolCalls(first.reply, [paintCall('call_paint'), paintCall('call_paint_2', { prompt: rainPrompt })])
    // The two requests of the jobs go at the same time, in any order: sort
    // them by their prompts ("rain" before "snow").
    const promptOf = (request: HeldRequest) => (JSON.parse(request.body) as { prompt: string }).prompt
    const [rain, snow] = [await requestTo(GENERATE_PATH), await requestTo(GENERATE_PATH)].sort((a, b) => promptOf(a).localeCompare(promptOf(b)))
    expect([rain, snow].map((request) => JSON.parse(request.body))).toStrictEqual([{ ...PAINT_BODY, prompt: rainPrompt }, PAINT_BODY])
    const second = await requestTo(CHAT_PATH)
    const snowJob = startedJob(second, 'call_paint')
    const rainJob = startedJob(second, 'call_paint_2')
    sendToolCalls(second.reply, [waitCall('call_wait', true)])
    await waitForValue(browser, 'jobs_wait that waits', async () => (await threadSections(browser))[1]?.text.includes('id="call_wait"') ?? false, true)

    await focusEditor(browser)
    await browser.keys([Key.Escape])
    await waitForValue(browser, 'sections after the stop', async () => (await threadSections(browser)).map(({ role }) => role), ['user', 'agent', 'user'])
    await waitForValue(browser, 'streaming', () => activeTabStreaming(browser), false)

    await submit(browser, 'Only the one in the snow.')
    const third = await requestTo(CHAT_PATH)
    sendToolCalls(third.reply, [openAiToolCall('call_cancel', 'job_cancel', { jobs: rainJob })])
    await waitForValue(browser, 'closed request of the cancelled job', async () => [rain.closed, snow.closed], [true, false])

    const fourth = await requestTo(CHAT_PATH)
    const cancelled: JobInfo = { id: rainJob, tool: 'model_invoke', status: 'cancelled', delivered: false, elapsedMs: 0, state: '', call: { number: 2, label: rainPrompt }, inputs: [] }
    expect(toolResult(fourth, 'call_cancel')).toBe(jobCancelText([cancelled], [rainJob], 1))
    answerHeld(snow.reply, 'application/json', JSON.stringify({ images: [MADE_PNG.toString('base64')] }))
    sendToolCalls(fourth.reply, [waitCall('call_wait_2', true), openAiToolCall('call_list', 'jobs_list', {})])

    const fifth = await requestTo(CHAT_PATH)
    expect(toolResult(fifth, 'call_wait_2')).toBe(jobsWaitText([
      { id: snowJob, tool: 'model_invoke', status: 'finished', text: 'Made the image @a.', call: { number: 1, label: PAINT_PROMPT } },
    ], 0))
    expect(toolResult(fifth, 'call_list').split('\n')).toContainEqual(expect.stringMatching(new RegExp(`^2 \\| ${rainJob} \\| model_invoke \\| cancelled \\| - \\| \\d+ \\| ${rainPrompt}$`)))
    await sendChatReply(fifth.reply, CALLER.modelName)

    // Only the job that was not cancelled made a file.
    const reply = await endedReply(browser, 3)
    const madeName = await newFileIn(browser, generatedDir, before)
    expect((await filesIn(generatedDir)).filter((name) => !before.includes(name))).toStrictEqual([madeName])
    expect(reply.endsWith(`</dez:tool>\n\n![id=a|tool=model_invoke|${PAINT_MARK}|made-by=${snowJob}](${path.join(generatedDir, madeName)})\n\n${replyText(CALLER.modelName)}`)).toBe(true)
    expect(setup.mock.hasWaitingRequest()).toBe(false)
    expect(await openToasts(browser, 'error')).toStrictEqual([])
    expect(await consoleErrors(browser)).toStrictEqual([])
  })

  // The invoked model must not call a tool or invoke a model in its turn,
  // and it gets nothing of the conversation: the whole body is checked.
  it('sends a text model only the prompt and the image that the prompt names, and gives its answer as the result of the job', async () => {
    const before = await filesIn(generatedDir)
    await focusEditor(browser)
    await typeKeys(browser, 'Look at ')
    await pasteImageReference(browser, PASTED_PNG, 'a')
    await submit(browser, '')
    const first = await requestTo(CHAT_PATH)
    sendToolCalls(first.reply, [askCall('call_ask', 'What does @a show?')])

    const asked = await requestTo(HELPER_PATH, {
      model: HELPER.modelId,
      stream: true,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'What does @a' },
          { type: 'image_url', image_url: { url: pngDataUrl(PASTED_PNG) } },
          { type: 'text', text: ' show?' },
        ],
      }],
    })
    const second = await requestTo(CHAT_PATH)
    const jobId = startedJob(second, 'call_ask')
    expect(toolResult(second, 'call_ask')).toContain('the image @a')

    sendToolCalls(second.reply, [waitCall('call_wait')])
    await sendChatReply(asked.reply, HELPER.modelName)
    const third = await requestTo(CHAT_PATH)
    expect(toolResult(third, 'call_wait')).toBe(jobsWaitText([{
      id: jobId, tool: 'model_invoke', status: 'finished', text: invocationAnswerText(replyText(HELPER.modelName)), call: { number: 1, label: 'What does @a show?' },
    }], 0))
    await sendChatReply(third.reply, CALLER.modelName)

    // The answer of the helper is only in the result of the job: the
    // caller decides what the user sees.
    const reply = await endedReply(browser)
    expect(reply.endsWith(`</dez:tool>\n${replyText(CALLER.modelName)}`)).toBe(true)
    expect(setup.mock.hasWaitingRequest()).toBe(false)
    expect(await filesIn(generatedDir)).toStrictEqual(before)
    expect(await openToasts(browser, 'error')).toStrictEqual([])
    expect(await consoleErrors(browser)).toStrictEqual([])
  })

  it('ends the request to a text model of a stopped reply when the user closes the tab, and takes nothing of its answer', async () => {
    const prompt = 'Tell a long story.'
    await submit(browser, 'Ask the helper.')
    const first = await requestTo(CHAT_PATH)
    sendToolCalls(first.reply, [askCall('call_ask', prompt)])
    const asked = await requestTo(HELPER_PATH, { model: HELPER.modelId, stream: true, messages: [{ role: 'user', content: prompt }] })
    const second = await requestTo(CHAT_PATH)
    const started = toolResult(second, 'call_ask')
    // The answer has begun, and it does not end.
    startEventStream(asked.reply)
    writeChatFrame(asked.reply, { content: 'Once' })

    // While a reply runs, the Submit button stops it. The job goes on for
    // the next reply of the tab.
    await pointerClick(browser, '.submit-button')
    await waitForValue(browser, 'chat request closed', async () => second.closed, true)
    const block = `<dez:tool id="call_ask" name="model_invoke" model="${HELPER.id}/${HELPER.modelId}" prompt="${prompt}">\n${started}\n</dez:tool>\n`
    await waitForThread(browser, [
      { role: 'user', text: 'Ask the helper.' },
      { role: 'agent', text: block },
      { role: 'user', text: '' },
    ])
    expect(asked.closed).toBe(false)

    // No later reply can take the job of a tab that is gone.
    await pointerClick(browser, '.tab--active .tab-close')
    await waitForValue(browser, 'request of the job closed', async () => asked.closed, true)
    expect(setup.mock.hasWaitingRequest()).toBe(false)
    expect(await openToasts(browser, 'error')).toStrictEqual([])
    expect(await consoleErrors(browser)).toStrictEqual([])
  })

  it('waits for a job that still runs when the model ends its reply, then puts the image of the job at the end of the reply', async () => {
    const before = await filesIn(generatedDir)
    await submit(browser, 'Make a picture.')
    const first = await requestTo(CHAT_PATH)
    sendToolCalls(first.reply, [paintCall('call_paint')])
    const paint = await requestTo(GENERATE_PATH, PAINT_BODY)
    const second = await requestTo(CHAT_PATH)
    const jobId = startedJob(second, 'call_paint')
    await sendChatReply(second.reply, CALLER.modelName)

    // The model ended its reply, and the reply waits for the job.
    await waitForValue(browser, 'text of the reply', async () => (await threadSections(browser))[1]?.text.endsWith(replyText(CALLER.modelName)) ?? false, true)
    expect(await activeTabStreaming(browser)).toBe(true)
    await waitForValue(browser, 'busy dots while the reply waits for the job', () => busyDotsShown(browser), true)
    expect(await threadSections(browser)).toHaveLength(2)

    answerHeld(paint.reply, 'application/json', JSON.stringify({ images: [MADE_PNG.toString('base64')] }))
    const reply = await endedReply(browser)
    await waitForValue(browser, 'busy dots after the reply', () => busyDotsShown(browser), false)
    const madePath = path.join(generatedDir, await newFileIn(browser, generatedDir, before))
    expect(reply.endsWith(`${replyText(CALLER.modelName)}\n\n![id=a|tool=model_invoke|${PAINT_MARK}|made-by=${jobId}](${madePath})`)).toBe(true)
    expect(await openToasts(browser, 'error')).toStrictEqual([])
    expect(await consoleErrors(browser)).toStrictEqual([])
  })

  it('tells the user in an error toast of a job that failed and whose result the model did not get', async () => {
    await submit(browser, 'Make a picture.')
    const first = await requestTo(CHAT_PATH)
    sendToolCalls(first.reply, [paintCall('call_paint')])
    const paint = await requestTo(GENERATE_PATH, PAINT_BODY)
    const second = await requestTo(CHAT_PATH)
    const jobId = startedJob(second, 'call_paint')
    await sendChatReply(second.reply, CALLER.modelName)
    paint.reply.writeHead(400, { 'Content-Type': 'application/json' })
    paint.reply.end(JSON.stringify({ error: 'The prompt breaks the content rules' }))

    const reply = await endedReply(browser)
    expect(reply.endsWith(replyText(CALLER.modelName))).toBe(true)
    await waitForValue(browser, 'error toast', async () => (await openToasts(browser, 'error')).map((toast) => toast.title), ['Job failed'])
    const [{ message }] = await openToasts(browser, 'error')
    expect(message).toContain(`The model_invoke job ${jobId} failed.`)
    // The result text of the job is for the model: only the console has it.
    expect(message).not.toContain('The prompt breaks the content rules')
    expect(await consoleErrors(browser)).toContainEqual(expect.stringMatching(new RegExp(`${jobId}.*The prompt breaks the content rules`, 's')))
    // Closed, so that it is not open in the next test.
    await click(browser, '.toast-card--error:not(.toast-card--closing) .toast-close')
    await waitForValue(browser, 'error toast closed', () => openToasts(browser, 'error'), [])
  })

  const imageSizes = async (): Promise<Array<{ width: number, height: number }>> => (await shownImages(browser)).map(({ width, height }) => ({ width, height }))

  /** Runs a reply whose one `model_invoke` call is intermediate and makes
   *  the image `MADE_PNG`, to its end. Gives the text of the reply, the
   *  file of the image, the job of the call, and the result of the call. */
  async function intermediateImageReply (): Promise<{ reply: string, madePath: string, jobId: string, started: string }> {
    const before = await filesIn(generatedDir)
    await submit(browser, 'Make a draft.')
    const first = await requestTo(CHAT_PATH)
    sendToolCalls(first.reply, [paintCall('call_paint', { is_intermediate: true })])
    const paint = await requestTo(GENERATE_PATH, PAINT_BODY)
    const second = await requestTo(CHAT_PATH)
    const jobId = startedJob(second, 'call_paint')
    // The job has no result yet, so the chip tells only what its model
    // makes.
    await waitForValue(browser, 'chip of the job that runs', () => intermediateParts(browser), [{ eye: 'closed', lit: false, types: ['image'], text: 'intermediate' }])

    sendToolCalls(second.reply, [waitCall('call_wait')])
    answerHeld(paint.reply, 'application/json', JSON.stringify({ images: [MADE_PNG.toString('base64')] }))
    const third = await requestTo(CHAT_PATH)
    // The model gets the result of an image that shows.
    expect(toolResult(third, 'call_wait')).toBe(jobsWaitText([{ id: jobId, tool: 'model_invoke', status: 'finished', text: 'Made the image @a.', call: { number: 1, label: PAINT_PROMPT } }], 0))
    await sendChatReply(third.reply, CALLER.modelName)

    const reply = await endedReply(browser)
    const madePath = path.join(generatedDir, await newFileIn(browser, generatedDir, before))
    expect(reply.endsWith(`</dez:tool>\n\n![id=a|tool=model_invoke|${PAINT_MARK}|made-by=${jobId}|hidden=${jobId}](${madePath})\n\n${replyText(CALLER.modelName)}`)).toBe(true)
    return { reply, madePath, jobId, started: toolResult(second, 'call_paint') }
  }

  it('hides the image of an intermediate call under its chip, shows it while the chip is open, and sends it for its @id', async () => {
    const { madePath, started } = await intermediateImageReply()

    // The image does not show at its place, and its lines take no room.
    // The chip of its call tells of it; the `jobs_wait` chip does not.
    await waitForValue(browser, 'chips after the reply', () => intermediateParts(browser), [hidingPart('image'), null])
    expect((await toolChips(browser))[0].label).toBe(`Tool call model_invoke, "${STUDIO.id}/${STUDIO.modelId}" "${PAINT_PROMPT}", intermediate asset hidden`)
    expect(await shownImages(browser)).toStrictEqual([])
    const note = 'Hidden intermediate image @a. Open its tool call to see it.'
    expect(await hiddenAssetNotes(browser)).toStrictEqual([{ text: note, visible: false }])

    // A caret on the line of the image shows what the line holds.
    await setCaret(browser, await docPos(browser, `](${madePath})`))
    await waitForValue(browser, 'note under the caret', () => hiddenAssetNotes(browser), [{ text: note, visible: true }])
    await setCaret(browser, (await editorDoc(browser)).length)
    await waitForValue(browser, 'note after the caret left', () => hiddenAssetNotes(browser), [{ text: note, visible: false }])

    // The open chip shows the image in its panel, before the call.
    await pressToolChip(browser, 0)
    await waitForValue(browser, 'image in the panel', imageSizes, [{ width: 48, height: 36 }])
    expect(await intermediateParts(browser)).toStrictEqual([revealingPart('image'), null])
    expect((await toolChips(browser))[0].label).toBe(`Tool call model_invoke, "${STUDIO.id}/${STUDIO.modelId}" "${PAINT_PROMPT}", intermediate asset`)
    expect(await hiddenPart(browser, 0)).toStrictEqual({ heading: 'Intermediate asset', assets: 1, text: null })
    expect((await toolPanel(browser, 0))?.result).toBe(started)

    await pressToolChip(browser, 0)
    await waitForValue(browser, 'image after the chip closed', () => shownImages(browser), [])
    expect(await intermediateParts(browser)).toStrictEqual([hidingPart('image'), null])

    // The hidden image has its id, and a mention of it sends the image.
    await submit(browser, 'Use @a now.')
    const next = await requestTo(CHAT_PATH)
    const { messages } = JSON.parse(next.body) as { messages: Array<{ role: string, content: unknown }> }
    expect(messages.at(-1)).toStrictEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'Use @a' },
        { type: 'image_url', image_url: { url: pngDataUrl(MADE_PNG) } },
        { type: 'text', text: ' now.' },
      ],
    })
    await sendChatReply(next.reply, CALLER.modelName)
    await waitForValue(browser, 'sections after the second reply', async () => (await threadSections(browser)).length, 5)
    expect(await openToasts(browser, 'error')).toStrictEqual([])
    expect(await consoleErrors(browser)).toStrictEqual([])
  })

  // A stop hands the job of the call to the next reply, so its image goes
  // into a later section than the chip of its call.
  it('hides the image of an intermediate call of a stopped reply under its chip, when the next reply takes it', async () => {
    const before = await filesIn(generatedDir)
    await submit(browser, 'Make a draft.')
    const first = await requestTo(CHAT_PATH)
    sendToolCalls(first.reply, [paintCall('call_paint', { is_intermediate: true })])
    const paint = await requestTo(GENERATE_PATH, PAINT_BODY)
    const second = await requestTo(CHAT_PATH)
    const jobId = startedJob(second, 'call_paint')
    await focusEditor(browser)
    await browser.keys([Key.Escape])
    await waitForValue(browser, 'sections after the stop', async () => (await threadSections(browser)).map(({ role }) => role), ['user', 'agent', 'user'])
    await waitForValue(browser, 'streaming', () => activeTabStreaming(browser), false)

    await submit(browser, 'Go on.')
    const third = await requestTo(CHAT_PATH)
    sendToolCalls(third.reply, [waitCall('call_wait')])
    answerHeld(paint.reply, 'application/json', JSON.stringify({ images: [MADE_PNG.toString('base64')] }))
    const fourth = await requestTo(CHAT_PATH)
    expect(toolResult(fourth, 'call_wait')).toBe(jobsWaitText([{ id: jobId, tool: 'model_invoke', status: 'finished', text: 'Made the image @a.', call: { number: 1, label: PAINT_PROMPT } }], 0))
    await sendChatReply(fourth.reply, CALLER.modelName)

    const reply = await endedReply(browser, 3)
    const madePath = path.join(generatedDir, await newFileIn(browser, generatedDir, before))
    expect(reply.endsWith(`</dez:tool>\n\n![id=a|tool=model_invoke|${PAINT_MARK}|made-by=${jobId}|hidden=${jobId}](${madePath})\n\n${replyText(CALLER.modelName)}`)).toBe(true)
    // The chip of the call in the stopped reply hides the image; the
    // `jobs_wait` chip of the next reply does not.
    await waitForValue(browser, 'chips after the reply', () => intermediateParts(browser), [hidingPart('image'), null])
    expect(await shownImages(browser)).toStrictEqual([])

    await pressToolChip(browser, 0)
    await waitForValue(browser, 'image in the panel', imageSizes, [{ width: 48, height: 36 }])
    expect(await hiddenPart(browser, 0)).toStrictEqual({ heading: 'Intermediate asset', assets: 1, text: null })
    await pressToolChip(browser, 0)
    await waitForValue(browser, 'image after the chip closed', () => shownImages(browser), [])
    expect(await openToasts(browser, 'error')).toStrictEqual([])
    expect(await consoleErrors(browser)).toStrictEqual([])
  })

  it('hides the clip of an intermediate call under its chip, and keeps its player in the open panel over a Save', async () => {
    await submit(browser, 'Make a draft song.')
    const first = await requestTo(CHAT_PATH)
    sendToolCalls(first.reply, [openAiToolCall('call_song', 'model_invoke', { model: `${STUDIO.id}/${SONG_MODEL.id}`, prompt: 'A slow song', is_intermediate: true })])
    const queue = await requestTo(QUEUE_PATH, { model: SONG_MODEL.id, prompt: 'A slow song' })
    const second = await requestTo(CHAT_PATH)
    const jobId = startedJob(second, 'call_song')
    sendToolCalls(second.reply, [waitCall('call_wait')])
    await finishVeniceJob(setup, queue, { retrievePath: RETRIEVE_PATH, modelId: SONG_MODEL.id, queueId: 'queue-1', clip: { type: 'audio/wav', bytes: SONG_WAV } })
    const third = await requestTo(CHAT_PATH)
    expect(toolResult(third, 'call_wait')).toBe(jobsWaitText([{ id: jobId, tool: 'model_invoke', status: 'finished', text: 'Made the audio clip @a.', call: { number: 1, label: 'A slow song' } }], 0))
    await sendChatReply(third.reply, CALLER.modelName)

    const reply = await endedReply(browser)
    expect(reply).toMatch(new RegExp(`</dez:tool>\\n\\n<dez:audio id="a" type="audio/wav" src="[^"]+\\.wav" expires="[^"]+" tool="model_invoke" ${SONG_MARK} job="queue-1" made-by="${jobId}" hidden="${jobId}"/>\\n\\n`))
    await waitForValue(browser, 'chips after the reply', () => intermediateParts(browser), [hidingPart('audio'), null])
    expect(await shownPlayers(browser)).toStrictEqual([])

    await pressToolChip(browser, 0)
    const player: ShownPlayer = { kind: 'audio', id: 'a', available: true, source: 'blob', seconds: 2, picture: null, clock: 'Not saved', save: 'save' }
    await waitForValue(browser, 'player in the panel', () => shownPlayers(browser), [player])
    expect(await intermediateParts(browser)).toStrictEqual([revealingPart('audio'), null])
    expect(await hiddenPart(browser, 0)).toStrictEqual({ heading: 'Intermediate asset', assets: 1, text: null })

    // Save writes the tag anew: its file is the saved one, and a file has
    // no end time. The player of the panel stays the same element: a new
    // one would stop a clip that plays. The clip stays hidden.
    await browser.execute(() => document.querySelector('.cm-content .media-player')?.setAttribute('data-e2e-kept', ''))
    await pointerClick(browser, '.media-player__save')
    await waitForValue(browser, 'saved player', () => shownPlayers(browser), [{ ...player, clock: null, save: 'saved' }])
    expect(await browser.execute(() => document.querySelector('.cm-content .media-player')?.hasAttribute('data-e2e-kept') ?? false)).toBe(true)
    const savedDir = appFilePath(setup.app.home, 'assets', 'generated', 'audio')
    const saved = new RegExp(`<dez:audio id="a" type="audio/wav" src="${savedDir}/[^"]+\\.wav" tool="model_invoke" ${SONG_MARK} job="queue-1" made-by="${jobId}" hidden="${jobId}"/>`)
    await waitForValue(browser, 'saved tag', async () => saved.test((await threadSections(browser))[1].text), true)
    expect(await intermediateParts(browser)).toStrictEqual([revealingPart('audio'), null])

    await pressToolChip(browser, 0)
    await waitForValue(browser, 'player after the chip closed', () => shownPlayers(browser), [])
    expect(await intermediateParts(browser)).toStrictEqual([hidingPart('audio'), null])
    expect(await openToasts(browser, 'error')).toStrictEqual([])
    expect(await consoleErrors(browser)).toStrictEqual([])
  })

  // The summary of a chip tells it apart from the calls of the same tool in
  // its section (`toolCallSummaries`), so a new call can change it. A new
  // chip would make a new player, which stops a clip that plays, and take
  // the focus from the chip: the drawn chip takes the new summary in place.
  it('keeps the chip and the player of its open panel when a new call of the same tool changes its summary', async () => {
    const model = `${STUDIO.id}/${SONG_MODEL.id}`
    const prompt = 'A slow song for a rainy night'
    await submit(browser, 'Make a draft song.')
    const first = await requestTo(CHAT_PATH)
    sendToolCalls(first.reply, [openAiToolCall('call_song', 'model_invoke', { model, prompt, is_intermediate: true })])
    const queue = await requestTo(QUEUE_PATH, { model: SONG_MODEL.id, prompt })
    const second = await requestTo(CHAT_PATH)
    startedJob(second, 'call_song')
    sendToolCalls(second.reply, [waitCall('call_wait')])
    await finishVeniceJob(setup, queue, { retrievePath: RETRIEVE_PATH, modelId: SONG_MODEL.id, queueId: 'queue-1', clip: { type: 'audio/wav', bytes: SONG_WAV } })
    const third = await requestTo(CHAT_PATH)

    await pressToolChip(browser, 0)
    await waitForValue(browser, 'player in the panel', async () => (await shownPlayers(browser)).length, 1)
    expect((await toolChips(browser))[0].summary).toBe(`"${model}" "${prompt}"`)
    await browser.execute(() => {
      const root = document.querySelector('.cm-content .dez-tool-call')
      const chip = root?.querySelector<HTMLElement>('.dez-tool-call__chip')
      root?.querySelector('.media-player')?.setAttribute('data-e2e-kept', '')
      chip?.setAttribute('data-e2e-kept', '')
      chip?.focus()
    })

    // The new call is refused at once, as `@z` names nothing; its chip is
    // the change.
    sendToolCalls(third.reply, [openAiToolCall('call_again', 'model_invoke', { model, prompt: 'A slow song for a rainy day with @z' })])
    const fourth = await requestTo(CHAT_PATH)
    await waitForValue(browser, 'summaries', async () => (await toolChips(browser)).map((chip) => chip.summary), [`"${model}" "…night"`, null, `"${model}" "…day with @z"`])
    expect((await toolChips(browser))[0].label).toBe(`Tool call model_invoke, "${model}" "…night", intermediate asset`)
    expect(await browser.execute(() => ({
      player: document.querySelector('.cm-content .media-player')?.hasAttribute('data-e2e-kept') ?? false,
      focus: document.activeElement?.matches('.dez-tool-call__chip[data-e2e-kept]') ?? false,
    }))).toStrictEqual({ player: true, focus: true })

    await sendChatReply(fourth.reply, CALLER.modelName)
    await endedReply(browser)
    expect(await openToasts(browser, 'error')).toStrictEqual([])
    expect(await consoleErrors(browser)).toStrictEqual([expect.stringContaining('The tool model_invoke failed')])
  })

  it('shows the answer of a text model to an intermediate call in the panel of its chip', async () => {
    const prompt = 'Name a color.'
    await submit(browser, 'Ask the helper.')
    const first = await requestTo(CHAT_PATH)
    sendToolCalls(first.reply, [askCall('call_ask', prompt, { is_intermediate: true })])
    const asked = await requestTo(HELPER_PATH, { model: HELPER.modelId, stream: true, messages: [{ role: 'user', content: prompt }] })
    const second = await requestTo(CHAT_PATH)
    const started = toolResult(second, 'call_ask')
    await waitForValue(browser, 'chip of the job that runs', () => intermediateParts(browser), [{ eye: 'closed', lit: false, types: ['text'], text: 'intermediate' }])

    sendToolCalls(second.reply, [waitCall('call_wait')])
    await sendChatReply(asked.reply, HELPER.modelName)
    const third = await requestTo(CHAT_PATH)
    await sendChatReply(third.reply, CALLER.modelName)

    // The answer is in no line of the reply, so the reply has nothing to
    // take out of view.
    const reply = await endedReply(browser)
    expect(reply.endsWith(`</dez:tool>\n${replyText(CALLER.modelName)}`)).toBe(true)
    await waitForValue(browser, 'chips after the reply', () => intermediateParts(browser), [{ eye: 'closed', lit: false, types: ['text'], text: 'intermediate text hidden' }, null])

    // The result of the call stays in its own field, after the answer.
    await pressToolChip(browser, 0)
    await waitForValue(browser, 'answer in the panel', () => hiddenPart(browser, 0), { heading: 'Intermediate text', assets: 0, text: invocationAnswerText(replyText(HELPER.modelName)) })
    expect(await intermediateParts(browser)).toStrictEqual([{ eye: 'open', lit: true, types: ['text'], text: 'intermediate text' }, null])
    expect((await toolPanel(browser, 0))?.result).toBe(started)
    expect(await openToasts(browser, 'error')).toStrictEqual([])
    expect(await consoleErrors(browser)).toStrictEqual([])
  })

  it('keeps the image of an intermediate call hidden after a relaunch, and the trash in the open panel takes it out of the reply', async () => {
    const before = await filesIn(generatedDir)
    const { reply, madePath, jobId, started } = await intermediateImageReply()
    const conversationId = await activeConversationId(browser)
    const file = conversationFilePath(setup.app.home, conversationId)
    await waitForValue(browser, 'saved reply', async () => (await fs.promises.readFile(file, 'utf8').catch(() => '')).includes(`hidden=${jobId}`), true)

    browser = await setup.relaunch()
    // A new page: the record that beforeEach started is gone.
    await resetConsoleErrors(browser)
    await waitForValue(browser, 'restored active tab', () => activeConversationId(browser), conversationId)
    await waitForValue(browser, 'restored chips', () => intermediateParts(browser), [hidingPart('image'), null])
    expect(await shownImages(browser)).toStrictEqual([])

    await pressToolChip(browser, 0)
    await waitForValue(browser, 'image in the panel', imageSizes, [{ width: 48, height: 36 }])
    // The image in the panel names the model that made it.
    expect(await assetModelLabels(browser)).toStrictEqual([{ name: STUDIO.modelName, label: `Made by ${STUDIO.modelId} (${STUDIO.modelName}), Provider: ${STUDIO.name}` }])

    // The trash of the image works as at its own place: after the prompt,
    // the file is gone, and the reference leaves the reply with the blank
    // line that was out of view with it.
    await movePointer(browser, await assetPartPoint(browser, '.dez-image', 0, '.dez-image__img'))
    await pointerClickAt(browser, await assetPartPoint(browser, '.dez-image', 0, '.dez-image__trash'))
    await waitForValue(browser, 'delete prompt', async () => await promptMessage(browser) !== null, true)
    await pointerClick(browser, '.confirm-btn--confirm')
    const reference = `![id=a|tool=model_invoke|${PAINT_MARK}|made-by=${jobId}|hidden=${jobId}](${madePath})\n\n`
    await waitForValue(browser, 'reply after the trash', async () => (await threadSections(browser))[1].text, reply.replace(reference, ''))
    await waitForValue(browser, 'files after the trash', () => filesIn(generatedDir), before)

    // The call stays, with its open panel, and its chip hides nothing.
    await waitForValue(browser, 'chips after the trash', () => intermediateParts(browser), [{ eye: 'closed', lit: false, types: [], text: 'intermediate' }, null])
    expect(await hiddenPart(browser, 0)).toBeNull()
    expect((await toolPanel(browser, 0))?.result).toBe(started)
    expect(await shownImages(browser)).toStrictEqual([])
    expect(await openToasts(browser, 'error')).toStrictEqual([])
    expect(await consoleErrors(browser)).toStrictEqual([])
  })
})
