import { describe, expect, it } from 'vitest'
import { APP_RUN_MAX_TOOL_CALLS } from './appsTool'
import { JS_EVAL_MAX_TOOL_CALLS } from './jsEval'
import { TOOL_DEFINITIONS } from './registry'
import { JOINED_RUN_FOLDER, JOINED_WORK_FOLDER, REAL_RUN_FOLDER, REAL_WORK_FOLDER, RUN_FOLDER_ID, RUN_FOLDERS } from './testing'
import { APP_RUN_BRIDGE, bridgedToolCall, JS_EVAL_BRIDGE, shownSelector, withHandles, type BridgedCallCheck } from './toolBridge'

// What the first call line of a `js_eval` run asks for.
function checked(selector: string, args?: unknown, number = 1): BridgedCallCheck {
  return bridgedToolCall(args === undefined ? { selector } : { selector, arguments: args }, number, RUN_FOLDERS, JS_EVAL_BRIDGE)
}

// The error text of a call line that Dez refuses.
function refusal(selector: string, args?: unknown, number = 1): string {
  return refusalOf(checked(selector, args, number), selector)
}

function refusalOf(check: BridgedCallCheck, selector: string): string {
  if (check.ok) throw new Error(`Dez did not refuse ${selector}`)
  return check.error
}

// What a call line of a run of an app asks for, after the earlier calls of
// the run made the assets whose ids stand for the handles `handleIds`.
function appChecked(selector: string, args: unknown, handleIds: readonly string[] = [], number = 1): BridgedCallCheck {
  return bridgedToolCall({ selector, arguments: args }, number, RUN_FOLDERS, APP_RUN_BRIDGE, handleIds)
}

function appRefusal(selector: string, args: unknown, handleIds: readonly string[] = [], number = 1): string {
  return refusalOf(appChecked(selector, args, handleIds, number), selector)
}

// The parameters of a call of a subcommand that Dez runs.
function parametersOf(check: BridgedCallCheck): unknown {
  if (!check.ok) throw new Error(`Dez refused the call: ${check.error}`)
  return JSON.parse(String(check.call.arguments.parameters))
}

describe('bridgedToolCall', () => {
  it('gives a call of a tool with its arguments', () => {
    expect(checked('dez.tools/asset_info', { assets: '@a @b', checks: 'black' })).toStrictEqual({
      ok: true,
      call: { name: 'asset_info', arguments: { assets: '@a @b', checks: 'black' } },
    })
  })

  it('gives a call of a subcommand with its parameters as the JSON text that the tool takes', () => {
    const check = checked('dez.tools/image/scale', { image: 'a', width: 1024 })

    expect(check).toStrictEqual({ ok: true, call: { name: 'image', arguments: { command: 'scale', parameters: '{"image":"a","width":1024}' } } })
  })

  it('takes the own arguments of a tool with subcommands', () => {
    const args = { command: 'scale', parameters: '{"image":"a","width":1024}' }

    expect(checked('dez.tools/image', args)).toStrictEqual({ ok: true, call: { name: 'image', arguments: args } })
  })

  it.each([undefined, null])('takes the arguments %j as a call with none', (args) => {
    expect(checked('dez.tools/jobs_list', args)).toStrictEqual({ ok: true, call: { name: 'jobs_list', arguments: {} } })
    expect(checked('dez.tools/image/help', args)).toStrictEqual({ ok: true, call: { name: 'image', arguments: { command: 'help', parameters: '{}' } } })
  })

  it.each(['@a', 5, true, [{ assets: '@a' }]])('refuses the arguments %j, which are no object', (args) => {
    expect(refusal('dez.tools/asset_info', args)).toContain('must be an object')
    expect(refusal('dez.tools/image/scale', args)).toContain('must be an object')
  })

  it.each([
    'dez.native/readAppFile',
    'dez.controller/tools/run',
    'sbp/selectors/register',
    'dez.tools',
    'DEZ.TOOLS/image',
    '',
  ])('refuses the selector %j, which names no Dez tool, and tells the two forms of a call', (selector) => {
    const error = refusal(selector, {})

    expect(error).toContain(`no selector ${JSON.stringify(selector)}`)
    expect(error).toContain('dez.sbp("dez.tools/<tool>", ')
    expect(error).toContain('dez.sbp("dez.tools/<tool>/<subcommand>", ')
  })

  it.each(['nope', '', 'Image', 'constructor', '__proto__'])('refuses the tool name %j with the names of the tools that code can call', (name) => {
    const error = refusal(`dez.tools/${name}`, {})

    expect(error).toContain(`no tool named ${JSON.stringify(name)}`)
    for (const tool of TOOL_DEFINITIONS) {
      if (tool.name === 'js_eval') expect(error).not.toContain(tool.name)
      else expect(error).toContain(tool.name)
    }
  })

  it('refuses a call of js_eval', () => {
    expect(refusal('dez.tools/js_eval', { code: 'return 1' })).toContain('Code cannot call js_eval')
  })

  // A run of code starts no other run of code, by either form of a call.
  it('refuses apps invoke in both forms of a selector, and tells the model to make the call itself', () => {
    const errors = [
      refusal('dez.tools/apps/invoke', { name: 'notes' }),
      refusal('dez.tools/apps', { command: 'invoke', parameters: '{"name": "notes"}' }),
      refusal('dez.tools/apps', { command: ' invoke\n' }),
    ]

    for (const error of errors) {
      expect(error).toContain('Code cannot call apps invoke')
      expect(error).toContain('as a tool call of your own')
    }
  })

  it('runs the other subcommands of the apps tool', () => {
    expect(checked('dez.tools/apps/ls', { path: '/apps/notes' })).toStrictEqual({
      ok: true,
      call: { name: 'apps', arguments: { command: 'ls', parameters: '{"path":"/apps/notes"}' } },
    })
    expect(checked('dez.tools/apps', { command: 'list_apps' }).ok).toBe(true)
  })

  it('refuses a selector with more parts than a tool and a subcommand', () => {
    expect(refusal('dez.tools/image/scale/more', { image: 'a' })).toContain('too many parts')
    expect(refusal('dez.tools/image/scale/', { image: 'a' })).toContain('too many parts')
  })

  it('refuses a subcommand of a tool that has none, and tells the call of the tool', () => {
    const error = refusal('dez.tools/asset_info/black', { assets: '@a' })

    expect(error).toContain('asset_info tool has no subcommands')
    expect(error).toContain('dez.sbp("dez.tools/asset_info", ')
  })

  it.each(['resize', '', 'Scale'])('refuses the subcommand %j, which the tool does not have, with the names of its subcommands', (subcommand) => {
    const error = refusal(`dez.tools/image/${subcommand}`, { image: 'a' })

    expect(error).toContain(`no subcommand ${JSON.stringify(subcommand)}`)
    expect(error).toContain('crop, scale, flip, rotate, brightness, contrast, saturation, invert, convert, help')
  })

  it('refuses arguments that the tool does not take, with the error of a direct call', () => {
    expect(refusal('dez.tools/asset_info', { assets: 5 })).toBe('The parameter "assets" must be a string, as in {"assets": "..."}.')
    expect(refusal('dez.tools/asset_info', {})).toMatch(/^The required parameter "assets" is missing\./)
    expect(refusal('dez.tools/jobs_list', { all: true })).toMatch(/^jobs_list has no parameter "all"\./)
  })

  it('tells the selector of a subcommand when the parameters of one are the arguments of its tool', () => {
    const error = refusal('dez.tools/image', { image: 'a', width: 1024 })

    expect(error).toMatch(/^image has no parameter "image"\./)
    expect(error).toContain('dez.sbp("dez.tools/image/<subcommand>", ')
  })

  it(`runs the call ${JS_EVAL_MAX_TOOL_CALLS} of a run, and refuses each one after it`, () => {
    expect(checked('dez.tools/jobs_list', {}, JS_EVAL_MAX_TOOL_CALLS).ok).toBe(true)
    expect(refusal('dez.tools/jobs_list', {}, JS_EVAL_MAX_TOOL_CALLS + 1)).toContain(`more than ${JS_EVAL_MAX_TOOL_CALLS} tool calls`)
    // Also a call that Dez refuses for another cause.
    expect(refusal('dez.tools/nope', {}, JS_EVAL_MAX_TOOL_CALLS + 1)).toContain(`more than ${JS_EVAL_MAX_TOOL_CALLS} tool calls`)
  })

  // The code gets the paths of its folders, and names a file of the work
  // folder by its path (`dez.workFolder`); the tool gets it as /work.
  it('takes the paths of this computer out of the arguments', () => {
    const check = checked('dez.tools/model_invoke', { model: 'p/m', prompt: `Read ${REAL_RUN_FOLDER}/code.ts, ${JOINED_RUN_FOLDER}, and ${JOINED_WORK_FOLDER}/notes.txt, then /home/u/apps/dez-deno` })

    expect(check).toStrictEqual({
      ok: true,
      call: { name: 'model_invoke', arguments: { model: 'p/m', prompt: 'Read /run/code.ts, /run, and /work/notes.txt, then /home/…' } },
    })
  })

  it('takes the paths of this computer out of the parameters of a subcommand, also out of a name', () => {
    const check = checked('dez.tools/video/ffmpeg', { arguments: `-i @c ${REAL_RUN_FOLDER}/out.mp4`, [`${JOINED_RUN_FOLDER}/x`]: [`${REAL_RUN_FOLDER}/y`, `${REAL_WORK_FOLDER}/z`] })

    expect(check).toStrictEqual({
      ok: true,
      call: { name: 'video', arguments: { command: 'ffmpeg', parameters: '{"arguments":"-i @c /run/out.mp4","/run/x":["/run/y","/work/z"]}' } },
    })
  })

  it('takes the paths of this computer out of the strings of a parameters text, and keeps its JSON whole', () => {
    const parameters = JSON.stringify({ arguments: `-i @c ${REAL_RUN_FOLDER}/out.mp4 -t 2`, [`${JOINED_RUN_FOLDER}/x`]: ['/tmp/a b', 'c'] })
    const check = checked('dez.tools/video', { command: 'ffmpeg', parameters })

    expect(check).toStrictEqual({
      ok: true,
      call: { name: 'video', arguments: { command: 'ffmpeg', parameters: '{"arguments":"-i @c /run/out.mp4 -t 2","/run/x":["/tmp/…","c"]}' } },
    })
  })

  it('takes a path that a parameters text writes with escapes out of it', () => {
    const check = checked('dez.tools/video', { command: 'ffmpeg', parameters: String.raw`{"arguments":"-i \/home\/alice\/a.mp4"}` })

    expect(check).toStrictEqual({ ok: true, call: { name: 'video', arguments: { command: 'ffmpeg', parameters: '{"arguments":"-i /home/…"}' } } })
  })

  it('takes the paths of this computer out of a parameters text that is no JSON', () => {
    const check = checked('dez.tools/video', { command: 'ffmpeg', parameters: '{"arguments":"-i /home/alice/a.mp4"' })

    expect(check).toStrictEqual({ ok: true, call: { name: 'video', arguments: { command: 'ffmpeg', parameters: '{"arguments":"-i /home/…' } } })
  })

  it('takes the paths of this computer out of a selector that it tells back', () => {
    const error = refusal(`${REAL_RUN_FOLDER}/code.ts`)

    expect(error).toContain('"/run/code.ts"')
    expect(error).not.toContain(RUN_FOLDER_ID)
  })

  it('tells back only the start of a long name', () => {
    const long = 'x'.repeat(2_000_000)

    expect(refusal(long).length).toBeLessThan(500)
    expect(refusal(`dez.tools/${long}`).length).toBeLessThan(1000)
    expect(refusal(`dez.tools/image/${long}`).length).toBeLessThan(500)
  })

  it('tells back a name with line ends on one line', () => {
    expect(refusal('dez.tools/a\nb').split('\n')).toHaveLength(1)
  })
})

describe('bridgedToolCall in a run of an app', () => {
  it('refuses apps show, apps invoke, and js_eval, in both forms of a selector', () => {
    for (const show of [appRefusal('dez.tools/apps/show', { name: 'notes' }), appRefusal('dez.tools/apps', { command: 'show', parameters: '{"name":"notes"}' })]) {
      expect(show).toContain('cannot call apps show')
    }
    expect(appRefusal('dez.tools/apps/invoke', { name: 'notes' })).toContain('cannot call apps invoke')
    expect(appRefusal('dez.tools/js_eval', { code: 'return 1' })).toContain('Code cannot call js_eval')
    // The code of js_eval runs in a reply, so it can show an app.
    expect(checked('dez.tools/apps/show', { name: 'notes' }).ok).toBe(true)
  })

  it(`runs the call ${APP_RUN_MAX_TOOL_CALLS} of a run, and refuses each one after it`, () => {
    expect(appChecked('dez.tools/jobs_list', {}, [], APP_RUN_MAX_TOOL_CALLS).ok).toBe(true)
    expect(appRefusal('dez.tools/jobs_list', {}, [], APP_RUN_MAX_TOOL_CALLS + 1)).toContain(`more than ${APP_RUN_MAX_TOOL_CALLS} tool calls`)
  })

  it('gives the tool the id of a handle that is a whole value, with or without its @', () => {
    const ids = ['k', 'm']

    expect(parametersOf(appChecked('dez.tools/image/flip', { image: '&2', direction: 'vertical' }, ids))).toStrictEqual({ image: 'm', direction: 'vertical' })
    expect(parametersOf(appChecked('dez.tools/image/flip', { image: ' @&1 ', direction: 'vertical' }, ids))).toStrictEqual({ image: '@k', direction: 'vertical' })
    // In the parameters text of the form of a call of the model too.
    const call = appChecked('dez.tools/image', { command: 'flip', parameters: '{"image":"&1","direction":"vertical"}' }, ids)
    expect(parametersOf(call)).toStrictEqual({ image: 'k', direction: 'vertical' })
  })

  it('gives the tool the id of each handle mention in a text, and keeps a & that is no handle mention', () => {
    const check = appChecked('dez.tools/model_invoke', { model: 'p/m', prompt: 'Mix @&1 and @&2 with @a. Keep Tom&1, x@&1, @&1x, @&1-b, @&0, and &1.' }, ['k', 'm'])

    expect(check).toStrictEqual({
      ok: true,
      call: { name: 'model_invoke', arguments: { model: 'p/m', prompt: 'Mix @k and @m with @a. Keep Tom&1, x@&1, @&1x, @&1-b, @&0, and &1.' } },
    })
  })

  it('refuses a call that names a handle of no asset, and tells the handles of the run', () => {
    const error = appRefusal('dez.tools/image/flip', { image: '&3', direction: 'vertical' }, ['k', 'm'])

    expect(error).toContain('The call names &3')
    expect(error).toContain('The handles of this run: &1 to &2.')
    expect(appRefusal('dez.tools/model_invoke', { model: 'p/m', prompt: 'Look at @&1.' })).toContain('No tool call of this run made an image or a clip yet')
  })

  it('gives the code of js_eval a handle as it is: its calls make assets of the reply', () => {
    expect(parametersOf(checked('dez.tools/image/flip', { image: '&1', direction: 'vertical' }))).toStrictEqual({ image: '&1', direction: 'vertical' })
  })
})

describe('withHandles', () => {
  it('names each asset of a handle by its handle, and keeps the other mentions', () => {
    const handles = new Map([['k', '&1'], ['m', '&2']])

    expect(withHandles('Made the image @k. The video clip @m goes over @a and @km.', handles)).toBe('Made the image @&1. The video clip @&2 goes over @a and @km.')
  })
})

describe('shownSelector', () => {
  it('gives a selector as it is', () => {
    expect(shownSelector('dez.tools/image/flip', RUN_FOLDERS)).toBe('dez.tools/image/flip')
  })

  it('gives a selector with no path of this computer, on one line, and short', () => {
    expect(shownSelector(`${REAL_RUN_FOLDER}/code.ts\n${JOINED_RUN_FOLDER}`, RUN_FOLDERS)).toBe('/run/code.ts /run')
    expect([...shownSelector('x'.repeat(2_000_000), RUN_FOLDERS)].length).toBeLessThanOrEqual(80)
    // The path goes before the cut: a cut inside it would leave a part.
    expect(shownSelector(`${'x'.repeat(60)}${REAL_RUN_FOLDER}/code.ts`, RUN_FOLDERS)).not.toContain('mnt')
  })
})
