import type { EditorView } from '@codemirror/view'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Key } from 'webdriverio'
import { startApp, type RunningApp } from './harness/app'
import { consoleErrors, resetConsoleErrors, screenshotOnFailure, waitFor, waitForValue } from './harness/dom'
import { makeConversation, readAppState, seedAppState, seedConversation } from './harness/fixtures'
import { createSession, destroySession, type E2EBrowser } from './harness/session'
import { focusEditor, sbpCall, threadSections } from './harness/thread'

// Cmd/Ctrl+= and Cmd/Ctrl+- change the font size of the thread editor in
// every tab, the size survives a relaunch, and the app chrome keeps its
// size. WebDriver keys reach the page key handler only; the Linux menu
// accelerators take the keys before the page (see vitest.e2e.config.ts).
//
// After each change CodeMirror must measure the text again, or its height
// map keeps the old line heights: the caret and clicks land on the wrong
// line. The docs here are shorter than the editor, the case where
// CodeMirror sees no size change by itself.

const FIRST_TAB_TEXT = 'Short question'
const SECOND_TAB_TEXT = 'Other tab'

interface EditorMetrics {
  /** Computed font size of the editor text, in px. */
  fontSize: number
  /** Computed font size of the role pill words, in px, to one decimal. */
  pillFontSize: number
  /** CodeMirror's measured default line height, rounded to whole px. */
  lineHeight: number
  /** Lines whose place in CodeMirror's height map is not where the DOM
   *  draws them. */
  misplacedLines: string[]
  /** Computed font size of the model button in the bottom bar (chrome). */
  chromeFontSize: number
}

async function editorMetrics (browser: E2EBrowser): Promise<EditorMetrics> {
  return browser.execute(() => {
    const content = document.querySelector<HTMLElement>('.cm-content')
    const pill = document.querySelector('.dez-role-separator')
    const chrome = document.querySelector('.model-selector-btn')
    if (!content || !pill || !chrome) throw new Error('editorMetrics: editor, role pill or model button not found')
    const view = Reflect.get(Reflect.get(content, 'cmTile'), 'root').view as EditorView
    const misplacedLines: string[] = []
    for (const line of content.querySelectorAll<HTMLElement>(':scope > .cm-line')) {
      const rect = line.getBoundingClientRect()
      const block = view.lineBlockAt(view.posAtDOM(line))
      const top = view.documentTop + block.top
      if (Math.abs(top - rect.top) > 1 || Math.abs(block.height - rect.height) > 1) {
        const number = view.state.doc.lineAt(block.from).number
        misplacedLines.push(`line ${number}: map ${Math.round(top)}+${Math.round(block.height)}, DOM ${Math.round(rect.top)}+${Math.round(rect.height)}`)
      }
    }
    return {
      fontSize: parseFloat(getComputedStyle(content).fontSize),
      pillFontSize: Math.round(parseFloat(getComputedStyle(pill).fontSize) * 10) / 10,
      lineHeight: Math.round(view.defaultLineHeight),
      misplacedLines,
      chromeFontSize: parseFloat(getComputedStyle(chrome).fontSize),
    }
  })
}

// What the editor shows at `px`: the pill words are 11px at the default
// 15px, the line height is 1.6, and the chrome stays at 12px.
function expectedMetrics (px: number): EditorMetrics {
  return {
    fontSize: px,
    pillFontSize: Math.round(px * 11 / 15 * 10) / 10,
    lineHeight: Math.round(px * 1.6),
    misplacedLines: [],
    chromeFontSize: 12,
  }
}

describe('editor font size', () => {
  let app: RunningApp
  let browser: E2EBrowser

  async function waitForTabBar (): Promise<void> {
    await waitFor(browser, 'header.tab-bar', 60_000)
  }

  async function waitForEditorMetrics (label: string, px: number): Promise<void> {
    await waitForValue(browser, label, () => editorMetrics(browser), expectedMetrics(px))
  }

  async function waitForActiveTabText (text: string): Promise<void> {
    await waitForValue(browser, 'active tab', async () => (await threadSections(browser))[0]?.text, text)
  }

  beforeAll(async () => {
    app = await startApp()
    try {
      await seedConversation(app.home, makeConversation({
        id: 'conv-a',
        sections: [
          { role: 'user', nodes: [{ kind: 'text', text: FIRST_TAB_TEXT }] },
          { role: 'agent', nodes: [{ kind: 'text', text: 'Short answer\nwith two lines' }] },
          { role: 'user', nodes: [{ kind: 'text', text: 'Last' }] },
        ],
      }))
      await seedConversation(app.home, makeConversation({
        id: 'conv-b',
        sections: [
          { role: 'user', nodes: [{ kind: 'text', text: SECOND_TAB_TEXT }] },
          { role: 'agent', nodes: [{ kind: 'text', text: 'Answer' }] },
        ],
      }))
      await seedAppState(app.home, {
        tabs: [
          { id: 'tab-a', title: 'A', conversationId: 'conv-a', activeModel: null, createdAt: Date.now() },
          { id: 'tab-b', title: 'B', conversationId: 'conv-b', activeModel: null, createdAt: Date.now() },
        ],
        activeTabId: 'tab-a',
      })
      browser = await createSession(app.binary, app.port)
    } catch (err) {
      await app.stop()
      throw err
    }
    await waitForTabBar()
    await waitForActiveTabText(FIRST_TAB_TEXT)
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
  })

  it('changes the editor size with Ctrl+= and Ctrl+-, and CodeMirror measures it again', async () => {
    await waitForEditorMetrics('default size', 15)
    await focusEditor(browser)

    await browser.keys([Key.Control, '='])
    await waitForEditorMetrics('after Ctrl+=', 16)
    await browser.keys([Key.Control, '+'])
    await waitForEditorMetrics('after Ctrl++', 17)
    await waitForValue(browser, 'saved size', async () => (await readAppState(app.home))?.editorFontSize, 17)

    await browser.keys([Key.Control, '-'])
    await waitForEditorMetrics('after Ctrl+-', 16)
    await browser.keys([Key.Control, '-'])
    await waitForEditorMetrics('back at the default', 15)

    await browser.keys([Key.Control, '='])
    await browser.keys([Key.Control, '='])
    await browser.keys([Key.Control, '='])
    await waitForEditorMetrics('after three Ctrl+=', 18)
    await waitForValue(browser, 'saved size', async () => (await readAppState(app.home))?.editorFontSize, 18)
  })

  it('uses the same size in the other tab', async () => {
    await sbpCall(browser, 'dez.model/tabs/switchToIndex', 1)
    await waitForActiveTabText(SECOND_TAB_TEXT)
    await waitForEditorMetrics('other tab', 18)

    await sbpCall(browser, 'dez.model/tabs/switchToIndex', 0)
    await waitForActiveTabText(FIRST_TAB_TEXT)
    await waitForEditorMetrics('first tab again', 18)
  })

  it('keeps the size after a relaunch', async () => {
    await destroySession(browser)
    browser = await createSession(app.binary, app.port)
    await waitForTabBar()
    // A new page: the record that beforeEach started is gone.
    await resetConsoleErrors(browser)
    await waitForActiveTabText(FIRST_TAB_TEXT)
    await waitForEditorMetrics('after the relaunch', 18)
  })
})
