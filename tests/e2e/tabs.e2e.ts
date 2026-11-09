import type { EditorView } from '@codemirror/view'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Key } from 'webdriverio'
import type { ModelRef, Tab } from '../../src/model/chat/types'
import type { SectionData } from '../../src/model/persistence/types'
import { startApp, type RunningApp } from './harness/app'
import {
  click,
  consoleErrors,
  openHistoryPanel,
  pointerClick,
  pointerClickAt,
  pointerDrag,
  pointerRelease,
  resetConsoleErrors,
  screenshotOnFailure,
  typeKeys,
  waitFor,
  waitForValue,
  type Point,
} from './harness/dom'
import { makeConversation, readAppState, seedAppState, seedConversation } from './harness/fixtures'
import { createSession, destroySession, type E2EBrowser } from './harness/session'
import {
  activeConversationId,
  activeTabId,
  editorDoc,
  focusEditor,
  focusedArea,
  newTab,
  savedPillLines,
  sbpCall,
  threadSections,
} from './harness/thread'

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

async function tabIds (browser: E2EBrowser): Promise<string[]> {
  const tabs = await sbpCall(browser, 'dez.model/tabs/list') as Array<{ id: string }>
  return tabs.map((tab) => tab.id)
}

async function horizontalBounds (browser: E2EBrowser, selector: string): Promise<{ left: number, right: number }> {
  return browser.execute((sel: string) => {
    const element = document.querySelector(sel)
    if (!element) throw new Error(`horizontalBounds: element not found: ${sel}`)
    const { left, right } = element.getBoundingClientRect()
    return { left, right }
  }, selector)
}

// How far the tab strip scrolls, and how far it is scrolled now.
async function stripScroll (browser: E2EBrowser): Promise<{ max: number, left: number }> {
  return browser.execute(() => {
    const strip = document.querySelector('.tab-strip')
    if (!strip) throw new Error('stripScroll: .tab-strip not found')
    return { max: strip.scrollWidth - strip.clientWidth, left: strip.scrollLeft }
  })
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

// A tab's sections as the store holds them, with the fields that the
// editor's section models carry (id, role, model, thinking) and the text.
async function tabSections (browser: E2EBrowser, tabId: string): Promise<Array<{
  id: string
  role: string
  text: string
  model: ModelRef | null
  thinking: string | null
}>> {
  const tab = await sbpCall(browser, 'dez.model/tab', tabId) as Tab | null
  if (!tab) throw new Error(`tabSections: no tab ${tabId}`)
  return tab.sections.map((section) => ({
    id: section.id,
    role: section.role,
    text: section.content.map((node) => node.kind === 'text' ? node.text : '').join(''),
    model: section.model ?? null,
    thinking: section.thinking?.text ?? null,
  }))
}

// The center of the title of the History row titled `title`, or null while
// the panel shows no such row.
async function historyRowCenter (browser: E2EBrowser, title: string): Promise<Point | null> {
  return browser.execute((wanted: string) => {
    const heading = Array.from(document.querySelectorAll('.history-row h3')).find((h3) => h3.textContent === wanted)
    if (!heading) return null
    const rect = heading.getBoundingClientRect()
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }
  }, title)
}

// Opens a saved conversation as the user does: a click on its History row.
async function openFromHistory (browser: E2EBrowser, title: string): Promise<void> {
  await openHistoryPanel(browser)
  await waitForValue(browser, `History row "${title}"`, async () => (await historyRowCenter(browser, title)) !== null, true)
  const row = await historyRowCenter(browser, title)
  if (!row) throw new Error(`openFromHistory: no History row "${title}"`)
  await pointerClickAt(browser, row)
  await waitForValue(browser, 'History panel closed', async () => (await browser.$('.history-overlay')).isExisting(), false)
}

// Questions and answers that end with an empty user section, as a saved
// reply leaves a thread. Each answer has `model` and its own thinking.
function questionsAndAnswers (name: string, turns: number, model: ModelRef): SectionData[] {
  const sections: SectionData[] = []
  for (let turn = 1; turn <= turns; turn++) {
    sections.push({ role: 'user', nodes: [{ kind: 'text', text: `${name} question ${turn}` }] })
    sections.push({
      role: 'agent',
      nodes: [{ kind: 'text', text: `${name} answer ${turn}` }],
      model,
      thinking: { text: `${name} thinking ${turn}` },
    })
  }
  sections.push({ role: 'user', nodes: [] })
  return sections
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
    const docLength = (await editorDoc(browser)).length
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

  // A new tab takes the focus, so the user can type in it at once. A press
  // on `+` takes the focus, and a click on a tab moves it out of the
  // editor, so both checks start with the focus outside the editor. Before
  // the fix, the typed keys went nowhere. With Settings open, Ctrl+T still
  // makes a tab behind it, and the focus stays in Settings.
  it('focuses the editor of a new tab, except while Settings is open', async () => {
    const start = (await tabStrip(browser)).titles

    await pointerClick(browser, '.tab-new')
    await waitForValue(browser, 'focus after a click on +', () => focusedArea(browser), 'editor')
    await typeKeys(browser, 'Plus words')
    const afterPlus = [...start, 'Plus words']
    await waitForValue(browser, 'tabs after typing in the + tab', () => tabStrip(browser), { titles: afterPlus, active: start.length })

    // On the title: the tab's center can be on its close button.
    await pointerClick(browser, '.tab--active .tab-title')
    await waitForValue(browser, 'focus after a click on a tab', () => focusedArea(browser), 'body')
    await browser.keys([Key.Control, 't'])
    await waitForValue(browser, 'focus after Ctrl+T', () => focusedArea(browser), 'editor')
    await typeKeys(browser, 'Key words')
    const afterKey = [...afterPlus, 'Key words']
    await waitForValue(browser, 'tabs after typing in the Ctrl+T tab', () => tabStrip(browser), { titles: afterKey, active: afterPlus.length })

    await sbpCall(browser, 'dez.model/settings/open', 'general')
    await waitFor(browser, '.settings-nav-btn')
    await pointerClick(browser, '.settings-nav-btn')
    await waitForValue(browser, 'focus after a click in Settings', () => focusedArea(browser), 'button')
    await browser.keys([Key.Control, 't'])
    await waitForValue(browser, 'tabs after Ctrl+T in Settings', () => tabStrip(browser), { titles: [...afterKey, 'New Tab'], active: afterKey.length })
    expect(await focusedArea(browser)).toBe('button')
    expect(await sbpCall(browser, 'dez.model/settings/isOpen')).toBe(true)

    await browser.keys([Key.Escape])
    await waitForValue(browser, 'Settings open', () => sbpCall(browser, 'dez.model/settings/isOpen'), false)
  })
})

// Tabs move by mouse drag, with pointer events (see TabBar.vue). The model
// order changes once, at the drop.
describe('tab drag', () => {
  const TITLES = ['One', 'Two', 'Three', 'Four']
  const MAX_EXTRA_TABS = 60
  let app: RunningApp
  let browser: E2EBrowser

  beforeAll(async () => {
    app = await startApp()
    try {
      // The text is the title, so the title stays when the editor derives it
      // from the first user line. The agent lines are text for a drag to
      // cross.
      for (const title of TITLES) {
        await seedConversation(app.home, makeConversation({
          id: `conv-${title}`,
          title,
          sections: [
            { role: 'user', nodes: [{ kind: 'text', text: title }] },
            { role: 'agent', nodes: [{ kind: 'text', text: 'A line of thread text.\nAnother line of thread text.' }] },
          ],
        }))
      }
      await seedAppState(app.home, {
        tabs: TITLES.map((title) => ({ id: `tab-${title}`, title, conversationId: `conv-${title}`, activeModel: null, createdAt: Date.now() })),
        activeTabId: 'tab-Four',
      })
      browser = await createSession(app.binary, app.port)
    } catch (err) {
      await app.stop()
      throw err
    }
    await waitFor(browser, 'header.tab-bar', 60_000)
    await waitForValue(browser, 'seeded tabs', () => tabStrip(browser), { titles: TITLES, active: 3 })
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

  it('moves a tab dragged past the third tab, makes it active, and saves the order', async () => {
    const third = await horizontalBounds(browser, '.tab-strip > .tab:nth-child(3)')
    // Past the middle of the third tab, not past the middle of the fourth.
    await pointerDrag(browser, '.tab-strip > .tab:nth-child(1) .tab-title', third.right - 2)

    const moved = ['Two', 'Three', 'One', 'Four']
    await waitForValue(browser, 'bar after the drag', () => tabStrip(browser), { titles: moved, active: 2 })
    await waitForValue(browser, 'saved tabs after the drag', async () => {
      const saved = await readAppState(app.home)
      return { titles: (saved?.tabs as Array<{ title: string }> | undefined)?.map((tab) => tab.title), activeTabId: saved?.activeTabId }
    }, { titles: moved, activeTabId: 'tab-One' })
  })

  // WebKit lets a press on `user-select: none` content, such as a tab, start
  // a text selection when the pointer reaches text.
  it('selects no text when a tab drag goes down into the thread', async () => {
    const before = await tabStrip(browser)
    const activeTitle = '.tab-strip > .tab--active .tab-title'
    const tab = await horizontalBounds(browser, activeTitle)
    const lastLineY = await browser.execute(() => {
      const line = Array.from(document.querySelectorAll('.cm-content .cm-line')).at(-1)
      if (!line) throw new Error('editor line not found')
      const rect = line.getBoundingClientRect()
      return Math.round(rect.top + rect.height / 2)
    })

    // Straight down, so the tab keeps its place in the bar.
    await pointerDrag(browser, activeTitle, Math.round((tab.left + tab.right) / 2), { toY: lastLineY })

    const selection = await browser.execute(() => {
      const content = document.querySelector('.cm-content')
      if (!content) throw new Error('.cm-content not found')
      const view = Reflect.get(Reflect.get(content, 'cmTile'), 'root').view as EditorView
      return { pageText: window.getSelection()?.toString() ?? '', editorEmpty: view.state.selection.main.empty }
    })
    expect(selection).toEqual({ pageText: '', editorEmpty: true })
    expect(await tabStrip(browser)).toEqual(before)
  })

  // A move under the drag threshold is still a click.
  it('switches tabs on a click with a small move, and closes a tab with its close button', async () => {
    const order = (await tabStrip(browser)).titles
    const lastTitle = '.tab-strip > .tab:nth-child(4) .tab-title'
    const last = await horizontalBounds(browser, lastTitle)
    await pointerDrag(browser, lastTitle, Math.round((last.left + last.right) / 2) + 3)
    await waitForValue(browser, 'bar after a click on the last tab', () => tabStrip(browser), { titles: order, active: 3 })

    await pointerClick(browser, '.tab-strip > .tab:nth-child(1) .tab-close')
    await waitForValue(browser, 'bar after a click on a close button', () => tabStrip(browser), { titles: order.slice(1), active: 2 })
  })

  // A tab held at the right end of a strip that scrolls goes to a place that
  // was out of view. Until the drop, only the bar shows the new place.
  it('scrolls the strip while a tab is held at its end, and drops the tab there', async () => {
    for (let extraTabs = 0; (await stripScroll(browser)).max < 300; extraTabs++) {
      expect(extraTabs, 'new tabs before the strip scrolls 300 px').toBeLessThan(MAX_EXTRA_TABS)
      await sbpCall(browser, 'dez.model/tabs/create')
    }
    await browser.execute(() => {
      const strip = document.querySelector('.tab-strip')
      if (strip) strip.scrollLeft = 0
    })
    const ids = await tabIds(browser)
    const firstTitle = (await tabStrip(browser)).titles[0]
    const strip = await horizontalBounds(browser, '.tab-strip')

    await pointerDrag(browser, '.tab-strip > .tab:nth-child(1) .tab-title', Math.round(strip.right) - 4, { release: false })
    await waitForValue(browser, 'strip scrolled to its end', async () => {
      const { max, left } = await stripScroll(browser)
      return left >= max - 1
    }, true)
    await waitForValue(browser, 'held tab last in the bar', async () => (await tabStrip(browser)).titles.at(-1), firstTitle)
    expect(await tabIds(browser)).toEqual(ids)

    await pointerRelease(browser)
    await waitForValue(browser, 'tabs after the drop', () => tabIds(browser), [...ids.slice(1), ids[0]])
  })
})

// Regression: a tab change that also adds a tab (History opens a
// conversation that no tab has, Reopen Closed Tab) gave the tab left behind
// the section models of the new tab, when the new tab had at least as many
// sections. A blank tab then showed the new tab's role pills with no text,
// and a tab with text was saved with the other conversation's models,
// thinking, and extra empty sections.
describe('tab change that adds a tab', () => {
  const HISTORY_THREAD = makeConversation({
    id: 'tab-change-history',
    title: 'History thread',
    sections: questionsAndAnswers('History', 2, { providerId: 'seeded', modelId: 'history-model' }),
  })
  const SAVED_THREAD = makeConversation({
    id: 'tab-change-saved',
    title: 'Saved thread',
    sections: questionsAndAnswers('Saved', 1, { providerId: 'seeded', modelId: 'saved-model' }),
  })
  const CLOSED_THREAD = makeConversation({
    id: 'tab-change-closed',
    title: 'Closed thread',
    sections: questionsAndAnswers('Closed', 2, { providerId: 'seeded', modelId: 'closed-model' }),
  })
  // Leaving a tab saves it at once, and the editor's own saves wait 1 s, so
  // a wrong save of the tab left behind is on disk after this pause.
  const SAVES_DONE_MS = 1500
  let app: RunningApp
  let browser: E2EBrowser

  beforeAll(async () => {
    app = await startApp()
    try {
      await seedAppState(app.home)
      for (const conversation of [HISTORY_THREAD, SAVED_THREAD, CLOSED_THREAD]) {
        await seedConversation(app.home, conversation)
      }
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

  it('leaves a blank tab blank when History opens a longer conversation', async () => {
    await newTab(browser)
    const blankTabId = await activeTabId(browser)
    const blank = await tabSections(browser, blankTabId)

    await openFromHistory(browser, HISTORY_THREAD.title)
    await waitForValue(browser, 'History thread open', () => activeConversationId(browser), HISTORY_THREAD.id)

    await click(browser, `.tab-strip > .tab:nth-child(${(await tabIds(browser)).indexOf(blankTabId) + 1})`)
    await waitForValue(browser, 'blank tab after the switch back', async () => ({
      doc: await editorDoc(browser),
      sections: await tabSections(browser, blankTabId),
    }), { doc: '', sections: blank })
  })

  it('keeps a saved tab as it is when Reopen Closed Tab brings back a longer tab', async () => {
    // Open and close the longer thread from a blank tab, so that the setup
    // does not depend on the tab that the previous test left active.
    await newTab(browser)
    const closedTab = await sbpCall(browser, 'dez.model/tabs/openConversation', CLOSED_THREAD.id) as Tab
    await sbpCall(browser, 'dez.controller/closeTab', closedTab.id)
    await waitForValue(browser, 'longer tab closed', async () => (await conversationIds(browser)).includes(CLOSED_THREAD.id), false)

    const savedTab = await sbpCall(browser, 'dez.model/tabs/openConversation', SAVED_THREAD.id) as Tab
    await waitForValue(browser, 'saved tab in the editor', async () => (await editorDoc(browser)).startsWith('Saved question 1'), true)
    const saved = {
      sections: await tabSections(browser, savedTab.id),
      pillLines: await savedPillLines(app.home, SAVED_THREAD.id),
    }

    await focusEditor(browser)
    await browser.keys([Key.Control, Key.Shift, 't'])
    await waitForValue(browser, 'longer tab reopened', () => activeConversationId(browser), CLOSED_THREAD.id)
    await browser.pause(SAVES_DONE_MS)
    expect({
      sections: await tabSections(browser, savedTab.id),
      pillLines: await savedPillLines(app.home, SAVED_THREAD.id),
    }).toEqual(saved)
  })
})
