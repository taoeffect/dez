import { Key } from 'webdriverio'
import { click, waitFor, waitForValue } from './dom'
import type { E2EBrowser } from './session'

// The provider settings popup of the bottom bar (the gear), as the specs of
// the media models read it: the "Model Parameters" of the active model.

/** One row of the "Model Parameters" section, with what its control
 *  shows. */
export type ParameterRow =
  | { name: string, label: string, options: string[], picked: string }
  | { name: string, label: string, number: string, min: string, max: string, step: string }
  | { name: string, label: string, on: boolean }

export interface PopupView {
  headers: string[]
  rows: ParameterRow[]
  /** The text of the first hint section ("Input", "Lyrics"). */
  hint: string | null
  /** Whether the popup has the "Reset to defaults" button. */
  reset: boolean
}

export async function popupOpen (browser: E2EBrowser): Promise<boolean> {
  return browser.execute(() => document.querySelector('.provider-settings-popup') !== null)
}

export async function openPopup (browser: E2EBrowser): Promise<void> {
  await click(browser, '.model-selector-gear')
  await waitFor(browser, '.provider-settings-popup')
}

export async function closePopup (browser: E2EBrowser): Promise<void> {
  await browser.keys([Key.Escape])
  await waitForValue(browser, 'popup open', () => popupOpen(browser), false)
}

/** What the open popup shows. */
export async function popupView (browser: E2EBrowser): Promise<PopupView> {
  return browser.execute(() => {
    const text = (el: Element | null): string => el?.textContent?.trim() ?? ''
    const rows = Array.from(document.querySelectorAll<HTMLElement>('.provider-settings-popup [data-parameter]'), (row): ParameterRow => {
      const base = { name: row.dataset.parameter ?? '', label: text(row.querySelector('.provider-settings-label')) }
      const select = row.querySelector('select')
      if (select) return { ...base, options: Array.from(select.options, (option) => option.text), picked: select.selectedOptions[0]?.text ?? '' }
      const input = row.querySelector('input')
      if (input) return { ...base, number: input.value, min: input.min, max: input.max, step: input.step }
      return { ...base, on: row.getAttribute('aria-checked') === 'true' }
    })
    const hint = document.querySelector('.provider-settings-hint')
    return {
      headers: Array.from(document.querySelectorAll('.provider-settings-header'), (header) => text(header)),
      rows,
      hint: hint ? text(hint) : null,
      reset: document.querySelector('.provider-settings-reset') !== null,
    }
  })
}

/** Gives the field of the parameter `name` the value `wanted` (for a list,
 *  the option with that text), then the `change` event that a user's edit
 *  ends with. wry's automation session takes no native keys for a field,
 *  so the page sets the value. */
export async function changeParameterField (browser: E2EBrowser, name: string, wanted: string, kind: 'option' | 'number'): Promise<void> {
  await browser.execute((parameter: string, value: string, fieldKind: string) => {
    const field = document.querySelector<HTMLInputElement | HTMLSelectElement>(`.provider-settings-popup [data-parameter="${parameter}"] .provider-settings-value`)
    if (!field) throw new Error(`changeParameterField: no field for ${parameter}`)
    if (fieldKind === 'number') {
      field.value = value
    } else {
      const option = Array.from((field as HTMLSelectElement).options).find((entry) => entry.text === value)
      if (!option) throw new Error(`changeParameterField: ${parameter} has no option ${value}`)
      option.selected = true
    }
    field.dispatchEvent(new Event('change', { bubbles: true }))
  }, name, wanted, kind)
}
