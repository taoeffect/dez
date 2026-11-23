import { drawTime, timeWords, type ShownTime } from '../editor/liveTimes'

const TIME_CLASS = 'dez-role-separator__duration'

/** Shows the reply time at the end of an agent role pill `label`: after
 *  the model part (`addModelToPill`), or after the role word when the pill
 *  has no model. A live time counts while the reply runs (`liveTimes.ts`),
 *  a final one is the time the reply took; null takes the time away.
 *  Styles are in `dezTheme` (`cmEditor.ts`). The time is widget DOM, not
 *  doc text, so find and copy never see it. */
export function renderPillTime(label: HTMLElement, time: ShownTime | null): void {
  let part = label.querySelector<HTMLElement>(`:scope > .${TIME_CLASS}`)
  if (!time) {
    part?.remove()
    return
  }
  if (!part) {
    part = document.createElement('span')
    // Screen readers read "1m 05s" letter by letter. A plain span cannot
    // carry an aria-label, so the time is a labeled graphic, as the model
    // part is (`addModelToPill`).
    part.setAttribute('role', 'img')
    label.appendChild(part)
  }
  const description = time.live ? `Reply running for ${timeWords(time)}` : `Reply took ${timeWords(time)}`
  drawTime(part, TIME_CLASS, time, description)
  if (part.getAttribute('aria-label') !== description) part.setAttribute('aria-label', description)
}
