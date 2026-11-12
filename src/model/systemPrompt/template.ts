// A placeholder: `{{name}}`, with optional spaces inside the braces. Global
// for `matchAll` only, which copies the regex and keeps no state in it.
const PLACEHOLDER = /\{\{ *([a-z][a-z0-9_]*) *\}\}/g

/** The text of a template with its values, or the first problem of the
 *  template: a short text for the user that starts with its line number. */
export type RenderedTemplate = { text: string } | { problem: string }

function lineProblem(template: string, offset: number, problem: string): { problem: string } {
  const line = template.slice(0, offset).split('\n').length
  return { problem: `Line ${line}: ${problem}` }
}

// The offset of the first `{{` or `}}` in a literal text that is not part of
// a placeholder, or -1. A `}` just after a placeholder or a `{` just before
// one makes a `{{` or `}}` with the placeholder's own braces (`{{{name}}}`),
// which the literal alone does not hold.
function strayBraceOffset(literal: string, afterPlaceholder: boolean, beforePlaceholder: boolean): number {
  const offsets = [literal.indexOf('{{'), literal.indexOf('}}')]
  if (afterPlaceholder && literal.startsWith('}')) offsets.push(0)
  if (beforePlaceholder && literal.endsWith('{')) offsets.push(literal.length - 1)
  const found = offsets.filter((offset) => offset >= 0)
  return found.length > 0 ? Math.min(...found) : -1
}

/** Fills each `{{name}}` placeholder of `template` with `values[name]`, in
 *  one pass: a value goes in as it is (no HTML escape) and is never read as
 *  template text, so a model id that holds `{{` cannot change the prompt.
 *
 *  There are no conditions and no loops; the caller builds lists as text.
 *  The first problem in text order stops the render: a placeholder with no
 *  value, or a `{{` or `}}` that is not part of a placeholder (a typo in the
 *  template). It logs nothing, as Settings checks the template on each key.
 *  Values that the template does not use are ignored. */
export function renderTemplate(template: string, values: Readonly<Record<string, string>>): RenderedTemplate {
  const matches = [...template.matchAll(PLACEHOLDER)]
  const parts: string[] = []
  let literalStart = 0
  // Literal `i` is the text before match `i`; the last one has no match.
  for (let i = 0; i <= matches.length; i++) {
    const match = matches.at(i)
    const literal = template.slice(literalStart, match?.index ?? template.length)
    const brace = strayBraceOffset(literal, i > 0, match !== undefined)
    if (brace >= 0) {
      return lineProblem(template, literalStart + brace, '"{{" or "}}" is not part of a variable such as {{name}} (lowercase letters, digits, and "_").')
    }
    parts.push(literal)
    if (!match) break
    const [placeholder, name] = match
    if (!Object.hasOwn(values, name)) return lineProblem(template, match.index, `${placeholder} is not a variable.`)
    parts.push(values[name])
    literalStart = match.index + placeholder.length
  }
  return { text: parts.join('') }
}
