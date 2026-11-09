import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Key } from 'webdriverio'
import { startApp, type RunningApp } from './harness/app'
import { consoleErrors, pointerClick, resetConsoleErrors, screenshotOnFailure, waitFor, waitForValue } from './harness/dom'
import { makeConversation, seedAppState, seedConversation } from './harness/fixtures'
import { createSession, destroySession, type E2EBrowser } from './harness/session'
import { docPos, editorCaret, editorDoc, focusEditor, savedPillLines, sbpCall, setCaret } from './harness/thread'
import type { ConversationData } from '../../src/model/persistence/types'

// Prompt pills in the real app: an expanded pill stays a pill when Delete
// removes a selection that starts at the end of its body and runs into the
// next sections, and an undo of that Delete brings the sections back with
// their roles and data.
//
// One app session serves the whole file. Each test opens its own copy of
// the thread: a Delete saves its conversation.

const PROMPT_NAME = 'say-hi'
const PROMPT_BODY = 'this is just a test, say hi'
const PROMPT_NODE = `prompt ${PROMPT_NAME}: ${PROMPT_BODY}`

// The issue's thread: a user section that is only the pill, the reply,
// and the empty user section after it.
function issueThread (id: string): ConversationData {
  return makeConversation({
    id,
    title: 'Prompt pills',
    sections: [
      { role: 'user', nodes: [{ kind: 'prompt', id: 'p1', promptId: null, name: PROMPT_NAME, body: PROMPT_BODY }] },
      {
        role: 'agent',
        nodes: [{ kind: 'text', text: 'Hi!' }],
        model: { providerId: 'openrouter', modelId: 'anthropic/claude-sonnet-4.5' },
        durationMs: 1500,
      },
      { role: 'user', nodes: [{ kind: 'text', text: '' }] },
    ],
  })
}

const DELETE_THREAD = issueThread('prompt-pills-delete-e2e')
const UNDO_THREAD = issueThread('prompt-pills-undo-e2e')
const THREAD_NODES = [
  { role: 'user', nodes: [PROMPT_NODE] },
  { role: 'agent', nodes: ['text Hi!'] },
  { role: 'user', nodes: [] },
]
const THREAD_PILL_LINES = [
  '<dez:pill type="user"/>',
  '<dez:pill type="agent" model="openrouter/anthropic/claude-sonnet-4.5" duration-ms="1500"/>',
  '<dez:pill type="user"/>',
]

interface SectionNodes {
  role: string
  /** `prompt <name>: <body>` or `text <text>`; empty text nodes are left
   *  out. */
  nodes: string[]
}

describe('prompt pills', () => {
  let app: RunningApp
  let browser: E2EBrowser

  // The active tab's sections as the store holds them.
  async function sectionNodes (): Promise<SectionNodes[]> {
    const sections = await sbpCall(browser, 'dez.model/thread/sections') as Array<{
      role: string
      content: Array<{ kind: 'text', text: string } | { kind: 'prompt', name: string, body: string }>
    }>
    return sections.map((section) => ({
      role: section.role,
      nodes: section.content
        .filter((node) => node.kind !== 'text' || node.text !== '')
        .map((node) => node.kind === 'prompt' ? `prompt ${node.name}: ${node.body}` : `text ${node.text}`),
    }))
  }

  // The roles of the drawn role pills, from the second section on (the
  // first section's User pill is not a widget).
  async function drawnPillRoles (): Promise<string[]> {
    return browser.execute(() => Array.from(
      document.querySelectorAll('.cm-content .dez-role-separator'),
      (pill) => pill.getAttribute('data-role') ?? '',
    ))
  }

  // Opens `conversationId` (the issue's thread), expands its pill, and
  // presses Delete over a selection from the doc end back to the end of the
  // pill's body. Returns the end of the body.
  async function deleteFromBodyEndToDocEnd (conversationId: string): Promise<number> {
    await sbpCall(browser, 'dez.model/tabs/openConversation', conversationId)
    await waitForValue(browser, 'thread open', sectionNodes, THREAD_NODES)
    await pointerClick(browser, '.dez-prompt-pill')
    await waitFor(browser, '.dez-prompt-pill[data-expanded="1"]', 10_000)

    // From the doc end back to the end of "hi", as a drag or Shift+click
    // gives. Set by code, so that it starts exactly at the body end, next
    // to the hidden close marker.
    const bodyEnd = await docPos(browser, PROMPT_BODY, PROMPT_BODY.length)
    await focusEditor(browser)
    await setCaret(browser, (await editorDoc(browser)).length, bodyEnd)
    await browser.keys([Key.Delete])

    await waitForValue(browser, 'thread after Delete', sectionNodes, [{ role: 'user', nodes: [PROMPT_NODE] }])
    return bodyEnd
  }

  beforeAll(async () => {
    app = await startApp()
    try {
      // Seed app_state.json (checkForUpdates: false) BEFORE the session so
      // startup never fires the update checker's network fetch/toast.
      await seedAppState(app.home)
      await seedConversation(app.home, DELETE_THREAD)
      await seedConversation(app.home, UNDO_THREAD)
      browser = await createSession(app.binary, app.port)
    } catch (err) {
      await app.stop()
      throw err
    }
    await waitFor(browser, 'header.tab-bar', 60_000)
  })

  // Errors thrown inside CodeMirror plugins and Vue handlers are only
  // logged, so the page records console.error calls and each test checks
  // the record.
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
  })

  it('keeps an expanded pill when Delete removes a selection from the end of its body to the doc end', async () => {
    const bodyEnd = await deleteFromBodyEndToDocEnd(DELETE_THREAD.id)

    await waitFor(browser, '.dez-prompt-pill[data-expanded="1"]', 10_000)
    expect(await editorCaret(browser)).toBe(bodyEnd)
  })

  it('brings back the removed sections with their roles and data on undo of that Delete', async () => {
    await deleteFromBodyEndToDocEnd(UNDO_THREAD.id)
    // The Delete's save, so that the check after the undo sees a new save.
    await waitForValue(browser, 'saved pills after Delete', () => savedPillLines(app.home, UNDO_THREAD.id), ['<dez:pill type="user"/>'])

    await browser.keys([Key.Control, 'z'])

    await waitForValue(browser, 'thread after undo', sectionNodes, THREAD_NODES)
    expect(await drawnPillRoles()).toEqual(['agent', 'user'])
    await waitForValue(browser, 'saved pills after undo', () => savedPillLines(app.home, UNDO_THREAD.id), THREAD_PILL_LINES)
  })
})
