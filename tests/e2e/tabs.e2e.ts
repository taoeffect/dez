import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { startApp, type RunningApp } from './harness/app'
import { click, screenshotOnFailure, waitFor, waitForValue } from './harness/dom'
import { seedAppState } from './harness/fixtures'
import { createSession, destroySession, type E2EBrowser } from './harness/session'

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
})
