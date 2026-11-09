import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Key } from 'webdriverio'
import { startApp, type RunningApp } from './harness/app'
import { consoleErrors, resetConsoleErrors, screenshotOnFailure, waitFor, waitForValue } from './harness/dom'
import { makeConversation, seedAppState, seedConversation } from './harness/fixtures'
import { createSession, destroySession, type E2EBrowser } from './harness/session'
import { focusEditor, misplacedLines, threadSections, type ThreadSection } from './harness/thread'

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

// Every heading level, as ATX and setext headings, then body text.
const ATX_HEADINGS = [
  '# Heading one',
  '## Heading two',
  '### Heading three',
  '#### Heading four',
  '##### Heading five',
  '###### Heading six',
]
const SETEXT_ONE = 'Setext one'
const SETEXT_TWO = 'Setext two'
const BODY = 'Body text'
const HEADING_LINES = [...ATX_HEADINGS, SETEXT_ONE, SETEXT_TWO, BODY]
const HEADING_TEXT = [...ATX_HEADINGS, '', SETEXT_ONE, '==========', '', SETEXT_TWO, '----------', '', BODY].join('\n')

// What breaks the heading scale in `sizes` (from `lineFontSizes`), or [].
// Each ATX level is smaller than the level above it, level 6 is the body
// size, level 1 is at most 1.5 times the body size, and a setext heading
// is the size of its ATX level.
function headingScaleProblems (sizes: Record<string, number | string>): string[] {
  const notes = Object.entries(sizes).filter(([, size]) => typeof size === 'string')
  if (notes.length > 0) return notes.map(([line, note]) => `${line}: ${note}`)
  const px = sizes as Record<string, number>
  const sized = (line: string): string => `${line} (${px[line]}px)`
  const problems: string[] = []
  ATX_HEADINGS.slice(1).forEach((line, index) => {
    if (px[line] >= px[ATX_HEADINGS[index]]) problems.push(`${sized(line)} is not smaller than ${sized(ATX_HEADINGS[index])}`)
  })
  if (px[ATX_HEADINGS[5]] !== px[BODY]) problems.push(`${sized(ATX_HEADINGS[5])} is not the body size, ${sized(BODY)}`)
  if (px[ATX_HEADINGS[0]] > 1.5 * px[BODY]) problems.push(`${sized(ATX_HEADINGS[0])} is more than 1.5 times ${sized(BODY)}`)
  if (px[SETEXT_ONE] !== px[ATX_HEADINGS[0]]) problems.push(`${sized(SETEXT_ONE)} is not the size of ${sized(ATX_HEADINGS[0])}`)
  if (px[SETEXT_TWO] !== px[ATX_HEADINGS[1]]) problems.push(`${sized(SETEXT_TWO)} is not the size of ${sized(ATX_HEADINGS[1])}`)
  return problems
}

// The size of each line in `sizes` (from `lineFontSizes`) relative to the
// body text, to two decimals: the scale must stay the same at every
// editor font size.
function relativeSizes (sizes: Record<string, number | string>): Record<string, number> {
  return Object.fromEntries(Object.entries(sizes).map(([line, size]) => [line, Math.round(Number(size) / Number(sizes[BODY]) * 100) / 100]))
}

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

  // The computed font size, in px, of the text of each drawn editor line
  // whose whole text is one of `lines`; 'missing' when no such line is
  // drawn, or the sizes when its text has more than one size.
  async function lineFontSizes (lines: string[]): Promise<Record<string, number | string>> {
    return browser.execute((wanted: string[]) => {
      const content = document.querySelector('.cm-content')
      if (!content) throw new Error('lineFontSizes: no editor')
      const drawn = [...content.querySelectorAll<HTMLElement>(':scope > .cm-line')]
      const sizes: Record<string, number | string> = {}
      for (const text of wanted) {
        const line = drawn.find((el) => el.textContent === text)
        if (!line) {
          sizes[text] = 'missing'
          continue
        }
        const found = new Set<number>()
        const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT)
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if (node.parentElement) found.add(parseFloat(getComputedStyle(node.parentElement).fontSize))
        }
        sizes[text] = found.size === 1 ? [...found][0] : `sizes ${[...found].join(', ')}`
      }
      return sizes
    }, lines)
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

  // The whole heading line scales, hash marks too. Taller lines must also
  // be in CodeMirror's height map, or the caret and clicks land on the
  // wrong line; the doc is shorter than the editor, the case where
  // CodeMirror sees no size change by itself (see font-size.e2e.ts).
  it('sizes each heading level, and the sizes follow the editor font size', async () => {
    await openFixture([
      { role: 'user', text: 'Show me every heading' },
      { role: 'agent', text: HEADING_TEXT },
      { role: 'user', text: 'Thanks' },
    ])
    await waitForValue(browser, 'heading scale', async () => headingScaleProblems(await lineFontSizes(HEADING_LINES)), [])
    const sizes = await lineFontSizes(HEADING_LINES)
    expect(sizes[BODY]).toBe(15)
    await waitForValue(browser, 'height map', () => misplacedLines(browser), [])

    await focusEditor(browser)
    await browser.keys([Key.Control, '='])
    await waitForValue(browser, 'heading scale after Ctrl+=', async () => {
      const larger = await lineFontSizes(HEADING_LINES)
      return { body: larger[BODY], scale: relativeSizes(larger) }
    }, { body: 16, scale: relativeSizes(sizes) })
    await waitForValue(browser, 'height map after Ctrl+=', () => misplacedLines(browser), [])

    // Back to the default size, which the other tests expect.
    await browser.keys([Key.Control, '-'])
    await waitForValue(browser, 'body size after Ctrl+-', async () => (await lineFontSizes([BODY]))[BODY], 15)
  })
})
