import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startApp, type RunningApp } from './harness/app'
import { click, waitFor, waitForValue } from './harness/dom'
import { makeConversation, readAppState, seedAppState, seedConversation } from './harness/fixtures'
import { createSession, destroySession, type E2EBrowser } from './harness/session'
import { sbpCall } from './harness/thread'

// Drives the real app: the gear button toggles the popup, the Venice
// toggles (after the Thinking row, first for every provider with thinking,
// and the Tools row) change the persisted providerSettings, the settings
// survive an app restart, OpenRouter shows only the Thinking and Tools rows,
// a custom provider without thinking or settings shows only the Tools row,
// a model gets only the toggles that apply to it, and an unknown provider
// shows the empty state. All interaction goes through executed JS (harness
// click()/dispatched KeyboardEvent) because wry's automation session rejects
// native WebDriver click/sendKeys.
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

  /** What the open popup shows: the header of the toggles, the row labels,
   *  and the text of the empty state. */
  async function popupView (): Promise<{ header: string | null, labels: string[], empty: string | null }> {
    return browser.execute(() => ({
      header: document.querySelector('.provider-settings-header')?.textContent?.trim() ?? null,
      labels: Array.from(document.querySelectorAll('.provider-settings-label')).map((el) => el.textContent?.trim() ?? ''),
      empty: document.querySelector('.provider-settings-empty')?.textContent?.trim() ?? null,
    }))
  }

  beforeAll(async () => {
    app = await startApp()
    try {
      // Seed a restored tab whose activeModel is a Grok Venice model (Grok
      // keeps all three Venice setting rows visible; non-Grok hides the X
      // search row). The app's initial default tab is created before
      // settings load, so defaultNewTabModel alone would leave activeModel
      // null.
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
        activeTabId: 'tab-e2e',
        // Neither has a server: with `fetchModels: false` the app never
        // sends them a request, and the model cache holds their config
        // models.
        customProviders: [
          // No settings and no thinking.
          {
            id: 'plain',
            name: 'Plain Mock',
            baseUrl: 'http://127.0.0.1:9/v1',
            apiFormat: 'openai',
            models: [{ id: 'plain-model' }],
            fetchModels: false,
            auth: 'apiKey'
          },
          // Thinking, and models that cannot use every toggle.
          {
            id: 'gated',
            name: 'Gated Mock',
            baseUrl: 'http://127.0.0.1:9/v1',
            apiFormat: 'openai',
            models: [
              { id: 'chat-model' },
              { id: 'no-tools-model', toolCalling: false },
              { id: 'no-thinking-model', thinking: false },
              { id: 'speech-model', outputs: ['audio'], request: 'tts' }
            ],
            fetchModels: false,
            auth: 'apiKey',
            thinking: {}
          }
        ]
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
    expect(labels).toEqual(['Thinking', 'Tools', 'Web search', 'X search', 'Web scraping'])

    // Defaults: every row on.
    for (const row of [0, 1, 2, 3, 4]) expect(await rowChecked(row)).toBe('true')

    // Flip four rows and confirm the switch state updates in the UI.
    await browser.execute(() => {
      const rows = document.querySelectorAll<HTMLButtonElement>('.provider-settings-row')
      rows[0].click()
      rows[1].click()
      rows[2].click()
      rows[4].click()
    })
    expect(await rowChecked(0)).toBe('false')
    expect(await rowChecked(1)).toBe('false')
    expect(await rowChecked(2)).toBe('false')
    expect(await rowChecked(3)).toBe('true')
    expect(await rowChecked(4)).toBe('false')

    // Escape closes the popup.
    await pressEscape()
    expect(await popupExists()).toBe(false)

    // Debounced persistence should land the overrides in app_state.json.
    await browser.waitUntil(
      async () => {
        const venice = (await readAppState(app.home))?.providerSettings?.venice
        return venice?.thinking === false && venice.tools === false &&
          venice.webSearch === false && venice.webScraping === false
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
    expect(await rowChecked(1)).toBe('false')
    expect(await rowChecked(2)).toBe('false')
    expect(await rowChecked(3)).toBe('true')
    expect(await rowChecked(4)).toBe('false')
    await pressEscape()
  })

  it('reset to defaults clears the stored overrides', async () => {
    // The previous test left flipped toggles in place after the restart.
    await click(browser, '.model-selector-gear')
    await waitFor(browser, '.provider-settings-popup')
    expect(await rowChecked(0)).toBe('false')
    expect(await rowChecked(1)).toBe('false')

    try {
      await click(browser, '.provider-settings-reset')

      // Switch states fall back to the defaults: every row on.
      for (const row of [0, 1, 2, 3, 4]) expect(await rowChecked(row)).toBe('true')
    } finally {
      // Keep the popup closed for the next test even if an assertion fails.
      await pressEscape()
    }

    // Debounced persistence should drop the venice overrides entirely.
    await browser.waitUntil(
      async () => {
        const state = await readAppState(app.home)
        return state !== null && state.providerSettings?.venice === undefined
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
    expect(nonGrokLabels).toEqual(['Thinking', 'Tools', 'Web search', 'Web scraping'])
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
    expect(grokLabels).toEqual(['Thinking', 'Tools', 'Web search', 'X search', 'Web scraping'])
    await pressEscape()
  })

  it('shows the Thinking and Tools rows for OpenRouter, only Tools for a provider without settings, and the empty state for an unknown provider', async () => {
    // Switch the active tab's model through the SBP bridge (window.sbp is
    // exposed by src/main.ts). OpenRouter has no settings of its own, but it
    // supports thinking.
    await browser.execute(() => {
      const w = window as unknown as { sbp: (sel: string, ...args: unknown[]) => unknown }
      w.sbp('dez.model/setActiveModel', 'openrouter', 'some/model', 'Some Model')
    })

    await click(browser, '.model-selector-gear')
    await waitFor(browser, '.provider-settings-popup')
    expect(await popupView()).toEqual({ header: 'OpenRouter', labels: ['Thinking', 'Tools'], empty: null })
    expect(await rowChecked(0)).toBe('true')
    expect(await rowChecked(1)).toBe('true')
    await pressEscape()

    await browser.execute(() => {
      const w = window as unknown as { sbp: (sel: string, ...args: unknown[]) => unknown }
      w.sbp('dez.model/setActiveModel', 'plain', 'plain-model', 'plain-model')
    })

    await click(browser, '.model-selector-gear')
    await waitFor(browser, '.provider-settings-popup')
    expect(await popupView()).toEqual({ header: 'Plain Mock', labels: ['Tools'], empty: null })
    await pressEscape()

    // A tab can keep the model of a provider that was removed.
    await browser.execute(() => {
      const w = window as unknown as { sbp: (sel: string, ...args: unknown[]) => unknown }
      w.sbp('dez.model/setActiveModel', 'removed', 'gone-model', 'gone-model')
    })

    await click(browser, '.model-selector-gear')
    await waitFor(browser, '.provider-settings-empty')
    expect(await popupView()).toEqual({ header: null, labels: [], empty: 'No Settings for removed' })
    await pressEscape()
  })

  it('shows only the toggles that apply to the active model, and resets only those', async () => {
    const views: Array<[string, { header: string | null, labels: string[], empty: string | null }]> = [
      ['chat-model', { header: 'Gated Mock', labels: ['Thinking', 'Tools'], empty: null }],
      ['no-tools-model', { header: 'Gated Mock', labels: ['Thinking'], empty: null }],
      ['no-thinking-model', { header: 'Gated Mock', labels: ['Tools'], empty: null }],
      // A media model with no parameters: no toggle does anything for it.
      ['speech-model', { header: null, labels: [], empty: 'No Settings for this model' }],
      // The model cache does not have it: every toggle of the provider.
      ['not-listed-model', { header: 'Gated Mock', labels: ['Thinking', 'Tools'], empty: null }]
    ]

    await click(browser, '.model-selector-gear')
    await waitFor(browser, '.provider-settings-popup')
    try {
      for (const [modelId, view] of views) {
        await sbpCall(browser, 'dez.model/setActiveModel', 'gated', modelId, modelId)
        // The popup stays open and follows the active model. The model
        // cache gets the config models soon after the app starts.
        await waitForValue(browser, `popup of ${modelId}`, popupView, view)
      }

      // The toggles keep their values while a model hides them: they are
      // stored for the provider.
      await sbpCall(browser, 'dez.model/setActiveModel', 'gated', 'chat-model', 'chat-model')
      await waitForValue(browser, 'popup of chat-model', popupView, views[0][1])
      await browser.execute(() => {
        for (const row of document.querySelectorAll<HTMLButtonElement>('.provider-settings-row')) row.click()
      })
      expect([await rowChecked(0), await rowChecked(1)]).toEqual(['false', 'false'])

      // "Reset to defaults" of a model with no Thinking row leaves the
      // Thinking value.
      await sbpCall(browser, 'dez.model/setActiveModel', 'gated', 'no-thinking-model', 'no-thinking-model')
      await waitForValue(browser, 'Tools of no-thinking-model', () => rowChecked(0), 'false')
      await click(browser, '.provider-settings-reset')
      await waitForValue(browser, 'Tools after the reset', () => rowChecked(0), 'true')

      await sbpCall(browser, 'dez.model/setActiveModel', 'gated', 'chat-model', 'chat-model')
      await waitForValue(browser, 'rows of chat-model after the reset', async () => [await rowChecked(0), await rowChecked(1)], ['false', 'true'])
    } finally {
      // Keep the popup closed for the next test even if an assertion fails.
      await pressEscape()
    }

    await waitForValue(browser, 'saved toggles', async () => (await readAppState(app.home))?.providerSettings?.gated ?? null, { thinking: false })
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
