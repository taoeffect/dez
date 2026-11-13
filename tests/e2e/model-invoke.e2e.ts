import fs from 'node:fs'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { jobsWaitText, startedJobId } from '../../src/model/tools/jobs'
import { click, consoleErrors, pointerClick, resetConsoleErrors, screenshotOnFailure, typeKeys, waitForValue } from './harness/dom'
import { filesIn, mediaTempDir, newFileIn, storedFileName } from './harness/fixtures'
import { generatedImagesDir, pasteImageReference, pngDataUrl, shownImages, solidPng } from './harness/images'
import { finishVeniceJob, shownPlayers, silentWav } from './harness/media'
import { startMockProviderApp, takeRequestTo, type MockProviderApp } from './harness/mockProviderApp'
import { answerHeld, mockChatPath, openAiToolCall, replyText, sendChatReply, sendToolCalls, type HeldRequest, type MockProvider } from './harness/mockServer'
import type { E2EBrowser } from './harness/session'
import { activeTabStreaming, focusEditor, newTab, openToasts, submit, threadSections, waitForThread } from './harness/thread'

// The `model_invoke` tool, driven through the real app against a mock chat
// model (the caller) and a mock of Venice's media API
// (`mediaApi: { format: 'venice' }`) in this process:
// - a call starts a job and returns its job id at once, with the inputs
//   that go; the request of the job holds the prompt and the image that the
//   prompt names with `@id`, as a data URL with no path;
// - `jobs_wait` gives the result of the job, and the image goes into the
//   reply after the blocks of that call, with a new id and the name of the
//   tool;
// - two jobs run at the same time, each `jobs_wait` gives the jobs that
//   ended, and the clip of a provider's job keeps the provider's job id;
// - a call that cannot work is refused at once and starts no job, and a
//   refusal of the provider is the result of its job;
// - a job that runs longer than `timeout_seconds` ends with no result, and
//   Dez closes its request;
// - Stop ends the job and its request, and keeps the tool blocks;
// - a reply that ends while a job runs waits for it and takes its image;
// - a job that failed and that no `jobs_wait` read shows an error toast.
// No request holds a path of the test HOME.
//
// One app session serves the whole file; each test starts in a new tab.

const CALLER: MockProvider = { id: 'caller', name: 'Caller Mock', modelId: 'caller-model', modelName: 'Caller Model' }
const STUDIO: MockProvider = { id: 'studio', name: 'Studio Mock', modelId: 'paint-model', modelName: 'Paint Model' }
const EDIT_MODEL = { id: 'edit-model', name: 'Edit Model' }
const SONG_MODEL = { id: 'song-model', name: 'Song Model' }
const CHAT_PATH = mockChatPath(CALLER)
const GENERATE_PATH = `/${STUDIO.id}/v1/image/generate`
const EDIT_PATH = `/${STUDIO.id}/v1/image/multi-edit`
const QUEUE_PATH = `/${STUDIO.id}/v1/audio/queue`
const RETRIEVE_PATH = `/${STUDIO.id}/v1/audio/retrieve`

// The shorter side has the 256 pixels that Venice's edit API asks for, so
// the image goes as it is.
const PASTED_PNG = solidPng(320, 256, [40, 160, 60])
const MADE_PNG = solidPng(48, 36, [200, 120, 20])
const SONG_WAV = silentWav(2)

const PAINT_PROMPT = 'A fox in the snow'
const paintCall = (id: string, more: Record<string, unknown> = {}) => openAiToolCall(id, 'model_invoke', { model: `${STUDIO.id}/${STUDIO.modelId}`, prompt: PAINT_PROMPT, ...more })
const waitCall = (id: string) => openAiToolCall(id, 'jobs_wait', {})
const PAINT_BODY = { model: STUDIO.modelId, prompt: PAINT_PROMPT, format: 'webp', hide_watermark: true, safe_mode: false }

describe('model_invoke', () => {
  let setup: MockProviderApp
  let browser: E2EBrowser
  let generatedDir: string

  // A chat request and the request of a job go at the same time, so the
  // test takes each request by its path.
  const requestTo = (requestPath: string, json?: unknown): Promise<HeldRequest> => takeRequestTo(setup, requestPath, json)

  /** The result of the call `callId`, as the chat request `request` sends
   *  it back. */
  function toolResult (request: HeldRequest, callId: string): string {
    const { messages } = JSON.parse(request.body) as { messages: Array<{ role: string, tool_call_id?: string, content?: unknown }> }
    const content = messages.find((message) => message.role === 'tool' && message.tool_call_id === callId)?.content
    if (typeof content !== 'string') throw new Error(`toolResult: the request has no result of ${callId}`)
    return content
  }

  /** The id of the job that the call `callId` started. */
  function startedJob (request: HeldRequest, callId: string): string {
    const id = startedJobId(toolResult(request, callId))
    if (id === null) throw new Error(`startedJob: ${callId} started no job`)
    return id
  }

  /** Waits for the end of the reply, and gives its text. */
  async function endedReply (): Promise<string> {
    await waitForValue(browser, 'sections after the reply', async () => (await threadSections(browser)).length, 3)
    await waitForValue(browser, 'streaming', () => activeTabStreaming(browser), false)
    return (await threadSections(browser))[1].text
  }

  beforeAll(async () => {
    setup = await startMockProviderApp(CALLER, {}, {
      moreProviders: [{
        provider: STUDIO,
        config: {
          mediaApi: { format: 'venice' },
          models: [
            { id: STUDIO.modelId, name: STUDIO.modelName, outputs: ['image'], request: 'image' },
            { id: EDIT_MODEL.id, name: EDIT_MODEL.name, outputs: ['image'], request: 'imageEdit' },
            { id: SONG_MODEL.id, name: SONG_MODEL.name, outputs: ['audio'], request: 'music' },
          ],
        },
      }],
      heldPaths: [GENERATE_PATH, EDIT_PATH, QUEUE_PATH, RETRIEVE_PATH],
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

    sendToolCalls(second.reply, [waitCall('call_wait')])
    answerHeld(edit.reply, 'image/png', MADE_PNG)
    const third = await requestTo(CHAT_PATH)
    expect(toolResult(third, 'call_wait')).toBe(jobsWaitText([{ id: jobId, tool: 'model_invoke', status: 'finished', text: 'Made the image @b.' }], 0))
    await sendChatReply(third.reply, CALLER.modelName)

    // The image comes after the blocks of the call that gave it.
    const reply = await endedReply()
    const madeName = await newFileIn(browser, generatedDir, before)
    expect(madeName).toMatch(storedFileName('png'))
    const madePath = path.join(generatedDir, madeName)
    expect(await fs.promises.readFile(madePath)).toEqual(MADE_PNG)
    expect(reply.endsWith(`</dez:tool>\n\n![${madePath}](id=b|tool=model_invoke)\n\n${replyText(CALLER.modelName)}`)).toBe(true)
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

    // The first wait ends with the first job that ends.
    sendToolCalls(second.reply, [waitCall('call_wait_1')])
    answerHeld(paint.reply, 'application/json', JSON.stringify({ images: [MADE_PNG.toString('base64')] }))
    const third = await requestTo(CHAT_PATH)
    expect(toolResult(third, 'call_wait_1')).toBe(jobsWaitText([{ id: paintJob, tool: 'model_invoke', status: 'finished', text: 'Made the image @a.' }], 1))

    sendToolCalls(third.reply, [waitCall('call_wait_2')])
    await finishVeniceJob(setup, queue, { retrievePath: RETRIEVE_PATH, modelId: SONG_MODEL.id, queueId: 'queue-1', clip: { type: 'audio/wav', bytes: SONG_WAV } })
    const fourth = await requestTo(CHAT_PATH)
    expect(toolResult(fourth, 'call_wait_2')).toBe(jobsWaitText([{ id: songJob, tool: 'model_invoke', status: 'finished', text: 'Made the audio clip @b.' }], 0))
    await sendChatReply(fourth.reply, CALLER.modelName)

    // Each asset comes after the blocks of the call that gave it.
    const reply = await endedReply()
    const image = /<\/dez:tool>\n\n!\[[^\]]+\]\(id=a\|tool=model_invoke\)\n/.exec(reply)
    expect(image).not.toBeNull()
    expect(image?.index).toBeLessThan(reply.indexOf('id="call_wait_2"'))
    const clip = /<\/dez:tool>\n\n<dez:audio id="b" type="audio\/wav" src="([^"]+\.wav)" expires="[^"]+" tool="model_invoke" job="queue-1"\/>\n\n([^\n]+)$/.exec(reply)
    expect(clip?.[2]).toBe(replyText(CALLER.modelName))
    expect(path.dirname(clip?.[1] ?? '')).toBe(mediaTempDir(setup.app.home))
    await waitForValue(browser, 'player of the song', () => shownPlayers(browser), [
      { kind: 'audio', id: 'b', available: true, source: 'blob', seconds: 2, picture: null, clock: 'Not saved', save: 'save' },
    ])
    expect(await openToasts(browser, 'error')).toStrictEqual([])
    expect(await consoleErrors(browser)).toStrictEqual([])
  })

  it('refuses a call that cannot work at once with no job, and gives a refusal of the provider as the result of its job', async () => {
    const before = await filesIn(generatedDir)
    await submit(browser, 'Make a picture.')
    const first = await requestTo(CHAT_PATH)
    sendToolCalls(first.reply, [
      // The caller is a chat model, which the tool does not take.
      openAiToolCall('call_chat', 'model_invoke', { model: `${CALLER.id}/${CALLER.modelId}`, prompt: PAINT_PROMPT }),
      paintCall('call_paint'),
    ])

    const paint = await requestTo(GENERATE_PATH, PAINT_BODY)
    const second = await requestTo(CHAT_PATH)
    expect(startedJobId(toolResult(second, 'call_chat'))).toBeNull()
    expect(toolResult(second, 'call_chat')).toContain(CALLER.modelName)
    const jobId = startedJob(second, 'call_paint')

    sendToolCalls(second.reply, [waitCall('call_wait')])
    paint.reply.writeHead(400, { 'Content-Type': 'application/json' })
    paint.reply.end(JSON.stringify({ error: 'The prompt breaks the content rules' }))
    const third = await requestTo(CHAT_PATH)
    const result = toolResult(third, 'call_wait')
    expect(result).toContain(`<job id="${jobId}" tool="model_invoke" status="failed">`)
    expect(result).toContain('The prompt breaks the content rules')
    await sendChatReply(third.reply, CALLER.modelName)

    // The model got the failure, so no toast tells of it.
    const reply = await endedReply()
    expect(reply.endsWith(`</dez:tool>\n${replyText(CALLER.modelName)}`)).toBe(true)
    expect(setup.mock.hasWaitingRequest()).toBe(false)
    expect(await filesIn(generatedDir)).toStrictEqual(before)
    expect(await openToasts(browser, 'error')).toStrictEqual([])
    expect(await consoleErrors(browser)).toContainEqual(expect.stringContaining(`The model_invoke job ${jobId} failed`))
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
    expect(result).toContain(`<job id="${jobId}" tool="model_invoke" status="timed out">`)
    expect(result).toContain('10 seconds')
    await sendChatReply(third.reply, CALLER.modelName)

    const reply = await endedReply()
    expect(reply.endsWith(`</dez:tool>\n${replyText(CALLER.modelName)}`)).toBe(true)
    expect(await filesIn(generatedDir)).toStrictEqual(before)
    expect(await openToasts(browser, 'error')).toStrictEqual([])
  })

  it('ends the job and its request when the user stops the reply, and keeps the tool block of the call', async () => {
    const before = await filesIn(generatedDir)
    await submit(browser, 'Make a picture.')
    const first = await requestTo(CHAT_PATH)
    sendToolCalls(first.reply, [paintCall('call_paint')])
    const paint = await requestTo(GENERATE_PATH, PAINT_BODY)
    const second = await requestTo(CHAT_PATH)
    const started = toolResult(second, 'call_paint')

    // While a reply runs, the Submit button stops it.
    await pointerClick(browser, '.submit-button')
    await waitForValue(browser, 'request of the job closed', async () => paint.closed, true)
    await waitForValue(browser, 'chat request closed', async () => second.closed, true)
    const block = `<dez:tool id="call_paint" name="model_invoke" model="${STUDIO.id}/${STUDIO.modelId}" prompt="${PAINT_PROMPT}">\n${started}\n</dez:tool>\n`
    await waitForThread(browser, [
      { role: 'user', text: 'Make a picture.' },
      { role: 'agent', text: block },
      { role: 'user', text: '' },
    ])
    expect(await filesIn(generatedDir)).toStrictEqual(before)

    // The call goes back with its result, and the stopped job has no other.
    await submit(browser, 'Go on.')
    const third = await requestTo(CHAT_PATH)
    expect(toolResult(third, 'call_paint')).toBe(started)
    expect(setup.mock.hasWaitingRequest()).toBe(false)
    expect(await consoleErrors(browser)).toStrictEqual([])
  })

  it('waits for a job that still runs when the model ends its reply, then puts the image of the job at the end of the reply', async () => {
    const before = await filesIn(generatedDir)
    await submit(browser, 'Make a picture.')
    const first = await requestTo(CHAT_PATH)
    sendToolCalls(first.reply, [paintCall('call_paint')])
    const paint = await requestTo(GENERATE_PATH, PAINT_BODY)
    const second = await requestTo(CHAT_PATH)
    await sendChatReply(second.reply, CALLER.modelName)

    // The model ended its reply, and the reply waits for the job.
    await waitForValue(browser, 'text of the reply', async () => (await threadSections(browser))[1]?.text.endsWith(replyText(CALLER.modelName)) ?? false, true)
    expect(await activeTabStreaming(browser)).toBe(true)
    expect(await threadSections(browser)).toHaveLength(2)

    answerHeld(paint.reply, 'application/json', JSON.stringify({ images: [MADE_PNG.toString('base64')] }))
    const reply = await endedReply()
    const madePath = path.join(generatedDir, await newFileIn(browser, generatedDir, before))
    expect(reply.endsWith(`${replyText(CALLER.modelName)}\n\n![${madePath}](id=a|tool=model_invoke)`)).toBe(true)
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

    const reply = await endedReply()
    expect(reply.endsWith(replyText(CALLER.modelName))).toBe(true)
    await waitForValue(browser, 'error toast', async () => (await openToasts(browser, 'error')).map((toast) => toast.title), ['Job failed'])
    const [{ message }] = await openToasts(browser, 'error')
    expect(message).toContain(jobId)
    expect(message).toContain('The prompt breaks the content rules')
    // Closed, so that it is not open in the next test.
    await click(browser, '.toast-card--error:not(.toast-card--closing) .toast-close')
    await waitForValue(browser, 'error toast closed', () => openToasts(browser, 'error'), [])
  })
})
