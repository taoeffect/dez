import fs from 'node:fs'
import type { EditorView } from '@codemirror/view'
import { expect } from 'vitest'
import { Key } from 'webdriverio'
import type { ToastVariant } from '../../../src/view/toast/selectors'
import { click, typeKeys, waitFor, waitForValue, type Point } from './dom'
import { conversationFilePath } from './fixtures'
import type { E2EBrowser } from './session'

// Helpers that drive the thread editor and the model picker through the
// app's page globals (`window.sbp`) and DOM. Specs that send chat requests
// to a mock server share them.

export interface ThreadSection {
  role: string
  text: string
}

/** Call an SBP selector in the page and return its (awaited) result. */
export async function sbpCall (browser: E2EBrowser, selector: string, ...args: unknown[]): Promise<unknown> {
  return browser.execute(async (sel: string, selectorArgs: unknown[]) => {
    const sbp = Reflect.get(window, 'sbp') as (selector: string, ...args: unknown[]) => unknown
    return await sbp(sel, ...selectorArgs)
  }, selector, args)
}

/** The id of the active tab. */
export async function activeTabId (browser: E2EBrowser): Promise<string> {
  return await sbpCall(browser, 'dez.model/tabs/activeId') as string
}

/** The conversation id of the active tab. */
export async function activeConversationId (browser: E2EBrowser): Promise<string> {
  // `dez.model/tab` returns the tab record of the store.
  const tab = await sbpCall(browser, 'dez.model/tab', await activeTabId(browser)) as { conversationId: string }
  return tab.conversationId
}

/** Opens a new tab and waits until it shows its one empty user section. */
export async function newTab (browser: E2EBrowser): Promise<void> {
  await sbpCall(browser, 'dez.model/tabs/create')
  await waitForValue(browser, 'new tab', () => threadSections(browser), [{ role: 'user', text: '' }])
}

/** The active tab's sections as role and plain text. */
export async function threadSections (browser: E2EBrowser): Promise<ThreadSection[]> {
  return browser.execute(() => {
    const sbp = Reflect.get(window, 'sbp') as (selector: string, ...args: unknown[]) => unknown
    const sections = sbp('dez.model/thread/sections') as Array<{ role: string, content: Array<{ kind: string, text?: string }> }>
    return sections.map((section) => ({
      role: section.role,
      text: section.content.map((node) => node.kind === 'text' ? node.text ?? '' : '').join(''),
    }))
  })
}

/** One row of a model picker's list, as the page shows it. */
export interface PickerRowView {
  kind: 'none' | 'header' | 'model'
  /** The label of a header, or the name that a model row or the None row
   *  shows. */
  text: string
  /** The tooltip of a model row's name; '' for the other rows. */
  title: string
  /** The row has the selected look. */
  active: boolean
}

/**
 * Reads the rows of a picker's list. It runs in the page (`browser.execute`
 * sends its source), so it uses nothing from this module.
 *
 * The picker draws its list with a virtual list: the DOM holds only the rows
 * near the visible part, and each row has its own place in a box that is as
 * tall as all rows. With `scroll`, this reads every row: it starts at the
 * top and scrolls down one visible part at a time, then puts the scroll
 * position back. Without `scroll`, it reads only the rows that the DOM holds
 * now. With `pick`, it clicks the row of that model when it reads it, and
 * stops.
 *
 * A row can be in more than one read, and the DOM gives a row that comes
 * back a new element. So a row counts as read by its place in the box, not
 * by its element.
 */
async function scanPicker (
  rootSelector: string,
  scroll: boolean,
  pick: { provider: string, model: string } | null
): Promise<{ rows: PickerRowView[], picked: boolean }> {
  const list = document.querySelector<HTMLElement>(`${rootSelector} .model-picker-list`)
  // The box of the virtual list.
  const box = list?.firstElementChild
  // A picker that is not open has no rows.
  if (!list || !box) return { rows: [], picked: false }

  // The row elements, once the list has drawn the rows for its scroll
  // position. The list draws them some frames after a scroll or a change of
  // its data: it must first measure new rows to give the next rows their
  // places. The rows are ready when each row starts where the row before it
  // ends, and together they fill the visible part of the box.
  const drawnRows = async (): Promise<HTMLElement[]> => {
    const deadline = performance.now() + 5000
    for (;;) {
      const elements = Array.from(list.querySelectorAll<HTMLElement>('.model-group-header, .model-item'))
      const rects = elements.map((element) => element.getBoundingClientRect())
      const listRect = list.getBoundingClientRect()
      const boxRect = box.getBoundingClientRect()
      const top = Math.max(listRect.top, boxRect.top)
      const bottom = Math.min(listRect.bottom, boxRect.bottom)
      const tiles = rects.every((rect, index) => index === 0 || Math.abs(rect.top - rects[index - 1].bottom) <= 1)
      const fills = bottom - top < 1 ||
        (rects.length > 0 && rects[0].top <= top + 1 && rects[rects.length - 1].bottom >= bottom - 1)
      if (tiles && fills) return elements
      if (performance.now() > deadline) {
        throw new Error(`scanPicker: the ${elements.length} drawn rows of ${rootSelector} do not fill the list at scroll position ${list.scrollTop}`)
      }
      await new Promise((resolve) => requestAnimationFrame(resolve))
    }
  }

  const rows: PickerRowView[] = []
  const start = list.scrollTop
  // The label of the last header read.
  let group = ''
  // Where the last row read ends, in px from the top of the box.
  let end = 0
  if (scroll) list.scrollTop = 0
  for (;;) {
    const elements = await drawnRows()
    const boxTop = box.getBoundingClientRect().top
    for (const element of elements) {
      const rect = element.getBoundingClientRect()
      if (rows.length > 0) {
        if (rect.top - boxTop < end - 1) continue
        if (rect.top - boxTop > end + 1) throw new Error(`scanPicker: no row from ${end} to ${rect.top - boxTop} px in ${rootSelector}`)
      }
      end = rect.bottom - boxTop
      const name = element.querySelector<HTMLElement>('.model-item-name')
      const row: PickerRowView = {
        kind: element.matches('.model-group-header') ? 'header' : element.matches('.model-item--none') ? 'none' : 'model',
        text: (name ?? element).textContent?.trim() ?? '',
        title: name?.title ?? '',
        active: element.matches('.model-item--active'),
      }
      rows.push(row)
      if (row.kind === 'header') {
        group = row.text
      } else if (pick && row.kind === 'model' && group === pick.provider && row.text === pick.model) {
        element.click()
        return { rows, picked: true }
      }
    }
    if (!scroll || list.scrollTop + list.clientHeight >= list.scrollHeight - 1) break
    list.scrollTop += list.clientHeight
  }
  if (scroll) list.scrollTop = start
  return { rows, picked: false }
}

/** Every row of the open picker's list, top to bottom: the picker of the
 *  bottom bar, or the one inside `root`. It scrolls the list to read the
 *  rows that are not drawn, and puts the scroll position back. */
export async function pickerRows (browser: E2EBrowser, root = '.model-dropdown'): Promise<PickerRowView[]> {
  return (await browser.execute(scanPicker, root, true, null)).rows
}

/** The rows of the open picker's list that are in the DOM now, top to
 *  bottom: the rows in view and some rows above and below them. */
export async function drawnPickerRows (browser: E2EBrowser, root = '.model-dropdown'): Promise<PickerRowView[]> {
  return (await browser.execute(scanPicker, root, false, null)).rows
}

/** The open picker's groups: provider name and model names, in order. The
 *  picker of the bottom bar, or the one inside `root`. */
export async function pickerGroups (browser: E2EBrowser, root = '.model-dropdown'): Promise<Array<{ provider: string, models: string[] }>> {
  const groups: Array<{ provider: string, models: string[] }> = []
  for (const row of await pickerRows(browser, root)) {
    if (row.kind === 'header') groups.push({ provider: row.text, models: [] })
    // The None row comes before the first header and is in no group.
    else if (row.kind === 'model') groups[groups.length - 1].models.push(row.text)
  }
  return groups
}

export async function openPicker (browser: E2EBrowser): Promise<void> {
  await click(browser, '.model-selector-btn')
  await waitFor(browser, '.model-dropdown', 10_000)
}

/** Picks the model named `modelName` in the picker group of `providerName`. */
export async function pickModel (browser: E2EBrowser, providerName: string, modelName: string): Promise<void> {
  await openPicker(browser)
  // The list fills after the picker opens, so read it until the model is
  // there.
  await waitForValue(browser, `${providerName} › ${modelName} picked`, async () =>
    (await browser.execute(scanPicker, '.model-dropdown', true, { provider: providerName, model: modelName })).picked, true)
  await waitForValue(browser, 'selected model', () => browser.execute(
    () => document.querySelector('.model-selector-label')?.textContent?.trim() ?? null
  ), modelName)
}

/** Moves the focus into the thread editor. */
export async function focusEditor (browser: E2EBrowser): Promise<void> {
  await browser.execute(() => {
    const content = document.querySelector<HTMLElement>('.cm-content')
    if (!content) throw new Error('focusEditor: .cm-content not found')
    content.focus()
  })
}

/** Where the focus is: 'find' or 'replace' for the find dropdown fields,
 *  'editor' for the thread editor, else the tag name of the focused
 *  element. */
export async function focusedArea (browser: E2EBrowser): Promise<string> {
  return browser.execute(() => {
    const el = document.activeElement
    if (!el) return 'none'
    if (el.matches('.find-field')) return el.getAttribute('aria-label')?.toLowerCase() ?? 'field'
    if (el.matches('.cm-content')) return 'editor'
    return el.tagName.toLowerCase()
  })
}

/** The text of the active editor's CodeMirror doc, with its live
 *  sentinels. */
export async function editorDoc (browser: E2EBrowser): Promise<string> {
  return browser.execute(() => {
    const content = document.querySelector('.cm-content')
    if (!content) throw new Error('editorDoc: .cm-content not found')
    const view = Reflect.get(Reflect.get(content, 'cmTile'), 'root').view as EditorView
    return view.state.doc.toString()
  })
}

/** Sets the active editor's main selection to `anchor`…`head` (a caret
 *  when `head` is left out) with a selection transaction, as code does. */
export async function setCaret (browser: E2EBrowser, anchor: number, head = anchor): Promise<void> {
  await browser.execute((from: number, to: number) => {
    const content = document.querySelector('.cm-content')
    if (!content) throw new Error('setCaret: .cm-content not found')
    const view = Reflect.get(Reflect.get(content, 'cmTile'), 'root').view as EditorView
    view.dispatch({ selection: { anchor: from, head: to } })
  }, anchor, head)
}

/** The head of the active editor's main selection. */
export async function editorCaret (browser: E2EBrowser): Promise<number> {
  return browser.execute(() => {
    const content = document.querySelector('.cm-content')
    if (!content) throw new Error('editorCaret: .cm-content not found')
    const view = Reflect.get(Reflect.get(content, 'cmTile'), 'root').view as EditorView
    return view.state.selection.main.head
  })
}

/** Doc position of `text` in the active editor plus `offset`; fails if
 *  `text` is not in the doc. */
export async function docPos (browser: E2EBrowser, text: string, offset = 0): Promise<number> {
  const index = (await editorDoc(browser)).indexOf(text)
  if (index < 0) throw new Error(`docPos: ${JSON.stringify(text)} is not in the doc`)
  return index + offset
}

/** Viewport point at doc position `pos`: x is the caret position (`side`
 *  picks the char before or after it), y the middle of its line. */
export async function docPosPoint (browser: E2EBrowser, pos: number, side: -1 | 1): Promise<Point> {
  return browser.execute((target: number, bias: -1 | 1) => {
    const content = document.querySelector('.cm-content')
    if (!content) throw new Error('docPosPoint: .cm-content not found')
    const view = Reflect.get(Reflect.get(content, 'cmTile'), 'root').view as EditorView
    const coords = view.coordsAtPos(target, bias)
    if (!coords) throw new Error(`docPosPoint: no coords for ${target}`)
    return { x: coords.left, y: (coords.top + coords.bottom) / 2 }
  }, pos, side)
}

/** The height of every role pill of the active editor. */
export async function rolePillHeights (browser: E2EBrowser): Promise<number[]> {
  return browser.execute(() =>
    Array.from(document.querySelectorAll('.cm-content .dez-role-separator__label')).map((pill) => pill.getBoundingClientRect().height)
  )
}

/** The drawn lines of the active editor whose place in CodeMirror's height
 *  map is not where the DOM draws them, as `line N: map top+height, DOM
 *  top+height`. On such a line the caret and clicks land on the wrong
 *  line. */
export async function misplacedLines (browser: E2EBrowser): Promise<string[]> {
  return browser.execute(() => {
    const content = document.querySelector<HTMLElement>('.cm-content')
    if (!content) throw new Error('misplacedLines: .cm-content not found')
    const view = Reflect.get(Reflect.get(content, 'cmTile'), 'root').view as EditorView
    const misplaced: string[] = []
    for (const line of content.querySelectorAll<HTMLElement>(':scope > .cm-line')) {
      const rect = line.getBoundingClientRect()
      const block = view.lineBlockAt(view.posAtDOM(line))
      const top = view.documentTop + block.top
      if (Math.abs(top - rect.top) > 1 || Math.abs(block.height - rect.height) > 1) {
        const number = view.state.doc.lineAt(block.from).number
        misplaced.push(`line ${number}: map ${Math.round(top)}+${Math.round(block.height)}, DOM ${Math.round(rect.top)}+${Math.round(rect.height)}`)
      }
    }
    return misplaced
  })
}

/** A mousedown on `part` of the role pill before section `index`, as a
 *  click gives. */
export async function pressRolePill (browser: E2EBrowser, index: number, part = '.dez-role-separator__label'): Promise<void> {
  await browser.execute((sectionIndex: number, selector: string) => {
    const target = document.querySelector(`.cm-content .dez-role-separator[data-section-index="${sectionIndex}"] ${selector}`)
    if (!target) throw new Error(`pressRolePill: no ${selector} for section ${sectionIndex}`)
    target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }))
  }, index, part)
}

/** The marker lines of a conversation file, or null while it does not
 *  exist. */
export async function savedPillLines (home: string, conversationId: string): Promise<string[] | null> {
  try {
    const content = await fs.promises.readFile(conversationFilePath(home, conversationId), 'utf8')
    return content.split('\n').filter((line) => line.startsWith('<dez:pill'))
  } catch {
    return null
  }
}

/** A saved pill line with its reply time as `#`: the time changes from run
 *  to run. */
export function maskPillDuration (line: string): string {
  return line.replace(/ duration-ms="\d+"/, ' duration-ms="#"')
}

/** Types `text` at the end of the active tab, then submits it with
 *  Ctrl+Enter. A new reply lands after the trailing user section. */
export async function submit (browser: E2EBrowser, text: string): Promise<void> {
  await focusEditor(browser)
  await browser.keys([Key.Control, Key.End])
  await typeKeys(browser, text)
  await browser.keys([Key.Control, Key.Enter])
}

/** Whether a stream runs in the active tab. */
export async function activeTabStreaming (browser: E2EBrowser): Promise<boolean> {
  return browser.execute(() => {
    const sbp = Reflect.get(window, 'sbp') as (selector: string, ...args: unknown[]) => unknown
    return sbp('dez.model/streams/isStreaming', sbp('dez.model/tabs/activeId')) as boolean
  })
}

/** Title and message of each open (not closing) toast of `variant`, or of
 *  every variant when it is not given. A toast with no title gives ''. */
export async function openToasts (browser: E2EBrowser, variant?: ToastVariant): Promise<Array<{ title: string, message: string }>> {
  return browser.execute((selector: string) => Array.from(
    document.querySelectorAll(`${selector}:not(.toast-card--closing)`),
    (card) => ({
      title: card.querySelector('.toast-title')?.textContent ?? '',
      message: card.querySelector('.toast-message')?.textContent ?? '',
    })
  ), variant ? `.toast-card--${variant}` : '.toast-card')
}

/** Waits until the active tab holds `expected` and no stream runs, then
 *  checks that no error toast is open. */
export async function waitForThread (browser: E2EBrowser, expected: ThreadSection[]): Promise<void> {
  await waitForValue(browser, 'thread sections', () => threadSections(browser), expected)
  await waitForValue(browser, 'streaming', () => activeTabStreaming(browser), false)
  expect(await openToasts(browser, 'error')).toEqual([])
}
