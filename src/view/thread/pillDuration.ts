/** The reply time in its short form, for the pill: "<0.1s", "4.2s", "42s",
 *  "1m 05s", "1h 02m". Under 10 s it shows tenths; from 1 minute on, the
 *  smaller unit always has two digits. Each form rounds the time once, so
 *  9.96 s shows as "10s", not "10.0s", 59.6 s as "1m 00s", and 1 h 0 min
 *  59 s as "1h 01m". */
export function shortDuration(durationMs: number): string {
  const tenths = Math.round(durationMs / 100)
  if (tenths < 1) return '<0.1s'
  if (tenths < 100) return `${(tenths / 10).toFixed(1)}s`
  const seconds = Math.round(durationMs / 1000)
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`
  const minutes = Math.round(durationMs / 60_000)
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}

/** The reply time in words, for the tooltip and screen readers: "4.2
 *  seconds", "1 minute 5 seconds", "1 hour 2 minutes 5 seconds". It rounds
 *  as `shortDuration` does, but keeps the seconds of a time over an hour. */
export function longDuration(durationMs: number): string {
  const tenths = Math.round(durationMs / 100)
  if (tenths < 1) return 'less than 0.1 seconds'
  if (tenths < 100) return `${(tenths / 10).toFixed(1)} seconds`
  const total = Math.round(durationMs / 1000)
  return [
    count(Math.floor(total / 3600), 'hour'),
    count(Math.floor(total / 60) % 60, 'minute'),
    count(total % 60, 'second'),
  ].filter(Boolean).join(' ')
}

function count(value: number, unit: string): string | null {
  if (value === 0) return null
  return `${value} ${unit}${value === 1 ? '' : 's'}`
}

/** Shows the reply time at the end of an agent role pill: after the model
 *  part (`addModelToPill`), or after the role word when the pill has no
 *  model. Styles are in `dezTheme` (`cmEditor.ts`). The time is widget DOM,
 *  not doc text, so find and copy never see it. */
export function addDurationToPill(pill: HTMLElement, durationMs: number): void {
  const time = document.createElement('span')
  time.className = 'dez-role-separator__duration'
  time.textContent = shortDuration(durationMs)
  const description = `Reply took ${longDuration(durationMs)}`
  time.title = description
  // Screen readers read "1m 05s" letter by letter. A plain span cannot
  // carry an aria-label, so the time is a labeled graphic, as the model
  // part is (`addModelToPill`).
  time.setAttribute('role', 'img')
  time.setAttribute('aria-label', description)
  pill.appendChild(time)
}
