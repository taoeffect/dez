import { mapJsonStrings } from '../../utils/json'
import { oneLineCut } from '../../utils/oneLineCut'
import { findAssetMentions } from '../chat/imageMentions'
import { APP_RUN_MAX_TOOL_CALLS, APPS_INVOKE, APPS_SHOW, APPS_TOOL } from './appsTool'
import { checkArgumentValues } from './arguments'
import { JS_EVAL_MAX_TOOL_CALLS, JS_EVAL_TOOL, textForModel, type JsEvalCallLine, type RunFolderForms } from './jsEval'
import { TOOL_DEFINITIONS, toolDefinition } from './registry'
import type { ToolArguments } from './types'

// The tool bridge: the Dez tools that code calls with `dez.sbp`: the code
// of a `js_eval` run (jsEval.ts), and the code of a run of a script app
// (appInvoke.ts). The module of Dez in the run writes one call line for
// each call (jsEvalRunner.js). This module tells which tool call a line
// asks for, or why Dez refuses it; controller/toolBridge.ts runs the call
// and writes the answer.
//
// A call line is untrusted input: the code of a model runs in the same
// program as the module that writes the lines, so it can write any line
// itself. So this page code is the guard, not the module:
// - No text of a line goes to the `sbp()` of the app. A selector of a line
//   is only a name that this module reads.
// - A line gets a call only of a Dez tool of `TOOL_DEFINITIONS`, with
//   arguments that the definition of the tool takes, as a call that the
//   model makes itself.
//
// The two forms of a selector:
// - `dez.tools/<tool>`, with the arguments of the tool. For a tool with
//   subcommands those are `command` and `parameters` (the text of a JSON
//   object), as in a call of the model.
// - `dez.tools/<tool>/<subcommand>`, with the parameters of the subcommand
//   as an object: code has objects, and needs no JSON text in a JSON text.

/** The tools that the code of a run cannot call. A run of code starts no
 *  other run of code: the limits of a run (its time, the count of its tool
 *  calls) would not hold for the work that it starts. */
const UNBRIDGED_TOOLS: readonly string[] = [JS_EVAL_TOOL.name]

/** A subcommand of a tool that the code of a run cannot call, and the
 *  error text of a call of it. */
interface UnbridgedSubcommand {
  tool: string
  subcommand: string
  text: string
}

/** The rules of the tool calls of the code of one kind of run. */
export interface BridgeRules {
  /** The most call lines of one run: a line after it gets no call. */
  maxCalls: number
  /** The error of a line after `maxCalls`. */
  overLimitText: string
  /** The subcommands that the code cannot call. The other subcommands of
   *  their tools go. */
  unbridged: readonly UnbridgedSubcommand[]
}

// `apps invoke` runs the code of an app, so no code calls it, for the cause
// of `UNBRIDGED_TOOLS`.
//
// The alias subcommands of `audio` and `video` (appAliases.ts) also run
// the code of an app, but they go: each runs fixed code that Dez ships,
// not code of a model, with its own time limit, and the call waits for
// it, so the time limit of the run that calls it still holds.
const UNBRIDGED_INVOKE: UnbridgedSubcommand = {
  tool: APPS_TOOL.name,
  subcommand: APPS_INVOKE,
  text: `Code cannot call ${APPS_TOOL.name} ${APPS_INVOKE}: a run of code starts no other run of code. `
    + `Call ${APPS_TOOL.name} ${APPS_INVOKE} yourself, as a tool call of your own, before or after this code.`,
}

/** The rules of the code of a `js_eval` run. */
export const JS_EVAL_BRIDGE: BridgeRules = {
  maxCalls: JS_EVAL_MAX_TOOL_CALLS,
  overLimitText: `The code made more than ${JS_EVAL_MAX_TOOL_CALLS} tool calls, the most of one ${JS_EVAL_TOOL.name} call, so Dez did not run this one. `
    + `Make fewer calls in one run: do the rest of the work in a new ${JS_EVAL_TOOL.name} call.`,
  unbridged: [UNBRIDGED_INVOKE],
}

/** The rules of the code of a run of a script app (`apps invoke`). It also
 *  shows no app: the run is a job, which has no reply to show the app in
 *  (`ToolRunContext.showApp`). */
export const APP_RUN_BRIDGE: BridgeRules = {
  maxCalls: APP_RUN_MAX_TOOL_CALLS,
  overLimitText: `The code made more than ${APP_RUN_MAX_TOOL_CALLS} tool calls, the most of one run of an app, so Dez did not run this one. `
    + 'Make fewer calls in one run: run the app again for the rest of the work.',
  unbridged: [
    UNBRIDGED_INVOKE,
    {
      tool: APPS_TOOL.name,
      subcommand: APPS_SHOW,
      text: `The code of an app cannot call ${APPS_TOOL.name} ${APPS_SHOW}: a job has no reply to show an app in. `
        + `Call ${APPS_TOOL.name} ${APPS_SHOW} yourself, as a tool call of your own, after the job.`,
    },
  ],
}

// The rule of `rules` that refuses a call of the tool `tool` that names
// the subcommand `command`, if one does. `command` is the subcommand as the
// call gave it: the runner of a subcommand tool trims the text
// (`parseSubcommandCall`), so this does too.
function unbridgedSubcommand(rules: BridgeRules, tool: string, command: unknown): UnbridgedSubcommand | undefined {
  return typeof command === 'string' ? rules.unbridged.find((rule) => rule.tool === tool && rule.subcommand === command.trim()) : undefined
}

/** The handle of the `number`th image or clip that the tool calls of the
 *  code of a run of an app made, from 1: `&1`, `&2`, …. The code knows the
 *  asset by it, as the asset gets its id only when a reader of the result
 *  of the job writes it into a reply (`writeJobAssets`). */
export function assetHandle(number: number): string {
  return `&${number}`
}

// A handle as the whole of a text, with an `@` or with none (`&1`, `@&1`).
const WHOLE_HANDLE = /^(@?)&([1-9]\d*)$/

// The chars of a word, as for a mention (chat/imageMentions.ts).
const WORD_CHARS = String.raw`\p{L}\p{M}\p{N}_`
// A handle as a mention in a text (`@&1`), by the rules of a mention: no
// word char comes before the `@` or after the number, and no `-` that
// joins it to a word. The regex takes the char before the `@` into the
// match, in place of a lookbehind, which older WebKit versions cannot
// parse.
const HANDLE_MENTION = new RegExp(String.raw`(^|[^${WORD_CHARS}])@&([1-9]\d*)(?![${WORD_CHARS}]|-[${WORD_CHARS}])`, 'gu')

// `text` with the id of each handle in it: a whole text that is a handle
// becomes the id (`&1` → `d`, `@&1` → `@d`), and each handle mention in a
// longer text becomes the mention of the id (`@&1` → `@d`). `ids` are the
// ids that stand for the handles, in the order of the handles. A handle
// of no asset stays, and goes into `unknown`.
function withHandleIds(text: string, ids: readonly string[], unknown: Set<string>): string {
  const idOf = (number: string): string | undefined => {
    const id = ids[Number(number) - 1]
    if (id === undefined) unknown.add(assetHandle(Number(number)))
    return id
  }
  const whole = WHOLE_HANDLE.exec(text.trim())
  if (whole) {
    const id = idOf(whole[2])
    return id === undefined ? text : `${whole[1]}${id}`
  }
  return text.replace(HANDLE_MENTION, (match, before: string, number: string) => {
    const id = idOf(number)
    return id === undefined ? match : `${before}@${id}`
  })
}

// The error of a call that names handles of no asset (`unknown`) of a run
// that made `made` assets.
function unknownHandlesText(unknown: ReadonlySet<string>, made: number): string {
  const named = [...unknown].join(', ')
  const handles = made === 0
    ? 'No tool call of this run made an image or a clip yet, so it has no handle.'
    : `The handles of this run: ${made === 1 ? assetHandle(1) : `${assetHandle(1)} to ${assetHandle(made)}`}.`
  return `The call names ${named}, but no tool call of this run made an image or a clip with that handle. ${handles} `
    + 'A handle names an image or a clip that an earlier tool call of the run made: give it as the whole value ("&1") or as a mention in a text ("@&1").'
}

/** `text` with each `@id` mention of an id of `handleById` (by provisional
 *  id, the handle of the asset) as the mention of the handle (`@&1`): a
 *  result of a tool call of the code of a run of an app names an asset of
 *  an earlier call by its handle, as the code knows it. */
export function withHandles(text: string, handleById: ReadonlyMap<string, string>): string {
  let mapped = ''
  let end = 0
  for (const { from, to, id } of findAssetMentions(text)) {
    const handle = handleById.get(id)
    if (handle === undefined) continue
    mapped += `${text.slice(end, from)}@${handle}`
    end = to
  }
  return mapped + text.slice(end)
}

const SELECTOR_START = 'dez.tools/'

// How code calls a tool, for the error texts.
const toolCallForm = (tool: string) => `\`await dez.sbp("${SELECTOR_START}${tool}", { …arguments })\``
const subcommandCallForm = (tool: string) => `\`await dez.sbp("${SELECTOR_START}${tool}/<subcommand>", { …parameters })\``
const CALL_FORMS = `Call a Dez tool with ${toolCallForm('<tool>')}, and a subcommand of a tool with ${subcommandCallForm('<tool>')}.`

// The most characters of a name of a call line that an error text shows.
const SHOWN_NAME_CHARS = 80

// A name that a call line gave (a selector, a part of one), on one line
// and short, as a line can hold a name of any length. The first cut keeps
// `oneLineCut` from a split of a text of megabytes into its characters.
function shortName(name: string): string {
  return oneLineCut(name.slice(0, SHOWN_NAME_CHARS * 4), SHOWN_NAME_CHARS)
}

// A name that a call line gave, for an error text: quoted.
function shown(name: string): string {
  return JSON.stringify(shortName(name))
}

/** The selector of a call line as the list of the tool calls of a run
 *  names a line that Dez refused (`BridgedCall.name`): with no path of
 *  this computer (`folders`, as for `bridgedToolCall`), on one line, and
 *  short. */
export function shownSelector(selector: string, folders: RunFolderForms): string {
  return shortName(textForModel(selector, folders))
}

/** The error that the code gets for a tool call that failed with an error
 *  that Dez did not expect, before its tool ran or after it
 *  (`unexpectedToolErrorText` is the text for a failure in the tool). It
 *  leaves out the text of the error, which can hold a local path. The log
 *  has it. */
export const UNEXPECTED_BRIDGE_ERROR_TEXT = 'Dez hit an error that it did not expect while it ran this tool call of the code. '
  + 'Tell the user that the tool call failed (Help › Developer Console shows the error), and do not make the same call again.'

// The `parameters` text of a call of a tool with subcommands, with no path
// of this computer (`forModel`). The cut of a path runs to the end of its
// line (`withoutLocalPaths`), and a JSON text is often one line: a cut of
// the text would take the end of the JSON with it, and the tool would
// refuse JSON that the code gave whole. A JSON text can also write a path
// with escapes (`\/home\/x`), which a cut of the text does not see. So the
// cut goes into the strings of the parsed value, as for the parameters of
// the subcommand form. A text that is no JSON gets the cut of a plain text:
// the tool refuses it anyway.
function parametersForModel(text: string, forModel: (text: string) => string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return forModel(text)
  }
  return JSON.stringify(mapJsonStrings(parsed, forModel))
}

/** A call that the bridge runs: a Dez tool, and the arguments that its
 *  definition accepted (a `ToolRunCall`, controller/tools.ts). */
export interface BridgedToolCall {
  name: string
  arguments: ToolArguments
}

/** What a call line asks for: a call to run, or the text of the error
 *  that the code gets, which tells the model how to fix its code. */
export type BridgedCallCheck =
  | { ok: true, call: BridgedToolCall }
  | { ok: false, error: string }

/** The tool call that the call line `line` of a run asks for, by the
 *  rules `rules` of its kind of run. `number` is the place of the line in
 *  the call lines of its run, from 1: a line after the limit of a run
 *  (`BridgeRules.maxCalls`) gets no call.
 *
 *  Refused with a text for the model: a selector that names no Dez tool,
 *  a tool or a subcommand that code cannot call (`UNBRIDGED_TOOLS`,
 *  `BridgeRules.unbridged`, in both forms of a selector), a subcommand
 *  that the tool does not have, arguments that are no object, and
 *  arguments that the definition of the tool does not take
 *  (`checkArgumentValues`). The parameters of a subcommand are not checked
 *  here: the runner of its tool checks them, as for a call of the model
 *  (`parseSubcommandCall`).
 *
 *  The selector and every text of the arguments first lose the paths of
 *  this computer (`textForModel`, with the paths `folders` of the folders
 *  of the run); the `parameters` text of a tool with subcommands loses
 *  them in the strings of its JSON (`parametersForModel`). The code can
 *  read the path of its run folder, of the work folder of its
 *  conversation, and of the Deno program, and an argument can go on to
 *  another provider (the prompt of a `model_invoke` call) or into the
 *  conversation (the label of a job). A path in the work folder goes as
 *  `/work/…`, as a model names it.
 *
 *  `handleIds` are given for the code of a run of an app: the ids that
 *  stand for the handles of the assets that the earlier calls of the run
 *  made (`assetHandle`), in the order of the handles. Each text of the
 *  arguments then gets the id of each handle in it (`withHandleIds`), and
 *  a call that names a handle of no asset is refused. */
export function bridgedToolCall(line: Pick<JsEvalCallLine, 'selector' | 'arguments'>, number: number, folders: RunFolderForms, rules: BridgeRules, handleIds?: readonly string[]): BridgedCallCheck {
  const refused = (error: string): BridgedCallCheck => ({ ok: false, error })
  if (number > rules.maxCalls) return refused(rules.overLimitText)
  const forModel = (text: string) => textForModel(text, folders)
  const selector = forModel(line.selector)
  if (!selector.startsWith(SELECTOR_START)) return refused(`\`dez.sbp\` has no selector ${shown(selector)}. ${CALL_FORMS}`)
  const [toolName, subcommand, ...more] = selector.slice(SELECTOR_START.length).split('/')
  if (more.length > 0) return refused(`The selector ${shown(selector)} has too many parts. ${CALL_FORMS}`)

  const definition = toolDefinition(toolName)
  if (!definition) {
    const names = TOOL_DEFINITIONS.flatMap((tool) => (UNBRIDGED_TOOLS.includes(tool.name) ? [] : [tool.name])).join(', ')
    return refused(`Dez has no tool named ${shown(toolName)}. The Dez tools that code can call, by their exact names: ${names}.`)
  }
  if (UNBRIDGED_TOOLS.includes(definition.name)) {
    return refused(`Code cannot call ${definition.name}: a run of code starts no other run of code. Do that work in this code, or in a new ${JS_EVAL_TOOL.name} call.`)
  }

  // No arguments (`dez.sbp(selector)`) are a call with none, as a call of
  // the model with a blank arguments text.
  const given = line.arguments ?? {}
  if (typeof given !== 'object' || Array.isArray(given)) {
    return refused(`The second argument of \`dez.sbp\` must be an object, as in ${toolCallForm(definition.name)}. Leave it out for a call with no arguments.`)
  }
  const unknownHandles = new Set<string>()
  const forCall = handleIds === undefined ? forModel : (text: string) => withHandleIds(forModel(text), handleIds, unknownHandles)
  const values = mapJsonStrings(given, forCall) as Record<string, unknown>
  const call = (checked: BridgedToolCall): BridgedCallCheck => (unknownHandles.size > 0
    ? refused(unknownHandlesText(unknownHandles, handleIds?.length ?? 0))
    : { ok: true, call: checked })

  if (subcommand === undefined) {
    const parameters: unknown = (given as Record<string, unknown>).parameters
    if (definition.subcommands && typeof parameters === 'string') values.parameters = parametersForModel(parameters, forCall)
    const checked = checkArgumentValues(definition, values)
    if (checked.ok) {
      const rule = unbridgedSubcommand(rules, definition.name, checked.arguments.command)
      return rule ? refused(rule.text) : call({ name: definition.name, arguments: checked.arguments })
    }
    return refused(definition.subcommands
      ? `${checked.error} In code, you can also name the subcommand in the selector and give its parameters as an object: ${subcommandCallForm(definition.name)}.`
      : checked.error)
  }
  if (!definition.subcommands) return refused(`The ${definition.name} tool has no subcommands. Call it with ${toolCallForm(definition.name)}.`)
  if (!definition.subcommands.includes(subcommand)) {
    return refused(`The ${definition.name} tool has no subcommand ${shown(subcommand)}. Its subcommands: ${definition.subcommands.join(', ')}. `
      + `Call one with ${subcommandCallForm(definition.name)}.`)
  }
  const rule = unbridgedSubcommand(rules, definition.name, subcommand)
  return rule ? refused(rule.text) : call({ name: definition.name, arguments: { command: subcommand, parameters: JSON.stringify(values) } })
}
