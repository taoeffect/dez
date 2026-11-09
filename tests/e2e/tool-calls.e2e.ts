import fs from 'node:fs'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Key } from 'webdriverio'
import { anthropicChatBody, anthropicMarkedUser, openAiChatBody } from './harness/chatBody'
import { consoleErrors, pointerClick, resetConsoleErrors, screenshotOnFailure, waitForValue } from './harness/dom'
import { conversationFilePath, makeConversation, seedConversation } from './harness/fixtures'
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
// keeps the call, and the next request sends it with its result. A long
// result scrolls in its field under the wheel. Backspace and Delete next to
// a chip never join its block to other text.
//
// One app session serves the whole file. The relaunch test reopens the tab
// of the OpenAI test, so it runs right after it.

const TOOLER: MockProvider = { id: 'tooler', name: 'Tool Mock', modelId: 'tool-model', modelName: 'Tool Model' }
const CLAUDE: MockProvider = { id: 'claude', name: 'Claude Mock', modelId: 'claude-model', modelName: 'Claude Model', apiFormat: 'anthropic' }

// The `model_list` results for the filters of the tests. The mock providers
// are the only configured ones: built-ins have no key in the test HOME.
const TOOLER_LIST = `1 model matches "tool" (full id | name | provider):\n${TOOLER.id}/${TOOLER.modelId} | ${TOOLER.modelName} | ${TOOLER.name}`
const CLAUDE_LIST = `1 model matches "claude" (full id | name | provider):\n${CLAUDE.id}/${CLAUDE.modelId} | ${CLAUDE.modelName} | ${CLAUDE.name}`

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

/** A `model_list` chip that succeeded, with its panel closed. */
function closedChip (summary: string): ToolChipView {
  return {
    state: 'success',
    label: 'Tool call model_list',
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
  let openAiRound: { conversationId: string, sections: ThreadSection[], lastBody: string } | null = null

  async function toolChips (): Promise<ToolChipView[]> {
    return browser.execute(() => Array.from(document.querySelectorAll<HTMLElement>('.cm-content .dez-tool-call'), (root) => {
      const chip = root.querySelector<HTMLElement>('.dez-tool-call__chip')
      return {
        state: root.dataset.state ?? null,
        label: chip?.getAttribute('aria-label') ?? null,
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
    openAiRound = { conversationId, sections, lastBody: second.body }
  })

  it('shows the saved call again after a relaunch, and sends it back with the same bytes', async () => {
    if (!openAiRound) throw new Error('The OpenAI test saved no tool call')
    const { conversationId, sections, lastBody } = openAiRound
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
    await waitForValue(browser, 'chip of the long result', async () => (await toolChips()).length, 1)
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
