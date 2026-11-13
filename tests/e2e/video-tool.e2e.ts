import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { jobStartedText, jobsWaitResults, startedJobId, type JobResult } from '../../src/model/tools/jobs'
import { REFUSED_DEVICES, REFUSED_PROTOCOLS } from '../../src/model/tools/videoTool'
import { consoleErrors, pointerClick, resetConsoleErrors, screenshotOnFailure, waitForValue } from './harness/dom'
import { linkedDropDir } from './harness/drops'
import { appFilePath, filesIn, mediaTempDir, newFileIn, storedFileName, workDir, writeTestFile } from './harness/fixtures'
import { generatedImagesDir, shownImages, solidPng } from './harness/images'
import { startedJob, waitCall } from './harness/jobs'
import { clipTag, MP4_VIDEO, shownPlayers, silentWav, startClipServer, WEBM_VIDEO, type ClipServer, type ShownPlayer } from './harness/media'
import { startMockProviderApp, takeRequest, type MockProviderApp } from './harness/mockProviderApp'
import { mockChatPath, openAiToolCall, replyText, sendChatReply, sendToolCalls, toolResult, type HeldRequest, type MockProvider } from './harness/mockServer'
import { pidsWithCwd } from './harness/processes'
import type { E2EBrowser } from './harness/session'
import { endedReply, newTab, openSeededConversation, openToasts, pickModel, submit, waitForThread } from './harness/thread'

// The `video` tool, driven through the real app against a mock chat model
// in this process. The app runs the real ffmpeg and ffprobe of the debug
// build:
// - `join_clips` joins clips with the same streams with no new encode (a
//   stored file, a file that the user linked, and a clip that is only at
//   its URL), and encodes clips of two formats again;
// - `ffmpeg` runs as a job on copies of the inputs that its arguments name
//   with `@id`: a new clip and a new image go into the generated folders
//   and into the reply, with a new id and the name of the tool; a PNG image
//   goes as a JPEG copy; a run with `-f null -` gives only its log;
// - `ffprobe` gives its output as the result of its call, with the neutral
//   names of the copies;
// - a call whose arguments name a file of the computer, the network, or a
//   device is refused at once: no job, and no work folder;
// - Stop and the time limit of a call end the program;
// - every work folder is gone after its call, and no file of the
//   conversation changes;
// - the lists of refused protocols and devices hold every one of this
//   ffmpeg build.
// No request holds a path of the test HOME (`takeRequest` checks each one).
//
// One app session serves the whole file; each test starts in a new tab.

const CALLER: MockProvider = { id: 'caller', name: 'Caller Mock', modelId: 'caller-model', modelName: 'Caller Model' }
const CHAT_PATH = mockChatPath(CALLER)
const HOUR_MS = 60 * 60 * 1000

// Even sizes, which the VP9 encoder needs for the usual pixel format.
const PICTURE_PNG = solidPng(48, 36, [40, 90, 220])
const SOUND_WAV = silentWav(1)

// The bytes of each file of the conversation that `openClips` opens, by
// the id of its clip or image.
const SOURCES = { a: WEBM_VIDEO, b: WEBM_VIDEO, c: PICTURE_PNG, d: MP4_VIDEO, e: SOUND_WAV }
type SourceId = keyof typeof SOURCES
const SOURCE_IDS = Object.keys(SOURCES) as SourceId[]

// The first new id in the conversation of `openClips`, and the place of
// the reply in it.
const CLIPS_REPLY_INDEX = 3

// A run with no end by itself for 10 minutes that does little work: a
// tone into a WAV file at the pace of real time (`-re`).
const ENDLESS_TONE = '-re -f lavfi -i sine=frequency=440 -t 600 tone.wav'

const videoCall = (id: string, command: string, parameters: Record<string, unknown>) =>
  openAiToolCall(id, 'video', { command, parameters: JSON.stringify(parameters) })

/** A job of a `video` call that ended, as the mock model got it. */
interface EndedJob {
  jobId: string
  /** The result of the call that started the job. */
  started: string
  /** The result of the job, from the `jobs_wait` call after it. */
  result: JobResult
  /** The chat request that holds the result of the job. It waits for its
   *  answer. */
  next: HeldRequest
}

describe('video tool', () => {
  let setup: MockProviderApp
  let browser: E2EBrowser
  let clips: ClipServer
  // The folder of the file that the conversation links, out of every temp
  // folder.
  let linkedDir: string
  let workRoot: string
  let videoDir: string
  let audioDir: string
  let imagesDir: string

  const chatRequest = (): Promise<HeldRequest> => takeRequest(setup, CHAT_PATH)

  // The standard output of a run of `program` of the build under test.
  function programOutput (program: 'dez-ffmpeg' | 'dez-ffprobe', args: string[]): string {
    const run = spawnSync(path.join(path.dirname(setup.app.binary), program), args, { encoding: 'utf8' })
    if (run.status !== 0) throw new Error(`${program} ${args.join(' ')} failed: ${run.stderr}`)
    return run.stdout
  }

  // The facts of the media file `file`: each stream (`video vp9 48x36`,
  // `audio opus`), and the length in s to 1 decimal place (null for an
  // image).
  function mediaFacts (file: string): { streams: string[], seconds: number | null } {
    const output = programOutput('dez-ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height:format=duration', '-of', 'json', file])
    const { streams, format } = JSON.parse(output) as {
      streams: Array<{ codec_type: string, codec_name: string, width?: number, height?: number }>
      format: { duration?: string }
    }
    return {
      streams: streams.map(({ codec_type: type, codec_name: codec, width, height }) => `${type} ${codec}${width === undefined ? '' : ` ${width}x${height}`}`),
      seconds: format.duration === undefined ? null : Math.round(Number(format.duration) * 10) / 10,
    }
  }

  // Opens a conversation with the files of `SOURCES`, each from another
  // place, and a clip that is only at its URL. Gives the path of each
  // file. The next new id of the conversation is `g`.
  // - `@a`: a video clip that the user dropped (a stored file);
  // - `@b`: the same clip as a file that the user linked;
  // - `@c`: a PNG image;
  // - `@d`: the same video in an MP4 file, as the temp copy of a clip that
  //   a model made;
  // - `@e`: a saved audio clip that a model made;
  // - `@f`: the clip of `@a` at the URL of a provider, with no file.
  async function openClips (name: string): Promise<Record<SourceId, string>> {
    const { home } = setup.app
    const files: Record<SourceId, string> = {
      a: appFilePath(home, 'assets', 'video', `${name}-a.webm`),
      b: path.join(linkedDir, `${name}-holiday.webm`),
      c: appFilePath(home, 'assets', 'images', `${name}-c.png`),
      d: path.join(mediaTempDir(home), `${name}-d.mp4`),
      e: path.join(audioDir, `${name}-e.wav`),
    }
    for (const id of SOURCE_IDS) await writeTestFile(files[id], SOURCES[id])
    const expires = new Date(Date.now() + HOUR_MS).toISOString()
    const url = clips.clipUrl('remote.webm')
    await openSeededConversation(browser, home, name, [
      {
        role: 'user',
        text: [
          clipTag('video', { id: 'a', type: 'video/webm', src: files.a }),
          clipTag('video', { id: 'b', type: 'video/webm', src: files.b }),
          `![${files.c}](id=c)`,
          'Here are my clips and my picture.',
        ].join('\n'),
      },
      {
        role: 'agent',
        text: [
          clipTag('video', { id: 'd', type: 'video/mp4', src: files.d, expires }),
          clipTag('audio', { id: 'e', type: 'audio/wav', src: files.e }),
          clipTag('video', { id: 'f', type: 'video/webm', src: url, url, expires }),
        ].join('\n\n'),
      },
      { role: 'user', text: '' },
    ])
    await pickModel(browser, CALLER.name, CALLER.modelName)
    return files
  }

  // Answers the chat request `request` with the `video` call `callId`,
  // and the request after it with a `jobs_wait` call, which gives the
  // result of the job of that call.
  async function runJob (request: HeldRequest, callId: string, command: string, parameters: Record<string, unknown>): Promise<EndedJob> {
    sendToolCalls(request.reply, [videoCall(callId, command, parameters)])
    const second = await chatRequest()
    const jobId = startedJob(second, callId)
    sendToolCalls(second.reply, [waitCall(`${callId}_wait`)])
    const next = await chatRequest()
    const waited = toolResult(next, `${callId}_wait`)
    expect(waited.startsWith('1 job ended. No job still runs.\n\n')).toBe(true)
    const results = jobsWaitResults(waited)
    expect(results.map(({ id, tool }) => ({ id, tool }))).toStrictEqual([{ id: jobId, tool: 'video' }])
    return { jobId, started: toolResult(second, callId), result: results[0], next }
  }

  // The work folder of the one call that runs: waits until the work root
  // holds one folder, and one program works in it.
  async function runningWorkFolder (): Promise<string> {
    await waitForValue(browser, 'programs in the work folders', async () => (await filesIn(workRoot)).map((name) => pidsWithCwd(path.join(workRoot, name)).length), [1])
    const [name] = await filesIn(workRoot)
    return path.join(workRoot, name)
  }

  // After the calls of a test: no work folder stays, no file of the
  // conversation changed, and nothing failed.
  async function expectCleanEnd (files: Record<SourceId, string>): Promise<void> {
    expect(await filesIn(workRoot)).toStrictEqual([])
    for (const id of SOURCE_IDS) expect((await fs.promises.readFile(files[id])).equals(SOURCES[id]), `the file of @${id} is as it was`).toBe(true)
    expect(await openToasts(browser, 'error')).toStrictEqual([])
    expect(await consoleErrors(browser)).toStrictEqual([])
  }

  // The player of a saved video clip of 48x36 pixels that a tool made.
  function madeVideoPlayer (id: string, seconds: number): ShownPlayer {
    return { kind: 'video', id, available: true, source: 'blob', seconds, picture: { width: 48, height: 36 }, clock: null, save: 'saved' }
  }

  beforeAll(async () => {
    clips = await startClipServer({ 'remote.webm': { type: 'video/webm', bytes: WEBM_VIDEO } })
    linkedDir = await linkedDropDir('video-tool')
    setup = await startMockProviderApp(CALLER)
    browser = setup.browser
    const { home } = setup.app
    workRoot = workDir(home)
    videoDir = appFilePath(home, 'assets', 'generated', 'video')
    audioDir = appFilePath(home, 'assets', 'generated', 'audio')
    imagesDir = generatedImagesDir(home)
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
    await clips?.stop()
    if (linkedDir) await fs.promises.rm(linkedDir, { recursive: true, force: true })
  })

  it('joins clips with the same streams with no new encode: a stored file, a linked file, and a clip that is only at its URL', async () => {
    const files = await openClips('join-copy')
    const before = await filesIn(videoDir)
    await submit(browser, 'Join my clips.')
    const job = await runJob(await chatRequest(), 'call_join', 'join_clips', { clips: '@a @b @f' })
    expect(job.started).toBe(`${jobStartedText(job.jobId)}\nThe inputs of the run: the video clip @a as a.webm, the video clip @b as b.webm, the video clip @f as f.webm.`)
    expect(job.result).toStrictEqual({
      id: job.jobId,
      tool: 'video',
      status: 'finished',
      text: 'Joined the 3 clips into one clip with no new encode: their streams match.\nMade the video clip @g.',
    })
    // The linked file is not in the test HOME, which `takeRequest` checks.
    expect(job.next.body).not.toContain(linkedDir)
    await sendChatReply(job.next.reply, CALLER.modelName)

    // The new clip is a stored file of the generated video, written into
    // the reply after the blocks of the call that gave it.
    const reply = await endedReply(browser, CLIPS_REPLY_INDEX)
    const madeName = await newFileIn(browser, videoDir, before)
    expect(madeName).toMatch(storedFileName('webm'))
    const madePath = path.join(videoDir, madeName)
    expect(reply.endsWith(`</dez:tool>\n\n<dez:video id="g" type="video/webm" src="${madePath}" tool="video"/>\n\n${replyText(CALLER.modelName)}`)).toBe(true)
    expect(mediaFacts(madePath)).toStrictEqual({ streams: ['video vp9 48x36'], seconds: 6 })
    await waitForValue(browser, 'player of the new clip', async () => (await shownPlayers(browser)).at(-1), madeVideoPlayer('g', 6))
    await expectCleanEnd(files)
  })

  it('encodes clips of two formats again into the format of the first clip', async () => {
    const files = await openClips('join-encode')
    const before = await filesIn(videoDir)
    await submit(browser, 'Join the two formats.')
    // `@d` is the temp copy of a clip: a file of the cache folder.
    const job = await runJob(await chatRequest(), 'call_join', 'join_clips', { clips: '@a @d' })
    expect(job.started).toBe(`${jobStartedText(job.jobId)}\nThe inputs of the run: the video clip @a as a.webm, the video clip @d as d.mp4.`)
    expect(job.result).toStrictEqual({
      id: job.jobId,
      tool: 'video',
      status: 'finished',
      text: 'Joined the 2 clips into one 48x36 WebM (VP9) clip. Dez encoded them again, as their streams do not match '
        + '(a join with no new encode needs the same format, codecs, size, and frame rate in every clip).\nMade the video clip @g.',
    })
    await sendChatReply(job.next.reply, CALLER.modelName)

    const reply = await endedReply(browser, CLIPS_REPLY_INDEX)
    const madeName = await newFileIn(browser, videoDir, before)
    expect(madeName).toMatch(storedFileName('webm'))
    const madePath = path.join(videoDir, madeName)
    expect(reply.endsWith(`</dez:tool>\n\n<dez:video id="g" type="video/webm" src="${madePath}" tool="video"/>\n\n${replyText(CALLER.modelName)}`)).toBe(true)
    expect(mediaFacts(madePath)).toStrictEqual({ streams: ['video vp9 48x36'], seconds: 4 })
    await waitForValue(browser, 'player of the new clip', async () => (await shownPlayers(browser)).at(-1), madeVideoPlayer('g', 4))
    await expectCleanEnd(files)
  })

  it('runs ffmpeg on copies of a video clip and a sound: the new clip goes into the generated video, and a run with -f null gives only its log', async () => {
    const files = await openClips('ffmpeg-mix')
    const before = await filesIn(videoDir)
    await submit(browser, 'Put the sound on the clip.')
    const mix = await runJob(await chatRequest(), 'call_mix', 'ffmpeg', { arguments: '-i @a -i @e -map 0:v -map 1:a -c:v copy -c:a libopus -shortest mixed.webm' })
    expect(mix.started).toBe(`${jobStartedText(mix.jobId)}\nThe inputs of the run: the video clip @a as a.webm, the audio clip @e as e.wav.`)
    expect(mix.result.status).toBe('finished')
    expect(mix.result.text).toMatch(/^ffmpeg ended with no error and made 1 file that Dez keeps: mixed\.webm \(video clip\)\. The line at the end gives its id\.\nThe end of the log of ffmpeg:\n[\s\S]+\nMade the video clip @g\.$/)

    // An example of the help of the subcommand: the log is the result, and
    // it names the input by the name of its copy.
    const loudness = await runJob(mix.next, 'call_loudness', 'ffmpeg', { arguments: '-v info -i @e -af volumedetect -f null -' })
    expect(loudness.started).toBe(`${jobStartedText(loudness.jobId)}\nThe inputs of the run: the audio clip @e as e.wav.`)
    expect(loudness.result.status).toBe('finished')
    expect(loudness.result.text.startsWith('ffmpeg ended with no error. It made no file, as the call asked for with -f null.\nThe end of the log of ffmpeg:\n')).toBe(true)
    expect(loudness.result.text).toContain('from \'e.wav\'')
    expect(loudness.result.text).toMatch(/mean_volume: -?[\d.]+ dB/)
    expect(loudness.result.text).not.toContain('Made the')
    await sendChatReply(loudness.next.reply, CALLER.modelName)

    const reply = await endedReply(browser, CLIPS_REPLY_INDEX)
    const madeName = await newFileIn(browser, videoDir, before)
    expect(madeName).toMatch(storedFileName('webm'))
    const madePath = path.join(videoDir, madeName)
    expect(reply).toContain(`</dez:tool>\n\n<dez:video id="g" type="video/webm" src="${madePath}" tool="video"/>\n<dez:tool id="call_loudness"`)
    expect(reply.endsWith(`</dez:tool>\n${replyText(CALLER.modelName)}`)).toBe(true)
    expect(mediaFacts(madePath)).toStrictEqual({ streams: ['video vp9 48x36', 'audio opus'], seconds: 1 })
    await waitForValue(browser, 'player of the new clip', async () => (await shownPlayers(browser)).at(-1), madeVideoPlayer('g', 1))
    await expectCleanEnd(files)
  })

  it('takes a frame of a clip as a new image, and makes a clip from a PNG image, which goes to ffmpeg as a JPEG copy', async () => {
    const files = await openClips('ffmpeg-images')
    const imagesBefore = await filesIn(imagesDir)
    const videosBefore = await filesIn(videoDir)
    await submit(browser, 'Take a frame, and make a clip of my picture.')
    // An example of the help of the subcommand.
    const frame = await runJob(await chatRequest(), 'call_frame', 'ffmpeg', { arguments: '-ss 1 -i @a -frames:v 1 -update 1 frame.jpg' })
    expect(frame.started).toBe(`${jobStartedText(frame.jobId)}\nThe inputs of the run: the video clip @a as a.webm.`)
    expect(frame.result.status).toBe('finished')
    expect(frame.result.text).toMatch(/^ffmpeg ended with no error and made 1 file that Dez keeps: frame\.jpg \(image\)\. The line at the end gives its id\.\n[\s\S]+\nMade the image @g\.$/)

    // This ffmpeg reads no PNG file.
    const still = await runJob(frame.next, 'call_still', 'ffmpeg', { arguments: '-loop 1 -i @c -i @e -c:v libvpx-vp9 -pix_fmt yuv420p -c:a libopus -shortest still.webm' })
    expect(still.started).toBe(`${jobStartedText(still.jobId)}\nThe inputs of the run: the image @c as c.jpg (a JPEG copy, with white in place of transparent pixels), the audio clip @e as e.wav.`)
    expect(still.result.status).toBe('finished')
    expect(still.result.text).toMatch(/^ffmpeg ended with no error and made 1 file that Dez keeps: still\.webm \(video clip\)\. The line at the end gives its id\.\n[\s\S]+\nMade the video clip @h\.$/)
    await sendChatReply(still.next.reply, CALLER.modelName)

    // Each new file comes after the blocks of the call that gave it.
    const reply = await endedReply(browser, CLIPS_REPLY_INDEX)
    const imageName = await newFileIn(browser, imagesDir, imagesBefore)
    expect(imageName).toMatch(storedFileName('jpg'))
    const imagePath = path.join(imagesDir, imageName)
    const videoName = await newFileIn(browser, videoDir, videosBefore)
    expect(videoName).toMatch(storedFileName('webm'))
    const videoPath = path.join(videoDir, videoName)
    expect(reply).toContain(`</dez:tool>\n\n![${imagePath}](id=g|tool=video)\n<dez:tool id="call_still"`)
    expect(reply.endsWith(`</dez:tool>\n\n<dez:video id="h" type="video/webm" src="${videoPath}" tool="video"/>\n\n${replyText(CALLER.modelName)}`)).toBe(true)
    expect(mediaFacts(imagePath)).toStrictEqual({ streams: ['video mjpeg 48x36'], seconds: null })
    expect(mediaFacts(videoPath)).toStrictEqual({ streams: ['video vp9 48x36', 'audio opus'], seconds: 1 })
    // The editor draws only the lines near its view, so the image of the
    // first message can have no DOM: find the new image by its file name.
    await waitForValue(browser, 'the new image in the editor', async () => (await shownImages(browser)).find(({ alt }) => alt === imageName), { alt: imageName, width: 48, height: 36 })
    await waitForValue(browser, 'player of the new clip', async () => (await shownPlayers(browser)).at(-1), madeVideoPlayer('h', 1))
    await expectCleanEnd(files)
  })

  it('gives the output of ffprobe as the result of its call, with the names of the copies and no job', async () => {
    const files = await openClips('ffprobe')
    await submit(browser, 'What are these files?')
    const first = await chatRequest()
    // The arguments that give the file name and the format of a file, and
    // the codec and the picture size of its streams.
    const format = '-v error -show_entries format=filename,format_name -of default=noprint_wrappers=1'
    const streams = '-v error -show_entries stream=codec_name,width,height -of csv=p=0'
    sendToolCalls(first.reply, [
      videoCall('call_linked', 'ffprobe', { arguments: `${format} @b` }),
      videoCall('call_temp', 'ffprobe', { arguments: `${format} @d` }),
      videoCall('call_remote', 'ffprobe', { arguments: `${streams} @f` }),
      videoCall('call_picture', 'ffprobe', { arguments: `${streams} @c` }),
    ])

    const second = await chatRequest()
    // The file name that ffprobe tells is the name of the copy, not the
    // name of the user's file.
    expect(toolResult(second, 'call_linked')).toBe('filename=b.webm\nformat_name=matroska,webm')
    expect(toolResult(second, 'call_temp')).toBe('filename=d.mp4\nformat_name=mov,mp4,m4a,3gp,3g2,mj2')
    expect(toolResult(second, 'call_remote')).toBe('vp9,48,36')
    expect(toolResult(second, 'call_picture')).toBe(
      'The image @c went to ffprobe as a JPEG copy, with white in place of transparent pixels: the facts are those of the copy.\nmjpeg,48,36',
    )
    expect(second.body).not.toContain(linkedDir)
    expect(second.body).not.toContain('holiday')
    await sendChatReply(second.reply, CALLER.modelName)

    const reply = await endedReply(browser, CLIPS_REPLY_INDEX)
    expect(reply.endsWith(`</dez:tool>\n${replyText(CALLER.modelName)}`)).toBe(true)
    expect(setup.mock.hasWaitingRequest()).toBe(false)
    await expectCleanEnd(files)
  })

  it('refuses arguments that name a file of the computer, the network, or a device at once, with no job and no work folder', async () => {
    await submit(browser, 'Read my files.')
    const first = await chatRequest()
    sendToolCalls(first.reply, [
      videoCall('call_path', 'ffmpeg', { arguments: '-i /etc/hostname -f null -' }),
      videoCall('call_url', 'ffprobe', { arguments: 'https://example.com/clip.mp4' }),
      videoCall('call_camera', 'ffmpeg', { arguments: '-f v4l2 -i video0 camera.mp4' }),
    ])

    const second = await chatRequest()
    const workFolderOnly = 'The program works only in its own work folder: name an input as @id, and an output as a new file name with no folder.'
    expect(toolResult(second, 'call_path')).toBe(
      `Dez refuses "/etc/hostname" in \`arguments\`: it holds an absolute path. ${workFolderOnly} `
      + 'For a run with no output file, end the arguments with -f null - (not with a path of the system). '
      + 'In an expression, write a division with no space before the "/", as in iw/2. Dez started no job.',
    )
    expect(toolResult(second, 'call_url')).toBe(`Dez refuses "https://example.com/clip.mp4" in \`arguments\`: it holds a URL. ${workFolderOnly} Dez did not run ffprobe.`)
    expect(toolResult(second, 'call_camera')).toBe(
      'Dez refuses "v4l2" in `arguments`: it names the device v4l2. '
      + 'Dez lets the program use no camera, no microphone, no screen, and no sound output of this computer. Dez started no job.',
    )
    for (const callId of ['call_path', 'call_url', 'call_camera']) expect(startedJobId(toolResult(second, callId))).toBeNull()

    sendToolCalls(second.reply, [openAiToolCall('call_list', 'jobs_list', {})])
    const third = await chatRequest()
    expect(toolResult(third, 'call_list')).toBe('This reply has started no job.')
    await sendChatReply(third.reply, CALLER.modelName)

    const reply = await endedReply(browser)
    expect(reply.endsWith(`</dez:tool>\n${replyText(CALLER.modelName)}`)).toBe(true)
    // A run makes its work folder first.
    expect(await filesIn(workRoot)).toStrictEqual([])
    expect(await openToasts(browser, 'error')).toStrictEqual([])
  })

  it('ends the program and deletes its work folder when the user stops the reply, and keeps the tool block of the call', async () => {
    const before = await filesIn(audioDir)
    await submit(browser, 'Make a long tone.')
    const first = await chatRequest()
    const parameters = JSON.stringify({ arguments: ENDLESS_TONE })
    sendToolCalls(first.reply, [videoCall('call_tone', 'ffmpeg', { arguments: ENDLESS_TONE })])
    const second = await chatRequest()
    const started = toolResult(second, 'call_tone')
    expect(started).toBe(`${jobStartedText(startedJob(second, 'call_tone'))}\nThe run has no input image and no input clip.`)
    const folder = await runningWorkFolder()

    // While a reply runs, the Submit button stops it.
    await pointerClick(browser, '.submit-button')
    await waitForValue(browser, 'chat request closed', async () => second.closed, true)
    await waitForValue(browser, 'programs in the work folder', async () => pidsWithCwd(folder), [])
    await waitForValue(browser, 'work folders', () => filesIn(workRoot), [])
    const block = `<dez:tool id="call_tone" name="video" command="ffmpeg" parameters="${parameters.replaceAll('"', '&quot;')}">\n${started}\n</dez:tool>\n`
    await waitForThread(browser, [
      { role: 'user', text: 'Make a long tone.' },
      { role: 'agent', text: block },
      { role: 'user', text: '' },
    ])
    expect(await filesIn(audioDir)).toStrictEqual(before)

    // The call goes back with its result, and the stopped job has no other.
    await submit(browser, 'Go on.')
    const third = await chatRequest()
    expect(toolResult(third, 'call_tone')).toBe(started)
    expect(setup.mock.hasWaitingRequest()).toBe(false)
    expect(await consoleErrors(browser)).toStrictEqual([])
  })

  it('ends a program that runs longer than the time limit of its call, with no new file', async () => {
    const before = await filesIn(audioDir)
    await submit(browser, 'Make a long tone.')
    const first = await chatRequest()
    // The shortest limit that the tool takes.
    sendToolCalls(first.reply, [videoCall('call_tone', 'ffmpeg', { arguments: ENDLESS_TONE, timeout_seconds: 10 })])
    const second = await chatRequest()
    const jobId = startedJob(second, 'call_tone')
    const folder = await runningWorkFolder()
    sendToolCalls(second.reply, [waitCall('call_wait')])

    // The wait is longer than `waitForValue` takes.
    await browser.waitUntil(async () => setup.mock.hasWaitingRequest(), { timeout: 30_000, interval: 100, timeoutMsg: 'the job did not end at its time limit' })
    const third = await chatRequest()
    const [result] = jobsWaitResults(toolResult(third, 'call_wait'))
    expect({ id: result.id, tool: result.tool, status: result.status }).toStrictEqual({ id: jobId, tool: 'video', status: 'timed out' })
    expect(result.text.startsWith('The job did not end within its time limit of 10 seconds, so Dez stopped it. It has no result. This is not a fault of the call.')).toBe(true)
    await sendChatReply(third.reply, CALLER.modelName)

    const reply = await endedReply(browser)
    expect(reply.endsWith(`</dez:tool>\n${replyText(CALLER.modelName)}`)).toBe(true)
    await waitForValue(browser, 'programs in the work folder', async () => pidsWithCwd(folder), [])
    await waitForValue(browser, 'work folders', () => filesIn(workRoot), [])
    expect(await filesIn(audioDir)).toStrictEqual(before)
    expect(await openToasts(browser, 'error')).toStrictEqual([])
  })

  // The argument rule refuses a protocol and a device by its name, so a
  // name that the lists do not hold would pass.
  it('refuses every protocol and every device of the ffmpeg of this build, but the lavfi device', () => {
    // Each name is a line with two spaces before it.
    const protocols = [...programOutput('dez-ffmpeg', ['-hide_banner', '-protocols']).matchAll(/^ {2}(\S+)$/gm)].map((match) => match[1])
    expect(protocols).toContain('file')
    expect(protocols.filter((name) => !REFUSED_PROTOCOLS.includes(name))).toStrictEqual([])

    // ` DE video4linux2,v4l2 Video4Linux2 output device`: the names of a
    // device after its two flags.
    const devices = [...programOutput('dez-ffmpeg', ['-hide_banner', '-devices']).matchAll(/^ [D ][E ] (\S+)/gm)].flatMap((match) => match[1].split(','))
    expect(devices).toContain('lavfi')
    expect(devices.filter((name) => name !== 'lavfi' && !REFUSED_DEVICES.includes(name))).toStrictEqual([])
  })
})
