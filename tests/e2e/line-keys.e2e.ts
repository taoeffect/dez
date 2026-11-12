import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Key } from 'webdriverio'
import { startApp, type RunningApp } from './harness/app'
import { consoleErrors, resetConsoleErrors, screenshotOnFailure, waitFor, waitForValue } from './harness/dom'
import { seedAppState } from './harness/fixtures'
import { createSession, destroySession, type E2EBrowser } from './harness/session'
import { docPos, editorCaret, editorDoc, focusEditor, openSeededConversation, setCaret } from './harness/thread'

// Delete Line (Alt+D on Linux) and Duplicate Line (Ctrl+Shift+D), pressed in
// the real editor. Their rules for sections, prompt pills, tool chips, and
// players are in src/view/editor/lineCommands.test.ts. CodeMirror's own
// line keys are off, so they cannot merge sections.
//
// One app session serves the whole file.

describe('line keys', () => {
  let app: RunningApp
  let browser: E2EBrowser

  async function docAndCaret (): Promise<{ doc: string, caret: number }> {
    return { doc: await editorDoc(browser), caret: await editorCaret(browser) }
  }

  beforeAll(async () => {
    app = await startApp()
    try {
      await seedAppState(app.home)
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
  })

  afterAll(async () => {
    if (browser) await destroySession(browser)
    await app?.stop()
  })

  it('duplicates and deletes the line of the caret, and CodeMirror\'s Shift+Ctrl+K deletes nothing', async () => {
    const text = 'alpha\nbravo\ncharlie'
    await openSeededConversation(browser, app.home, 'line-keys', [{ role: 'user', text }])
    await focusEditor(browser)
    await setCaret(browser, await docPos(browser, 'bravo', 2))

    await browser.keys([Key.Control, Key.Shift, 'd'])
    await waitForValue(browser, 'after Duplicate Line', docAndCaret, { doc: 'alpha\nbravo\nbravo\ncharlie', caret: 'alpha\nbravo\nbr'.length })
    await browser.keys([Key.Alt, 'd'])
    await waitForValue(browser, 'after Delete Line', docAndCaret, { doc: text, caret: 'alpha\nbravo\nch'.length })

    // Keys run in order, so the Delete Line after Shift+Ctrl+K shows that
    // Shift+Ctrl+K changed nothing.
    await setCaret(browser, 1)
    await browser.keys([Key.Control, Key.Shift, 'k'])
    await browser.keys([Key.Alt, 'd'])
    await waitForValue(browser, 'after Shift+Ctrl+K and Delete Line', docAndCaret, { doc: 'bravo\ncharlie', caret: 1 })
    expect(await consoleErrors(browser)).toEqual([])
  })
})
