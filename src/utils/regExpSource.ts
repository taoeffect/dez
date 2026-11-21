/** `text` as the source of a regular expression that matches only it. */
export function regExpSource(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
