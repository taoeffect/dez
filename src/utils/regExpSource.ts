/** `text` as the source of a regular expression that matches only it. */
export function regExpSource(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Whether `source` is the source of a regular expression that compiles. */
export function isRegExpSource(source: string): boolean {
  try {
    new RegExp(source)
    return true
  } catch {
    return false
  }
}
