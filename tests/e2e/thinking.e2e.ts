import fs from 'node:fs'
import type http from 'node:http'
import type { EditorView } from '@codemirror/view'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Key } from 'webdriverio'
import { startApp, type RunningApp } from './harness/app'
import { click, closeSettings, consoleErrors, resetConsoleErrors, screenshotOnFailure, waitFor, waitForValue } from './harness/dom'
import { conversationFilePath, makeConversation, readAppState, seedConversation, seedRawAppState } from './harness/fixtures'
import { startChatMock, startEventStream, writeAnthropicEvent, writeChatFrame, type MockServer } from './harness/mockServer'
import { createSession, destroySession, type E2EBrowser } from './harness/session'
import { activeTabStreaming, maskPillDuration, pickModel, pressRolePill, sbpCall, submit, threadSections, waitForThread } from './harness/thread'

// Model thinking, driven through the real app against a mock server in this
// process: the thinking parts of the agent pill, the encrypted pill of the
// panel, the saved container marker, the send-back of earlier thinking, both
// Thinking toggles, the "Supports thinking" checkbox of custom providers,
// and Copy Markdown.
//
// Three custom providers share the mock, each under its own path prefix.
// "Thinker Mock" (OpenAI format) and "Claude Mock" (Anthropic format) are
// seeded with `thinking: {}`. "Plain Mock" (OpenAI format) has no thinking
// until the checkbox test turns it on. Both OpenAI routes stream
// `reasoning_content` before the answer, so a reply to a provider without
// thinking shows that the app ignores it. `fetchModels: false` keeps the
// model lists to the configs, so the mock serves only chat requests.
//
// One app session serves the whole file. The Thinker tests run in order in
// the first tab: each builds on the replies of the one before.

const THINKER = { id: 'thinker', name: 'Thinker Mock', modelId: 'think-model', modelName: 'Think Model' }
const PLAIN = { id: 'plain', name: 'Plain Mock', modelId: 'plain-model', modelName: 'Plain Model' }
const CLAUDE = { id: 'claude', name: 'Claude Mock', modelId: 'claude-model', modelName: 'Claude Model' }

const THINKER_CHAT = '/thinker/v1/chat/completions'
const PLAIN_CHAT = '/plain/v1/chat/completions'
const CLAUDE_CHAT = '/claude/v1/messages'

const FIELD_REPLAY = { kind: 'field', field: 'reasoning_content' }

// A thinking text that ends in an encrypted-reasoning line, as some servers
// send it (`readableThinking` in src/model/chat/thinking.ts). The panel
// shows only the readable part and an encrypted pill, but the store, the
// requests, and the saved file keep the whole text. The line is 3072 chars
// long, so the pill reads "3 KB".
const READABLE_PLAN = 'Readable plan.\n\n- check the data'
const ENCRYPTED_LINE = (() => {
  const head = '__ENCRYPTED_REASONING__v1:{"format":"xai-responses-v1","items":[{"id":"rs_1","content":"'
  const tail = '"}]}'
  return head + 'Q'.repeat(3072 - head.length - tail.length) + tail
})()
const ENCRYPTED_THINKING = `${READABLE_PLAN}\n\n${ENCRYPTED_LINE}`
const PLAIN_SEEDED_THINKING = 'Plain plan.\nNo encrypted line.'

// The two parts of the thinking of the nth reply of an OpenAI route, in
// stream order. The second part adds lines, so an open panel grows while
// the reply streams.
function thinkingParts (n: number): [string, string] {
  return [`Plan ${n}:`, '\n- read the question\n- write the answer']
}

function thinkingText (n: number): string {
  return thinkingParts(n).join('')
}

function answerText (n: number): string {
  return `Answer ${n}.`
}

function claudeBlock (n: number): { type: 'thinking', thinking: string, signature: string } {
  return { type: 'thinking', thinking: `Claude plan ${n}.`, signature: `sig-${n}` }
}

function claudeAnswer (n: number): string {
  return `Claude answer ${n}.`
}

// A user message that the Anthropic format marks as a cache breakpoint: the
// last two user messages of each request.
function claudeMarked (text: string): unknown {
  return { role: 'user', content: [{ type: 'text', text, cache_control: { type: 'ephemeral' } }] }
}

// The thinking that the store holds for the nth Claude reply: the shown text
// and the signed replay with the prefix hash of the messages before it.
function claudeThinking (n: number): unknown {
  return {
    text: claudeBlock(n).thinking,
    replay: { kind: 'anthropicBlocks', blocks: [claudeBlock(n)], prefixHash: expect.any(String) },
  }
}

// The lines that the conversation file holds for the nth Thinker reply: the
// container marker with the replay and the exact thinking text, then the
// answer. The last line is the blank line before the next marker.
function savedThinkerReply (n: number): string[] {
  return [
    `<dez:pill type="agent" model="${THINKER.id}/${THINKER.modelId}" duration-ms="#" replay="{&quot;kind&quot;:&quot;field&quot;,&quot;field&quot;:&quot;reasoning_content&quot;}">`,
    ...thinkingText(n).split('\n'),
    '</dez:pill>',
    answerText(n),
    '',
  ]
}

interface MockRequest {
  path: string
  body: Record<string, unknown>
}

interface MockState {
  requests: MockRequest[]
  /** An OpenAI reply waits at each of its pause points for the next of
   *  these promises, while any are left. */
  pauses: Array<Promise<void>>
  /** The thinking parts of the next OpenAI reply, in place of
   *  `thinkingParts(n)`; that reply sets it back to null. */
  nextThinkingParts: string[] | null
}

/** What the thinking parts of one role pill show. */
interface PillThinkingView {
  role: string
  /** The left slot of the pill. */
  slot: 'spinner' | 'disclosure' | null
  /** `aria-expanded` of the disclosure triangle. */
  expanded: string | null
  /** `data-thinking-open` is set on the separator. */
  open: boolean
  /** The text of the panel's text field, or null without a panel. */
  panelText: string | null
}

interface Gate {
  opened: Promise<void>
  open: () => void
}

function gate (): Gate {
  let open = (): void => {}
  const opened = new Promise<void>((resolve) => { open = resolve })
  return { opened, open }
}

// Streams the nth reply of an OpenAI route: the thinking parts as
// `reasoning_content`, then the answer with a `finish_reason`, then
// `[DONE]`. It pauses before each part and before the answer.
async function sendOpenAiReply (res: http.ServerResponse, n: number, state: MockState): Promise<void> {
  startEventStream(res)
  const parts = state.nextThinkingParts ?? thinkingParts(n)
  state.nextThinkingParts = null
  for (const part of parts) {
    await state.pauses.shift()
    writeChatFrame(res, { reasoning_content: part })
  }
  await state.pauses.shift()
  writeChatFrame(res, { content: 'Answer' })
  writeChatFrame(res, { content: ` ${n}.` }, 'stop')
  res.end('data: [DONE]\n\n')
}

// Streams the nth reply of the Anthropic route: one signed thinking block,
// then the answer block.
function sendClaudeReply (res: http.ServerResponse, n: number): void {
  startEventStream(res)
  const block = claudeBlock(n)
  writeAnthropicEvent(res, {
    type: 'message_start',
    message: { id: `msg_${n}`, type: 'message', role: 'assistant', model: CLAUDE.modelId, content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } },
  })
  writeAnthropicEvent(res, { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } })
  writeAnthropicEvent(res, { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: block.thinking } })
  writeAnthropicEvent(res, { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: block.signature } })
  writeAnthropicEvent(res, { type: 'content_block_stop', index: 0 })
  writeAnthropicEvent(res, { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } })
  writeAnthropicEvent(res, { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: claudeAnswer(n) } })
  writeAnthropicEvent(res, { type: 'content_block_stop', index: 1 })
  writeAnthropicEvent(res, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } })
  writeAnthropicEvent(res, { type: 'message_stop' })
  res.end()
}

describe('thinking', () => {
  let app: RunningApp
  let browser: E2EBrowser
  let server: MockServer
  const mock: MockState = { requests: [], pauses: [], nextThinkingParts: null }

  function requestBodies (path: string): Array<Record<string, unknown>> {
    return mock.requests.filter((request) => request.path === path).map((request) => request.body)
  }

  // The saved Plain Mock config as the app writes it, without `thinking`.
  function savedPlainConfig (): Record<string, unknown> {
    return {
      id: PLAIN.id,
      name: PLAIN.name,
      baseUrl: `${server.url}/${PLAIN.id}/v1`,
      apiFormat: 'openai',
      models: [{ id: PLAIN.modelId, name: PLAIN.modelName }],
      fetchModels: false,
      auth: 'apiKey',
    }
  }

  async function savedProviderSettings (providerId: string): Promise<unknown> {
    return (await readAppState(app.home))?.providerSettings?.[providerId] ?? null
  }

  async function savedCustomProvider (providerId: string): Promise<unknown> {
    return (await readAppState(app.home))?.customProviders?.find((config) => config.id === providerId) ?? null
  }

  // The lines of each agent section in the active tab's conversation file,
  // from its marker line to the next marker, or null while the file does
  // not exist. The reply time changes from run to run, so its digits read
  // as `#`.
  async function savedAgentReplies (): Promise<string[][] | null> {
    const tab = await sbpCall(browser, 'dez.model/tab', await sbpCall(browser, 'dez.model/tabs/activeId')) as { conversationId: string }
    let content: string
    try {
      content = await fs.promises.readFile(conversationFilePath(app.home, tab.conversationId), 'utf8')
    } catch {
      return null
    }
    const replies: string[][] = []
    let reply: string[] | null = null
    for (const line of content.split('\n')) {
      if (line.startsWith('<dez:pill type="user"')) {
        reply = null
      } else if (line.startsWith('<dez:pill type="agent"')) {
        reply = [maskPillDuration(line)]
        replies.push(reply)
      } else {
        reply?.push(line)
      }
    }
    return replies
  }

  // The thinking of each section of the active tab in the store.
  async function storedThinking (): Promise<unknown[]> {
    return browser.execute(() => {
      const sbp = Reflect.get(window, 'sbp') as (selector: string, ...args: unknown[]) => unknown
      const sections = sbp('dez.model/thread/sections') as Array<{ thinking?: unknown }>
      return sections.map((section) => section.thinking ? JSON.parse(JSON.stringify(section.thinking)) as unknown : null)
    })
  }

  async function pillThinking (index: number): Promise<PillThinkingView | null> {
    return browser.execute((sectionIndex: number) => {
      const separator = document.querySelector<HTMLElement>(`.cm-content .dez-role-separator[data-section-index="${sectionIndex}"]`)
      if (!separator) return null
      const label = separator.querySelector('.dez-role-separator__label')
      const disclosure = label?.querySelector('.dez-role-separator__disclosure')
      const spinner = label?.querySelector('.dez-role-separator__spinner')
      const field = separator.querySelector<HTMLTextAreaElement>('.dez-role-separator__thinking textarea.dez-role-separator__thinking-text')
      return {
        role: separator.dataset.role ?? '',
        slot: disclosure ? 'disclosure' as const : spinner ? 'spinner' as const : null,
        expanded: disclosure?.getAttribute('aria-expanded') ?? null,
        open: separator.dataset.thinkingOpen === '1',
        panelText: field?.value ?? null,
      }
    }, index)
  }

  // The encrypted pill in the thinking panel of section `index`, or null
  // when the panel has none: its label, its tooltip, and whether it is
  // drawn below the text field.
  async function encryptedPill (index: number): Promise<{ label: string, title: string, belowText: boolean } | null> {
    return browser.execute((sectionIndex: number) => {
      const panel = document.querySelector(`.cm-content .dez-role-separator[data-section-index="${sectionIndex}"] .dez-role-separator__thinking`)
      const pill = panel?.querySelector<HTMLElement>('.dez-role-separator__thinking-encrypted')
      const field = panel?.querySelector('.dez-role-separator__thinking-text')
      if (!pill || !field) return null
      return {
        label: pill.textContent ?? '',
        title: pill.title,
        belowText: pill.getBoundingClientRect().top >= field.getBoundingClientRect().bottom - 0.5,
      }
    }, index)
  }

  // Where a click near the left edge of the first line of section `index`
  // lands: "same line" when CodeMirror maps it to that line. A stale height
  // of the pill above it would move the click to another line. The lookup
  // is the imprecise one that CodeMirror uses for clicks, so an empty line
  // gets a position too.
  async function lineHitBelowPill (index: number): Promise<string> {
    return browser.execute((sectionIndex: number) => {
      const content = document.querySelector('.cm-content')
      if (!content) throw new Error('lineHitBelowPill: .cm-content not found')
      const view = Reflect.get(Reflect.get(content, 'cmTile'), 'root').view as EditorView
      const line = content.querySelector(`.dez-role-separator[data-section-index="${sectionIndex}"]`)?.closest('.cm-line')?.nextElementSibling
      if (!(line instanceof HTMLElement)) throw new Error(`lineHitBelowPill: no line after separator ${sectionIndex}`)
      const rect = line.getBoundingClientRect()
      const hit = view.posAtCoords({ x: rect.left + 4, y: rect.top + rect.height / 2 }, false)
      const expected = view.state.doc.lineAt(view.posAtDOM(line)).number
      const actual = view.state.doc.lineAt(hit).number
      return actual === expected ? 'same line' : `line ${expected}, click on ${actual}`
    }, index)
  }

  // The drawn caret against the selection head: "at the end" when the head
  // is at the end of the doc and the caret is drawn on it. CodeMirror moves
  // the caret only when it sees that the layout changed.
  async function caretAtEnd (): Promise<string> {
    return browser.execute(() => {
      const content = document.querySelector('.cm-content')
      if (!content) throw new Error('caretAtEnd: .cm-content not found')
      const view = Reflect.get(Reflect.get(content, 'cmTile'), 'root').view as EditorView
      const { head } = view.state.selection.main
      if (head !== view.state.doc.length) return `head at ${head} of ${view.state.doc.length}`
      const caret = document.querySelector<HTMLElement>('.cm-cursorLayer .cm-cursor-primary')
      const layer = caret?.parentElement
      const coords = view.coordsAtPos(head)
      if (!caret || !layer || !coords) throw new Error('caretAtEnd: no caret')
      // The caret is hidden while the editor has no focus, so its offset
      // in the layer gives its place.
      const offset = layer.getBoundingClientRect().top + parseFloat(caret.style.top) - coords.top
      return Math.abs(offset) < 2 ? 'at the end' : `caret ${Math.round(offset)}px off the end`
    })
  }

  async function openGear (): Promise<void> {
    await click(browser, '.model-selector-gear')
    await waitFor(browser, '.provider-settings-popup', 10_000)
  }

  async function closeGear (): Promise<void> {
    await browser.execute(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    await waitForValue(browser, 'popup open', () => browser.execute(() => document.querySelector('.provider-settings-popup') !== null), false)
  }

  async function gearRows (): Promise<{ header: string | null, rows: Array<[string, string | null]> }> {
    return browser.execute(() => ({
      header: document.querySelector('.provider-settings-header')?.textContent?.trim() ?? null,
      rows: Array.from(document.querySelectorAll('.provider-settings-row')).map((row): [string, string | null] => [
        row.querySelector('.provider-settings-label')?.textContent?.trim() ?? '',
        row.getAttribute('aria-checked'),
      ]),
    }))
  }

  async function openProviderDetail (providerId: string, name: string): Promise<void> {
    await sbpCall(browser, 'dez.model/settings/open', 'providers')
    await waitFor(browser, `.provider-row[data-provider-id="${providerId}"]`, 10_000)
    await click(browser, `.provider-row[data-provider-id="${providerId}"]`)
    await waitForValue(browser, `${name} details`, () => browser.execute(
      () => document.querySelector('.provider-detail-name')?.textContent?.trim() ?? null
    ), name)
  }

  /** `aria-checked` of the Thinking switch in Settings › Providers, or null
   *  when the selected provider has none. */
  async function thinkingSwitch (): Promise<string | null> {
    return browser.execute(() => document.querySelector('.provider-thinking-toggle')?.getAttribute('aria-checked') ?? null)
  }

  async function supportsThinkingChecked (): Promise<boolean | null> {
    return browser.execute(() => document.querySelector<HTMLInputElement>('input.provider-supports-thinking-checkbox')?.checked ?? null)
  }

  async function newTab (providerName: string, modelName: string): Promise<void> {
    await sbpCall(browser, 'dez.model/tabs/create')
    await waitForValue(browser, 'new tab', () => threadSections(browser), [{ role: 'user', text: '' }])
    await pickModel(browser, providerName, modelName)
  }

  beforeAll(async () => {
    // Answers only the chat requests of the three providers, and records them.
    server = await startChatMock([THINKER_CHAT, PLAIN_CHAT, CLAUDE_CHAT], async (req, res, body) => {
      const path = req.url ?? ''
      mock.requests.push({ path, body: JSON.parse(body) as Record<string, unknown> })
      const n = mock.requests.filter((request) => request.path === path).length
      if (path === CLAUDE_CHAT) sendClaudeReply(res, n)
      else await sendOpenAiReply(res, n, mock)
    })
    app = await startApp()
    try {
      const provider = (config: typeof THINKER, apiFormat: string, baseUrl: string, thinking: boolean): Record<string, unknown> => ({
        id: config.id,
        name: config.name,
        baseUrl,
        apiFormat,
        fetchModels: false,
        models: [{ id: config.modelId, name: config.modelName }],
        ...(thinking ? { thinking: {} } : {}),
      })
      await seedRawAppState(app.home, {
        customProviders: [
          provider(THINKER, 'openai', `${server.url}/${THINKER.id}/v1`, true),
          provider(PLAIN, 'openai', `${server.url}/${PLAIN.id}/v1`, false),
          // Anthropic SDK style: the base URL has no `/v1`.
          provider(CLAUDE, 'anthropic', `${server.url}/${CLAUDE.id}`, true),
        ],
      })
      await seedConversation(app.home, makeConversation({
        id: 'copy-source',
        title: 'Copy source',
        sections: [
          { role: 'user', nodes: [{ kind: 'text', text: 'Question with **bold**' }] },
          {
            role: 'agent',
            nodes: [{ kind: 'text', text: 'Answer line' }],
            model: { providerId: THINKER.id, modelId: THINKER.modelId },
            thinking: { text: 'Seeded plan.\nSecond line.', replay: { kind: 'field', field: 'reasoning_content' } },
          },
          { role: 'user', nodes: [{ kind: 'text', text: 'Follow-up' }] },
        ],
      }))
      await seedConversation(app.home, makeConversation({
        id: 'encrypted-source',
        title: 'Encrypted source',
        sections: [
          { role: 'user', nodes: [{ kind: 'text', text: 'Encrypted question 1' }] },
          {
            role: 'agent',
            nodes: [{ kind: 'text', text: 'Encrypted answer 1' }],
            model: { providerId: THINKER.id, modelId: THINKER.modelId },
            thinking: { text: PLAIN_SEEDED_THINKING, replay: { kind: 'field', field: 'reasoning_content' } },
          },
          { role: 'user', nodes: [{ kind: 'text', text: 'Encrypted question 2' }] },
          {
            role: 'agent',
            nodes: [{ kind: 'text', text: 'Encrypted answer 2' }],
            model: { providerId: THINKER.id, modelId: THINKER.modelId },
            thinking: { text: ENCRYPTED_THINKING, replay: { kind: 'field', field: 'reasoning_content' } },
          },
          { role: 'user', nodes: [] },
        ],
      }))
      browser = await createSession(app.binary, app.port)
    } catch (err) {
      await app.stop()
      throw err
    }
    await waitFor(browser, 'header.tab-bar', 60_000)
  })

  beforeEach(async () => {
    await resetConsoleErrors(browser)
  })

  afterEach(async (ctx) => {
    await screenshotOnFailure(browser, ctx)
    if (ctx.task.result?.state === 'fail') return
    expect(await consoleErrors(browser)).toEqual([])
  })

  afterAll(async () => {
    await destroySession(browser)
    await app?.stop()
    await server?.stop()
  })

  it('shows a spinner, then a triangle that opens the thinking as it streams, and keeps it open after the stream', async () => {
    await pickModel(browser, THINKER.name, THINKER.modelName)
    const gates = [gate(), gate(), gate()]
    mock.pauses = gates.map((g) => g.opened)
    try {
      await submit(browser, 'Question 1')
      // The reply streams and has no thinking yet.
      await waitForValue(browser, 'pill before the thinking', () => pillThinking(1), {
        role: 'agent', slot: 'spinner', expanded: null, open: false, panelText: null,
      })
      gates[0].open()
      await waitForValue(browser, 'pill with thinking', () => pillThinking(1), {
        role: 'agent', slot: 'disclosure', expanded: 'false', open: false, panelText: null,
      })
      // Screen readers get the triangle as a "Thinking" button, and its open
      // state from `expanded`. The pill has a model here; no part of it that
      // holds the triangle may be an image, because an image hides its
      // children (WebKit's computed role does not show that).
      const triangle = await browser.$('.cm-content .dez-role-separator[data-section-index="1"] .dez-role-separator__disclosure')
      expect([await triangle.getComputedRole(), await triangle.getComputedLabel()]).toEqual(['button', 'Thinking'])
      expect(await browser.execute(() => {
        const pill = document.querySelector('.cm-content .dez-role-separator[data-section-index="1"] .dez-role-separator__label')
        return { model: pill?.hasAttribute('data-model-key') ?? false, inImage: !!pill?.querySelector('.dez-role-separator__disclosure')?.closest('[role="img"]') }
      })).toEqual({ model: true, inImage: false })
      // A mousedown on the triangle opens the panel and keeps the role.
      await pressRolePill(browser, 1, '.dez-role-separator__disclosure')
      await waitForValue(browser, 'open panel', () => pillThinking(1), {
        role: 'agent', slot: 'disclosure', expanded: 'true', open: true, panelText: thinkingParts(1)[0],
      })
      expect(await browser.execute(() => {
        const field = document.querySelector<HTMLTextAreaElement>('.dez-role-separator__thinking-text')
        return { readOnly: field?.readOnly ?? null, label: field?.getAttribute('aria-label') ?? null }
      })).toEqual({ readOnly: true, label: 'Thinking' })
      gates[1].open()
      await waitForValue(browser, 'panel after more thinking', () => pillThinking(1), {
        role: 'agent', slot: 'disclosure', expanded: 'true', open: true, panelText: thinkingText(1),
      })
      expect(await activeTabStreaming(browser)).toBe(true)
    } finally {
      for (const g of gates) g.open()
      mock.pauses = []
    }

    await waitForThread(browser, [
      { role: 'user', text: 'Question 1' },
      { role: 'agent', text: answerText(1) },
      { role: 'user', text: '' },
    ])
    // The editor rebuilds its state from the store when a stream ends; the
    // panel stays open.
    await waitForValue(browser, 'panel after the stream', () => pillThinking(1), {
      role: 'agent', slot: 'disclosure', expanded: 'true', open: true, panelText: thinkingText(1),
    })
    expect(await storedThinking()).toEqual([null, { text: thinkingText(1), replay: FIELD_REPLAY }, null])
    await waitForValue(browser, 'saved reply', savedAgentReplies, [savedThinkerReply(1)])
    // The OpenAI format asks for no thinking fields by default.
    expect(requestBodies(THINKER_CHAT)).toEqual([{
      model: THINKER.modelId,
      stream: true,
      messages: [{ role: 'user', content: 'Question 1' }],
    }])

    // A mousedown anywhere else on a pill with a triangle opens or closes
    // the panel too: here on the role word, then on the model name.
    await pressRolePill(browser, 1)
    await waitForValue(browser, 'closed panel', () => pillThinking(1), {
      role: 'agent', slot: 'disclosure', expanded: 'false', open: false, panelText: null,
    })
    // Closing the panel makes the pill shorter with no doc change. The caret
    // must stay at the end of the doc, and a click on a line below the pill
    // must land on that line. The doc is shorter than the editor here, so
    // the height of the editor content does not change.
    await waitForValue(browser, 'caret after the close', caretAtEnd, 'at the end')
    await waitForValue(browser, 'click below the closed pill', () => lineHitBelowPill(1), 'same line')
    await waitForValue(browser, 'click on the last line', () => lineHitBelowPill(2), 'same line')
    // Opening the panel makes the pill taller with no doc change. A click
    // on the answer below it must still land on the answer line.
    await pressRolePill(browser, 1, '.dez-role-separator__model-name')
    await waitForValue(browser, 'opened again', async () => (await pillThinking(1))?.panelText ?? null, thinkingText(1))
    await waitForValue(browser, 'click below the open pill', () => lineHitBelowPill(1), 'same line')
  })

  it('sends the thinking back with the next request to the same model', async () => {
    await submit(browser, 'Question 2')
    await waitForThread(browser, [
      { role: 'user', text: 'Question 1' },
      { role: 'agent', text: answerText(1) },
      { role: 'user', text: 'Question 2' },
      { role: 'agent', text: answerText(2) },
      { role: 'user', text: '' },
    ])
    expect(requestBodies(THINKER_CHAT)[1]).toEqual({
      model: THINKER.modelId,
      stream: true,
      messages: [
        { role: 'user', content: 'Question 1' },
        { role: 'assistant', content: answerText(1), reasoning_content: thinkingText(1) },
        { role: 'user', content: 'Question 2' },
      ],
    })
  })

  it('changes one Thinking value from the gear popup and Settings › Providers, and drops thinking while it is off', async () => {
    await openGear()
    expect(await gearRows()).toEqual({ header: THINKER.name, rows: [['Thinking', 'true']] })
    await click(browser, '.provider-settings-row')
    expect(await gearRows()).toEqual({ header: THINKER.name, rows: [['Thinking', 'false']] })
    await closeGear()
    await waitForValue(browser, 'saved toggle', () => savedProviderSettings(THINKER.id), { thinking: false })

    await openProviderDetail(THINKER.id, THINKER.name)
    expect(await thinkingSwitch()).toBe('false')
    await click(browser, '.provider-thinking-toggle')
    await waitForValue(browser, 'switch after a click', thinkingSwitch, 'true')
    await waitForValue(browser, 'saved toggle after a click', () => savedProviderSettings(THINKER.id), { thinking: true })
    await click(browser, '.provider-thinking-toggle')
    await waitForValue(browser, 'switch after a second click', thinkingSwitch, 'false')
    await closeSettings(browser)
    await openGear()
    expect(await gearRows()).toEqual({ header: THINKER.name, rows: [['Thinking', 'false']] })
    await closeGear()

    // Off: the request sends no thinking back, and the reasoning of the
    // reply is neither shown nor stored.
    await submit(browser, 'Question 3')
    await waitForThread(browser, [
      { role: 'user', text: 'Question 1' },
      { role: 'agent', text: answerText(1) },
      { role: 'user', text: 'Question 2' },
      { role: 'agent', text: answerText(2) },
      { role: 'user', text: 'Question 3' },
      { role: 'agent', text: answerText(3) },
      { role: 'user', text: '' },
    ])
    expect(requestBodies(THINKER_CHAT)[2]).toEqual({
      model: THINKER.modelId,
      stream: true,
      messages: [
        { role: 'user', content: 'Question 1' },
        { role: 'assistant', content: answerText(1) },
        { role: 'user', content: 'Question 2' },
        { role: 'assistant', content: answerText(2) },
        { role: 'user', content: 'Question 3' },
      ],
    })
    expect(await storedThinking()).toEqual([
      null,
      { text: thinkingText(1), replay: FIELD_REPLAY },
      null,
      { text: thinkingText(2), replay: FIELD_REPLAY },
      null,
      null,
      null,
    ])
    await waitForValue(browser, 'pill of the reply without thinking', () => pillThinking(5), {
      role: 'agent', slot: null, expanded: null, open: false, panelText: null,
    })
    await waitForValue(browser, 'saved replies', savedAgentReplies, [
      savedThinkerReply(1),
      savedThinkerReply(2),
      [`<dez:pill type="agent" model="${THINKER.id}/${THINKER.modelId}" duration-ms="#"/>`, answerText(3), ''],
    ])

    // "Reset to defaults" turns thinking on again and drops the saved value.
    await openGear()
    await click(browser, '.provider-settings-reset')
    expect(await gearRows()).toEqual({ header: THINKER.name, rows: [['Thinking', 'true']] })
    await closeGear()
    await waitForValue(browser, 'saved toggle after the reset', () => savedProviderSettings(THINKER.id), null)
  })

  it('turns thinking on and off for a custom provider with the Supports thinking checkbox', async () => {
    await newTab(PLAIN.name, PLAIN.modelName)
    // Without thinking support, the reasoning in the reply is ignored.
    await submit(browser, 'Plain question 1')
    await waitForThread(browser, [
      { role: 'user', text: 'Plain question 1' },
      { role: 'agent', text: answerText(1) },
      { role: 'user', text: '' },
    ])
    expect(await storedThinking()).toEqual([null, null, null])
    expect(await pillThinking(1)).toEqual({ role: 'agent', slot: null, expanded: null, open: false, panelText: null })

    await openProviderDetail(PLAIN.id, PLAIN.name)
    expect(await supportsThinkingChecked()).toBe(false)
    expect(await thinkingSwitch()).toBeNull()
    await click(browser, 'input.provider-supports-thinking-checkbox')
    await waitForValue(browser, 'Thinking switch', thinkingSwitch, 'true')
    expect(await supportsThinkingChecked()).toBe(true)
    await waitForValue(browser, 'saved config with thinking', () => savedCustomProvider(PLAIN.id), { ...savedPlainConfig(), thinking: {} })
    await closeSettings(browser)
    await openGear()
    expect(await gearRows()).toEqual({ header: PLAIN.name, rows: [['Thinking', 'true']] })
    await closeGear()

    await submit(browser, 'Plain question 2')
    await waitForThread(browser, [
      { role: 'user', text: 'Plain question 1' },
      { role: 'agent', text: answerText(1) },
      { role: 'user', text: 'Plain question 2' },
      { role: 'agent', text: answerText(2) },
      { role: 'user', text: '' },
    ])
    expect(await storedThinking()).toEqual([null, null, null, { text: thinkingText(2), replay: FIELD_REPLAY }, null])
    expect((await pillThinking(3))?.slot).toBe('disclosure')
    // The checkbox asks for nothing more than the OpenAI format default.
    expect(requestBodies(PLAIN_CHAT)[1]).toEqual({
      model: PLAIN.modelId,
      stream: true,
      messages: [
        { role: 'user', content: 'Plain question 1' },
        { role: 'assistant', content: answerText(1) },
        { role: 'user', content: 'Plain question 2' },
      ],
    })

    await openProviderDetail(PLAIN.id, PLAIN.name)
    await click(browser, 'input.provider-supports-thinking-checkbox')
    await waitForValue(browser, 'Thinking switch after the uncheck', thinkingSwitch, null)
    expect(await supportsThinkingChecked()).toBe(false)
    await waitForValue(browser, 'saved config without thinking', () => savedCustomProvider(PLAIN.id), savedPlainConfig())
    await closeSettings(browser)
  })

  it('sends signed Anthropic thinking back only while the messages before it are unchanged', async () => {
    await newTab(CLAUDE.name, CLAUDE.modelName)
    await submit(browser, 'Claude question 1')
    await waitForThread(browser, [
      { role: 'user', text: 'Claude question 1' },
      { role: 'agent', text: claudeAnswer(1) },
      { role: 'user', text: '' },
    ])
    // The Anthropic format asks for adaptive, summarized thinking by default.
    expect(requestBodies(CLAUDE_CHAT)[0]).toEqual({
      model: CLAUDE.modelId,
      stream: true,
      max_tokens: 32000,
      thinking: { type: 'adaptive', display: 'summarized' },
      messages: [claudeMarked('Claude question 1')],
    })
    expect(await storedThinking()).toEqual([null, claudeThinking(1), null])
    expect((await pillThinking(1))?.slot).toBe('disclosure')

    await submit(browser, 'Claude question 2')
    await waitForThread(browser, [
      { role: 'user', text: 'Claude question 1' },
      { role: 'agent', text: claudeAnswer(1) },
      { role: 'user', text: 'Claude question 2' },
      { role: 'agent', text: claudeAnswer(2) },
      { role: 'user', text: '' },
    ])
    expect(requestBodies(CLAUDE_CHAT)[1].messages).toEqual([
      claudeMarked('Claude question 1'),
      { role: 'assistant', content: [claudeBlock(1), { type: 'text', text: claudeAnswer(1) }] },
      claudeMarked('Claude question 2'),
    ])
    // Both replies hold a signed replay, so a text-only send after the edit
    // comes from the prefix check.
    expect(await storedThinking()).toEqual([null, claudeThinking(1), null, claudeThinking(2), null])

    // An edit of the first question changes the messages before both
    // replies, so their signed thinking is stale and goes back as text only.
    await browser.execute((question: string, added: string) => {
      const content = document.querySelector('.cm-content')
      if (!content) throw new Error('edit: .cm-content not found')
      const view = Reflect.get(Reflect.get(content, 'cmTile'), 'root').view as EditorView
      view.dispatch({ changes: { from: String(view.state.doc).indexOf(question) + question.length, insert: added } })
    }, 'Claude question 1', ' (edited)')
    await waitForValue(browser, 'edited question', async () => (await threadSections(browser))[0]?.text ?? null, 'Claude question 1 (edited)')
    await submit(browser, 'Claude question 3')
    await waitForValue(browser, 'third reply', async () => (await threadSections(browser))[5]?.text ?? null, claudeAnswer(3))
    await waitForValue(browser, 'streaming', () => activeTabStreaming(browser), false)
    expect(requestBodies(CLAUDE_CHAT)[2].messages).toEqual([
      { role: 'user', content: 'Claude question 1 (edited)' },
      { role: 'assistant', content: claudeAnswer(1) },
      claudeMarked('Claude question 2'),
      { role: 'assistant', content: claudeAnswer(2) },
      claudeMarked('Claude question 3'),
    ])

    // The third reply came after the edit, so its thinking goes back.
    await submit(browser, 'Claude question 4')
    await waitForThread(browser, [
      { role: 'user', text: 'Claude question 1 (edited)' },
      { role: 'agent', text: claudeAnswer(1) },
      { role: 'user', text: 'Claude question 2' },
      { role: 'agent', text: claudeAnswer(2) },
      { role: 'user', text: 'Claude question 3' },
      { role: 'agent', text: claudeAnswer(3) },
      { role: 'user', text: 'Claude question 4' },
      { role: 'agent', text: claudeAnswer(4) },
      { role: 'user', text: '' },
    ])
    expect(requestBodies(CLAUDE_CHAT)[3].messages).toEqual([
      { role: 'user', content: 'Claude question 1 (edited)' },
      { role: 'assistant', content: claudeAnswer(1) },
      { role: 'user', content: 'Claude question 2' },
      { role: 'assistant', content: claudeAnswer(2) },
      claudeMarked('Claude question 3'),
      { role: 'assistant', content: [claudeBlock(3), { type: 'text', text: claudeAnswer(3) }] },
      claudeMarked('Claude question 4'),
    ])
  })

  it('copies the selection as Markdown with role headings and without markers or thinking, and a thinking panel selection as is', async () => {
    await sbpCall(browser, 'dez.model/tabs/openConversation', 'copy-source')
    await waitForValue(browser, 'seeded thread', () => threadSections(browser), [
      { role: 'user', text: 'Question with **bold**' },
      { role: 'agent', text: 'Answer line' },
      { role: 'user', text: 'Follow-up' },
    ])
    // Records what the app copies. WebDriver keys are no real input events,
    // so Wayland would not give the app the system clipboard anyway.
    await browser.execute(() => {
      const copied: string[] = []
      Reflect.set(window, '__e2eCopied', copied)
      Object.defineProperty(navigator.clipboard, 'writeText', {
        configurable: true,
        value: async (text: string) => { copied.push(text) },
      })
    })
    const copiedTexts = (): Promise<string[]> => browser.execute(() => Reflect.get(window, '__e2eCopied') as string[])

    await browser.execute(() => {
      const content = document.querySelector('.cm-content')
      if (!content) throw new Error('select: .cm-content not found')
      const view = Reflect.get(Reflect.get(content, 'cmTile'), 'root').view as EditorView
      view.focus()
      view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } })
    })
    await browser.keys([Key.Control, Key.Shift, 'c'])
    // The same text as Save As Markdown, without its `# Copy source` line.
    const tabMarkdown = '## User\n\nQuestion with **bold**\n\n## Agent\n\nAnswer line\n\n## User\n\nFollow-up\n'
    await waitForValue(browser, 'copied Markdown', copiedTexts, [tabMarkdown])

    // In the thinking panel, select all selects the panel text, and Copy
    // Markdown copies it unchanged.
    await pressRolePill(browser, 1, '.dez-role-separator__disclosure')
    await waitForValue(browser, 'open panel', async () => (await pillThinking(1))?.panelText ?? null, 'Seeded plan.\nSecond line.')
    await browser.execute(() => document.querySelector<HTMLTextAreaElement>('.dez-role-separator__thinking-text')?.focus())
    await browser.keys([Key.Control, 'a'])
    await browser.keys([Key.Control, Key.Shift, 'c'])
    await waitForValue(browser, 'copied thinking', copiedTexts, [tabMarkdown, 'Seeded plan.\nSecond line.'])
  })

  it('shows an encrypted line of the thinking as a pill, and sends and saves the thinking as the provider sent it', async () => {
    await sbpCall(browser, 'dez.model/tabs/openConversation', 'encrypted-source')
    const seededThread = [
      { role: 'user', text: 'Encrypted question 1' },
      { role: 'agent', text: 'Encrypted answer 1' },
      { role: 'user', text: 'Encrypted question 2' },
      { role: 'agent', text: 'Encrypted answer 2' },
    ]
    await waitForValue(browser, 'seeded thread', () => threadSections(browser), [...seededThread, { role: 'user', text: '' }])

    // The panel leaves out the encrypted line, with the blank lines before
    // it, and shows the encrypted pill below the text in its place.
    await pressRolePill(browser, 3, '.dez-role-separator__disclosure')
    await waitForValue(browser, 'panel without the encrypted line', async () => (await pillThinking(3))?.panelText ?? null, READABLE_PLAN)
    expect(await encryptedPill(3)).toEqual({
      label: 'Encrypted reasoning hidden · 3 KB',
      title: 'The provider sent this reasoning encrypted. Dez keeps it with the reply but does not show it.',
      belowText: true,
    })
    // A reply without an encrypted line gets no encrypted pill.
    await pressRolePill(browser, 1, '.dez-role-separator__disclosure')
    await waitForValue(browser, 'panel of the reply without the line', async () => (await pillThinking(1))?.panelText ?? null, PLAIN_SEEDED_THINKING)
    expect(await encryptedPill(1)).toBeNull()
    // Only the panel changes: the store keeps the text as the provider sent it.
    expect(await storedThinking()).toEqual([
      null,
      { text: PLAIN_SEEDED_THINKING, replay: FIELD_REPLAY },
      null,
      { text: ENCRYPTED_THINKING, replay: FIELD_REPLAY },
      null,
    ])

    // The prompt cache guard: the next request to the same model sends the
    // stored thinking back unchanged, encrypted line and all.
    await pickModel(browser, THINKER.name, THINKER.modelName)
    const n = requestBodies(THINKER_CHAT).length + 1
    await submit(browser, 'Encrypted question 3')
    await waitForThread(browser, [
      ...seededThread,
      { role: 'user', text: 'Encrypted question 3' },
      { role: 'agent', text: answerText(n) },
      { role: 'user', text: '' },
    ])
    expect(requestBodies(THINKER_CHAT)[n - 1]).toEqual({
      model: THINKER.modelId,
      stream: true,
      messages: [
        { role: 'user', content: 'Encrypted question 1' },
        { role: 'assistant', content: 'Encrypted answer 1', reasoning_content: PLAIN_SEEDED_THINKING },
        { role: 'user', content: 'Encrypted question 2' },
        { role: 'assistant', content: 'Encrypted answer 2', reasoning_content: ENCRYPTED_THINKING },
        { role: 'user', content: 'Encrypted question 3' },
      ],
    })
    // The app saves the conversation again after the reply; the file still
    // holds the encrypted line.
    const seededMarker = `<dez:pill type="agent" model="${THINKER.id}/${THINKER.modelId}" replay="{&quot;kind&quot;:&quot;field&quot;,&quot;field&quot;:&quot;reasoning_content&quot;}">`
    await waitForValue(browser, 'saved replies', savedAgentReplies, [
      [seededMarker, ...PLAIN_SEEDED_THINKING.split('\n'), '</dez:pill>', 'Encrypted answer 1', ''],
      [seededMarker, ...ENCRYPTED_THINKING.split('\n'), '</dez:pill>', 'Encrypted answer 2', ''],
      savedThinkerReply(n),
    ])
  })

  // While a reply streams, the panel can hold back all of its thinking so
  // far (`readableThinking`): here `_` can still grow into the encrypted
  // marker, and then the whole text is one encrypted line. More text can
  // still come, so only a finished reply says that it has no readable text.
  it('says that the provider sent no readable thinking only after the stream', async () => {
    await newTab(THINKER.name, THINKER.modelName)
    const encryptedOnly = '__ENCRYPTED_REASONING__v1:{"items":[]}'
    const n = requestBodies(THINKER_CHAT).length + 1
    const panelField = (): Promise<{ text: string, placeholder: string } | null> => browser.execute(() => {
      const field = document.querySelector<HTMLTextAreaElement>('.cm-content .dez-role-separator[data-section-index="1"] .dez-role-separator__thinking-text')
      return field ? { text: field.value, placeholder: field.placeholder } : null
    })
    const gates = [gate(), gate(), gate()]
    mock.pauses = gates.map((g) => g.opened)
    mock.nextThinkingParts = [encryptedOnly.slice(0, 1), encryptedOnly.slice(1)]
    try {
      await submit(browser, 'Unreadable question')
      gates[0].open()
      await waitForValue(browser, 'triangle', async () => (await pillThinking(1))?.slot ?? null, 'disclosure')
      await pressRolePill(browser, 1, '.dez-role-separator__disclosure')
      await waitForValue(browser, 'panel of the held-back start', panelField, { text: '', placeholder: '' })
      gates[1].open()
      await waitForValue(browser, 'encrypted pill while streaming', async () => (await encryptedPill(1))?.label ?? null, `Encrypted reasoning hidden · ${encryptedOnly.length} B`)
      expect(await panelField()).toEqual({ text: '', placeholder: '' })
      expect(await activeTabStreaming(browser)).toBe(true)
    } finally {
      for (const g of gates) g.open()
      mock.pauses = []
      mock.nextThinkingParts = null
    }

    await waitForThread(browser, [
      { role: 'user', text: 'Unreadable question' },
      { role: 'agent', text: answerText(n) },
      { role: 'user', text: '' },
    ])
    await waitForValue(browser, 'panel after the stream', panelField, { text: '', placeholder: 'The provider sent no readable thinking.' })
  })
})
