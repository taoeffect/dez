import fs from 'node:fs'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { click, consoleErrors, resetConsoleErrors, screenshotOnFailure, waitForValue } from './harness/dom'
import { dropFiles, nativeDrop } from './harness/drops'
import { makeConversation, seedConversation } from './harness/fixtures'
import { pasteImage, pngDataUrl, solidPng } from './harness/images'
import { MP4_VIDEO, WEBM_VIDEO, clipTag, shownPlayers, silentWav } from './harness/media'
import { startMockProviderApp, type MockProviderApp } from './harness/mockProviderApp'
import type { HeldRequest, MockProvider } from './harness/mockServer'
import type { E2EBrowser } from './harness/session'
import { docPosPoint, editorDoc, focusEditor, newTab, openToasts, pasteText, pickModel, sbpCall, setCaret, submit, threadSections, waitForThread } from './harness/thread'

// Clips that a message holds or names with @id, driven through the real
// app against a mock of Venice's media API
// (`mediaApi: { format: 'venice' }`), which also serves the model list:
// - a reference-to-video model of the Seedance 2.0 family gets the image,
//   the video clip, and the audio clip of the message in its reference
//   fields, each as a data URL of the file's bytes with no path, and its
//   prompt names each by its place in its list (`<Video 1>`, `<Audio 1>`);
// - clips that the user drops into the newest message (an HTML5 drop or a
//   native drop) are stored in the clip folders, show as players, and go
//   with no mention; a clip of an earlier message goes by its mention;
// - a model that takes no clip gets the request without the clips, and a
//   warning toast tells that they were left out;
// - an audio clip with no image and no video clip gets an error toast for
//   a model whose audio clips need one, and no request goes.
//
// The clips of replies are temp copies. The video is an MP4 file (Venice
// takes no WebM) that the computer can play, as each clip shows as a
// player.
//
// One app session serves the whole file; each test starts in a new tab.

const FILMS: MockProvider = { id: 'clipfilms', name: 'Clip Films Mock', modelId: 'frames-model', modelName: 'Frames Model' }
const QUEUE_PATH = `/${FILMS.id}/v1/video/queue`
const RETRIEVE_PATH = `/${FILMS.id}/v1/video/retrieve`
// A Seedance 2.0 reference-to-video model: up to 3 video and 3 audio clips
// of 2 to 15 seconds, MP4 or MOV and WAV or MP3 (veniceReferences.ts).
const REFERENCES = { id: 'seedance-2-0-reference-to-video-mock', name: 'Dance References' }

const CONSTRAINTS = {
  model_type: 'image-to-video',
  durations: ['10s', '5s'],
  resolutions: ['720p', '480p'],
  aspect_ratios: [],
  audio_configurable: true,
}
const MODEL_LIST = {
  object: 'list',
  data: [
    { id: FILMS.modelId, name: FILMS.modelName, type: 'video', model_spec: { constraints: CONSTRAINTS } },
    { id: REFERENCES.id, name: REFERENCES.name, type: 'video', model_spec: { constraints: CONSTRAINTS } },
  ],
}
// The fields that each request of the tests sends: the lowest length and
// resolution of the lists, and the default of the "Audio" switch.
const PARAMETERS = { duration: '5s', resolution: '480p', audio: true }

const PNG = solidPng(48, 32, [220, 40, 40])
const BEAT = silentWav(3)
const HOUR_MS = 60 * 60 * 1000

describe('clips that a message names', () => {
  let setup: MockProviderApp
  let browser: E2EBrowser

  // Writes `bytes` as the temp copy `name` of a clip, and gives its tag.
  async function tempClip (kind: 'audio' | 'video', id: string, name: string, bytes: Buffer): Promise<string> {
    const dir = path.join(setup.app.home, '.cache', 'dez', 'media')
    await fs.promises.mkdir(dir, { recursive: true })
    const src = path.join(dir, name)
    await fs.promises.writeFile(src, bytes)
    return clipTag(kind, { id, type: kind === 'audio' ? 'audio/wav' : 'video/mp4', src, expires: new Date(Date.now() + HOUR_MS).toISOString() })
  }

  // Seeds a conversation whose one reply holds the clips `tags`, with
  // `next` as the text of the user section after it, opens it, and picks
  // the model `modelName`.
  async function openClips (id: string, tags: string[], next: string, modelName: string): Promise<void> {
    const reply = tags.join('\n\n')
    await seedConversation(setup.app.home, makeConversation({
      id,
      title: id,
      sections: [
        { role: 'user', nodes: [{ kind: 'text', text: 'Make clips' }] },
        { role: 'agent', nodes: [{ kind: 'text', text: reply }] },
        { role: 'user', nodes: [{ kind: 'text', text: next }] },
      ],
    }))
    await sbpCall(browser, 'dez.model/tabs/openConversation', id)
    await waitForThread(browser, [{ role: 'user', text: 'Make clips' }, { role: 'agent', text: reply }, { role: 'user', text: next }])
    await pickModel(browser, FILMS.name, modelName)
  }

  // Pastes `png` at the end of the doc and waits for its reference, which
  // gets the image id `id`. Returns the text of the message.
  async function pasteAtEnd (png: Buffer, id: string): Promise<string> {
    await focusEditor(browser)
    await setCaret(browser, (await editorDoc(browser)).length)
    await pasteImage(browser, png)
    await waitForValue(browser, `reference of the image ${id}`, async () => (await threadSections(browser)).at(-1)?.text.endsWith(`](id=${id})`), true)
    return (await threadSections(browser)).at(-1)?.text ?? ''
  }

  async function queueRequest (body: Record<string, unknown>): Promise<HeldRequest> {
    const queue = await setup.mock.waitForRequest(browser)
    expect(queue.path).toBe(QUEUE_PATH)
    expect(JSON.parse(queue.body)).toStrictEqual(body)
    expect(queue.body).not.toContain(setup.app.home)
    return queue
  }

  // Answers the queue request with a job whose clip is done at the first
  // ask. Returns the tag of the clip, which the reply `agentIndex` then
  // holds as its whole text.
  async function answerJob (queue: HeldRequest, queueId: string, agentIndex: number, modelId: string): Promise<string> {
    queue.reply.writeHead(200, { 'Content-Type': 'application/json' })
    queue.reply.end(JSON.stringify({ model: modelId, queue_id: queueId, status: 'QUEUED' }))

    const retrieve = await setup.mock.waitForRequest(browser)
    expect(retrieve.path).toBe(RETRIEVE_PATH)
    retrieve.reply.writeHead(200, { 'Content-Type': 'video/webm' })
    retrieve.reply.end(WEBM_VIDEO)

    await waitForValue(browser, 'sections after the reply', async () => (await threadSections(browser)).length, agentIndex + 2)
    return (await threadSections(browser))[agentIndex].text
  }

  beforeAll(async () => {
    setup = await startMockProviderApp(FILMS, {
      mediaApi: { format: 'venice' },
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
    await setup.mock.dropOpenReplies(browser)
  })

  afterAll(async () => {
    await setup?.stop()
  })

  it('sends the image, the video clip, and the audio clip of a message to a reference model, each named in the prompt', async () => {
    const beat = await tempClip('audio', 'a', 'beat.wav', BEAT)
    const dance = await tempClip('video', 'b', 'dance.mp4', MP4_VIDEO)
    await openClips('references', [beat, dance], 'The dancer of @b moves to @a, like ', REFERENCES.name)
    const message = await pasteAtEnd(PNG, 'c')
    await submit(browser, '')

    const queue = await queueRequest({
      model: REFERENCES.id,
      prompt: 'The dancer of <Video 1> moves to <Audio 1>, like <Image 1>',
      ...PARAMETERS,
      reference_image_urls: [pngDataUrl(PNG)],
      reference_video_urls: [`data:video/mp4;base64,${MP4_VIDEO.toString('base64')}`],
      reference_audio_urls: [`data:audio/wav;base64,${BEAT.toString('base64')}`],
    })
    const clip = await answerJob(queue, 'queue-1', 3, REFERENCES.id)

    // The message keeps its mentions; the new clip gets the next id.
    expect(clip).toMatch(/^<dez:video id="d" type="video\/webm" src="[^"]+\.webm" expires="[^"]+" job="queue-1"\/>$/)
    await waitForThread(browser, [
      { role: 'user', text: 'Make clips' },
      { role: 'agent', text: `${beat}\n\n${dance}` },
      { role: 'user', text: message },
      { role: 'agent', text: clip },
      { role: 'user', text: '' },
    ])
    expect(await openToasts(browser, 'warning')).toStrictEqual([])
    expect(await consoleErrors(browser)).toStrictEqual([])
  })

  it('takes clips that are dropped into the newest message, and sends them with its image to a reference model', async () => {
    await pickModel(browser, FILMS.name, REFERENCES.name)
    await focusEditor(browser)
    const text = 'The dancer of @a moves to @b, like '
    await pasteText(browser, text)
    await waitForValue(browser, 'typed text', () => editorDoc(browser), text)

    // Dropped at the line start, before text: each clip gets a whole line
    // and an id, in file order.
    const point = await docPosPoint(browser, 0, 1)
    const accepted = await dropFiles(browser, { x: point.x + 1, y: point.y }, [
      { name: 'dance.mp4', type: 'video/mp4', base64: MP4_VIDEO.toString('base64') },
      { name: 'beat.wav', type: 'audio/wav', base64: BEAT.toString('base64') },
    ])
    expect(accepted).toStrictEqual({ dragover: true, drop: true })
    const tagLines = /^<dez:video id="a" type="video\/mp4" src="([^"]+)"\/>\n<dez:audio id="b" type="audio\/wav" src="([^"]+)"\/>\n/
    await waitForValue(browser, 'tags of the dropped clips', async () => tagLines.test(await editorDoc(browser)), true)
    const [tags, videoSrc, audioSrc] = tagLines.exec(await editorDoc(browser)) ?? ['', '', '']
    expect(path.dirname(videoSrc)).toBe(path.join(setup.app.home, '.config', 'dez', 'assets', 'video'))
    expect(path.dirname(audioSrc)).toBe(path.join(setup.app.home, '.config', 'dez', 'assets', 'audio'))
    expect(await fs.promises.readFile(videoSrc)).toStrictEqual(MP4_VIDEO)
    expect(await fs.promises.readFile(audioSrc)).toStrictEqual(BEAT)
    // A dropped clip is a stored file: no clock, and the Save control
    // shows it as saved.
    await waitForValue(browser, 'players of the dropped clips', () => shownPlayers(browser), [
      { kind: 'video', id: 'a', available: true, source: 'blob', seconds: 2, picture: { width: 48, height: 36 }, clock: null, save: 'saved' },
      { kind: 'audio', id: 'b', available: true, source: 'blob', seconds: 3, picture: null, clock: null, save: 'saved' },
    ])

    const message = await pasteAtEnd(PNG, 'c')
    expect(message.startsWith(`${tags}${text}![`)).toBe(true)
    await submit(browser, '')

    // The tags and the mentions of the clips become their names, and each
    // clip goes once.
    const queue = await queueRequest({
      model: REFERENCES.id,
      prompt: '<Video 1>\n<Audio 1>\nThe dancer of <Video 1> moves to <Audio 1>, like <Image 1>',
      ...PARAMETERS,
      reference_image_urls: [pngDataUrl(PNG)],
      reference_video_urls: [`data:video/mp4;base64,${MP4_VIDEO.toString('base64')}`],
      reference_audio_urls: [`data:audio/wav;base64,${BEAT.toString('base64')}`],
    })
    const clip = await answerJob(queue, 'queue-drop', 1, REFERENCES.id)
    expect(clip).toMatch(/^<dez:video id="d" type="video\/webm" src="[^"]+\.webm" expires="[^"]+" job="queue-drop"\/>$/)
    await waitForThread(browser, [
      { role: 'user', text: message },
      { role: 'agent', text: clip },
      { role: 'user', text: '' },
    ])
    expect(await openToasts(browser, 'warning')).toStrictEqual([])
    expect(await consoleErrors(browser)).toStrictEqual([])
  })

  it('copies a clip of a native file drop into the clip folder, and sends it with a clip of an earlier message that the newest message names', async () => {
    // An audio clip that the user dropped into an earlier message.
    const audioDir = path.join(setup.app.home, '.config', 'dez', 'assets', 'audio')
    await fs.promises.mkdir(audioDir, { recursive: true })
    const beatSrc = path.join(audioDir, 'earlier-beat.wav')
    await fs.promises.writeFile(beatSrc, BEAT)
    const beat = `<dez:audio id="a" type="audio/wav" src="${beatSrc}"/>`
    const first = `${beat}\nMake a dance to this`
    await seedConversation(setup.app.home, makeConversation({
      id: 'earlier-clip',
      title: 'earlier-clip',
      sections: [
        { role: 'user', nodes: [{ kind: 'text', text: first }] },
        { role: 'agent', nodes: [{ kind: 'text', text: 'Drop a video of the dancer.' }] },
        { role: 'user', nodes: [{ kind: 'text', text: 'The dancer moves to @a' }] },
      ],
    }))
    await sbpCall(browser, 'dez.model/tabs/openConversation', 'earlier-clip')
    await waitForThread(browser, [
      { role: 'user', text: first },
      { role: 'agent', text: 'Drop a video of the dancer.' },
      { role: 'user', text: 'The dancer moves to @a' },
    ])
    await pickModel(browser, FILMS.name, REFERENCES.name)

    // A real native drop adds the file to the asset scope; this one does
    // not, so the file is in the clip folder, which is always in it.
    const videoDir = path.join(setup.app.home, '.config', 'dez', 'assets', 'video')
    await fs.promises.mkdir(videoDir, { recursive: true })
    const source = path.join(videoDir, 'dropped-dance.mp4')
    await fs.promises.writeFile(source, MP4_VIDEO)
    const newest = (await editorDoc(browser)).length - 'The dancer moves to @a'.length
    const point = await docPosPoint(browser, newest, 1)
    await nativeDrop(browser, { x: point.x + 1, y: point.y }, [source])

    const tagLine = /^<dez:video id="b" type="video\/mp4" src="([^"]+)"\/>\nThe dancer moves to @a$/
    await waitForValue(browser, 'tag of the dropped clip', async () => tagLine.test((await threadSections(browser)).at(-1)?.text ?? ''), true)
    const [message, videoSrc] = tagLine.exec((await threadSections(browser)).at(-1)?.text ?? '') ?? ['', '']
    expect(path.dirname(videoSrc)).toBe(videoDir)
    expect(videoSrc).not.toBe(source)
    expect(await fs.promises.readFile(videoSrc)).toStrictEqual(MP4_VIDEO)
    await waitForValue(browser, 'players', () => shownPlayers(browser), [
      { kind: 'audio', id: 'a', available: true, source: 'blob', seconds: 3, picture: null, clock: null, save: 'saved' },
      { kind: 'video', id: 'b', available: true, source: 'blob', seconds: 2, picture: { width: 48, height: 36 }, clock: null, save: 'saved' },
    ])
    await submit(browser, '')

    // The clip of the earlier message goes by its mention; the tag of that
    // message goes in its request form only, and the prompt holds the
    // newest message.
    const queue = await queueRequest({
      model: REFERENCES.id,
      prompt: '<Video 1>\nThe dancer moves to <Audio 1>',
      ...PARAMETERS,
      reference_video_urls: [`data:video/mp4;base64,${MP4_VIDEO.toString('base64')}`],
      reference_audio_urls: [`data:audio/wav;base64,${BEAT.toString('base64')}`],
    })
    const clip = await answerJob(queue, 'queue-native', 3, REFERENCES.id)
    await waitForThread(browser, [
      { role: 'user', text: first },
      { role: 'agent', text: 'Drop a video of the dancer.' },
      { role: 'user', text: message },
      { role: 'agent', text: clip },
      { role: 'user', text: '' },
    ])
    expect(await openToasts(browser, 'warning')).toStrictEqual([])
    expect(await consoleErrors(browser)).toStrictEqual([])
  })

  it('sends a model that takes no clip the request without the clips, and tells that they were left out', async () => {
    const beat = await tempClip('audio', 'a', 'left-beat.wav', BEAT)
    const dance = await tempClip('video', 'b', 'left-dance.mp4', MP4_VIDEO)
    await openClips('no-clips', [beat, dance], 'Make it dance like @b to @a: ', FILMS.modelName)
    await pasteAtEnd(PNG, 'c')
    await submit(browser, '')

    const queue = await queueRequest({
      model: FILMS.modelId,
      prompt: 'Make it dance like @b to @a: ![image](id=c)',
      ...PARAMETERS,
      image_url: pngDataUrl(PNG),
    })
    await waitForValue(browser, 'warning toast', () => openToasts(browser, 'warning'), [{
      title: 'Clips not sent',
      message: `${FILMS.modelName} takes no clip, so 2 clips were left out of the request.`,
    }])
    expect(await answerJob(queue, 'queue-2', 3, FILMS.modelId)).toMatch(/^<dez:video id="d" type="video\/webm" src="[^"]+\.webm" expires="[^"]+" job="queue-2"\/>$/)
    expect(await consoleErrors(browser)).toStrictEqual([])
  })

  it('refuses an audio clip with no image and no video clip for a model whose audio clips need one, and sends nothing', async () => {
    const refusal = `${REFERENCES.name} takes an audio clip only together with a reference image or video. Add an image or a video clip to the message, or name one with @id.`
    const beat = await tempClip('audio', 'a', 'lone-beat.wav', BEAT)
    await openClips('audio-alone', [beat], 'Dance to @a', REFERENCES.name)
    await submit(browser, '')

    await waitForValue(browser, 'error toast', () => openToasts(browser, 'error'), [{ title: 'Cannot send', message: refusal }])
    expect(setup.mock.hasWaitingRequest()).toBe(false)
    expect(await consoleErrors(browser)).toStrictEqual([`Cannot send: ${refusal}`])
    await click(browser, '.toast-card--error .toast-close')
    await waitForValue(browser, 'error toast closed', () => openToasts(browser, 'error'), [])
    await waitForThread(browser, [
      { role: 'user', text: 'Make clips' },
      { role: 'agent', text: beat },
      { role: 'user', text: 'Dance to @a' },
    ])
  })
})
