// A placeholder: `{{name}}`, with optional spaces inside the braces.
const PLACEHOLDER = /\{\{ *([a-z][a-z0-9_]*) *\}\}/

function templateError(message: string): Error {
  const error = new Error(`System prompt template: ${message}`)
  console.error(error)
  return error
}

/** Fills each `{{name}}` placeholder of `template` with `values[name]`, in
 *  one pass: a value goes in as it is (no HTML escape) and is never read as
 *  template text, so a model id that holds `{{` cannot change the prompt.
 *
 *  There are no conditions and no loops; the caller builds lists as text.
 *  Throws on a placeholder with no value, and on a `{{` or `}}` that is not
 *  part of a placeholder (a typo in the template). Values that the template
 *  does not use are ignored. */
export function renderTemplate(template: string, values: Readonly<Record<string, string>>): string {
  // With a capture group, `split` gives literal text at the even indexes and
  // placeholder names at the odd ones.
  return template.split(PLACEHOLDER).map((part, index) => {
    if (index % 2 === 0) {
      if (part.includes('{{') || part.includes('}}')) {
        throw templateError(`"{{" or "}}" outside a {{name}} placeholder in ${JSON.stringify(part)}`)
      }
      return part
    }
    if (!Object.hasOwn(values, part)) throw templateError(`no value for {{${part}}}`)
    return values[part]
  }).join('')
}
