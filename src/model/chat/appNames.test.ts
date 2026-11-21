import { describe, expect, it } from 'vitest'
import { escapeMarkerAttribute } from '../../utils/markerAttribute'
import { findCall, findText } from '../tools/appsTool'
import { appsArgs, folderTree } from '../tools/testing'
import { appTagText } from './appTags'
import { namedApps } from './appNames'
import { toolBlockText } from './toolBlocks'

function names (text: string): string[] {
  return [...namedApps(text)].sort()
}

// The block of one `apps` call, as a conversation file holds it.
function appsCall (command: string, parameters: unknown, result = 'Done.'): string {
  return toolBlockText({ id: 'call_1', name: 'apps', status: 'success', arguments: { command, parameters: JSON.stringify(parameters) }, result })
}

describe('namedApps', () => {
  it('finds the app of a tag', () => {
    expect(names(`Here it is:\n${appTagText('unit-converter')}\n`)).toStrictEqual(['unit-converter'])
  })

  it('finds the app that a call names with `name`', () => {
    expect(names(appsCall('show', { name: 'timer' }))).toContain('timer')
    expect(names(appsCall('invoke', { name: 'contact-sheet', parameters: { columns: 4 }, inputs: ['a1'] }))).toContain('contact-sheet')
    expect(names(appsCall('init', { name: 'notes_2', kind: 'ui', description: 'Keeps notes.' }))).toContain('notes_2')
  })

  it('finds the apps of the paths of a call and of its result', () => {
    expect(names(appsCall('read', { path: '/apps/timer/main.js' }, '1: let seconds = 0'))).toContain('timer')
    expect(names(appsCall('rm', { paths: ['/apps/a/old.js', '/apps/b'] }))).toStrictEqual(expect.arrayContaining(['a', 'b']))
    expect(names(appsCall('mv', { moves: [{ from: '/apps/old-name', to: '/apps/new-name' }] }))).toStrictEqual(expect.arrayContaining(['old-name', 'new-name']))
    expect(names('Made the UI app /apps/clock with 4 files:\n/apps/clock/index.html')).toStrictEqual(['clock'])
    expect(names('The app is at /apps/clock.')).toStrictEqual(['clock'])
  })

  it('takes the whole name of a path, not a start of it', () => {
    expect(names('/apps/notes2/main.js')).toStrictEqual(['notes2'])
    expect(names(`/apps/${'a'.repeat(64)}/main.js`)).toStrictEqual(['a'.repeat(64)])
    expect(names(`/apps/${'a'.repeat(65)}/main.js`)).toStrictEqual([])
    expect(names('/apps/-x and /apps/ and /apps')).toStrictEqual([])
  })

  it('finds the app of a call that the code of a js_eval call made', () => {
    // JSON in JSON in an attribute: each quote of the inner text has a `\`.
    const record = JSON.stringify({ calls: [{ name: 'apps', arguments: { command: 'show', parameters: JSON.stringify({ name: 'chart' }) } }] })
    const attribute = escapeMarkerAttribute(record)
    expect(attribute).toContain('\\&quot;name\\&quot;:\\&quot;chart\\&quot;')
    expect(names(`<dez:tool id="c1" name="js_eval" bridged="${attribute}">`)).toContain('chart')
    // An attribute that was escaped once more.
    expect(names(escapeMarkerAttribute(attribute))).toContain('chart')
  })

  it('finds the app that code names', () => {
    expect(names('await dez.sbp(\'apps\', { command: \'show\', parameters: { name: \'chart\' } })')).toStrictEqual(['chart'])
    expect(names('const call = { name : `chart-2` }')).toStrictEqual(['chart-2'])
    expect(names(escapeMarkerAttribute('{\n  "name":\n    "chart"\n}'))).toStrictEqual(['chart'])
    expect(names('{ "name": "chart" }')).toStrictEqual(['chart'])
  })

  it('takes no name that is not the whole quoted value of a `name`', () => {
    expect(names('name="foo.png"')).toStrictEqual([])
    expect(names('name="Timer"')).toStrictEqual([])
    expect(names(`name="${'a'.repeat(65)}"`)).toStrictEqual([])
    expect(names('The name is timer, and "timer" is its name.')).toStrictEqual([])
    expect(names('name=timer')).toStrictEqual([])
  })

  it('takes no app of a list of bare names', () => {
    const list = '3 apps (name | kind | size | description), by name.\nclock | ui | 2 KB | Shows the time.\nnotes | ui | 9 KB | Keeps notes.\ntimer | script | 1 KB | Counts down.'
    expect(names(list)).toStrictEqual([])
    expect(names('/apps: 2 folders and 0 files (name | size).\nclock/ | 4 files, 2 KB\nnotes/ | 3 files, 9 KB')).toStrictEqual([])
    expect(names('No app matches `name` "x". /apps/ has 3 apps: call list_apps with no parameters to list them all.')).toStrictEqual([])
  })

  it('takes no app of a find of the files of every app', () => {
    const tree = folderTree({ clock: null, 'clock/main.js': 5, notes: null, 'notes/src/main.js': 9 })
    const result = findText(findCall(appsArgs('find', { query: '*' })), tree)
    expect(result).toContain('notes/src/main.js')
    expect(names(result)).toStrictEqual([])
  })

  it('keeps an app that only looks named: the safe side', () => {
    expect(names(appsCall('list_apps', { name: 'convert' }))).toStrictEqual(expect.arrayContaining(['apps', 'convert']))
    expect(names('https://example.com/apps/shop/cart')).toStrictEqual(['shop'])
  })

  it('reads a long text with many `name` words and paths once', () => {
    const text = `${'name '.repeat(200_000)}${'/apps/'.repeat(200_000)}${'a'.repeat(1_000_000)}`
    const start = performance.now()
    expect(names(text)).toStrictEqual([])
    expect(performance.now() - start).toBeLessThan(2000)
  })
})
