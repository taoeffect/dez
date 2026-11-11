import fs from 'node:fs'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { openAiChatBody } from './harness/chatBody'
import { consoleErrors, elementCenter, movePointer, pointerClick, resetConsoleErrors, screenshotOnFailure, waitForValue } from './harness/dom'
import { conversationFilePath, makeConversation, seedConversation } from './harness/fixtures'
import { WEBM_VIDEO, openPlayerTooltips, shownPlayers, silentWav, startClipServer, type ClipServer, type ShownPlayer } from './harness/media'
import { startMockProviderApp, type MockProviderApp } from './harness/mockProviderApp'
import { mockChatPath, replyText, sendChatReply, type MockProvider } from './harness/mockServer'
import type { E2EBrowser } from './harness/session'
import { copySelection, editorDoc, newTab, pasteText, pickModel, sbpCall, setCaret, submit, threadSections, waitForThread, type ThreadSection } from './harness/thread'

// The players of audio and video clips (media tags in agent sections),
// driven through the real app. The clips come from a clip server of the
// test, which stands for the CDN of a provider, and from a mock of Venice's
// media API (`mediaApi: { format: 'venice' }`):
// - a tag whose source is a URL shows a player that plays from it, with the
//   clock that tells until when the URL works; Save downloads the clip into
//   the folder of the saved clips and makes that file the tag's source, and
//   the clock goes; the check becomes the trash only when the pointer comes
//   to it anew; the trash asks first, keeps the file on "No", and on "Yes"
//   deletes it and gives the tag its URL back;
// - Save moves the temp copy of a clip under its own name, and a clip whose
//   file is gone shows the "not available" card;
// - a speech model's reply is one request to `/audio/speech`; the audio is
//   written as a temp copy, the reply holds its tag with a new id, and a
//   later chat request gets only the id and the type of the clip, with no
//   path;
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

const TONE = silentWav(2)
const STORED_WAV_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.wav$/
const HOUR_MS = 60 * 60 * 1000
const DELETE_PROMPT = 'Are you sure you want to delete the saved file of this clip?'

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

  async function promptMessage (): Promise<string | null> {
    return browser.execute(() => document.querySelector('.confirm-dialog .confirm-message')?.textContent ?? null)
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

  beforeAll(async () => {
    clips = await startClipServer({
      'tone.wav': { type: 'audio/wav', bytes: TONE },
      'video.webm': { type: 'video/webm', bytes: WEBM_VIDEO },
    })
    setup = await startMockProviderApp(SPEAKER, {
      mediaApi: { format: 'venice' },
      models: [
        { id: SPEAKER.modelId, name: SPEAKER.modelName, outputs: ['audio'], request: 'tts' },
        { id: CHAT_MODEL.id, name: CHAT_MODEL.name },
      ],
    }, { heldPaths: [SPEECH_PATH] })
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

    // The clock tells until when the URL works, with the time as the page
    // writes it: in the locale and the time zone of the app.
    const until = await browser.execute(
      (time: string) => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(time)),
      expires,
    )
    await movePointer(browser, await elementCenter(browser, '.media-player__clock'))
    await waitForValue(browser, 'clock tooltip', () => openPlayerTooltips(browser), [
      `Not saved This clip is available until ${until}. Save it to keep it.`,
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

  it('moves the temp copy of a clip on Save, and tells that a clip with no file is not available', async () => {
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
    expect(await browser.execute(
      () => Array.from(document.querySelectorAll('.cm-content .media-player__unavailable'), (card) => card.textContent?.trim() ?? ''),
    )).toStrictEqual(['This clip is no longer available.'])

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
