import fs from 'node:fs'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { startApp, type RunningApp } from './harness/app'
import { click, screenshotOnFailure, typeInto, waitFor, waitForValue } from './harness/dom'
import { seedRawAppState } from './harness/fixtures'
import { createSession, destroySession, type E2EBrowser } from './harness/session'
import { sbpCall } from './harness/thread'

// The Settings panes with classic scrollbars, which take layout width (as
// on macOS with a mouse, or with "Show scroll bars: Always"). When such a
// scrollbar came or went, WebKit kept the rows of the pane at their old
// width, so the scrollbar covered their right edge, or a gap stayed after
// it went away. `.settings-scroller` (SettingsView.vue) keeps the room for
// the scrollbar at all times. Each check reads how far the pane's children
// end past its content box. The checks of an overflowing pane also expect
// a classic scrollbar, so they cannot pass with overlay scrollbars.
//
// WebKitGTK draws overlay scrollbars unless GTK's `gtk-overlay-scrolling`
// is off. The app's HOME is the harness temp dir, so the spec turns it off
// there two ways: in a GSettings keyfile (GTK reads GSettings on Wayland)
// and in settings.ini (X11 with no XSETTINGS manager, as under xvfb-run).
//
// The checks run in the order that showed the bug: the first look at a
// pane after its scrollbar came or went. A later relayout of the pane
// (for example a hover style) hid the bug again.

// No server listens here, so the models request fails at once, and its
// error makes the provider detail taller, as in the user's report.
const DEAD_URL = 'http://127.0.0.1:9/v1'

const PROMPT_COUNT = 30

interface PaneFit {
  classicScrollbar: boolean
  overflows: boolean
  /** How far the widest child ends past the pane's content box, in px;
   *  negative when it ends short of it. */
  overhang: number
}

function seedClassicScrollbars (home: string): void {
  const gsettingsDir = path.join(home, '.config', 'glib-2.0', 'settings')
  fs.mkdirSync(gsettingsDir, { recursive: true })
  fs.writeFileSync(path.join(gsettingsDir, 'keyfile'), '[org/gnome/desktop/interface]\noverlay-scrolling=false\n')
  const gtkDir = path.join(home, '.config', 'gtk-3.0')
  fs.mkdirSync(gtkDir, { recursive: true })
  fs.writeFileSync(path.join(gtkDir, 'settings.ini'), '[Settings]\ngtk-overlay-scrolling=false\n')
}

describe('Settings panes with classic scrollbars', () => {
  let app: RunningApp
  let browser: E2EBrowser

  async function paneFit (selector: string): Promise<PaneFit> {
    return browser.execute((sel: string) => {
      const pane = document.querySelector<HTMLElement>(sel)
      if (!pane) throw new Error(`paneFit: element not found: ${sel}`)
      const paddingBoxRight = pane.getBoundingClientRect().left + pane.clientLeft + pane.clientWidth
      const contentRight = paddingBoxRight - parseFloat(getComputedStyle(pane).paddingRight)
      const childRight = Math.max(...Array.from(pane.children, (child) => child.getBoundingClientRect().right))
      return {
        // The panes have no border, so this is the scrollbar or its gutter.
        classicScrollbar: pane.offsetWidth > pane.clientWidth,
        overflows: pane.scrollHeight > pane.clientHeight,
        overhang: Math.round(childRight - contentRight),
      }
    }, selector)
  }

  async function openSection (section: string, readySelector: string): Promise<void> {
    await sbpCall(browser, 'dez.model/settings/open', section)
    await waitFor(browser, readySelector, 10_000)
  }

  beforeAll(async () => {
    app = await startApp({ env: { GSETTINGS_BACKEND: 'keyfile' } })
    try {
      seedClassicScrollbars(app.home)
      const customProviders = [{ id: 'tall', name: 'Tall Provider', baseUrl: DEAD_URL }]
      // Enough rows to make the provider list scroll.
      for (let i = 0; i < 12; i++) customProviders.push({ id: `extra${i}`, name: `Extra Provider ${i}`, baseUrl: DEAD_URL })
      await seedRawAppState(app.home, { customProviders })
      const prompts = Array.from({ length: PROMPT_COUNT }, (_, i) => ({ id: `prompt${i}`, name: `Prompt ${i}`, content: `Text ${i}` }))
      fs.writeFileSync(path.join(app.home, '.config', 'dez', 'prompts.json'), JSON.stringify(prompts))
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

  it('keeps the Providers rows clear of their scrollbars', async () => {
    await openSection('providers', '.provider-manager .provider-row')
    expect(await paneFit('.provider-sidebar')).toEqual({ classicScrollbar: true, overflows: true, overhang: 0 })
    await click(browser, '.provider-row[data-provider-id="openrouter"]')
    await waitForValue(browser, 'OpenRouter details', () => browser.execute(() =>
      document.querySelector('.provider-detail-name')?.textContent?.trim()), 'OpenRouter')
    expect((await paneFit('.provider-detail')).overhang).toBe(0)

    await click(browser, '.provider-row[data-provider-id="tall"]')
    await waitForValue(browser, 'models error', () => browser.execute(() =>
      document.querySelector('.provider-detail .provider-models-status--error') !== null), true)
    expect(await paneFit('.provider-detail')).toEqual({ classicScrollbar: true, overflows: true, overhang: 0 })
  })

  it('keeps the Shortcuts rows clear of the pane scrollbar, and General at full width after', async () => {
    await openSection('shortcuts', '.shortcut-manager')
    expect(await paneFit('.settings-content')).toEqual({ classicScrollbar: true, overflows: true, overhang: 0 })
    await openSection('general', '.settings-model-picker')
    expect((await paneFit('.settings-content')).overhang).toBe(0)
  })

  it('keeps the prompt rows clear of their scrollbar when the search changes', async () => {
    await openSection('prompts', '.prompt-list')
    await typeInto(browser, '.prompt-search', 'Prompt 7', { clear: true })
    await waitForValue(browser, 'prompt rows for "Prompt 7"', () => browser.execute(() =>
      document.querySelectorAll('.prompt-list .prompt-row').length), 1)
    expect((await paneFit('.prompt-list')).overhang).toBe(0)

    await typeInto(browser, '.prompt-search', '', { clear: true })
    await waitForValue(browser, 'prompt rows with no search', () => browser.execute(() =>
      document.querySelectorAll('.prompt-list .prompt-row').length), PROMPT_COUNT)
    expect(await paneFit('.prompt-list')).toEqual({ classicScrollbar: true, overflows: true, overhang: 0 })
  })
})
