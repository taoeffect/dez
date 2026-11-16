import fs from 'node:fs'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Key } from 'webdriverio'
import { CARRIED_USER_ASSETS_LABEL, COMPACTION_MESSAGE_INTRO, COMPACTION_USER_MESSAGE_LABEL, compactionTagText, readCompactionTag } from '../../src/model/chat/compaction'
import { compactionNotesText } from '../../src/model/chat/compactionNotes'
import { newMediaIds } from '../../src/model/chat/mediaIds'
import type { ShownPicture } from '../../src/model/chat/shownPictures'
import type { ConversationData, SectionData } from '../../src/model/persistence/types'
import { compactionInstruction } from '../../src/model/streams/compactionRequest'
import { shortDuration } from '../../src/view/thread/pillDuration'
import { anthropicChatBody, anthropicMarkedUser, openAiChatBody } from './harness/chatBody'
import { click, consoleErrors, pointerClick, pointerClickAt, resetConsoleErrors, screenshotOnFailure, typeKeys, waitForValue } from './harness/dom'
import { linkedDropDir } from './harness/drops'
import { appFilePath, conversationFilePath, filesIn, makeConversation, seedConversation, writeTestFile } from './harness/fixtures'
import { pasteImageReference, pngDataUrl, shownImages, solidPng, type ShownImage } from './harness/images'
import { problemCards, shownPlayers, silentWav, WEBM_VIDEO, type ShownPlayer } from './harness/media'
import { startMockProviderApp, takeRequest, type MockProviderApp } from './harness/mockProviderApp'
import { LARGE_TOKENS, mockChatPath, openAiToolCall, replyText, sendAnthropicReply, sendChatReply, sendChatText, sendToolCalls, startEventStream, toolResult, writeChatFrame, type HeldRequest, type MockProvider } from './harness/mockServer'
import type { E2EBrowser } from './harness/session'
import { activeConversationId, activeTabStreaming, AT_BOTTOM_PX, docPos, editorCaret, editorDoc, focusEditor, misplacedLines, newTab, openToasts, pickModel, pressRolePill, savedPillLines, sbpCall, setCaret, submit, threadSections, viewFromBottom, waitForThread, type ThreadSection } from './harness/thread'
import { hiddenAssetNotes, hiddenPart, pressToolChip, toolChips, toolPanelPictures, type ToolChipView } from './harness/toolChips'

// Compaction, driven through the real app against a mock server in this
// process.
//
// A compacted conversation: its first section is the compaction section,
// an agent section whose first line is the compaction tag. These tests
// open a conversation file that holds one.
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
//   unless the user names it with `@id`. A kept clip in the panel plays by
//   the role that its section has now.
//
// A compaction that runs: the mock tells that a request was near the
// context window of its model, or the conversation file tells it.
// - Before the next chat request of the reply (between two tool rounds,
//   or the first request after a submit), Dez sends the compaction
//   request: the request that was due, with the instruction of Dez as one
//   more user message. The bottom bar shows "Compacting…" meanwhile.
// - The notes of the answer take the place of the conversation, in the
//   tab, in the editor, and in the file, and the reply goes on: its next
//   request holds the notes, the images and pictures that go with them,
//   and the kept messages of the user.
// - A compaction request that fails two times ends the reply with an
//   error toast, and a stop ends it with none. Both keep the
//   conversation.
// - The first compaction already drops a made image of an earlier reply
//   that the answer does not keep, but never an image of the user. The
//   compaction chip tells how many assets the compaction dropped.
// - Dez deletes the file of a dropped image that the user saw only in the
//   panel of a call, and the picture copies of the tag before. The file
//   of any other dropped image stays.
//
// One app session serves the whole file. The relaunch test reopens the
// conversation of the request test.

const PROVIDER: MockProvider = { id: 'compact', name: 'Compact Mock', modelId: 'compact-model', modelName: 'Compact Model' }
const CLAUDE: MockProvider = { id: 'claude', name: 'Claude Mock', modelId: 'claude-model', modelName: 'Claude Model', apiFormat: 'anthropic' }
const MODEL_KEY = `${PROVIDER.id}/${PROVIDER.modelId}`
const CHAT_PATH = mockChatPath(PROVIDER)

// The first line of the instruction of a compaction request.
const INSTRUCTION_START = compactionInstruction({ assetTable: '', jobs: [], cost: undefined, tools: false }).split('\n')[0]
const NOTES_SUMMARY = 'The user wants to go on with the task.'
// An answer to a compaction request: a summary, and no other part.
const NOTES_ANSWER = `## Summary\n${NOTES_SUMMARY}\n`

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
const USER_MESSAGE_START = `\n\n${COMPACTION_USER_MESSAGE_LABEL}\n`
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
  // The folder of a linked clip, out of every temp folder.
  let linkedDir: string

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
  // `provider` and with the other fields of `more`, opens it, and waits
  // for it.
  async function openSeeded (id: string, sections: SectionData[], provider: MockProvider, more: Partial<ConversationData>): Promise<ThreadSection[]> {
    await seedConversation(setup.app.home, makeConversation({
      ...more,
      id,
      title: id,
      sections,
      activeModel: { providerId: provider.id, modelId: provider.modelId, modelName: provider.modelName },
    }))
    await sbpCall(browser, 'dez.model/tabs/openConversation', id)
    const thread = sections.map(({ role, nodes }) => ({ role, text: nodes.map((node) => (node.kind === 'text' ? node.text : '')).join('') }))
    await waitForThread(browser, thread)
    return thread
  }

  // Seeds the conversation `id` with `sections` for the model of
  // `provider`, with the cost and the numbers of one compaction and the
  // fields of `more`, opens it, and waits for it.
  async function openCompacted (id: string, sections: SectionData[], provider = PROVIDER, more: Partial<ConversationData> = {}): Promise<ThreadSection[]> {
    const cost = { usd: 0.25, requests: 4, unpriced: 0 }
    return openSeeded(id, sections, provider, { cost, compactions: { count: 1, tokens: 52_000, cost }, ...more })
  }

  // Seeds and opens the conversation `id` with one reply, whose request
  // held `LARGE_TOKENS` tokens: the first request of its next reply is due
  // for a compaction.
  async function openLarge (id: string): Promise<ThreadSection[]> {
    return openSeeded(id, [textSection('user', 'The task.'), textSection('agent', 'An earlier answer.'), textSection('user', '')], PROVIDER, {
      context: { tokens: LARGE_TOKENS, estimate: 0 },
    })
  }

  // Checks that `request` is the compaction request of a conversation
  // whose next chat request holds `messages`: that same request (the
  // prompt cache of the provider holds its start), with one more user
  // message at its end, the instruction of Dez.
  function expectCompactionRequest (request: HeldRequest, messages: unknown[]): void {
    const body = JSON.parse(request.body) as { messages: Array<{ role: string, content: unknown }> }
    expect({ ...body, messages: body.messages.slice(0, -1) }).toStrictEqual(openAiChatBody(PROVIDER, messages))
    const instruction = body.messages.at(-1)
    expect(instruction?.role).toBe('user')
    expect(typeof instruction?.content === 'string' && instruction.content.startsWith(INSTRUCTION_START)).toBe(true)
  }

  // The one message of a request right after a compaction that kept no
  // image: the notes that the tab holds (the text of its first section
  // after the tag line), then each message of `kept`, the messages of the
  // user that the compaction kept.
  async function notesMessage (...kept: string[]): Promise<Record<string, unknown>> {
    const [first] = await threadSections(browser)
    const tag = first.role === 'agent' ? readCompactionTag(first.text) : null
    if (tag === null) throw new Error('notesMessage: the first section of the tab is no compaction section')
    return { role: 'user', content: `${COMPACTION_MESSAGE_INTRO}\n\n${first.text.slice(tag.textFrom)}${kept.map((text) => `${USER_MESSAGE_START}${text}`).join('')}` }
  }

  // Whether the bottom bar tells the user that the reply waits for a
  // compaction: the part is on the one line of the label that shows.
  async function showsCompacting (): Promise<boolean> {
    return browser.execute(() => {
      const label = document.querySelector<HTMLElement>('.bottom-bar .usage-label')
      const part = label?.querySelector<HTMLElement>('.compacting-label')
      if (!label || !part) return false
      const box = label.getBoundingClientRect()
      const rect = part.getBoundingClientRect()
      return rect.width > 0 && rect.top >= box.top - 1 && rect.bottom <= box.bottom + 1
    })
  }

  // The role of each pill of the editor, with the index of its section.
  async function pillRoles (): Promise<Array<{ index: number, role: string }>> {
    return (await pills()).map(({ index, role }) => ({ index, role }))
  }

  // The lines of the saved file of the conversation `id`.
  async function savedLines (id: string): Promise<string[]> {
    return (await fs.promises.readFile(conversationFilePath(setup.app.home, id), 'utf8')).split('\n')
  }

  // The numbers of the header of the saved file of the conversation `id`
  // whose names match `names`.
  async function savedNumbers (id: string, names: RegExp): Promise<string[]> {
    return (await savedLines(id))[0]
      .replace(/ -->$/, '')
      .split(' | ')
      .filter((part) => names.test(part))
  }

  // The files of the conversation with images, and its sections: the
  // compaction section (its tag keeps a picture, and its notes name a made
  // image), the kept user message with its image, and the empty message
  // of the user.
  async function imageConversation (): Promise<SectionData[]> {
    const { home } = setup.app
    const keptFile = await writeTestFile(appFilePath(home, 'assets', 'images', 'compaction-kept.png'), KEPT_PNG)
    const madeFile = await writeTestFile(appFilePath(home, 'assets', 'generated', 'images', 'compaction-made.png'), MADE_PNG)
    await writeTestFile(appFilePath(home, 'assets', 'generated', 'views', SHEET.file), SHEET_PNG)
    const notes = `The user wants a film of a fox.\nThe fox: ![${madeFile}](id=b)\nIt is red.`
    const kept = `Make a film of ![${keptFile}](id=a)`
    const tag = compactionTagText({ count: 1, lastId: 'c', pictures: [SHEET] })
    return [compactionSection(`${tag}\n${notes}`), textSection('user', kept), textSection('user', '')]
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
        { type: 'text', text: `${USER_MESSAGE_START}Make a film of ![image](id=a)` },
        imagePart(KEPT_PNG),
        { type: 'text', text: `${USER_MESSAGE_START}${sent}` },
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
        { type: 'text', text: `${USER_MESSAGE_START}Make a film of the fox.\n\n${CARRIED_USER_ASSETS_LABEL}\n![image](id=a|kept=compaction)\n![image](id=e)` },
        imagePart(CARRIED_PNG),
        { type: 'text', text: `${USER_MESSAGE_START}Make it longer.${USER_MESSAGE_START}${sent}` },
        ...sentParts,
      ],
    }
  }

  beforeAll(async () => {
    setup = await startMockProviderApp(PROVIDER, {}, { moreProviders: [{ provider: CLAUDE }] })
    browser = setup.browser
    linkedDir = await linkedDropDir('compaction')
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
    if (linkedDir) await fs.promises.rm(linkedDir, { recursive: true, force: true })
  })

  it('shows an Agent pill first, in place of the tag line, and keeps the caret off that line', async () => {
    const sections = await imageConversation()
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
    const sections = await imageConversation()
    const thread = await openCompacted(REQUESTS_ID, sections)

    await submit(browser, 'Go on.')
    const first = await takeRequest(setup, CHAT_PATH, openAiChatBody(PROVIDER, [compactionMessage('Go on.')]))
    await sendChatReply(first.reply, 'the first')
    const answered = [...thread.slice(0, 2), { role: 'user', text: 'Go on.' }, { role: 'agent', text: replyText('the first') }, { role: 'user', text: '' }]
    await waitForThread(browser, answered)

    // The compaction message keeps its image parts when a newer user
    // message comes: the prompt cache needs the same bytes.
    await submit(browser, 'And then?')
    const second = await takeRequest(setup, CHAT_PATH, openAiChatBody(PROVIDER, [
      compactionMessage('Go on.'),
      { role: 'assistant', content: replyText('the first') },
      { role: 'user', content: 'And then?' },
    ]))
    await sendChatReply(second.reply, 'the second')
    await waitForThread(browser, [...answered.slice(0, 4), { role: 'user', text: 'And then?' }, { role: 'agent', text: replyText('the second') }, { role: 'user', text: '' }])

    // The file keeps the agent role of the first section, its tag, and
    // the compaction numbers of its header. The two requests have no
    // known price: the mock model has no list price.
    await waitForValue(browser, 'saved numbers', () => savedNumbers(REQUESTS_ID, /^(cost|requests|unpriced|compact)/), [
      'cost: 0.25',
      'requests: 6',
      'unpriced: 2',
      'compactions: 1',
      'compacted-tokens: 52000',
      'compacted-cost: 0.25',
      'compacted-requests: 4',
    ])
    // A blank line follows the header.
    expect((await savedLines(REQUESTS_ID)).slice(2, 4)).toStrictEqual([`<dez:pill type="agent" model="${MODEL_KEY}" duration-ms="${REPLY_MS}"/>`, thread[0].text.split('\n')[0]])
  })

  it('sends a user message first in the Anthropic format', async () => {
    const thread = await openCompacted('compacted-claude', [
      compactionSection(`${PLAIN_TAG}\nNotes of the work.`, CLAUDE),
      textSection('user', 'The task.'),
      textSection('user', ''),
    ], CLAUDE)

    await submit(browser, 'Go on.')
    const request = await takeRequest(setup, mockChatPath(CLAUDE), anthropicChatBody(CLAUDE, [
      anthropicMarkedUser(`${COMPACTION_MESSAGE_INTRO}\n\nNotes of the work.${USER_MESSAGE_START}The task.${USER_MESSAGE_START}Go on.`),
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
    const first = await takeRequest(setup, CHAT_PATH, openAiChatBody(PROVIDER, [keptCompactionMessage('Go on.')]))
    await sendChatReply(first.reply, 'the plain')
    await waitForThread(browser, [...plain.slice(0, 4), { role: 'user', text: 'Go on.' }, { role: 'agent', text: replyText('the plain') }, { role: 'user', text: '' }])

    // The newest user message is in the compaction message too: there, a
    // mention sends the kept image of the notes and the kept image of the
    // user.
    const mentioned = await openCompacted('compacted-kept-mention', sections)
    await submit(browser, 'Show me @d and @a.')
    const second = await takeRequest(setup, CHAT_PATH, openAiChatBody(PROVIDER, [keptCompactionMessage(
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

  // A linked file plays only in a user section. Backspace at the start of
  // the carried assets of the user joins them to the compaction section,
  // an agent section, so the open panel shows the kept linked clip as a
  // clip that does not play; an undo makes it play again.
  it('plays a kept linked clip in the open panel only while its section is a user section', async () => {
    const linked = await writeTestFile(path.join(linkedDir, 'compaction-linked.webm'), WEBM_VIDEO)
    const notes = `${PLAIN_TAG}\nThe user sent a film.`
    const carried = [CARRIED_USER_ASSETS_LABEL, `<dez:video id="c" type="video/webm" src="${linked}" kept="compaction"/>`].join('\n')
    const thread = await openCompacted('compacted-kept-linked', [compactionSection(notes), textSection('user', carried), textSection('user', '')])

    await pressToolChip(browser, 0)
    await waitForValue(browser, 'player of the user section', () => shownPlayers(browser), [KEPT_CLIP_PLAYER])

    await focusEditor(browser)
    await setCaret(browser, await docPos(browser, CARRIED_USER_ASSETS_LABEL))
    await browser.keys([Key.Backspace])
    await waitForThread(browser, [{ role: 'agent', text: `${notes}${carried}` }, thread[2]])
    expect(await hiddenAssetNotes(browser)).toStrictEqual([keptNote('video clip @c')])
    await waitForValue(browser, 'card of the agent section', () => problemCards(browser), [{ cause: 'gone', lines: ['This clip is no longer available.'] }])

    await browser.keys([Key.Control, 'z'])
    await waitForThread(browser, thread)
    await waitForValue(browser, 'player after the undo', () => shownPlayers(browser), [KEPT_CLIP_PLAYER])
  })

  // A compaction can keep some hundred clips. Each player holds a pipeline,
  // and the sound server refuses one past some count (the card of a clip
  // that cannot play), so the panel draws only the rows near the visible
  // part of its list (`AssetList.vue`).
  it('draws only the kept clips near the visible part of the panel, and keeps a clip that plays', async () => {
    const { home } = setup.app
    const wav = await writeTestFile(appFilePath(home, 'assets', 'generated', 'audio', 'compaction-many.wav'), silentWav(1))
    const webm = await writeTestFile(appFilePath(home, 'assets', 'generated', 'video', 'compaction-many.webm'), WEBM_VIDEO)
    const ids = newMediaIds([], 130)
    const [first, firstVideo] = ids
    const last = ids[ids.length - 1]
    const tags = ids.map((id, index) => index % 2 === 0
      ? `<dez:audio id="${id}" type="audio/wav" src="${wav}" kept="compaction"/>`
      : `<dez:video id="${id}" type="video/webm" src="${webm}" kept="compaction"/>`)
    const notes = [compactionTagText({ count: 1, lastId: last, pictures: [] }), 'The user made many clips.', ...tags].join('\n')
    const thread = await openCompacted('compacted-many-clips', [compactionSection(notes), textSection('user', 'Ask.'), textSection('user', '')])
    expect(await compactionChipCounts()).toStrictEqual(['130 kept assets'])

    // The ids of the drawn players, true when each one has its clip.
    const drawnClips = async (): Promise<{ ids: string[], loaded: boolean }> => {
      const players = await shownPlayers(browser)
      return { ids: players.map(({ id }) => id), loaded: players.every(({ available, seconds }) => available && seconds !== null) }
    }
    const mediaElements = async (): Promise<number> => browser.execute(() => document.querySelectorAll('.cm-content :is(audio, video)').length)
    // Whether the clip `id` is paused; null when no player draws it.
    const clipPaused = async (id: string): Promise<boolean | null> => browser.execute((clipId: string) => {
      const player = Array.from(document.querySelectorAll('.cm-content .media-player'))
        .find((candidate) => candidate.querySelector('.media-player__id')?.textContent?.trim() === clipId)
      return player?.querySelector<HTMLMediaElement>('audio, video')?.paused ?? null
    }, id)
    // A scroll to the end of the list, again at each read: the list gets
    // its full height only as the rows near the end get their sizes.
    const endIsDrawn = async (): Promise<boolean> => {
      await browser.execute(() => {
        const list = document.querySelector<HTMLElement>('.cm-content .dez-asset-list')
        if (!list) throw new Error('endIsDrawn: .dez-asset-list not found')
        list.scrollTop = list.scrollHeight
      })
      const { ids: drawn, loaded } = await drawnClips()
      return loaded && drawn.includes(last) && !drawn.includes(first)
    }

    await pressToolChip(browser, 0)
    await waitForValue(browser, 'first rows', async () => {
      const { ids: drawn, loaded } = await drawnClips()
      return loaded && drawn.includes(firstVideo)
    }, true)
    const opened = await drawnClips()
    expect(opened.ids).toStrictEqual(ids.slice(0, opened.ids.length))
    expect(opened.ids.length).toBeLessThan(20)
    expect(await mediaElements()).toBeLessThan(20)
    expect(await problemCards(browser)).toStrictEqual([])

    // The video loops, so it still plays when the list is at its end. The
    // press goes to the center of its play button.
    await pointerClickAt(browser, await browser.execute((clipId: string) => {
      const player = Array.from(document.querySelectorAll('.cm-content .media-player'))
        .find((candidate) => candidate.querySelector('.media-player__id')?.textContent?.trim() === clipId)
      const video = player?.querySelector<HTMLVideoElement>('video')
      const rect = player?.querySelector('.media-player__play')?.getBoundingClientRect()
      if (!video || !rect) throw new Error(`no video or play button of the clip ${clipId}`)
      video.loop = true
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
    }, firstVideo))
    await waitForValue(browser, 'the video plays', () => clipPaused(firstVideo), false)

    await waitForValue(browser, 'the end of the list', endIsDrawn, true)
    expect(await clipPaused(firstVideo)).toBe(false)
    expect(await mediaElements()).toBeLessThan(20)
    expect(await problemCards(browser)).toStrictEqual([])

    // A paused clip far from the visible part frees its player.
    await browser.execute(() => {
      for (const media of document.querySelectorAll<HTMLMediaElement>('.cm-content :is(audio, video)')) media.pause()
    })
    await waitForValue(browser, 'the paused video', () => clipPaused(firstVideo), null)

    await pressToolChip(browser, 0)
    await waitForValue(browser, 'media elements after the close', mediaElements, 0)
    expect(await threadSections(browser)).toStrictEqual(thread)
  })

  it('compacts the conversation between two rounds of a reply, and the reply goes on from the notes', async () => {
    await newTab(browser)
    await pickModel(browser, PROVIDER.name, PROVIDER.modelName)
    const question = 'Which compact models are there?'
    await submit(browser, question)
    const first = await takeRequest(setup, CHAT_PATH, openAiChatBody(PROVIDER, [{ role: 'user', content: question }]))
    const call = openAiToolCall('call_1', 'model_list', { filter: 'compact' })
    sendToolCalls(first.reply, [call], { promptTokens: LARGE_TOKENS })

    // The next request of the reply is due for a compaction, so Dez asks
    // for the notes first. The reply runs meanwhile.
    const compaction = await takeRequest(setup, CHAT_PATH)
    expectCompactionRequest(compaction, [
      { role: 'user', content: question },
      { role: 'assistant', content: '', tool_calls: [call] },
      { role: 'tool', tool_call_id: 'call_1', content: toolResult(compaction, 'call_1') },
    ])
    await waitForValue(browser, '"Compacting…" in the bottom bar', showsCompacting, true)
    expect(await activeTabStreaming(browser)).toBe(true)
    sendChatText(compaction.reply, NOTES_ANSWER, { promptTokens: LARGE_TOKENS })

    // The notes take the place of the conversation, and the reply goes on
    // from them: its section is empty again, and the call is gone.
    const second = await takeRequest(setup, CHAT_PATH)
    expect(JSON.parse(second.body)).toStrictEqual(openAiChatBody(PROVIDER, [await notesMessage(question)]))
    const [notes, ...rest] = await threadSections(browser)
    expect(readCompactionTag(notes.text)?.count).toBe(1)
    expect(notes.text).toContain(NOTES_SUMMARY)
    expect(rest).toStrictEqual([{ role: 'user', text: question }, { role: 'agent', text: '' }])
    // The editor shows the new sections.
    await waitForValue(browser, 'pills after the compaction', pillRoles, [{ index: 0, role: 'agent' }, { index: 1, role: 'user' }, { index: 2, role: 'agent' }])
    expect(await firstSectionLook()).toStrictEqual(COMPACTED_LOOK)
    expect(await showsCompacting()).toBe(false)
    expect(await activeTabStreaming(browser)).toBe(true)

    // The view still follows the reply: an answer that is taller than the
    // editor keeps the view at its bottom.
    const answer = Array.from({ length: 120 }, (_, i) => `Line ${i + 1} of the answer.`).join('\n')
    startEventStream(second.reply)
    writeChatFrame(second.reply, { content: answer })
    await waitForValue(browser, 'answer in the editor', async () => (await editorDoc(browser)).includes(answer), true)
    // The follow scrolls in the frame after the change, and viewFromBottom
    // waits two frames: read it first, so that the scrollTop read comes
    // after the follow.
    expect(await viewFromBottom(browser), 'distance from the bottom').toBeLessThanOrEqual(AT_BOTTOM_PX)
    expect(await browser.execute(() => (document.querySelector('.cm-scroller')?.scrollTop ?? 0) > 0), 'the view scrolled').toBe(true)
    writeChatFrame(second.reply, { content: '' }, 'stop')
    second.reply.end('data: [DONE]\n\n')
    await waitForThread(browser, [notes, { role: 'user', text: question }, { role: 'agent', text: answer }, { role: 'user', text: '' }])
    expect(await misplacedLines(browser)).toStrictEqual([])
  })

  it('compacts a conversation that is too large before the first request of a new reply', async () => {
    const id = 'compaction-at-submit'
    const thread = await openLarge(id)

    await submit(browser, 'Go on.')
    const compaction = await takeRequest(setup, CHAT_PATH)
    expectCompactionRequest(compaction, [
      { role: 'user', content: thread[0].text },
      { role: 'assistant', content: thread[1].text },
      { role: 'user', content: 'Go on.' },
    ])
    await waitForValue(browser, '"Compacting…" in the bottom bar', showsCompacting, true)
    sendChatText(compaction.reply, NOTES_ANSWER, { promptTokens: LARGE_TOKENS + 1000 })

    // The first request of the reply holds the notes, the first message of
    // the user, and the new one.
    const request = await takeRequest(setup, CHAT_PATH)
    expect(JSON.parse(request.body)).toStrictEqual(openAiChatBody(PROVIDER, [await notesMessage(thread[0].text, 'Go on.')]))
    await sendChatReply(request.reply, 'the reader of the notes')
    const [notes] = await threadSections(browser)
    expect(readCompactionTag(notes.text)?.count).toBe(1)
    expect(notes.text).toContain(NOTES_SUMMARY)
    await waitForThread(browser, [notes, thread[0], { role: 'user', text: 'Go on.' }, { role: 'agent', text: replyText('the reader of the notes') }, { role: 'user', text: '' }])
    await waitForValue(browser, 'pills after the reply', pillRoles, [
      { index: 0, role: 'agent' },
      { index: 1, role: 'user' },
      { index: 2, role: 'user' },
      { index: 3, role: 'agent' },
      { index: 4, role: 'user' },
    ])
    expect(await firstSectionLook()).toStrictEqual(COMPACTED_LOOK)
    expect(await showsCompacting()).toBe(false)

    // The file holds the compaction, with the tokens that the provider
    // counted for the compaction request.
    await waitForValue(browser, 'saved compaction numbers', () => savedNumbers(id, /^(compactions|compacted-tokens)/), ['compactions: 1', `compacted-tokens: ${LARGE_TOKENS + 1000}`])
    expect((await savedLines(id))[3]).toBe(notes.text.split('\n')[0])
  })

  it('ends the reply with an error toast when the compaction request fails two times, and keeps the conversation', async () => {
    const thread = await openLarge('compaction-failure')

    await submit(browser, 'Go on.')
    // Dez sends a failed compaction request one more time.
    for (let tries = 1; tries <= 2; tries++) {
      const compaction = await takeRequest(setup, CHAT_PATH)
      compaction.reply.writeHead(500, { 'Content-Type': 'application/json' })
      compaction.reply.end(JSON.stringify({ error: { message: 'The mock server failed.' } }))
    }

    await waitForValue(browser, 'error toast', async () => (await openToasts(browser, 'error')).map((toast) => toast.title), ['Compaction failed'])
    await waitForValue(browser, 'streaming', () => activeTabStreaming(browser), false)
    expect(await threadSections(browser)).toStrictEqual([...thread.slice(0, 2), { role: 'user', text: 'Go on.' }])
    expect(await showsCompacting()).toBe(false)
    // A third request would come at once.
    await browser.pause(300)
    expect(setup.mock.hasWaitingRequest()).toBe(false)

    // Dez logs each failed request and the end of the reply.
    await resetConsoleErrors(browser)
    await click(browser, '.toast-card--error:not(.toast-card--closing) .toast-close')
    await waitForValue(browser, 'error toast closed', () => openToasts(browser, 'error'), [])
  })

  it('stops a compaction request with its reply, with no toast, and keeps the conversation', async () => {
    const thread = await openLarge('compaction-stop')

    await submit(browser, 'Go on.')
    const compaction = await takeRequest(setup, CHAT_PATH)
    await waitForValue(browser, '"Compacting…" in the bottom bar', showsCompacting, true)

    await pointerClick(browser, '.submit-button')
    await waitForValue(browser, 'request closed by the app', async () => compaction.closed, true)
    await waitForThread(browser, [...thread.slice(0, 2), { role: 'user', text: 'Go on.' }])
    expect(await showsCompacting()).toBe(false)
    // A stop is no failure: a second compaction request would come at once.
    await browser.pause(300)
    expect(setup.mock.hasWaitingRequest()).toBe(false)
  })

  // The conversation file holds a first compaction, whose notes have a
  // line for each of its two made images, and whose tag has a picture.
  it('deletes the file of a dropped intermediate image and the old picture copy, and keeps the file of a dropped image that the user saw', async () => {
    const { home } = setup.app
    const imagesDir = appFilePath(home, 'assets', 'generated', 'images')
    const viewsDir = appFilePath(home, 'assets', 'generated', 'views')
    const names = { draft: 'compaction-draft.png', seen: 'compaction-seen.png', sheet: 'compaction-old-sheet.png' }
    const draft = await writeTestFile(path.join(imagesDir, names.draft), KEPT_MADE_PNG)
    const seen = await writeTestFile(path.join(imagesDir, names.seen), MADE_PNG)
    await writeTestFile(path.join(viewsDir, names.sheet), SHEET_PNG)
    // The hidden mark is written out here, so that the spec does not take
    // it from the code under test: a call made the draft as a part of its
    // work, and the user saw it only in the panel of that call.
    const notes = compactionNotesText({
      summary: 'A fox for the user.',
      requirements: '',
      nextSteps: '',
      assets: [
        { id: 'a', kind: 'image', facts: 'PNG, 36x28', origin: 'made by the model_invoke job 1 of its reply: "A fox draft"', sentence: 'A draft of the fox.', byReply: false, text: `![${draft}](id=a|tool=model_invoke|hidden=j-aaaa)` },
        { id: 'b', kind: 'image', facts: 'PNG, 30x20', origin: 'made by the model_invoke job 2 of its reply: "A fox"', sentence: 'The fox.', byReply: false, text: `![${seen}](id=b|tool=model_invoke)` },
      ],
      unnamed: [],
      jobs: [],
      jobInputs: new Map(),
      cost: undefined,
    })
    const thread = await openCompacted('compaction-file-delete', [
      compactionSection(`${compactionTagText({ count: 1, lastId: 'b', pictures: [{ ...SHEET, file: names.sheet }] })}\n${notes}`),
      textSection('user', 'Make a fox.'),
      textSection('agent', 'The fox is done.'),
      textSection('user', ''),
    ], PROVIDER, { context: { tokens: LARGE_TOKENS, estimate: 0 } })

    await submit(browser, 'Now a wolf.')
    const compaction = await takeRequest(setup, CHAT_PATH)
    sendChatText(compaction.reply, '## Summary\nThe fox is done, and a wolf is next.\n\n## Assets\n@a: drop - The wolf needs no fox draft.\n@b: drop - The wolf needs no fox.\n')
    const request = await takeRequest(setup, CHAT_PATH)
    await sendChatReply(request.reply, 'the wolf')

    // The second compaction left both images out of the conversation.
    const [newNotes] = await threadSections(browser)
    expect(readCompactionTag(newNotes.text)).toMatchObject({ count: 2, dropped: 2, pictures: [] })
    expect([draft, seen].filter((file) => newNotes.text.includes(file))).toStrictEqual([])
    expect(await compactionChipCounts()).toStrictEqual(['2 dropped'])
    await waitForThread(browser, [newNotes, thread[1], { role: 'user', text: 'Now a wolf.' }, { role: 'agent', text: replyText('the wolf') }, { role: 'user', text: '' }])

    await waitForValue(browser, 'files of the two dropped images', async () => (await filesIn(imagesDir)).filter((name) => name === names.draft || name === names.seen), [names.seen])
    await waitForValue(browser, 'old picture copy', async () => (await filesIn(viewsDir)).includes(names.sheet), false)
  })

  // The answer keeps one made image of an earlier reply and drops the
  // image of the user. The other made image has no line, so it leaves the
  // conversation. The image of the user stays, in the section of the
  // carried assets.
  it('drops at the first compaction a made image of an earlier reply that the answer does not keep, and never an image of the user', async () => {
    const { home } = setup.app
    const madeDir = appFilePath(home, 'assets', 'generated', 'images')
    const names = { kept: 'compaction-first-kept.png', gone: 'compaction-first-gone.png' }
    const keptFile = await writeTestFile(path.join(madeDir, names.kept), KEPT_MADE_PNG)
    const goneFile = await writeTestFile(path.join(madeDir, names.gone), MADE_PNG)
    const photo = await writeTestFile(appFilePath(home, 'assets', 'images', 'compaction-first-photo.png'), CARRIED_PNG)
    const thread = await openSeeded('compaction-first-drop', [
      textSection('user', 'Make a fox.'),
      textSection('agent', `Two foxes.\n![${keptFile}](id=a)\n![${goneFile}](id=b)`),
      textSection('user', `Use this photo too:\n![${photo}](id=c)`),
      textSection('agent', 'Done.'),
      textSection('user', ''),
    ], PROVIDER, { context: { tokens: LARGE_TOKENS, estimate: 0 } })

    await submit(browser, 'Now a wolf.')
    const compaction = await takeRequest(setup, CHAT_PATH)
    sendChatText(compaction.reply, '## Summary\nThe foxes are done, and a wolf is next.\n\n## Assets\n@a: keep - The fox that the wolf meets.\n@c: drop - The photo is not needed.\n')
    const request = await takeRequest(setup, CHAT_PATH)
    await sendChatReply(request.reply, 'the wolf')

    const [notes, first, carried] = await threadSections(browser)
    expect(readCompactionTag(notes.text)).toMatchObject({ count: 1, dropped: 1 })
    expect([keptFile, goneFile].filter((file) => notes.text.includes(file))).toStrictEqual([keptFile])
    expect(first).toStrictEqual(thread[0])
    expect(carried.text.split('\n')).toStrictEqual([CARRIED_USER_ASSETS_LABEL, `![${photo}](id=c|kept=compaction)`])
    // The reply scrolled the editor to its end, and the editor draws no
    // chip far out of view.
    await browser.execute(() => {
      const scroller = document.querySelector('.cm-scroller')
      if (scroller) scroller.scrollTop = 0
    })
    await waitForValue(browser, 'compaction chip', () => toolChips(browser), [compactionChipView(['2 kept assets', '1 dropped'], false)])
    expect(await compactionChipCounts()).toStrictEqual(['2 kept assets', '1 dropped'])
    // The user saw the dropped image in the reply, so its file stays until
    // Delete Unused Files.
    expect((await filesIn(madeDir)).filter((name) => name === names.kept || name === names.gone)).toStrictEqual([names.gone, names.kept])
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
    const request = await takeRequest(setup, CHAT_PATH, openAiChatBody(PROVIDER, [
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
