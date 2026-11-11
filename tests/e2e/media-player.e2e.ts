import fs from 'node:fs'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { openAiChatBody } from './harness/chatBody'
import { click, consoleErrors, elementCenter, isOnTop, movePointer, pointerClick, pointerClickAt, pointerDrag, resetConsoleErrors, screenshotOnFailure, waitForValue, type Point } from './harness/dom'
import { conversationFilePath, makeConversation, seedConversation } from './harness/fixtures'
import { NOT_A_CLIP, WAV_SAMPLE_RATE, WEBM_VIDEO, monoWav, openPlayerTooltips, problemCards, shownPlayers, silentWav, startClipServer, waitForPlayerFullscreen, type ClipServer, type ProblemCard, type ShownPlayer } from './harness/media'
import { startMockProviderApp, type MockProviderApp } from './harness/mockProviderApp'
import { mockChatPath, replyText, sendChatReply, type MockProvider } from './harness/mockServer'
import { threadCount, webProcessPid } from './harness/processes'
import type { E2EBrowser } from './harness/session'
import { copySelection, editorCaret, editorDoc, focusEditor, focusedArea, newTab, openToasts, pasteText, pickModel, sbpCall, setCaret, submit, threadSections, waitForThread, type ThreadSection } from './harness/thread'

// The players of audio and video clips (media tags in agent sections),
// driven through the real app. The clips come from a clip server of the
// test, which stands for the CDN of a provider, from a mock of Venice's
// media API (`mediaApi: { format: 'venice' }`), and from a mock of
// OpenRouter's (`format: 'openrouter'`):
// - a tag whose source is a URL shows a player that plays from it, with the
//   clock that tells until when the URL works; Save downloads the clip into
//   the folder of the saved clips and makes that file the tag's source, and
//   the clock goes; the check becomes the trash only when the pointer comes
//   to it anew; the trash asks first, keeps the file on "No", and on "Yes"
//   deletes it and gives the tag its URL back;
// - Save moves the temp copy of a clip under its own name, the clock of a
//   temp copy also tells where the file is (with `~` for the home folder),
//   and a clip whose file is gone shows the card that says so;
// - a clip in a format that no computer decodes (text in a `.webm` file),
//   from a temp copy or from a URL, shows the card that says that this
//   computer cannot play it, under which the clock and Save stay; the card
//   stays over a Save and then names the saved file, and after the Delete
//   of a saved file that has no URL the clip is gone; a clip whose URL
//   gives no clip (a 404) is gone;
// - the clock's tooltip stays open while the pointer moves into it and
//   rests there, also in fullscreen over the picture; a drag or a triple
//   click in it selects its text and leaves the editor's caret and doc
//   alone, and the editor gets the focus back when the tooltip closes;
// - a video that fills the screen stays so over a Save; it leaves
//   fullscreen at a click on its fullscreen button, before the delete
//   prompt shows, and when a Save fails, so that the prompt and the toast
//   are not behind it; the largest video of its card has no source, so
//   that macOS puts no text recognition view over the player;
// - a player whose tab is left gives up its decoder, also when it leaves
//   during its load;
// - a speech model's reply is one request to `/audio/speech`; the audio is
//   written as a temp copy, the reply holds its tag with a new id, and a
//   later chat request gets only the id and the type of the clip, with no
//   path;
// - a speech reply that is raw samples (`audio/pcm`), from a model that
//   the config gives the `pcm` format, becomes a WAV file of the samples;
// - each player has an id badge that shows while the pointer is over the
//   player (on a video at the top right of the picture, else beside the
//   card), with a tooltip that tells how to name the clip;
// - a clip that is pasted from another conversation gets a new id when the
//   conversation has a clip with its id, and so do the pasted mentions of
//   it.
//
// One app session serves the whole file; each test starts in a new tab.

const SPEAKER: MockProvider = { id: 'speaker', name: 'Speaker Mock', modelId: 'speak-model', modelName: 'Speak Model' }
const CHAT_MODEL = { id: 'chat-model', name: 'Chat Model' }
const SPEECH_PATH = `/${SPEAKER.id}/v1/audio/speech`

// A speech model that makes only raw samples. The media API of this
// provider has an own model list, which the mock answers with no models.
const RAW_SPEAKER: MockProvider = { id: 'raw', name: 'Raw Speech Mock', modelId: 'raw-voice', modelName: 'Raw Voice' }
const RAW_SPEECH_PATH = `/${RAW_SPEAKER.id}/v1/audio/speech`
const RAW_MODEL_LIST_PATH = `/${RAW_SPEAKER.id}/v1/videos/models`

// One second of a saw wave in 16-bit little-endian samples: each byte
// differs from the bytes next to it, so a byte that moves shows.
const RAW_SAMPLES = Buffer.alloc(WAV_SAMPLE_RATE * 2)
for (let sample = 0; sample < WAV_SAMPLE_RATE; sample++) RAW_SAMPLES.writeInt16LE((sample % 50 - 25) * 100, sample * 2)

const TONE = silentWav(2)
const STORED_WAV_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.wav$/
const HOUR_MS = 60 * 60 * 1000
const DELETE_PROMPT = 'Are you sure you want to delete the saved file of this clip?'
// The prompt for a saved file with no URL to go back to.
const DELETE_ONLY_COPY_PROMPT = `${DELETE_PROMPT} The clip cannot be played again after that.`

// The cards of clips that do not play.
const GONE_CARD: ProblemCard = { cause: 'gone', lines: ['This clip is no longer available.'] }
const CANNOT_PLAY_WEBM = 'This computer cannot play the format of this clip (video/webm).'
const SAVE_HINT = 'Its file is still there. Save the clip to keep the file, then open the file with another app.'
const OPEN_HINT = 'Its file is still there. Open the file with another app.'

// A point of the tab bar: over no player.
const OFF_PLAYERS = { x: 5, y: 5 }

type ClipKind = 'audio' | 'video'

/** The text of a media tag, written out here so that the spec does not take
 *  the format from the code under test. No value needs an escape. */
function clipTag (kind: ClipKind, fields: { id: string, type: string, src?: string, url?: string, expires?: string }): string {
  const attributes = (['id', 'type', 'src', 'url', 'expires'] as const)
    .flatMap((name) => fields[name] === undefined ? [] : [` ${name}="${fields[name]}"`])
  return `<dez:${kind}${attributes.join('')}/>`
}

/** The thread of a seeded conversation whose one reply is `reply`, with
 *  `next` as the text of the user section after it. */
function seededThread (reply: string, next = ''): ThreadSection[] {
  return [
    { role: 'user', text: 'Make clips' },
    { role: 'agent', text: reply },
    { role: 'user', text: next },
  ]
}

describe('media player', () => {
  let setup: MockProviderApp
  let clips: ClipServer
  let browser: E2EBrowser

  function savedDir (kind: ClipKind): string {
    return path.join(setup.app.home, '.config', 'dez', 'assets', 'generated', kind)
  }

  function tempDir (): string {
    return path.join(setup.app.home, '.cache', 'dez', 'media')
  }

  async function filesIn (dir: string): Promise<string[]> {
    try {
      return (await fs.promises.readdir(dir)).sort()
    } catch {
      return []
    }
  }

  // The file names in `dir` that are not in `before`, once there are
  // `count` of them.
  async function newFiles (dir: string, before: string[], count: number): Promise<string[]> {
    const added = async () => (await filesIn(dir)).filter((name) => !before.includes(name))
    await waitForValue(browser, `new files in ${path.basename(dir)}`, async () => (await added()).length, count)
    return await added()
  }

  // Seeds a conversation whose one reply is `reply`, as the app saves it
  // after a reply (with the next user section, whose text is `next`), and
  // opens it.
  async function openReply (id: string, reply: string, next = ''): Promise<void> {
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
    await waitForValue(browser, 'seeded thread', () => threadSections(browser), seededThread(reply, next))
  }

  // The name of the first Save control, which tells what a click on it does.
  async function saveLabel (): Promise<string | null> {
    return browser.execute(() => document.querySelector('.cm-content .media-player__save')?.getAttribute('aria-label') ?? null)
  }

  // `time` as the page writes it: in the locale and the time zone of the
  // app.
  async function pageTime (time: string): Promise<string> {
    return browser.execute(
      (iso: string) => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso)),
      time,
    )
  }

  async function promptMessage (): Promise<string | null> {
    return browser.execute(() => document.querySelector('.confirm-dialog .confirm-message')?.textContent ?? null)
  }

  // The source of the video that WebKit on macOS would read text from when
  // the first player fills the screen: the `<video>` with the largest box in
  // the card, and the first one when two are equal (`updateMainVideoElement`
  // in WebKit's WebFullScreenManager.cpp). '' is a video with no source.
  // For a video with a source, macOS puts a native view over the page that
  // takes the clicks on the player's bar (see `MediaPlayer.vue`). That view
  // does not exist on Linux, so the spec checks what makes it.
  async function textRecognitionVideoSource (): Promise<string | null> {
    return browser.execute(() => {
      let source: string | null = null
      let largest = 0
      for (const video of document.querySelectorAll<HTMLVideoElement>('.cm-content .media-player__card video')) {
        const { width, height } = video.getBoundingClientRect()
        if (width * height <= largest) continue
        largest = width * height
        source = video.currentSrc
      }
      return source
    })
  }

  interface Badge {
    label: string | null
    opacity: string
    place: 'top right of the card' | 'right of the card' | 'other'
  }

  // The id badge of each player, in doc order.
  async function badges (): Promise<Badge[]> {
    return browser.execute(() => Array.from(document.querySelectorAll('.cm-content .media-player'), (player) => {
      const badge = player.querySelector('.media-player__id')?.getBoundingClientRect()
      const card = player.querySelector('.media-player__card')?.getBoundingClientRect()
      if (!badge || !card) throw new Error('badges: a player has no badge or no card')
      const inCard = badge.left >= card.left && badge.right <= card.right && badge.top >= card.top && badge.bottom <= card.bottom
      const badgeMiddle = badge.top + badge.height / 2
      const place: Badge['place'] = inCard && badge.left > card.left + card.width / 2 && badge.bottom < card.top + card.height / 2
        ? 'top right of the card'
        : badge.left >= card.right && badgeMiddle > card.top && badgeMiddle < card.bottom ? 'right of the card' : 'other'
      return {
        label: player.querySelector('.media-player__id')?.getAttribute('aria-label') ?? null,
        opacity: getComputedStyle(player.querySelector('.media-player__id') as Element).opacity,
        place,
      }
    }))
  }

  interface ClockTooltipLayout {
    clock: Point
    /** The box of the clock, and of its tooltip, in viewport px. */
    clockBox: DOMRectReadOnly
    tooltip: DOMRectReadOnly
    /** The side of the clock that the tooltip is on (video.js's
     *  `data-side`). */
    side: string | null
    /** A point in the first character of each line of the tooltip. */
    lines: Point[]
    /** The points where a drag selects the path alone: at the left edge of
     *  its first character and at the right edge of its last one. Null when
     *  the tooltip names no file. */
    path: { from: Point, to: Point } | null
  }

  // Where the first clock and its tooltip are.
  async function clockTooltipLayout (): Promise<ClockTooltipLayout> {
    return browser.execute(() => {
      const tooltip = document.querySelector('.cm-content .media-player__clock + media-tooltip') as HTMLElement
      const clockBox = (tooltip.previousElementSibling as Element).getBoundingClientRect()
      const charBox = (text: Text, index: number): DOMRect => {
        const range = document.createRange()
        range.setStart(text, index)
        range.setEnd(text, index + 1)
        return range.getBoundingClientRect()
      }
      const lines = Array.from(tooltip.children, (line) => {
        const box = charBox(line.firstChild as Text, 0)
        return { x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2 }
      })
      const pathText = tooltip.querySelector('.media-player__tooltip-path')?.firstChild as Text | undefined
      let path = null
      if (pathText) {
        const first = charBox(pathText, pathText.data.indexOf('~'))
        const last = charBox(pathText, pathText.data.length - 1)
        path = {
          from: { x: first.left + 1, y: (first.top + first.bottom) / 2 },
          to: { x: last.right - 1, y: (last.top + last.bottom) / 2 },
        }
      }
      return {
        clock: { x: (clockBox.left + clockBox.right) / 2, y: (clockBox.top + clockBox.bottom) / 2 },
        clockBox: clockBox.toJSON() as DOMRectReadOnly,
        tooltip: tooltip.getBoundingClientRect().toJSON() as DOMRectReadOnly,
        side: tooltip.getAttribute('data-side'),
        lines,
        path,
      }
    })
  }

  // Moves the pointer from the clock's center straight into its tooltip,
  // then on to `to`, in steps of 3 px, as a slow hand does. In the gap
  // between the clock and the tooltip it stops for longer than the close
  // delay, so only the bridge can keep the tooltip open there. Gives
  // whether the tooltip was open after each step and after the stop.
  async function walkIntoClockTooltip (to: Point): Promise<boolean[]> {
    const { clock, clockBox, tooltip, side } = await clockTooltipLayout()
    const below = side === 'bottom'
    const gap = { x: clock.x, y: below ? (clockBox.bottom + tooltip.top) / 2 : (clockBox.top + tooltip.bottom) / 2 }
    const inside = { x: clock.x, y: below ? tooltip.top + 4 : tooltip.bottom - 4 }
    const tooltipOpen = async () => (await openPlayerTooltips(browser)).length === 1
    const open: boolean[] = []
    let at = clock
    for (const stop of [gap, inside, to]) {
      const steps = Math.max(1, Math.ceil(Math.hypot(stop.x - at.x, stop.y - at.y) / 3))
      for (let step = 1; step <= steps; step++) {
        await movePointer(browser, { x: at.x + (stop.x - at.x) * step / steps, y: at.y + (stop.y - at.y) * step / steps })
        open.push(await tooltipOpen())
      }
      if (stop === gap) {
        await browser.pause(400)
        open.push(await tooltipOpen())
      }
      at = stop
    }
    return open
  }

  async function selectedText (): Promise<string> {
    return browser.execute(() => window.getSelection()?.toString() ?? '')
  }

  beforeAll(async () => {
    clips = await startClipServer({
      'tone.wav': { type: 'audio/wav', bytes: TONE },
      'video.webm': { type: 'video/webm', bytes: WEBM_VIDEO },
      'text.webm': { type: 'video/webm', bytes: NOT_A_CLIP },
    })
    setup = await startMockProviderApp(SPEAKER, {
      mediaApi: { format: 'venice' },
      models: [
        { id: SPEAKER.modelId, name: SPEAKER.modelName, outputs: ['audio'], request: 'tts' },
        { id: CHAT_MODEL.id, name: CHAT_MODEL.name },
      ],
    }, {
      moreProviders: [{
        provider: RAW_SPEAKER,
        config: {
          mediaApi: {
            format: 'openrouter',
            modelRequestBodies: [{ request: 'tts', modelIdPrefix: 'raw-', body: { response_format: 'pcm' } }],
          },
          models: [{ id: RAW_SPEAKER.modelId, name: RAW_SPEAKER.modelName, outputs: ['audio'], request: 'tts' }],
        },
      }],
      heldPaths: [SPEECH_PATH, RAW_SPEECH_PATH],
      jsonAnswers: { [RAW_MODEL_LIST_PATH]: { data: [] } },
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
    await clips?.stop()
  })

  it('plays a clip from its URL, saves it as a file, and deletes the file after a prompt', async () => {
    const before = await filesIn(savedDir('audio'))
    const url = clips.clipUrl('tone.wav')
    const expires = new Date(Date.now() + HOUR_MS).toISOString()
    const remoteTag = clipTag('audio', { id: 'a', type: 'audio/wav', src: url, url, expires })
    await openReply('remote-clip', remoteTag)
    const remote: ShownPlayer = { kind: 'audio', id: 'a', available: true, source: url, seconds: 2, picture: null, clock: 'Not saved', save: 'save' }
    await waitForValue(browser, 'player of the URL', () => shownPlayers(browser), [remote])

    // The clock tells until when the URL works. A clip that plays from a
    // URL has no file to name.
    await movePointer(browser, await elementCenter(browser, '.media-player__clock'))
    await waitForValue(browser, 'clock tooltip', () => openPlayerTooltips(browser), [
      `Not saved This clip is available until ${await pageTime(expires)}. Save it to keep it.`,
    ])

    // Save downloads the clip, and its file becomes the source of the tag.
    // The URL and its time stay, for the Delete. The player loads the file
    // only after the download, so the folder then holds the whole file
    // under its last name.
    await pointerClick(browser, '.media-player__save')
    await waitForValue(browser, 'source after Save', async () => (await shownPlayers(browser))[0]?.source, 'blob')
    const [name] = await newFiles(savedDir('audio'), before, 1)
    expect(name).toMatch(STORED_WAV_NAME)
    const savedPath = path.join(savedDir('audio'), name)
    const savedTag = clipTag('audio', { id: 'a', type: 'audio/wav', src: savedPath, url, expires })
    await waitForValue(browser, 'thread after Save', () => threadSections(browser), seededThread(savedTag))
    expect(await fs.promises.readFile(savedPath)).toStrictEqual(TONE)
    const file = conversationFilePath(setup.app.home, 'remote-clip')
    await waitForValue(browser, 'saved tag in the file', async () => (await fs.promises.readFile(file, 'utf8').catch(() => '')).includes(savedTag), true)

    // The saved file plays, and the clock is gone. The pointer is still on
    // the control, which shows the check and not the trash.
    const saved: ShownPlayer = { ...remote, source: 'blob', clock: null, save: 'saved' }
    await waitForValue(browser, 'player of the saved file', () => shownPlayers(browser), [saved])
    expect(await saveLabel()).toBe('Saved')

    // The trash shows when the pointer comes to the check anew.
    await movePointer(browser, OFF_PLAYERS)
    await movePointer(browser, await elementCenter(browser, '.media-player__save'))
    await waitForValue(browser, 'trash', saveLabel, 'Delete the saved file')

    // "No" keeps the file and the tag.
    await pointerClick(browser, '.media-player__save')
    await waitForValue(browser, 'prompt', promptMessage, DELETE_PROMPT)
    await pointerClick(browser, '.confirm-btn--cancel')
    await waitForValue(browser, 'prompt after No', promptMessage, null)
    expect(await filesIn(savedDir('audio'))).toStrictEqual([...before, name].sort())
    expect(await threadSections(browser)).toStrictEqual(seededThread(savedTag))
    expect(await shownPlayers(browser)).toStrictEqual([saved])

    // "Yes" deletes the file, and the clip plays from its URL again.
    await pointerClick(browser, '.media-player__save')
    await waitForValue(browser, 'second prompt', promptMessage, DELETE_PROMPT)
    await pointerClick(browser, '.confirm-btn--confirm')
    await waitForValue(browser, 'thread after the delete', () => threadSections(browser), seededThread(remoteTag))
    await waitForValue(browser, 'player after the delete', () => shownPlayers(browser), [remote])
    expect(await filesIn(savedDir('audio'))).toStrictEqual(before)
    await waitForValue(browser, 'prompt after Yes', promptMessage, null)
    await waitForValue(browser, 'tag with the URL in the file', async () => (await fs.promises.readFile(file, 'utf8').catch(() => '')).includes(remoteTag), true)
    expect(await consoleErrors(browser)).toStrictEqual([])
  })

  it('tells where the temp copy of a clip is, moves it on Save, and tells that a clip with no file is not available', async () => {
    const savedBefore = await filesIn(savedDir('audio'))
    const tempBefore = await filesIn(tempDir())
    await fs.promises.mkdir(tempDir(), { recursive: true })
    const tempPath = path.join(tempDir(), 'kept-copy.wav')
    // The file is new, so the cleanup of old temp copies leaves it.
    await fs.promises.writeFile(tempPath, TONE)
    const expires = new Date(Date.now() + HOUR_MS).toISOString()
    const tempTag = clipTag('audio', { id: 'a', type: 'audio/wav', src: tempPath, expires })
    const goneTag = clipTag('audio', { id: 'b', type: 'audio/wav', src: path.join(tempDir(), 'gone-copy.wav'), expires })
    await openReply('temp-clip', `${tempTag}\n\n${goneTag}`)

    // A local file plays from a blob URL of its bytes.
    const temp: ShownPlayer = { kind: 'audio', id: 'a', available: true, source: 'blob', seconds: 2, picture: null, clock: 'Not saved', save: 'save' }
    const gone: ShownPlayer = { kind: 'audio', id: 'b', available: false, source: null, seconds: null, picture: null, clock: null, save: null }
    await waitForValue(browser, 'players', () => shownPlayers(browser), [temp, gone])
    expect(await problemCards(browser)).toStrictEqual([GONE_CARD])

    // The clock of a temp copy also tells where the file is. The home
    // folder of the app is the temp folder of this run, and `~` stands for
    // it.
    await focusEditor(browser)
    await setCaret(browser, 3)
    const doc = await editorDoc(browser)
    await movePointer(browser, await elementCenter(browser, '.media-player__clock'))
    await waitForValue(browser, 'clock tooltip of the temp copy', () => openPlayerTooltips(browser), [
      `Not saved This clip is available until ${await pageTime(expires)}. Save it to keep it. Temporary file: ~/.cache/dez/media/kept-copy.wav`,
    ])

    // The pointer can go from the clock into the tooltip, over the gap
    // between them, and the tooltip stays open on the whole way. In it, a
    // drag selects the path alone, and a triple click selects its line, not
    // the editor lines after the player.
    const layout = await clockTooltipLayout()
    const pathLine = layout.lines[2]
    expect(await walkIntoClockTooltip(pathLine)).not.toContain(false)
    const { from, to } = layout.path!
    await pointerDrag(browser, from, to.x, { toY: to.y })
    await waitForValue(browser, 'selection after a drag over the path', selectedText, '~/.cache/dez/media/kept-copy.wav')
    await pointerClickAt(browser, pathLine, 3)
    await waitForValue(browser, 'selection after a triple click', selectedText, 'Temporary file: ~/.cache/dez/media/kept-copy.wav')
    expect(await openPlayerTooltips(browser)).toHaveLength(1)

    // The presses put the focus on the card (a focused editor would draw its
    // own selection over the one in the tooltip), and they leave the
    // editor's caret and doc as they were. When the pointer leaves, the
    // tooltip closes, and the editor gets the focus back.
    expect(await focusedArea(browser)).toBe('media-container')
    await movePointer(browser, OFF_PLAYERS)
    await waitForValue(browser, 'tooltips with the pointer off the clock', () => openPlayerTooltips(browser), [])
    await waitForValue(browser, 'focus after the tooltip closed', () => focusedArea(browser), 'editor')
    expect(await editorCaret(browser)).toBe(3)
    expect(await editorDoc(browser)).toBe(doc)

    // Save moves the copy under its name. The time of the temp copy means
    // nothing for the saved file, so the tag loses its `expires`.
    await pointerClick(browser, '.media-player__save')
    const savedPath = path.join(savedDir('audio'), 'kept-copy.wav')
    const savedTag = clipTag('audio', { id: 'a', type: 'audio/wav', src: savedPath })
    await waitForValue(browser, 'thread after Save', () => threadSections(browser), seededThread(`${savedTag}\n\n${goneTag}`))
    expect(await filesIn(savedDir('audio'))).toStrictEqual([...savedBefore, 'kept-copy.wav'].sort())
    expect(await fs.promises.readFile(savedPath)).toStrictEqual(TONE)
    expect(await filesIn(tempDir())).toStrictEqual(tempBefore)
    await waitForValue(browser, 'players after Save', () => shownPlayers(browser), [{ ...temp, clock: null, save: 'saved' }, gone])

    // Only the clip with no file gave an error, with no path in it.
    expect(await consoleErrors(browser)).toStrictEqual(['[MediaPlayer] The file of the clip could not be read'])
  })

  // The error code of the clip's media element depends on the media stack
  // of the host, so the tests below take each code that the HTML standard
  // allows for the case.
  it('tells that this computer cannot play the format of a temp copy, keeps that over a Save, and names the saved file', async () => {
    const savedBefore = await filesIn(savedDir('video'))
    const tempBefore = await filesIn(tempDir())
    await fs.promises.mkdir(tempDir(), { recursive: true })
    const tempPath = path.join(tempDir(), 'text-copy.webm')
    await fs.promises.writeFile(tempPath, NOT_A_CLIP)
    const expires = new Date(Date.now() + HOUR_MS).toISOString()
    await openReply('text-copy', clipTag('video', { id: 'a', type: 'video/webm', src: tempPath, expires }))

    // The file was read, so its bytes are there: the card names the format
    // of the clip, and the bar keeps the clock and the Save.
    const cannotPlay: ShownPlayer = { kind: 'video', id: 'a', available: false, source: null, seconds: null, picture: null, clock: 'Not saved', save: 'save' }
    await waitForValue(browser, 'player of the text', () => shownPlayers(browser), [cannotPlay])
    expect(await problemCards(browser)).toStrictEqual([{ cause: 'cannot-play', lines: [CANNOT_PLAY_WEBM, SAVE_HINT] }])
    await movePointer(browser, await elementCenter(browser, '.media-player__clock'))
    await waitForValue(browser, 'clock tooltip', () => openPlayerTooltips(browser), [
      `Not saved This clip is available until ${await pageTime(expires)}. Save it to keep it. Temporary file: ~/.cache/dez/media/text-copy.webm`,
    ])
    await movePointer(browser, OFF_PLAYERS)
    await waitForValue(browser, 'tooltips with the pointer off the clock', () => openPlayerTooltips(browser), [])

    // Save moves the file. Its bytes are the same, so the card stays, and
    // it names the saved file in place of the clock.
    await pointerClick(browser, '.media-player__save')
    const savedPath = path.join(savedDir('video'), 'text-copy.webm')
    await waitForValue(browser, 'thread after Save', () => threadSections(browser), seededThread(clipTag('video', { id: 'a', type: 'video/webm', src: savedPath })))
    expect(await filesIn(savedDir('video'))).toStrictEqual([...savedBefore, 'text-copy.webm'].sort())
    expect(await fs.promises.readFile(savedPath)).toStrictEqual(NOT_A_CLIP)
    expect(await filesIn(tempDir())).toStrictEqual(tempBefore)
    await waitForValue(browser, 'player after Save', () => shownPlayers(browser), [{ ...cannotPlay, clock: null, save: 'saved' }])
    await waitForValue(browser, 'card after Save', () => problemCards(browser), [{
      cause: 'cannot-play',
      lines: [CANNOT_PLAY_WEBM, OPEN_HINT, 'Saved file: ~/.config/dez/assets/generated/video/text-copy.webm'],
    }])

    // The trash shows when the pointer comes to the check anew, and it
    // deletes the saved file. The tag has no URL to go back to, so the clip
    // is then gone.
    await movePointer(browser, OFF_PLAYERS)
    await movePointer(browser, await elementCenter(browser, '.media-player__save'))
    await waitForValue(browser, 'trash', saveLabel, 'Delete the saved file')
    await pointerClick(browser, '.media-player__save')
    await waitForValue(browser, 'prompt', promptMessage, DELETE_ONLY_COPY_PROMPT)
    await pointerClick(browser, '.confirm-btn--confirm')
    await waitForValue(browser, 'thread after the delete', () => threadSections(browser), seededThread(clipTag('video', { id: 'a', type: 'video/webm' })))
    expect(await filesIn(savedDir('video'))).toStrictEqual(savedBefore)
    await waitForValue(browser, 'prompt after Yes', promptMessage, null)
    await waitForValue(browser, 'player after the delete', () => shownPlayers(browser), [{ ...cannotPlay, clock: null, save: null }])
    expect(await problemCards(browser)).toStrictEqual([GONE_CARD])

    // One error: the media element's, at the first load. The Save tried
    // the bytes no second time.
    expect(await consoleErrors(browser)).toStrictEqual([expect.stringMatching(/^\[MediaPlayer\] The clip did not load; media error code: [34]$/)])
  })

  it('tells that this computer cannot play the format of a clip whose URL answers', async () => {
    const url = clips.clipUrl('text.webm')
    const expires = new Date(Date.now() + HOUR_MS).toISOString()
    await openReply('text-url', clipTag('video', { id: 'a', type: 'video/webm', src: url, url, expires }))

    await waitForValue(browser, 'player of the text', () => shownPlayers(browser), [
      { kind: 'video', id: 'a', available: false, source: null, seconds: null, picture: null, clock: 'Not saved', save: 'save' },
    ])
    expect(await problemCards(browser)).toStrictEqual([{ cause: 'cannot-play', lines: [CANNOT_PLAY_WEBM, SAVE_HINT] }])
    expect(await consoleErrors(browser)).toStrictEqual([expect.stringMatching(/^\[MediaPlayer\] The clip did not load; media error code: [34]$/)])
  })

  it('tells that a clip whose URL gives no clip is no longer available', async () => {
    const url = clips.clipUrl('missing.webm')
    const expires = new Date(Date.now() + HOUR_MS).toISOString()
    await openReply('missing-url', clipTag('video', { id: 'a', type: 'video/webm', src: url, url, expires }))

    await waitForValue(browser, 'player of the missing clip', () => shownPlayers(browser), [
      { kind: 'video', id: 'a', available: false, source: null, seconds: null, picture: null, clock: null, save: null },
    ])
    expect(await problemCards(browser)).toStrictEqual([GONE_CARD])
    // The 404 of the question to the URL is no error of its own.
    expect(await consoleErrors(browser)).toStrictEqual([expect.stringMatching(/^\[MediaPlayer\] The clip did not load; media error code: [24]$/)])
  })

  it('keeps a video in fullscreen over a Save, lets the clock tooltip over its picture be selected, and leaves fullscreen for the delete prompt and at a click on its button', async () => {
    const before = await filesIn(savedDir('video'))
    const url = clips.clipUrl('video.webm')
    const expires = new Date(Date.now() + HOUR_MS).toISOString()
    await openReply('fullscreen-clip', clipTag('video', { id: 'a', type: 'video/webm', src: url, url, expires }))
    await waitForValue(browser, 'length of the clip', async () => (await shownPlayers(browser))[0]?.seconds, 2)
    expect(await textRecognitionVideoSource()).toBe('')
    await pointerClick(browser, '.media-player__fullscreen')
    await waitForPlayerFullscreen(browser, true)
    expect(await textRecognitionVideoSource()).toBe('')

    // The clock's tooltip takes the pointer in fullscreen too. There it is
    // over the picture, and a triple click in it selects its line and does
    // not play the clip.
    await movePointer(browser, await elementCenter(browser, '.media-player__clock'))
    await waitForValue(browser, 'clock tooltip in fullscreen', async () => (await openPlayerTooltips(browser)).length, 1)
    const { lines } = await clockTooltipLayout()
    expect(await walkIntoClockTooltip(lines[1])).not.toContain(false)
    await pointerClickAt(browser, lines[1], 3)
    await waitForValue(browser, 'selection in fullscreen', selectedText, `This clip is available until ${await pageTime(expires)}. Save it to keep it.`)
    expect(await browser.execute(() => document.querySelector<HTMLVideoElement>('.cm-content .media-player__video')?.paused)).toBe(true)
    await waitForPlayerFullscreen(browser, true)

    // Save rewrites the tag of the player. The player stays in the document
    // over that, so it still fills the screen.
    await pointerClick(browser, '.media-player__save')
    await waitForValue(browser, 'Save control', async () => (await shownPlayers(browser))[0]?.save, 'saved')
    expect(await newFiles(savedDir('video'), before, 1)).toHaveLength(1)
    await waitForPlayerFullscreen(browser, true)

    // The trash asks first. The prompt is not a part of the player, so the
    // player leaves fullscreen, and the prompt shows over the page.
    await movePointer(browser, await elementCenter(browser, '.media-player__play'))
    await movePointer(browser, await elementCenter(browser, '.media-player__save'))
    await waitForValue(browser, 'trash', saveLabel, 'Delete the saved file')
    await pointerClick(browser, '.media-player__save')
    await waitForValue(browser, 'prompt', promptMessage, DELETE_PROMPT)
    await waitForPlayerFullscreen(browser, false)
    expect(await isOnTop(browser, '.confirm-dialog')).toBe(true)
    await pointerClick(browser, '.confirm-btn--cancel')
    await waitForValue(browser, 'prompt after No', promptMessage, null)
    expect(await focusedArea(browser)).toBe('editor')

    // A click on the fullscreen button of a player that fills the screen
    // ends the fullscreen, and the editor gets the focus back.
    await pointerClick(browser, '.media-player__fullscreen')
    await waitForPlayerFullscreen(browser, true)
    expect(await focusedArea(browser)).toBe('media-container')
    await pointerClick(browser, '.media-player__fullscreen')
    await waitForPlayerFullscreen(browser, false)
    await waitForValue(browser, 'focus after fullscreen', () => focusedArea(browser), 'editor')
    expect(await consoleErrors(browser)).toStrictEqual([])
  })

  it('leaves fullscreen when a Save fails, so that its toast shows', async () => {
    await fs.promises.mkdir(tempDir(), { recursive: true })
    const tempPath = path.join(tempDir(), 'lost-copy.webm')
    await fs.promises.writeFile(tempPath, WEBM_VIDEO)
    const expires = new Date(Date.now() + HOUR_MS).toISOString()
    await openReply('lost-clip', clipTag('video', { id: 'a', type: 'video/webm', src: tempPath, expires }))
    await waitForValue(browser, 'length of the clip', async () => (await shownPlayers(browser))[0]?.seconds, 2)
    await pointerClick(browser, '.media-player__fullscreen')
    await waitForPlayerFullscreen(browser, true)

    // The player has the bytes of the file, so it still plays when the file
    // is gone. Save moves the file, which now fails.
    await fs.promises.rm(tempPath)
    await pointerClick(browser, '.media-player__save')
    await waitForValue(browser, 'error toast', async () => (await openToasts(browser, 'error')).map((toast) => toast.title), ['Could not save the clip'])
    await waitForPlayerFullscreen(browser, false)
    expect(await isOnTop(browser, '.toast-card--error')).toBe(true)
    expect((await shownPlayers(browser))[0]?.save).toBe('save')

    await click(browser, '.toast-card--error .toast-close')
    await waitForValue(browser, 'error toast closed', () => openToasts(browser, 'error'), [])
  })

  it('gives up the decoder of a clip whose tab is left', async () => {
    await fs.promises.mkdir(tempDir(), { recursive: true })
    const tempPath = path.join(tempDir(), 'left-copy.wav')
    await fs.promises.writeFile(tempPath, TONE)
    const expires = new Date(Date.now() + HOUR_MS).toISOString()
    await openReply('left-clip', clipTag('audio', { id: 'a', type: 'audio/wav', src: tempPath, expires }))
    const otherTabId = (await sbpCall(browser, 'dez.model/tabs/create') as { id: string }).id

    // Shows the player again, waits for `shown`, and leaves its tab.
    const showAndLeave = async (label: string, shown: (player: ShownPlayer | undefined) => boolean): Promise<void> => {
      await sbpCall(browser, 'dez.model/tabs/openConversation', 'left-clip')
      await waitForValue(browser, label, async () => shown((await shownPlayers(browser))[0]), true)
      await sbpCall(browser, 'dez.model/tabs/switch', otherTabId)
    }
    const withMetadata = (): Promise<void> => showAndLeave('player with its metadata', (player) => player?.seconds === 2)
    const withSource = (): Promise<void> => showAndLeave('player with its source', (player) => player?.source === 'blob')

    // The decoder of a media element is a GStreamer pipeline, which has
    // about 4 threads. A player that keeps it after it left shows as
    // threads of the page's process that never end; before the release,
    // each player that left kept them, and no clip loaded after about 120
    // players. The first players start threads that stay (thread pools),
    // so the count starts after them.
    const ROUNDS = 10
    const pid = webProcessPid(setup.app.home)
    for (let round = 0; round < 2; round++) await withMetadata()
    const before = threadCount(pid)
    // The threads of a pipeline end a moment after its release.
    const kept = async (): Promise<string> => {
      const more = threadCount(pid) - before
      return more < ROUNDS ? 'none' : `${more} threads more after ${ROUNDS} players`
    }

    for (let round = 0; round < ROUNDS; round++) await withMetadata()
    await waitForValue(browser, 'decoders of players that left with their metadata', kept, 'none')

    // A player that leaves during its load gives up its decoder when the
    // load is past its start.
    for (let round = 0; round < ROUNDS; round++) await withSource()
    await waitForValue(browser, 'decoders of players that left during their load', kept, 'none')

    expect(await consoleErrors(browser)).toStrictEqual([])
    await fs.promises.rm(tempPath)
  })

  it('writes the audio of a speech reply as a tag, and sends a later request only its id and type', async () => {
    const tempBefore = await filesIn(tempDir())
    await pickModel(browser, SPEAKER.name, SPEAKER.modelName)
    const sent = Date.now()
    await submit(browser, 'Say hello')

    const speech = await setup.mock.waitForRequest(browser)
    expect(speech.path).toBe(SPEECH_PATH)
    expect(JSON.parse(speech.body)).toStrictEqual({ model: SPEAKER.modelId, input: 'Say hello' })
    speech.reply.writeHead(200, { 'Content-Type': 'audio/wav' })
    speech.reply.end(TONE)

    // The reply ends after the download, which goes into a `.part` file
    // first. The audio is a temp copy, which stays for 24 hours after the
    // request.
    await waitForValue(browser, 'sections of the reply', async () => (await threadSections(browser)).map((section) => section.role), ['user', 'agent', 'user'])
    const [name] = await newFiles(tempDir(), tempBefore, 1)
    expect(name).toMatch(STORED_WAV_NAME)
    const tempPath = path.join(tempDir(), name)
    const reply = (await threadSections(browser))[1].text
    const expires = /^<dez:audio id="a" type="audio\/wav" src="[^"]+" expires="([^"]+)"\/>$/.exec(reply)?.[1] ?? ''
    expect(reply).toBe(clipTag('audio', { id: 'a', type: 'audio/wav', src: tempPath, expires }))
    expect(new Date(expires).toISOString()).toBe(expires)
    expect(Date.parse(expires)).toBeGreaterThanOrEqual(sent + 24 * HOUR_MS)
    expect(Date.parse(expires)).toBeLessThanOrEqual(Date.now() + 24 * HOUR_MS)
    await waitForThread(browser, [
      { role: 'user', text: 'Say hello' },
      { role: 'agent', text: reply },
      { role: 'user', text: '' },
    ])
    expect(await fs.promises.readFile(tempPath)).toStrictEqual(TONE)
    await waitForValue(browser, 'player of the reply', () => shownPlayers(browser), [
      { kind: 'audio', id: 'a', available: true, source: 'blob', seconds: 2, picture: null, clock: 'Not saved', save: 'save' },
    ])

    // A chat model gets the clip as its id and type: no path, and no time
    // that would change the bytes of the message later.
    await pickModel(browser, SPEAKER.name, CHAT_MODEL.name)
    await submit(browser, 'Thanks')
    const chat = await setup.mock.waitForRequest(browser)
    expect(chat.path).toBe(mockChatPath(SPEAKER))
    expect(JSON.parse(chat.body)).toStrictEqual(openAiChatBody({ ...SPEAKER, modelId: CHAT_MODEL.id }, [
      { role: 'user', content: 'Say hello' },
      { role: 'assistant', content: '<dez:audio id="a" type="audio/wav"/>' },
      { role: 'user', content: 'Thanks' },
    ]))
    expect(chat.body).not.toContain(setup.app.home)
    await sendChatReply(chat.reply, 'thanks')
    await waitForThread(browser, [
      { role: 'user', text: 'Say hello' },
      { role: 'agent', text: reply },
      { role: 'user', text: 'Thanks' },
      { role: 'agent', text: replyText('thanks') },
      { role: 'user', text: '' },
    ])
    expect(await consoleErrors(browser)).toStrictEqual([])
  })

  it('makes a WAV file of a speech reply that is raw samples', async () => {
    const tempBefore = await filesIn(tempDir())
    await pickModel(browser, RAW_SPEAKER.name, RAW_SPEAKER.modelName)
    await submit(browser, 'Say hello')

    // The config's body part for the model replaces the `mp3` of the format.
    const speech = await setup.mock.waitForRequest(browser)
    expect(speech.path).toBe(RAW_SPEECH_PATH)
    expect(JSON.parse(speech.body)).toStrictEqual({ model: RAW_SPEAKER.modelId, input: 'Say hello', response_format: 'pcm' })
    speech.reply.writeHead(200, { 'Content-Type': `audio/pcm;rate=${WAV_SAMPLE_RATE};channels=1` })
    speech.reply.end(RAW_SAMPLES)

    // The samples go into a `.part` file, which is gone when the reply
    // ends: the one new file is the WAV file.
    await waitForValue(browser, 'sections of the reply', async () => (await threadSections(browser)).map((section) => section.role), ['user', 'agent', 'user'])
    const [name] = await newFiles(tempDir(), tempBefore, 1)
    expect(name).toMatch(STORED_WAV_NAME)
    const tempPath = path.join(tempDir(), name)
    const reply = (await threadSections(browser))[1].text
    const expires = /^<dez:audio id="a" type="audio\/wav" src="[^"]+" expires="([^"]+)"\/>$/.exec(reply)?.[1] ?? ''
    expect(reply).toBe(clipTag('audio', { id: 'a', type: 'audio/wav', src: tempPath, expires }))
    expect(await fs.promises.readFile(tempPath)).toStrictEqual(monoWav(RAW_SAMPLES, 2))
    await waitForValue(browser, 'player of the reply', () => shownPlayers(browser), [
      { kind: 'audio', id: 'a', available: true, source: 'blob', seconds: 1, picture: null, clock: 'Not saved', save: 'save' },
    ])
    expect(await consoleErrors(browser)).toStrictEqual([])
  })

  it('shows the id of a clip in a badge while the pointer is over its player', async () => {
    const videoUrl = clips.clipUrl('video.webm')
    const audioUrl = clips.clipUrl('tone.wav')
    const expires = new Date(Date.now() + HOUR_MS).toISOString()
    await openReply('clip-ids', [
      clipTag('video', { id: 'a', type: 'video/webm', src: videoUrl, url: videoUrl, expires }),
      clipTag('audio', { id: 'b', type: 'audio/wav', src: audioUrl, url: audioUrl, expires }),
    ].join('\n\n'))
    await waitForValue(browser, 'players', () => shownPlayers(browser), [
      { kind: 'video', id: 'a', available: true, source: videoUrl, seconds: 2, picture: { width: 48, height: 36 }, clock: 'Not saved', save: 'save' },
      { kind: 'audio', id: 'b', available: true, source: audioUrl, seconds: 2, picture: null, clock: 'Not saved', save: 'save' },
    ])

    // Only the badge of the player under the pointer shows. On a video it
    // is over the picture; an audio card has no room, so it is beside it.
    const videoBadge: Badge = { label: 'Video id: a', opacity: '0', place: 'top right of the card' }
    const audioBadge: Badge = { label: 'Audio id: b', opacity: '0', place: 'right of the card' }
    await movePointer(browser, OFF_PLAYERS)
    await waitForValue(browser, 'badges at rest', badges, [videoBadge, audioBadge])
    await movePointer(browser, await elementCenter(browser, '.media-player[data-kind="video"] .media-player__card'))
    await waitForValue(browser, 'badges with the pointer on the video', badges, [{ ...videoBadge, opacity: '1' }, audioBadge])
    await movePointer(browser, await elementCenter(browser, '.media-player[data-kind="video"] .media-player__id'))
    await waitForValue(browser, 'tooltip of the video badge', () => openPlayerTooltips(browser), [
      'Video id: a Refer to this clip in a message as video @a.',
    ])

    await movePointer(browser, await elementCenter(browser, '.media-player[data-kind="audio"] .media-player__card'))
    await waitForValue(browser, 'badges with the pointer on the audio card', badges, [videoBadge, { ...audioBadge, opacity: '1' }])
    // The badge is outside the card, and the player still counts as hovered
    // there.
    await movePointer(browser, await elementCenter(browser, '.media-player[data-kind="audio"] .media-player__id'))
    await waitForValue(browser, 'tooltip of the audio badge', () => openPlayerTooltips(browser), [
      'Audio id: b Refer to this clip in a message as audio @b.',
    ])
    expect(await badges()).toStrictEqual([videoBadge, { ...audioBadge, opacity: '1' }])

    await movePointer(browser, OFF_PLAYERS)
    await waitForValue(browser, 'tooltips with the pointer off the players', () => openPlayerTooltips(browser), [])
    await waitForValue(browser, 'badges with the pointer off the players', badges, [videoBadge, audioBadge])
    expect(await consoleErrors(browser)).toStrictEqual([])
  })

  it('gives a clip that is pasted from another conversation a new id, and the pasted mentions of it too, when the conversation has a clip with its id', async () => {
    const audioUrl = clips.clipUrl('tone.wav')
    const videoUrl = clips.clipUrl('video.webm')
    const expires = new Date(Date.now() + HOUR_MS).toISOString()
    const audio = { type: 'audio/wav', src: audioUrl, url: audioUrl, expires }

    // The conversation that is copied whole: its clip is `a` there, and
    // its last message names the clip.
    await openReply('copied-clip', clipTag('audio', { id: 'a', ...audio }), 'Use audio @a, not @a-side')
    await setCaret(browser, 0, (await editorDoc(browser)).length)
    const copied = await copySelection(browser)

    // The conversation that gets the paste has a clip `a` of its own.
    const videoTag = clipTag('video', { id: 'a', type: 'video/webm', src: videoUrl, url: videoUrl, expires })
    await openReply('own-clip', videoTag)
    await setCaret(browser, (await editorDoc(browser)).length)
    await pasteText(browser, copied)

    // The paste starts in the empty last section. The pasted clip is `b`
    // here, and so is its mention; `@a-side` is no mention.
    await waitForValue(browser, 'thread after the paste', () => threadSections(browser), [
      { role: 'user', text: 'Make clips' },
      { role: 'agent', text: videoTag },
      { role: 'user', text: 'Make clips' },
      { role: 'agent', text: clipTag('audio', { id: 'b', ...audio }) },
      { role: 'user', text: 'Use audio @b, not @a-side' },
    ])
    await waitForValue(browser, 'players after the paste', () => shownPlayers(browser), [
      { kind: 'video', id: 'a', available: true, source: videoUrl, seconds: 2, picture: { width: 48, height: 36 }, clock: 'Not saved', save: 'save' },
      { kind: 'audio', id: 'b', available: true, source: audioUrl, seconds: 2, picture: null, clock: 'Not saved', save: 'save' },
    ])
    expect(await consoleErrors(browser)).toStrictEqual([])
  })
})
