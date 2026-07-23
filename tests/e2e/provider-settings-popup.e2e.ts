import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startApp, type RunningApp } from './harness/app'
import { click, waitFor } from './harness/dom'
import { makeConversation, seedAppState, seedConversation } from './harness/fixtures'
import { createSession, destroySession, type E2EBrowser } from './harness/session'

// Throwaway verification spec for the provider-settings-popup task (TODO-4).
// Drives the real app: gear button toggles the popup, Venice toggles mutate
// persisted providerSettings, settings survive an app restart, and a
// non-Venice provider shows the empty state. All interaction goes through
// executed JS (harness click()/dispatched KeyboardEvent) because wry's
// automation session rejects native WebDriver click/sendKeys.
describe('provider settings popup', () => {
  let app: RunningApp
  let browser: E2EBrowser

  async function waitForTabBar (): Promise<void> {
    await waitFor(browser, 'header.tab-bar', 60_000)
  }

  async function pressEscape (): Promise<void> {
    await browser.execute(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
  }

  /** aria-checked of the Nth `.provider-settings-row`, read via executed JS. */
  async function rowChecked (index: number): Promise<string | null> {
    return browser.execute((i: number) => {
      const rows = document.querySelectorAll('.provider-settings-row')
      return rows[i]?.getAttribute('aria-checked') ?? null
    }, index)
  }

  async function popupExists (): Promise<boolean> {
    return browser.execute(() => document.querySelector('.provider-settings-popup') !== null)
  }

  beforeAll(async () => {
    app = await startApp()
    try {
      // Seed a restored tab whose activeModel is a Grok Venice model (Grok
      // keeps all four setting rows visible; non-Grok hides the X search
      // row). The app's initial default tab is created before settings load,
      // so defaultNewTabModel alone would leave activeModel null.
      const veniceModel = { providerId: 'venice', modelId: 'grok-4-20', modelName: 'grok-4-20' }
      await seedConversation(app.home, makeConversation({ id: 'conv-e2e', activeModel: veniceModel }))
      await seedAppState(app.home, {
        tabs: [{
          id: 'tab-e2e',
          title: 'New Chat',
          conversationId: 'conv-e2e',
          activeModel: veniceModel,
          createdAt: Date.now()
        }],
        activeTabId: 'tab-e2e'
      })
      browser = await createSession(app.binary, app.port)
    } catch (err) {
      await app.stop()
      throw err
    }
  })

  afterAll(async () => {
    await destroySession(browser)
    await app?.stop()
  })

  it('gear opens the popup with Venice toggle rows and toggling persists', async () => {
    await waitForTabBar()

    await click(browser, '.model-selector-gear')
    await waitFor(browser, '.provider-settings-popup')

    const headerText = await browser.execute(
      () => document.querySelector('.provider-settings-header')?.textContent?.trim() ?? ''
    )
    expect(headerText).toBe('Venice')

    const labels = await browser.execute(() =>
      Array.from(document.querySelectorAll('.provider-settings-label')).map(
        (el) => el.textContent?.trim() ?? ''
      )
    )
    expect(labels).toEqual(['Web search', 'X search', 'Web scraping', 'Venice system prompt'])

    // Defaults: web search on, Venice system prompt off.
    expect(await rowChecked(0)).toBe('true')
    expect(await rowChecked(3)).toBe('false')

    // Flip both and confirm the switch state updates in the UI.
    await browser.execute(() => {
      const rows = document.querySelectorAll<HTMLButtonElement>('.provider-settings-row')
      rows[0].click()
      rows[3].click()
    })
    expect(await rowChecked(0)).toBe('false')
    expect(await rowChecked(3)).toBe('true')

    // Escape closes the popup.
    await pressEscape()
    expect(await popupExists()).toBe(false)

    // Debounced persistence should land the overrides in app_state.json.
    const stateFile = path.join(app.home, '.config', 'dez', 'app_state.json')
    await browser.waitUntil(
      async () => {
        try {
          const state = JSON.parse(await fs.promises.readFile(stateFile, 'utf8'))
          return state.providerSettings?.venice?.webSearch === false &&
            state.providerSettings?.venice?.veniceSystemPrompt === true
        } catch {
          return false
        }
      },
      { timeout: 10_000, timeoutMsg: 'providerSettings.venice was not persisted to app_state.json' }
    )
  })

  it('persists toggles across an app restart', async () => {
    await destroySession(browser)
    browser = await createSession(app.binary, app.port)
    await waitForTabBar()

    await click(browser, '.model-selector-gear')
    await waitFor(browser, '.provider-settings-popup')
    expect(await rowChecked(0)).toBe('false')
    expect(await rowChecked(1)).toBe('true')
    expect(await rowChecked(3)).toBe('true')
    await pressEscape()
  })

  it('reset to defaults clears the stored overrides', async () => {
    // The previous test left flipped toggles in place after the restart.
    await click(browser, '.model-selector-gear')
    await waitFor(browser, '.provider-settings-popup')
    expect(await rowChecked(0)).toBe('false')

    try {
      await click(browser, '.provider-settings-reset')

      // Switch states fall back to the Venice descriptor defaults (the
      // first three on, Venice system prompt off).
      expect(await rowChecked(0)).toBe('true')
      expect(await rowChecked(1)).toBe('true')
      expect(await rowChecked(2)).toBe('true')
      expect(await rowChecked(3)).toBe('false')
    } finally {
      // Keep the popup closed for the next test even if an assertion fails.
      await pressEscape()
    }

    // Debounced persistence should drop the venice overrides entirely.
    const stateFile = path.join(app.home, '.config', 'dez', 'app_state.json')
    await browser.waitUntil(
      async () => {
        try {
          const state = JSON.parse(await fs.promises.readFile(stateFile, 'utf8'))
          return state.providerSettings?.venice === undefined
        } catch {
          return false
        }
      },
      { timeout: 10_000, timeoutMsg: 'providerSettings.venice was not cleared from app_state.json' }
    )
  })

  it('hides the X search row for non-Grok Venice models', async () => {
    // Switch the active tab to a non-Grok Venice model via the SBP bridge:
    // the X search row disappears, the other rows stay.
    await browser.execute(() => {
      const w = window as unknown as { sbp: (sel: string, ...args: unknown[]) => unknown }
      w.sbp('dez.model/setActiveModel', 'venice', 'llama-3.3-70b', 'llama-3.3-70b')
    })

    await click(browser, '.model-selector-gear')
    await waitFor(browser, '.provider-settings-popup')
    const nonGrokLabels = await browser.execute(() =>
      Array.from(document.querySelectorAll('.provider-settings-label')).map(
        (el) => el.textContent?.trim() ?? ''
      )
    )
    expect(nonGrokLabels).toEqual(['Web search', 'Web scraping', 'Venice system prompt'])
    await pressEscape()

    // Switch back to a Grok model: the X search row returns.
    await browser.execute(() => {
      const w = window as unknown as { sbp: (sel: string, ...args: unknown[]) => unknown }
      w.sbp('dez.model/setActiveModel', 'venice', 'grok-4-20', 'grok-4-20')
    })

    await click(browser, '.model-selector-gear')
    await waitFor(browser, '.provider-settings-popup')
    const grokLabels = await browser.execute(() =>
      Array.from(document.querySelectorAll('.provider-settings-label')).map(
        (el) => el.textContent?.trim() ?? ''
      )
    )
    expect(grokLabels).toEqual(['Web search', 'X search', 'Web scraping', 'Venice system prompt'])
    await pressEscape()
  })

  it('shows the empty state for a provider without settings', async () => {
    // Switch the active tab's model to a non-Venice provider via the SBP
    // bridge (window.sbp is exposed by src/main.ts).
    await browser.execute(() => {
      const w = window as unknown as { sbp: (sel: string, ...args: unknown[]) => unknown }
      w.sbp('dez.model/setActiveModel', 'openrouter', 'some/model', 'Some Model')
    })

    await click(browser, '.model-selector-gear')
    await waitFor(browser, '.provider-settings-empty')
    const text = await browser.execute(
      () => document.querySelector('.provider-settings-empty')?.textContent?.trim() ?? ''
    )
    expect(text).toBe('No Settings for OpenRouter')
    await pressEscape()
  })

  it('model dropdown and popup are mutually exclusive', async () => {
    await click(browser, '.model-selector-gear')
    await waitFor(browser, '.provider-settings-popup')

    // Opening the model dropdown must close the settings popup.
    await click(browser, '.model-selector-btn')
    expect(await popupExists()).toBe(false)
    const dropdownExists = await browser.execute(
      () => document.querySelector('.model-dropdown') !== null
    )
    expect(dropdownExists).toBe(true)
    await pressEscape()
  })
})
