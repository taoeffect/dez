// Escaping for values inside `dez:` marker attributes (`name="…"`,
// `model="…"`) in conversation files and clipboard text. A value ends at the
// next `"` and a marker must stay on one line, so `"`, LF, and CR become
// character references. `&` is escaped too, so a value that holds a literal
// `&quot;` reads back unchanged.
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
