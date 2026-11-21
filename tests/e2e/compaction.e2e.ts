import fs from 'node:fs'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Key } from 'webdriverio'
import { appTagLabel } from '../../src/model/chat/appTags'
import { CARRIED_USER_ASSETS_LABEL, COMPACTION_END_LINE, COMPACTION_MESSAGE_INTRO, COMPACTION_USER_MESSAGE_LABEL, compactionBlockText, compactionTagText, readCompactionBlock, type CompactionBlock } from '../../src/model/chat/compaction'
import { compactionNotesText, messageFence, notesFinalReply, notesMessageParts, notesMessages } from '../../src/model/chat/compactionNotes'
import { newMediaIds } from '../../src/model/chat/mediaIds'
import type { ShownPicture } from '../../src/model/chat/shownPictures'
import type { ConversationData, SectionData } from '../../src/model/persistence/types'
import { compactionInstruction } from '../../src/model/streams/compactionRequest'
import { shortDuration } from '../../src/view/thread/pillDuration'
import { ageApp, seedApp, shownAppCards, uiAppFiles } from './harness/apps'
import { anthropicChatBody, anthropicMarkedUser, openAiChatBody } from './harness/chatBody'
import { click, consoleErrors, movePointer, pointerClick, pointerClickAt, promptMessage, resetConsoleErrors, screenshotOnFailure, typeKeys, waitForValue } from './harness/dom'
import { linkedDropDir } from './harness/drops'
import { findDropdownOpen, findStatus, openFindWithQuery } from './harness/find'
import { appFilePath, conversationFilePath, filesIn, makeConversation, newFileIn, seedConversation, writeTestFile } from './harness/fixtures'
import { pasteImageReference, pngDataUrl, shownImages, solidPng, type ShownImage } from './harness/images'
import { clipTag, MP4_VIDEO, problemCards, shownPlayers, silentWav, tempClipTag, WEBM_VIDEO, type ShownPlayer } from './harness/media'
import { assetInView, flashedAssets, pressMention, recordFlashes } from './harness/mentions'
import { startMockProviderApp, takeRequest, type MockProviderApp } from './harness/mockProviderApp'
import { LARGE_TOKENS, mockChatPath, mockModelKey, openAiToolCall, replyText, requestMessages, sendAnthropicReply, sendChatReply, sendChatText, sendToolCalls, startEventStream, toolResult, writeChatFrame, writeUsage, type HeldRequest, type MockProvider } from './harness/mockServer'
import type { E2EBrowser } from './harness/session'
import { activeConversationId, activeTabStreaming, activeTabTitle, assetPartPoint, AT_BOTTOM_PX, docPos, editorCaret, editorDoc, focusEditor, misplacedLines, newTab, openToasts, pickModel, pillThinking, pressRolePill, savedPillLines, sbpCall, scrollEditorToTop, setCaret, submit, threadSections, viewFromBottom, waitForThread, type ThreadSection } from './harness/thread'
import { hiddenAssetNotes, hiddenPart, pressToolChip, toolChips, toolPanelPictures, type ToolChipView } from './harness/toolChips'

// Compaction, driven through the real app against a mock server in this
// process.
//
// A compacted conversation: its first section is the compaction section,
// an agent section that starts with the compaction block (the tag line,
// the notes, and the end line). These tests open a conversation file that
// holds one.
// - The editor shows an Agent pill first, in place of the tag line, and no
//   User pill above it. Two chips take the place of the other lines of the
//   block: the assets chip and the summary chip. Both start closed, and
//   stay as they are over the end of a stream. A relaunch shows them
//   closed.
// - The notes are no text of the editor: the panel of the summary chip
//   shows them in a read-only field, and Find does not match them. The
//   caret never goes into the block. Backspace after it keeps the block,
//   as the text after the block is the reply. Only a selection that holds
//   the block deletes it, which makes the first section a user section;
//   an undo brings the block back.
// - Each request starts with one user message: the notes, the pictures of
//   the tag, and the user messages right after the notes, with their
//   images. That message is the same in every later request.
// - A conversation of an older Dez, whose tag ends with `/>` and whose
//   notes run to the end of the section, opens with the same two chips and
//   sends the same message.
// - A save and a relaunch keep the section, its pill, and the compaction
//   numbers of the file header.
// - A new image gets an id after the `last-id` of the tag.
// - The assets of the block, and the kept assets of the section of the
//   carried assets of the user, show only in the panel of the assets chip,
//   with the pictures of the tag. The counts of the chip tell how many
//   assets the compaction kept and dropped. The trash and the Save of an
//   asset work in the panel, and the counts follow. A request sends a kept
//   image as its text only, unless the user names it with `@id`. A clip in
//   the panel plays by the role that its section has now.
//
// A compaction that runs: the mock tells that a request was near the
// context window of its model, or the conversation file tells it.
// - Before the next chat request of the reply (between two tool rounds,
//   or the first request after a submit), Dez sends the compaction
//   request: the request that was due, with the instruction of Dez as one
//   more user message. The bottom bar shows "Compacting…" meanwhile.
// - The notes of the answer take the place of the conversation, in the
//   tab, in the editor, and in the file, as a block with its end line, and
//   the reply goes on in the same section right after the block: one
//   Agent pill, with the thinking and the spinner of the reply, and no
//   User pill before the reply. A reply can compact two times.
//   The notes hold the messages of the user that the work needs word for
//   word: the first one, the middle ones that the answer keeps, and the
//   newest one, which the summary chip shows, each in a code fence, and
//   the tab keeps its title. The next request holds the notes with these
//   messages, each in a code fence, and their images: an image that a
//   message links goes as pixels, and no text holds a path. A middle
//   message that the answer drops leaves, and its image stays an asset.
// - A compaction request that fails two times ends the reply with an
//   error toast, and a stop ends it with none. Both keep the
//   conversation.
// - The first compaction already drops a made image of an earlier reply
//   that the answer does not keep, but never an image of the user. The
//   assets chip tells how many assets the compaction dropped.
// - A conversation in an old layout (kept user sections after the block,
//   or the reply in a section of its own) compacts again into the new
//   layout. A relaunch keeps the new layout, and it sends the same
//   messages.
// - Dez deletes the file of a dropped image that the user saw only in the
//   panel of a call, and the picture copies of the tag before. The file
//   of any other dropped image stays.
// - Each app that the conversation named keeps a line in the notes, and
//   the instruction of the compaction request lists it. Delete
//   Unreferenced Apps keeps an app that only that line names.
//
// One app session serves the whole file. The relaunch test reopens the
// conversation of the request test, and a conversation that compacted at
// a submit.

const PROVIDER: MockProvider = { id: 'compact', name: 'Compact Mock', modelId: 'compact-model', modelName: 'Compact Model' }
const CLAUDE: MockProvider = { id: 'claude', name: 'Claude Mock', modelId: 'claude-model', modelName: 'Claude Model', apiFormat: 'anthropic' }
// A model with thinking (`thinking: {}`), for the pill of a reply that
// compacts.
const THINKER: MockProvider = { id: 'thinker', name: 'Thinker Mock', modelId: 'think-model', modelName: 'Think Model' }
const MODEL_KEY = mockModelKey(PROVIDER)
const CHAT_PATH = mockChatPath(PROVIDER)

// The first line of the instruction of a compaction request.
const INSTRUCTION_START = compactionInstruction({ middleMessages: [], assetTable: '', apps: [], jobs: [], cost: undefined, tools: false }).split('\n')[0]
const NOTES_REQUIREMENTS = 'The user wants to go on with the task.'
// An answer to a compaction request: requirements, and no other part.
const NOTES_ANSWER = `## Requirements and decisions\n${NOTES_REQUIREMENTS}\n`
// The first line of the notes of the image conversation: a line that only
// the notes hold.
const IMAGE_NOTES_START = 'The user wants a film of a fox.'

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
// The image that a message of the user links: a file of the user out of
// every Dez folder.
const LINKED_PNG = solidPng(26, 18, [40, 200, 200])
// The screenshot that the user sends in a middle message, in place of the
// renders of the model.
const SHOT_PNG = solidPng(34, 26, [90, 90, 90])
const SHOT_IMAGE: ShownImage = { alt: 'compaction-middle-shot.png', width: 34, height: 26 }

const PLAIN_DATA = { count: 1, lastId: 'c', pictures: [] }
const PLAIN_TAG = compactionTagText(PLAIN_DATA)
// The tag of a conversation of an older Dez, whose notes run to the end
// of the section: the same tag, with `/>` at its end.
const OLD_TAG = `${PLAIN_TAG.slice(0, -1)}/>`
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
// The two images of the first message of the user in the notes.
const LINKED_USER_IMAGE: ShownImage = { alt: 'compaction-linked.png', width: 26, height: 18 }
const MESSAGE_IMAGE: ShownImage = { alt: 'compaction-message.png', width: 40, height: 24 }

/** The assets chip of the first compaction of a conversation, with
 *  `counts` (as "2 kept") and its panel open or not. */
function assetsChipView (counts: string[], open: boolean): ToolChipView {
  return {
    state: null,
    label: ['Compaction 1 assets', ...counts].join(', '),
    unrecognized: null,
    name: 'Compaction 1 assets',
    summary: null,
    stateWord: null,
    spinner: false,
    expanded: String(open),
    title: open ? 'Hide compaction assets' : 'Show compaction assets',
    open,
  }
}

/** The summary chip of the first compaction of a conversation, with its
 *  panel open or not. */
function summaryChipView (open: boolean): ToolChipView {
  return {
    state: null,
    label: null,
    unrecognized: null,
    name: 'Compaction 1 summary',
    summary: null,
    stateWord: null,
    spinner: false,
    expanded: String(open),
    title: open ? 'Hide compaction summary' : 'Show compaction summary',
    open,
  }
}

/** An assets chip with nothing to show: no panel, so no name for screen
 *  readers, no disclosure state, and no tooltip. */
const EMPTY_ASSETS_CHIP: ToolChipView = { ...assetsChipView([], false), label: null, expanded: null, title: '' }

/** The text at the place of the kept asset `name`, while the caret is on
 *  another line. */
function keptNote (name: string): { text: string, visible: boolean } {
  return { text: `Kept ${name}. Open the assets chip of the compaction to see it.`, visible: false }
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

  // Seeds and opens the conversation `id` with one reply, the text
  // `answer`, whose request held `LARGE_TOKENS` tokens: the first request
  // of its next reply is due for a compaction.
  async function openLarge (id: string, answer = 'An earlier answer.'): Promise<ThreadSection[]> {
    return openSeeded(id, [textSection('user', 'The task.'), textSection('agent', answer), textSection('user', '')], PROVIDER, {
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

  // Whether the pill before section `index` shows that its reply streams.
  async function pillStreams (index: number): Promise<boolean> {
    return browser.execute((sectionIndex: number) => document.querySelector(
      `.cm-content .dez-role-separator[data-section-index="${sectionIndex}"] .dez-role-separator__label[data-streaming]`,
    ) !== null, index)
  }

  // The compaction block of the first section of the tab, with its parts,
  // and the text of the reply after it.
  async function compactedSection (): Promise<{ block: string, read: CompactionBlock, reply: string }> {
    const [first] = await threadSections(browser)
    const read = first.role === 'agent' ? readCompactionBlock(first.text) : null
    if (read === null) throw new Error('compactedSection: the first section of the tab is no compaction section')
    return { block: first.text.slice(0, read.to), read, reply: first.text.slice(read.textFrom) }
  }

  // The one message of a request right after a compaction that kept no
  // image: the notes of the compaction block of the tab, with each message
  // part as its text in a code fence. The reply text after the block does
  // not change it. `messages` are the texts of the user parts: the
  // messages of the user that the notes keep, word for word. `reply` is
  // the text of the reply part: the reply right before the final message,
  // as the user saw it; null for notes with no reply part.
  async function notesMessage (messages: string[], reply: string | null = null): Promise<Record<string, unknown>> {
    const notes = (await compactedSection()).read.notes.trim()
    expect(notesMessages(notes).map(({ text }) => text)).toStrictEqual(messages)
    expect(notesFinalReply(notes)).toBe(reply)
    // A code fence takes the place of the start line and the end line of
    // a part.
    const content = notesMessageParts(notes).reduceRight((text, part) => {
      const fence = messageFence(part.text)
      return `${text.slice(0, part.partFrom)}${fence}\n${part.text}\n${fence}${text.slice(part.partTo)}`
    }, notes)
    return { role: 'user', content: `${COMPACTION_MESSAGE_INTRO}\n\n${content}` }
  }

  // The text of the field of notes in the panel of the compaction chip
  // `part`; null while the panel is closed or has no such field.
  async function chipNotes (part: 'assets' | 'summary'): Promise<string | null> {
    return browser.execute((wanted: string) => document.querySelector<HTMLTextAreaElement>(
      `.cm-content .dez-compaction-chip[data-part="${wanted}"] .dez-compaction-chip__notes textarea.dez-tool-call__result-text`,
    )?.value ?? null, part)
  }

  // The name and the open state of each chip, for a compaction whose
  // counts a test does not set.
  async function chipStates (): Promise<Array<{ name: string, open: boolean }>> {
    return (await toolChips(browser)).map(({ name, open }) => ({ name, open }))
  }

  // Whether a line of the editor shows `text`. The fields of the panels are
  // no lines, so this tells whether the notes are text of the editor.
  async function linesShow (text: string): Promise<boolean> {
    return browser.execute((wanted: string) => Array.from(document.querySelectorAll('.cm-content .cm-line'))
      .some((line) => (line.textContent ?? '').includes(wanted)), text)
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
    const notes = `${IMAGE_NOTES_START}\nThe fox: ![id=b](${madeFile})\nIt is red.`
    const kept = `Make a film of ![id=a](${keptFile})`
    const block = compactionBlockText({ count: 1, lastId: 'c', pictures: [SHEET] }, notes)
    return [compactionSection(block), textSection('user', kept), textSection('user', '')]
  }

  // The first message of each request of the image conversation after the
  // user sent `sent`: the notes with their image, the picture of the tag
  // after its label, then each user message with its image.
  function compactionMessage (sent: string): Record<string, unknown> {
    return {
      role: 'user',
      content: [
        { type: 'text', text: `${COMPACTION_MESSAGE_INTRO}\n\n${IMAGE_NOTES_START}\nThe fox: ![id=b](image)` },
        imagePart(MADE_PNG),
        { type: 'text', text: `\nIt is red.\n\n${SHEET.label}` },
        imagePart(SHEET_PNG),
        { type: 'text', text: `${USER_MESSAGE_START}Make a film of ![id=a](image)` },
        imagePart(KEPT_PNG),
        { type: 'text', text: `${USER_MESSAGE_START}${sent}` },
      ],
    }
  }

  // The text of each count at the end of the assets chip.
  async function compactionChipCounts (): Promise<string[]> {
    return browser.execute(() => Array.from(document.querySelectorAll('.cm-content .dez-compaction-chip__count'), (count) => count.textContent ?? ''))
  }

  // The files of the conversation with kept assets, and its sections: the
  // compaction section (its notes name the made image `b`, and keep the
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
      'The user wants a film of a fox.',
      `![id=b](${made})`,
      'The fox is red.',
      `![id=d|kept=compaction](${keptMade})`,
      'The film of the fox:',
      `<dez:video id="c" type="video/webm" src="${clip}" kept="compaction"/>`,
      'The fox sleeps.',
    ]
    return [
      compactionSection(compactionBlockText({ count: 1, lastId: 'e', pictures: [SHEET] }, notes.join('\n'))),
      textSection('user', 'Make a film of the fox.'),
      textSection('user', [CARRIED_USER_ASSETS_LABEL, `![id=a|kept=compaction](${keptUser})`, `![id=e](${carried})`].join('\n')),
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
        { type: 'text', text: `${COMPACTION_MESSAGE_INTRO}\n\nThe user wants a film of a fox.\n![id=b](image)` },
        imagePart(MADE_PNG),
        {
          type: 'text',
          text: `\nThe fox is red.\n![id=d|kept=compaction](image)\nThe film of the fox:\n<dez:video id="c" type="video/webm"/>\nThe fox sleeps.\n\n${SHEET.label}`,
        },
        imagePart(SHEET_PNG),
        { type: 'text', text: `${USER_MESSAGE_START}Make a film of the fox.\n\n${CARRIED_USER_ASSETS_LABEL}\n![id=a|kept=compaction](image)\n![id=e](image)` },
        imagePart(CARRIED_PNG),
        { type: 'text', text: `${USER_MESSAGE_START}Make it longer.${USER_MESSAGE_START}${sent}` },
        ...sentParts,
      ],
    }
  }

  beforeAll(async () => {
    setup = await startMockProviderApp(PROVIDER, {}, { moreProviders: [{ provider: CLAUDE }, { provider: THINKER, config: { thinking: {} } }] })
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

  it('shows an Agent pill and two closed chips in place of the compaction block, and keeps the caret after the block', async () => {
    const sections = await imageConversation()
    const thread = await openCompacted('compacted-look', sections)
    const blockEnd = thread[0].text.length

    await waitForValue(browser, 'pills', pills, [AGENT_PILL, userPill(1), userPill(2)])
    expect(await firstSectionLook()).toStrictEqual(COMPACTED_LOOK)
    // The made image of the notes is out of view with the block.
    await waitForValue(browser, 'shown images', () => shownImages(browser), [KEPT_USER_IMAGE])
    expect(await toolChips(browser)).toStrictEqual([assetsChipView(['1 kept', '1 picture'], false), summaryChipView(false)])
    expect(await linesShow(IMAGE_NOTES_START)).toBe(false)
    // The first pill is a pill as every other one: same left edge, same
    // height, and no line is drawn at a wrong place.
    const boxes = await pillBoxes()
    expect(new Set(boxes.lefts).size).toBe(1)
    expect(new Set(boxes.heights).size).toBe(1)
    expect(await misplacedLines(browser)).toStrictEqual([])

    // The section has no text after the block, so the first place of the
    // caret is the end of the block. Text that the user types there gets
    // its own line after the block.
    await focusEditor(browser)
    await browser.keys([Key.Control, Key.Home])
    expect(await editorCaret(browser)).toBe(blockEnd)
    await browser.keys([Key.ArrowUp])
    await browser.keys([Key.ArrowLeft])
    expect(await editorCaret(browser)).toBe(blockEnd)
    await typeKeys(browser, 'So: ')
    await waitForThread(browser, [{ role: 'agent', text: `${thread[0].text}\nSo: ` }, ...thread.slice(1)])
    expect(await linesShow('So:')).toBe(true)
    expect(await toolChips(browser)).toStrictEqual([assetsChipView(['1 kept', '1 picture'], false), summaryChipView(false)])
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

  // The tag of an older Dez ends with `/>`, and its notes run to the end of
  // the section. Dez reads that form as it is: the file keeps it, and the
  // request gets the message that the block form gives.
  it('opens a conversation of the old form with the two chips, and sends the same first message', async () => {
    const id = 'compacted-old-form'
    const thread = await openCompacted(id, [compactionSection(`${OLD_TAG}\nNotes of the work.`), textSection('user', 'The task.'), textSection('user', '')])
    await waitForValue(browser, 'pills', pills, [AGENT_PILL, userPill(1), userPill(2)])
    expect(await firstSectionLook()).toStrictEqual(COMPACTED_LOOK)
    expect(await toolChips(browser)).toStrictEqual([EMPTY_ASSETS_CHIP, summaryChipView(false)])
    expect(await linesShow('Notes of the work.')).toBe(false)

    await pressToolChip(browser, 1)
    await waitForValue(browser, 'summary in the open panel', () => chipNotes('summary'), 'Notes of the work.')
    expect(await toolChips(browser)).toStrictEqual([EMPTY_ASSETS_CHIP, summaryChipView(true)])

    await submit(browser, 'Go on.')
    const request = await takeRequest(setup, CHAT_PATH, openAiChatBody(PROVIDER, [
      { role: 'user', content: `${COMPACTION_MESSAGE_INTRO}\n\nNotes of the work.${USER_MESSAGE_START}The task.${USER_MESSAGE_START}Go on.` },
    ]))
    await sendChatReply(request.reply, 'the old form')
    await waitForThread(browser, [...thread.slice(0, 2), { role: 'user', text: 'Go on.' }, { role: 'agent', text: replyText('the old form') }, { role: 'user', text: '' }])
    // The end of the stream makes a new editor state, which keeps the open
    // panel.
    await waitForValue(browser, 'chips after the reply', () => toolChips(browser), [EMPTY_ASSETS_CHIP, summaryChipView(true)])
    expect(await chipNotes('summary')).toBe('Notes of the work.')
    await waitForValue(browser, 'saved tag line', async () => (await savedLines(id))[3], OLD_TAG)
  })

  it('keeps the block at a Backspace after it, deletes it with a selection that holds it, which makes the first section a user section, and an undo brings the block back', async () => {
    const block = compactionBlockText(PLAIN_DATA, 'Notes of the work.')
    const thread = await openCompacted('compacted-edit', [compactionSection(`${block}\nMore of the work.`), textSection('user', 'The task.')])
    await waitForValue(browser, 'pills', pills, [AGENT_PILL, userPill(1)])
    const { firstTop } = await pillBoxes()

    // The text after the block is the reply: a Backspace at its start
    // changes nothing.
    await focusEditor(browser)
    await browser.keys([Key.Control, Key.Home])
    expect(await editorCaret(browser)).toBe(block.length + 1)
    await browser.keys([Key.Backspace])
    await browser.pause(300)
    expect(await threadSections(browser)).toStrictEqual(thread)
    expect(await pills()).toStrictEqual([AGENT_PILL, userPill(1)])
    expect(await editorCaret(browser)).toBe(block.length + 1)

    // A selection from there to the start of the doc holds the block.
    await browser.keys([Key.Shift, Key.Control, Key.Home])
    await browser.keys([Key.Backspace])
    await waitForThread(browser, [{ role: 'user', text: 'More of the work.' }, thread[1]])
    await waitForValue(browser, 'pills with no block', pills, [userPill(1)])
    expect(await firstSectionLook()).toStrictEqual({ mark: null, userPill: true, tagText: false })
    expect(await toolChips(browser)).toStrictEqual([])
    expect(await misplacedLines(browser)).toStrictEqual([])
    // The User pill is where the Agent pill was.
    const userPillTop = await browser.execute(() => {
      const content = document.querySelector<HTMLElement>('.cm-content')
      return content ? Math.round(parseFloat(getComputedStyle(content, '::before').top)) : null
    })
    expect(userPillTop).toBe(firstTop)
    await waitForValue(browser, 'saved pills with no block', () => savedPillLines(setup.app.home, 'compacted-edit'), ['<dez:pill type="user"/>', '<dez:pill type="user"/>'])

    await browser.keys([Key.Control, 'z'])
    await waitForThread(browser, thread)
    await waitForValue(browser, 'pills after the undo', pills, [AGENT_PILL, userPill(1)])
    expect(await firstSectionLook()).toStrictEqual(COMPACTED_LOOK)
    expect(await toolChips(browser)).toStrictEqual([EMPTY_ASSETS_CHIP, summaryChipView(false)])
    expect(await misplacedLines(browser)).toStrictEqual([])
    await browser.keys([Key.Control, Key.Home])
    expect(await editorCaret(browser)).toBe(block.length + 1)
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

  it('shows the assets of the block and the kept assets only in the panel of the assets chip, with the pictures of the tag, and the notes in the panel of the summary chip', async () => {
    const thread = await openCompacted('compacted-kept-look', await keptConversation())
    const counts = ['4 kept', '1 picture']
    // The notes for people: each asset as its label, with no file path.
    const summary = ['The user wants a film of a fox.', '[image]', 'The fox is red.', '[image]', 'The film of the fox:', '[video]', 'The fox sleeps.'].join('\n')
    // Whether each player that the editor draws is in the panel of the
    // assets chip.
    const playersInPanel = async (): Promise<boolean[]> => browser.execute(() => Array.from(
      document.querySelectorAll('.cm-content .media-player'),
      (player) => player.closest('.dez-compaction-chip[data-part="assets"] .dez-tool-call__panel') !== null,
    ))

    // The image of the carried assets shows; the kept image of that
    // section shows its note. The block shows no asset and no note.
    await waitForValue(browser, 'shown images', () => shownImages(browser), [CARRIED_IMAGE])
    expect(await shownPlayers(browser)).toStrictEqual([])
    expect(await hiddenAssetNotes(browser)).toStrictEqual([keptNote('image @a')])
    expect(await toolChips(browser)).toStrictEqual([assetsChipView(counts, false), summaryChipView(false)])
    expect(await compactionChipCounts()).toStrictEqual(counts)
    expect(await toolPanelPictures(browser, 0)).toBeNull()
    expect(await chipNotes('summary')).toBeNull()
    expect(await misplacedLines(browser)).toStrictEqual([])

    // The panel shows the assets of the block and the kept image of the
    // carried assets in doc order, then the picture. The chip is above the
    // carried assets, so its images come first.
    await pressToolChip(browser, 0)
    await waitForValue(browser, 'open assets chip', () => toolChips(browser), [assetsChipView(counts, true), summaryChipView(false)])
    // virtua draws the rows as it measures them: wait for the fourth.
    await waitForValue(browser, 'kept assets part', () => hiddenPart(browser, 0), { heading: 'Kept assets', assets: 4, text: null })
    await waitForValue(browser, 'images with the panel open', () => shownImages(browser), [MADE_IMAGE, KEPT_MADE_IMAGE, KEPT_USER_IMAGE, CARRIED_IMAGE])
    await waitForValue(browser, 'player with the panel open', () => shownPlayers(browser), [KEPT_CLIP_PLAYER])
    expect(await playersInPanel()).toStrictEqual([true])
    await waitForValue(browser, 'picture with the panel open', () => toolPanelPictures(browser, 0), [{ label: SHEET.label, size: '64x16' }])
    // The notes have no part of the assets of the conversation.
    expect(await chipNotes('assets')).toBeNull()
    // A press keeps the caret where it was, so the note stays out of view.
    expect(await hiddenAssetNotes(browser)).toStrictEqual([keptNote('image @a')])

    await pressToolChip(browser, 1)
    await waitForValue(browser, 'summary in the open panel', () => chipNotes('summary'), summary)
    expect(await toolChips(browser)).toStrictEqual([assetsChipView(counts, true), summaryChipView(true)])
    expect(await linesShow('The fox sleeps.')).toBe(false)

    await pressToolChip(browser, 0)
    await pressToolChip(browser, 1)
    await waitForValue(browser, 'closed chips', () => toolChips(browser), [assetsChipView(counts, false), summaryChipView(false)])
    expect(await hiddenPart(browser, 0)).toBeNull()
    expect(await chipNotes('summary')).toBeNull()
    expect(await shownPlayers(browser)).toStrictEqual([])
    expect(await shownImages(browser)).toStrictEqual([CARRIED_IMAGE])
    expect(await misplacedLines(browser)).toStrictEqual([])
    expect(await threadSections(browser)).toStrictEqual(thread)
  })

  // The notes of the assets of the conversation show in the panel of the
  // assets chip, and every other part in the panel of the summary chip.
  // Find matches only the text of the editor.
  it('splits the notes between the two panels, and Find does not match them', async () => {
    const notes = ['## Summary', 'The fox is done.', '', '## Assets of the conversation', '@c: a clip of the fox.', '', '## Next steps', 'Make a wolf.'].join('\n')
    await openCompacted('compacted-notes-parts', [compactionSection(compactionBlockText(PLAIN_DATA, notes)), textSection('user', 'The fox sleeps.')])
    await waitForValue(browser, 'chips', () => toolChips(browser), [assetsChipView(['0 kept'], false), summaryChipView(false)])

    await pressToolChip(browser, 0)
    await waitForValue(browser, 'assets notes', () => chipNotes('assets'), '@c: a clip of the fox.')
    await pressToolChip(browser, 1)
    await waitForValue(browser, 'summary', () => chipNotes('summary'), '## Summary\nThe fox is done.\n\n## Next steps\nMake a wolf.')

    // "fox" is in the notes two times, and once in the user message.
    await focusEditor(browser)
    await openFindWithQuery(browser, 'fox')
    await waitForValue(browser, 'find status', () => findStatus(browser), '1 of 1')
    expect(await browser.execute(() => Array.from(document.querySelectorAll('.dez-find-match'), (match) => match.textContent ?? ''))).toStrictEqual(['fox'])
    await browser.keys([Key.Escape])
    await waitForValue(browser, 'find closed', () => findDropdownOpen(browser), false)
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

  // Only the compaction block and the section of the carried assets of the
  // user hide what the compaction keeps. A user can copy a kept line into
  // a later message, and there it is an image as every other one.
  it('shows a kept image at its place in a user message after a reply', async () => {
    const kept = await writeTestFile(appFilePath(setup.app.home, 'assets', 'images', 'compaction-kept.png'), KEPT_PNG)
    const reference = `![id=a|kept=compaction](${kept})`
    await openCompacted('compacted-kept-later', [
      compactionSection(compactionBlockText(PLAIN_DATA, `The user sent a fox.\n${reference}\nIt is red.`)),
      textSection('user', 'Make a film of the fox.'),
      textSection('agent', 'Which fox?'),
      textSection('user', `This one:\n${reference}`),
    ])

    await waitForValue(browser, 'shown images', () => shownImages(browser), [KEPT_USER_IMAGE])
    expect(await hiddenAssetNotes(browser)).toStrictEqual([])
    expect(await toolChips(browser)).toStrictEqual([assetsChipView(['1 kept'], false), summaryChipView(false)])
  })

  // A linked file plays only in a user section. The tag of the compaction
  // section has no end line, so its block runs to the end of the section.
  // Backspace at the start of the carried assets of the user joins them to
  // the compaction section, so they are in the block of an agent section:
  // the open panel shows the kept linked clip as a clip that does not play.
  // An undo makes it play again.
  it('plays a kept linked clip in the open panel only while its section is a user section', async () => {
    const linked = await writeTestFile(path.join(linkedDir, 'compaction-linked.webm'), WEBM_VIDEO)
    const notes = `${PLAIN_TAG}\nThe user sent a film.`
    const carried = [CARRIED_USER_ASSETS_LABEL, `<dez:video id="c" type="video/webm" src="${linked}" kept="compaction"/>`].join('\n')
    const thread = await openCompacted('compacted-kept-linked', [compactionSection(notes), textSection('user', carried), textSection('user', '')])

    await pressToolChip(browser, 0)
    await waitForValue(browser, 'player of the user section', () => shownPlayers(browser), [KEPT_CLIP_PLAYER])

    // The join keeps a line break after the block, as after every line
    // block.
    await focusEditor(browser)
    await setCaret(browser, await docPos(browser, CARRIED_USER_ASSETS_LABEL))
    await browser.keys([Key.Backspace])
    await waitForThread(browser, [{ role: 'agent', text: `${notes}\n${carried}` }, thread[2]])
    expect(await hiddenAssetNotes(browser)).toStrictEqual([])
    await waitForValue(browser, 'card of the agent section', () => problemCards(browser), [{ cause: 'gone', lines: ['This clip is no longer available.'] }])
    expect(await linesShow(CARRIED_USER_ASSETS_LABEL)).toBe(false)

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
    expect(await compactionChipCounts()).toStrictEqual(['130 kept'])

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

  // A mention of a kept asset after the block: a click opens the assets
  // chip, and the list scrolls to the row of the asset, which it draws only
  // then.
  it('opens the assets chip on a click on a mention of a far kept clip, and shows and flashes its row', async () => {
    const { home } = setup.app
    const wav = await writeTestFile(appFilePath(home, 'assets', 'generated', 'audio', 'compaction-mention.wav'), silentWav(1))
    const ids = newMediaIds([], 130)
    const last = ids[ids.length - 1]
    const tags = ids.map((id) => `<dez:audio id="${id}" type="audio/wav" src="${wav}" kept="compaction"/>`)
    const notes = [compactionTagText({ count: 1, lastId: last, pictures: [] }), 'The user made many clips.', ...tags].join('\n')
    const thread = await openCompacted('compacted-mention', [compactionSection(notes), textSection('user', `Play @${last} again.`), textSection('user', '')])
    expect(await compactionChipCounts()).toStrictEqual(['130 kept'])
    expect(await shownPlayers(browser)).toStrictEqual([])

    await recordFlashes(browser)
    await pressMention(browser, 0)
    await waitForValue(browser, 'the kept clip in view', () => assetInView(browser, last), true)
    expect(await flashedAssets(browser)).toStrictEqual([`player ${last}`])
    expect((await shownPlayers(browser)).map(({ id }) => id)).not.toContain(ids[0])
    expect(await threadSections(browser)).toStrictEqual(thread)

    await pressToolChip(browser, 0)
    await waitForValue(browser, 'players after the close', async () => (await shownPlayers(browser)).length, 0)
  })

  // The trash of an image and the Save of a clip work in the panel of the
  // assets chip as at their own place, and change the text of the block.
  it('saves a clip and trashes an image in the panel of the assets chip, and the counts follow', async () => {
    const { home } = setup.app
    const imagesDir = appFilePath(home, 'assets', 'generated', 'images')
    const videoDir = appFilePath(home, 'assets', 'generated', 'video')
    // The image is narrower than its toolbar, which hangs into the row of
    // the clip; the toolbar must still take the pointer there.
    const image = await writeTestFile(path.join(imagesDir, 'compaction-trash.png'), MADE_PNG)
    const clip = await tempClipTag(home, 'video', 'b', 'compaction-save.mp4', MP4_VIDEO)
    const notes = ['The fox:', `![id=a](${image})`, 'The film of the fox:', clip, 'The end.'].join('\n')
    await openCompacted('compacted-panel-actions', [compactionSection(compactionBlockText({ count: 1, lastId: 'b', pictures: [] }, notes)), textSection('user', '')])
    await waitForValue(browser, 'counts', compactionChipCounts, ['2 kept'])
    // The player of the temp copy, loaded: a click before the video has its
    // size can land on another control, as the player grows.
    const unsaved: ShownPlayer = { ...KEPT_CLIP_PLAYER, id: 'b', clock: 'Not saved', save: 'save' }
    const blockText = async (): Promise<string> => (await threadSections(browser))[0].text

    await pressToolChip(browser, 0)
    await waitForValue(browser, 'player in the panel', () => shownPlayers(browser), [unsaved])
    await waitForValue(browser, 'image in the panel', () => shownImages(browser), [{ alt: 'compaction-trash.png', width: 30, height: 20 }])

    // Save moves the temp copy into the folder of the saved clips, and the
    // tag in the block gets that file, with no end time.
    const videosBefore = await filesIn(videoDir)
    await pointerClick(browser, '.cm-content .media-player__save')
    const saved = path.join(videoDir, await newFileIn(browser, videoDir, videosBefore))
    await waitForValue(browser, 'saved tag in the block', async () => (await blockText()).includes(clipTag('video', { id: 'b', type: 'video/mp4', src: saved })), true)
    await waitForValue(browser, 'saved player', () => shownPlayers(browser), [{ ...unsaved, clock: null, save: 'saved' }])
    expect(await compactionChipCounts()).toStrictEqual(['2 kept'])

    // The trash asks first, then deletes the file and the reference.
    await movePointer(browser, await assetPartPoint(browser, '.dez-image', 0, '.dez-image__img'))
    await pointerClickAt(browser, await assetPartPoint(browser, '.dez-image', 0, '.dez-image__trash'))
    await waitForValue(browser, 'delete prompt', async () => await promptMessage(browser) !== null, true)
    await pointerClick(browser, '.confirm-btn--confirm')
    await waitForValue(browser, 'block after the trash', async () => (await blockText()).includes('![id=a]('), false)
    await waitForValue(browser, 'counts after the trash', compactionChipCounts, ['1 kept'])
    expect(await filesIn(imagesDir)).not.toContain('compaction-trash.png')
    expect(await hiddenPart(browser, 0)).toStrictEqual({ heading: 'Kept assets', assets: 1, text: null })
    expect(await shownImages(browser)).toStrictEqual([])
    expect(await shownPlayers(browser)).toStrictEqual([{ ...unsaved, clock: null, save: 'saved' }])
    // The block keeps its end line.
    const text = await blockText()
    expect(readCompactionBlock(text)).toMatchObject({ count: 1, textFrom: text.length })
    expect(text.endsWith(`\n${COMPACTION_END_LINE}`)).toBe(true)
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
    // from them, in the same section after the block: the call is gone.
    // The question is in the notes: no section of the user is left.
    const second = await takeRequest(setup, CHAT_PATH)
    expect(JSON.parse(second.body)).toStrictEqual(openAiChatBody(PROVIDER, [await notesMessage([question])]))
    const [firstSection, ...rest] = await threadSections(browser)
    const { block, read, reply } = await compactedSection()
    expect(read.count).toBe(1)
    expect(block).toContain(NOTES_REQUIREMENTS)
    // A new compaction writes the block form: the notes end at the end
    // line, and the reply has no text yet.
    expect(block.endsWith(`\n${COMPACTION_END_LINE}`)).toBe(true)
    expect([firstSection.text, reply]).toStrictEqual([`${block}\n`, ''])
    expect(rest).toStrictEqual([])
    // The editor shows the new section: one Agent pill, the pill of the
    // reply, with its spinner, and the two chips closed.
    await waitForValue(browser, 'pills after the compaction', pillRoles, [{ index: 0, role: 'agent' }])
    expect((await pillThinking(browser, 0))?.slot).toBe('spinner')
    expect(await firstSectionLook()).toStrictEqual(COMPACTED_LOOK)
    expect(await chipStates()).toStrictEqual([{ name: 'Compaction 1 assets', open: false }, { name: 'Compaction 1 summary', open: false }])
    expect(await linesShow(NOTES_REQUIREMENTS)).toBe(false)
    expect(await showsCompacting()).toBe(false)
    expect(await activeTabStreaming(browser)).toBe(true)
    // The open summary panel shows the notes of the new compaction, with
    // the message of the user.
    await pressToolChip(browser, 1)
    await waitForValue(browser, 'summary in the open panel', async () => {
      const shown = await chipNotes('summary')
      return shown !== null && shown.includes(NOTES_REQUIREMENTS) && shown.includes(question)
    }, true)

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
    await waitForThread(browser, [{ role: 'agent', text: `${block}\n${answer}` }, { role: 'user', text: '' }])
    // The User pill comes after the reply, with the caret in its section.
    // The editor draws no pill far out of view: the Agent pill is at the
    // top of the long answer.
    expect(await pillRoles()).toStrictEqual([{ index: 1, role: 'user' }])
    expect(await editorCaret(browser)).toBe((await editorDoc(browser)).length)
    expect(await misplacedLines(browser)).toStrictEqual([])
    // The end of the reply makes a new editor state, which keeps the open
    // panel. The editor draws no chip far out of view, so scroll up first.
    await scrollEditorToTop(browser)
    await waitForValue(browser, 'chips after the reply', chipStates, [{ name: 'Compaction 1 assets', open: false }, { name: 'Compaction 1 summary', open: true }])
    expect((await pillRoles())[0]).toStrictEqual({ index: 0, role: 'agent' })
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

    // The first request of the reply holds the notes, with the first
    // message of the user and the new one in them.
    const request = await takeRequest(setup, CHAT_PATH)
    expect(JSON.parse(request.body)).toStrictEqual(openAiChatBody(PROVIDER, [await notesMessage([thread[0].text, 'Go on.'], thread[1].text)]))
    await sendChatReply(request.reply, 'the reader of the notes')
    const { block, read } = await compactedSection()
    expect(read.count).toBe(1)
    expect(block).toContain(NOTES_REQUIREMENTS)
    // The reply is in the section of the block, and the caret is in the
    // user section after it.
    await waitForThread(browser, [{ role: 'agent', text: `${block}\n${replyText('the reader of the notes')}` }, { role: 'user', text: '' }])
    await waitForValue(browser, 'pills after the reply', pillRoles, [{ index: 0, role: 'agent' }, { index: 1, role: 'user' }])
    expect(await editorCaret(browser)).toBe((await editorDoc(browser)).length)
    expect(await firstSectionLook()).toStrictEqual(COMPACTED_LOOK)
    expect(await showsCompacting()).toBe(false)

    // The file holds the compaction, with the tokens that the provider
    // counted for the compaction request.
    await waitForValue(browser, 'saved compaction numbers', () => savedNumbers(id, /^(compactions|compacted-tokens)/), ['compactions: 1', `compacted-tokens: ${LARGE_TOKENS + 1000}`])
    expect((await savedLines(id))[3]).toBe(block.split('\n')[0])
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

  // A compaction takes the tags and the calls of the apps out of the
  // conversation. Without its line in the notes, no text would name the
  // app, and Delete Unreferenced Apps would delete it.
  it('keeps a line in the notes for each app that the conversation named, and Delete Unreferenced Apps keeps that app', async () => {
    const appsDir = appFilePath(setup.app.home, 'apps')
    const board = { name: 'compaction-board', description: 'A board of the foxes.', kind: 'ui' } as const
    const spare = 'compaction-spare'
    await seedApp(appsDir, board, uiAppFiles(''))
    await seedApp(appsDir, { name: spare, description: 'An app of no conversation.', kind: 'script' }, { 'main.ts': 'export default () => "spare"\n' })
    // Delete Unreferenced Apps takes no app with a new file.
    for (const name of [board.name, spare]) await ageApp(appsDir, name, 60 * 60 * 1000)
    const appLine = `/apps/${board.name} | ${board.kind} | ${board.description}`
    const appLines = (text: string): string[] => text.split('\n').filter((line) => line.startsWith('/apps/'))
    // The folders of the apps that Delete Unreferenced Apps would delete
    // now.
    const unusedApps = async (): Promise<string[]> => browser.execute(async () => {
      const sbp = Reflect.get(window, 'sbp') as (selector: string, kind: 'apps', onProgress: () => void) => Promise<{ files: Array<{ path: string }> }>
      const { files } = await sbp('dez.controller/unusedFiles/find', 'apps', () => {})
      return files.map(({ path }) => path)
    })

    const id = 'compaction-apps'
    const thread = await openLarge(id, `The board of the foxes:\n<dez:app name="${board.name}"/>`)
    await waitForValue(browser, 'card of the app', async () => (await shownAppCards(browser)).map(({ app }) => app), [board.name])
    expect(await unusedApps()).toStrictEqual([`apps/${spare}`])

    await submit(browser, 'Go on.')
    const compaction = await takeRequest(setup, CHAT_PATH)
    const { messages } = JSON.parse(compaction.body) as { messages: Array<{ content: string }> }
    expect(appLines(messages.at(-1)?.content ?? '')).toStrictEqual([appLine])
    sendChatText(compaction.reply, NOTES_ANSWER, { promptTokens: LARGE_TOKENS + 1000 })

    const request = await takeRequest(setup, CHAT_PATH)
    // The notes quote the reply before "Go on." with a label for its app.
    expect(JSON.parse(request.body)).toStrictEqual(openAiChatBody(PROVIDER, [await notesMessage([thread[0].text, 'Go on.'], `The board of the foxes:\n${appTagLabel(board.name)}`)]))
    await sendChatReply(request.reply, 'the reader of the notes')
    const { block, read } = await compactedSection()
    await waitForThread(browser, [{ role: 'agent', text: `${block}\n${replyText('the reader of the notes')}` }, { role: 'user', text: '' }])
    // The tag left with the text: only the line of the notes names the
    // app now.
    expect(block).not.toContain('<dez:app')
    expect(appLines(read.notes)).toStrictEqual([appLine])
    // The scan reads the file of the conversation, so it runs after the
    // save.
    await waitForValue(browser, 'saved compaction', () => savedNumbers(id, /^compactions/), ['compactions: 1'])
    expect(await unusedApps()).toStrictEqual([`apps/${spare}`])
  })

  // The conversation file holds a first compaction in the old layout: a
  // kept user section after the block. Its notes have a line for each of
  // its two made images, and its tag has a picture. The second compaction
  // writes the new layout.
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
      requirements: 'A fox for the user.',
      assets: [
        { id: 'a', kind: 'image', facts: 'PNG, 36x28', origin: 'made by the model_invoke job 1 of its reply: "A fox draft"', sentence: 'A draft of the fox.', byReply: false, text: `![id=a|tool=model_invoke|hidden=j-aaaa](${draft})` },
        { id: 'b', kind: 'image', facts: 'PNG, 30x20', origin: 'made by the model_invoke job 2 of its reply: "A fox"', sentence: 'The fox.', byReply: false, text: `![id=b|tool=model_invoke](${seen})` },
      ],
      unnamed: [],
      apps: [],
      firstMessage: null,
      middleMessages: [],
      leftOutMessages: 0,
      finalMessage: null,
      finalReply: null,
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
    // The first message of the old layout and the new message are in the
    // notes now.
    expect(JSON.parse(request.body)).toStrictEqual(openAiChatBody(PROVIDER, [await notesMessage([thread[1].text, 'Now a wolf.'], thread[2].text)]))
    await sendChatReply(request.reply, 'the wolf')

    // The second compaction left both images out of the conversation, and
    // the reply follows its block.
    const { block, read } = await compactedSection()
    expect(read).toMatchObject({ count: 2, dropped: 2, pictures: [] })
    expect([draft, seen].filter((file) => block.includes(file))).toStrictEqual([])
    expect(await compactionChipCounts()).toStrictEqual(['0 kept', '2 dropped'])
    await waitForThread(browser, [{ role: 'agent', text: `${block}\n${replyText('the wolf')}` }, { role: 'user', text: '' }])

    await waitForValue(browser, 'files of the two dropped images', async () => (await filesIn(imagesDir)).filter((name) => name === names.draft || name === names.seen), [names.seen])
    await waitForValue(browser, 'old picture copy', async () => (await filesIn(viewsDir)).includes(names.sheet), false)
  })

  // The answer keeps one made image of an earlier reply and drops the
  // image of the user. The other made image has no line, so it leaves the
  // conversation. The answer drops the middle message of the user, so it
  // leaves too, but its image stays, with its line in the notes.
  it('drops at the first compaction a made image of an earlier reply that the answer does not keep, and never an image of the user', async () => {
    const { home } = setup.app
    const madeDir = appFilePath(home, 'assets', 'generated', 'images')
    const names = { kept: 'compaction-first-kept.png', gone: 'compaction-first-gone.png' }
    const keptFile = await writeTestFile(path.join(madeDir, names.kept), KEPT_MADE_PNG)
    const goneFile = await writeTestFile(path.join(madeDir, names.gone), MADE_PNG)
    const photo = await writeTestFile(appFilePath(home, 'assets', 'images', 'compaction-first-photo.png'), CARRIED_PNG)
    const thread = await openSeeded('compaction-first-drop', [
      textSection('user', 'Make a fox.'),
      textSection('agent', `Two foxes.\n![id=a](${keptFile})\n![id=b](${goneFile})`),
      textSection('user', `Use this photo too:\n![id=c](${photo})`),
      textSection('agent', 'Done.'),
      textSection('user', ''),
    ], PROVIDER, { context: { tokens: LARGE_TOKENS, estimate: 0 } })

    await submit(browser, 'Now a wolf.')
    const compaction = await takeRequest(setup, CHAT_PATH)
    sendChatText(compaction.reply, '## Summary\nThe foxes are done, and a wolf is next.\n\n## Middle messages\nm1: drop\n\n## Assets\n@a: keep - The fox that the wolf meets.\n@c: drop - The photo is not needed.\n')
    const request = await takeRequest(setup, CHAT_PATH)
    await sendChatReply(request.reply, 'the wolf')

    await waitForValue(browser, 'reply after the notes', async () => (await compactedSection()).reply, replyText('the wolf'))
    await waitForThread(browser, [(await threadSections(browser))[0], { role: 'user', text: '' }])
    const { block, read } = await compactedSection()
    expect(read).toMatchObject({ count: 1, dropped: 1 })
    expect([keptFile, goneFile].filter((file) => block.includes(file))).toStrictEqual([keptFile])
    expect(notesMessages(read.notes).map(({ text }) => text)).toStrictEqual([thread[0].text, 'Now a wolf.'])
    expect(block).toContain(`\n![id=c|kept=compaction](${photo})\n@c `)
    // The reply scrolled the editor to its end, and the editor draws no
    // chip far out of view.
    await scrollEditorToTop(browser)
    await waitForValue(browser, 'compaction chips', () => toolChips(browser), [assetsChipView(['2 kept', '1 dropped'], false), summaryChipView(false)])
    expect(await compactionChipCounts()).toStrictEqual(['2 kept', '1 dropped'])
    // The user saw the dropped image in the reply, so its file stays until
    // Delete Unreferenced Files.
    expect((await filesIn(madeDir)).filter((name) => name === names.kept || name === names.gone)).toStrictEqual([names.gone, names.kept])
  })

  // The first message of the user holds a pasted image and a linked one: a
  // file of the user out of every Dez folder (linkedFiles.ts). The tag of
  // the block lists the linked path, so the reference still counts there.
  it('keeps the first and the newest message of the user in the notes with their images, and the title of the tab', async () => {
    const photo = await writeTestFile(appFilePath(setup.app.home, 'assets', 'images', 'compaction-message.png'), KEPT_PNG)
    const linked = await writeTestFile(path.join(linkedDir, 'compaction-linked.png'), LINKED_PNG)
    const first = `Film ![id=a](${linked}) and ![id=b](${photo})`
    await openSeeded('compaction-messages', [
      textSection('user', first),
      textSection('agent', 'An earlier answer.'),
      textSection('user', ''),
    ], PROVIDER, { context: { tokens: LARGE_TOKENS, estimate: 0 } })

    await submit(browser, 'Go on.')
    const compaction = await takeRequest(setup, CHAT_PATH)
    sendChatText(compaction.reply, NOTES_ANSWER)

    // One user message: the notes, with the two messages and the reply
    // between them word for word in code fences, and each image right
    // after its reference. No text holds a path.
    const request = await takeRequest(setup, CHAT_PATH)
    const notes = await compactedSection()
    expect(notes.read.linked).toStrictEqual([linked])
    const text = notes.read.notes.trim()
    const [firstPart, replyPart, newestPart] = notesMessageParts(text)
    expect([firstPart.text, replyPart.text, newestPart.text]).toStrictEqual([first, 'An earlier answer.', 'Go on.'])
    const fence = messageFence(first)
    expect(JSON.parse(request.body)).toStrictEqual(openAiChatBody(PROVIDER, [{
      role: 'user',
      content: [
        { type: 'text', text: `${COMPACTION_MESSAGE_INTRO}\n\n${text.slice(0, firstPart.partFrom)}${fence}\nFilm ![id=a](image)` },
        imagePart(LINKED_PNG),
        { type: 'text', text: ' and ![id=b](image)' },
        imagePart(KEPT_PNG),
        { type: 'text', text: `\n${fence}${text.slice(firstPart.partTo, replyPart.partFrom)}${fence}\nAn earlier answer.\n${fence}${text.slice(replyPart.partTo, newestPart.partFrom)}${fence}\nGo on.\n${fence}${text.slice(newestPart.partTo)}` },
      ],
    }]))
    expect(request.body).not.toContain(linkedDir)
    expect(request.body).not.toContain(setup.app.home)
    await sendChatReply(request.reply, 'the film')

    // One Agent pill for the notes and the reply, no User pill before the
    // reply, and the title still tells the first message.
    await waitForThread(browser, [{ role: 'agent', text: `${notes.block}\n${replyText('the film')}` }, { role: 'user', text: '' }])
    await waitForValue(browser, 'pills after the reply', pillRoles, [{ index: 0, role: 'agent' }, { index: 1, role: 'user' }])
    expect(await activeTabTitle(browser)).toBe('Film [image] and [image]')

    // The summary chip shows the two messages, and the assets chip shows
    // the images of the first one, also the linked one.
    await scrollEditorToTop(browser)
    await pressToolChip(browser, 1)
    await waitForValue(browser, 'messages in the summary panel', async () => {
      const shown = await chipNotes('summary')
      return shown !== null && shown.includes('Film [image] and [image]') && shown.includes('Go on.')
    }, true)
    await pressToolChip(browser, 0)
    await waitForValue(browser, 'images in the assets panel', () => shownImages(browser), [LINKED_USER_IMAGE, MESSAGE_IMAGE])
  })

  // The answer keeps the middle message with the instruction of the user
  // and drops the "ok", and it drops the render that the user rejected.
  // The kept message and its image go in a code fence; the "ok" leaves,
  // and the notes tell that one message is left out.
  it('keeps the middle messages of the user that the answer keeps, each in a code fence, and leaves out the others', async () => {
    const { home } = setup.app
    const shot = await writeTestFile(appFilePath(home, 'assets', 'images', SHOT_IMAGE.alt), SHOT_PNG)
    const render = await writeTestFile(appFilePath(home, 'assets', 'generated', 'images', 'compaction-middle-render.png'), MADE_PNG)
    const instruction = `For the middle part use my screenshot, not the renders:\n![id=a](${shot})`
    await openSeeded('compaction-middle', [
      textSection('user', 'Make a short film in three parts.'),
      textSection('agent', 'A plan.'),
      textSection('user', instruction),
      textSection('agent', `A render of the middle part.\n![id=b](${render})`),
      textSection('user', 'ok'),
      textSection('agent', 'Fine.'),
      textSection('user', ''),
    ], PROVIDER, { context: { tokens: LARGE_TOKENS, estimate: 0 } })

    await submit(browser, 'Now the end part.')
    const compaction = await takeRequest(setup, CHAT_PATH)
    // The instruction lists the start of each middle message, after the
    // form of a line ("m1: keep|drop").
    const start = 'm1: "For the middle part use my screenshot, not the renders: '
    const list = String(requestMessages(compaction).at(-1)?.content).split('\n').filter((line) => /^m\d+: "/.test(line))
    expect(list.map((line) => line.slice(0, start.length))).toStrictEqual([start, 'm2: "ok"'])
    sendChatText(compaction.reply, '## Requirements and decisions\nThe film has three parts.\n\n## Middle messages\nm1: keep\nm2: drop\n\n## Assets\n@b: drop - The user rejected the renders.\n')

    // The next request quotes the first, the kept middle, and the final
    // message, and the reply right before the final one ("Fine."), each in
    // a code fence, and the image of the middle message right after its
    // reference, in its fence.
    const request = await takeRequest(setup, CHAT_PATH)
    const { block, read } = await compactedSection()
    const text = read.notes.trim()
    const [first, middle, pairReply, final] = notesMessageParts(text)
    expect(notesMessageParts(text).map((part) => [part.role, part.text])).toStrictEqual([
      ['user', 'Make a short film in three parts.'],
      ['user', instruction],
      ['agent', 'Fine.'],
      ['user', 'Now the end part.'],
    ])
    const fence = messageFence(instruction)
    expect(JSON.parse(request.body)).toStrictEqual(openAiChatBody(PROVIDER, [{
      role: 'user',
      content: [
        { type: 'text', text: `${COMPACTION_MESSAGE_INTRO}\n\n${text.slice(0, first.partFrom)}${fence}\n${first.text}\n${fence}${text.slice(first.partTo, middle.partFrom)}${fence}\nFor the middle part use my screenshot, not the renders:\n![id=a](image)` },
        imagePart(SHOT_PNG),
        { type: 'text', text: `\n${fence}${text.slice(middle.partTo, pairReply.partFrom)}${fence}\nFine.\n${fence}${text.slice(pairReply.partTo, final.partFrom)}${fence}\nNow the end part.\n${fence}${text.slice(final.partTo)}` },
      ],
    }]))
    await sendChatReply(request.reply, 'the end part')
    await waitForValue(browser, 'reply after the notes', async () => (await compactedSection()).reply, replyText('the end part'))

    // The render left the conversation; the screenshot stays.
    expect(read).toMatchObject({ count: 1, dropped: 1 })
    expect([shot, render].filter((file) => block.includes(file))).toStrictEqual([shot])

    // The summary chip shows the three kinds of message, each kept one in
    // a code fence, and tells that one message is left out. Under the
    // heading of the final message pair, the reply comes before the final
    // message, each in a code fence. The assets chip shows the screenshot
    // and no render.
    await scrollEditorToTop(browser)
    await pressToolChip(browser, 1)
    await waitForValue(browser, 'summary panel', async () => (await chipNotes('summary')) !== null, true)
    const shown = await chipNotes('summary') ?? ''
    expect(shown).toContain('## User messages\n\n### First message\n\n```\nMake a short film in three parts.\n```')
    expect(shown).toContain('### Relevant middle messages\n\nDez left out 1 other message of the user here')
    expect(shown).toContain('```\nFor the middle part use my screenshot, not the renders:\n')
    const pair = ['### Final message pair\n\n', '```\nFine.\n```', '```\nNow the end part.\n```'].map((piece) => shown.indexOf(piece))
    expect(pair.filter((at) => at < 0)).toStrictEqual([])
    expect(pair).toStrictEqual([...pair].sort((a, b) => a - b))
    expect(shown).not.toContain('```\nok\n```')
    await pressToolChip(browser, 0)
    await waitForValue(browser, 'images in the assets panel', () => shownImages(browser), [SHOT_IMAGE])
  })

  // An older Dez wrote the reply after a compaction as a section of its
  // own, after the section of the block. Such a conversation sends as it
  // is, and its next compaction writes one section.
  it('sends and compacts a conversation whose reply after the notes is a section of its own', async () => {
    await openCompacted('compacted-own-reply', [
      compactionSection(compactionBlockText(PLAIN_DATA, 'Notes of the work.')),
      textSection('agent', 'The reply after the notes.'),
      textSection('user', ''),
    ], PROVIDER, { context: { tokens: LARGE_TOKENS, estimate: 0 } })
    await waitForValue(browser, 'pills', pills, [AGENT_PILL, { index: 1, role: 'agent', model: null, time: null }, userPill(2)])
    expect(await firstSectionLook()).toStrictEqual(COMPACTED_LOOK)

    await submit(browser, 'Go on.')
    const compaction = await takeRequest(setup, CHAT_PATH)
    expectCompactionRequest(compaction, [
      { role: 'user', content: `${COMPACTION_MESSAGE_INTRO}\n\nNotes of the work.` },
      { role: 'assistant', content: 'The reply after the notes.' },
      { role: 'user', content: 'Go on.' },
    ])
    sendChatText(compaction.reply, NOTES_ANSWER)

    const request = await takeRequest(setup, CHAT_PATH)
    expect(JSON.parse(request.body)).toStrictEqual(openAiChatBody(PROVIDER, [await notesMessage(['Go on.'])]))
    await sendChatReply(request.reply, 'the new layout')
    const { block, read } = await compactedSection()
    expect(read.count).toBe(2)
    await waitForThread(browser, [{ role: 'agent', text: `${block}\n${replyText('the new layout')}` }, { role: 'user', text: '' }])
    await waitForValue(browser, 'pills after the reply', pillRoles, [{ index: 0, role: 'agent' }, { index: 1, role: 'user' }])
  })

  // The pill of the block is the pill of the reply: it streams, and it
  // shows the thinking of the rounds after the newest compaction. The
  // thinking from before a compaction goes with the rounds that it
  // replaces. The second compaction of a reply replaces the block of the
  // first one and the rounds after it.
  it('compacts one reply two times under one Agent pill, which shows the spinner and the thinking of the reply', async () => {
    const chatPath = mockChatPath(THINKER)
    await newTab(browser)
    await pickModel(browser, THINKER.name, THINKER.modelName)
    const question = 'Which models think?'
    await submit(browser, question)
    const first = await takeRequest(setup, chatPath)
    sendToolCalls(first.reply, [openAiToolCall('call_1', 'model_list', { filter: 'think' })], { thinking: 'A plan before the notes.', promptTokens: LARGE_TOKENS })

    const firstCompaction = await takeRequest(setup, chatPath)
    sendChatText(firstCompaction.reply, NOTES_ANSWER, { promptTokens: LARGE_TOKENS })

    // The reply goes on after the block, with no thinking yet: the pill
    // shows the spinner.
    const second = await takeRequest(setup, chatPath)
    expect(requestMessages(second)).toStrictEqual([await notesMessage([question])])
    await waitForValue(browser, 'pills after the first compaction', pillRoles, [{ index: 0, role: 'agent' }])
    expect((await pillThinking(browser, 0))?.slot).toBe('spinner')
    expect(await pillStreams(0)).toBe(true)

    // The thinking of the next round shows on the same pill.
    const plan = 'A plan after the notes.'
    startEventStream(second.reply)
    writeChatFrame(second.reply, { reasoning_content: plan })
    await waitForValue(browser, 'thinking on the pill', async () => (await pillThinking(browser, 0))?.slot ?? null, 'disclosure')
    await pressRolePill(browser, 0, '.dez-role-separator__disclosure')
    await waitForValue(browser, 'open thinking panel', async () => (await pillThinking(browser, 0))?.panelText ?? null, plan)
    expect(await pillStreams(0)).toBe(true)
    // A small count after the compaction: the next compaction is due only
    // at a large one.
    const secondCall = openAiToolCall('call_2', 'model_list', { filter: 'plan' })
    writeChatFrame(second.reply, { tool_calls: [{ index: 0, ...secondCall }] }, 'tool_calls')
    writeUsage(second.reply, { promptTokens: 20_000 })
    second.reply.end('data: [DONE]\n\n')

    // The chip of the call comes after the two chips of the compaction.
    const third = await takeRequest(setup, chatPath)
    expect(requestMessages(third)).toStrictEqual([
      await notesMessage([question]),
      { role: 'assistant', content: '', tool_calls: [secondCall], reasoning_content: plan },
      { role: 'tool', tool_call_id: 'call_2', content: toolResult(third, 'call_2') },
    ])
    await waitForValue(browser, 'chips of the reply', chipStates, [
      { name: 'Compaction 1 assets', open: false },
      { name: 'Compaction 1 summary', open: false },
      { name: 'model_list', open: false },
    ])
    const thirdCall = openAiToolCall('call_3', 'model_list', { filter: 'more' })
    sendToolCalls(third.reply, [thirdCall], { promptTokens: LARGE_TOKENS })

    // The second compaction request is the request that was due, with the
    // instruction at its end.
    const secondCompaction = await takeRequest(setup, chatPath)
    const compactionMessages = requestMessages(secondCompaction)
    expect(compactionMessages.slice(0, -1)).toStrictEqual([
      ...requestMessages(third),
      { role: 'assistant', content: '', tool_calls: [thirdCall] },
      { role: 'tool', tool_call_id: 'call_3', content: toolResult(secondCompaction, 'call_3') },
    ])
    expect(String(compactionMessages.at(-1)?.content).startsWith(INSTRUCTION_START)).toBe(true)
    const secondSummary = 'The models that think are listed.'
    sendChatText(secondCompaction.reply, `## Summary\n${secondSummary}\n`, { promptTokens: LARGE_TOKENS })

    // The new block takes the place of the old one and of the rounds after
    // it. The thinking of those rounds goes with them.
    const last = await takeRequest(setup, chatPath)
    expect(requestMessages(last)).toStrictEqual([await notesMessage([question])])
    const { block, read, reply } = await compactedSection()
    expect([read.count, block.includes(secondSummary), reply]).toStrictEqual([2, true, ''])
    expect(await pillRoles()).toStrictEqual([{ index: 0, role: 'agent' }])
    await waitForValue(browser, 'pill after the second compaction', async () => (await pillThinking(browser, 0))?.slot ?? null, 'spinner')
    expect(await chipStates()).toStrictEqual([{ name: 'Compaction 2 assets', open: false }, { name: 'Compaction 2 summary', open: false }])

    // At the end of the reply, the User pill comes, with the caret in its
    // section, and text that the user types goes there.
    await sendChatReply(last.reply, 'the thinker')
    const answered = { role: 'agent', text: `${block}\n${replyText('the thinker')}` }
    await waitForThread(browser, [answered, { role: 'user', text: '' }])
    expect(await pillRoles()).toStrictEqual([{ index: 0, role: 'agent' }, { index: 1, role: 'user' }])
    expect([await pillStreams(0), (await pillThinking(browser, 0))?.slot]).toStrictEqual([false, null])
    expect(await editorCaret(browser)).toBe((await editorDoc(browser)).length)
    await focusEditor(browser)
    await typeKeys(browser, 'Thanks.')
    await waitForThread(browser, [answered, { role: 'user', text: 'Thanks.' }])
  })

  it('shows the compaction section and sends the same first message after a relaunch, in the old and the new layout', async () => {
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
    expect(await toolChips(browser)).toStrictEqual([assetsChipView(['1 kept', '1 picture'], false), summaryChipView(false)])

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
    await waitForValue(browser, 'streaming', () => activeTabStreaming(browser), false)

    // The conversation of the compaction at a submit: its reply is in the
    // section of the block. The file keeps that section, and the request
    // sends the block as the compaction message, then the reply.
    await sbpCall(browser, 'dez.model/tabs/openConversation', 'compaction-at-submit')
    await waitForValue(browser, 'pills of the new layout', async () => (await pills()).map((pill) => ({ ...pill, time: null })), [
      { index: 0, role: 'agent', model: PROVIDER.modelName, time: null },
      userPill(1),
    ])
    expect(await firstSectionLook()).toStrictEqual(COMPACTED_LOOK)
    const { block, reply } = await compactedSection()
    expect(reply).toBe(replyText('the reader of the notes'))
    await submit(browser, 'And next?')
    const next = await takeRequest(setup, CHAT_PATH, openAiChatBody(PROVIDER, [
      await notesMessage(['The task.', 'Go on.'], 'An earlier answer.'),
      { role: 'assistant', content: replyText('the reader of the notes') },
      { role: 'user', content: 'And next?' },
    ]))
    await sendChatReply(next.reply, 'the next')
    await waitForThread(browser, [
      { role: 'agent', text: `${block}\n${replyText('the reader of the notes')}` },
      { role: 'user', text: 'And next?' },
      { role: 'agent', text: replyText('the next') },
      { role: 'user', text: '' },
    ])
  })
})
