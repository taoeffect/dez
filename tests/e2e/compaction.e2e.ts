import fs from 'node:fs'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Key } from 'webdriverio'
import { CARRIED_USER_ASSETS_LABEL, COMPACTION_MESSAGE_INTRO, COMPACTION_USER_MESSAGE_LABEL, compactionTagText } from '../../src/model/chat/compaction'
import type { ShownPicture } from '../../src/model/chat/shownPictures'
import type { SectionData } from '../../src/model/persistence/types'
import { shortDuration } from '../../src/view/thread/pillDuration'
import { anthropicChatBody, anthropicMarkedUser, openAiChatBody } from './harness/chatBody'
import { consoleErrors, resetConsoleErrors, screenshotOnFailure, typeKeys, waitForValue } from './harness/dom'
import { appFilePath, conversationFilePath, makeConversation, seedConversation, writeTestFile } from './harness/fixtures'
import { pasteImageReference, pngDataUrl, shownImages, solidPng, type ShownImage } from './harness/images'
import { shownPlayers, WEBM_VIDEO, type ShownPlayer } from './harness/media'
import { startMockProviderApp, takeRequest, type MockProviderApp } from './harness/mockProviderApp'
import { mockChatPath, replyText, sendAnthropicReply, sendChatReply, type MockProvider } from './harness/mockServer'
import type { E2EBrowser } from './harness/session'
import { activeConversationId, editorCaret, focusEditor, misplacedLines, pressRolePill, savedPillLines, sbpCall, submit, threadSections, waitForThread, type ThreadSection } from './harness/thread'
import { hiddenAssetNotes, hiddenPart, pressToolChip, toolChips, toolPanelPictures, type ToolChipView } from './harness/toolChips'

// A compacted conversation, driven through the real app against a mock
// server in this process. Its first section is the compaction section: an
// agent section whose first line is the compaction tag. No compaction runs
// here: each test opens a conversation file that holds one.
// - The editor shows an Agent pill first, in place of the tag line, and no
//   User pill above it. The caret never goes before the notes.
// - Each request starts with one user message: the notes, the pictures of
//   the tag, and the user messages right after the notes, with their
//   images. That message is the same in every later request.
// - A save and a relaunch keep the section, its pill, and the compaction
//   numbers of the file header.
// - Without its tag, the section is a user section, as the first section
//   of every other conversation; an undo brings the compaction section
//   back.
// - A new image gets an id after the `last-id` of the tag.
// - A compaction can keep an image or a clip: its reference or its tag has
//   the kept mark. The editor hides it at its place in the compaction
//   section and in the section of the carried assets of the user, and the
//   compaction chip under the Agent pill shows it in its panel, with the
//   pictures of the tag. A request sends a kept image as its text only,
//   unless the user names it with `@id`.
//
// One app session serves the whole file. The relaunch test reopens the
// conversation of the request test.

const PROVIDER: MockProvider = { id: 'compact', name: 'Compact Mock', modelId: 'compact-model', modelName: 'Compact Model' }
const CLAUDE: MockProvider = { id: 'claude', name: 'Claude Mock', modelId: 'claude-model', modelName: 'Claude Model', apiFormat: 'anthropic' }
const MODEL_KEY = `${PROVIDER.id}/${PROVIDER.modelId}`

// The image of the kept user message, the image that the notes name, and
// the picture that the tag keeps for the model.
const KEPT_PNG = solidPng(40, 24, [220, 40, 40])
const MADE_PNG = solidPng(30, 20, [40, 160, 60])
const SHEET_PNG = solidPng(64, 16, [40, 90, 220])
const SHEET: ShownPicture = { file: 'compaction-sheet.png', label: 'The frame sheet of the video clip @c.', width: 64, height: 16, bytes: SHEET_PNG.length }
// The image that the notes keep, and the image that the section of the
// carried assets of the user shows.
const KEPT_MADE_PNG = solidPng(36, 28, [200, 160, 40])
const CARRIED_PNG = solidPng(44, 22, [120, 40, 160])

const PLAIN_TAG = compactionTagText({ count: 1, lastId: 'c', pictures: [] })
const REPLY_MS = 4213
// The start of each kept user message in the compaction message.
const KEPT = `\n\n${COMPACTION_USER_MESSAGE_LABEL}\n`
const REQUESTS_ID = 'compacted-requests'

/** One role pill of the editor. */
interface PillView {
  index: number
  role: string
  /** The model name of the pill; null when it shows none. */
  model: string | null
  /** The reply time of the pill; null when it shows none. */
  time: string | null
}

/** How the editor shows the start of its first section. */
interface FirstSectionLook {
  /** The role that the editor marks on its content: only `agent`, for a
   *  compaction section. */
  mark: string | null
  /** Whether the User pill of a first user section shows. It is no widget:
   *  the content draws it above the first line. */
  userPill: boolean
  /** Whether the editor shows the text of a compaction tag. */
  tagText: boolean
}

const COMPACTED_LOOK: FirstSectionLook = { mark: 'agent', userPill: false, tagText: false }
const AGENT_PILL: PillView = { index: 0, role: 'agent', model: PROVIDER.modelName, time: shortDuration(REPLY_MS) }

function userPill (index: number): PillView {
  return { index, role: 'user', model: null, time: null }
}

function textSection (role: SectionData['role'], text: string): SectionData {
  return { role, nodes: [{ kind: 'text', text }] }
}

/** A compaction section of the mock model with the text `text`. */
function compactionSection (text: string, provider = PROVIDER): SectionData {
  return { ...textSection('agent', text), model: { providerId: provider.id, modelId: provider.modelId }, durationMs: REPLY_MS }
}

function imagePart (png: Buffer): Record<string, unknown> {
  return { type: 'image_url', image_url: { url: pngDataUrl(png) } }
}

// The images of the conversation with kept assets, as the editor shows
// them.
const MADE_IMAGE: ShownImage = { alt: 'compaction-made.png', width: 30, height: 20 }
const KEPT_MADE_IMAGE: ShownImage = { alt: 'compaction-kept-made.png', width: 36, height: 28 }
const KEPT_USER_IMAGE: ShownImage = { alt: 'compaction-kept.png', width: 40, height: 24 }
const CARRIED_IMAGE: ShownImage = { alt: 'compaction-carried.png', width: 44, height: 22 }
const KEPT_CLIP_PLAYER: ShownPlayer = { kind: 'video', id: 'c', available: true, source: 'blob', seconds: 2, picture: { width: 48, height: 36 }, clock: null, save: 'saved' }

/** The compaction chip of a conversation that the compaction left with
 *  `counts` (as "2 kept assets"), with its panel open or not. */
function compactionChipView (counts: string[], open: boolean): ToolChipView {
  return {
    state: null,
    label: ['Compaction 1', ...counts].join(', '),
    unrecognized: null,
    name: 'Compaction 1',
    summary: null,
    stateWord: null,
    spinner: false,
    expanded: String(open),
    title: open ? 'Hide compaction' : 'Show compaction',
    open,
  }
}

/** The text at the place of the kept asset `name`, while the caret is on
 *  another line. */
function keptNote (name: string): { text: string, visible: boolean } {
  return { text: `Kept ${name}. Open the compaction chip to see it.`, visible: false }
}

describe('a compacted conversation', () => {
  let setup: MockProviderApp
  let browser: E2EBrowser

  async function pills (): Promise<PillView[]> {
    return browser.execute(() => Array.from(document.querySelectorAll<HTMLElement>('.cm-content .dez-role-separator'), (separator) => ({
      index: Number(separator.dataset.sectionIndex),
      role: separator.dataset.role ?? '',
      model: separator.querySelector('.dez-role-separator__model-name')?.textContent ?? null,
      time: separator.querySelector('.dez-role-separator__duration')?.textContent ?? null,
    })))
  }

  async function firstSectionLook (): Promise<FirstSectionLook> {
    return browser.execute(() => {
      const content = document.querySelector<HTMLElement>('.cm-content')
      if (!content) throw new Error('firstSectionLook: .cm-content not found')
      return {
        mark: content.getAttribute('data-first-role'),
        userPill: getComputedStyle(content, '::before').display !== 'none',
        tagText: (content.textContent ?? '').includes('dez:compaction'),
      }
    })
  }

  // The left edge and the height of each role pill, and how far the first
  // one is below the top of the editor's content, in whole px.
  async function pillBoxes (): Promise<{ lefts: number[], heights: number[], firstTop: number }> {
    return browser.execute(() => {
      const content = document.querySelector<HTMLElement>('.cm-content')
      if (!content) throw new Error('pillBoxes: .cm-content not found')
      const boxes = Array.from(content.querySelectorAll('.dez-role-separator__label'), (pill) => pill.getBoundingClientRect())
      return {
        lefts: boxes.map((box) => Math.round(box.left)),
        heights: boxes.map((box) => Math.round(box.height)),
        firstTop: Math.round(boxes[0].top - content.getBoundingClientRect().top),
      }
    })
  }

  // Seeds the conversation `id` with `sections` for the model of
  // `provider`, with the cost and the numbers of one compaction, opens
  // it, and waits for it.
  async function openCompacted (id: string, sections: SectionData[], provider = PROVIDER): Promise<ThreadSection[]> {
    const cost = { usd: 0.25, requests: 4, unpriced: 0 }
    await seedConversation(setup.app.home, makeConversation({
      id,
      title: id,
      sections,
      activeModel: { providerId: provider.id, modelId: provider.modelId, modelName: provider.modelName },
      cost,
      compactions: { count: 1, tokens: 52_000, cost },
    }))
    await sbpCall(browser, 'dez.model/tabs/openConversation', id)
    const thread = sections.map(({ role, nodes }) => ({ role, text: nodes.map((node) => (node.kind === 'text' ? node.text : '')).join('') }))
    await waitForThread(browser, thread)
    return thread
  }

  // The files of the conversation with images, and its sections: the
  // compaction section (its tag keeps a picture, and its notes name a made
  // image), the kept user message with its image, and the empty message
  // of the user.
  async function imageConversation (): Promise<{ sections: SectionData[], notes: string, kept: string }> {
    const { home } = setup.app
    const keptFile = await writeTestFile(appFilePath(home, 'assets', 'images', 'compaction-kept.png'), KEPT_PNG)
    const madeFile = await writeTestFile(appFilePath(home, 'assets', 'generated', 'images', 'compaction-made.png'), MADE_PNG)
    await writeTestFile(appFilePath(home, 'assets', 'generated', 'views', SHEET.file), SHEET_PNG)
    const notes = `The user wants a film of a fox.\nThe fox: ![${madeFile}](id=b)\nIt is red.`
    const kept = `Make a film of ![${keptFile}](id=a)`
    const tag = compactionTagText({ count: 1, lastId: 'c', pictures: [SHEET] })
    return { sections: [compactionSection(`${tag}\n${notes}`), textSection('user', kept), textSection('user', '')], notes, kept }
  }

  // The first message of each request of the image conversation after the
  // user sent `sent`: the notes with their image, the picture of the tag
  // after its label, then each user message with its image.
  function compactionMessage (sent: string): Record<string, unknown> {
    return {
      role: 'user',
      content: [
        { type: 'text', text: `${COMPACTION_MESSAGE_INTRO}\n\nThe user wants a film of a fox.\nThe fox: ![image](id=b)` },
        imagePart(MADE_PNG),
        { type: 'text', text: `\nIt is red.\n\n${SHEET.label}` },
        imagePart(SHEET_PNG),
        { type: 'text', text: `${KEPT}Make a film of ![image](id=a)` },
        imagePart(KEPT_PNG),
        { type: 'text', text: `${KEPT}${sent}` },
      ],
    }
  }

  // The text of each count at the end of the compaction chip.
  async function compactionChipCounts (): Promise<string[]> {
    return browser.execute(() => Array.from(document.querySelectorAll('.cm-content .dez-compaction-chip__count'), (count) => count.textContent ?? ''))
  }

  // The files of the conversation with kept assets, and its sections: the
  // compaction section (its notes show the made image `b` and keep the
  // image `d` and the clip `c`, and its tag keeps a picture), the first
  // kept user message, the section of the carried assets of the user (it
  // keeps the image `a` and shows the image `e`), a second kept user
  // message, and the empty message of the user. The kept marks are written
  // out here, so that the spec does not take them from the code under test.
  async function keptConversation (): Promise<SectionData[]> {
    const { home } = setup.app
    const made = await writeTestFile(appFilePath(home, 'assets', 'generated', 'images', 'compaction-made.png'), MADE_PNG)
    const keptMade = await writeTestFile(appFilePath(home, 'assets', 'generated', 'images', 'compaction-kept-made.png'), KEPT_MADE_PNG)
    const clip = await writeTestFile(appFilePath(home, 'assets', 'generated', 'video', 'compaction-clip.webm'), WEBM_VIDEO)
    const keptUser = await writeTestFile(appFilePath(home, 'assets', 'images', 'compaction-kept.png'), KEPT_PNG)
    const carried = await writeTestFile(appFilePath(home, 'assets', 'images', 'compaction-carried.png'), CARRIED_PNG)
    await writeTestFile(appFilePath(home, 'assets', 'generated', 'views', SHEET.file), SHEET_PNG)
    const notes = [
      compactionTagText({ count: 1, lastId: 'e', pictures: [SHEET] }),
      'The user wants a film of a fox.',
      `![${made}](id=b)`,
      'The fox is red.',
      `![${keptMade}](id=d|kept=compaction)`,
      'The film of the fox:',
      `<dez:video id="c" type="video/webm" src="${clip}" kept="compaction"/>`,
      'The fox sleeps.',
    ]
    return [
      compactionSection(notes.join('\n')),
      textSection('user', 'Make a film of the fox.'),
      textSection('user', [CARRIED_USER_ASSETS_LABEL, `![${keptUser}](id=a|kept=compaction)`, `![${carried}](id=e)`].join('\n')),
      textSection('user', 'Make it longer.'),
      textSection('user', ''),
    ]
  }

  // The first message of the request of the conversation with kept assets
  // after the user sent a message: the kept images go as their text only,
  // and the clip as the request form of its tag. `sent` is the text of the
  // sent message up to its first image part, if any, and `sentParts` are
  // the parts of the rest of it.
  function keptCompactionMessage (sent: string, ...sentParts: Array<Record<string, unknown>>): Record<string, unknown> {
    return {
      role: 'user',
      content: [
        { type: 'text', text: `${COMPACTION_MESSAGE_INTRO}\n\nThe user wants a film of a fox.\n![image](id=b)` },
        imagePart(MADE_PNG),
        {
          type: 'text',
          text: `\nThe fox is red.\n![image](id=d|kept=compaction)\nThe film of the fox:\n<dez:video id="c" type="video/webm"/>\nThe fox sleeps.\n\n${SHEET.label}`,
        },
        imagePart(SHEET_PNG),
        { type: 'text', text: `${KEPT}Make a film of the fox.\n\n${CARRIED_USER_ASSETS_LABEL}\n![image](id=a|kept=compaction)\n![image](id=e)` },
        imagePart(CARRIED_PNG),
        { type: 'text', text: `${KEPT}Make it longer.${KEPT}${sent}` },
        ...sentParts,
      ],
    }
  }

  beforeAll(async () => {
    setup = await startMockProviderApp(PROVIDER, {}, { moreProviders: [{ provider: CLAUDE }] })
    browser = setup.browser
  })

  beforeEach(async () => {
    await resetConsoleErrors(browser)
  })

  afterEach(async (ctx) => {
    await screenshotOnFailure(browser, ctx)
    await setup.mock.dropOpenReplies(browser)
    if (ctx.task.result?.state === 'fail') return
    expect(await consoleErrors(browser)).toEqual([])
  })

  afterAll(async () => {
    await setup?.stop()
  })

  it('shows an Agent pill first, in place of the tag line, and keeps the caret off that line', async () => {
    const { sections } = await imageConversation()
    const thread = await openCompacted('compacted-look', sections)
    const notesStart = thread[0].text.indexOf('\n') + 1

    await waitForValue(browser, 'pills', pills, [AGENT_PILL, userPill(1), userPill(2)])
    expect(await firstSectionLook()).toStrictEqual(COMPACTED_LOOK)
    await waitForValue(browser, 'shown images', () => shownImages(browser), [
      { alt: 'compaction-made.png', width: 30, height: 20 },
      { alt: 'compaction-kept.png', width: 40, height: 24 },
    ])
    // The first pill is a pill as every other one: same left edge, same
    // height, and no line is drawn at a wrong place.
    const boxes = await pillBoxes()
    expect(new Set(boxes.lefts).size).toBe(1)
    expect(new Set(boxes.heights).size).toBe(1)
    expect(await misplacedLines(browser)).toStrictEqual([])

    // The first place of the caret is the start of the notes: text that
    // the user types at the top of the doc goes there.
    await focusEditor(browser)
    await browser.keys([Key.Control, Key.Home])
    expect(await editorCaret(browser)).toBe(notesStart)
    await browser.keys([Key.ArrowUp])
    await browser.keys([Key.ArrowLeft])
    expect(await editorCaret(browser)).toBe(notesStart)
    await typeKeys(browser, 'So: ')
    await waitForThread(browser, [{ role: 'agent', text: `${thread[0].text.slice(0, notesStart)}So: ${thread[0].text.slice(notesStart)}` }, ...thread.slice(1)])
    await browser.keys([Key.Control, 'z'])
    await waitForThread(browser, thread)

    // The role of a compaction section does not toggle.
    await pressRolePill(browser, 0, '.dez-role-separator__label', { shiftKey: true })
    expect(await pills()).toStrictEqual([AGENT_PILL, userPill(1), userPill(2)])
    expect(await threadSections(browser)).toStrictEqual(thread)
  })

  it('sends the notes, the pictures of the tag, and the kept user messages as one user message, the first of every request', async () => {
    const { sections } = await imageConversation()
    const thread = await openCompacted(REQUESTS_ID, sections)

    await submit(browser, 'Go on.')
    const first = await takeRequest(setup, mockChatPath(PROVIDER), openAiChatBody(PROVIDER, [compactionMessage('Go on.')]))
    await sendChatReply(first.reply, 'the first')
    const answered = [...thread.slice(0, 2), { role: 'user', text: 'Go on.' }, { role: 'agent', text: replyText('the first') }, { role: 'user', text: '' }]
    await waitForThread(browser, answered)

    // The compaction message keeps its image parts when a newer user
    // message comes: the prompt cache needs the same bytes.
    await submit(browser, 'And then?')
    const second = await takeRequest(setup, mockChatPath(PROVIDER), openAiChatBody(PROVIDER, [
      compactionMessage('Go on.'),
      { role: 'assistant', content: replyText('the first') },
      { role: 'user', content: 'And then?' },
    ]))
    await sendChatReply(second.reply, 'the second')
    await waitForThread(browser, [...answered.slice(0, 4), { role: 'user', text: 'And then?' }, { role: 'agent', text: replyText('the second') }, { role: 'user', text: '' }])

    // The file keeps the agent role of the first section, its tag, and
    // the compaction numbers of its header. The two requests have no
    // known price: the mock model has no list price.
    const savedLines = async (): Promise<string[]> => (await fs.promises.readFile(conversationFilePath(setup.app.home, REQUESTS_ID), 'utf8')).split('\n')
    const savedNumbers = async (): Promise<string[]> => (await savedLines())[0]
      .replace(/ -->$/, '')
      .split(' | ')
      .filter((part) => /^(cost|requests|unpriced|compact)/.test(part))
    await waitForValue(browser, 'saved numbers', savedNumbers, [
      'cost: 0.25',
      'requests: 6',
      'unpriced: 2',
      'compactions: 1',
      'compacted-tokens: 52000',
      'compacted-cost: 0.25',
      'compacted-requests: 4',
    ])
    // A blank line follows the header.
    expect((await savedLines()).slice(2, 4)).toStrictEqual([`<dez:pill type="agent" model="${MODEL_KEY}" duration-ms="${REPLY_MS}"/>`, thread[0].text.split('\n')[0]])
  })

  it('sends a user message first in the Anthropic format', async () => {
    const thread = await openCompacted('compacted-claude', [
      compactionSection(`${PLAIN_TAG}\nNotes of the work.`, CLAUDE),
      textSection('user', 'The task.'),
      textSection('user', ''),
    ], CLAUDE)

    await submit(browser, 'Go on.')
    const request = await takeRequest(setup, mockChatPath(CLAUDE), anthropicChatBody(CLAUDE, [
      anthropicMarkedUser(`${COMPACTION_MESSAGE_INTRO}\n\nNotes of the work.${KEPT}The task.${KEPT}Go on.`),
    ]))
    sendAnthropicReply(request.reply, 'Claude')
    await waitForThread(browser, [...thread.slice(0, 2), { role: 'user', text: 'Go on.' }, { role: 'agent', text: replyText('Claude') }, { role: 'user', text: '' }])
  })

  it('makes the first section a user section when its tag goes, and an undo brings the compaction section back', async () => {
    const thread = await openCompacted('compacted-edit', [compactionSection(`${PLAIN_TAG}\nNotes of the work.`), textSection('user', 'The task.')])
    await waitForValue(browser, 'pills', pills, [AGENT_PILL, userPill(1)])
    const { firstTop } = await pillBoxes()

    // Backspace at the start of the notes deletes the whole tag.
    await focusEditor(browser)
    await browser.keys([Key.Control, Key.Home])
    await browser.keys([Key.Backspace])
    await waitForThread(browser, [{ role: 'user', text: 'Notes of the work.' }, thread[1]])
    await waitForValue(browser, 'pills with no tag', pills, [userPill(1)])
    expect(await firstSectionLook()).toStrictEqual({ mark: null, userPill: true, tagText: false })
    expect(await misplacedLines(browser)).toStrictEqual([])
    // The User pill is where the Agent pill was.
    const userPillTop = await browser.execute(() => {
      const content = document.querySelector<HTMLElement>('.cm-content')
      return content ? Math.round(parseFloat(getComputedStyle(content, '::before').top)) : null
    })
    expect(userPillTop).toBe(firstTop)
    await waitForValue(browser, 'saved pills with no tag', () => savedPillLines(setup.app.home, 'compacted-edit'), ['<dez:pill type="user"/>', '<dez:pill type="user"/>'])

    await browser.keys([Key.Control, 'z'])
    await waitForThread(browser, thread)
    await waitForValue(browser, 'pills after the undo', pills, [AGENT_PILL, userPill(1)])
    expect(await firstSectionLook()).toStrictEqual(COMPACTED_LOOK)
    expect(await misplacedLines(browser)).toStrictEqual([])
    expect(await editorCaret(browser)).toBe(PLAIN_TAG.length + 1)
    await waitForValue(browser, 'saved pills after the undo', () => savedPillLines(setup.app.home, 'compacted-edit'), [
      `<dez:pill type="agent" model="${MODEL_KEY}" duration-ms="${REPLY_MS}"/>`,
      '<dez:pill type="user"/>',
    ])
  })

  // The notes and the kept messages can still name an asset that the
  // compaction removed (`@c`), so its id must never name a new asset.
  it('gives a new image an id after the last id of the tag', async () => {
    await openCompacted('compacted-ids', [compactionSection(`${PLAIN_TAG}\nThe clip @c is the best one.`), textSection('user', '')])

    await focusEditor(browser)
    await browser.keys([Key.Control, Key.End])
    await pasteImageReference(browser, KEPT_PNG, 'd')
  })

  it('hides the assets that the compaction keeps, and its chip under the Agent pill shows them with the pictures of the tag', async () => {
    const thread = await openCompacted('compacted-kept-look', await keptConversation())
    const notes = [keptNote('image @d'), keptNote('video clip @c'), keptNote('image @a')]
    const counts = ['3 kept assets', '1 picture']

    await waitForValue(browser, 'shown images', () => shownImages(browser), [MADE_IMAGE, CARRIED_IMAGE])
    expect(await shownPlayers(browser)).toStrictEqual([])
    expect(await hiddenAssetNotes(browser)).toStrictEqual(notes)
    expect(await toolChips(browser)).toStrictEqual([compactionChipView(counts, false)])
    expect(await compactionChipCounts()).toStrictEqual(counts)
    expect(await toolPanelPictures(browser, 0)).toBeNull()
    expect(await misplacedLines(browser)).toStrictEqual([])

    // The panel shows the kept assets in doc order, then the picture. The
    // chip is above the notes, so its images come first.
    await pressToolChip(browser, 0)
    await waitForValue(browser, 'open chip', () => toolChips(browser), [compactionChipView(counts, true)])
    expect(await hiddenPart(browser, 0)).toStrictEqual({ heading: 'Kept assets', assets: 3, text: null })
    await waitForValue(browser, 'images with the panel open', () => shownImages(browser), [KEPT_MADE_IMAGE, KEPT_USER_IMAGE, MADE_IMAGE, CARRIED_IMAGE])
    await waitForValue(browser, 'player with the panel open', () => shownPlayers(browser), [KEPT_CLIP_PLAYER])
    await waitForValue(browser, 'picture with the panel open', () => toolPanelPictures(browser, 0), [{ label: SHEET.label, size: '64x16' }])
    // A press keeps the caret where it was, so the notes stay out of view.
    expect(await hiddenAssetNotes(browser)).toStrictEqual(notes)

    await pressToolChip(browser, 0)
    await waitForValue(browser, 'closed chip', () => toolChips(browser), [compactionChipView(counts, false)])
    expect(await hiddenPart(browser, 0)).toBeNull()
    expect(await shownPlayers(browser)).toStrictEqual([])
    expect(await shownImages(browser)).toStrictEqual([MADE_IMAGE, CARRIED_IMAGE])
    expect(await misplacedLines(browser)).toStrictEqual([])
    expect(await threadSections(browser)).toStrictEqual(thread)
  })

  it('sends a kept image as its text only, and a mention of the user sends the image right after the mention', async () => {
    const sections = await keptConversation()
    const plain = await openCompacted('compacted-kept-requests', sections)

    await submit(browser, 'Go on.')
    const first = await takeRequest(setup, mockChatPath(PROVIDER), openAiChatBody(PROVIDER, [keptCompactionMessage('Go on.')]))
    await sendChatReply(first.reply, 'the plain')
    await waitForThread(browser, [...plain.slice(0, 4), { role: 'user', text: 'Go on.' }, { role: 'agent', text: replyText('the plain') }, { role: 'user', text: '' }])

    // The newest user message is in the compaction message too: there, a
    // mention sends the kept image of the notes and the kept image of the
    // user.
    const mentioned = await openCompacted('compacted-kept-mention', sections)
    await submit(browser, 'Show me @d and @a.')
    const second = await takeRequest(setup, mockChatPath(PROVIDER), openAiChatBody(PROVIDER, [keptCompactionMessage(
      'Show me @d',
      imagePart(KEPT_MADE_PNG),
      { type: 'text', text: ' and @a' },
      imagePart(KEPT_PNG),
      { type: 'text', text: '.' },
    )]))
    await sendChatReply(second.reply, 'the mention')
    await waitForThread(browser, [...mentioned.slice(0, 4), { role: 'user', text: 'Show me @d and @a.' }, { role: 'agent', text: replyText('the mention') }, { role: 'user', text: '' }])
  })

  // Only the compaction section and the section of the carried assets of
  // the user hide what the compaction keeps. A user can copy a kept line
  // into a later message, and there it is an image as every other one.
  it('shows a kept image at its place in a user message after a reply', async () => {
    const kept = await writeTestFile(appFilePath(setup.app.home, 'assets', 'images', 'compaction-kept.png'), KEPT_PNG)
    const reference = `![${kept}](id=a|kept=compaction)`
    await openCompacted('compacted-kept-later', [
      compactionSection(`${PLAIN_TAG}\nThe user sent a fox.\n${reference}\nIt is red.`),
      textSection('user', 'Make a film of the fox.'),
      textSection('agent', 'Which fox?'),
      textSection('user', `This one:\n${reference}`),
    ])

    await waitForValue(browser, 'shown images', () => shownImages(browser), [KEPT_USER_IMAGE])
    expect(await hiddenAssetNotes(browser)).toStrictEqual([keptNote('image @a')])
    expect(await toolChips(browser)).toStrictEqual([compactionChipView(['1 kept asset'], false)])
  })

  it('shows the compaction section and sends the same first message after a relaunch', async () => {
    const active = await activeConversationId(browser)
    browser = await setup.relaunch()
    // A new page: the record that beforeEach started is gone.
    await resetConsoleErrors(browser)

    // The tab bar shows before the app restores the saved tabs, and the
    // restore sets the active tab: the tab of the test before. Switch only
    // after it, or the restore switches back.
    await waitForValue(browser, 'restored active tab', () => activeConversationId(browser), active)
    await sbpCall(browser, 'dez.model/tabs/openConversation', REQUESTS_ID)
    // The times of the two replies of the request test change from run to
    // run.
    await waitForValue(browser, 'pills after the relaunch', async () => (await pills()).map((pill) => (pill.index === 0 ? pill : { ...pill, time: null })), [
      AGENT_PILL,
      userPill(1),
      userPill(2),
      { index: 3, role: 'agent', model: PROVIDER.modelName, time: null },
      userPill(4),
      { index: 5, role: 'agent', model: PROVIDER.modelName, time: null },
      userPill(6),
    ])
    expect(await firstSectionLook()).toStrictEqual(COMPACTED_LOOK)

    await submit(browser, 'And now?')
    const request = await takeRequest(setup, mockChatPath(PROVIDER), openAiChatBody(PROVIDER, [
      compactionMessage('Go on.'),
      { role: 'assistant', content: replyText('the first') },
      { role: 'user', content: 'And then?' },
      { role: 'assistant', content: replyText('the second') },
      { role: 'user', content: 'And now?' },
    ]))
    await sendChatReply(request.reply, 'the third')
    await waitForValue(browser, 'the third reply', async () => (await threadSections(browser)).at(-2)?.text ?? null, replyText('the third'))
  })
})
