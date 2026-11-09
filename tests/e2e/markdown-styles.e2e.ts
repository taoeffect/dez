import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { startApp, type RunningApp } from './harness/app'
import { consoleErrors, resetConsoleErrors, screenshotOnFailure, waitFor, waitForValue } from './harness/dom'
import { makeConversation, seedAppState, seedConversation } from './harness/fixtures'
import { createSession, destroySession, type E2EBrowser } from './harness/session'
import { threadSections, type ThreadSection } from './harness/thread'

// How the thread editor styles markdown, read as computed styles in the
// real app.
//
// One app session serves the whole file. Each test opens its fixture in a
// new tab.

// The issue's sample (inline code in a paragraph and in list items), with
// inline code and links in the other block kinds.
const INLINE_TEXT = [
  'Many of these also have a `:batch` variant for asynchronous batch jobs.',
  '',
  '## Venice `heading-code`',
  '',
  '- Gemini 4 Argon (`venice/gemini-4-argon`)',
  '- See [list link](https://example.com/list) and <https://example.com/auto>',
  '',
  '1. Ordered `ordered-code`',
  '',
  '> Quoted words, `quote-code` and [quote link](https://example.com/quote)',
  '',
  'Plain [paragraph link](https://example.com/para).',
].join('\n')

interface ThemeColors {
  text: string
  muted: string
  link: string
  code: string
}

describe('markdown styles', () => {
  let app: RunningApp
  let browser: E2EBrowser
  let fixtureCount = 0

  // Seeds a conversation with `sections`, opens it in a new tab, and waits
  // until the tab shows it.
  async function openFixture (sections: ThreadSection[]): Promise<void> {
    const id = `markdown-styles-e2e-${++fixtureCount}`
    await seedConversation(app.home, makeConversation({
      id,
      title: id,
      sections: sections.map(({ role, text }) => ({ role: role as 'user' | 'agent', nodes: [{ kind: 'text', text }] })),
    }))
    await browser.execute((conversationId: string) => {
      const sbp = Reflect.get(window, 'sbp') as (selector: string, ...args: unknown[]) => unknown
      void sbp('dez.model/tabs/openConversation', conversationId)
    }, id)
    await waitForValue(browser, `fixture ${id} open`, () => threadSections(browser), sections)
  }

  // The theme's colors as computed colors (`rgb(...)`), so that they
  // compare with the computed colors of the editor text.
  async function themeColors (): Promise<ThemeColors> {
    return browser.execute(() => {
      const probe = document.createElement('span')
      document.body.append(probe)
      const resolve = (variable: string): string => {
        probe.style.color = `var(${variable})`
        return getComputedStyle(probe).color
      }
      const colors = { text: resolve('--color-text'), muted: resolve('--color-muted'), link: resolve('--color-link'), code: resolve('--color-code') }
      probe.remove()
      return colors
    })
  }

  // The computed color and font style of the editor text node that holds
  // each of `texts`, as `color style`, or 'missing' when no text node
  // holds it.
  async function textStyles (texts: string[]): Promise<Record<string, string>> {
    return browser.execute((wanted: string[]) => {
      const content = document.querySelector('.cm-content')
      if (!content) throw new Error('textStyles: no editor')
      const nodes: Text[] = []
      const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text)
      const styles: Record<string, string> = {}
      for (const text of wanted) {
        const parent = nodes.find((node) => node.data.includes(text))?.parentElement
        const style = parent ? getComputedStyle(parent) : null
        styles[text] = style ? `${style.color} ${style.fontStyle}` : 'missing'
      }
      return styles
    }, texts)
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

  // Errors thrown inside CodeMirror plugins and Vue handlers are only
  // logged, so the page records console.error calls and each test checks
  // the record.
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

  it('colors inline code and links the same in paragraphs, headings, lists, and quotes', async () => {
    await openFixture([
      { role: 'user', text: 'Show me some markdown' },
      { role: 'agent', text: INLINE_TEXT },
      { role: 'user', text: 'Thanks' },
    ])
    const colors = await themeColors()
    const code = `${colors.code} normal`
    const link = `${colors.link} normal`
    // All text in a quote is italic; inline code and links keep their color.
    const quoteCode = `${colors.code} italic`
    const quoteLink = `${colors.link} italic`

    await waitForValue(browser, 'inline code and link styles', () => textStyles([
      ':batch',
      'heading-code',
      'venice/gemini-4-argon',
      'ordered-code',
      'quote-code',
      'Quoted words',
      'paragraph link',
      'list link',
      'https://example.com/auto',
      'quote link',
    ]), {
      ':batch': code,
      'heading-code': code,
      'venice/gemini-4-argon': code,
      'ordered-code': code,
      'quote-code': quoteCode,
      'Quoted words': `${colors.muted} italic`,
      'paragraph link': link,
      'list link': link,
      'https://example.com/auto': link,
      'quote link': quoteLink,
    })
  })

  // The issue's conversation: replies cut off inside a quote, once inside
  // a list item. The quotes end with their sections.
  it('styles no user text as a quote after a reply that ends in a quote', async () => {
    await openFixture([
      { role: 'user', text: 'Is there a quote by George Orwell about thoughtcrime?' },
      { role: 'agent', text: 'Here are the quotes:\n\n*   **On the goal of Newspeak:**\n    > "In the end we shall make thoughtcrime impossible. Every' },
      { role: 'user', text: 'finish the quote' },
      { role: 'agent', text: 'Here is all of it:\n\n> "In the end we shall make thoughtcrime literally impossible, because' },
      { role: 'user', text: 'Why do you keep cutting it off?' },
    ])
    const colors = await themeColors()

    await waitForValue(browser, 'quote and user text styles', () => textStyles([
      'literally impossible',
      'finish the quote',
      'Why do you keep cutting it off?',
    ]), {
      'literally impossible': `${colors.muted} italic`,
      'finish the quote': `${colors.text} normal`,
      'Why do you keep cutting it off?': `${colors.text} normal`,
    })
  })
})
