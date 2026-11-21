import { APP_NAME_SOURCE, isAppName } from '../tools/appManifest'
import { APPS_VIRTUAL_ROOT } from '../tools/appsTool'

// The apps that a text names: the one rule for "this text uses the app".
// Delete Unreferenced Apps keeps an app that a text names
// (controller/unusedFiles.ts), and a compaction keeps the names of the apps
// of the text that it replaces (controller/compactionApps.ts).
//
// The rule reads raw text, as the rule of the stored files does
// (`removeNamedFiles`, unusedFiles.ts): the text of a conversation file, of
// a content node, or of a section. It knows no section and no role, so it
// cannot use the recognizers of the tags and the tool blocks. It finds more
// than they do: it can keep an app that nothing shows, but it never misses
// an app that Dez shows or that a call of the `apps` tool names.
//
// A text names the app `x` in two forms:
//
// 1. `/apps/x`: a path of the `apps` tool, anywhere. A call has it in
//    `path`, `paths`, and `moves`, a result has it in its text, and the
//    notes of a compaction list the apps by it (compactionNotes.ts).
// 2. `x` as the quoted value of a `name`:
//
//      <dez:app name="x"/>
//      <dez:tool id="c1" name="apps" command="show" parameters="{&quot;name&quot;:&quot;x&quot;}">
//      bridged="{&quot;calls&quot;:[{…&quot;parameters&quot;:&quot;{\&quot;name\&quot;:\&quot;x\&quot;}&quot;…
//      code="await dez.sbp('apps', { command: 'show', parameters: { name: 'x' } })"
//
//    The first is the tag of a shown app (appTags.ts). The others are a
//    call of `show`, `invoke`, or `init` (toolBlocks.ts): its own
//    arguments, the record of a call that the code of a `js_eval` call
//    made (bridgedCalls.ts), and that code itself. An attribute of a
//    marker holds `"` as `&quot;` (utils/markerAttribute.ts), and JSON in
//    JSON has a `\` before each quote, so a quote has all these forms.
//
// What the rule keeps with no need: an app that has the name of a Dez tool
// (`<dez:tool … name="video">`), an app that the `name` filter of a
// `list_apps` call gives, and a path that only looks like one of the tool
// (`https://example.com/apps/x`). A result of `list_apps` or of `ls` gives
// bare names, and one of `find` gives paths after `/apps/`, so it keeps no
// app: a list of every app must not keep every app.
//
// What the rule misses: code of a `js_eval` call that builds the name of an
// app from parts (a variable), when the call has no record of its tool
// calls (a call that was stopped, or a record that is cut).

const PATH_START = `${APPS_VIRTUAL_ROOT}/`

// A quote as a text can hold it: `"`, `'`, a backtick, or the `&quot;` of a
// marker attribute (with `&amp;` for each time that the attribute was
// escaped again), each after the `\` characters of JSON in JSON.
const QUOTE = '\\\\{0,7}(?:["\'`]|&(?:amp;){0,3}quot;)'
// Whitespace, also as a marker attribute holds a line break.
const GAP = '(?:\\s|&#1[03];)*'
// What comes after the word `name` when it names an app: the end quote of
// a quoted key, `:` or `=`, and the quoted name. The end quote of the
// value is a part of the rule, so `name="x.png"` and a name of more than
// 64 characters name no app. Sticky: it is tested only where the word
// ends. Each part is bounded or has one way to match, so a test reads
// each character once.
const NAME_VALUE = new RegExp(`(?:${QUOTE})?${GAP}[:=]${GAP}${QUOTE}(${APP_NAME_SOURCE})${QUOTE}`, 'y')
const NAME_WORD = 'name'

// A character of the name of an app (`[a-z0-9_-]`, `APP_NAME_SOURCE`).
function isNameChar(code: number): boolean {
  return (code >= 0x61 && code <= 0x7a) || (code >= 0x30 && code <= 0x39) || code === 0x2d || code === 0x5f
}

/** The names of the apps that `text` names (the two forms above). A name
 *  here has the form of an app name; an app with that name need not be
 *  there. */
export function namedApps(text: string): Set<string> {
  const names = new Set<string>()
  // The name is the whole run of name characters after `/apps/`, so
  // `/apps/notes2` names `notes2` and not `notes`. The search goes on
  // after the run: it reads each character once.
  for (let at = text.indexOf(PATH_START); at !== -1;) {
    const start = at + PATH_START.length
    let end = start
    while (end < text.length && isNameChar(text.charCodeAt(end))) end++
    const name = text.slice(start, end)
    if (isAppName(name)) names.add(name)
    at = text.indexOf(PATH_START, end)
  }
  for (let at = text.indexOf(NAME_WORD); at !== -1; at = text.indexOf(NAME_WORD, at + NAME_WORD.length)) {
    NAME_VALUE.lastIndex = at + NAME_WORD.length
    const match = NAME_VALUE.exec(text)
    if (match !== null) names.add(match[1])
  }
  return names
}
