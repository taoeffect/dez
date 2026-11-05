import { expect } from 'vitest'
import { Key } from 'webdriverio'
import { click, typeKeys, waitFor, waitForValue } from './dom'
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

/** Types `text` at the end of the active tab, then submits it with
 *  Ctrl+Enter. A new reply lands after the trailing user section. */
export async function submit (browser: E2EBrowser, text: string): Promise<void> {
  await browser.execute(() => {
    const content = document.querySelector('.cm-content') as HTMLElement | null
    if (!content) throw new Error('submit: .cm-content not found')
    content.focus()
  })
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

/** Waits until the active tab holds `expected` and no stream runs, then
 *  checks that the tab has no stream error. */
export async function waitForThread (browser: E2EBrowser, expected: ThreadSection[]): Promise<void> {
  await waitForValue(browser, 'thread sections', () => threadSections(browser), expected)
  await waitForValue(browser, 'streaming', () => activeTabStreaming(browser), false)
  expect(await sbpCall(browser, 'dez.model/streams/activeTabError')).toBeNull()
}
