import type { EditorView } from '@codemirror/view'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Key } from 'webdriverio'
import { startApp, type RunningApp } from './harness/app'
import { consoleErrors, pointerClick, resetConsoleErrors, screenshotOnFailure, waitFor, waitForValue } from './harness/dom'
import { makeConversation, seedAppState, seedConversation } from './harness/fixtures'
import { createSession, destroySession, type E2EBrowser } from './harness/session'
import { docPos, editorCaret, sbpCall } from './harness/thread'

// Prompt pills in the real app: an expanded pill stays a pill when Delete
// removes a selection that starts at the end of its body and runs into the
// next sections.
//
// One app session serves the whole file.

const PROMPT_NAME = 'say-hi'
const PROMPT_BODY = 'this is just a test, say hi'
const PROMPT_NODE = `prompt ${PROMPT_NAME}: ${PROMPT_BODY}`

// The issue's thread: a user section that is only the pill, the reply,
// and the empty user section after it.
const THREAD = makeConversation({
  id: 'prompt-pills-e2e',
  title: 'Prompt pills',
  sections: [
    { role: 'user', nodes: [{ kind: 'prompt', id: 'p1', promptId: null, name: PROMPT_NAME, body: PROMPT_BODY }] },
    { role: 'agent', nodes: [{ kind: 'text', text: 'Hi!' }] },
    { role: 'user', nodes: [{ kind: 'text', text: '' }] },
  ],
})

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

  beforeAll(async () => {
    app = await startApp()
    try {
      // Seed app_state.json (checkForUpdates: false) BEFORE the session so
      // startup never fires the update checker's network fetch/toast.
      await seedAppState(app.home)
      await seedConversation(app.home, THREAD)
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
    await browser.execute((conversationId: string) => {
      const sbp = Reflect.get(window, 'sbp') as (selector: string, ...args: unknown[]) => unknown
      void sbp('dez.model/tabs/openConversation', conversationId)
    }, THREAD.id)
    await waitForValue(browser, 'thread open', sectionNodes, [
      { role: 'user', nodes: [PROMPT_NODE] },
      { role: 'agent', nodes: ['text Hi!'] },
      { role: 'user', nodes: [] },
    ])
    await pointerClick(browser, '.dez-prompt-pill')
    await waitFor(browser, '.dez-prompt-pill[data-expanded="1"]', 10_000)

    // From the doc end back to the end of "hi", as a drag or Shift+click
    // gives. Set by code, so that it starts exactly at the body end, next
    // to the hidden close marker.
    const bodyEnd = await docPos(browser, PROMPT_BODY, PROMPT_BODY.length)
    await browser.execute((head: number) => {
      const content = document.querySelector('.cm-content')
      if (!content) throw new Error('select: .cm-content not found')
      const view = Reflect.get(Reflect.get(content, 'cmTile'), 'root').view as EditorView
      view.focus()
      view.dispatch({ selection: { anchor: view.state.doc.length, head } })
    }, bodyEnd)
    await browser.keys([Key.Delete])

    await waitForValue(browser, 'thread after Delete', sectionNodes, [{ role: 'user', nodes: [PROMPT_NODE] }])
    await waitFor(browser, '.dez-prompt-pill[data-expanded="1"]', 10_000)
    expect(await editorCaret(browser)).toBe(bodyEnd)
  })
})
