import type { EditorView } from '@codemirror/view'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { Key } from 'webdriverio'
import { startApp, type RunningApp } from './harness/app'
import { click, screenshotOnFailure, typeKeys, waitFor, waitForValue } from './harness/dom'
import { makeConversation, seedAppState, seedConversation } from './harness/fixtures'
import { createSession, destroySession, type E2EBrowser } from './harness/session'
import { focusEditor, sbpCall, threadSections } from './harness/thread'

const MAX_CLICKS = 40
// Clicks to make while the tabs overflow the strip, counting the click that
// first makes them overflow.
const OVERFLOWING_CLICKS = 3

interface TabBarState {
  tabCount: number
  overflows: boolean
  view: {
    newTabButtonInHeader: boolean
    newTabButtonOnTop: boolean
    lastTabActive: boolean
    activeTabVisible: boolean
  }
}

// Where the new-tab button and the active tab are on screen. The strip is
// the scrolling parent of the tabs; a part of it outside its box is
// scrolled out of view.
async function tabBarState (browser: E2EBrowser): Promise<TabBarState> {
  return browser.execute(() => {
    const header = document.querySelector('header.tab-bar')
    const button = document.querySelector('.tab-new')
    const tabs = Array.from(document.querySelectorAll('.tab'))
    const strip = tabs[0]?.parentElement
    const active = document.querySelector('.tab--active')
    if (!header || !button || !strip || !active) throw new Error('tab bar parts not found')

    const inside = (inner: DOMRect, outer: DOMRect): boolean =>
      inner.left >= outer.left - 0.5 && inner.right <= outer.right + 0.5 &&
      inner.top >= outer.top - 0.5 && inner.bottom <= outer.bottom + 0.5
    const buttonRect = button.getBoundingClientRect()
    const headerRect = header.getBoundingClientRect()
    const hit = document.elementFromPoint(
      buttonRect.left + buttonRect.width / 2,
      buttonRect.top + buttonRect.height / 2
    )
    const activeRect = active.getBoundingClientRect()
    return {
      tabCount: tabs.length,
      overflows: strip.scrollWidth > strip.clientWidth,
      view: {
        newTabButtonInHeader: buttonRect.width > 0 && inside(buttonRect, headerRect),
        newTabButtonOnTop: hit !== null && button.contains(hit),
        lastTabActive: active === tabs[tabs.length - 1],
        activeTabVisible: inside(activeRect, strip.getBoundingClientRect()) && inside(activeRect, headerRect),
      },
    }
  })
}

// The tab titles in tab bar order, and the index of the active tab.
async function tabStrip (browser: E2EBrowser): Promise<{ titles: string[], active: number }> {
  return browser.execute(() => {
    const tabs = Array.from(document.querySelectorAll('.tab-strip > .tab'))
    return {
      titles: tabs.map((tab) => tab.querySelector('.tab-title')?.textContent ?? ''),
      active: tabs.findIndex((tab) => tab.classList.contains('tab--active')),
    }
  })
}

async function conversationIds (browser: E2EBrowser): Promise<string[]> {
  const tabs = await sbpCall(browser, 'dez.model/tabs/list') as Array<{ conversationId: string }>
  return tabs.map((tab) => tab.conversationId)
}

// The doc line at the top of the editor's view and the caret, read two
// frames after the last change so that its scroll work is done.
async function viewPlace (browser: E2EBrowser): Promise<{ topLine: number, caret: number }> {
  return browser.execute(() => new Promise<{ topLine: number, caret: number }>((resolve, reject) => {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const content = document.querySelector('.cm-content')
      if (!content) {
        reject(new Error('viewPlace: .cm-content not found'))
        return
      }
      const view = Reflect.get(Reflect.get(content, 'cmTile'), 'root').view as EditorView
      const block = view.lineBlockAtHeight(view.scrollDOM.getBoundingClientRect().top - view.documentTop)
      resolve({ topLine: view.state.doc.lineAt(block.from).number, caret: view.state.selection.main.head })
    }))
  }))
}

const VISIBLE = {
  newTabButtonInHeader: true,
  newTabButtonOnTop: true,
  lastTabActive: true,
  activeTabVisible: true,
}

describe('tab bar', () => {
  let app: RunningApp
  let browser: E2EBrowser

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

  afterEach(async (ctx) => {
    await screenshotOnFailure(browser, ctx)
  })

  afterAll(async () => {
    await destroySession(browser)
    await app?.stop()
  })

  // Regression: the `+` was the last item of the scrolling strip, so after a
  // click the strip scrolled the new tab to its right edge and the `+` out
  // of view.
  it('keeps the new-tab button visible while tabs overflow the strip', async () => {
    let tabCount = (await tabBarState(browser)).tabCount
    let overflowingClicks = 0

    for (let clickNumber = 1; clickNumber <= MAX_CLICKS && overflowingClicks < OVERFLOWING_CLICKS; clickNumber++) {
      await click(browser, '.tab-new')
      tabCount += 1
      // The read that matches also tells whether the tabs overflow now.
      let overflows = false
      await waitForValue(browser, `tab bar after click ${clickNumber}`, async () => {
        const state = await tabBarState(browser)
        overflows = state.overflows
        return { tabCount: state.tabCount, view: state.view }
      }, { tabCount, view: VISIBLE })
      if (overflows) overflowingClicks += 1
    }

    expect(overflowingClicks, 'clicks made while the tabs overflow the strip').toBe(OVERFLOWING_CLICKS)

    // Scrolled back to the first tab, the button must still be on screen.
    await browser.execute(() => {
      const strip = document.querySelector('.tab')?.parentElement
      if (strip) strip.scrollLeft = 0
    })
    await waitForValue(browser, 'new-tab button with the strip scrolled to the start', async () => {
      const { newTabButtonInHeader, newTabButtonOnTop } = (await tabBarState(browser)).view
      return { newTabButtonInHeader, newTabButtonOnTop }
    }, { newTabButtonInHeader: true, newTabButtonOnTop: true })
  })

  // Ctrl+W, then Ctrl+Shift+T: the tab comes back at its place, active, with
  // its title and the text that was typed but never sent (it is not on
  // disk). Before the fix, Ctrl+Shift+T opened a new tab, as Ctrl+T does.
  // browser.keys skip GTK, so this tests the page handler, not the menu
  // accelerators.
  it('reopens a closed tab with Ctrl+Shift+T, and Ctrl+T still opens a new tab', async () => {
    const start = (await tabStrip(browser)).titles
    const typedIndex = start.length
    const withTypedTab = [...start, 'Unsent words', 'New Tab']

    await focusEditor(browser)
    await browser.keys([Key.Control, 't'])
    await waitForValue(browser, 'tabs after Ctrl+T', () => tabStrip(browser), { titles: [...start, 'New Tab'], active: typedIndex })
    await focusEditor(browser)
    await typeKeys(browser, 'Unsent words')
    await browser.keys([Key.Control, 't'])
    await waitForValue(browser, 'tabs after typing and Ctrl+T', () => tabStrip(browser), { titles: withTypedTab, active: typedIndex + 1 })

    const typedConversationId = (await conversationIds(browser))[typedIndex]
    await click(browser, `.tab-strip > .tab:nth-child(${typedIndex + 1})`)
    await waitForValue(browser, 'typed tab selected', () => tabStrip(browser), { titles: withTypedTab, active: typedIndex })
    await focusEditor(browser)
    await browser.keys([Key.Control, 'w'])
    await waitForValue(browser, 'tabs after Ctrl+W', () => tabStrip(browser), { titles: [...start, 'New Tab'], active: typedIndex })

    await focusEditor(browser)
    await browser.keys([Key.Control, Key.Shift, 't'])
    await waitForValue(browser, 'tabs after Ctrl+Shift+T', () => tabStrip(browser), { titles: withTypedTab, active: typedIndex })
    expect((await conversationIds(browser))[typedIndex]).toBe(typedConversationId)
    expect(await threadSections(browser)).toEqual([{ role: 'user', text: 'Unsent words' }])

    await focusEditor(browser)
    await browser.keys([Key.Control, 't'])
    const withNewTab = [...withTypedTab, 'New Tab']
    await waitForValue(browser, 'tabs after Ctrl+T', () => tabStrip(browser), { titles: withNewTab, active: withNewTab.length - 1 })
    expect(await threadSections(browser)).toEqual([{ role: 'user', text: '' }])
  })

  // Regression: a tab came back at the top of its doc, with the caret at the
  // doc start, after a tab switch and after Ctrl+Shift+T.
  it('shows a tab where the user left it, after a tab switch and after Ctrl+Shift+T', async () => {
    const id = 'tabs-e2e-long'
    const text = Array.from({ length: 150 }, (_, i) => `line ${i + 1}`).join('\n')
    await seedConversation(app.home, makeConversation({
      id,
      title: id,
      sections: [
        { role: 'user', nodes: [{ kind: 'text', text }] },
        { role: 'agent', nodes: [{ kind: 'text', text: 'Reply.' }] },
      ],
    }))
    await sbpCall(browser, 'dez.model/tabs/openConversation', id)
    let opened = { titles: [] as string[], active: -1 }
    await waitForValue(browser, 'long tab open', async () => {
      opened = await tabStrip(browser)
      return opened.titles[opened.active]
    }, id)
    const longTab = `.tab-strip > .tab:nth-child(${opened.active + 1})`

    // Focus first: a script focus of the editor scrolls it to the caret.
    await focusEditor(browser)
    await browser.keys([Key.Control, Key.End])
    const docLength = await browser.execute(() => {
      const content = document.querySelector('.cm-content')
      if (!content) throw new Error('docLength: .cm-content not found')
      return (Reflect.get(Reflect.get(content, 'cmTile'), 'root').view as EditorView).state.doc.length
    })
    let bottom = { topLine: 0, caret: 0 }
    await waitForValue(browser, 'caret at the doc end', async () => {
      bottom = await viewPlace(browser)
      return bottom.caret
    }, docLength)
    expect(bottom.topLine).toBeGreaterThan(100)

    await browser.keys([Key.Control, 't'])
    await waitForValue(browser, 'new tab active', async () => (await tabStrip(browser)).active, opened.titles.length)
    await click(browser, longTab)
    await waitForValue(browser, 'long tab active', async () => (await tabStrip(browser)).active, opened.active)
    await waitForValue(browser, 'place after the tab switch', () => viewPlace(browser), bottom)

    await focusEditor(browser)
    await browser.keys([Key.Control, 'w'])
    // By conversation id: the tab title is now the first user line, not id.
    await waitForValue(browser, 'long tab closed', async () => (await conversationIds(browser)).includes(id), false)
    await focusEditor(browser)
    await browser.keys([Key.Control, Key.Shift, 't'])
    // The index alone is true before the reopen: the close activates the
    // new tab, which moves into the long tab's index.
    await waitForValue(browser, 'long tab reopened', async () => {
      const { active } = await tabStrip(browser)
      return { conversationId: (await conversationIds(browser))[active], active }
    }, { conversationId: id, active: opened.active })
    await waitForValue(browser, 'place after Ctrl+Shift+T', () => viewPlace(browser), bottom)
  })
})
