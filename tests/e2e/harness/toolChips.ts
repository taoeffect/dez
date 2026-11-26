import { jobStartedText } from '../../../src/model/tools/jobs'
import { pointerClickAt, waitForValue, type Point } from './dom'
import type { E2EBrowser } from './session'
import { assetPartPoint } from './thread'

// What the tool call chips of the active editor show
// (src/view/editor/toolCalls.ts), read from the page, and what a spec
// expects of them; a press on a chip; the read-only text fields of an
// open panel (the compaction chips have them too: a press on a word, the
// selection, a copy, the place of the parameter rows); and the text of a
// call block that a seeded conversation holds.

/** What one tool call chip in the editor shows. */
export interface ToolChipView {
  /** `data-state` of the chip root. */
  state: string | null
  label: string | null
  /** The words before the name of a tool that Dez does not have. */
  unrecognized: string | null
  name: string
  summary: string | null
  /** "failed", "interrupted", or "not run"; null for a call that succeeded
   *  or runs. */
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

/** The time that one tool call chip shows (`renderCallTime`,
 *  src/view/editor/toolCalls.ts), and where its call is while its group
 *  runs. */
export interface ToolChipTimeView {
  /** `data-phase` of the chip: "ended" or "waiting" for a call of a group
   *  that runs, which does not run now; else null. */
  phase: string | null
  /** The first part of the chip: "spinner" or "triangle". */
  lead: string | null
  time: { text: string, live: boolean, title: string } | null
}

/** The time of each chip of the active editor, in doc order. */
export async function toolChipTimes (browser: E2EBrowser): Promise<ToolChipTimeView[]> {
  return browser.execute(() => Array.from(document.querySelectorAll<HTMLElement>('.cm-content .dez-tool-call__chip'), (chip) => {
    const time = chip.querySelector<HTMLElement>(':scope > .dez-tool-call__time')
    const lead = chip.firstElementChild
    return {
      phase: chip.dataset.phase ?? null,
      lead: lead?.matches('.dez-tool-call__spinner') ? 'spinner' : lead?.matches('.dez-tool-call__disclosure') ? 'triangle' : null,
      time: time && { text: time.textContent ?? '', live: time.classList.contains('dez-tool-call__time--live'), title: time.title },
    }
  }))
}

/** What the panel of an open chip shows of the call. */
export interface ToolPanelView {
  /** The parameter rows of the call. The code of a `js_eval` call is not
   *  one of them (`codePanel`). */
  parameters: Array<[string, string]>
  result: string | null
  /** The call is in the error or the interrupted state. Not `error`: a
   *  `browser.execute` result with a set `error` field fails the script. */
  failed: boolean
}

/** The panel of the chip `index` (doc order); null while it is closed. The
 *  result field is found by its name, the value of each parameter row is
 *  the text of its field, and the parameter rows are the ones of the panel
 *  itself: the panel of an intermediate call can hold a second field,
 *  before it (`hiddenPart`), and the panel of a `js_eval` call the rows
 *  and the fields of the tool calls of its code (`codePanel`). */
export async function toolPanel (browser: E2EBrowser, index: number): Promise<ToolPanelView | null> {
  return browser.execute((chipIndex: number) => {
    const panel = document.querySelectorAll('.cm-content .dez-tool-call')[chipIndex]?.querySelector('.dez-tool-call__panel')
    if (!panel) return null
    const names = Array.from(panel.querySelectorAll(':scope > .dez-tool-call__parameters > .dez-tool-call__parameter-name'), (name) => name.textContent ?? '')
    const values = Array.from(panel.querySelectorAll(':scope > .dez-tool-call__parameters > .dez-tool-call__parameter-value'), (value) => value.querySelector('textarea')?.value ?? '')
    const result = panel.querySelector<HTMLTextAreaElement>('textarea[aria-label="Result"]')
    return {
      parameters: names.map((name, at): [string, string] => [name, values[at] ?? '']),
      result: result?.value ?? null,
      failed: result?.closest('.dez-tool-call__result')?.hasAttribute('data-error') ?? false,
    }
  }, index)
}

/** One tool call of the code of a `js_eval` call, as the panel of its chip
 *  shows it. */
export interface CodeToolCallView {
  name: string
  /** `data-status` of the call. */
  status: string | null
  /** "failed" or "not finished"; null for a call that gave a result. */
  stateWord: string | null
  parameters: Array<[string, string]>
  /** The text of the result field, and what the field shows in its place
   *  while that is blank. */
  result: string
  placeholder: string
  /** The result field has the look of an error. */
  failed: boolean
}

/** What the open panel of a `js_eval` chip shows of the code of its call. */
export interface CodePanelView {
  /** The headings of the panel, in order. */
  headings: string[]
  /** The text of the code field; null for a panel with none. */
  code: string | null
  /** The tool calls of the code, in order. */
  calls: CodeToolCallView[]
  /** The line that tells how many tool calls the list does not hold; null
   *  for none. */
  more: string | null
}

/** The code part and the tool calls of the code in the panel of the chip
 *  `index` (doc order); null while the panel is closed. The result field of
 *  a tool call of the code is found by its name, as each of its parameter
 *  values is a field too. */
export async function codePanel (browser: E2EBrowser, index: number): Promise<CodePanelView | null> {
  return browser.execute((chipIndex: number) => {
    const panel = document.querySelectorAll('.cm-content .dez-tool-call')[chipIndex]?.querySelector('.dez-tool-call__panel')
    if (!panel) return null
    return {
      headings: Array.from(panel.querySelectorAll('.dez-tool-call__heading'), (heading) => heading.textContent ?? ''),
      code: panel.querySelector<HTMLTextAreaElement>('textarea[aria-label="Code"]')?.value ?? null,
      calls: Array.from(panel.querySelectorAll<HTMLElement>('.dez-tool-call__bridged-call'), (call) => {
        const names = Array.from(call.querySelectorAll('.dez-tool-call__parameter-name'), (name) => name.textContent ?? '')
        const values = Array.from(call.querySelectorAll('.dez-tool-call__parameter-value'), (value) => value.querySelector('textarea')?.value ?? '')
        const result = call.querySelector<HTMLTextAreaElement>('textarea[aria-label^="Result of tool call"]')
        return {
          name: call.querySelector('.dez-tool-call__bridged-name')?.textContent ?? '',
          status: call.dataset.status ?? null,
          stateWord: call.querySelector('.dez-tool-call__bridged-state')?.textContent ?? null,
          parameters: names.map((name, at): [string, string] => [name, values[at] ?? '']),
          result: result?.value ?? '',
          placeholder: result?.placeholder ?? '',
          failed: result?.closest('.dez-tool-call__result')?.hasAttribute('data-error') ?? false,
        }
      }),
      more: panel.querySelector('.dez-tool-call__bridged-more')?.textContent ?? null,
    }
  }, index)
}

/** A picture that the panel of an `asset_view` chip shows: the label of
 *  the picture as the model got it, and `size`, the pixels of its file
 *  (`48x36`), null while it loads, or "missing" when its copy is gone. */
export interface ToolPanelPicture {
  label: string
  size: string | null
}

/** The pictures of the panel of the chip `index` (doc order); null while
 *  the panel is closed. */
export async function toolPanelPictures (browser: E2EBrowser, index: number): Promise<ToolPanelPicture[] | null> {
  return browser.execute((chipIndex: number) => {
    const panel = document.querySelectorAll('.cm-content .dez-tool-call')[chipIndex]?.querySelector('.dez-tool-call__panel')
    if (!panel) return null
    return Array.from(panel.querySelectorAll('.dez-tool-call__picture'), (item) => {
      const img = item.querySelector<HTMLImageElement>('img.dez-tool-call__picture-img')
      const loaded = img !== null && img.complete && img.naturalWidth > 0
      return {
        label: item.querySelector('.dez-tool-call__picture-label')?.textContent ?? '',
        size: item.querySelector('.dez-image-missing') ? 'missing' : loaded ? `${img.naturalWidth}x${img.naturalHeight}` : null,
      }
    })
  }, index)
}

/** What a read-only text field of an open panel shows: its text, the part
 *  of it that is selected, and whether it has the focus. */
export interface PanelFieldView {
  text: string
  selected: string
  focused: boolean
}

/** The accessible name of the field of the value of the parameter `name`
 *  in a panel: of the call of the panel, or of the tool call `callNumber`
 *  (from 1) of the code of a `js_eval` call. */
export function parameterFieldName (name: string, callNumber?: number): string {
  return callNumber === undefined ? `Parameter ${name}` : `Parameter ${name} of tool call ${callNumber}`
}

/** The accessible names of the text fields of the open panel of the chip
 *  `index` (doc order), in order; null while the panel is closed. */
export async function panelFieldNames (browser: E2EBrowser, index: number): Promise<string[] | null> {
  return browser.execute((chipIndex: number) => {
    const panel = document.querySelectorAll('.cm-content .dez-tool-call')[chipIndex]?.querySelector('.dez-tool-call__panel')
    if (!panel) return null
    return Array.from(panel.querySelectorAll('textarea'), (field) => field.getAttribute('aria-label') ?? '')
  }, index)
}

/** The text field whose accessible name is `name` in the open panel of the
 *  chip `index` (doc order); null when the panel is closed or has no such
 *  field. */
export async function panelField (browser: E2EBrowser, index: number, name: string): Promise<PanelFieldView | null> {
  return browser.execute((chipIndex: number, fieldName: string) => {
    const root = document.querySelectorAll('.cm-content .dez-tool-call')[chipIndex]
    const field = Array.from(root?.querySelectorAll<HTMLTextAreaElement>('.dez-tool-call__panel textarea') ?? []).find((candidate) => candidate.getAttribute('aria-label') === fieldName)
    if (!field) return null
    return { text: field.value, selected: field.value.slice(field.selectionStart, field.selectionEnd), focused: document.activeElement === field }
  }, index, name)
}

/** The viewport point at the middle of the first `word` of the text field
 *  named `name` (`panelField`), read two frames after the last change, when
 *  CodeMirror has placed the lines. A text field gives no box of a part of
 *  its text, so a hidden copy of the field, with its text and its computed
 *  style at its place, gives the box of the word. The word must be in
 *  view. */
export async function panelFieldWordPoint (browser: E2EBrowser, index: number, name: string, word: string): Promise<Point> {
  return browser.execute((chipIndex: number, fieldName: string, wanted: string) => new Promise<Point>((resolve, reject) => {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const root = document.querySelectorAll('.cm-content .dez-tool-call')[chipIndex]
      const field = Array.from(root?.querySelectorAll<HTMLTextAreaElement>('.dez-tool-call__panel textarea') ?? []).find((candidate) => candidate.getAttribute('aria-label') === fieldName)
      const at = field?.value.indexOf(wanted) ?? -1
      if (!field || at < 0) {
        reject(new Error(`panelFieldWordPoint: no field "${fieldName}" with "${wanted}" in chip ${chipIndex}`))
        return
      }
      const style = getComputedStyle(field)
      const box = field.getBoundingClientRect()
      const copy = document.createElement('div')
      for (let i = 0; i < style.length; i++) copy.style.setProperty(style[i], style.getPropertyValue(style[i]))
      Object.assign(copy.style, { position: 'fixed', left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: 'auto', margin: '0', overflow: 'visible', visibility: 'hidden', pointerEvents: 'none' })
      const text = document.createTextNode(field.value)
      copy.appendChild(text)
      document.body.appendChild(copy)
      const range = document.createRange()
      range.setStart(text, at)
      range.setEnd(text, at + wanted.length)
      const rect = range.getClientRects()[0]
      copy.remove()
      const point = { x: rect.left + rect.width / 2 - field.scrollLeft, y: rect.top + rect.height / 2 - field.scrollTop }
      if (point.x < 0 || point.y < 0 || point.x > window.innerWidth || point.y > window.innerHeight) {
        reject(new Error(`panelFieldWordPoint: "${wanted}" of the field "${fieldName}" is out of view`))
        return
      }
      resolve(point)
    }))
  }), index, name, word)
}

/** Sends the text field named `name` (`panelField`) a `copy` event with a
 *  `DataTransfer` of its own, as a copy key there sends one, and gives
 *  whether a handler canceled it and the text that a handler put in.
 *  WebDriver cannot read the system clipboard, and a script cannot start
 *  the field's own copy: an event that no handler takes is the sign that
 *  the field's own copy runs. */
export async function sendCopyToPanelField (browser: E2EBrowser, index: number, name: string): Promise<{ canceled: boolean, text: string }> {
  return browser.execute((chipIndex: number, fieldName: string) => {
    const root = document.querySelectorAll('.cm-content .dez-tool-call')[chipIndex]
    const field = Array.from(root?.querySelectorAll<HTMLTextAreaElement>('.dez-tool-call__panel textarea') ?? []).find((candidate) => candidate.getAttribute('aria-label') === fieldName)
    if (!field) throw new Error(`sendCopyToPanelField: no field "${fieldName}" in chip ${chipIndex}`)
    const data = new DataTransfer()
    const event = new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true })
    field.dispatchEvent(event)
    return { canceled: event.defaultPrevented, text: data.getData('text/plain') }
  }, index, name)
}

/** Where one parameter row of a panel draws its value: `offset`, how far
 *  the first line of the value is below the top of the name, in px (to
 *  0.1 px), and `lines`, the height of the text of the value in lines of
 *  the name (to 0.1 line). */
export interface ParameterRowPlace {
  name: string
  offset: number
  lines: number
}

/** The place of each parameter row of the open panel of the chip `index`
 *  (doc order), the rows of the panel itself (`toolPanel`), read two
 *  frames after the last change; null while the panel is closed. */
export async function parameterRowPlaces (browser: E2EBrowser, index: number): Promise<ParameterRowPlace[] | null> {
  return browser.execute((chipIndex: number) => new Promise<ParameterRowPlace[] | null>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const panel = document.querySelectorAll('.cm-content .dez-tool-call')[chipIndex]?.querySelector('.dez-tool-call__panel')
      if (!panel) {
        resolve(null)
        return
      }
      const names = panel.querySelectorAll(':scope > .dez-tool-call__parameters > .dez-tool-call__parameter-name')
      const values = panel.querySelectorAll(':scope > .dez-tool-call__parameters > .dez-tool-call__parameter-value')
      resolve(Array.from(names, (name, at) => {
        const text = values[at].querySelector('textarea') ?? values[at]
        const style = getComputedStyle(text)
        const box = text.getBoundingClientRect()
        const top = box.top + parseFloat(style.borderTopWidth) + parseFloat(style.paddingTop)
        const height = box.height - parseFloat(style.borderTopWidth) - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom) - parseFloat(style.borderBottomWidth)
        // The grid stretches a name to the height of its row.
        const line = parseFloat(getComputedStyle(name).lineHeight)
        return {
          name: name.textContent ?? '',
          offset: Math.round((top - name.getBoundingClientRect().top) * 10) / 10,
          lines: Math.round(height / line * 10) / 10,
        }
      }))
    }))
  }), index)
}

/** Presses the chip `index` (doc order), which opens or closes its panel.
 *  A panel that just opened or closed changes the height of its line, and
 *  CodeMirror can move the chips some frames later, when it measures the
 *  lines: the press waits until two reads, one poll interval apart, give
 *  the chip the same place. The first poll of `waitUntil` runs at once, so
 *  it only reads: a comparison of two reads right after each other can
 *  pass before the move. */
export async function pressToolChip (browser: E2EBrowser, index: number): Promise<void> {
  // Not `let point: Point | null = null`: TypeScript would take it for null
  // after the callback, which it does not see assign.
  let point = null as Point | null
  await waitForValue(browser, `settled place of chip ${index}`, async () => {
    const last = point
    point = await assetPartPoint(browser, '.dez-tool-call', index, '.dez-tool-call__chip')
    return last !== null && point.x === last.x && point.y === last.y
  }, true)
  await pointerClickAt(browser, point as Point)
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

/** What the chip of an intermediate call shows of one asset of `type`
 *  that it hides, with its panel closed. */
export function hidingPart (type: string): IntermediatePartView {
  return { eye: 'closed', lit: false, types: [type], text: 'intermediate asset hidden' }
}

/** As `hidingPart`, with its panel open. */
export function revealingPart (type: string): IntermediatePartView {
  return { eye: 'open', lit: true, types: [type], text: 'intermediate asset' }
}

/** The block of a `model_invoke` call `callId` with `is_intermediate`,
 *  whose result tells that it started the job `jobId`. */
export function intermediateInvokeBlock (callId: string, jobId: string): string {
  return `<dez:tool id="${callId}" name="model_invoke" model="studio/paint" prompt="A draft" is_intermediate="true">\n${jobStartedText(jobId, 1)}\n</dez:tool>`
}

/** The text of a `model_list` call that succeeded, as the agent section and
 *  the conversation file hold it. */
export function modelListBlock (id: string, filter: string, result: string): string {
  return `<dez:tool id="${id}" name="model_list" filter="${filter}">\n${result}\n</dez:tool>`
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
   *  `shownPlayers` read them, with those at their own place. A long list
   *  (the kept assets of a compaction) draws only the rows near its
   *  visible part. */
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
      assets: part.querySelectorAll('.dez-tool-call__assets :is(.dez-image, .dez-media)').length,
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
