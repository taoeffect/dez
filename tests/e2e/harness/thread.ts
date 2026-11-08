import fs from 'node:fs'
import type { EditorView } from '@codemirror/view'
import { expect } from 'vitest'
import { Key } from 'webdriverio'
import { click, typeKeys, waitFor, waitForValue } from './dom'
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

/** The open picker's groups: provider name and model names, in order. */
export async function pickerGroups (browser: E2EBrowser): Promise<Array<{ provider: string, models: string[] }>> {
  return browser.execute(() =>
    Array.from(document.querySelectorAll('.model-dropdown .model-group')).map((group) => ({
      provider: group.querySelector('.model-group-header')?.textContent?.trim() ?? '',
      models: Array.from(group.querySelectorAll('.model-item-name')).map((name) => name.textContent?.trim() ?? ''),
    }))
  )
}

export async function openPicker (browser: E2EBrowser): Promise<void> {
  await click(browser, '.model-selector-btn')
  await waitFor(browser, '.model-dropdown', 10_000)
}

/** Picks the model named `modelName` in the picker group of `providerName`. */
export async function pickModel (browser: E2EBrowser, providerName: string, modelName: string): Promise<void> {
  await openPicker(browser)
  await waitForValue(browser, `${providerName} in the picker`, async () =>
    (await pickerGroups(browser)).find((group) => group.provider === providerName)?.models.includes(modelName) ?? false, true)
  await browser.execute((provider: string, model: string) => {
    const group = Array.from(document.querySelectorAll('.model-dropdown .model-group')).find(
      (candidate) => candidate.querySelector('.model-group-header')?.textContent?.trim() === provider
    )
    const item = Array.from(group?.querySelectorAll<HTMLElement>('.model-item') ?? []).find(
      (candidate) => candidate.querySelector('.model-item-name')?.textContent?.trim() === model
    )
    if (!item) throw new Error(`pickModel: ${provider} › ${model} not found`)
    item.click()
  }, providerName, modelName)
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

/** The height of every role pill of the active editor. */
export async function rolePillHeights (browser: E2EBrowser): Promise<number[]> {
  return browser.execute(() =>
    Array.from(document.querySelectorAll('.cm-content .dez-role-separator__label')).map((pill) => pill.getBoundingClientRect().height)
  )
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

/** Title and message of each open (not closing) error toast. */
export async function openErrorToasts (browser: E2EBrowser): Promise<Array<{ title: string, message: string }>> {
  return browser.execute(() => Array.from(
    document.querySelectorAll('.toast-card--error:not(.toast-card--closing)'),
    (card) => ({
      title: card.querySelector('.toast-title')?.textContent ?? '',
      message: card.querySelector('.toast-message')?.textContent ?? '',
    })
  ))
}

/** Waits until the active tab holds `expected` and no stream runs, then
 *  checks that no error toast is open. */
export async function waitForThread (browser: E2EBrowser, expected: ThreadSection[]): Promise<void> {
  await waitForValue(browser, 'thread sections', () => threadSections(browser), expected)
  await waitForValue(browser, 'streaming', () => activeTabStreaming(browser), false)
  expect(await openErrorToasts(browser)).toEqual([])
}
