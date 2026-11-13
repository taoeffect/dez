import { pointerClickAt } from './dom'
import type { E2EBrowser } from './session'
import { assetPartPoint } from './thread'

// What the tool call chips of the active editor show
// (src/view/editor/toolCalls.ts), read from the page.

/** What one tool call chip in the editor shows. */
export interface ToolChipView {
  /** `data-state` of the chip root. */
  state: string | null
  label: string | null
  /** The words before the name of a tool that Dez does not have. */
  unrecognized: string | null
  name: string
  summary: string | null
  /** "failed" or "interrupted"; null for a call that succeeded or runs. */
  stateWord: string | null
  spinner: boolean
  expanded: string | null
  title: string
  open: boolean
}

/** The chips of the active editor, in doc order. */
export async function toolChips (browser: E2EBrowser): Promise<ToolChipView[]> {
  return browser.execute(() => Array.from(document.querySelectorAll<HTMLElement>('.cm-content .dez-tool-call'), (root) => {
    const chip = root.querySelector<HTMLElement>('.dez-tool-call__chip')
    return {
      state: root.dataset.state ?? null,
      label: chip?.getAttribute('aria-label') ?? null,
      unrecognized: chip?.querySelector('.dez-tool-call__unrecognized')?.textContent ?? null,
      name: chip?.querySelector('.dez-tool-call__name')?.textContent ?? '',
      summary: chip?.querySelector('.dez-tool-call__summary')?.textContent ?? null,
      stateWord: chip?.querySelector('.dez-tool-call__state')?.textContent ?? null,
      spinner: chip?.querySelector('.dez-tool-call__spinner') != null,
      expanded: chip?.getAttribute('aria-expanded') ?? null,
      title: chip?.title ?? '',
      open: root.hasAttribute('data-open'),
    }
  }))
}

/** What the panel of an open chip shows of the call. */
export interface ToolPanelView {
  parameters: Array<[string, string]>
  result: string | null
  error: boolean
}

/** The panel of the chip `index` (doc order); null while it is closed. The
 *  result field is found by its name: the panel of an intermediate call
 *  can hold a second field, before it (`hiddenPart`). */
export async function toolPanel (browser: E2EBrowser, index: number): Promise<ToolPanelView | null> {
  return browser.execute((chipIndex: number) => {
    const panel = document.querySelectorAll('.cm-content .dez-tool-call')[chipIndex]?.querySelector('.dez-tool-call__panel')
    if (!panel) return null
    const names = Array.from(panel.querySelectorAll('.dez-tool-call__parameter-name'), (name) => name.textContent ?? '')
    const values = Array.from(panel.querySelectorAll('.dez-tool-call__parameter-value'), (value) => value.textContent ?? '')
    const result = panel.querySelector<HTMLTextAreaElement>('textarea[aria-label="Result"]')
    return {
      parameters: names.map((name, at): [string, string] => [name, values[at] ?? '']),
      result: result?.value ?? null,
      error: result?.closest('.dez-tool-call__result')?.hasAttribute('data-error') ?? false,
    }
  }, index)
}

/** Presses the chip `index` (doc order), which opens or closes its panel. */
export async function pressToolChip (browser: E2EBrowser, index: number): Promise<void> {
  await pointerClickAt(browser, await assetPartPoint(browser, '.dez-tool-call', index, '.dez-tool-call__chip'))
}

/** The part of a chip that tells that its call is intermediate. */
export interface IntermediatePartView {
  /** The eye that the part draws. */
  eye: 'open' | 'closed'
  /** Whether the eye has another color than the rest of the chip. */
  lit: boolean
  /** The type of each type symbol, in order. */
  types: string[]
  text: string
}

/** The intermediate part of each chip of the active editor, in doc order;
 *  null for a chip with no such part. */
export async function intermediateParts (browser: E2EBrowser): Promise<Array<IntermediatePartView | null>> {
  return browser.execute(() => Array.from(document.querySelectorAll<HTMLElement>('.cm-content .dez-tool-call__chip'), (chip) => {
    const part = chip.querySelector('.dez-tool-call__intermediate')
    const eye = part?.querySelector('.dez-tool-call__eye')
    if (!part || !eye) return null
    return {
      // Only the open eye has a pupil.
      eye: eye.querySelector('circle') ? 'open' as const : 'closed' as const,
      lit: getComputedStyle(eye).color !== getComputedStyle(chip).color,
      types: Array.from(part.querySelectorAll('.dez-tool-call__type'), (type) => type.getAttribute('data-type') ?? ''),
      text: part.querySelector('.dez-tool-call__intermediate-label')?.textContent ?? '',
    }
  }))
}

/** What the open panel of an intermediate call shows of the things that
 *  its chip hides. */
export interface HiddenPartView {
  heading: string
  /** How many images and players the part draws. `shownImages` and
   *  `shownPlayers` read them, with those at their own place. */
  assets: number
  /** The text of a job that made only text; null for a part with assets. */
  text: string | null
}

/** The hidden part of the panel of the chip `index` (doc order); null when
 *  the panel is closed or has no such part. */
export async function hiddenPart (browser: E2EBrowser, index: number): Promise<HiddenPartView | null> {
  return browser.execute((chipIndex: number) => {
    const part = document.querySelectorAll('.cm-content .dez-tool-call')[chipIndex]?.querySelector('.dez-tool-call__panel > .dez-tool-call__hidden')
    if (!part) return null
    return {
      heading: part.querySelector('.dez-tool-call__heading')?.textContent ?? '',
      assets: part.querySelectorAll('.dez-tool-call__assets > *').length,
      text: part.querySelector<HTMLTextAreaElement>('textarea[aria-label="Intermediate text"]')?.value ?? null,
    }
  }, index)
}

/** The text that the editor draws at the place of each hidden asset, in
 *  doc order, and whether the user can see it: its line has a height only
 *  while a caret is on it. */
export async function hiddenAssetNotes (browser: E2EBrowser): Promise<Array<{ text: string, visible: boolean }>> {
  return browser.execute(() => Array.from(document.querySelectorAll<HTMLElement>('.cm-content .dez-hidden-asset'), (note) => {
    const line = note.closest('.cm-line')
    return { text: note.textContent ?? '', visible: (line?.getBoundingClientRect().height ?? 0) > 0 && note.getBoundingClientRect().width > 0 }
  }))
}
