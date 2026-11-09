/** The escape and unescape of one tag name in free text. */
export interface TagEscape {
  escape: (text: string) => string
  unescape: (text: string) => string
}

// Free text inside a `dez:` marker (thinking text, a tool result) or next
// to one (model answer text) must not hold a tag that starts or ends a
// marker. Each `<`, `\`…, optional `/`, `tag` run gets one more `\` after
// the `<` on escape and loses one on unescape. Text that already holds the
// escaped form gets one more `\` too, so unescape always gives the exact
// text back. `tag` goes into a regex and a replacement string as it is, so
// it must hold no regex special char and no `$`.
export function tagEscape(tag: string): TagEscape {
  const run = new RegExp(String.raw`<(\\*)(\/?)${tag}`, 'g')
  const escapedRun = new RegExp(String.raw`<\\(\\*)(\/?)${tag}`, 'g')
  return {
    escape: (text) => text.replace(run, `<\\$1$2${tag}`),
    unescape: (text) => text.replace(escapedRun, `<$1$2${tag}`),
  }
}
