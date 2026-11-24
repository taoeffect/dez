import fs from 'node:fs'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { MAX_REQUEST_IMAGE_BYTES } from '../../src/model/streams/pictureBudget'
import { ASSET_INFO_COLUMNS } from '../../src/model/tools/assetInfo'
import { pictureBudgetLeftText, PICTURES_SHOWN_NOTE } from '../../src/model/tools/assetView'
import { jobStartedText, jobsWaitResults, startedJobId } from '../../src/model/tools/jobs'
import { REFUSED_DEVICES, REFUSED_PROTOCOLS, workInputNotFileText, workPathUnreadableText } from '../../src/model/tools/videoTool'
import { byteSizeText } from '../../src/utils/byteSize'
import { sentImageUrls } from './harness/chatBody'
import { consoleErrors, pointerClick, resetConsoleErrors, screenshotOnFailure, waitForValue } from './harness/dom'
import { linkedDropDir } from './harness/drops'
import { appFilePath, filesIn, mediaTempDir, newFileIn, savedTextCount, storedFileName, workDir, writeTestFile } from './harness/fixtures'
import { generatedImagesDir, shownImages, solidPng } from './harness/images'
import { NO_JOBS_LIST_TEXT, runToolJob, startedJob, waitCall, type EndedJob } from './harness/jobs'
import { clipTag, MP4_VIDEO, shownPlayers, silentWav, startClipServer, WEBM_VIDEO, type ClipServer, type ShownPlayer } from './harness/media'
import { startMockProviderApp, takeRequest, type MockProviderApp } from './harness/mockProviderApp'
import { mockChatPath, openAiToolCall, replyText, sendChatReply, sendToolCalls, toolResult, type HeldRequest, type MockProvider } from './harness/mockServer'
import { processExists, runningProgram } from './harness/processes'
import { mediaFacts, pixelColors, programOutput, programRun } from './harness/programs'
import type { E2EBrowser } from './harness/session'
import { activeConversationId, endedReply, newTab, openSeededConversation, openToasts, pickModel, submit, waitForThread } from './harness/thread'
import { hiddenAssetNotes, hiddenPart, hidingPart, intermediateParts, pressToolChip, revealingPart, toolChips, toolPanelPictures } from './harness/toolChips'

// The `video` tool, driven through the real app against a mock chat model
// in this process. The app runs the real ffmpeg and ffprobe of the debug
// build:
// - `join_clips` joins clips with the same streams with no new encode (a
//   stored file, a file that the user linked, and a clip that is only at
//   its URL), and encodes clips of two formats again;
// - `ffmpeg` runs as a job on copies of the inputs that its arguments name
//   with `@id`: a new clip and a new image go into the generated folders
//   and into the reply, with a new id and the name of the tool; a later
//   call of the reply mixes music under the sound of such a new clip, and
//   another one takes the last frame of such a clip as an image (both the
//   examples of the help); a PNG image goes as its own file, and a new PNG
//   image keeps the transparent pixels of its source; drawtext and
//   `subtitles` (the examples of the help) draw text with the fonts that
//   Dez ships, the subtitles from a text file of the call; a run with
//   `-f null -` gives only its log; with `is_intermediate`, its new clip
//   is hidden under the chip of its call;
// - `ffprobe` gives its output as the result of its call, with the neutral
//   names of the copies;
// - `ffmpeg` with `save_to` moves the frames of a clip into a folder of
//   `/work`, with no asset; later `ffmpeg` and `ffprobe` calls read those
//   files of `/work` as copies; a path of `/work` that is no file is
//   refused with no run, and so is a link there, which Dez does not follow;
// - the examples of the help for an edit: lossless FFV1 segments of an
//   exact count of frames in `/work`, a join of them that loses no frame, a
//   clip with alpha that ffmpeg makes and puts over the edit, and the two
//   passes of loudnorm;
// - the examples of the help for the two filters of this build that use a
//   library: rubberband slows a tone and raises its pitch, and the two
//   passes of vid.stab, through a file of `/work`, make a shaky clip
//   stable;
// - a call whose arguments name a file of the computer (a font too), the
//   network, a device, or a commands file of a filter is refused at once:
//   no job, and no run folder;
// - Stop leaves the program of a job to the next reply; a close of the tab
//   and the time limit of a call end it;
// - every run folder is gone after its call, and no file of the
//   conversation changes;
// - the lists of refused protocols and devices hold every one of this
//   ffmpeg build;
// - `asset_info` tells the facts of each image and clip that its call
//   names (the clips from the same ffprobe), whether the editor hides it,
//   and who made it: the user, a model, or a job of the reply;
// - `asset_view` shows the model an image as it is, the frame sheet of a
//   video clip, and the wave of an audio clip, with the times of the
//   frames and the loudness from the log of the same ffmpeg, in each later
//   request of the reply and, as the same bytes at the same place, in the
//   request of the next reply;
// - on a clip of 4 shots that the spec makes with that ffmpeg, `asset_view`
//   shows the frames at given times (`times`), one frame for each shot
//   (`scenes`) with the wave of the sound as a strip under them, the
//   spectrogram of a tone, and the loudness of the video clip; the panel
//   of each chip shows the picture that its call showed the model, also
//   after a relaunch;
// - `layout` "grid" puts two images and the frame sheets of two video clips
//   into one picture;
// - the `checks` of `asset_info` find the black, frozen, and silent parts,
//   and the loudness curve of each clip;
// - `video cuts` runs the built-in app dez-cuts in the real Deno, waits for
//   it, and finds the cuts of the clip of 4 shots, with a JSON file of
//   each clip in the work folder of the conversation;
// - `video title` runs the built-in app dez-title in the real Deno, waits
//   for it, and puts a clip of the title with alpha (PNG in MOV) into the
//   reply as an asset of its call; the overlay example of the help puts it
//   over a clip.
// No request holds a path of the test HOME (`takeRequest` checks each one).
// Each video clip with sound that the spec makes is VP9 and Opus in WebM:
// the CI GStreamer (.github/workflows/e2e.yml) decodes both, so the players
// of the page can show it.
//
// One app session serves the whole file; each test starts in a new tab.

const CALLER: MockProvider = { id: 'caller', name: 'Caller Mock', modelId: 'caller-model', modelName: 'Caller Model' }
const CHAT_PATH = mockChatPath(CALLER)
const HOUR_MS = 60 * 60 * 1000

// Even sizes, which the VP9 encoder needs for the usual pixel format.
const PICTURE_PNG = solidPng(48, 36, [40, 90, 220])
const SOUND_WAV = silentWav(1)
// A wide and a tall image for the grid.
const TALL_PNG = solidPng(36, 48, [220, 160, 40])

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

// The arguments of ffmpeg that make the video clip `@a` of `openShots`, of
// 4 shots of 1 s at 5 fps (a test picture, red, black, and the test picture
// again), with a tone in the first second, 2 s of silence, and a tone of
// 0.9 s: with a tone of 1 s, the Opus sound makes the clip 4.008 s long,
// not 4 s.
const SHOTS_ARGS = [
  '-v error -y',
  '-f lavfi -i testsrc=size=48x36:rate=5:duration=1',
  '-f lavfi -i color=c=red:size=48x36:rate=5:duration=1',
  '-f lavfi -i color=c=black:size=48x36:rate=5:duration=1',
  '-f lavfi -i testsrc=size=48x36:rate=5:duration=1',
  '-f lavfi -i sine=frequency=440:duration=1',
  '-f lavfi -i anullsrc=r=44100:cl=mono:duration=2',
  '-f lavfi -i sine=frequency=440:duration=0.9',
  '-filter_complex [0:v][1:v][2:v][3:v]concat=n=4:v=1:a=0[v];[4:a][5:a][6:a]concat=n=3:v=0:a=1[a]',
  '-map [v] -map [a] -c:v libvpx-vp9 -pix_fmt yuv420p -c:a libopus',
].join(' ').split(' ')

// The arguments of ffmpeg that make the audio clip `@b` of `openShots`: a
// tone of 1 s in a WAV file.
const TONE_ARGS = '-v error -y -f lavfi -i sine=frequency=440:duration=1'.split(' ')

// The arguments of ffmpeg that make a PNG image of 48x36 pixels of one
// color, each pixel half transparent; and the red, green, blue, and alpha
// of each of its pixels (an alpha of 0.5 is 127).
const ALPHA_ARGS = '-v error -y -f lavfi -i color=c=0x2080ff@0.5:size=48x36,format=rgba -frames:v 1 -update 1'.split(' ')
const ALPHA_COLOR = '32,128,255,127'

// The font of the drawtext example of the help, and its arguments for the
// clip `@a`.
const TITLE_FONT = 'NotoSans-Bold.ttf'
const TITLE_ARGS = `-ss 1 -i @a -frames:v 1 -vf "drawtext=fontfile=fonts/${TITLE_FONT}:text='Night Drive':fontsize=64:fontcolor=white:borderw=4:x=(w-text_w)/2:y=h-text_h-40" -update 1 title.png`
// The font, the text file, and the arguments of the subtitles example of
// the help, for the clip `@a`. The subtitle ends at 2.5 s. The help encodes
// H.264 in MP4; here VP9 in WebM takes its place, as the GStreamer of CI has
// no H.264 decoder and the player of the new clip would fail to load it
// (.github/workflows/e2e.yml).
const SUBTITLES_FONT = 'NotoSans-Regular.ttf'
const SUBTITLES_FILES = { 'words.srt': '1\n00:00:00,000 --> 00:00:02,500\nNight: Drive\n' }
const SUBTITLES_ARGS = '-i @a -vf "subtitles=words.srt:fontsdir=fonts:force_style=\'FontName=Noto Sans\'" -c:v libvpx-vp9 subtitled.webm'

// A tone of 8 s whose level goes up and down: loudnorm does a linear pass 2
// only when the measured loudness range is above 0, which a tone of one
// level does not have.
const SWELL_SOURCE = 'aevalsrc=0.3*sin(2*PI*440*t)*(0.55+0.45*sin(2*PI*0.25*t)):s=48000:d=8'
// The targets of the loudnorm examples of the help.
const LOUDNORM_TARGETS = 'loudnorm=I=-14:TP=-1.2:LRA=11'

// The values of the JSON of loudnorm in the log of an ffmpeg call, by key
// (`input_i`: "-17.57").
function loudnormValues (text: string): Record<string, string> {
  const values = Object.fromEntries(Array.from(text.matchAll(/^\s*"(\w+)" : "([^"]*)",?$/gm), ([, key, value]) => [key, value]))
  expect(Object.keys(values)).toContain('input_i')
  return values
}

// The ids of the files of the conversation that `openShots` opens.
type ShotId = 'a' | 'b' | 'c' | 'd' | 'e'
const SHOT_IDS: ShotId[] = ['a', 'b', 'c', 'd', 'e']

// The last line of an `asset_view` result: what is left of the picture
// budget, in a round that takes as many pictures as the budget has.
const budgetLine = (pictures: number, tokens: number, bytes: number) => pictureBudgetLeftText({ left: { pictures, tokens, bytes }, roundPictures: pictures })

// The loudness line of `asset_view` for the part `part` of a clip.
const loudnessLine = (part: string) => new RegExp(`^Loudness of ${part}: -\\d+(\\.\\d)? LUFS integrated, \\d+(\\.\\d)? LU range, -\\d+(\\.\\d)? dBFS true peak\\.$`)

const videoCall = (id: string, command: string, parameters: Record<string, unknown>) =>
  openAiToolCall(id, 'video', { command, parameters: JSON.stringify(parameters) })

/** A message of an OpenAI-format chat request, as the mock got it. */
interface WireMessage {
  role: string
  content: string | Array<{ type: string, text?: string, image_url?: { url: string } }> | null
}

describe('video tool', () => {
  let setup: MockProviderApp
  let browser: E2EBrowser
  let clips: ClipServer
  // The folder of the file that the conversation links, out of every temp
  // folder.
  let linkedDir: string
  let runFoldersRoot: string
  let videoDir: string
  let audioDir: string
  let imagesDir: string
  // The bytes of each file of the conversation that `openShots` opens, by
  // the id of its clip or image. `beforeAll` makes the clips.
  let shotSources: Record<ShotId, Buffer>
  // The PNG image of `ALPHA_ARGS`, which `beforeAll` makes.
  let alphaPng: Buffer

  const chatRequest = (): Promise<HeldRequest> => takeRequest(setup, CHAT_PATH)

  // The number of light pixels (gray above the middle) of the frame at
  // `seconds` of the picture or clip `file`: the white text that a call
  // draws on a black picture.
  function lightPixels (file: string, seconds = 0): number {
    const gray = programRun(setup.app, 'dez-ffmpeg', ['-v', 'error', '-ss', String(seconds), '-i', file, '-frames:v', '1', '-vf', 'format=gray', '-f', 'rawvideo', '-'])
    return gray.filter((value) => value > 128).length
  }

  // The number of frames of the video stream of `file`, as ffprobe counts
  // them when it decodes the stream.
  function frameCount (file: string): number {
    return Number(programOutput(setup.app, 'dez-ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', file]).trim())
  }

  // The path of the file of the clip `id` that the reply text `reply`
  // shows.
  function madeClipPath (reply: string, id: string): string {
    const match = new RegExp(`<dez:(?:video|audio) id="${id}" type="[^"]+" src="([^"]+)"`).exec(reply)
    expect(match, `the tag of @${id}`).not.toBeNull()
    return match![1]
  }

  // The mean change of the video clip `file` from one frame to the next:
  // the mean gray level (0 to 255) of the difference of each two frames.
  function meanFrameChange (file: string): number {
    const log = programOutput(setup.app, 'dez-ffmpeg', ['-v', 'error', '-i', file, '-vf', 'tblend=all_mode=difference,signalstats,metadata=mode=print:key=lavfi.signalstats.YAVG:file=-', '-f', 'null', '-'])
    const values = Array.from(log.matchAll(/^lavfi\.signalstats\.YAVG=([\d.]+)$/gm), (match) => Number(match[1]))
    expect(values.length).toBeGreaterThan(10)
    return values.reduce((sum, value) => sum + value, 0) / values.length
  }

  // The frequency of the tone of the audio clip `file`, in Hz: the count of
  // its rises through 0 in each second, with 0.25 s left out at each end.
  // rubberband smears the hard stop of a tone over the end of its clip,
  // which then has more rises (548 a second in the last 0.25 s of a tone of
  // 524 Hz).
  function toneFrequency (file: string): number {
    const pcm = programRun(setup.app, 'dez-ffmpeg', ['-v', 'error', '-i', file, '-f', 's16le', '-ac', '1', '-ar', '44100', '-'])
    const samples = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length / 2)
    const edge = 0.25 * 44100
    const end = samples.length - edge
    let rises = 0
    for (let index = edge + 1; index < end; index++) if (samples[index - 1] < 0 && samples[index] >= 0) rises++
    return rises / ((end - edge) / 44100)
  }

  // The streams of the picture of the data URL `url`, which must be a
  // JPEG, as ffprobe reads them from a copy in the file `name`
  // (`video mjpeg 1292x240`).
  async function sentJpegFacts (url: string, name: string): Promise<string[]> {
    const [type, data] = url.split(',')
    expect(type).toBe('data:image/jpeg;base64')
    const file = path.join(linkedDir, name)
    await writeTestFile(file, Buffer.from(data, 'base64'))
    return mediaFacts(setup.app, file).streams
  }

  // The bytes of the base64 text of an image of a user message that goes
  // as its file `file`: each request of the conversation sends it, so it
  // takes a part of the picture budget.
  const userImageBytes = (file: Buffer): number => file.toString('base64').length
  // The bytes of the two images of the user in the conversation of
  // `openShots`, `@c` and `@e`.
  const shotsImageBytes = (): number => userImageBytes(shotSources.c) + userImageBytes(shotSources.e)

  // The picture message after the tool messages of the request `request`:
  // the text and the data URL of each part, and the bytes of base64 of all
  // its pictures.
  function sentPictures (request: HeldRequest): { messages: WireMessage[], parts: string[], urls: string[], bytes: number } {
    const { messages }: { messages: WireMessage[] } = JSON.parse(request.body)
    expect(messages.at(-1)?.role).toBe('user')
    const content = messages.at(-1)?.content
    const parts = Array.isArray(content) ? content : []
    const urls = parts.flatMap(({ image_url: image }) => (image ? [image.url] : []))
    return {
      messages,
      parts: parts.map(({ type, text }) => text ?? type),
      urls,
      bytes: urls.reduce((sum, url) => sum + url.split(',')[1].length, 0),
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
          `![id=c](${files.c})`,
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

  // Opens a conversation with the files of `shotSources`, all from the
  // user, and gives the path of each file:
  // - `@a`: a video clip of 4 shots with sound (`SHOTS_ARGS`);
  // - `@b`: a tone of 1 s in a WAV file;
  // - `@c`, `@e`: a wide and a tall PNG image;
  // - `@d`: a video clip of one color, 2 s, with no sound.
  // The images `@c` and `@e` of the user go with each request, and each
  // counts as an image of the largest size: 3,136 tokens for a model of no
  // family. So of 20 pictures and 52,000 tokens, a reply has a budget of
  // 18 pictures and 45,728 tokens.
  async function openShots (name: string): Promise<Record<ShotId, string>> {
    const { home } = setup.app
    const files: Record<ShotId, string> = {
      a: appFilePath(home, 'assets', 'video', `${name}-a.webm`),
      b: appFilePath(home, 'assets', 'audio', `${name}-b.wav`),
      c: appFilePath(home, 'assets', 'images', `${name}-c.png`),
      d: appFilePath(home, 'assets', 'video', `${name}-d.webm`),
      e: appFilePath(home, 'assets', 'images', `${name}-e.png`),
    }
    for (const id of SHOT_IDS) await writeTestFile(files[id], shotSources[id])
    await openSeededConversation(browser, home, name, [
      {
        role: 'user',
        text: [
          clipTag('video', { id: 'a', type: 'video/webm', src: files.a }),
          clipTag('audio', { id: 'b', type: 'audio/wav', src: files.b }),
          `![id=c](${files.c})`,
          clipTag('video', { id: 'd', type: 'video/webm', src: files.d }),
          `![id=e](${files.e})`,
          'Here are my shots.',
        ].join('\n'),
      },
      { role: 'agent', text: 'Got them.' },
      { role: 'user', text: '' },
    ])
    await pickModel(browser, CALLER.name, CALLER.modelName)
    return files
  }

  // Runs the job of the `video` call `callId` (`runToolJob`).
  function runJob (request: HeldRequest, callId: string, command: string, parameters: Record<string, unknown>): Promise<EndedJob> {
    return runToolJob(chatRequest, request, 'video', callId, videoCall(callId, command, parameters))
  }

  // After the calls of a test: no run folder stays, no file of the
  // conversation changed (`files`, from `openClips` or `openShots`, with
  // their bytes in `sources`), and nothing failed.
  async function expectCleanEnd (files: Record<string, string>, sources: Record<string, Buffer> = SOURCES): Promise<void> {
    expect(await filesIn(runFoldersRoot)).toStrictEqual([])
    for (const [id, file] of Object.entries(files)) expect((await fs.promises.readFile(file)).equals(sources[id]), `the file of @${id} is as it was`).toBe(true)
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
    runFoldersRoot = workDir(home)
    videoDir = appFilePath(home, 'assets', 'generated', 'video')
    audioDir = appFilePath(home, 'assets', 'generated', 'audio')
    imagesDir = generatedImagesDir(home)
    const shotsFile = path.join(linkedDir, 'shots.webm')
    const toneFile = path.join(linkedDir, 'tone.wav')
    const alphaFile = path.join(linkedDir, 'alpha.png')
    programOutput(setup.app, 'dez-ffmpeg', [...SHOTS_ARGS, shotsFile])
    programOutput(setup.app, 'dez-ffmpeg', [...TONE_ARGS, toneFile])
    programOutput(setup.app, 'dez-ffmpeg', [...ALPHA_ARGS, alphaFile])
    shotSources = {
      a: await fs.promises.readFile(shotsFile),
      b: await fs.promises.readFile(toneFile),
      c: PICTURE_PNG,
      d: WEBM_VIDEO,
      e: TALL_PNG,
    }
    alphaPng = await fs.promises.readFile(alphaFile)
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
    expect(job.started).toBe(`${jobStartedText(job.jobId, 1)}\nThe inputs of the run: the video clip @a as a.webm, the video clip @b as b.webm, the video clip @f as f.webm.`)
    expect(job.result).toStrictEqual({
      id: job.jobId,
      tool: 'video',
      status: 'finished',
      text: 'Joined the 3 clips into one clip with no new encode: their streams match.\nMade the video clip @g.',
      call: { number: 1, label: 'join_clips @a @b @f' },
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
    expect(reply.endsWith(`</dez:tool>\n\n<dez:video id="g" type="video/webm" src="${madePath}" tool="video" made-by="${job.jobId}"/>\n\n${replyText(CALLER.modelName)}`)).toBe(true)
    expect(mediaFacts(setup.app, madePath)).toStrictEqual({ streams: ['video vp9 48x36'], seconds: 6 })
    await waitForValue(browser, 'player of the new clip', async () => (await shownPlayers(browser)).at(-1), madeVideoPlayer('g', 6))
    await expectCleanEnd(files)
  })

  it('encodes clips of two formats again into the format of the first clip', async () => {
    const files = await openClips('join-encode')
    const before = await filesIn(videoDir)
    await submit(browser, 'Join the two formats.')
    // `@d` is the temp copy of a clip: a file of the cache folder.
    const job = await runJob(await chatRequest(), 'call_join', 'join_clips', { clips: '@a @d' })
    expect(job.started).toBe(`${jobStartedText(job.jobId, 1)}\nThe inputs of the run: the video clip @a as a.webm, the video clip @d as d.mp4.`)
    expect(job.result).toStrictEqual({
      id: job.jobId,
      tool: 'video',
      status: 'finished',
      text: 'Joined the 2 clips into one 48x36 WebM (VP9) clip. Dez encoded them again, as their streams do not match '
        + '(a join with no new encode needs the same format, codecs, size, and frame rate in every clip).\nMade the video clip @g.',
      call: { number: 1, label: 'join_clips @a @d' },
    })
    await sendChatReply(job.next.reply, CALLER.modelName)

    const reply = await endedReply(browser, CLIPS_REPLY_INDEX)
    const madeName = await newFileIn(browser, videoDir, before)
    expect(madeName).toMatch(storedFileName('webm'))
    const madePath = path.join(videoDir, madeName)
    expect(reply.endsWith(`</dez:tool>\n\n<dez:video id="g" type="video/webm" src="${madePath}" tool="video" made-by="${job.jobId}"/>\n\n${replyText(CALLER.modelName)}`)).toBe(true)
    expect(mediaFacts(setup.app, madePath)).toStrictEqual({ streams: ['video vp9 48x36'], seconds: 4 })
    await waitForValue(browser, 'player of the new clip', async () => (await shownPlayers(browser)).at(-1), madeVideoPlayer('g', 4))
    await expectCleanEnd(files)
  })

  it('runs ffmpeg on copies of a video clip and a sound: the new clip goes into the generated video, a later call mixes music under its sound, and a run with -f null gives only its log', async () => {
    const files = await openClips('ffmpeg-mix')
    const before = await filesIn(videoDir)
    await submit(browser, 'Put the sound on the clip.')
    const mix = await runJob(await chatRequest(), 'call_mix', 'ffmpeg', { arguments: '-i @a -i @e -map 0:v -map 1:a -c:v copy -c:a libopus -shortest mixed.webm' })
    expect(mix.started).toBe(`${jobStartedText(mix.jobId, 1)}\nThe inputs of the run: the video clip @a as a.webm, the audio clip @e as e.wav.`)
    expect(mix.result.status).toBe('finished')
    // The result names its call: the start of the command line.
    expect(mix.result.call).toStrictEqual({ number: 1, label: 'ffmpeg -i @a -i @e -map 0:v -map 1:a -c:v copy -c:a libopus -shortest mixed.webm' })
    expect(mix.result.text).toMatch(/^ffmpeg ended with no error and made 1 file that Dez keeps: mixed\.webm \(video clip\)\. The line at the end gives its id\.\nThe end of the log of ffmpeg:\n[\s\S]+\nMade the video clip @g\.$/)
    const madeName = await newFileIn(browser, videoDir, before)

    // An example of the help of the subcommand: the log is the result, and
    // it names the input by the name of its copy.
    const loudness = await runJob(mix.next, 'call_loudness', 'ffmpeg', { arguments: '-v info -i @e -af volumedetect -f null -' })
    expect(loudness.started).toBe(`${jobStartedText(loudness.jobId, 2)}\nThe inputs of the run: the audio clip @e as e.wav.`)
    expect(loudness.result.status).toBe('finished')
    expect(loudness.result.text.startsWith('ffmpeg ended with no error. It made no file, as the call asked for with -f null.\nThe end of the log of ffmpeg:\n')).toBe(true)
    expect(loudness.result.text).toContain('from \'e.wav\'')
    expect(loudness.result.text).toMatch(/mean_volume: -?[\d.]+ dB/)
    expect(loudness.result.text).not.toContain('Made the')

    // Music under the sound of the clip that the first call made, at a
    // lower level: the filter graph with labels of the example of the help,
    // on a clip of this reply.
    const under = await runJob(loudness.next, 'call_under', 'ffmpeg', {
      arguments: '-i @g -i @e -filter_complex "[1:a]volume=0.25[music];[0:a][music]amix=inputs=2:duration=first:normalize=0[a]" -map 0:v -map "[a]" -c:v copy -c:a libopus under.webm',
    })
    expect(under.started).toBe(`${jobStartedText(under.jobId, 3)}\nThe inputs of the run: the video clip @g as g.webm, the audio clip @e as e.wav.`)
    expect(under.result.status).toBe('finished')
    expect(under.result.text.endsWith('\nMade the video clip @h.')).toBe(true)
    await sendChatReply(under.next.reply, CALLER.modelName)

    const reply = await endedReply(browser, CLIPS_REPLY_INDEX)
    expect(madeName).toMatch(storedFileName('webm'))
    const madePath = path.join(videoDir, madeName)
    const underPath = path.join(videoDir, await newFileIn(browser, videoDir, [...before, madeName]))
    expect(reply).toContain(`</dez:tool>\n\n<dez:video id="g" type="video/webm" src="${madePath}" tool="video" made-by="${mix.jobId}"/>\n<dez:tool id="call_loudness"`)
    expect(reply.endsWith(`</dez:tool>\n\n<dez:video id="h" type="video/webm" src="${underPath}" tool="video" made-by="${under.jobId}"/>\n\n${replyText(CALLER.modelName)}`)).toBe(true)
    for (const file of [madePath, underPath]) expect(mediaFacts(setup.app, file)).toStrictEqual({ streams: ['video vp9 48x36', 'audio opus'], seconds: 1 })
    await waitForValue(browser, 'player of the last new clip', async () => (await shownPlayers(browser)).at(-1), madeVideoPlayer('h', 1))
    await expectCleanEnd(files)
  })

  it('hides the clip of an ffmpeg call with is_intermediate under the chip of its call, which shows it when it opens', async () => {
    const files = await openClips('ffmpeg-intermediate')
    const before = await filesIn(videoDir)
    await submit(browser, 'Put the sound on the clip, as a step of your work.')
    const mix = await runJob(await chatRequest(), 'call_part', 'ffmpeg', { arguments: '-i @a -i @e -map 0:v -map 1:a -c:v copy -c:a libopus -shortest part.webm', is_intermediate: true })
    // The flag changes nothing that the model reads.
    expect(mix.started).toBe(`${jobStartedText(mix.jobId, 1)}\nThe inputs of the run: the video clip @a as a.webm, the audio clip @e as e.wav.`)
    expect(mix.result.status).toBe('finished')
    expect(mix.result.text.endsWith('\nMade the video clip @g.')).toBe(true)
    await sendChatReply(mix.next.reply, CALLER.modelName)

    const reply = await endedReply(browser, CLIPS_REPLY_INDEX)
    const madePath = path.join(videoDir, await newFileIn(browser, videoDir, before))
    expect(reply.endsWith(`</dez:tool>\n\n<dez:video id="g" type="video/webm" src="${madePath}" tool="video" made-by="${mix.jobId}" hidden="${mix.jobId}"/>\n\n${replyText(CALLER.modelName)}`)).toBe(true)

    // The chip of the `video` call tells of the clip; the `jobs_wait` chip
    // does not, and no player shows the clip at its place.
    await waitForValue(browser, 'chips after the reply', () => intermediateParts(browser), [hidingPart('video'), null])
    expect((await shownPlayers(browser)).map(({ id }) => id)).not.toContain('g')
    expect(await hiddenAssetNotes(browser)).toStrictEqual([{ text: 'Hidden intermediate video clip @g. Open its tool call to see it.', visible: false }])

    await pressToolChip(browser, 0)
    await waitForValue(browser, 'player in the panel', async () => (await shownPlayers(browser)).find(({ id }) => id === 'g'), madeVideoPlayer('g', 1))
    expect(await intermediateParts(browser)).toStrictEqual([revealingPart('video'), null])
    expect(await hiddenPart(browser, 0)).toStrictEqual({ heading: 'Intermediate asset', assets: 1, text: null })

    await pressToolChip(browser, 0)
    await waitForValue(browser, 'player after the chip closed', async () => (await shownPlayers(browser)).map(({ id }) => id).includes('g'), false)
    expect(await intermediateParts(browser)).toStrictEqual([hidingPart('video'), null])
    await expectCleanEnd(files)
  })

  it('tells the facts of each image and clip that an asset_info call names, whether it is hidden, and who made it', async () => {
    const files = await openClips('asset-info')
    const before = await filesIn(videoDir)
    await submit(browser, 'Tell me about my clips.')
    // A clip that a job made as a step of its work: hidden, and made by the
    // job.
    const mix = await runJob(await chatRequest(), 'call_part', 'ffmpeg', { arguments: '-i @a -i @e -map 0:v -map 1:a -c:v copy -c:a libopus -shortest part.webm', is_intermediate: true })
    expect(mix.result.text.endsWith('\nMade the video clip @g.')).toBe(true)
    sendToolCalls(mix.next.reply, [openAiToolCall('call_info', 'asset_info', { assets: '@g @a @b @c @d @e @f' })])

    const third = await chatRequest()
    const [header, made, ...sources] = toolResult(third, 'call_info').split('\n')
    expect(header).toBe(ASSET_INFO_COLUMNS)
    // The length and the frame rate of the new clip are those of its
    // encode.
    const madeBytes = (await fs.promises.stat(path.join(videoDir, await newFileIn(browser, videoDir, before)))).size
    expect(made).toMatch(/^@g \| video \| WebM \| [\d.]+ s \| 48x36 \| [\d.]+ fps \| vp9 \| sound \(opus\) \| /)
    expect(made.split(' | ').slice(-3)).toStrictEqual([byteSizeText(madeBytes), 'hidden', `made by the video job 1 of its reply: "${mix.result.call.label}"`])
    const video = '2 s | 48x36 | 5 fps | vp9 | no sound'
    expect(sources).toStrictEqual([
      `@a | video | WebM | ${video} | ${byteSizeText(WEBM_VIDEO.length)} | shown | from the user`,
      `@b | video | WebM | ${video} | ${byteSizeText(WEBM_VIDEO.length)} | shown | from the user`,
      `@c | image | PNG | 48x36 | ${byteSizeText(PICTURE_PNG.length)} | shown | from the user`,
      `@d | video | MP4 | ${video} | ${byteSizeText(MP4_VIDEO.length)} | shown | made by a model`,
      `@e | audio | WAV | 1 s | pcm_u8 | 8000 Hz | 1 channel | ${byteSizeText(SOUND_WAV.length)} | shown | made by a model`,
      `@f | video | WebM | ${video} | ${byteSizeText(WEBM_VIDEO.length)} | shown | made by a model`,
    ])
    expect(third.body).not.toContain(linkedDir)
    await sendChatReply(third.reply, CALLER.modelName)

    await endedReply(browser, CLIPS_REPLY_INDEX)
    await expectCleanEnd(files)
  })

  it('shows the model an image, the frame sheet of a video clip, and the wave of a clip that the reply made, in the later requests of the reply and in the next reply', async () => {
    const files = await openClips('asset-view')
    await submit(browser, 'Make a tone, and check it and my clips.')
    const tone = await runJob(await chatRequest(), 'call_tone', 'ffmpeg', { arguments: '-f lavfi -i sine=frequency=440:duration=1 tone.wav' })
    expect(tone.result.text.endsWith('\nMade the audio clip @g.')).toBe(true)
    sendToolCalls(tone.next.reply, [openAiToolCall('call_view', 'asset_view', { assets: '@a @c @g', frames: 4 })])

    const viewed = await chatRequest()
    const [videoLine, sheet, imageLine, audioLine, wave, loudness, end, budget] = toolResult(viewed, 'call_view').split('\n')
    expect(videoLine).toBe(`@a | video | WebM | 2 s | 48x36 | 5 fps | vp9 | no sound | ${byteSizeText(WEBM_VIDEO.length)}`)
    // The times are those of the frames that ffmpeg took: the clip has a
    // frame each 0.2 s, and the sheet takes the first one at or after the
    // middle of each quarter.
    const layout = '4 frames in one row, at 0.4, 0.8, 1.4, 1.8 s'
    expect(sheet).toBe(`Frame sheet of 0 s to 2 s: ${layout}.`)
    expect(imageLine).toBe(`@c | image | PNG | 48x36 | ${byteSizeText(PICTURE_PNG.length)}`)
    expect(audioLine).toMatch(/^@g \| audio \| WAV \| 1 s \| pcm_s16le \| \d+ Hz \| 1 channel \| /)
    expect(wave).toBe('Wave picture of 0 s to 1 s: 800x200 pixels, time runs left to right, and the height is the peak level on a square-root scale.')
    // A sine at the default level of the lavfi source, an eighth of the
    // full scale: about -18 dBFS.
    expect(loudness).toMatch(/^Loudness of 0 s to 1 s: -\d+(\.\d)? LUFS integrated, \d+(\.\d)? LU range, -1[78](\.\d)? dBFS true peak\.$/)
    expect(end).toBe(PICTURES_SHOWN_NOTE)

    // The pictures are one user message right after the tool message, with
    // a line that names each one.
    const { messages, parts, urls, bytes } = sentPictures(viewed)
    expect(messages.at(-2)?.role).toBe('tool')
    expect(parts).toStrictEqual([
      `asset_view: the frame sheet of the video clip @a: ${layout}.`,
      'image_url',
      'asset_view: the image @c.',
      'image_url',
      'asset_view: the wave of the audio clip @g, 0 s to 1 s, time runs left to right.',
      'image_url',
    ])
    const [sheetUrl, imageUrl, waveUrl] = urls
    expect(imageUrl).toBe(`data:image/png;base64,${PICTURE_PNG.toString('base64')}`)
    // Four frames, each scaled into a box of 320 by 320 pixels (320x240),
    // with 4 pixels between them.
    expect(await sentJpegFacts(sheetUrl, 'sheet.jpg')).toStrictEqual(['video mjpeg 1292x240'])
    expect(await sentJpegFacts(waveUrl, 'wave.jpg')).toStrictEqual(['video mjpeg 800x200'])
    // The image `@c` of the user goes with each request, and counts as an
    // image of the largest size (3,136 tokens), so the budget had 19
    // pictures and 48,864 tokens. The sheet costs 47 * 9 = 423 tokens, the
    // picture of the image 2 * 2 = 4, and the wave 29 * 8 = 232; the bytes
    // are those of the base64 data.
    expect(budget).toBe(budgetLine(16, 48_205, MAX_REQUEST_IMAGE_BYTES - userImageBytes(PICTURE_PNG) - bytes))

    // The next request of the reply sends the same messages again, the
    // pictures at the same place.
    sendToolCalls(viewed.reply, [openAiToolCall('call_info', 'asset_info', { assets: '@g' })])
    const after = await chatRequest()
    const { messages: afterMessages }: { messages: WireMessage[] } = JSON.parse(after.body)
    expect(afterMessages.slice(0, messages.length)).toStrictEqual(messages)
    expect(afterMessages.slice(messages.length).map(({ role }) => role)).toStrictEqual(['assistant', 'tool'])
    await sendChatReply(after.reply, CALLER.modelName)
    const reply = await endedReply(browser, CLIPS_REPLY_INDEX)
    // The conversation holds no picture: only the block of the call names
    // the copies, which the requests of the conversation read and its
    // panel shows, in an attribute that no request sends.
    expect(reply.replace(/ pictures="[^"]*"/, '')).not.toContain('asset_view: ')

    // The request of the next reply sends the messages of the reply
    // again, with the pictures at the same place and as the same bytes:
    // the model still sees them, and the prompt cache of the provider
    // still holds.
    await submit(browser, 'Thanks.')
    const next = await chatRequest()
    const { messages: nextMessages }: { messages: WireMessage[] } = JSON.parse(next.body)
    expect(nextMessages.slice(0, afterMessages.length)).toStrictEqual(afterMessages)
    expect(nextMessages.slice(afterMessages.length).map(({ role }) => role)).toStrictEqual(['assistant', 'user'])
    expect(sentImageUrls(next.body)).toStrictEqual([`data:image/png;base64,${PICTURE_PNG.toString('base64')}`, sheetUrl, imageUrl, waveUrl])
    await sendChatReply(next.reply, CALLER.modelName)
    await endedReply(browser, CLIPS_REPLY_INDEX + 2)
    await expectCleanEnd(files)
  })

  it('shows the model the frames of a video clip at given times and one for each shot, with the wave of its sound under them, and the spectrogram of a tone; the panel of each chip shows its picture, also after a relaunch', async () => {
    const { home } = setup.app
    const viewsDir = appFilePath(home, 'assets', 'generated', 'views')
    const viewsBefore = await filesIn(viewsDir)
    const files = await openShots('asset-view-shots')
    await submit(browser, 'Look at my shots and my tone.')
    const first = await chatRequest()
    sendToolCalls(first.reply, [
      openAiToolCall('call_scenes', 'asset_view', { assets: '@a', scenes: true, sound_picture: 'wave' }),
      openAiToolCall('call_times', 'asset_view', { assets: '@a', times: '0.5 2.5' }),
      openAiToolCall('call_spectrogram', 'asset_view', { assets: '@b', sound_picture: 'spectrogram' }),
    ])

    // The pictures of the three calls are one user message after their
    // tool messages, in the order of the calls.
    const viewed = await chatRequest()
    const { messages, parts, urls } = sentPictures(viewed)
    expect(messages.slice(-4, -1).map(({ role }) => role)).toStrictEqual(['tool', 'tool', 'tool'])
    // The clip has a frame each 0.2 s, and a cut at the start of each shot.
    const scenesLabel = 'asset_view: the frame sheet of the shots of the video clip @a: 4 frames in one row, at 0, 1, 2, 3 s; '
      + 'under the frames, the wave of its sound, 0 s to 4 s, time runs left to right.'
    // The first frame at or after 0.5 s is the one at 0.6 s.
    const timesLabel = 'asset_view: the frame sheet of the video clip @a: 2 frames in one row, at 0.6, 2.6 s.'
    const spectrogramLabel = 'asset_view: the spectrogram of the audio clip @b, 0 s to 1 s, time runs left to right and the frequency bottom to top.'
    expect(parts).toStrictEqual([scenesLabel, 'image_url', timesLabel, 'image_url', spectrogramLabel, 'image_url'])
    // Each frame fits in a box of 320 by 320 pixels (320x240), with 4
    // pixels between two frames; the strip is 160 pixels high, 4 pixels
    // under the frames. The spectrogram is 800x200 pixels, with its axes
    // and its scale around it.
    const [scenesUrl, timesUrl, spectrogramUrl] = urls
    const panelPictures = [
      { label: scenesLabel, size: '1292x404' },
      { label: timesLabel, size: '644x240' },
      { label: spectrogramLabel, size: '1082x328' },
    ]
    expect(await sentJpegFacts(scenesUrl, 'scenes.jpg')).toStrictEqual([`video mjpeg ${panelPictures[0].size}`])
    expect(await sentJpegFacts(timesUrl, 'times.jpg')).toStrictEqual([`video mjpeg ${panelPictures[1].size}`])
    expect(await sentJpegFacts(spectrogramUrl, 'spectrogram.jpg')).toStrictEqual([`video mjpeg ${panelPictures[2].size}`])

    // The budget line of each result tells what is left after the pictures
    // of its call and of the calls before it: the sheet of the shots costs
    // 47 * 15 = 705 tokens, the sheet of the times 23 * 9 = 207, and the
    // spectrogram 39 * 12 = 468.
    const leftAfter = (pictures: number, tokens: number, sent: readonly string[]) => budgetLine(
      pictures,
      tokens,
      MAX_REQUEST_IMAGE_BYTES - shotsImageBytes() - sent.reduce((sum, url) => sum + url.split(',')[1].length, 0),
    )
    const shotsLine = `@a | video | WebM | 4 s | 48x36 | 5 fps | vp9 | sound (opus) | ${byteSizeText(shotSources.a.length)}`
    expect(toolResult(viewed, 'call_scenes').split('\n')).toStrictEqual([
      shotsLine,
      'Frame sheet of the shots of 0 s to 4 s: 4 frames in one row, at 0, 1, 2, 3 s. '
        + 'The first frame is the first frame of the part, and each other one the first frame after a cut. Dez found 3 cuts in the part. '
        + 'Under the frames: the wave of the sound of 0 s to 4 s, a strip of 1292x160 pixels; '
        + 'time runs left to right over the whole width of the sheet, and the height is the peak level on a square-root scale.',
      expect.stringMatching(loudnessLine('0 s to 4 s')),
      PICTURES_SHOWN_NOTE,
      leftAfter(17, 45_023, [scenesUrl]),
    ])
    // With `times`, the loudness is of the whole clip.
    expect(toolResult(viewed, 'call_times').split('\n')).toStrictEqual([
      shotsLine,
      'Frame sheet of the first frame at or after each of `times` 0.5, 2.5 s: 2 frames in one row, at 0.6, 2.6 s.',
      expect.stringMatching(loudnessLine('0 s to 4 s')),
      PICTURES_SHOWN_NOTE,
      leftAfter(16, 44_816, [scenesUrl, timesUrl]),
    ])
    expect(toolResult(viewed, 'call_spectrogram').split('\n')).toStrictEqual([
      `@b | audio | WAV | 1 s | pcm_s16le | 44100 Hz | 1 channel | ${byteSizeText(shotSources.b.length)}`,
      'Spectrogram of 0 s to 1 s: 1082x328 pixels, time runs left to right, on the axes at the top and the bottom in seconds of the clip; '
        + 'the frequency runs bottom to top, on the axis at the left in Hz, on a linear scale; '
        + 'and the color is the level of each frequency, on the scale at the right in dBFS.',
      expect.stringMatching(loudnessLine('0 s to 1 s')),
      PICTURES_SHOWN_NOTE,
      leftAfter(15, 44_348, urls),
    ])
    await sendChatReply(viewed.reply, CALLER.modelName)
    await endedReply(browser, CLIPS_REPLY_INDEX)

    // Dez keeps a JPEG copy of each picture: the requests of the
    // conversation read it, and the panel of its chip shows it.
    const copies = (await filesIn(viewsDir)).filter((name) => !viewsBefore.includes(name))
    expect(copies.map((name) => storedFileName('jpg').test(name))).toStrictEqual([true, true, true])

    // The panel of each chip shows the picture of its call under the label
    // that the model got. One panel at a time: CodeMirror draws only the
    // lines near the view.
    const expectPanelPictures = async () => {
      for (const [index, picture] of panelPictures.entries()) {
        await pressToolChip(browser, index)
        await waitForValue(browser, `pictures of the panel of chip ${index}`, () => toolPanelPictures(browser, index), [picture])
        await pressToolChip(browser, index)
        await waitForValue(browser, `closed panel of chip ${index}`, () => toolPanelPictures(browser, index), null)
      }
    }
    await expectPanelPictures()

    // The blocks of the calls name the copies in the conversation file, so
    // the panels show them after a relaunch.
    const conversationId = await activeConversationId(browser)
    await waitForValue(browser, 'saved pictures of the calls', () => savedTextCount(home, conversationId, ' pictures="'), 3)
    browser = await setup.relaunch()
    // A new page: the record that beforeEach started is gone.
    await resetConsoleErrors(browser)
    await waitForValue(browser, 'restored active tab', () => activeConversationId(browser), conversationId)
    await waitForValue(browser, 'restored chips', async () => (await toolChips(browser)).length, 3)
    await expectPanelPictures()
    await expectCleanEnd(files, shotSources)
  })

  it('puts two images and the frame sheets of two video clips into one grid picture', async () => {
    const files = await openShots('asset-grid')
    await submit(browser, 'Compare all of them.')
    const first = await chatRequest()
    sendToolCalls(first.reply, [openAiToolCall('call_grid', 'asset_view', { assets: '@c @e @a @d', layout: 'grid', frames: 4 })])

    const viewed = await chatRequest()
    // Each sheet takes the first frame at or after the middle of each
    // quarter of its clip.
    const shotsSheet = '4 frames in one row, at 0.6, 1.6, 2.6, 3.6 s'
    const colorSheet = '4 frames in one row, at 0.4, 0.8, 1.4, 1.8 s'
    const map = `the images @c and @e, left to right; the frame sheet of the video clip @a: ${shotsSheet}; the frame sheet of the video clip @d: ${colorSheet}`
    const { parts, urls, bytes } = sentPictures(viewed)
    expect(parts).toStrictEqual([`asset_view: a grid, top to bottom: ${map}.`, 'image_url'])
    // The images side by side at their own size, 4 pixels apart (88x48
    // pixels), then each sheet (1292x240), 16 pixels apart: 48 + 16 + 240 +
    // 16 + 240 = 560 pixels high.
    expect(await sentJpegFacts(urls[0], 'grid.jpg')).toStrictEqual(['video mjpeg 1292x560'])
    // The note of each sheet goes first, as the note of a picture. The grid
    // is one picture of 47 * 20 = 940 tokens.
    expect(toolResult(viewed, 'call_grid').split('\n')).toStrictEqual([
      `@c | image | PNG | 48x36 | ${byteSizeText(PICTURE_PNG.length)}`,
      `@e | image | PNG | 36x48 | ${byteSizeText(TALL_PNG.length)}`,
      `@a | video | WebM | 4 s | 48x36 | 5 fps | vp9 | sound (opus) | ${byteSizeText(shotSources.a.length)}`,
      `Frame sheet of 0 s to 4 s: ${shotsSheet}.`,
      expect.stringMatching(loudnessLine('0 s to 4 s')),
      `@d | video | WebM | 2 s | 48x36 | 5 fps | vp9 | no sound | ${byteSizeText(WEBM_VIDEO.length)}`,
      `Frame sheet of 0 s to 2 s: ${colorSheet}.`,
      `Grid picture of 1292x560 pixels, top to bottom: ${map}.`,
      PICTURES_SHOWN_NOTE,
      budgetLine(17, 44_788, MAX_REQUEST_IMAGE_BYTES - shotsImageBytes() - bytes),
    ])
    await sendChatReply(viewed.reply, CALLER.modelName)
    await endedReply(browser, CLIPS_REPLY_INDEX)
    await expectCleanEnd(files, shotSources)
  })

  it('finds the black, frozen, and silent parts, and the loudness curve of each clip that an asset_info call checks', async () => {
    const files = await openShots('asset-checks')
    await submit(browser, 'Check my clips.')
    const first = await chatRequest()
    sendToolCalls(first.reply, [openAiToolCall('call_checks', 'asset_info', { assets: '@a @b @c @d', checks: 'black frozen silence loudness_curve' })])

    const checked = await chatRequest()
    const noPicture = 'no check, the clip has no picture'
    const noSound = 'no check, the clip has no sound'
    const curveValue = '(-\\d+(\\.\\d)?|-inf)'
    const curveLine = (values: number) => new RegExp(`^ {2}loudness_curve: ${curveValue}(, ${curveValue}){${values - 1}} LUFS, one value for each second from 0 s`)
    expect(toolResult(checked, 'call_checks').split('\n')).toStrictEqual([
      `${ASSET_INFO_COLUMNS} Under the line of a clip: a line for each check, with times in seconds of the clip.`,
      `@a | video | WebM | 4 s | 48x36 | 5 fps | vp9 | sound (opus) | ${byteSizeText(shotSources.a.length)} | shown | from the user`,
      '  black: 2 s to 3 s',
      // The red shot and the black one; the test pictures move.
      '  frozen: 1 s to 2 s, 2 s to 3 s',
      // The silence between the tones, which the Opus encode blurs by a few
      // ms: the decoder of another computer can give other ms.
      expect.stringMatching(/^ {2}silence: 1(\.0\d{0,2})? s to (2\.9\d{0,2}|3) s$/),
      expect.stringMatching(curveLine(4)),
      `@b | audio | WAV | 1 s | pcm_s16le | 44100 Hz | 1 channel | ${byteSizeText(shotSources.b.length)} | shown | from the user`,
      `  black: ${noPicture}`,
      `  frozen: ${noPicture}`,
      '  silence: none',
      expect.stringMatching(curveLine(1)),
      // An image gets no check.
      `@c | image | PNG | 48x36 | ${byteSizeText(PICTURE_PNG.length)} | shown | from the user`,
      // A clip of one color is frozen from its first frame to its end.
      `@d | video | WebM | 2 s | 48x36 | 5 fps | vp9 | no sound | ${byteSizeText(WEBM_VIDEO.length)} | shown | from the user`,
      '  black: none',
      '  frozen: 0 s to the end',
      `  silence: ${noSound}`,
      `  loudness_curve: ${noSound}`,
    ])
    await sendChatReply(checked.reply, CALLER.modelName)
    await endedReply(browser, CLIPS_REPLY_INDEX)
    await expectCleanEnd(files, shotSources)
  })

  it('finds the cuts of each video clip with video cuts, which runs the built-in app dez-cuts and waits for it', async () => {
    const files = await openShots('alias-cuts')
    await submit(browser, 'Find the cuts of my clips.')
    const workFolder = appFilePath(setup.app.home, 'work', await activeConversationId(browser))
    const first = await chatRequest()
    sendToolCalls(first.reply, [videoCall('call_cuts', 'cuts', { clips: '@a @d' })])

    const measured = await chatRequest()
    expect(toolResult(measured, 'call_cuts').split('\n')).toStrictEqual([
      '@a (20 frames, 4.000 s at 5 fps): 3 cuts, at 1.000, 2.000, 3.000 s. In /work/cuts-a.json.',
      '@d (10 frames, 2.000 s at 5 fps): no cut. In /work/cuts-d.json.',
      'Each file holds id, fps, frames, duration, threshold, and cuts: {frame, time, score} each, where frame is the first frame after the cut. Times are in seconds.',
    ])
    const shots = JSON.parse(await fs.promises.readFile(path.join(workFolder, 'cuts-a.json'), 'utf8')) as { cuts: Array<{ frame: number, time: number }> }
    expect(shots.cuts.map(({ frame, time }) => [frame, time])).toStrictEqual([[5, 1], [10, 2], [15, 3]])
    await sendChatReply(measured.reply, CALLER.modelName)
    await endedReply(browser, CLIPS_REPLY_INDEX)
    await expectCleanEnd(files, shotSources)
  })

  it('takes a frame of a clip as a new image, and makes a clip from a PNG image, which goes to ffmpeg as its own file', async () => {
    const files = await openClips('ffmpeg-images')
    const imagesBefore = await filesIn(imagesDir)
    const videosBefore = await filesIn(videoDir)
    await submit(browser, 'Take a frame, and make a clip of my picture.')
    // An example of the help of the subcommand.
    const frame = await runJob(await chatRequest(), 'call_frame', 'ffmpeg', { arguments: '-ss 1 -i @a -frames:v 1 -update 1 frame.jpg' })
    expect(frame.started).toBe(`${jobStartedText(frame.jobId, 1)}\nThe inputs of the run: the video clip @a as a.webm.`)
    expect(frame.result.status).toBe('finished')
    expect(frame.result.text).toMatch(/^ffmpeg ended with no error and made 1 file that Dez keeps: frame\.jpg \(image\)\. The line at the end gives its id\.\n[\s\S]+\nMade the image @g\.$/)

    // A set length (-t 1) and not -shortest, as the clip of the help has: with
    // -loop 1, the picture can go past the end of the sound on a busy computer.
    // ffmpeg holds the frames of the picture until the sound reaches them, but
    // when it holds 10 s of them (-shortest_buf_duration), it lets them go on.
    // On one CPU, more than half of the runs gave a clip of 1.7 s or more.
    const still = await runJob(frame.next, 'call_still', 'ffmpeg', { arguments: '-loop 1 -i @c -i @e -c:v libvpx-vp9 -pix_fmt yuv420p -c:a libopus -t 1 still.webm' })
    expect(still.started).toBe(`${jobStartedText(still.jobId, 2)}\nThe inputs of the run: the image @c as c.png, the audio clip @e as e.wav.`)
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
    expect(reply).toContain(`</dez:tool>\n\n![id=g|tool=video|made-by=${frame.jobId}](${imagePath})\n<dez:tool id="call_still"`)
    expect(reply.endsWith(`</dez:tool>\n\n<dez:video id="h" type="video/webm" src="${videoPath}" tool="video" made-by="${still.jobId}"/>\n\n${replyText(CALLER.modelName)}`)).toBe(true)
    expect(mediaFacts(setup.app, imagePath)).toStrictEqual({ streams: ['video mjpeg 48x36'], seconds: null })
    expect(mediaFacts(setup.app, videoPath)).toStrictEqual({ streams: ['video vp9 48x36', 'audio opus'], seconds: 1 })
    // The editor draws only the lines near its view, so the image of the
    // first message can have no DOM: find the new image by its file name.
    await waitForValue(browser, 'the new image in the editor', async () => (await shownImages(browser)).find(({ alt }) => alt === imageName), { alt: imageName, width: 48, height: 36 })
    await waitForValue(browser, 'player of the new clip', async () => (await shownPlayers(browser)).at(-1), madeVideoPlayer('h', 1))
    await expectCleanEnd(files)
  })

  it('gives ffmpeg a PNG image as its own file, and keeps its transparent pixels in a new PNG image', async () => {
    const { home } = setup.app
    const file = appFilePath(home, 'assets', 'images', 'ffmpeg-alpha-a.png')
    await writeTestFile(file, alphaPng)
    await openSeededConversation(browser, home, 'ffmpeg-alpha', [
      { role: 'user', text: `![id=a](${file})\nHere is my picture.` },
      { role: 'agent', text: 'Got it.' },
      { role: 'user', text: '' },
    ])
    await pickModel(browser, CALLER.name, CALLER.modelName)
    const before = await filesIn(imagesDir)
    await submit(browser, 'Make it half as large.')
    const small = await runJob(await chatRequest(), 'call_small', 'ffmpeg', { arguments: '-i @a -vf scale=24:18 small.png' })
    expect(small.started).toBe(`${jobStartedText(small.jobId, 1)}\nThe inputs of the run: the image @a as a.png.`)
    expect(small.result.text).toMatch(/^ffmpeg ended with no error and made 1 file that Dez keeps: small\.png \(image\)\. The line at the end gives its id\.\n[\s\S]+\nMade the image @b\.$/)
    await sendChatReply(small.next.reply, CALLER.modelName)

    const reply = await endedReply(browser, CLIPS_REPLY_INDEX)
    const imageName = await newFileIn(browser, imagesDir, before)
    expect(imageName).toMatch(storedFileName('png'))
    const imagePath = path.join(imagesDir, imageName)
    expect(reply.endsWith(`</dez:tool>\n\n![id=b|tool=video|made-by=${small.jobId}](${imagePath})\n\n${replyText(CALLER.modelName)}`)).toBe(true)
    expect(mediaFacts(setup.app, imagePath)).toStrictEqual({ streams: ['video png 24x18'], seconds: null })
    // Each pixel has the color and the alpha of the source.
    expect(pixelColors(setup.app, imagePath)).toStrictEqual([ALPHA_COLOR])
    await waitForValue(browser, 'the new image in the editor', async () => (await shownImages(browser)).find(({ alt }) => alt === imageName), { alt: imageName, width: 24, height: 18 })
    await expectCleanEnd({ a: file }, { a: alphaPng })
  })

  // The way of the help to start a next scene where a clip ends. Each frame
  // of `testsrc` is another picture; the clips of `SOURCES` show one
  // picture in every frame.
  it('takes the last frame of a clip that the reply made as a new image, with the example of the help', async () => {
    const files = await openClips('ffmpeg-last-frame')
    const videosBefore = await filesIn(videoDir)
    const imagesBefore = await filesIn(imagesDir)
    await submit(browser, 'Make a clip, and take its last frame for the next scene.')
    // 10 frames, at 0 s, 0.2 s, …, 1.8 s.
    const count = await runJob(await chatRequest(), 'call_count', 'ffmpeg', { arguments: '-f lavfi -i testsrc=size=48x36:rate=5:duration=2 -c:v libvpx-vp9 count.webm' })
    expect(count.result.text.endsWith('\nMade the video clip @g.')).toBe(true)
    const last = await runJob(count.next, 'call_last', 'ffmpeg', { arguments: '-sseof -1 -i @g -update 1 -q:v 2 last.jpg' })
    expect(last.started).toBe(`${jobStartedText(last.jobId, 2)}\nThe inputs of the run: the video clip @g as g.webm.`)
    expect(last.result.text).toMatch(/^ffmpeg ended with no error and made 1 file that Dez keeps: last\.jpg \(image\)\. The line at the end gives its id\.\n[\s\S]+\nMade the image @h\.$/)
    await sendChatReply(last.next.reply, CALLER.modelName)

    const reply = await endedReply(browser, CLIPS_REPLY_INDEX)
    const countPath = path.join(videoDir, await newFileIn(browser, videoDir, videosBefore))
    const imageName = await newFileIn(browser, imagesDir, imagesBefore)
    expect(imageName).toMatch(storedFileName('jpg'))
    const imagePath = path.join(imagesDir, imageName)
    expect(reply.endsWith(`</dez:tool>\n\n![id=h|tool=video|made-by=${last.jobId}](${imagePath})\n\n${replyText(CALLER.modelName)}`)).toBe(true)
    expect(mediaFacts(setup.app, countPath)).toStrictEqual({ streams: ['video vp9 48x36'], seconds: 2 })

    // The image is the frame at 1.8 s, the last one, and not the one
    // before it: the same ffmpeg takes each of them with a seek.
    const frames = [1.8, 1.6].map((seconds) => {
      const file = path.join(linkedDir, `last-frame-${seconds}.jpg`)
      programOutput(setup.app, 'dez-ffmpeg', ['-v', 'error', '-y', '-ss', String(seconds), '-i', countPath, '-frames:v', '1', '-update', '1', '-q:v', '2', file])
      return fs.readFileSync(file)
    })
    const image = await fs.promises.readFile(imagePath)
    expect(frames.map((frame) => image.equals(frame))).toStrictEqual([true, false])
    await expectCleanEnd(files)
  })

  // The examples of the help that draw text, on a black clip that the reply
  // makes: large enough for the text, and with no light pixel.
  it('writes a title and subtitles on a clip with the fonts that Dez ships, the subtitles from a text file of the call, with the examples of the help', async () => {
    const imagesBefore = await filesIn(imagesDir)
    const videosBefore = await filesIn(videoDir)
    await submit(browser, 'Write a title and subtitles on a dark clip.')
    const dark = await runJob(await chatRequest(), 'call_dark', 'ffmpeg', { arguments: '-f lavfi -i color=c=black:size=640x360:rate=5:duration=3 -c:v libvpx-vp9 dark.webm' })
    expect(dark.result.text.endsWith('\nMade the video clip @a.')).toBe(true)
    const darkName = await newFileIn(browser, videoDir, videosBefore)

    const title = await runJob(dark.next, 'call_title', 'ffmpeg', { arguments: TITLE_ARGS, fonts: TITLE_FONT })
    expect(title.started).toBe(`${jobStartedText(title.jobId, 2)}\nThe inputs of the run: the video clip @a as a.webm. The fonts of the run, in its fonts folder: ${TITLE_FONT}.`)
    expect(title.result.text).toMatch(/^ffmpeg ended with no error and made 1 file that Dez keeps: title\.png \(image\)\. The line at the end gives its id\.\n[\s\S]+\nMade the image @b\.$/)

    const subtitles = await runJob(title.next, 'call_subtitles', 'ffmpeg', { arguments: SUBTITLES_ARGS, fonts: SUBTITLES_FONT, text_files: JSON.stringify(SUBTITLES_FILES) })
    expect(subtitles.started).toBe(`${jobStartedText(subtitles.jobId, 3)}\nThe inputs of the run: the video clip @a as a.webm. `
      + `The fonts of the run, in its fonts folder: ${SUBTITLES_FONT}. The text files of the run, in its run folder: words.srt.`)
    expect(subtitles.result.text).toMatch(/^ffmpeg ended with no error and made 1 file that Dez keeps: subtitled\.webm \(video clip\)\. The line at the end gives its id\.\n[\s\S]+\nMade the video clip @c\.$/)
    // No request names the folder of the fonts that Dez ships.
    expect(subtitles.next.body).not.toContain(path.dirname(setup.app.binary))
    await sendChatReply(subtitles.next.reply, CALLER.modelName)

    const reply = await endedReply(browser)
    const darkPath = path.join(videoDir, darkName)
    const titlePath = path.join(imagesDir, await newFileIn(browser, imagesDir, imagesBefore))
    const subtitledPath = path.join(videoDir, await newFileIn(browser, videoDir, [...videosBefore, darkName]))
    expect(reply).toContain(`</dez:tool>\n\n![id=b|tool=video|made-by=${title.jobId}](${titlePath})\n<dez:tool id="call_subtitles"`)
    expect(reply.endsWith(`</dez:tool>\n\n<dez:video id="c" type="video/webm" src="${subtitledPath}" tool="video" made-by="${subtitles.jobId}"/>\n\n${replyText(CALLER.modelName)}`)).toBe(true)
    expect(mediaFacts(setup.app, titlePath)).toStrictEqual({ streams: ['video png 640x360'], seconds: null })
    expect(mediaFacts(setup.app, subtitledPath)).toStrictEqual({ streams: ['video vp9 640x360'], seconds: 3 })
    // White text on the black clip: the title, and the subtitle until its
    // end. drawtext fails with no font, and libass draws no text when the
    // fonts folder has no font of the family of the style.
    expect(lightPixels(darkPath, 1)).toBe(0)
    expect(lightPixels(titlePath)).toBeGreaterThan(100)
    expect(lightPixels(subtitledPath, 1)).toBeGreaterThan(100)
    expect(lightPixels(subtitledPath, 2.8)).toBe(0)
    await expectCleanEnd({})
  })

  // The overlay example of the help, with VP9 in WebM in place of H.264 in
  // MP4, as in `SUBTITLES_ARGS`. The title shows from 0.5 s to 1.5 s.
  it('makes a title clip with alpha with video title, which runs the built-in app dez-title and waits for it, and puts it over a clip with the overlay example of the help', async () => {
    const videosBefore = await filesIn(videoDir)
    await submit(browser, 'Put a title over a dark clip.')
    const dark = await runJob(await chatRequest(), 'call_dark', 'ffmpeg', { arguments: '-f lavfi -i color=c=black:size=160x90:rate=5:duration=3 -c:v libvpx-vp9 dark.webm' })
    expect(dark.result.text.endsWith('\nMade the video clip @a.')).toBe(true)
    const darkName = await newFileIn(browser, videoDir, videosBefore)

    sendToolCalls(dark.next.reply, [videoCall('call_title', 'title', { text: 'NEON CITY', width: 160, height: 90, fps: 5, duration: 1 })])
    const titled = await chatRequest()
    expect(toolResult(titled, 'call_title')).toBe([
      'The title "NEON CITY": 5 frames of 160×90 at 5 fps (1 s), with an alpha channel, in NotoSerifCJKjp-Black.otf.',
      '',
      'Dez keeps 1 file of the output folder: title.frames/ (video clip: 5 frames, PNG in MOV with alpha). The line at the end gives its id.',
      'Made the video clip @b.',
    ].join('\n'))
    const titleName = await newFileIn(browser, videoDir, [...videosBefore, darkName])
    expect(titleName).toMatch(storedFileName('mov'))

    const overlay = await runJob(titled, 'call_overlay', 'ffmpeg', {
      arguments: '-i @a -itsoffset 0.5 -i @b -filter_complex "[0:v][1:v]overlay=eof_action=pass,format=yuv420p[v]" -map "[v]" -map "0:a?" -c:v libvpx-vp9 -c:a copy titled.webm',
    })
    expect(overlay.result.text.endsWith('\nMade the video clip @c.')).toBe(true)
    await sendChatReply(overlay.next.reply, CALLER.modelName)

    const reply = await endedReply(browser)
    const darkPath = path.join(videoDir, darkName)
    const titlePath = path.join(videoDir, titleName)
    const overlaidPath = path.join(videoDir, await newFileIn(browser, videoDir, [...videosBefore, darkName, titleName]))
    // No job made the title: its clip has the tool of its call and no job.
    expect(reply).toContain(`</dez:tool>\n\n<dez:video id="b" type="video/quicktime" src="${titlePath}" tool="video"/>`)
    expect(reply.endsWith(`</dez:tool>\n\n<dez:video id="c" type="video/webm" src="${overlaidPath}" tool="video" made-by="${overlay.jobId}"/>\n\n${replyText(CALLER.modelName)}`)).toBe(true)
    expect(mediaFacts(setup.app, titlePath)).toStrictEqual({ streams: ['video png 160x90'], seconds: 1 })
    expect(mediaFacts(setup.app, overlaidPath)).toStrictEqual({ streams: ['video vp9 160x90'], seconds: 3 })
    // Most pixels of a frame of the title are transparent; the letters are
    // opaque.
    const pixels = programRun(setup.app, 'dez-ffmpeg', ['-v', 'error', '-ss', '0.5', '-i', titlePath, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'])
    const alphas = pixels.filter((_, index) => index % 4 === 3)
    expect(alphas.filter((alpha) => alpha === 0).length).toBeGreaterThan(alphas.length / 2)
    expect(alphas.filter((alpha) => alpha === 255).length).toBeGreaterThan(100)
    expect(lightPixels(darkPath, 1)).toBe(0)
    expect(lightPixels(overlaidPath, 0.2)).toBe(0)
    expect(lightPixels(overlaidPath, 1)).toBeGreaterThan(100)
    expect(lightPixels(overlaidPath, 2.5)).toBe(0)
    await expectCleanEnd({})
  })

  // The examples of the help for an edit from lossless segments, a clip
  // with alpha that ffmpeg makes over it, and two-pass loudnorm. The source
  // is a black clip, so the white text of the clip with alpha is the only
  // light part. As in `SUBTITLES_ARGS`, VP9 in WebM takes the place of H.264
  // in MP4 in each clip that a player shows.
  it('cuts lossless segments into /work, joins them with no lost frame, puts a clip with alpha that ffmpeg makes over the edit, and sets the loudness of a tone in two passes, with the examples of the help', async () => {
    await submit(browser, 'Edit a dark clip from two segments, put a lower third over it, and set the loudness of a tone.')
    const segFolder = appFilePath(setup.app.home, 'work', await activeConversationId(browser), 'seg')
    const dark = await runJob(await chatRequest(), 'call_dark', 'ffmpeg', { arguments: '-f lavfi -i color=c=black:size=160x90:rate=24:duration=4 -c:v libvpx-vp9 dark.webm' })
    expect(dark.result.text.endsWith('\nMade the video clip @a.')).toBe(true)

    // 24 frames from second 2, and 12 frames from the start.
    const first = await runJob(dark.next, 'call_s1', 'ffmpeg', { arguments: '-ss 2 -i @a -frames:v 24 -an -c:v ffv1 -r 24 s1.mov', save_to: '/work/seg' })
    expect(first.result.text.startsWith('ffmpeg ended with no error, and Dez saved its 1 new file into /work/seg: /work/seg/s1.mov.')).toBe(true)
    const second = await runJob(first.next, 'call_s2', 'ffmpeg', { arguments: '-i @a -frames:v 12 -an -c:v ffv1 -r 24 s2.mov', save_to: '/work/seg' })
    expect(second.result.text.startsWith('ffmpeg ended with no error, and Dez saved its 1 new file into /work/seg: /work/seg/s2.mov.')).toBe(true)
    expect(await filesIn(segFolder)).toStrictEqual(['s1.mov', 's2.mov'])
    for (const [name, frames] of [['s1.mov', 24], ['s2.mov', 12]] as const) {
      const file = path.join(segFolder, name)
      expect(mediaFacts(setup.app, file).streams).toStrictEqual(['video ffv1 160x90'])
      expect(frameCount(file), name).toBe(frames)
    }

    const edit = await runJob(second.next, 'call_edit', 'ffmpeg', {
      arguments: '-i /work/seg/s1.mov -i /work/seg/s2.mov -filter_complex "[0:v][1:v]concat=n=2:v=1:a=0,setpts=N/(24*TB)[v]" -map "[v]" -r 24 -c:v libvpx-vp9 edit.webm',
    })
    expect(edit.result.text.endsWith('\nMade the video clip @b.')).toBe(true)

    // The text shows from 0.5 s to 1 s of the edit of 1.5 s.
    const lower = await runJob(edit.next, 'call_lower', 'ffmpeg', {
      arguments: `-f lavfi -i color=c=black@0:size=160x90:rate=24:duration=0.5,format=rgba -vf "drawtext=fontfile=fonts/${TITLE_FONT}:text='Night Drive':fontsize=20:fontcolor=white:borderw=2:x=10:y=h-text_h-10" -c:v png lower.mov`,
      fonts: TITLE_FONT,
    })
    expect(lower.result.text.endsWith('\nMade the video clip @c.')).toBe(true)
    const over = await runJob(lower.next, 'call_over', 'ffmpeg', {
      arguments: '-i @b -itsoffset 0.5 -i @c -filter_complex "[0:v][1:v]overlay=eof_action=pass,format=yuv420p[v]" -map "[v]" -map "0:a?" -c:v libvpx-vp9 -c:a copy over.webm',
    })
    expect(over.result.text.endsWith('\nMade the video clip @d.')).toBe(true)

    const swell = await runJob(over.next, 'call_swell', 'ffmpeg', { arguments: `-f lavfi -i ${SWELL_SOURCE} swell.wav` })
    expect(swell.result.text.endsWith('\nMade the audio clip @e.')).toBe(true)
    const measure = await runJob(swell.next, 'call_measure', 'ffmpeg', { arguments: `-v info -i @e -af ${LOUDNORM_TARGETS}:print_format=json -f null -` })
    expect(measure.result.text.startsWith('ffmpeg ended with no error. It made no file, as the call asked for with -f null.\n')).toBe(true)
    const measured = loudnormValues(measure.result.text)
    expect(Number(measured.input_i)).toBeLessThan(-16)
    const loud = await runJob(measure.next, 'call_loud', 'ffmpeg', {
      arguments: `-v info -i @e -af ${LOUDNORM_TARGETS}:measured_I=${measured.input_i}:measured_TP=${measured.input_tp}:measured_LRA=${measured.input_lra}`
        + `:measured_thresh=${measured.input_thresh}:offset=${measured.target_offset}:linear=true:print_format=summary -ar 48000 loud.wav`,
    })
    expect(loud.result.text).toMatch(/\nNormalization Type: +Linear\n/)
    expect(loud.result.text.endsWith('\nMade the audio clip @f.')).toBe(true)
    // Pass 1 on the new clip: its loudness is the target.
    const check = await runJob(loud.next, 'call_check', 'ffmpeg', { arguments: `-v info -i @f -af ${LOUDNORM_TARGETS}:print_format=json -f null -` })
    expect(Math.abs(Number(loudnormValues(check.result.text).input_i) + 14)).toBeLessThanOrEqual(0.5)
    await sendChatReply(check.next.reply, CALLER.modelName)

    const reply = await endedReply(browser)
    const clipPath = (id: string): string => madeClipPath(reply, id)
    expect(mediaFacts(setup.app, clipPath('b'))).toStrictEqual({ streams: ['video vp9 160x90'], seconds: 1.5 })
    expect(frameCount(clipPath('b'))).toBe(36)
    expect(mediaFacts(setup.app, clipPath('c'))).toStrictEqual({ streams: ['video png 160x90'], seconds: 0.5 })
    // Most pixels of a frame of the clip with alpha are transparent; the
    // letters are opaque.
    const pixels = programRun(setup.app, 'dez-ffmpeg', ['-v', 'error', '-i', clipPath('c'), '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'])
    const alphas = pixels.filter((_, index) => index % 4 === 3)
    expect(alphas.filter((alpha) => alpha === 0).length).toBeGreaterThan(alphas.length / 2)
    expect(alphas.filter((alpha) => alpha === 255).length).toBeGreaterThan(50)
    expect(lightPixels(clipPath('d'), 0.25)).toBe(0)
    expect(lightPixels(clipPath('d'), 0.75)).toBeGreaterThan(50)
    expect(lightPixels(clipPath('d'), 1.25)).toBe(0)
    expect(mediaFacts(setup.app, clipPath('f'))).toStrictEqual({ streams: ['audio pcm_s16le'], seconds: 8 })
    expect(programOutput(setup.app, 'dez-ffprobe', ['-v', 'error', '-show_entries', 'stream=sample_rate', '-of', 'csv=p=0', clipPath('f')]).trim()).toBe('48000')
    await expectCleanEnd({})
  })

  // The examples of the help for rubberband and for the two passes of
  // vid.stab. The shaky clip is a color chart that does not move, under a
  // crop that moves up to 12 px across and 9 px up or down from its center,
  // so only the shake changes its frames. As in `SUBTITLES_ARGS`, VP9 in
  // WebM takes the place of H.264 in MP4.
  it('slows a tone and raises its pitch with rubberband, and makes a shaky clip stable in two passes through /work, with the examples of the help', async () => {
    const files = await openShots('stabilize')
    await submit(browser, 'Slow my tone and raise it, and make a shaky clip stable.')
    const stabFolder = appFilePath(setup.app.home, 'work', await activeConversationId(browser), 'stab')
    const voice = await runJob(await chatRequest(), 'call_voice', 'ffmpeg', { arguments: '-i @b -af rubberband=tempo=0.8:pitch=1.189:formant=preserved:pitchq=quality voice.wav' })
    expect(voice.result.text.endsWith('\nMade the audio clip @f.')).toBe(true)

    const shaky = await runJob(voice.next, 'call_shaky', 'ffmpeg', {
      arguments: '-f lavfi -i "colorchart=rate=24:patch_size=48x48,trim=duration=3,crop=240:150:\'24+12*sin(n*1.7)\':\'21+9*cos(n*2.3)\'" -c:v libvpx-vp9 -pix_fmt yuv420p shaky.webm',
    })
    expect(shaky.result.text.endsWith('\nMade the video clip @g.')).toBe(true)
    const detect = await runJob(shaky.next, 'call_detect', 'ffmpeg', { arguments: '-i @g -vf vidstabdetect=shakiness=8:result=transforms.trf -f null -', save_to: '/work/stab' })
    expect(detect.result.text.startsWith('ffmpeg ended with no error, and Dez saved its 1 new file into /work/stab: /work/stab/transforms.trf.')).toBe(true)
    expect(await filesIn(stabFolder)).toStrictEqual(['transforms.trf'])
    const stable = await runJob(detect.next, 'call_stable', 'ffmpeg', {
      arguments: '-i @g -vf "vidstabtransform=input=/work/stab/transforms.trf,unsharp=5:5:0.8:3:3:0.4" -c:v libvpx-vp9 -c:a copy stable.webm',
    })
    expect(stable.result.text.endsWith('\nMade the video clip @h.')).toBe(true)
    await sendChatReply(stable.next.reply, CALLER.modelName)

    const reply = await endedReply(browser, CLIPS_REPLY_INDEX)
    // 1 s at 80% of its speed, and 440 Hz times 1.189.
    const voicePath = madeClipPath(reply, 'f')
    expect(Number(programOutput(setup.app, 'dez-ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', voicePath]))).toBeCloseTo(1.25, 2)
    expect(Math.abs(toneFrequency(voicePath) - 523)).toBeLessThanOrEqual(5)
    expect(mediaFacts(setup.app, madeClipPath(reply, 'h'))).toStrictEqual({ streams: ['video vp9 240x150'], seconds: 3 })
    // The local build of the release changed the frames by 16.3 and 1.8.
    expect(meanFrameChange(madeClipPath(reply, 'h'))).toBeLessThan(meanFrameChange(madeClipPath(reply, 'g')) / 4)
    await expectCleanEnd(files, shotSources)
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
    // A PNG image goes as its own file: the result has no note of a copy.
    expect(toolResult(second, 'call_picture')).toBe('png,48,36')
    expect(second.body).not.toContain(linkedDir)
    expect(second.body).not.toContain('holiday')
    await sendChatReply(second.reply, CALLER.modelName)

    const reply = await endedReply(browser, CLIPS_REPLY_INDEX)
    expect(reply.endsWith(`</dez:tool>\n${replyText(CALLER.modelName)}`)).toBe(true)
    expect(setup.mock.hasWaitingRequest()).toBe(false)
    await expectCleanEnd(files)
  })

  it('saves the frames of a clip into a folder of /work with save_to, and gives the files of /work to later ffmpeg and ffprobe calls as copies', async () => {
    const files = await openShots('work-files')
    const imagesBefore = await filesIn(imagesDir)
    await submit(browser, 'Put two frames of my clip side by side.')
    const workFolder = appFilePath(setup.app.home, 'work', await activeConversationId(browser))
    const frames = await runJob(await chatRequest(), 'call_frames', 'ffmpeg', { arguments: '-i @a -vf fps=1 -frames:v 2 f%02d.png', save_to: '/work/frames' })
    expect(frames.started).toBe(`${jobStartedText(frames.jobId, 1)}\nThe inputs of the run: the video clip @a as a.webm. Dez moves the new files of the run into /work/frames.`)
    expect(frames.result.status).toBe('finished')
    expect(frames.result.text).toMatch(/^ffmpeg ended with no error, and Dez saved its 2 new files into \/work\/frames: \/work\/frames\/f01\.png, \/work\/frames\/f02\.png\. They are not in your reply\. [^\n]+\nThe end of the log of ffmpeg:\n/)
    expect(frames.result.text).not.toContain('Made the')
    expect(await filesIn(path.join(workFolder, 'frames'))).toStrictEqual(['f01.png', 'f02.png'])
    expect(mediaFacts(setup.app, path.join(workFolder, 'frames', 'f01.png'))).toStrictEqual({ streams: ['video png 48x36'], seconds: null })
    // A link in the work folder to a file out of it: Dez follows no link
    // there, so it cannot read what is at its path, and it logs why.
    const outside = path.join(linkedDir, 'work-files-outside.png')
    await writeTestFile(outside, PICTURE_PNG)
    await fs.promises.symlink(outside, path.join(workFolder, 'link.png'))

    const pair = await runJob(frames.next, 'call_pair', 'ffmpeg', { arguments: '-i /work/frames/f01.png -i /work/frames/f02.png -filter_complex hstack -update 1 pair.png' })
    expect(pair.started).toBe(`${jobStartedText(pair.jobId, 2)}\nThe inputs of the run: /work/frames/f01.png as work/frames/f01.png, /work/frames/f02.png as work/frames/f02.png.`)
    expect(pair.result.status).toBe('finished')
    expect(pair.result.text).toMatch(/^ffmpeg ended with no error and made 1 file that Dez keeps: pair\.png \(image\)\. [\s\S]+\nMade the image @f\.$/)

    const missing = { virtual: '/work/frames/f03.png', name: 'work/frames/f03.png', file: '' }
    sendToolCalls(pair.next.reply, [
      videoCall('call_probe', 'ffprobe', { arguments: '-v error -show_entries stream=codec_name,width,height -of csv=p=0 /work/frames/f02.png' }),
      videoCall('call_missing', 'ffprobe', { arguments: '-v error -show_entries stream=codec_name -of csv=p=0 /work/frames/f03.png' }),
      videoCall('call_link', 'ffprobe', { arguments: '-v error -show_entries stream=codec_name -of csv=p=0 /work/link.png' }),
      // A path of /work in the arguments is an input, also after -frames:v.
      videoCall('call_output', 'ffmpeg', { arguments: '-i @a -frames:v 1 /work/still.png' }),
    ])
    const probed = await chatRequest()
    expect(toolResult(probed, 'call_probe')).toBe('png,48,36')
    expect(toolResult(probed, 'call_missing')).toBe(workInputNotFileText(missing, 'missing', 'ffprobe'))
    expect(toolResult(probed, 'call_link')).toBe(workPathUnreadableText('/work/link.png', 'ffprobe'))
    // Each refused call logs its error too.
    expect(await consoleErrors(browser)).toContainEqual(expect.stringContaining('goes through a link'))
    await resetConsoleErrors(browser)
    expect(toolResult(probed, 'call_output')).toBe(workInputNotFileText({ virtual: '/work/still.png', name: 'work/still.png', file: '' }, 'missing', 'ffmpeg'))
    expect(startedJobId(toolResult(probed, 'call_output'))).toBeNull()
    expect(probed.body).not.toContain(linkedDir)
    await sendChatReply(probed.reply, CALLER.modelName)

    // The reply holds the one image of the pair: the saved frames are no
    // assets.
    const reply = await endedReply(browser, CLIPS_REPLY_INDEX)
    const imagePath = path.join(imagesDir, await newFileIn(browser, imagesDir, imagesBefore))
    expect(reply.match(/!\[id=/g)).toHaveLength(1)
    expect(reply).toContain(`![id=f|tool=video|made-by=${pair.jobId}](${imagePath})`)
    expect(mediaFacts(setup.app, imagePath)).toStrictEqual({ streams: ['video png 96x36'], seconds: null })
    expect(await filesIn(workFolder)).toStrictEqual(['frames', 'link.png'])
    expect((await fs.promises.readFile(outside)).equals(PICTURE_PNG)).toBe(true)
    await expectCleanEnd(files, shotSources)
  })

  it('refuses arguments that name a file of the computer, the network, a device, or a commands file at once, with no job and no run folder', async () => {
    await submit(browser, 'Read my files.')
    const first = await chatRequest()
    const blackFrame = '-f lavfi -i color=c=black:size=640x360 -frames:v 1'
    sendToolCalls(first.reply, [
      videoCall('call_path', 'ffmpeg', { arguments: '-i /etc/hostname -f null -' }),
      videoCall('call_url', 'ffprobe', { arguments: 'https://example.com/clip.mp4' }),
      videoCall('call_camera', 'ffmpeg', { arguments: '-f v4l2 -i video0 camera.mp4' }),
      videoCall('call_font', 'ffmpeg', { arguments: `${blackFrame} -vf "drawtext=fontfile=/usr/share/fonts/x.ttf:text=Hi" title.png` }),
      // The commands of a file that the call writes could make curves write
      // a file anywhere.
      videoCall('call_commands', 'ffmpeg', { arguments: `${blackFrame} -vf "sendcmd=f=cmds.txt,curves" curves.png`, text_files: '{"cmds.txt":"0 curves plot p.gp;"}' }),
    ])

    const second = await chatRequest()
    const runFolderOnly = 'The program works only in its own run folder: name an input as @id or as a path of /work/, and an output as a new file name with no folder.'
    const absolutePath = (word: string) => `Dez refuses ${JSON.stringify(word)} in \`arguments\`: it holds an absolute path. ${runFolderOnly} `
      + 'For a run with no output file, end the arguments with -f null - (not with a path of the system). '
      + 'In an expression, write a division with no space before the "/", as in iw/2. Dez started no job.'
    expect(toolResult(second, 'call_path')).toBe(absolutePath('/etc/hostname'))
    expect(toolResult(second, 'call_url')).toBe(`Dez refuses "https://example.com/clip.mp4" in \`arguments\`: it holds a URL. ${runFolderOnly} Dez did not run ffprobe.`)
    expect(toolResult(second, 'call_camera')).toBe(
      'Dez refuses "v4l2" in `arguments`: it names the device v4l2. '
      + 'Dez lets the program use no camera, no microphone, no screen, and no sound output of this computer. Dez started no job.',
    )
    expect(toolResult(second, 'call_font')).toBe(absolutePath('drawtext=fontfile=/usr/share/fonts/x.ttf:text=Hi'))
    expect(toolResult(second, 'call_commands')).toBe(
      'Dez refuses "sendcmd=f=cmds.txt,curves" in `arguments`: it gives sendcmd a commands file. '
      + 'Dez does not check the text of a file, and a command can make a filter open a file outside of its run folder. '
      + 'Write the commands into the filter, as in "asendcmd=c=\'2 volume volume 0.5\',volume=1". Dez started no job.',
    )
    for (const callId of ['call_path', 'call_url', 'call_camera', 'call_font', 'call_commands']) expect(startedJobId(toolResult(second, callId))).toBeNull()

    sendToolCalls(second.reply, [openAiToolCall('call_list', 'jobs_list', {})])
    const third = await chatRequest()
    expect(toolResult(third, 'call_list')).toBe(NO_JOBS_LIST_TEXT)
    await sendChatReply(third.reply, CALLER.modelName)

    const reply = await endedReply(browser)
    expect(reply.endsWith(`</dez:tool>\n${replyText(CALLER.modelName)}`)).toBe(true)
    // A run makes its run folder first.
    expect(await filesIn(runFoldersRoot)).toStrictEqual([])
    expect(await openToasts(browser, 'error')).toStrictEqual([])
  })

  it('keeps the program of a job when the user stops the reply, and ends it and deletes its run folder when the user closes the tab', async () => {
    const before = await filesIn(audioDir)
    await submit(browser, 'Make a long tone.')
    const first = await chatRequest()
    const parameters = JSON.stringify({ arguments: ENDLESS_TONE })
    sendToolCalls(first.reply, [videoCall('call_tone', 'ffmpeg', { arguments: ENDLESS_TONE })])
    const second = await chatRequest()
    const started = toolResult(second, 'call_tone')
    expect(started).toBe(`${jobStartedText(startedJob(second, 'call_tone'), 1)}\nThe run has no input image and no input clip.`)
    const program = await runningProgram(browser, runFoldersRoot)

    // While a reply runs, the Submit button stops it. The job goes on for
    // the next reply of the tab.
    await pointerClick(browser, '.submit-button')
    await waitForValue(browser, 'chat request closed', async () => second.closed, true)
    const block = `<dez:tool id="call_tone" name="video" command="ffmpeg" parameters="${parameters.replaceAll('"', '&quot;')}">\n${started}\n</dez:tool>\n`
    await waitForThread(browser, [
      { role: 'user', text: 'Make a long tone.' },
      { role: 'agent', text: block },
      { role: 'user', text: '' },
    ])
    expect(processExists(program)).toBe(true)
    expect(await filesIn(runFoldersRoot)).toHaveLength(1)

    // No later reply can take the job of a tab that is gone.
    await pointerClick(browser, '.tab--active .tab-close')
    await waitForValue(browser, 'the program of the call runs', async () => processExists(program), false)
    await waitForValue(browser, 'run folders', () => filesIn(runFoldersRoot), [])
    expect(await filesIn(audioDir)).toStrictEqual(before)
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
    const program = await runningProgram(browser, runFoldersRoot)
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
    await waitForValue(browser, 'the program of the call runs', async () => processExists(program), false)
    await waitForValue(browser, 'run folders', () => filesIn(runFoldersRoot), [])
    expect(await filesIn(audioDir)).toStrictEqual(before)
    expect(await openToasts(browser, 'error')).toStrictEqual([])
  })

  // The argument rule refuses a protocol and a device by its name, so a
  // name that the lists do not hold would pass.
  it('refuses every protocol and every device of the ffmpeg of this build, but the lavfi device', () => {
    // Each name is a line with two spaces before it.
    const protocols = [...programOutput(setup.app, 'dez-ffmpeg', ['-hide_banner', '-protocols']).matchAll(/^ {2}(\S+)$/gm)].map((match) => match[1])
    expect(protocols).toContain('file')
    expect(protocols.filter((name) => !REFUSED_PROTOCOLS.includes(name))).toStrictEqual([])

    // ` DE video4linux2,v4l2 Video4Linux2 output device`: the names of a
    // device after its two flags.
    const devices = [...programOutput(setup.app, 'dez-ffmpeg', ['-hide_banner', '-devices']).matchAll(/^ [D ][E ] (\S+)/gm)].flatMap((match) => match[1].split(','))
    expect(devices).toContain('lavfi')
    expect(devices.filter((name) => name !== 'lavfi' && !REFUSED_DEVICES.includes(name))).toStrictEqual([])
  })
})
