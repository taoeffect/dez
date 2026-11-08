import { StateEffect, StateField } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { readableThinking, type ReadableThinking } from '../../model/chat/thinking'
import type { Role, SectionThinking } from '../../model/chat/types'
import { measureLineHeights } from './editorMeasure'

/** What the thinking parts of an agent role pill show: the left slot (a
 *  spinner or a disclosure triangle) and the thinking panel. */
export interface PillThinkingView {
  /** The thinking text; '' when the section has none. */
  text: string
  /** The thinking can go back to the provider. A replay without text
   *  (redacted or encrypted thinking) still counts as thinking. */
  hasReplay: boolean
  /** The thinking panel is open. Never true for a pill without thinking. */
  expanded: boolean
  /** The section is the one the active tab's stream writes into. */
  streaming: boolean
}

/** The pill shows a disclosure triangle (not a spinner). A replay without
 *  text (redacted or encrypted thinking) counts as thinking too: the pill
 *  gets a triangle, and the panel a placeholder. */
export function hasThinking(thinking: PillThinkingView): boolean {
  return thinking.text !== '' || thinking.hasReplay
}

/** The thinking parts of a pill must change when this is false: it
 *  compares every field that `renderPillThinking` draws. */
export function sameThinkingView(a: PillThinkingView | null, b: PillThinkingView | null): boolean {
  if (!a || !b) return !a && !b
  return (
    a.text === b.text &&
    a.hasReplay === b.hasReplay &&
    a.expanded === b.expanded &&
    a.streaming === b.streaming
  )
}

/** Opens or closes the thinking panel of the section with this id. */
export const toggleThinkingExpandedEffect = StateEffect.define<string>()

/** Ids of the sections whose thinking panel is open. This is view state and
 *  is never saved: ThreadEditor starts each tab with all panels closed, and
 *  copies the set when it rebuilds the state of the same tab. */
export const thinkingExpandedField = StateField.define<ReadonlySet<string>>({
  create: () => new Set<string>(),
  update(value, tr) {
    let next = value
    for (const e of tr.effects) {
      if (!e.is(toggleThinkingExpandedEffect)) continue
      const copy = new Set(next)
      if (copy.has(e.value)) copy.delete(e.value)
      else copy.add(e.value)
      next = copy
    }
    return next
  },
})

/** The thinking parts of a section's pill; null means the pill shows none.
 *  Only agent sections get them (thinking is agent-only). A section that
 *  streams gets them too, so its pill shows a spinner until thinking
 *  arrives, for every model. */
export function sectionThinkingView(
  section: { id: string; role: Role; thinking?: SectionThinking } | undefined,
  expanded: ReadonlySet<string>,
  streamingSectionId: string | null,
): PillThinkingView | null {
  if (section?.role !== 'agent') return null
  const view: PillThinkingView = {
    text: section.thinking?.text ?? '',
    hasReplay: section.thinking?.replay !== undefined,
    expanded: false,
    streaming: section.id === streamingSectionId,
  }
  if (!hasThinking(view)) return view.streaming ? view : null
  view.expanded = expanded.has(section.id)
  return view
}

const PANEL_CLASS = 'dez-role-separator__thinking'
const MIRROR_CLASS = 'dez-role-separator__thinking-mirror'
const TEXT_CLASS = 'dez-role-separator__thinking-text'
const ENCRYPTED_CLASS = 'dez-role-separator__thinking-encrypted'
const DISCLOSURE_CLASS = 'dez-role-separator__disclosure'
const SPINNER_CLASS = 'dez-role-separator__spinner'
/** A streaming panel this close to its bottom counts as at the bottom. */
const PANEL_BOTTOM_SLACK_PX = 8

/** Panels that the user scrolled up from the bottom. A streaming panel
 *  scrolls to its new text only when it is not in here. */
const panelsScrolledUp = new WeakSet<HTMLElement>()
/** The scroll position that the last scroll to new text gave each panel. */
const panelFollowScrollTop = new WeakMap<HTMLElement, number>()

/** The event happened inside a thinking panel. */
export function isThinkingPanelEvent(event: Event): boolean {
  const target = event.target as Node | null
  const element = target instanceof Element ? target : target?.parentElement
  return !!element?.closest(`.${PANEL_CLASS}`)
}

function directChild(parent: HTMLElement, className: string): HTMLElement | null {
  for (const child of parent.children) {
    if (child instanceof HTMLElement && child.classList.contains(className)) return child
  }
  return null
}

function renderSlot(label: HTMLElement, thinking: PillThinkingView | null): void {
  const className = !thinking ? null : hasThinking(thinking) ? DISCLOSURE_CLASS : SPINNER_CLASS
  let slot = directChild(label, DISCLOSURE_CLASS) ?? directChild(label, SPINNER_CLASS)
  // The spinner element stays while it is still wanted, so its animation
  // does not restart on each update.
  if (slot && slot.className !== className) {
    slot.remove()
    slot = null
  }
  if (!className) return
  if (!slot) {
    slot = document.createElement('span')
    slot.className = className
    if (className === DISCLOSURE_CLASS) {
      slot.textContent = '▶'
      // Screen readers get "Thinking, button" plus the open state from
      // `aria-expanded`, which a role-less span does not expose. The pill
      // `label` must keep no role that hides its children (such as `img`).
      slot.setAttribute('role', 'button')
      slot.setAttribute('aria-label', 'Thinking')
    } else {
      slot.setAttribute('aria-hidden', 'true')
    }
    label.prepend(slot)
  }
  if (className === DISCLOSURE_CLASS) {
    const expanded = thinking?.expanded === true
    slot.setAttribute('aria-expanded', String(expanded))
    slot.title = expanded ? 'Hide thinking' : 'Show thinking'
  }
}

function createPanel(): HTMLElement {
  const panel = document.createElement('span')
  panel.className = PANEL_CLASS
  const mirror = document.createElement('span')
  mirror.className = MIRROR_CLASS
  mirror.setAttribute('aria-hidden', 'true')
  mirror.appendChild(document.createTextNode(''))
  const field = document.createElement('textarea')
  field.className = TEXT_CLASS
  field.readOnly = true
  field.rows = 1
  field.spellcheck = false
  field.placeholder = 'The provider sent no readable thinking.'
  field.setAttribute('aria-label', 'Thinking')
  panel.append(mirror, field)
  panel.addEventListener('scroll', () => {
    if (panel.scrollHeight - panel.scrollTop - panel.clientHeight <= PANEL_BOTTOM_SLACK_PX) panelsScrolledUp.delete(panel)
    // A scroll event can come after more text arrived, so a panel that is
    // not at its bottom was not always scrolled by the user. New text and
    // the scroll to it never move the panel up; only the user does.
    else if (panel.scrollTop < (panelFollowScrollTop.get(panel) ?? 0)) panelsScrolledUp.add(panel)
  }, { passive: true })
  return panel
}

/** Shows `text` in the panel; returns whether it changed. The mirror holds
 *  the same text, and its text node is the record of what is shown, also
 *  where the CSS gives the mirror no layout (`field-sizing`). Both are found
 *  by class, as the encrypted pill can come after them. */
function setPanelText(panel: HTMLElement, text: string): boolean {
  const mirror = directChild(panel, MIRROR_CLASS)?.firstChild
  const field = directChild(panel, TEXT_CLASS)
  if (!(mirror instanceof Text) || !(field instanceof HTMLTextAreaElement)) return false
  const shown = mirror.data
  if (shown === text) return false
  if (text.startsWith(shown)) {
    const added = text.slice(shown.length)
    // Appends keep the user's selection in the field; assigning `value`
    // would drop it while thinking streams in.
    field.setRangeText(added, field.textLength, field.textLength, 'preserve')
    mirror.appendData(added)
  } else {
    field.value = text
    mirror.data = text
    // Shorter text can move the panel up; that is not a scroll by the user.
    panelFollowScrollTop.delete(panel)
  }
  return true
}

function sizeLabel(chars: number): string {
  if (chars < 1024) return `${chars} B`
  const kilobytes = Math.round(chars / 1024)
  if (kilobytes < 1024) return `${kilobytes} KB`
  return `${(chars / (1024 * 1024)).toFixed(1)} MB`
}

/** Shows the encrypted pill after the panel text while `readable` leaves
 *  out encrypted lines, so that they never go without a trace; returns
 *  whether it changed. It is not part of the text field, so a copy from
 *  the panel never holds it. A text field cannot hold an element in its
 *  text, so the pill is at the end also when the lines were in the middle. */
function renderEncryptedPill(panel: HTMLElement, readable: ReadableThinking): boolean {
  let pill = directChild(panel, ENCRYPTED_CLASS)
  if (readable.encryptedBlocks === 0) {
    pill?.remove()
    return pill !== null
  }
  const blocks = readable.encryptedBlocks > 1 ? ` · ${readable.encryptedBlocks} blocks` : ''
  const label = `Encrypted reasoning hidden · ${sizeLabel(readable.encryptedChars)}${blocks}`
  if (pill?.textContent === label) return false
  if (!pill) {
    pill = document.createElement('span')
    pill.className = ENCRYPTED_CLASS
    pill.title = 'The provider sent this reasoning encrypted. Dez keeps it with the reply but does not show it.'
    panel.appendChild(pill)
  }
  pill.textContent = label
  return true
}

/** Draws the thinking parts of a role pill to match `thinking`: the slot at
 *  the left of the pill `label`, and the panel after the label in
 *  `separator`. It changes only the parts that differ, so a thinking token
 *  keeps the pill, its animations and the text field's selection.
 *
 *  The panel shows the readable text (`readableThinking`) and, in place of
 *  encrypted lines, the encrypted pill; the stored text does not change, as
 *  replays send it back to the provider. Only an open panel computes them.
 *
 *  The read-only textarea is as tall as its text, and the panel has a max
 *  height and scrolls. Where the engine has `field-sizing` (the panel CSS in
 *  `cmEditor.ts`), the textarea sizes itself in a block panel, and the
 *  hidden mirror of the text gets no layout. Elsewhere the panel is a CSS
 *  grid with the mirror and the textarea in one cell: the mirror's height
 *  sets the cell's height, so the textarea fits its text without script
 *  measuring. The encrypted pill comes after the text. While the section
 *  streams, the panel stays at the bottom unless the user scrolled up. A
 *  change of the panel's height makes CodeMirror measure the line heights
 *  again, so the caret and clicks below the pill stay on the right line. */
export function renderPillThinking(separator: HTMLElement, label: HTMLElement, thinking: PillThinkingView | null, view: EditorView): void {
  renderSlot(label, thinking)
  const existing = directChild(separator, PANEL_CLASS)
  if (!thinking?.expanded) {
    if (existing) {
      existing.remove()
      separator.removeAttribute('data-thinking-open')
      measureLineHeights(view)
    }
    return
  }
  const panel = existing ?? createPanel()
  if (!existing) {
    separator.appendChild(panel)
    separator.setAttribute('data-thinking-open', '1')
  }
  const readable = readableThinking(thinking.text, thinking.streaming)
  const textChanged = setPanelText(panel, readable.text)
  const pillChanged = renderEncryptedPill(panel, readable)
  if (existing && !textChanged && !pillChanged) return
  measureLineHeights(view)
  if (thinking.streaming && !panelsScrolledUp.has(panel)) {
    view.requestMeasure({
      key: panel,
      read: () => panel.scrollHeight - panel.clientHeight,
      write: (bottom) => {
        panelFollowScrollTop.set(panel, bottom)
        panel.scrollTop = bottom
      },
    })
  }
}
