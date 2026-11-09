// Escaping and grammar for the attributes of `dez:` markers (`name="…"`,
// `model="…"`) in conversation files and clipboard text: the section pills
// (pillMarker.ts) and the tool blocks (toolBlocks.ts). A value ends at the
// next `"` and a marker must stay on one line, so `"`, LF, and CR become
// character references. `&` is escaped too, so a value that holds a literal
// `&quot;` reads back unchanged. Conversation files write prompt names
// without this escaping (conversationFormat.ts).
const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '"': '&quot;',
  '\n': '&#10;',
  '\r': '&#13;',
}

const UNESCAPES: Record<string, string> = {
  '&amp;': '&',
  '&quot;': '"',
  '&#10;': '\n',
  '&#13;': '\r',
}

export function escapeMarkerAttribute(value: string): string {
  return value.replace(/[&"\n\r]/g, (char) => ESCAPES[char])
}

// One pass, so `&amp;quot;` reads back as `&quot;`, not as `"`.
export function unescapeMarkerAttribute(value: string): string {
  return value.replace(/&(?:amp|quot|#10|#13);/g, (reference) => UNESCAPES[reference])
}

// One `name="value"` attribute. Escaped values never hold `"`, so a value
// ends at the next `"`, even when it holds `/>` or `>`.
const ATTRIBUTE_NAME = String.raw`[A-Za-z_][\w.:-]*`
const ATTRIBUTE = new RegExp(String.raw`(${ATTRIBUTE_NAME})\s*=\s*"([^"]*)"`, 'g')

/** Regex source of the attributes of a marker tag, after its name: any
 *  number of `name="value"` attributes, each after whitespace, then
 *  optional whitespace. It has no capture groups, so callers can join it
 *  into a larger pattern. `\s` holds line breaks, so a tag that a pattern
 *  allows to span lines can. */
export const MARKER_ATTRIBUTES = String.raw`(?:\s+${ATTRIBUTE_NAME}\s*=\s*"[^"]*")*\s*`

/** The attributes in the text of a marker tag, by name, with their values
 *  unescaped. When a name comes twice, the first value wins. Pass only the
 *  tag: attributes are read from the whole text. */
export function markerAttributes(text: string): Map<string, string> {
  const attributes = new Map<string, string>()
  // `matchAll` copies the global regex, so no `lastIndex` state is shared.
  for (const [, name, value] of text.matchAll(ATTRIBUTE)) {
    if (!attributes.has(name)) attributes.set(name, unescapeMarkerAttribute(value))
  }
  return attributes
}
