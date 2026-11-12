import fs from 'node:fs'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Key } from 'webdriverio'
import { unknownToolText } from '../../src/model/tools/registry'
import { anthropicChatBody, anthropicMarkedUser, openAiChatBody } from './harness/chatBody'
import { consoleErrors, pointerClick, resetConsoleErrors, screenshotOnFailure, typeKeys, waitForValue } from './harness/dom'
import { conversationFilePath, makeConversation, seedConversation } from './harness/fixtures'
import { decodedImage, pasteImage, pngDataUrl, shownImages, stripedPng, type Rgb } from './harness/images'
import { WAV_SAMPLE_RATE, monoWav, shownPlayers } from './harness/media'
import { startMockProviderApp, type MockProviderApp } from './harness/mockProviderApp'
import { mockChatPath, replyText, sendAnthropicReply, sendChatReply, startEventStream, writeAnthropicEvent, writeChatFrame, type MockProvider } from './harness/mockServer'
import type { E2EBrowser } from './harness/session'
import { activeConversationId, activeTabStreaming, docPos, editorCaret, editorDoc, focusEditor, focusedArea, newTab, pickModel, sbpCall, setCaret, submit, threadSections, waitForThread, type ThreadSection } from './harness/thread'

// Tool calls, driven through the real app against a mock server in this
// process: a model of each API format calls the `model_list` tool, the app
// runs it, writes the call as a block into the reply, shows the block as a
// chip whose panel shows the parameters and the result, and sends the call
// and its result back in the next request. Every request holds Dez's system
// prompt and tools, and a later request starts with the same bytes as the
// one before it (the prompt cache). A relaunch reads the saved call back
// from the conversation file. A Stop while the round after a call waits
// keeps the call, and the next request sends it with its result. A
// `model_info` call gives the facts of the mock model as Dez knows them.
// The `image` tool's `crop` and `scale` calls make new images from a pasted
// one: the images go into the reply after the calls, and the requests name
// them by their ids, with no path. A pasted SVG goes as the same PNG copy
// in each request of a reply, and its crop is a PNG. An `audio` call cuts a
// part of a saved clip into a new saved WAV clip, in the same way. A block
// of a tool that Dez does not have shows as an old/unrecognized tool chip,
// and goes back with its result. A long result scrolls in its field under
// the wheel. Backspace and Delete next to a chip never join its block to
// other text.
//
// One app session serves the whole file. The relaunch test reopens the tab
// of the OpenAI test, so it runs right after it.

const TOOLER: MockProvider = { id: 'tooler', name: 'Tool Mock', modelId: 'tool-model', modelName: 'Tool Model' }
const CLAUDE: MockProvider = { id: 'claude', name: 'Claude Mock', modelId: 'claude-model', modelName: 'Claude Model', apiFormat: 'anthropic' }

// 90 x 20, in three stripes of 30 columns: the image of the `image` tool
// test.
const GREEN: Rgb = [40, 160, 60]
const STRIPES_PNG = stripedPng(30, 20, [[220, 40, 40], GREEN, [40, 90, 220]])

// Three stripes of 20 viewBox units, with no width and height. The size
// that WebKit gives it depends on the version: WebKitGTK 2.54 gives it
// 300 x 150 (the default size, fitted to the viewBox), and 2.52 (the CI
// runner's) gives it the viewBox size. The SVG test works in the size that
// the webview gives. Where that is not the viewBox size, WebKit draws a
// part of an SVG wrong unless Dez draws it whole
// (`dez.controller/images/redraw`).
const STRIPES_SVG = Buffer.from([
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 30">',
  '<rect width="20" height="30" fill="rgb(220,40,40)"/>',
  `<rect x="20" width="20" height="30" fill="rgb(${GREEN.join(',')})"/>`,
  '<rect x="40" width="20" height="30" fill="rgb(40,90,220)"/>',
  '</svg>',
].join(''))
const WEBKIT_SVG_SIZES = [{ width: 300, height: 150 }, { width: 60, height: 30 }]

// Two seconds of silence, 16-bit mono at 8 kHz: the clip of the `audio`
// test. Silence, so a run makes no sound.
const SONG_WAV = monoWav(Buffer.alloc(2 * WAV_SAMPLE_RATE * 2), 2)

// The `model_list` results for the filters of the tests. The mock providers
// are the only configured ones: built-ins have no key in the test HOME. Their
// models do not say what they make, so the lines have no outputs column.
const LIST_COLUMNS = '(full id | name | provider | outputs). Outputs: t text, i image, a audio, v video.'
const TOOLER_LIST = `1 model matches "tool" ${LIST_COLUMNS}\n${TOOLER.id}/${TOOLER.modelId} | ${TOOLER.modelName} | ${TOOLER.name}`
const CLAUDE_LIST = `1 model matches "claude" ${LIST_COLUMNS}\n${CLAUDE.id}/${CLAUDE.modelId} | ${CLAUDE.modelName} | ${CLAUDE.name}`

const EPHEMERAL = { type: 'ephemeral' }

/** The text of a `model_list` call that succeeded, as the agent section and
 *  the conversation file hold it. */
function modelListBlock (id: string, filter: string, result: string): string {
  return `<dez:tool id="${id}" name="model_list" filter="${filter}">\n${result}\n</dez:tool>`
}

/** A `model_list` call in an OpenAI-format assistant message. */
function openAiModelListCall (id: string, filter: string): Record<string, unknown> {
  return { id, type: 'function', function: { name: 'model_list', arguments: JSON.stringify({ filter }) } }
}

// Each message of an OpenAI-format request body as JSON text, in the key
// order of the body as sent, and the tools. JSON.parse keeps the key order,
// so equal texts mean equal bytes.
function sentParts (body: string): { messages: string[], tools: string } {
  const parsed = JSON.parse(body) as { messages: unknown[], tools?: unknown }
  return { messages: parsed.messages.map((message) => JSON.stringify(message)), tools: JSON.stringify(parsed.tools) }
}

// The provider's prompt cache reads a later request only up to its first
// byte that differs from the earlier one, so the later request must start
// with every message of the earlier one, the system message first, and send
// the same tools.
function expectSentPrefix (earlierBody: string, laterBody: string): void {
  const earlier = sentParts(earlierBody)
  const later = sentParts(laterBody)
  expect(later.tools).toBe(earlier.tools)
  expect(later.messages.slice(0, earlier.messages.length)).toEqual(earlier.messages)
}

/** What one tool call chip in the editor shows. */
interface ToolChipView {
  /** `data-state` of the chip root. */
  state: string | null
  label: string | null
  /** The words before the name of a tool that Dez does not have. */
  unrecognized: string | null
  name: string
  summary: string | null
  /** "failed" or "interrupted"; null for a call that succeeded or runs. */
  stateWord: string | null
  spinner: boolean
  expanded: string | null
  title: string
  open: boolean
}

/** What the panel of an open chip shows. */
interface ToolPanelView {
  parameters: Array<[string, string]>
  result: string | null
  error: boolean
}

/** The parts of an OpenAI-format request message that a spec reads. */
interface SentMessage {
  role: string
  content?: unknown
  tool_call_id?: string
  tool_calls?: Array<{ id: string, function: { name: string } }>
}

/** A `model_list` chip that succeeded, with its panel closed. */
function closedChip (summary: string): ToolChipView {
  return {
    state: 'success',
    label: `Tool call model_list, ${summary}`,
    unrecognized: null,
    name: 'model_list',
    summary,
    stateWord: null,
    spinner: false,
    expanded: 'false',
    title: 'Show tool call',
    open: false,
  }
}

describe('tool calls', () => {
  let setup: MockProviderApp
  let browser: E2EBrowser
  // The tab of the OpenAI test, for the relaunch test.
  let openAiTab: { conversationId: string, sections: ThreadSection[], lastBody: string } | null = null

  async function toolChips (): Promise<ToolChipView[]> {
    return browser.execute(() => Array.from(document.querySelectorAll<HTMLElement>('.cm-content .dez-tool-call'), (root) => {
      const chip = root.querySelector<HTMLElement>('.dez-tool-call__chip')
      return {
        state: root.dataset.state ?? null,
        label: chip?.getAttribute('aria-label') ?? null,
        unrecognized: chip?.querySelector('.dez-tool-call__unrecognized')?.textContent ?? null,
        name: chip?.querySelector('.dez-tool-call__name')?.textContent ?? '',
        summary: chip?.querySelector('.dez-tool-call__summary')?.textContent ?? null,
        stateWord: chip?.querySelector('.dez-tool-call__state')?.textContent ?? null,
        spinner: chip?.querySelector('.dez-tool-call__spinner') != null,
        expanded: chip?.getAttribute('aria-expanded') ?? null,
        title: chip?.title ?? '',
        open: root.hasAttribute('data-open'),
      }
    }))
  }

  async function toolPanel (index: number): Promise<ToolPanelView | null> {
    return browser.execute((chipIndex: number) => {
      const panel = document.querySelectorAll('.cm-content .dez-tool-call')[chipIndex]?.querySelector('.dez-tool-call__panel')
      if (!panel) return null
      const names = Array.from(panel.querySelectorAll('.dez-tool-call__parameter-name'), (name) => name.textContent ?? '')
      const values = Array.from(panel.querySelectorAll('.dez-tool-call__parameter-value'), (value) => value.textContent ?? '')
      return {
        parameters: names.map((name, index): [string, string] => [name, values[index] ?? '']),
        result: panel.querySelector<HTMLTextAreaElement>('.dez-tool-call__result-text')?.value ?? null,
        error: panel.querySelector('.dez-tool-call__result')?.hasAttribute('data-error') ?? false,
      }
    }, index)
  }

  beforeAll(async () => {
    setup = await startMockProviderApp(TOOLER, {}, { moreProviders: [{ provider: CLAUDE }] })
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

  it('runs a model_list call of an OpenAI-format model, shows it as a chip with a panel, and sends the call and its result back', async () => {
    const question = 'Which tool models are there?'
    await submit(browser, question)
    const first = await setup.mock.waitForRequest(browser)
    expect(first.path).toBe(mockChatPath(TOOLER))
    expect(JSON.parse(first.body)).toEqual(openAiChatBody(TOOLER, [{ role: 'user', content: question }]))

    // Text, then the call in pieces: its id and name, then its arguments in
    // two parts.
    startEventStream(first.reply)
    writeChatFrame(first.reply, { content: 'Let me look.' })
    writeChatFrame(first.reply, { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'model_list', arguments: '' } }] })
    writeChatFrame(first.reply, { tool_calls: [{ index: 0, function: { arguments: '{"filter":' } }] })
    writeChatFrame(first.reply, { tool_calls: [{ index: 0, function: { arguments: '"tool"}' } }] }, 'tool_calls')
    first.reply.end('data: [DONE]\n\n')

    // The app runs the call, puts its block after the text, and sends the
    // next round of the same reply.
    const second = await setup.mock.waitForRequest(browser)
    expect(JSON.parse(second.body)).toEqual(openAiChatBody(TOOLER, [
      { role: 'user', content: question },
      { role: 'assistant', content: 'Let me look.', tool_calls: [openAiModelListCall('call_1', 'tool')] },
      { role: 'tool', tool_call_id: 'call_1', content: TOOLER_LIST },
    ]))
    expectSentPrefix(first.body, second.body)
    const block = modelListBlock('call_1', 'tool', TOOLER_LIST)
    await waitForValue(browser, 'reply while the next round waits', () => threadSections(browser), [
      { role: 'user', text: question },
      { role: 'agent', text: `Let me look.\n${block}\n` },
    ])
    await waitForValue(browser, 'chip while the next round waits', toolChips, [closedChip('"tool"')])
    expect(await activeTabStreaming(browser)).toBe(true)

    await sendChatReply(second.reply, TOOLER.modelName)
    const sections = [
      { role: 'user', text: question },
      { role: 'agent', text: `Let me look.\n${block}\n${replyText(TOOLER.modelName)}` },
      { role: 'user', text: '' },
    ]
    await waitForThread(browser, sections)
    await waitForValue(browser, 'chip after the reply', toolChips, [closedChip('"tool"')])

    // A press on the chip opens its panel, and keeps the caret and the focus
    // in the editor.
    const openChip = { ...closedChip('"tool"'), expanded: 'true', title: 'Hide tool call', open: true }
    const caret = await editorCaret(browser)
    await pointerClick(browser, '.cm-content .dez-tool-call__chip')
    await waitForValue(browser, 'open chip', toolChips, [openChip])
    expect(await toolPanel(0)).toEqual({ parameters: [['filter', 'tool']], result: TOOLER_LIST, error: false })
    expect(await editorCaret(browser)).toBe(caret)
    expect(await focusedArea(browser)).toBe('editor')
    await pointerClick(browser, '.cm-content .dez-tool-call__chip')
    await waitForValue(browser, 'chip closed by a press', toolChips, [closedChip('"tool"')])
    expect(await toolPanel(0)).toBeNull()

    // Enter and Space toggle the focused chip, which keeps the focus; the
    // keys do not reach the doc.
    await browser.execute(() => document.querySelector<HTMLElement>('.cm-content .dez-tool-call__chip')?.focus())
    await browser.keys(Key.Enter)
    await waitForValue(browser, 'chip opened by Enter', toolChips, [openChip])
    await browser.keys(Key.Space)
    await waitForValue(browser, 'chip closed by Space', toolChips, [closedChip('"tool"')])
    expect(await browser.execute(() => document.activeElement?.matches('.dez-tool-call__chip') ?? false)).toBe(true)
    expect(await threadSections(browser)).toEqual(sections)

    const conversationId = await activeConversationId(browser)
    const file = conversationFilePath(setup.app.home, conversationId)
    await waitForValue(browser, 'saved call', async () => (await fs.promises.readFile(file, 'utf8').catch(() => '')).includes(sections[1].text), true)
    openAiTab = { conversationId, sections, lastBody: second.body }
  })

  it('shows the saved call again after a relaunch, and sends it back with the same bytes', async () => {
    if (!openAiTab) throw new Error('The OpenAI test saved no tool call')
    const { conversationId, sections, lastBody } = openAiTab
    browser = await setup.relaunch()
    // A new page: the record that beforeEach started is gone.
    await resetConsoleErrors(browser)

    await waitForValue(browser, 'restored active tab', () => activeConversationId(browser), conversationId)
    await waitForValue(browser, 'restored thread', () => threadSections(browser), sections)
    // The open state is view state, so the panel starts closed.
    await waitForValue(browser, 'restored chip', toolChips, [closedChip('"tool"')])

    await submit(browser, 'And again?')
    const request = await setup.mock.waitForRequest(browser)
    expect(JSON.parse(request.body)).toEqual(openAiChatBody(TOOLER, [
      { role: 'user', content: sections[0].text },
      { role: 'assistant', content: 'Let me look.', tool_calls: [openAiModelListCall('call_1', 'tool')] },
      { role: 'tool', tool_call_id: 'call_1', content: TOOLER_LIST },
      { role: 'assistant', content: replyText(TOOLER.modelName) },
      { role: 'user', content: 'And again?' },
    ]))
    expectSentPrefix(lastBody, request.body)
    await sendChatReply(request.reply, 'again')
    await waitForThread(browser, [
      ...sections.slice(0, 2),
      { role: 'user', text: 'And again?' },
      { role: 'agent', text: replyText('again') },
      { role: 'user', text: '' },
    ])
  })

  it('runs a model_list call of an Anthropic-format model, and sends the call and its result back as tool_use and tool_result blocks', async () => {
    await newTab(browser)
    await pickModel(browser, CLAUDE.name, CLAUDE.modelName)
    const question = 'Which Claude models are there?'
    await submit(browser, question)
    const first = await setup.mock.waitForRequest(browser)
    expect(first.path).toBe(mockChatPath(CLAUDE))
    expect(JSON.parse(first.body)).toEqual(anthropicChatBody(CLAUDE, [anthropicMarkedUser(question)]))

    // A text block, then a tool_use block whose input comes in two parts.
    startEventStream(first.reply)
    writeAnthropicEvent(first.reply, {
      type: 'message_start',
      message: { id: 'msg_tool', type: 'message', role: 'assistant', content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } },
    })
    writeAnthropicEvent(first.reply, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
    writeAnthropicEvent(first.reply, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Checking.' } })
    writeAnthropicEvent(first.reply, { type: 'content_block_stop', index: 0 })
    writeAnthropicEvent(first.reply, { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_01', name: 'model_list', input: {} } })
    writeAnthropicEvent(first.reply, { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"filter":' } })
    writeAnthropicEvent(first.reply, { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"claude"}' } })
    writeAnthropicEvent(first.reply, { type: 'content_block_stop', index: 1 })
    writeAnthropicEvent(first.reply, { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 9 } })
    writeAnthropicEvent(first.reply, { type: 'message_stop' })
    first.reply.end()

    // The results message is a user message, so it gets the cache mark of
    // the last user message.
    const second = await setup.mock.waitForRequest(browser)
    expect(JSON.parse(second.body)).toEqual(anthropicChatBody(CLAUDE, [
      anthropicMarkedUser(question),
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Checking.' },
          { type: 'tool_use', id: 'toolu_01', name: 'model_list', input: { filter: 'claude' } },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_01', content: CLAUDE_LIST, cache_control: EPHEMERAL }] },
    ]))

    sendAnthropicReply(second.reply, CLAUDE.modelName)
    await waitForThread(browser, [
      { role: 'user', text: question },
      { role: 'agent', text: `Checking.\n${modelListBlock('toolu_01', 'claude', CLAUDE_LIST)}\n${replyText(CLAUDE.modelName)}` },
      { role: 'user', text: '' },
    ])
    await waitForValue(browser, 'chip', toolChips, [closedChip('"claude"')])
  })

  it('keeps the call when Stop ends the reply while the next round waits, and sends it back with its result', async () => {
    await newTab(browser)
    await pickModel(browser, TOOLER.name, TOOLER.modelName)
    const question = 'List the tool models.'
    await submit(browser, question)
    const first = await setup.mock.waitForRequest(browser)

    // A call with no text before it.
    startEventStream(first.reply)
    writeChatFrame(first.reply, { tool_calls: [{ index: 0, id: 'call_stop', type: 'function', function: { name: 'model_list', arguments: '{"filter":"tool"}' } }] }, 'tool_calls')
    first.reply.end('data: [DONE]\n\n')

    const second = await setup.mock.waitForRequest(browser)
    await waitForValue(browser, 'chip while the next round waits', toolChips, [closedChip('"tool"')])
    expect(await activeTabStreaming(browser)).toBe(true)

    await pointerClick(browser, '.submit-button')
    const block = modelListBlock('call_stop', 'tool', TOOLER_LIST)
    await waitForThread(browser, [
      { role: 'user', text: question },
      { role: 'agent', text: `${block}\n` },
      { role: 'user', text: '' },
    ])
    await waitForValue(browser, 'request closed by the app', async () => second.closed, true)
    expect(await toolChips()).toEqual([closedChip('"tool"')])

    // The call ended before the stop, so it goes back with its result.
    await submit(browser, 'Go on.')
    const third = await setup.mock.waitForRequest(browser)
    expect(JSON.parse(third.body)).toEqual(openAiChatBody(TOOLER, [
      { role: 'user', content: question },
      { role: 'assistant', content: '', tool_calls: [openAiModelListCall('call_stop', 'tool')] },
      { role: 'tool', tool_call_id: 'call_stop', content: TOOLER_LIST },
      { role: 'user', content: 'Go on.' },
    ]))
    expectSentPrefix(second.body, third.body)
    await sendChatReply(third.reply, 'go on')
    await waitForThread(browser, [
      { role: 'user', text: question },
      { role: 'agent', text: `${block}\n` },
      { role: 'user', text: 'Go on.' },
      { role: 'agent', text: replyText('go on') },
      { role: 'user', text: '' },
    ])
  })

  it('runs a model_info call: the result holds the facts of the model as Dez knows them, and the panel shows it', async () => {
    await newTab(browser)
    await pickModel(browser, TOOLER.name, TOOLER.modelName)
    const question = 'Tell me about the tool model.'
    await submit(browser, question)
    const first = await setup.mock.waitForRequest(browser)
    const model = `${TOOLER.id}/${TOOLER.modelId}`
    const call = { id: 'call_info', type: 'function', function: { name: 'model_info', arguments: JSON.stringify({ model }) } }
    startEventStream(first.reply)
    writeChatFrame(first.reply, { tool_calls: [{ index: 0, ...call }] }, 'tool_calls')
    first.reply.end('data: [DONE]\n\n')

    const second = await setup.mock.waitForRequest(browser)
    const sent = JSON.parse(second.body) as { messages: Array<{ content: unknown }> }
    const result = sent.messages.at(-1)?.content
    if (typeof result !== 'string') throw new Error('The second request has no tool result text')
    expect(JSON.parse(second.body)).toEqual(openAiChatBody(TOOLER, [
      { role: 'user', content: question },
      { role: 'assistant', content: '', tool_calls: [call] },
      { role: 'tool', tool_call_id: 'call_info', content: result },
    ]))
    // The mock model's config tells only its id and name, so every fact is
    // the value that Dez acts on when it does not know; the Tools toggle is
    // the user's value. The mock provider's config has no `thinking`, so
    // Dez asks for no thinking: the model does not think, and the fact is
    // known. The usage texts are not wording that a test pins.
    expect(JSON.parse(result)).toStrictEqual({
      id: model,
      name: TOOLER.modelName,
      provider: { id: TOOLER.id, name: TOOLER.name },
      dez: {
        request: 'chat',
        outputs: ['text'],
        imageInput: true,
        toolCalling: true,
        thinking: false,
        unknown: ['request', 'outputs', 'imageInput', 'toolCalling'],
        toggles: [{ key: 'tools', label: 'Tools', on: true }],
      },
      usage: expect.any(Array),
      providerEntry: { id: TOOLER.modelId, name: TOOLER.modelName },
    })

    await sendChatReply(second.reply, TOOLER.modelName)
    await waitForThread(browser, [
      { role: 'user', text: question },
      { role: 'agent', text: `<dez:tool id="call_info" name="model_info" model="${model}">\n${result}\n</dez:tool>\n${replyText(TOOLER.modelName)}` },
      { role: 'user', text: '' },
    ])
    await pointerClick(browser, '.cm-content .dez-tool-call__chip')
    await waitForValue(browser, 'model_info panel', () => toolPanel(0), { parameters: [['model', model]], result, error: false })
  })

  it('runs image crop and scale calls: the new images go into the reply after the calls, and the requests name them by their ids', async () => {
    await newTab(browser)
    await pickModel(browser, TOOLER.name, TOOLER.modelName)
    await focusEditor(browser)
    await typeKeys(browser, 'Crop ')
    await pasteImage(browser, STRIPES_PNG)
    await waitForValue(browser, 'reference of the pasted image', async () => (await threadSections(browser))[0].text.endsWith('](id=a)'), true)
    const message = (await threadSections(browser))[0].text
    await submit(browser, '')
    const first = await setup.mock.waitForRequest(browser)
    const withImage = { role: 'user', content: [{ type: 'text', text: 'Crop ![image](id=a)' }, { type: 'image_url', image_url: { url: pngDataUrl(STRIPES_PNG) } }] }
    expect(JSON.parse(first.body)).toEqual(openAiChatBody(TOOLER, [withImage]))

    // The green stripe (columns 30 to 59), then that new image at twice its
    // size: the second call of the group names the image of the first.
    const cropParameters = JSON.stringify({ image: 'a', x: 30, y: 0, width: 30, height: 20 })
    const scaleParameters = JSON.stringify({ image: 'b', width: 60 })
    const cropCall = { id: 'call_crop', type: 'function', function: { name: 'image', arguments: JSON.stringify({ command: 'crop', parameters: cropParameters }) } }
    const scaleCall = { id: 'call_scale', type: 'function', function: { name: 'image', arguments: JSON.stringify({ command: 'scale', parameters: scaleParameters }) } }
    startEventStream(first.reply)
    writeChatFrame(first.reply, { content: 'Cropping.' })
    writeChatFrame(first.reply, { tool_calls: [{ index: 0, ...cropCall }, { index: 1, ...scaleCall }] }, 'tool_calls')
    first.reply.end('data: [DONE]\n\n')

    // The results name the new images by their ids and give their sizes.
    // The references of the images come after the request of this round,
    // so the request ends with the results.
    const cropResult = 'Made the image @b from @a. The image @b is 30x20 pixels.'
    const scaleResult = 'Made the image @c from @b. The image @c is 60x40 pixels.'
    const round = [
      { role: 'assistant', content: 'Cropping.', tool_calls: [cropCall, scaleCall] },
      { role: 'tool', tool_call_id: 'call_crop', content: cropResult },
      { role: 'tool', tool_call_id: 'call_scale', content: scaleResult },
    ]
    const second = await setup.mock.waitForRequest(browser)
    expect(JSON.parse(second.body)).toEqual(openAiChatBody(TOOLER, [withImage, ...round]))
    expectSentPrefix(first.body, second.body)
    await sendChatReply(second.reply, TOOLER.modelName)

    // The new images are files of the generated images, written into the
    // reply after the calls with the name of the tool that made them. The
    // text of the next round starts a new paragraph after them.
    await waitForValue(browser, 'sections after the reply', async () => (await threadSections(browser)).length, 3)
    const reply = (await threadSections(browser))[1].text
    const [croppedPath = '', scaledPath = ''] = [...reply.matchAll(/!\[([^\]]+)\]\(id=[bc]\|tool=image\)/g)].map((match) => match[1])
    const blockOf = (id: string, command: string, parameters: string, result: string) =>
      `<dez:tool id="${id}" name="image" command="${command}" parameters="${parameters.replaceAll('"', '&quot;')}">\n${result}\n</dez:tool>`
    const blocks = `${blockOf('call_crop', 'crop', cropParameters, cropResult)}\n${blockOf('call_scale', 'scale', scaleParameters, scaleResult)}`
    const generatedDir = path.join(setup.app.home, '.config', 'dez', 'assets', 'generated', 'images')
    expect([path.dirname(croppedPath), path.dirname(scaledPath)]).toStrictEqual([generatedDir, generatedDir])
    const sections = [
      { role: 'user', text: message },
      {
        role: 'agent',
        text: `Cropping.\n${blocks}\n\n![${croppedPath}](id=b|tool=image)\n\n![${scaledPath}](id=c|tool=image)\n\n${replyText(TOOLER.modelName)}`,
      },
    ]
    await waitForThread(browser, [...sections, { role: 'user', text: '' }])
    const pastedPath = message.slice('Crop !['.length, message.indexOf(']('))
    await waitForValue(browser, 'shown images', () => shownImages(browser), [
      { alt: path.basename(pastedPath), width: 90, height: 20 },
      { alt: path.basename(croppedPath), width: 30, height: 20 },
      { alt: path.basename(scaledPath), width: 60, height: 40 },
    ])
    const green = [[...GREEN, 255], [...GREEN, 255], [...GREEN, 255]]
    expect(await decodedImage(browser, pngDataUrl(await fs.promises.readFile(croppedPath)), [5, 15, 25])).toEqual({ width: 30, height: 20, pixels: green })
    const scaled = await fs.promises.readFile(scaledPath)
    expect(await decodedImage(browser, pngDataUrl(scaled), [10, 30, 50])).toEqual({ width: 60, height: 40, pixels: green })
    expect(await fs.promises.readFile(pastedPath)).toEqual(STRIPES_PNG)

    // A later request holds the references of the new images as text with
    // no path, at the start of the message after the results; a mention of
    // an id sends its image.
    await submit(browser, 'Is @c green?')
    const third = await setup.mock.waitForRequest(browser)
    expect(JSON.parse(third.body)).toEqual(openAiChatBody(TOOLER, [
      { role: 'user', content: 'Crop ![image](id=a)' },
      ...round,
      { role: 'assistant', content: `\n![image](id=b|tool=image)\n\n![image](id=c|tool=image)\n\n${replyText(TOOLER.modelName)}` },
      { role: 'user', content: [{ type: 'text', text: 'Is @c' }, { type: 'image_url', image_url: { url: pngDataUrl(scaled) } }, { type: 'text', text: ' green?' }] },
    ]))
    expect(third.body).not.toContain(setup.app.home)
    await sendChatReply(third.reply, 'green')
    await waitForThread(browser, [...sections, { role: 'user', text: 'Is @c green?' }, { role: 'agent', text: replyText('green') }, { role: 'user', text: '' }])
  })

  // No provider is known to take SVG images.
  it('sends a pasted SVG as the same PNG copy in each request of a reply, and its image crop call makes a PNG', async () => {
    await newTab(browser)
    await pickModel(browser, TOOLER.name, TOOLER.modelName)
    await focusEditor(browser)
    await typeKeys(browser, 'Crop ')
    await pasteImage(browser, STRIPES_SVG, 'image/svg+xml')
    await waitForValue(browser, 'reference of the pasted SVG', async () => (await threadSections(browser))[0].text.endsWith('](id=a)'), true)
    const message = (await threadSections(browser))[0].text
    const pastedPath = message.slice('Crop !['.length, message.indexOf(']('))
    expect(path.extname(pastedPath)).toBe('.svg')
    expect(await fs.promises.readFile(pastedPath)).toEqual(STRIPES_SVG)
    await waitForValue(browser, 'loaded SVG', async () => ((await shownImages(browser))[0]?.width ?? 0) > 0, true)
    const [shown] = await shownImages(browser)
    expect(shown.alt).toBe(path.basename(pastedPath))
    const svgSize = { width: shown.width, height: shown.height }
    expect(WEBKIT_SVG_SIZES).toContainEqual(svgSize)
    const stripe = svgSize.width / 3

    await submit(browser, '')
    const first = await setup.mock.waitForRequest(browser)
    const sent = JSON.parse(first.body) as { messages: Array<{ content: Array<{ type: string, image_url?: { url: string } }> }> }
    const copy = sent.messages.at(-1)?.content[1]?.image_url?.url ?? ''
    expect(copy.startsWith('data:image/png;base64,')).toBe(true)
    expect(await decodedImage(browser, copy, [stripe / 2, stripe * 1.5, stripe * 2.5])).toEqual({
      ...svgSize,
      pixels: [[220, 40, 40, 255], [...GREEN, 255], [40, 90, 220, 255]],
    })

    // The green stripe.
    const made = { width: stripe, height: svgSize.height }
    const call = {
      id: 'call_crop_svg',
      type: 'function',
      function: { name: 'image', arguments: JSON.stringify({ command: 'crop', parameters: JSON.stringify({ image: 'a', x: stripe, y: 0, ...made }) }) },
    }
    startEventStream(first.reply)
    writeChatFrame(first.reply, { tool_calls: [{ index: 0, ...call }] }, 'tool_calls')
    first.reply.end('data: [DONE]\n\n')

    // The next request starts with the bytes of the first one, so the copy
    // of the second drawing is the same file.
    const second = await setup.mock.waitForRequest(browser)
    expectSentPrefix(first.body, second.body)
    expect((JSON.parse(second.body) as { messages: unknown[] }).messages.at(-1)).toEqual({
      role: 'tool',
      tool_call_id: 'call_crop_svg',
      content: `Made the image @b from @a. The image @b is ${made.width}x${made.height} pixels.`,
    })
    await sendChatReply(second.reply, TOOLER.modelName)

    await waitForValue(browser, 'sections after the reply', async () => (await threadSections(browser)).length, 3)
    const reply = (await threadSections(browser))[1].text
    const madePath = reply.slice(reply.indexOf('![') + 2, reply.indexOf(']('))
    expect(path.extname(madePath)).toBe('.png')
    expect(await decodedImage(browser, pngDataUrl(await fs.promises.readFile(madePath)), [made.width / 10, made.width / 2, made.width * 9 / 10])).toEqual({
      ...made,
      pixels: [[...GREEN, 255], [...GREEN, 255], [...GREEN, 255]],
    })
    expect(await fs.promises.readFile(pastedPath)).toEqual(STRIPES_SVG)
  })

  it('runs an audio clip call: the cut is a new saved WAV clip in the reply after the call, and the requests name it by its id', async () => {
    const audioDir = path.join(setup.app.home, '.config', 'dez', 'assets', 'generated', 'audio')
    const songPath = path.join(audioDir, 'song.wav')
    await fs.promises.mkdir(audioDir, { recursive: true })
    await fs.promises.writeFile(songPath, SONG_WAV)
    const songTag = `<dez:audio id="a" type="audio/wav" src="${songPath}"/>`
    await seedConversation(setup.app.home, makeConversation({
      id: 'audio-cut',
      title: 'Audio cut',
      sections: [
        { role: 'user', nodes: [{ kind: 'text', text: 'Make a song.' }] },
        { role: 'agent', nodes: [{ kind: 'text', text: songTag }] },
        { role: 'user', nodes: [{ kind: 'text', text: '' }] },
      ],
    }))
    await sbpCall(browser, 'dez.model/tabs/openConversation', 'audio-cut')
    await waitForThread(browser, [{ role: 'user', text: 'Make a song.' }, { role: 'agent', text: songTag }, { role: 'user', text: '' }])
    await pickModel(browser, TOOLER.name, TOOLER.modelName)
    await submit(browser, 'Cut it.')
    const first = await setup.mock.waitForRequest(browser)
    const before = [
      { role: 'user', content: 'Make a song.' },
      { role: 'assistant', content: '<dez:audio id="a" type="audio/wav"/>' },
      { role: 'user', content: 'Cut it.' },
    ]
    expect(JSON.parse(first.body)).toEqual(openAiChatBody(TOOLER, before))

    const parameters = JSON.stringify({ clip: 'a', start: 0.5, end: 1 })
    const call = { id: 'call_cut', type: 'function', function: { name: 'audio', arguments: JSON.stringify({ command: 'clip', parameters }) } }
    startEventStream(first.reply)
    writeChatFrame(first.reply, { tool_calls: [{ index: 0, ...call }] }, 'tool_calls')
    first.reply.end('data: [DONE]\n\n')

    // The tag of the new clip comes after the request of this round, so the
    // request ends with the result.
    const result = 'Made the audio clip @b from @a, from second 0.5 to second 1. The audio clip @b is 0.5 seconds long.'
    const round = [
      { role: 'assistant', content: '', tool_calls: [call] },
      { role: 'tool', tool_call_id: 'call_cut', content: result },
    ]
    const second = await setup.mock.waitForRequest(browser)
    expect(JSON.parse(second.body)).toEqual(openAiChatBody(TOOLER, [...before, ...round]))
    expectSentPrefix(first.body, second.body)
    await sendChatReply(second.reply, TOOLER.modelName)

    // The new clip is a saved file of the generated audio, written into the
    // reply after the call with the name of the tool that made it.
    await waitForValue(browser, 'sections after the reply', async () => (await threadSections(browser)).length, 5)
    const reply = (await threadSections(browser))[3].text
    const madePath = /<dez:audio id="b" type="audio\/wav" src="([^"]+)"/.exec(reply)?.[1] ?? ''
    expect(path.dirname(madePath)).toBe(audioDir)
    expect(path.basename(madePath)).toMatch(/^[0-9a-f-]{36}\.wav$/)
    const block = `<dez:tool id="call_cut" name="audio" command="clip" parameters="${parameters.replaceAll('"', '&quot;')}">\n${result}\n</dez:tool>`
    const sections = [
      { role: 'user', text: 'Make a song.' },
      { role: 'agent', text: songTag },
      { role: 'user', text: 'Cut it.' },
      { role: 'agent', text: `${block}\n\n<dez:audio id="b" type="audio/wav" src="${madePath}" tool="audio"/>\n\n${replyText(TOOLER.modelName)}` },
    ]
    await waitForThread(browser, [...sections, { role: 'user', text: '' }])
    await waitForValue(browser, 'players', async () => (await shownPlayers(browser)).map(({ id, available, seconds, save }) => ({ id, available, seconds, save })), [
      { id: 'a', available: true, seconds: 2, save: 'saved' },
      { id: 'b', available: true, seconds: 0.5, save: 'saved' },
    ])

    // A 16-bit WAV file at the rate of the cut (48 kHz), with the channel
    // of the clip: half a second of it.
    const made = await fs.promises.readFile(madePath)
    expect({
      riff: made.toString('ascii', 0, 4),
      channels: made.readUInt16LE(22),
      rate: made.readUInt32LE(24),
      bits: made.readUInt16LE(34),
      dataBytes: made.readUInt32LE(40),
      length: made.length,
    }).toStrictEqual({ riff: 'RIFF', channels: 1, rate: 48000, bits: 16, dataBytes: 48000, length: 44 + 48000 })
    expect(await fs.promises.readFile(songPath)).toEqual(SONG_WAV)

    // A later request holds the tag of the new clip in its request form:
    // its id and type, with no path.
    await submit(browser, 'Thanks.')
    const third = await setup.mock.waitForRequest(browser)
    expect(JSON.parse(third.body)).toEqual(openAiChatBody(TOOLER, [
      ...before,
      ...round,
      { role: 'assistant', content: `\n<dez:audio id="b" type="audio/wav"/>\n\n${replyText(TOOLER.modelName)}` },
      { role: 'user', content: 'Thanks.' },
    ]))
    expect(third.body).not.toContain(setup.app.home)
    await sendChatReply(third.reply, 'welcome')
    await waitForThread(browser, [...sections, { role: 'user', text: 'Thanks.' }, { role: 'agent', text: replyText('welcome') }, { role: 'user', text: '' }])
  })

  it('shows a block of a tool that Dez does not have as an old/unrecognized tool chip, and sends the call back with its result', async () => {
    const oldResult = 'Made the image @b from @a. The image @b is 10x10 pixels.'
    const oldBlock = `<dez:tool id="call_old" name="crop_scale_image" image="a" width="10" height="10">\n${oldResult}\n</dez:tool>`
    const refusal = unknownToolText('web_search')
    const refusedBlock = `<dez:tool id="call_web" name="web_search" status="error" query="cats">\n${refusal}\n</dez:tool>`
    const reply = `${oldBlock}\n${refusedBlock}\nDone.`
    await seedConversation(setup.app.home, makeConversation({
      id: 'unrecognized-tools',
      title: 'Unrecognized tools',
      sections: [
        { role: 'user', nodes: [{ kind: 'text', text: 'Crop it and look it up.' }] },
        { role: 'agent', nodes: [{ kind: 'text', text: reply }] },
        { role: 'user', nodes: [{ kind: 'text', text: '' }] },
      ],
    }))
    await sbpCall(browser, 'dez.model/tabs/openConversation', 'unrecognized-tools')
    const sections = [{ role: 'user', text: 'Crop it and look it up.' }, { role: 'agent', text: reply }]
    await waitForThread(browser, [...sections, { role: 'user', text: '' }])

    // The chip names the tool after the words, with no argument summary; a
    // refused call keeps its state word.
    const unrecognized = 'old/unrecognized tool:'
    await waitForValue(browser, 'chips of the old and the made-up tool', toolChips, [
      { ...closedChip(''), label: 'Tool call, old/unrecognized tool: crop_scale_image', unrecognized, name: 'crop_scale_image', summary: null },
      { ...closedChip(''), state: 'error', label: 'Tool call, old/unrecognized tool: web_search, failed', unrecognized, name: 'web_search', summary: null, stateWord: 'failed' },
    ])
    await pointerClick(browser, '.cm-content .dez-tool-call__chip')
    await waitForValue(browser, 'panel of the old tool', () => toolPanel(0), {
      parameters: [['image', 'a'], ['width', '10'], ['height', '10']],
      result: oldResult,
      error: false,
    })

    await pickModel(browser, TOOLER.name, TOOLER.modelName)
    await submit(browser, 'Go on.')
    const request = await setup.mock.waitForRequest(browser)
    // The mock's copy of the app's request; the expects below check the
    // parts that this cast names.
    const sent = JSON.parse(request.body) as { messages: SentMessage[] }
    expect(sent.messages.flatMap((message) => message.tool_calls ?? []).map((call) => [call.id, call.function.name])).toEqual([['call_old', 'crop_scale_image'], ['call_web', 'web_search']])
    expect(sent.messages.filter((message) => message.role === 'tool').map((message) => [message.tool_call_id, message.content])).toEqual([['call_old', oldResult], ['call_web', refusal]])
    await sendChatReply(request.reply, TOOLER.modelName)
    await waitForThread(browser, [...sections, { role: 'user', text: 'Go on.' }, { role: 'agent', text: replyText(TOOLER.modelName) }, { role: 'user', text: '' }])
  })

  it('scrolls a result that is taller than its field under the wheel, not the doc', async () => {
    // Text after the block makes the doc taller than the window, so a wheel
    // that the field does not take would scroll the doc.
    const result = Array.from({ length: 120 }, (_, index) => `result line ${index + 1}`).join('\n')
    const after = Array.from({ length: 80 }, (_, index) => `after ${index + 1}`).join('\n')
    await seedConversation(setup.app.home, makeConversation({
      id: 'long-result',
      title: 'Long result',
      sections: [
        { role: 'user', nodes: [{ kind: 'text', text: 'All models?' }] },
        { role: 'agent', nodes: [{ kind: 'text', text: `${modelListBlock('call_long', 'x', result)}\n${after}` }] },
      ],
    }))
    await sbpCall(browser, 'dez.model/tabs/openConversation', 'long-result')
    await waitForValue(browser, 'chip of the long result', toolChips, [closedChip('"x"')])
    await pointerClick(browser, '.cm-content .dez-tool-call__chip')
    await waitForValue(browser, 'long result in the panel', async () => (await toolPanel(0))?.result, result)

    const scrollTops = async (): Promise<{ field: number, doc: number }> => browser.execute(() => ({
      field: document.querySelector('.cm-content .dez-tool-call__result')?.scrollTop ?? -1,
      doc: document.querySelector('.cm-scroller')?.scrollTop ?? -1,
    }))
    const field = await browser.execute(() => {
      const box = document.querySelector('.cm-content .dez-tool-call__result')
      if (!box) throw new Error('no result field')
      box.scrollIntoView({ block: 'center' })
      const rect = box.getBoundingClientRect()
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }
    })
    const before = await scrollTops()
    expect(before.field).toBe(0)
    await browser.action('wheel').scroll({ x: field.x, y: field.y, deltaY: 300 }).perform()
    await waitForValue(browser, 'result field scrolled', async () => (await scrollTops()).field > 0, true)
    expect((await scrollTops()).doc).toBe(before.doc)
  })

  it('keeps each chip on its own lines under Backspace before it, Delete after it, and section merges', async () => {
    const first = modelListBlock('call_keys_a', 'a', 'one')
    const ending = modelListBlock('call_keys_b', 'b', 'two')
    const alone = modelListBlock('call_keys_c', 'c', 'three')
    const reply = `before\n${first}\nafter\n${ending}`
    await seedConversation(setup.app.home, makeConversation({
      id: 'chip-keys',
      title: 'Chip keys',
      sections: [
        { role: 'user', nodes: [{ kind: 'text', text: 'Ask' }] },
        { role: 'agent', nodes: [{ kind: 'text', text: reply }] },
        { role: 'user', nodes: [{ kind: 'text', text: 'next' }] },
        { role: 'agent', nodes: [{ kind: 'text', text: alone }] },
        { role: 'user', nodes: [{ kind: 'text', text: 'last' }] },
      ],
    }))
    await sbpCall(browser, 'dez.model/tabs/openConversation', 'chip-keys')
    await waitForValue(browser, 'chips', async () => (await toolChips()).length, 3)
    const doc = await editorDoc(browser)
    const docAndCaret = async (): Promise<{ doc: string, caret: number }> => ({ doc: await editorDoc(browser), caret: await editorCaret(browser) })
    const from = await docPos(browser, first)
    const to = from + first.length
    await focusEditor(browser)

    // ArrowLeft from after the chip puts the caret at its start. Backspace
    // there and Delete at the chip end go over the line break.
    await setCaret(browser, to)
    await browser.keys(Key.ArrowLeft)
    await waitForValue(browser, 'caret after ArrowLeft', docAndCaret, { doc, caret: from })
    await browser.keys(Key.Backspace)
    await waitForValue(browser, 'after Backspace at the chip start', docAndCaret, { doc, caret: from - 1 })
    await setCaret(browser, to)
    await browser.keys(Key.Delete)
    await waitForValue(browser, 'after Delete at the chip end', docAndCaret, { doc, caret: to + 1 })

    // Section merges keep a line break at the chip.
    await setCaret(browser, await docPos(browser, 'next'))
    await browser.keys(Key.Backspace)
    await waitForValue(browser, 'sections after Backspace at the next section', () => threadSections(browser), [
      { role: 'user', text: 'Ask' },
      { role: 'agent', text: `${reply}\nnext` },
      { role: 'agent', text: alone },
      { role: 'user', text: 'last' },
    ])
    expect(await editorCaret(browser)).toBe(await docPos(browser, 'next'))
    const aloneTo = (await docPos(browser, alone)) + alone.length
    await setCaret(browser, aloneTo)
    await browser.keys(Key.Delete)
    await waitForValue(browser, 'sections after Delete at the chip end', () => threadSections(browser), [
      { role: 'user', text: 'Ask' },
      { role: 'agent', text: `${reply}\nnext` },
      { role: 'agent', text: `${alone}\nlast` },
    ])
    expect(await editorCaret(browser)).toBe(aloneTo)
    expect((await toolChips()).length).toBe(3)
  })
})
