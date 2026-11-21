import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { startApp, type RunningApp } from './harness/app'
import { screenshotOnFailure, waitFor, waitForValue, withSmallerWindow } from './harness/dom'
import { seedAppState } from './harness/fixtures'
import { createSession, destroySession, type E2EBrowser } from './harness/session'
import { sbpCall } from './harness/thread'

// The layout of Settings › General, from the user's report: the cleanup
// buttons sat at the left edge while every other control sat at the right,
// and in the wide pane a label was so far from its control that the user
// could not tell which label went with which control. The page is now
// titled groups of boxed rows: a label and a hint at the left, the control
// at the right. The checks read the boxes of every control of the page, in
// the default window and in the narrowest one (`minWidth`,
// tauri.conf.json).

/** One control of the page (every button of the General section), as the
 *  page lays it out. */
interface Control {
  /** The accessible name: the texts of `aria-labelledby`, or the text. */
  name: string
  right: number
  width: number
  /** What ties the control to its row badly, if anything. */
  problems: string[]
}

const NARROWEST_WINDOW = 600

describe('Settings › General layout', () => {
  let app: RunningApp
  let browser: E2EBrowser

  // Reads the controls of the General section. A control's row is its
  // `.settings-card-row`: the row must hold one label, hold the label and
  // the control from top to bottom, keep the label left of the control, and
  // sit in a card with a border. A control with `aria-labelledby` must have
  // its row label in its name; one without must have text of its own. Its
  // `aria-describedby` must name text in its row (the hint).
  async function controls (): Promise<Control[]> {
    return browser.execute(() => {
      const section = document.querySelector('.settings-section')
      if (!section) throw new Error('controls: no Settings section')
      const text = (el: Element | null): string => el?.textContent?.replace(/\s+/g, ' ').trim() ?? ''
      const byIds = (ids: string): Element[] => ids.split(/\s+/).flatMap((id) => document.getElementById(id) ?? [])
      return Array.from(section.querySelectorAll('button'), (control) => {
        const labelledBy = control.getAttribute('aria-labelledby')
        const name = labelledBy ? byIds(labelledBy).map(text).join(' ') : text(control)
        const box = control.getBoundingClientRect()
        const problems: string[] = []
        const row = control.closest('.settings-card-row')
        if (!row) return { name, right: box.right, width: box.width, problems: ['no row'] }
        const rowBox = row.getBoundingClientRect()
        const labels = row.querySelectorAll('.settings-card-label')
        if (labels.length !== 1) problems.push(`${labels.length} labels in its row`)
        const label = labels[0]
        if (label) {
          const labelBox = label.getBoundingClientRect()
          if (labelBox.top < rowBox.top || labelBox.bottom > rowBox.bottom) problems.push('label out of its row')
          if (labelBox.right > box.left) problems.push('label runs under the control')
          if (labelledBy ? !name.includes(text(label)) : name === '') problems.push('no row label in its name')
        }
        if (box.top < rowBox.top || box.bottom > rowBox.bottom) problems.push('control out of its row')
        const card = row.closest('.settings-card')
        if (!card || parseFloat(getComputedStyle(card).borderTopWidth) < 1) problems.push('row in no card with a border')
        const described = byIds(control.getAttribute('aria-describedby') ?? '')
        if (described.length === 0 || described.some((hint) => !row.contains(hint) || text(hint) === '')) problems.push('no hint of its row as its description')
        return { name, right: box.right, width: box.width, problems }
      })
    })
  }

  // The names of the controls that do not end at the right edge of the
  // control that ends furthest right, ±1 px.
  function offRightEdge (all: Control[]): string[] {
    const edge = Math.max(...all.map((control) => control.right))
    return all.filter((control) => Math.abs(control.right - edge) > 1).map((control) => control.name)
  }

  function rowProblems (all: Control[]): string[] {
    return all.flatMap((control) => control.problems.map((problem) => `${control.name}: ${problem}`))
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
    await sbpCall(browser, 'dez.model/settings/open', 'general')
    await waitFor(browser, '.settings-model-picker', 10_000)
  })

  afterEach(async (ctx) => {
    await screenshotOnFailure(browser, ctx)
  })

  afterAll(async () => {
    await destroySession(browser)
    await app?.stop()
  })

  it('ends every control at one right edge', async () => {
    const all = await controls()
    expect(all.length).toBeGreaterThan(0)
    expect(offRightEdge(all)).toEqual([])
  })

  it('puts each control in a boxed row with its label and its hint', async () => {
    expect(rowProblems(await controls())).toEqual([])
  })

  it('gives the two cleanup buttons one width', async () => {
    const widths = await browser.execute(() => ['.unused-files-btn', '.unused-apps-btn'].map((selector) =>
      document.querySelector(selector)?.getBoundingClientRect().width ?? null))
    expect(widths[0]).not.toBeNull()
    expect(widths[1]).toBe(widths[0])
  })

  it('keeps the layout in the narrowest window', async () => {
    await withSmallerWindow(browser, ({ height }) => ({ width: NARROWEST_WINDOW, height }), async () => {
      await waitForValue(browser, 'narrow page', async () => await browser.execute(() => window.innerWidth) <= NARROWEST_WINDOW, true)
      const all = await controls()
      expect(offRightEdge(all)).toEqual([])
      expect(rowProblems(all)).toEqual([])
    })
  })
})
