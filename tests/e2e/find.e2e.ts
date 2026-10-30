import { isDeepStrictEqual } from 'node:util'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Key } from 'webdriverio'
import { startApp, type RunningApp } from './harness/app'
import { click, screenshotOnFailure, typeInto, waitFor } from './harness/dom'
import { makeConversation, seedAppState, seedConversation } from './harness/fixtures'
import { createSession, destroySession, type E2EBrowser } from './harness/session'

// Find/replace dropdown in the thread editor, driven through the real app.
//
// Keys are real WebDriver key actions, so the global shortcut handler, the
// CodeMirror keymaps, and the native textarea default actions (Shift+Enter
// newline, caret moves, Backspace) all run as they do for a user.
// `browser.keys([a, b])` presses all keys down, then releases them, so one
// call is one chord. Only element `sendKeys` and element clicks are
// rejected by wry, so plain text goes in through the harness `typeInto` and
// buttons are clicked with `el.click()`.
//
// One app session serves the whole file. Each test opens the fixture in a
// new tab. Find state (query, regex flag, replace row, history) is shared
// by all tabs and is not reset, so each test sets what it depends on.

const FIND_FIELD = '.find-field[aria-label="Find"]'
const REPLACE_FIELD = '.find-field[aria-label="Replace"]'

// "fox" (any case) matches 4 times: "Fox one", "brown fox", "fox two", and
// the agent section's "Fox". The regex `fox \w+` matches 3 of them.
const USER_TEXT = 'Fox one: the quick brown fox.\nfox two jumps over the lazy dog.'
const AGENT_TEXT = 'A third Fox appears.\nNothing to see on this line.'

interface SectionText {
  role: string
  text: string
}

let fixtureCount = 0

describe('find and replace', () => {
  let app: RunningApp
  let browser: E2EBrowser

  // Poll until `read()` returns `expected`. The failure message shows the
  // last value read, which `waitUntil` alone would not.
  async function waitForValue<T> (label: string, read: () => Promise<T>, expected: T): Promise<void> {
    let actual: T | undefined
    try {
      await browser.waitUntil(async () => {
        actual = await read()
        return isDeepStrictEqual(actual, expected)
      }, { timeout: 10_000, interval: 50 })
    } catch {
      throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
    }
  }

  // One action per character: a key repeated inside one `browser.keys`
  // chord is dropped.
  async function typeKeys (text: string): Promise<void> {
    for (const ch of text) await browser.keys(ch)
  }

  async function findStatus (): Promise<string> {
    return browser.execute(() => document.querySelector('.find-status')?.textContent?.trim() ?? '')
  }

  async function matchCount (): Promise<number> {
    return browser.execute(() => document.querySelectorAll('.dez-find-match').length)
  }

  // Text of each element of the current match. A match that spans lines
  // draws one element per line.
  async function currentMatchTexts (): Promise<string[]> {
    return browser.execute(() =>
      Array.from(document.querySelectorAll('.dez-find-match--current')).map((el) => el.textContent ?? '')
    )
  }

  async function selectionDrawn (): Promise<boolean> {
    return browser.execute(() => document.querySelector('.cm-selectionBackground') !== null)
  }

  async function dropdownOpen (): Promise<boolean> {
    return browser.execute(() => document.querySelector('.find-dropdown') !== null)
  }

  async function fieldState (selector: string): Promise<{ value: string, rows: number, caret: number }> {
    return browser.execute((sel: string) => {
      const field = document.querySelector(sel) as HTMLTextAreaElement | null
      if (!field) throw new Error(`fieldState: ${sel} not found`)
      return { value: field.value, rows: field.rows, caret: field.selectionStart }
    }, selector)
  }

  // 'find' / 'replace' for the dropdown fields, 'editor' for CodeMirror.
  async function focusedArea (): Promise<string> {
    return browser.execute(() => {
      const el = document.activeElement
      if (!el) return 'none'
      if (el.matches('.find-field')) return el.getAttribute('aria-label')?.toLowerCase() ?? 'field'
      if (el.matches('.cm-content')) return 'editor'
      return el.tagName.toLowerCase()
    })
  }

  // Section texts of the active tab, read from the store (it syncs on every
  // doc change).
  async function sectionTexts (): Promise<SectionText[]> {
    return browser.execute(() => {
      type StoreTab = { id: string, sections: Array<{ role: string, content: Array<{ kind: string, text?: string }> }> }
      const sbp = Reflect.get(window, 'sbp') as (selector: string, ...args: unknown[]) => unknown
      const activeId = sbp('dez.model/tabs/activeId') as string
      const tab = (sbp('dez.model/tabs/list') as StoreTab[]).find((candidate) => candidate.id === activeId)
      return (tab?.sections ?? []).map((section) => ({
        role: section.role,
        text: section.content.map((node) => node.kind === 'text' ? node.text ?? '' : '').join(''),
      }))
    })
  }

  async function setRegex (on: boolean): Promise<void> {
    await browser.execute((wanted: boolean) => {
      const toggle = document.querySelector('.find-btn--toggle') as HTMLButtonElement | null
      if (!toggle) throw new Error('setRegex: regex toggle not found')
      if ((toggle.getAttribute('aria-pressed') === 'true') !== wanted) toggle.click()
    }, on)
  }

  async function setReplaceOpen (open: boolean): Promise<void> {
    const isOpen = (): Promise<boolean> =>
      browser.execute((sel: string) => document.querySelector(sel) !== null, REPLACE_FIELD)
    if ((await isOpen()) !== open) await click(browser, 'button[title="Toggle replace"]')
    await waitForValue('replace row open', isOpen, open)
  }

  async function clickButtonWithText (text: string): Promise<void> {
    await browser.execute((label: string) => {
      const button = Array.from(document.querySelectorAll('.find-dropdown button'))
        .find((candidate) => candidate.textContent?.trim() === label) as HTMLButtonElement | undefined
      if (!button) throw new Error(`clickButtonWithText: no "${label}" button`)
      button.click()
    }, text)
  }

  async function focusEditor (): Promise<void> {
    await browser.execute(() => {
      const content = document.querySelector('.cm-content') as HTMLElement | null
      if (!content) throw new Error('focusEditor: .cm-content not found')
      content.focus()
    })
  }

  // Seed the fixture under a new id, open it in a new tab, and put the
  // cursor at the doc start with the find dropdown closed. The last line
  // names the fixture, so the wait cannot match an older tab's editor.
  async function openFixture (): Promise<void> {
    const id = `find-e2e-${++fixtureCount}`
    await browser.execute(() => {
      const sbp = Reflect.get(window, 'sbp') as (selector: string, ...args: unknown[]) => unknown
      sbp('dez.editor/closeFind')
    })
    await seedConversation(app.home, makeConversation({
      id,
      title: id,
      sections: [
        { role: 'user', nodes: [{ kind: 'text', text: USER_TEXT }] },
        { role: 'agent', nodes: [{ kind: 'text', text: `${AGENT_TEXT}\n${id}` }] },
      ],
    }))
    await browser.execute((conversationId: string) => {
      const sbp = Reflect.get(window, 'sbp') as (selector: string, ...args: unknown[]) => unknown
      void sbp('dez.model/tabs/openConversation', conversationId)
    }, id)
    await browser.waitUntil(
      async () => browser.execute(
        (marker: string) => (document.querySelector('.cm-content')?.textContent ?? '').endsWith(marker),
        id
      ),
      { timeout: 30_000, timeoutMsg: `fixture ${id} did not open in the editor` }
    )
    await focusEditor()
    await browser.keys([Key.Control, Key.Home])
  }

  // Ctrl+F, then a fresh query: plain mode, empty field, typed text.
  async function openFindWithQuery (search: string): Promise<void> {
    await browser.keys([Key.Control, 'f'])
    await waitFor(browser, FIND_FIELD, 10_000)
    await setRegex(false)
    await typeInto(browser, FIND_FIELD, search, { clear: true })
  }

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
    await waitFor(browser, 'header.tab-bar', 60_000)
  })

  // Errors thrown by selectors inside Vue handlers are only logged, so the
  // page records console.error calls and each test checks the record.
  beforeEach(async () => {
    await browser.execute(() => {
      const errors: string[] = []
      Reflect.set(window, '__findE2eErrors', errors)
      if (!Reflect.get(window, '__findE2eConsoleWrapped')) {
        Reflect.set(window, '__findE2eConsoleWrapped', true)
        const original = console.error.bind(console)
        console.error = (...args: unknown[]) => {
          const record = Reflect.get(window, '__findE2eErrors') as string[]
          record.push(args.map((arg) => arg instanceof Error ? arg.stack ?? arg.message : String(arg)).join(' '))
          original(...args)
        }
      }
    })
  })

  afterEach(async (ctx) => {
    await screenshotOnFailure(browser, ctx)
    if (ctx.task.result?.state === 'fail') return
    const errors = await browser.execute(() => Reflect.get(window, '__findE2eErrors') as string[])
    expect(errors).toEqual([])
  })

  afterAll(async () => {
    await destroySession(browser)
    await app?.stop()
  })

  it('opens with Ctrl+F, prefills the selection, and highlights every match', async () => {
    await openFixture()
    // Select the first word, "Fox".
    await browser.keys([Key.Control, Key.Shift, Key.ArrowRight])
    await browser.keys([Key.Control, 'f'])

    await waitFor(browser, FIND_FIELD, 10_000)
    expect(await focusedArea()).toBe('find')
    const prefilled = await browser.execute((sel: string) => {
      const field = document.querySelector(sel) as HTMLTextAreaElement
      return { value: field.value, start: field.selectionStart, end: field.selectionEnd }
    }, FIND_FIELD)
    expect(prefilled).toEqual({ value: 'Fox', start: 0, end: 3 })

    await setRegex(false)
    await waitForValue('status', findStatus, '1 of 4')
    await waitForValue('match count', matchCount, 4)
    await waitForValue('current match', currentMatchTexts, ['Fox'])

    // Search as you type: the first match at or after the doc start.
    await typeInto(browser, FIND_FIELD, 'lazy dog', { clear: true })
    await waitForValue('status', findStatus, '1 of 1')
    await waitForValue('current match', currentMatchTexts, ['lazy dog'])

    await typeInto(browser, FIND_FIELD, 'zebra', { clear: true })
    await waitForValue('status', findStatus, 'No results')
    await waitForValue('match count', matchCount, 0)
  })

  it('navigates with Enter, Ctrl+G, Shift+Ctrl+G, and the arrow buttons, wrapping at both ends', async () => {
    await openFixture()
    await openFindWithQuery('fox')
    await waitForValue('status', findStatus, '1 of 4')

    await browser.keys([Key.Enter])
    await waitForValue('status after Enter', findStatus, '2 of 4')
    await waitForValue('current match', currentMatchTexts, ['fox'])
    await browser.keys([Key.Control, 'g'])
    await waitForValue('status after Ctrl+G', findStatus, '3 of 4')
    await browser.keys([Key.Control, 'g'])
    await waitForValue('status after Ctrl+G', findStatus, '4 of 4')
    await waitForValue('current match', currentMatchTexts, ['Fox'])
    await browser.keys([Key.Control, 'g'])
    await waitForValue('status after wrapping forward', findStatus, '1 of 4')
    await browser.keys([Key.Control, Key.Shift, 'g'])
    await waitForValue('status after wrapping back', findStatus, '4 of 4')

    await click(browser, 'button[title^="Previous match"]')
    await waitForValue('status after the previous button', findStatus, '3 of 4')
    await click(browser, 'button[title^="Next match"]')
    await waitForValue('status after the next button', findStatus, '4 of 4')
    // The buttons do not take focus from the field.
    expect(await focusedArea()).toBe('find')
    expect(await matchCount()).toBe(4)
  })

  it('switches between literal and regex matching', async () => {
    await openFixture()
    await openFindWithQuery('fox \\w+')
    const toggle = async (): Promise<{ pressed: string | null, title: string | null }> =>
      browser.execute(() => {
        const button = document.querySelector('.find-btn--toggle')
        return { pressed: button?.getAttribute('aria-pressed') ?? null, title: button?.getAttribute('title') ?? null }
      })

    await waitForValue('literal status', findStatus, 'No results')
    expect(await toggle()).toEqual({ pressed: 'false', title: 'Enable regex' })

    await click(browser, '.find-btn--toggle')
    await waitForValue('regex toggle', toggle, { pressed: 'true', title: 'Disable regex' })
    await waitForValue('regex status', findStatus, '1 of 3')
    await waitForValue('match count', matchCount, 3)
    await waitForValue('current match', currentMatchTexts, ['Fox one'])

    const invalid = async (): Promise<boolean> =>
      browser.execute((sel: string) => document.querySelector(sel)?.classList.contains('find-field--invalid') ?? false, FIND_FIELD)
    await typeInto(browser, FIND_FIELD, 'fox(', { clear: true })
    await waitForValue('invalid status', findStatus, 'Invalid regex')
    expect(await invalid()).toBe(true)
    await waitForValue('match count', matchCount, 0)

    // The same text is a valid literal search.
    await click(browser, '.find-btn--toggle')
    await waitForValue('literal status', findStatus, 'No results')
    expect(await invalid()).toBe(false)
  })

  it('replaces one match at a time and all at once, each as one undo step', async () => {
    await openFixture()
    await openFindWithQuery('fox')
    await waitForValue('status', findStatus, '1 of 4')
    const before = await sectionTexts()
    // Each step of `expected` replaces the next "fox" (any case) in doc
    // order; the last one replaces all that are left.
    const replaced = (count: number): SectionText[] => {
      let left = count
      return before.map(({ role, text }) => ({
        role,
        text: text.replace(/fox/gi, (match) => left-- > 0 ? 'cat' : match),
      }))
    }

    await setReplaceOpen(false)
    await click(browser, 'button[title="Toggle replace"]')
    await waitFor(browser, REPLACE_FIELD, 10_000)
    await waitForValue('focus after expanding', focusedArea, 'replace')
    expect(await browser.execute(() =>
      document.querySelector('button[title="Toggle replace"]')?.getAttribute('aria-expanded')
    )).toBe('true')
    await typeInto(browser, REPLACE_FIELD, 'cat', { clear: true })

    // Replace the current match; the next match becomes current.
    await click(browser, 'button[title="Replace (Enter)"]')
    await waitForValue('sections after Replace', sectionTexts, replaced(1))
    await waitForValue('status after Replace', findStatus, '1 of 3')
    await waitForValue('current match', currentMatchTexts, ['fox'])

    // Enter in the replace field does the same.
    await browser.keys([Key.Enter])
    await waitForValue('sections after Enter', sectionTexts, replaced(2))
    await waitForValue('status after Enter', findStatus, '1 of 2')

    await clickButtonWithText('Replace all')
    await waitForValue('sections after Replace all', sectionTexts, replaced(4))
    await waitForValue('status after Replace all', findStatus, 'No results')

    await focusEditor()
    await browser.keys([Key.Control, 'z'])
    await waitForValue('sections after undoing Replace all', sectionTexts, replaced(2))
    await browser.keys([Key.Control, 'z'])
    await waitForValue('sections after undoing Enter', sectionTexts, replaced(1))
  })

  // On macOS WebKit, the keydown of the Enter that confirms IME text comes
  // after compositionend, with isComposing false and keyCode 229. No IME
  // runs here, so the test sends that keydown itself. Vue renders what it
  // changed before the next WebDriver command reads the page.
  it('ignores the Enter that confirms IME text in the find and replace fields', async () => {
    const pressImeEnter = async (selector: string): Promise<void> => {
      await browser.execute((sel: string) => {
        const field = document.querySelector(sel) as HTMLTextAreaElement | null
        if (!field) throw new Error(`pressImeEnter: ${sel} not found`)
        field.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Enter', code: 'Enter', keyCode: 229, bubbles: true, cancelable: true,
        }))
      }, selector)
    }

    await openFixture()
    await openFindWithQuery('fox')
    await waitForValue('status', findStatus, '1 of 4')
    await pressImeEnter(FIND_FIELD)
    expect(await findStatus()).toBe('1 of 4')
    await browser.keys([Key.Enter])
    await waitForValue('status after Enter', findStatus, '2 of 4')

    await setReplaceOpen(true)
    await typeInto(browser, REPLACE_FIELD, 'cat', { clear: true })
    const before = await sectionTexts()
    await pressImeEnter(REPLACE_FIELD)
    expect(await findStatus()).toBe('2 of 4')
    expect(await sectionTexts()).toEqual(before)
    await browser.keys([Key.Enter])
    await waitForValue('status after Enter in the replace field', findStatus, '2 of 3')
  })

  it('recalls earlier searches with ArrowUp and ArrowDown', async () => {
    await openFixture()
    await openFindWithQuery('quick')
    await waitForValue('status', findStatus, '1 of 1')
    // Next/previous (Enter or button) and closing add the search to the
    // history, even when the match does not move.
    await browser.keys([Key.Enter])
    await typeInto(browser, FIND_FIELD, 'lazy', { clear: true })
    await waitForValue('status', findStatus, '1 of 1')
    await click(browser, 'button[title^="Next match"]')
    await typeInto(browser, FIND_FIELD, 'third', { clear: true })
    await waitForValue('status', findStatus, '1 of 1')
    await browser.keys([Key.Escape])
    await waitForValue('dropdown open', dropdownOpen, false)

    // The reopened field shows the newest entry, so the first ArrowUp skips
    // it. A recalled search runs right away, with the caret at its end.
    await browser.keys([Key.Control, 'f'])
    await waitFor(browser, FIND_FIELD, 10_000)
    expect((await fieldState(FIND_FIELD)).value).toBe('third')
    await browser.keys([Key.ArrowUp])
    await waitForValue('field after ArrowUp', () => fieldState(FIND_FIELD), { value: 'lazy', rows: 1, caret: 4 })
    await waitForValue('status of the recalled search', findStatus, '1 of 1')
    await waitForValue('current match', currentMatchTexts, ['lazy'])
    await browser.keys([Key.ArrowUp])
    await waitForValue('field after ArrowUp', () => fieldState(FIND_FIELD), { value: 'quick', rows: 1, caret: 5 })
    await browser.keys([Key.ArrowDown])
    await waitForValue('field after ArrowDown', () => fieldState(FIND_FIELD), { value: 'lazy', rows: 1, caret: 4 })
    await browser.keys([Key.ArrowDown])
    await waitForValue('field after ArrowDown', () => fieldState(FIND_FIELD), { value: 'third', rows: 1, caret: 5 })

    // Typing while browsing starts a new browse: ArrowUp starts again from
    // the newest entry, and going past it restores the typed draft.
    await browser.keys([Key.ArrowUp])
    await waitForValue('field after ArrowUp', () => fieldState(FIND_FIELD), { value: 'lazy', rows: 1, caret: 4 })
    await typeKeys('x')
    await browser.keys([Key.ArrowUp])
    await waitForValue('field after typing and ArrowUp', () => fieldState(FIND_FIELD), { value: 'third', rows: 1, caret: 5 })
    await browser.keys([Key.ArrowDown])
    await waitForValue('restored draft', () => fieldState(FIND_FIELD), { value: 'lazyx', rows: 1, caret: 5 })

    // In a multi-line search, ArrowUp off the first line moves the caret
    // up a line; only ArrowUp on the first line recalls.
    await browser.keys([Key.Shift, Key.Enter])
    await typeKeys('fox')
    await waitForValue('multi-line draft', () => fieldState(FIND_FIELD), { value: 'lazyx\nfox', rows: 2, caret: 9 })
    // The native caret move keeps the pixel x position, so with a
    // proportional font only the line is fixed, not the column.
    await browser.keys([Key.ArrowUp])
    await waitForValue(
      'caret after ArrowUp on the last line',
      async () => {
        const { value, rows, caret } = await fieldState(FIND_FIELD)
        return { value, rows, caretOnFirstLine: caret <= value.indexOf('\n') }
      },
      { value: 'lazyx\nfox', rows: 2, caretOnFirstLine: true }
    )
    await browser.keys([Key.ArrowUp])
    await waitForValue('field after ArrowUp on the first line', () => fieldState(FIND_FIELD), { value: 'third', rows: 1, caret: 5 })
  })

  it('grows the fields with Shift+Enter up to three rows and matches across lines', async () => {
    await openFixture()
    await openFindWithQuery('')
    await waitForValue('empty field', () => fieldState(FIND_FIELD), { value: '', rows: 1, caret: 0 })

    await typeKeys('brown fox.')
    await browser.keys([Key.Shift, Key.Enter])
    await typeKeys('fox two')
    await waitForValue('two-line field', () => fieldState(FIND_FIELD), { value: 'brown fox.\nfox two', rows: 2, caret: 18 })
    // The match spans the line break, so it draws one element per line.
    await waitForValue('status', findStatus, '1 of 1')
    await waitForValue('current match', currentMatchTexts, ['brown fox.', 'fox two'])

    await browser.keys([Key.Shift, Key.Enter])
    await typeKeys('a')
    await waitForValue('three-line field', () => fieldState(FIND_FIELD), { value: 'brown fox.\nfox two\na', rows: 3, caret: 20 })
    await browser.keys([Key.Shift, Key.Enter])
    await typeKeys('b')
    await waitForValue('four-line field', () => fieldState(FIND_FIELD), { value: 'brown fox.\nfox two\na\nb', rows: 3, caret: 22 })
    await waitForValue('status', findStatus, 'No results')

    // Deleting the newlines shrinks the field again.
    for (let i = 0; i < 4; i++) await browser.keys([Key.Backspace])
    await waitForValue('shrunk field', () => fieldState(FIND_FIELD), { value: 'brown fox.\nfox two', rows: 2, caret: 18 })
    await waitForValue('status', findStatus, '1 of 1')

    await setReplaceOpen(true)
    await typeInto(browser, REPLACE_FIELD, 'x', { clear: true })
    await browser.keys([Key.Shift, Key.Enter])
    await typeKeys('y')
    await waitForValue('two-line replace field', () => fieldState(REPLACE_FIELD), { value: 'x\ny', rows: 2, caret: 3 })
  })

  it('closes with Esc from the dropdown, the editor, and elsewhere, clearing the highlights', async () => {
    await openFixture()
    await openFindWithQuery('fox')
    await waitForValue('status', findStatus, '1 of 4')
    await waitForValue('match count', matchCount, 4)
    await waitForValue('selection drawn', selectionDrawn, true)

    // Esc in the search field: the selected match collapses to a cursor and
    // focus returns to the editor.
    await browser.keys([Key.Escape])
    await waitForValue('dropdown open', dropdownOpen, false)
    await waitForValue('match count after Esc', matchCount, 0)
    await waitForValue('selection drawn after Esc', selectionDrawn, false)
    expect(await focusedArea()).toBe('editor')

    // Ctrl+F in the editor reopens with the query kept and searches from the
    // cursor at the end of the first match.
    await browser.keys([Key.Control, 'f'])
    await waitFor(browser, FIND_FIELD, 10_000)
    expect((await fieldState(FIND_FIELD)).value).toBe('fox')
    await waitForValue('status after reopening', findStatus, '2 of 4')
    await waitForValue('match count after reopening', matchCount, 4)

    await focusEditor()
    await browser.keys([Key.Escape])
    await waitForValue('dropdown open after Esc in the editor', dropdownOpen, false)
    await waitForValue('match count after Esc in the editor', matchCount, 0)

    await browser.keys([Key.Control, 'f'])
    await waitFor(browser, FIND_FIELD, 10_000)
    await waitForValue('match count after reopening', matchCount, 4)
    await browser.execute(() => (document.activeElement as HTMLElement | null)?.blur())
    expect(await focusedArea()).toBe('body')
    await browser.keys([Key.Escape])
    await waitForValue('dropdown open after Esc elsewhere', dropdownOpen, false)
    await waitForValue('match count after Esc elsewhere', matchCount, 0)
  })

  it('closes only an open Settings or History modal on Esc, and find on the next Esc', async () => {
    const settingsOpen = async (): Promise<boolean> =>
      browser.execute(() => document.querySelector('.settings-overlay') !== null)
    const historyOpen = async (): Promise<boolean> =>
      browser.execute(() => document.querySelector('.history-overlay') !== null)

    await openFixture()
    await openFindWithQuery('fox')
    await waitForValue('status', findStatus, '1 of 4')

    // The modals do not take focus, so Esc goes to the editor first. The
    // current match must stay selected.
    await focusEditor()
    await browser.keys([Key.Control, ','])
    await waitForValue('settings open', settingsOpen, true)
    expect(await focusedArea()).toBe('editor')
    await browser.keys([Key.Escape])
    await waitForValue('settings open after Esc in the editor', settingsOpen, false)
    expect(await dropdownOpen()).toBe(true)
    expect(await findStatus()).toBe('1 of 4')
    await browser.keys([Key.Escape])
    await waitForValue('dropdown open after the second Esc in the editor', dropdownOpen, false)

    await browser.keys([Key.Control, 'f'])
    await waitFor(browser, FIND_FIELD, 10_000)
    await browser.keys([Key.Control, 'h'])
    await waitForValue('history open', historyOpen, true)
    expect(await focusedArea()).toBe('find')
    await browser.keys([Key.Escape])
    await waitForValue('history open after Esc in the search field', historyOpen, false)
    expect(await dropdownOpen()).toBe(true)
    await browser.keys([Key.Escape])
    await waitForValue('dropdown open after the second Esc in the search field', dropdownOpen, false)
  })
})
