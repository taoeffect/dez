/** A time in its short form, for a pill or a chip: "<0.1s", "4.2s", "42s",
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

/** A time that still runs, in the units of `shortDuration`: "1s" … "59s",
 *  "1m 00s", "1h 00m". It counts whole units and rounds down, so it never
 *  runs ahead of the clock and changes at most once a second. */
export function liveDuration(elapsedMs: number): string {
  const seconds = Math.floor(Math.max(0, elapsedMs) / 1000)
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`
  const minutes = Math.floor(seconds / 60)
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}

/** A time in words, for a tooltip, a screen reader, or a model: "4.2
 *  seconds", "1 minute 5 seconds", "1 hour 2 minutes 5 seconds". It rounds
 *  as `shortDuration` does, but keeps the seconds of a time over an hour. */
export function longDuration(durationMs: number): string {
  const tenths = Math.round(durationMs / 100)
  if (tenths < 1) return 'less than 0.1 seconds'
  if (tenths < 100) return `${(tenths / 10).toFixed(1)} seconds`
  return wholeSeconds(Math.round(durationMs / 1000))
}

/** A time that still runs, in words: "12 seconds", "1 minute 5 seconds".
 *  It rounds down, as `liveDuration` does. */
export function longLiveDuration(elapsedMs: number): string {
  const seconds = Math.floor(Math.max(0, elapsedMs) / 1000)
  return seconds === 0 ? '0 seconds' : wholeSeconds(seconds)
}

function wholeSeconds(total: number): string {
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
