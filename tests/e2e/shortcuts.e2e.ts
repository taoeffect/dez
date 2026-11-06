import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Key } from 'webdriverio'
import { click, consoleErrors, pointerClick, resetConsoleErrors, screenshotOnFailure, typeKeys, waitFor, waitForValue } from './harness/dom'
import { readAppState } from './harness/fixtures'
import { startMockProviderApp, type MockProviderApp } from './harness/mockProviderApp'
import { replyText, sendChatReply, type MockProvider } from './harness/mockServer'
import type { E2EBrowser } from './harness/session'
import { activeTabStreaming, focusEditor, sbpCall, threadSections } from './harness/thread'

// Settings › Shortcuts lists every action of the shortcut registry, records
// a new key for a row, refuses a key that another action has, resets one row
// or all of them, and saves the keys in app_state.json. The window key
// handler, the editor keymap, and the Submit button follow a new key at
// once.
//
// WebDriver keys reach the page only. On Linux GTK takes a menu accelerator
// before the page, so the recorder turns the accelerators off while it
// records; that part needs the manual recipe in vitest.e2e.config.ts.
//
// One app session serves the whole file, and each test starts from the keys
// that the tests before it set.

const PROVIDER: MockProvider = { id: 'keys', name: 'Keys Mock', modelId: 'keys-model', modelName: 'Keys Model' }

interface ShortcutRow {
  label: string
  key: string
  /** The "also …" note of the default aliases. */
  aliases: string | null
  resetDisabled: boolean
  /** The error text under the row. Not named `error`: webdriverio reads an
   *  `execute` result with an `error` field as a WebDriver error. */
  refusal: string | null
}

describe('Settings › Shortcuts', () => {
  let setup: MockProviderApp
  let browser: E2EBrowser

  const rowSelector = (id: string): string => `.shortcut-row[data-shortcut-id="${id}"]`

  async function row (id: string): Promise<ShortcutRow> {
    return browser.execute((selector: string) => {
      const el = document.querySelector(selector)
      if (!el) throw new Error(`row: ${selector} not found`)
      const text = (part: string): string | null => el.querySelector(part)?.textContent?.trim() ?? null
      return {
        label: text('.shortcut-label') ?? '',
        key: text('.shortcut-key') ?? '',
        aliases: text('.shortcut-aliases'),
        resetDisabled: el.querySelector<HTMLButtonElement>('.shortcut-reset')?.disabled ?? false,
        refusal: text('.shortcut-error'),
      }
    }, rowSelector(id))
  }

  async function settingsOpen (): Promise<boolean> {
    return browser.execute(() => document.querySelector('.settings-overlay') !== null)
  }

  // The `shortcuts` overrides in app_state.json. Settings are saved after a
  // debounce, so read them in a waitForValue.
  async function savedShortcuts (): Promise<unknown> {
    return (await readAppState(setup.app.home))?.shortcuts ?? {}
  }

  // Opens Settings › Shortcuts as Help › Keyboard Shortcuts does.
  async function openShortcuts (): Promise<void> {
    await sbpCall(browser, 'dez.model/settings/open', 'shortcuts')
    await waitFor(browser, '.shortcut-manager')
  }

  async function closeSettings (): Promise<void> {
    await browser.keys([Key.Escape])
    await waitForValue(browser, 'Settings open', settingsOpen, false)
  }

  async function startRecording (id: string): Promise<void> {
    await click(browser, `${rowSelector(id)} .shortcut-key`)
    await waitForValue(browser, `${id} recording`, async () => (await row(id)).key, 'Press keys…')
  }

  async function tabCount (): Promise<number> {
    return browser.execute(() => document.querySelectorAll('.tab-strip > .tab').length)
  }

  async function submitButton (): Promise<{ keycap: string, name: string }> {
    return browser.execute(() => {
      const button = document.querySelector('.submit-button')
      if (!button) throw new Error('submitButton: .submit-button not found')
      return {
        keycap: button.querySelector('.submit-button-keycap')?.textContent ?? '',
        name: button.getAttribute('aria-label') ?? '',
      }
    })
  }

  beforeAll(async () => {
    setup = await startMockProviderApp(PROVIDER)
    browser = setup.browser
  })

  beforeEach(async () => {
    await resetConsoleErrors(browser)
  })

  afterEach(async (ctx) => {
    await screenshotOnFailure(browser, ctx)
    await setup.mock.dropOpenReplies(browser)
    if (ctx.task.result?.state === 'fail') return
    // The recorder turns the menu accelerators off and on again; a failed
    // `setAccelerator` would log here.
    expect(await consoleErrors(browser)).toEqual([])
  })

  afterAll(async () => {
    await setup?.stop()
  })

  it('lists every shortcut by group in its own tab, and General has no list', async () => {
    await click(browser, 'button[title^="Settings"]')
    await waitFor(browser, '.settings-overlay')
    expect(await browser.execute(() => document.querySelector('.shortcut-row') !== null), 'rows in General').toBe(false)

    await browser.execute(() => {
      const button = [...document.querySelectorAll<HTMLElement>('.settings-nav-btn')].find((el) => el.textContent?.trim() === 'Shortcuts')
      if (!button) throw new Error('no Shortcuts nav button')
      button.click()
    })
    await waitFor(browser, '.shortcut-manager')

    const listed = await browser.execute(() => [...document.querySelectorAll('.shortcut-group')].map((group) => ({
      title: group.querySelector('.shortcut-group-title')?.textContent ?? '',
      ids: [...group.querySelectorAll('.shortcut-row')].map((el) => el.getAttribute('data-shortcut-id') ?? ''),
    })))
    expect(listed.map((group) => group.title)).toEqual(['Conversation', 'Editing', 'Find', 'Tabs', 'App'])
    const registry = await sbpCall(browser, 'dez.model/settings/shortcuts') as Array<{ id: string, group: string }>
    expect(listed.flatMap((group) => group.ids.map((id) => `${group.title} ${id}`)))
      .toEqual(registry.map((shortcut) => `${shortcut.group} ${shortcut.id}`))

    expect(await row('submit')).toEqual({ label: 'Submit thread to LLM', key: 'Ctrl+↩', aliases: null, resetDisabled: true, refusal: null })
    expect(await row('redo')).toEqual({ label: 'Redo', key: 'Ctrl+Shift+Z', aliases: 'also Ctrl+Y', resetDisabled: true, refusal: null })
    expect(await row('quit')).toEqual({ label: 'Quit', key: 'Ctrl+Q', aliases: null, resetDisabled: true, refusal: null })
    expect(await browser.execute(() => document.querySelector<HTMLButtonElement>('.shortcut-reset-all')?.disabled)).toBe(true)
  })

  it('stops recording on Esc or a click outside, and Settings stays open', async () => {
    await openShortcuts()
    const unchanged = { label: 'New tab', key: 'Ctrl+T', aliases: null, resetDisabled: true, refusal: null }

    await startRecording('newTab')
    // A modifier alone is no key: the row still records, so the Esc after it
    // stops the recording and does not close Settings.
    await browser.keys([Key.Control])
    await browser.keys([Key.Escape])
    await waitForValue(browser, 'newTab row after Esc', () => row('newTab'), unchanged)
    expect(await settingsOpen(), 'Settings open after Esc').toBe(true)

    await startRecording('newTab')
    await pointerClick(browser, '.settings-header h2')
    await waitForValue(browser, 'newTab row after a click outside', () => row('newTab'), unchanged)
    expect(await settingsOpen(), 'Settings open after the click').toBe(true)
    expect(await savedShortcuts()).toEqual({})
  })

  it('gives an app action a new key: the new key works and the old one does nothing', async () => {
    await openShortcuts()
    await startRecording('newTab')
    await browser.keys([Key.Control, 'k'])
    await waitForValue(browser, 'newTab row', () => row('newTab'), { label: 'New tab', key: 'Ctrl+K', aliases: null, resetDisabled: false, refusal: null })
    await waitForValue(browser, 'saved keys', savedShortcuts, { newTab: 'Ctrl-k' })
    await closeSettings()

    const before = await tabCount()
    await focusEditor(browser)
    // The window handler creates a tab in the keydown, so a tab would show at
    // once.
    await browser.keys([Key.Control, 't'])
    expect(await tabCount(), 'tabs after Ctrl+T').toBe(before)
    await browser.keys([Key.Control, 'k'])
    await waitForValue(browser, 'tabs after Ctrl+K', tabCount, before + 1)
    expect(await browser.execute(() => document.querySelector('.tab-new')?.getAttribute('title'))).toBe('New tab (Ctrl+K)')
  })

  it('refuses a key that another action has, and saves nothing', async () => {
    await openShortcuts()
    const before = await tabCount()
    await startRecording('newTab')
    // Ctrl+W closes the tab while no row records.
    await browser.keys([Key.Control, 'w'])
    await waitForValue(browser, 'newTab row', () => row('newTab'), {
      label: 'New tab', key: 'Ctrl+K', aliases: null, resetDisabled: false, refusal: 'Used by Close tab',
    })
    expect(await tabCount(), 'tabs').toBe(before)
    expect(await settingsOpen(), 'Settings open').toBe(true)
    expect(await savedShortcuts()).toEqual({ newTab: 'Ctrl-k' })
  })

  it('gives Submit a new key: the editor keymap and the Submit button follow', async () => {
    await openShortcuts()
    await startRecording('submit')
    await browser.keys([Key.Control, 'j'])
    await waitForValue(browser, 'submit row', async () => (await row('submit')).key, 'Ctrl+J')
    await closeSettings()
    expect(await submitButton()).toEqual({ keycap: 'Ctrl+J', name: 'Submit (Ctrl+J)' })

    await sbpCall(browser, 'dez.model/tabs/create')
    await focusEditor(browser)
    await typeKeys(browser, 'Rebound')
    // A submit adds the agent section and starts the stream in the keydown,
    // so it would show at once.
    await browser.keys([Key.Control, Key.Enter])
    expect((await threadSections(browser)).map((section) => section.role), 'roles after Ctrl+Enter').toEqual(['user'])
    expect(await activeTabStreaming(browser), 'streaming after Ctrl+Enter').toBe(false)

    await browser.keys([Key.Control, 'j'])
    const request = await setup.mock.waitForRequest(browser)
    expect(request.body).toContain('Rebound')
    await sendChatReply(request.reply, 'rebound')
    await waitForValue(browser, 'reply', async () => (await threadSections(browser)).slice(1), [
      { role: 'agent', text: replyText('rebound') },
      { role: 'user', text: '' },
    ])
  })

  it('keeps the keys after a relaunch', async () => {
    await waitForValue(browser, 'saved keys', savedShortcuts, { newTab: 'Ctrl-k', submit: 'Ctrl-j' })
    browser = await setup.relaunch()
    // A new page: the record that beforeEach started is gone.
    await resetConsoleErrors(browser)

    expect(await submitButton()).toEqual({ keycap: 'Ctrl+J', name: 'Submit (Ctrl+J)' })
    await openShortcuts()
    expect((await row('newTab')).key).toBe('Ctrl+K')
    expect((await row('submit')).key).toBe('Ctrl+J')
    await closeSettings()

    const before = await tabCount()
    await focusEditor(browser)
    await browser.keys([Key.Control, 'k'])
    await waitForValue(browser, 'tabs after Ctrl+K', tabCount, before + 1)
  })

  it('resets one row, but not to a default key that another action has now', async () => {
    await openShortcuts()
    await startRecording('closeTab')
    await browser.keys([Key.Control, 't'])
    await waitForValue(browser, 'closeTab row', async () => (await row('closeTab')).key, 'Ctrl+T')

    await click(browser, `${rowSelector('newTab')} .shortcut-reset`)
    await waitForValue(browser, 'newTab row', () => row('newTab'), {
      label: 'New tab', key: 'Ctrl+K', aliases: null, resetDisabled: false, refusal: 'Used by Close tab',
    })

    await click(browser, `${rowSelector('closeTab')} .shortcut-reset`)
    await waitForValue(browser, 'closeTab row', () => row('closeTab'), { label: 'Close tab', key: 'Ctrl+W', aliases: null, resetDisabled: true, refusal: null })
    expect((await row('newTab')).refusal, 'newTab refusal after the other reset').toBeNull()
    await waitForValue(browser, 'saved keys', savedShortcuts, { newTab: 'Ctrl-k', submit: 'Ctrl-j' })
  })

  it('brings back every default key with Reset All Shortcuts', async () => {
    await openShortcuts()
    await click(browser, '.shortcut-reset-all')
    await waitForValue(browser, 'changed rows', () => browser.execute(() =>
      [...document.querySelectorAll('.shortcut-row')]
        .filter((el) => !el.querySelector<HTMLButtonElement>('.shortcut-reset')?.disabled)
        .map((el) => el.getAttribute('data-shortcut-id'))), [])
    expect((await row('newTab')).key).toBe('Ctrl+T')
    expect((await row('submit')).key).toBe('Ctrl+↩')
    expect(await browser.execute(() => document.querySelector<HTMLButtonElement>('.shortcut-reset-all')?.disabled)).toBe(true)
    await waitForValue(browser, 'saved keys', savedShortcuts, {})
    await closeSettings()

    expect(await submitButton()).toEqual({ keycap: 'Ctrl+↩', name: 'Submit (Ctrl+Enter)' })
    const before = await tabCount()
    await focusEditor(browser)
    await browser.keys([Key.Control, 't'])
    await waitForValue(browser, 'tabs after Ctrl+T', tabCount, before + 1)
  })
})
