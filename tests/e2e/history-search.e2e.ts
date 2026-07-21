import fs from 'node:fs'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { startApp, type RunningApp } from './harness/app'
import { createSession, destroySession, type E2EBrowser } from './harness/session'
import { click, openHistoryPanel, screenshotOnFailure, typeInto, waitFor, waitForRowCount } from './harness/dom'
import {
  conversationFilePath,
  makeConversation,
  resetConversationFixtures,
  seedAppState,
  seedConversation
} from './harness/fixtures'
import type { ConversationData } from '../../src/model/persistence/types'

// Full-text history search, ported from the manual walkthrough in
// .agents/tasks/full-text-search/STEP-5.md. Drives the real app's history
// panel through WebDriver: listing, AND multi-term search with <mark>
// highlights, no-match empty state, mtime-driven re-indexing, the delete
// flow (UI + on-disk), sort modes, and click-to-open.
//
// Lifecycle boundary (decided in TODO-4): the tauri-driver process, temp
// HOME, and WebDriver session are shared per spec FILE (beforeAll/afterAll)
// because app launch dominates cost. Each test resets only the conversation
// fixtures on disk (millisecond-scale) and reopens the history panel, which
// re-lists from disk on mount — giving every test a clean search/sort/list
// state without relaunching the app.

// Fixed past epoch (ms) so `recent` ordering is deterministic: the panel's
// recent sort orders by file mtime (Rust file_updated_at), so each fixture
// gets an explicit, distinct mtime rather than relying on write order.
const MTIME_BASE = 1_700_000_000_000

function alphaConv (): ConversationData {
  return makeConversation({
    id: 'e2e-alpha',
    title: 'Alpha Conversation',
    sections: [{ role: 'user', nodes: [{ kind: 'text', text: 'the zeppelin autopilot drifted over the alps' }] }]
  })
}

function betaConv (): ConversationData {
  return makeConversation({
    id: 'e2e-beta',
    title: 'Beta Conversation',
    sections: [{ role: 'user', nodes: [{ kind: 'text', text: 'a zeppelin floated above the quiet city' }] }]
  })
}

function gammaConv (): ConversationData {
  return makeConversation({
    id: 'e2e-gamma',
    title: 'Gamma Conversation',
    sections: [{ role: 'user', nodes: [{ kind: 'text', text: 'quasar light crossed the empty void' }] }]
  })
}

interface FixtureEntry {
  data: ConversationData
  mtime?: number
}

// Standard three-conversation set, alpha newest / gamma oldest by mtime.
function standardFixtures (): FixtureEntry[] {
  return [
    { data: alphaConv(), mtime: MTIME_BASE + 3000 },
    { data: betaConv(), mtime: MTIME_BASE + 2000 },
    { data: gammaConv(), mtime: MTIME_BASE + 1000 }
  ]
}

// Titles chosen so alphabetical order (Apple, Mountain, Zebra) differs from
// recent-by-mtime order (Zebra, Mountain, Apple), proving the sort toggle.
function sortFixtures (): FixtureEntry[] {
  return [
    {
      data: makeConversation({
        id: 'e2e-zebra',
        title: 'Zebra Trip',
        sections: [{ role: 'user', nodes: [{ kind: 'text', text: 'zebras on the savanna' }] }]
      }),
      mtime: MTIME_BASE + 3000
    },
    {
      data: makeConversation({
        id: 'e2e-mountain',
        title: 'Mountain Hike',
        sections: [{ role: 'user', nodes: [{ kind: 'text', text: 'hiking the mountain ridge' }] }]
      }),
      mtime: MTIME_BASE + 2000
    },
    {
      data: makeConversation({
        id: 'e2e-apple',
        title: 'Apple Pie',
        sections: [{ role: 'user', nodes: [{ kind: 'text', text: 'baking an apple pie' }] }]
      }),
      mtime: MTIME_BASE + 1000
    }
  ]
}

// Wipe the temp HOME's conversations dir, then seed each entry (with its
// optional mtime). resetConversationFixtures([]) only wipes; seeding happens
// here so per-fixture mtimes can be set for deterministic ordering.
async function resetFixtures (home: string, entries: FixtureEntry[]): Promise<void> {
  await resetConversationFixtures(home, [])
  for (const entry of entries) {
    await seedConversation(home, entry.data, entry.mtime !== undefined ? { mtime: entry.mtime } : {})
  }
}

// Clear the search input and type a fresh query. The per-character
// InputEvent workaround lives in the harness's `typeInto`; clearing first
// lets a test replace a previous query outright.
async function setSearchQuery (browser: E2EBrowser, text: string): Promise<void> {
  await typeInto(browser, '.history-search', text, { clear: true })
}

async function setSortMode (browser: E2EBrowser, mode: 'recent' | 'alphabetical'): Promise<void> {
  await browser.execute((val: string) => {
    const el = document.querySelector('.history-sort') as HTMLSelectElement | null
    if (!el) throw new Error('setSortMode: .history-sort not found')
    el.value = val
    el.dispatchEvent(new Event('change', { bubbles: true }))
  }, mode)
}

async function getRowTitles (browser: E2EBrowser): Promise<string[]> {
  return browser.execute(() =>
    Array.from(document.querySelectorAll('.history-row .history-row-title-line h3'))
      .map((el) => el.textContent?.trim() ?? '')
  )
}

async function getMarkTexts (browser: E2EBrowser): Promise<string[]> {
  return browser.execute(() =>
    Array.from(document.querySelectorAll('.history-row-mark'))
      .map((el) => el.textContent ?? '')
  )
}

async function getMarkCount (browser: E2EBrowser): Promise<number> {
  return browser.execute(() => document.querySelectorAll('.history-row-mark').length)
}

// Wait for the panel to settle on an expected result count: rows when
// expected > 0, the empty-state block when expected === 0.
async function waitForResults (browser: E2EBrowser, expected: number): Promise<void> {
  if (expected === 0) {
    await waitFor(browser, '.history-empty')
  } else {
    await waitForRowCount(browser, expected)
  }
}

async function waitForOverlayGone (browser: E2EBrowser): Promise<void> {
  await browser.waitUntil(
    async () => {
      try {
        const el = await browser.$('.history-overlay')
        return !(await el.isExisting())
      } catch {
        return true
      }
    },
    { timeout: 30_000, timeoutMsg: 'history overlay did not close' }
  )
}

// Close the panel if it is open, then open it fresh. A freshly mounted panel
// starts with an empty query and `recent` sort and re-lists from disk, so
// this gives each test a clean, current view of the seeded fixtures.
async function reopenHistoryPanel (browser: E2EBrowser): Promise<void> {
  const overlay = await browser.$('.history-overlay')
  if (await overlay.isExisting()) {
    await click(browser, '.history-close')
    await waitForOverlayGone(browser)
  }
  await openHistoryPanel(browser)
}

// Per-test setup: reset on-disk fixtures, reopen the panel (triggering a
// fresh listing), and wait for the full unfiltered list to render.
async function startTest (
  browser: E2EBrowser,
  home: string,
  entries: FixtureEntry[],
  expectedRows: number
): Promise<void> {
  await resetFixtures(home, entries)
  await reopenHistoryPanel(browser)
  await waitForResults(browser, expectedRows)
}

async function waitForFileGone (filePath: string): Promise<void> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (!fs.existsSync(filePath)) return
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error(`conversation file still exists after delete: ${filePath}`)
}

describe('history full-text search', () => {
  let app: RunningApp
  let browser: E2EBrowser

  beforeAll(async () => {
    app = await startApp()
    try {
      // Seed app_state.json (checkForUpdates: false) BEFORE the session so
      // startup never fires the update checker's network fetch/toast.
      await seedAppState(app.home)
      browser = await createSession(app.binary, app.port)
    } catch (err) {
      await app.stop()
      throw err
    }
    // Wait for the app chrome to be live before any test drives it.
    await browser.waitUntil(
      async () => {
        try {
          const tabBar = await browser.$('header.tab-bar')
          return tabBar.isExisting()
        } catch {
          return false
        }
      },
      { timeout: 60_000, timeoutMsg: 'tab bar did not render within 60s of session start' }
    )
  })

  afterEach(async (ctx) => {
    await screenshotOnFailure(browser, ctx)
  })

  afterAll(async () => {
    await destroySession(browser)
    await app?.stop()
  })

  it('lists all conversations newest-first with plain previews on an empty query', async () => {
    await startTest(browser, app.home, standardFixtures(), 3)

    // Empty query renders no highlight marks (snippet is null -> plain preview).
    expect(await getMarkCount(browser)).toBe(0)

    // Recent sort is the default: alpha (newest mtime) -> beta -> gamma.
    await browser.waitUntil(
      async () => (await getRowTitles(browser)).join('|') ===
        'Alpha Conversation|Beta Conversation|Gamma Conversation',
      { timeout: 30_000, timeoutMsg: 'recent ordering did not match newest-first' }
    )
  })

  it('matches all terms (AND) and highlights each with <mark>', async () => {
    await startTest(browser, app.home, standardFixtures(), 3)

    // Only alpha contains BOTH "zeppelin" and "autopilot".
    await setSearchQuery(browser, 'zeppelin autopilot')
    await waitForResults(browser, 1)

    const titles = await getRowTitles(browser)
    expect(titles).toEqual(['Alpha Conversation'])

    // Both query terms are highlighted in the snippet.
    await browser.waitUntil(
      async () => {
        const marks = (await getMarkTexts(browser)).join(' ').toLowerCase()
        return marks.includes('zeppelin') && marks.includes('autopilot')
      },
      { timeout: 30_000, timeoutMsg: 'expected both terms to be <mark>-highlighted' }
    )
  })

  it('matches a single term across multiple conversations', async () => {
    await startTest(browser, app.home, standardFixtures(), 3)

    // "zeppelin" appears in both alpha and beta, not gamma.
    await setSearchQuery(browser, 'zeppelin')
    await waitForResults(browser, 2)

    const titles = await getRowTitles(browser)
    expect(titles.sort()).toEqual(['Alpha Conversation', 'Beta Conversation'])
  })

  it('shows the empty state when nothing matches', async () => {
    await startTest(browser, app.home, standardFixtures(), 3)

    await setSearchQuery(browser, 'xyzzynonexistentterm')
    await waitForResults(browser, 0)

    const emptyText = await browser.execute(() =>
      document.querySelector('.history-empty')?.textContent ?? ''
    )
    expect(emptyText).toContain('No matching conversations')
  })

  it('re-indexes a conversation when its file mtime changes on disk', async () => {
    await startTest(browser, app.home, standardFixtures(), 3)

    // The word is absent at first.
    await setSearchQuery(browser, 'xylophone')
    await waitForResults(browser, 0)

    // Append a unique word to alpha's file; this bumps its mtime, which the
    // metadata-only listing detects to reload just that file.
    const alphaPath = conversationFilePath(app.home, 'e2e-alpha')
    await fs.promises.appendFile(alphaPath, '\nxylophone music plays on\n', 'utf8')

    // Clear (forces a re-list that picks up the new mtime) then search again.
    await setSearchQuery(browser, '')
    await waitForResults(browser, 3)
    await setSearchQuery(browser, 'xylophone')
    await waitForResults(browser, 1)

    const titles = await getRowTitles(browser)
    expect(titles).toEqual(['Alpha Conversation'])
    await browser.waitUntil(
      async () => (await getMarkTexts(browser)).join(' ').toLowerCase().includes('xylophone'),
      { timeout: 30_000, timeoutMsg: 'appended term was not highlighted after re-index' }
    )
  })

  it('deletes a conversation from the UI and from disk', async () => {
    await startTest(browser, app.home, standardFixtures(), 3)

    const gammaPath = conversationFilePath(app.home, 'e2e-gamma')
    expect(fs.existsSync(gammaPath)).toBe(true)

    // Open the inline confirm on gamma's row via its trash button.
    await browser.execute(() => {
      const rows = Array.from(document.querySelectorAll('.history-row'))
      const row = rows.find((r) =>
        r.querySelector('.history-row-title-line h3')?.textContent?.includes('Gamma Conversation')
      )
      if (!row) throw new Error('gamma row not found')
      ;(row.querySelector('.history-row-trash') as HTMLButtonElement).click()
    })

    await waitFor(browser, '.history-confirm-btn--danger')
    await click(browser, '.history-confirm-btn--danger')

    // The row disappears from the live results and the file is removed on disk.
    await waitForResults(browser, 2)
    await waitForFileGone(gammaPath)
  })

  it('switches between recent and alphabetical sort modes', async () => {
    await startTest(browser, app.home, sortFixtures(), 3)

    // Default recent sort: newest mtime first (Zebra, Mountain, Apple).
    await browser.waitUntil(
      async () => (await getRowTitles(browser)).join('|') === 'Zebra Trip|Mountain Hike|Apple Pie',
      { timeout: 30_000, timeoutMsg: 'recent sort order did not match' }
    )

    await setSortMode(browser, 'alphabetical')
    await browser.waitUntil(
      async () => (await getRowTitles(browser)).join('|') === 'Apple Pie|Mountain Hike|Zebra Trip',
      { timeout: 30_000, timeoutMsg: 'alphabetical sort order did not match' }
    )

    // Toggling back restores the recent order.
    await setSortMode(browser, 'recent')
    await browser.waitUntil(
      async () => (await getRowTitles(browser)).join('|') === 'Zebra Trip|Mountain Hike|Apple Pie',
      { timeout: 30_000, timeoutMsg: 'recent sort order did not restore' }
    )
  })

  it('opens a conversation from a search hit and closes the panel', async () => {
    const openConv = makeConversation({
      id: 'e2e-open',
      title: 'Open Me',
      sections: [{ role: 'user', nodes: [{ kind: 'text', text: 'xylograph quasar beacon' }] }]
    })
    await startTest(browser, app.home, [{ data: openConv, mtime: MTIME_BASE }], 1)

    // Click the row body (not the trash) to open the conversation.
    await browser.execute(() => {
      const row = document.querySelector('.history-row') as HTMLElement | null
      if (!row) throw new Error('no history row to open')
      row.click()
    })

    await waitForOverlayGone(browser)

    // The opened conversation's content lands in the CodeMirror editor.
    await browser.waitUntil(
      async () => {
        const text = await browser.execute(() =>
          document.querySelector('.cm-content')?.textContent ?? ''
        )
        return text.includes('xylograph')
      },
      { timeout: 30_000, timeoutMsg: 'opened conversation content did not appear in the editor' }
    )
  })
})
