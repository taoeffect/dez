import fs from 'node:fs'
import type { EditorView } from '@codemirror/view'
import { expect } from 'vitest'
import { Key } from 'webdriverio'
import type { ModelRef } from '../../../src/model/chat/types'
import type { ToastVariant } from '../../../src/view/toast/selectors'
import { click, typeKeys, waitFor, waitForValue, type Point } from './dom'
import { conversationFilePath, makeConversation, seedConversation } from './fixtures'
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

/** The title that the tab bar shows for the active tab. */
export async function activeTabTitle (browser: E2EBrowser): Promise<string | null> {
  return browser.execute(() => document.querySelector('.tab--active .tab-title')?.textContent ?? null)
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

/** Whether the model picker of the bottom bar, or the one at `root`, is
 *  open. */
export async function pickerOpen (browser: E2EBrowser, root = '.model-dropdown'): Promise<boolean> {
  return browser.execute((rootSelector: string) => document.querySelector(rootSelector) !== null, root)
}

/** The name of the model that the model button of the bottom bar shows. */
export async function selectedModelName (browser: E2EBrowser): Promise<string | null> {
  return browser.execute(() => document.querySelector('.model-selector-label')?.textContent?.trim() ?? null)
}

/** Picks the model named `modelName` in the picker group of `providerName`. */
export async function pickModel (browser: E2EBrowser, providerName: string, modelName: string): Promise<void> {
  await openPicker(browser)
  // The list fills after the picker opens, so read it until the model is
  // there.
  await waitForValue(browser, `${providerName} › ${modelName} picked`, async () =>
    (await browser.execute(scanPicker, '.model-dropdown', true, { provider: providerName, model: modelName })).picked, true)
  await waitForValue(browser, 'selected model', () => selectedModelName(browser), modelName)
}

/** Moves the focus into the thread editor and keeps its view where it is,
 *  with CodeMirror's `focus()`, as a click in the text does.
 *
 *  Why not `content.focus()`: on the first focus of the editor in an app
 *  session, the DOM selection is not in the editor, so WebKit puts its
 *  caret at the doc start and scrolls the view there. A spec that scrolled
 *  to an image first then had no image in the view. CodeMirror focuses
 *  with `preventScroll`, and on WebKit puts back each scroll position that
 *  the focus changed. */
export async function focusEditor (browser: E2EBrowser): Promise<void> {
  await browser.execute(() => {
    const content = document.querySelector('.cm-content')
    if (!content) throw new Error('focusEditor: .cm-content not found')
    const view = Reflect.get(Reflect.get(content, 'cmTile'), 'root').view as EditorView
    view.focus()
  })
}

/** What a view at its bottom may still have below it: scroll positions
 *  can be fractions of a pixel. */
export const AT_BOTTOM_PX = 1

/** The distance from the bottom of the editor's view to the bottom of its
 *  scrollable area, read two frames after the last change so that the
 *  scroll work of that change is done. */
export async function viewFromBottom (browser: E2EBrowser): Promise<number> {
  return browser.execute(() => new Promise<number>((resolve, reject) => {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const scroll = document.querySelector<HTMLElement>('.cm-scroller')
      if (!scroll) reject(new Error('viewFromBottom: .cm-scroller not found'))
      else resolve(scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight)
    }))
  }))
}

/** Scrolls the thread editor to its top: the editor draws only the pills
 *  and chips near the view. */
export async function scrollEditorToTop (browser: E2EBrowser): Promise<void> {
  await browser.execute(() => {
    const scroller = document.querySelector('.cm-scroller')
    if (!scroller) throw new Error('scrollEditorToTop: .cm-scroller not found')
    scroller.scrollTop = 0
  })
}

/** Scrolls the thread editor to its end, where CM draws the last lines. */
export async function scrollEditorToEnd (browser: E2EBrowser): Promise<void> {
  await browser.execute(() => {
    const scroller = document.querySelector('.cm-scroller')
    if (!scroller) throw new Error('scrollEditorToEnd: .cm-scroller not found')
    scroller.scrollTop = scroller.scrollHeight
  })
}

/** The scroll position of the thread editor. */
export async function editorScrollTop (browser: E2EBrowser): Promise<number> {
  return browser.execute(() => {
    const scroller = document.querySelector('.cm-scroller')
    if (!scroller) throw new Error('editorScrollTop: .cm-scroller not found')
    return scroller.scrollTop
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

/** Where the active editor's view is. */
export interface ViewPlace {
  /** The doc position of the line block at the top edge of the view. */
  pos: number
  /** The number of the doc line of that block. */
  line: number
  /** Px from the top of that block down to the top edge of the view. */
  offset: number
  scrollTop: number
  /** Px of the scroller below the bottom edge of the view. */
  fromBottom: number
  /** The main selection. */
  anchor: number
  head: number
}

/** The place of the active editor's view, read two frames after the last
 *  change so that the scroll work of that change is done. A spec takes the
 *  fields that it checks. */
export async function viewPlace (browser: E2EBrowser): Promise<ViewPlace> {
  return browser.execute(() => new Promise<ViewPlace>((resolve, reject) => {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const content = document.querySelector('.cm-content')
      if (!content) {
        reject(new Error('viewPlace: .cm-content not found'))
        return
      }
      const view = Reflect.get(Reflect.get(content, 'cmTile'), 'root').view as EditorView
      const scroll = view.scrollDOM
      const top = scroll.getBoundingClientRect().top - view.documentTop
      const block = view.lineBlockAtHeight(top)
      const { anchor, head } = view.state.selection.main
      resolve({
        pos: block.from,
        line: view.state.doc.lineAt(block.from).number,
        offset: top - block.top,
        scrollTop: scroll.scrollTop,
        fromBottom: scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight,
        anchor,
        head,
      })
    }))
  }))
}

/** The anchor and the head of the active editor's main selection. */
export async function editorSelection (browser: E2EBrowser): Promise<{ anchor: number, head: number }> {
  return browser.execute(() => {
    const content = document.querySelector('.cm-content')
    if (!content) throw new Error('editorSelection: .cm-content not found')
    const view = Reflect.get(Reflect.get(content, 'cmTile'), 'root').view as EditorView
    const { anchor, head } = view.state.selection.main
    return { anchor, head }
  })
}

/** The clipboard text that a copy of the active editor's selection gives.
 *  WebDriver cannot read the system clipboard, so the page sends the editor
 *  a `copy` event with a `DataTransfer` of its own, which the editor's copy
 *  handler fills. */
export async function copySelection (browser: E2EBrowser): Promise<string> {
  return browser.execute(() => {
    const content = document.querySelector('.cm-content')
    if (!content) throw new Error('copySelection: .cm-content not found')
    const data = new DataTransfer()
    content.dispatchEvent(new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true }))
    return data.getData('text/plain')
  })
}

/** Pastes `text` at the active editor's selection as clipboard text, with
 *  a `paste` event that the page builds: WebDriver cannot write the system
 *  clipboard. */
export async function pasteText (browser: E2EBrowser, text: string): Promise<void> {
  await browser.execute((pasted: string) => {
    const content = document.querySelector('.cm-content')
    if (!content) throw new Error('pasteText: .cm-content not found')
    const data = new DataTransfer()
    data.setData('text/plain', pasted)
    content.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  }, text)
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

/** Scrolls the element `part` of the asset `asset` (such as `.dez-image`
 *  or `.media-player`) at `index` (doc order) of the active editor into
 *  view, and gives its center. The center is read two frames after the
 *  scroll: CodeMirror then draws the lines that came into view and
 *  measures them, and that can move the element. */
export async function assetPartPoint (browser: E2EBrowser, asset: string, index: number, part: string): Promise<Point> {
  await browser.execute((wantedAsset: string, at: number, wantedPart: string) => {
    const element = document.querySelectorAll(`.cm-content ${wantedAsset}`)[at]?.querySelector(wantedPart)
    if (!element) throw new Error(`assetPartPoint: no ${wantedPart} in ${wantedAsset} ${at}`)
    element.scrollIntoView({ block: 'center' })
  }, asset, index, part)
  return browser.execute((wantedAsset: string, at: number, wantedPart: string) => new Promise<Point>((resolve, reject) => {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const box = document.querySelectorAll(`.cm-content ${wantedAsset}`)[at]?.querySelector(wantedPart)?.getBoundingClientRect()
      if (!box) reject(new Error(`assetPartPoint: ${wantedPart} in ${wantedAsset} ${at} went away`))
      else resolve({ x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2 })
    }))
  }), asset, index, part)
}

/** The model label of each image and player of the active editor that has
 *  one, in doc order: the name that it shows, and its accessible name. */
export async function assetModelLabels (browser: E2EBrowser): Promise<Array<{ name: string, label: string }>> {
  return browser.execute(() => Array.from(
    document.querySelectorAll('.cm-content .dez-image__model, .cm-content .media-player__model'),
    (item) => ({
      name: item.querySelector('.dez-image__model-name, .media-player__model-name')?.textContent ?? '',
      label: item.getAttribute('aria-label') ?? '',
    }),
  ))
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
 *  line. Read two frames after the last change: CodeMirror measures the
 *  DOM into its height map in the next frame, and until then the map is
 *  old. With software GL (Xvfb on CI), WebKit can take about a second to
 *  draw the first frame of a new page of images and chips. */
export async function misplacedLines (browser: E2EBrowser): Promise<string[]> {
  return browser.execute(() => new Promise<string[]>((resolve, reject) => {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const content = document.querySelector<HTMLElement>('.cm-content')
      if (!content) {
        reject(new Error('misplacedLines: .cm-content not found'))
        return
      }
      const view = Reflect.get(Reflect.get(content, 'cmTile'), 'root').view as EditorView
      const misplaced: string[] = []
      for (const line of content.querySelectorAll<HTMLElement>(':scope > .cm-line')) {
        const rect = line.getBoundingClientRect()
        const lineBlock = view.lineBlockAt(view.posAtDOM(line))
        // A line with a block widget next to it (the compaction chip) is one
        // line block made of parts. Its text part is the part with no widget.
        const block = Array.isArray(lineBlock.type) ? lineBlock.type.find((part) => part.widget === null) ?? lineBlock : lineBlock
        const top = view.documentTop + block.top
        if (Math.abs(top - rect.top) > 1 || Math.abs(block.height - rect.height) > 1) {
          const number = view.state.doc.lineAt(block.from).number
          misplaced.push(`line ${number}: map ${Math.round(top)}+${Math.round(block.height)}, DOM ${Math.round(rect.top)}+${Math.round(rect.height)}`)
        }
      }
      resolve(misplaced)
    }))
  }))
}

/** A mousedown on `part` of the role pill before section `index`, as a
 *  click gives; with `shiftKey`, as a Shift+click gives. */
export async function pressRolePill (browser: E2EBrowser, index: number, part = '.dez-role-separator__label', { shiftKey = false } = {}): Promise<void> {
  await browser.execute((sectionIndex: number, selector: string, shift: boolean) => {
    const target = document.querySelector(`.cm-content .dez-role-separator[data-section-index="${sectionIndex}"] ${selector}`)
    if (!target) throw new Error(`pressRolePill: no ${selector} for section ${sectionIndex}`)
    target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, shiftKey: shift }))
  }, index, part, shiftKey)
}

/** What the thinking parts of one role pill show. */
export interface PillThinkingView {
  role: string
  /** The left slot of the pill. */
  slot: 'spinner' | 'disclosure' | null
  /** `aria-expanded` of the disclosure triangle. */
  expanded: string | null
  /** `data-thinking-open` is set on the separator. */
  open: boolean
  /** The text of the panel's text field, or null without a panel. */
  panelText: string | null
}

/** The thinking parts of the role pill before section `index`, or null
 *  when the editor draws no such pill. */
export async function pillThinking (browser: E2EBrowser, index: number): Promise<PillThinkingView | null> {
  return browser.execute((sectionIndex: number) => {
    const separator = document.querySelector<HTMLElement>(`.cm-content .dez-role-separator[data-section-index="${sectionIndex}"]`)
    if (!separator) return null
    const label = separator.querySelector('.dez-role-separator__label')
    const disclosure = label?.querySelector('.dez-role-separator__disclosure')
    const spinner = label?.querySelector('.dez-role-separator__spinner')
    const field = separator.querySelector<HTMLTextAreaElement>('.dez-role-separator__thinking textarea.dez-role-separator__thinking-text')
    return {
      role: separator.dataset.role ?? '',
      slot: disclosure ? 'disclosure' as const : spinner ? 'spinner' as const : null,
      expanded: disclosure?.getAttribute('aria-expanded') ?? null,
      open: separator.dataset.thinkingOpen === '1',
      panelText: field?.value ?? null,
    }
  }, index)
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

/** Whether the busy dots under the editor show. */
export async function busyDotsShown (browser: E2EBrowser): Promise<boolean> {
  return browser.execute(() => document.querySelector('.busy-indicator') !== null)
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

/** Closes every open toast, and waits until no card is left (a card that
 *  closes stays in the DOM for its leave animation). A spec calls it so
 *  that a test sees only the toasts that it causes, and so that a toast of
 *  an earlier test does not catch a pointer click near the bottom right. */
export async function closeToasts (browser: E2EBrowser): Promise<void> {
  await browser.execute(() => {
    document.querySelectorAll<HTMLElement>('.toast-card:not(.toast-card--closing) .toast-close').forEach((button) => button.click())
  })
  await waitForValue(browser, 'toasts closed', () => browser.execute(() => document.querySelectorAll('.toast-card').length), 0)
}

// The end of a stream rebuilds the editor, and when the view followed the
// stream, it scrolls to the bottom one frame later
// (`scrollViewToBottomAfterLayout`, `ThreadEditor.vue`). The rebuild asks
// for that frame in the task that ends the stream, so it comes before the
// frames that a later script asks for. With slow frames (software GL), a
// scroll of a spec that does not wait for it is undone.
async function streamEndScrollDone (browser: E2EBrowser): Promise<void> {
  await browser.execute(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  }))
}

/** Waits until the active tab holds `expected`, no stream runs, and the
 *  scroll of the stream end is done, then checks that no error toast is
 *  open. */
export async function waitForThread (browser: E2EBrowser, expected: ThreadSection[]): Promise<void> {
  await waitForValue(browser, 'thread sections', () => threadSections(browser), expected)
  await waitForValue(browser, 'streaming', () => activeTabStreaming(browser), false)
  await streamEndScrollDone(browser)
  expect(await openToasts(browser, 'error')).toEqual([])
}

/** Waits for the end of the reply at the section `replyIndex` of the
 *  active tab (the empty user section after it is there, no stream runs,
 *  and the scroll of the stream end is done), and gives its text. */
export async function endedReply (browser: E2EBrowser, replyIndex = 1): Promise<string> {
  await waitForValue(browser, 'sections after the reply', async () => (await threadSections(browser)).length, replyIndex + 2)
  await waitForValue(browser, 'streaming', () => activeTabStreaming(browser), false)
  await streamEndScrollDone(browser)
  return (await threadSections(browser))[replyIndex].text
}

/** Seeds the conversation `id` with `sections` in the test HOME `home`,
 *  opens it in a new tab, and waits for it as `waitForThread` does. A
 *  section with a `model` is a reply of that model. */
export async function openSeededConversation (browser: E2EBrowser, home: string, id: string, sections: Array<{ role: 'user' | 'agent', text: string, model?: ModelRef }>): Promise<void> {
  await seedConversation(home, makeConversation({
    id,
    title: id,
    sections: sections.map(({ role, text, model }) => ({ role, nodes: [{ kind: 'text', text }], ...(model && { model }) })),
  }))
  await sbpCall(browser, 'dez.model/tabs/openConversation', id)
  await waitForThread(browser, sections.map(({ role, text }) => ({ role, text })))
}
