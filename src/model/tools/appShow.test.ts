import { describe, expect, it } from 'vitest'
import { APP_KINDS, MANIFEST_MAX_BYTES } from './appManifest'
import { appCardFacts, appNotShownText, checkShowTarget, showCall, shownAppNames, shownAppText, showResultText, type ShowTarget } from './appShow'
import { appsArgs, fileTree, FOLDER_FACTS, folderTree, MISSING_TREE, notesManifest, refusal } from './testing'

const NOT_SHOWN = 'Dez shows no app.'

function show(name: string) {
  return showCall(appsArgs('show', { name }))
}

describe('showCall', () => {
  it('names the app, its manifest, and its page', () => {
    const call = show(' notes ')

    expect(call.name).toBe('notes')
    expect([call.app.virtual, call.manifest.virtual, call.index.virtual]).toStrictEqual(['/apps/notes', '/apps/notes/manifest.json', '/apps/notes/index.html'])
  })

  it('refuses a name that is no name of an app', () => {
    for (const name of ['My App', '../notes', 'notes/index.html', '/apps/notes', '']) {
      expect(refusal(() => show(name)), name).toContain('is no name for an app')
    }
  })
})

// What is at the paths of a UI app that Dez can show, with `changes`.
function target(changes: Partial<ShowTarget> = {}): ShowTarget {
  const manifestBytes = notesManifest('ui')
  return { app: FOLDER_FACTS, manifest: { kind: 'file', size: manifestBytes.length }, manifestBytes, index: { kind: 'file', size: 300 }, ...changes }
}

describe('checkShowTarget', () => {
  const call = show('notes')
  const check = (changes: Partial<ShowTarget>) => refusal(() => checkShowTarget(call, target(changes)))

  it('takes a UI app with a page', () => {
    expect(() => checkShowTarget(call, target())).not.toThrow()
  })

  it('refuses an app that is not there, and a file at its place', () => {
    expect(check({ app: MISSING_TREE })).toContain('There is no app /apps/notes')
    expect(check({ app: { kind: 'file', size: 3 } })).toContain('/apps/notes is a file and no folder')
  })

  it('refuses an app whose manifest is missing, is no plain small file, or is not valid', () => {
    const missing = check({ manifest: MISSING_TREE, manifestBytes: null })
    expect(missing).toContain('has no manifest.json')

    for (const manifest of [FOLDER_FACTS, { kind: 'other', size: 0 }, { kind: 'file', size: MANIFEST_MAX_BYTES + 1 }] as const) {
      expect(check({ manifest, manifestBytes: null }), manifest.kind).toContain('/apps/notes/manifest.json is no plain file')
    }

    const invalid = check({ manifestBytes: new TextEncoder().encode('{"name": "notes"') })
    expect(invalid).toContain('/apps/notes/manifest.json is not valid')
    for (const text of [missing, invalid]) {
      expect(text).toContain(NOT_SHOWN)
      for (const kind of APP_KINDS) expect(text).toContain(`"${kind}"`)
    }
  })

  it('refuses a script app before it looks at the page, and names invoke', () => {
    const text = check({ manifestBytes: notesManifest('script'), index: MISSING_TREE })

    expect(text).toContain('/apps/notes is a script app')
    expect(text).toContain('run it with invoke')
    expect(text).toContain(NOT_SHOWN)
  })

  it('refuses a built-in UI app, as a fault of Dez', () => {
    const text = refusal(() => checkShowTarget(show('dez-board'), target()))

    expect(text).toBe(`/apps/dez-board is a built-in app of Dez with the kind "ui", and Dez shows and runs no built-in UI app. This is a fault of Dez, not of your call: tell the user. ${NOT_SHOWN}`)
  })

  it('refuses a UI app with no page, and one with a folder or a link at its place', () => {
    const missing = check({ index: MISSING_TREE })
    expect(missing).toContain('has no index.html')
    expect(missing).toContain('Write /apps/notes/index.html')
    expect(missing).toContain(NOT_SHOWN)

    expect(check({ index: FOLDER_FACTS })).toContain('/apps/notes/index.html is a folder and no file')
    expect(check({ index: { kind: 'other', size: 0 } })).toContain('/apps/notes/index.html is a link or a special file and no file')
  })

  it('checks the app before its manifest, and the manifest before the page', () => {
    expect(check({ app: MISSING_TREE, manifest: MISSING_TREE, manifestBytes: null, index: MISSING_TREE })).toContain('There is no app')
    expect(check({ manifest: MISSING_TREE, manifestBytes: null, index: MISSING_TREE })).toContain('has no manifest.json')
  })
})

describe('appCardFacts', () => {
  const call = show('notes')
  const tree = folderTree({ 'manifest.json': 80, 'index.html': 300, lib: null, 'lib/a.js': 1200 })
  const facts = (changes: Partial<ShowTarget> = {}, listing = tree) => appCardFacts(call, target(changes), listing)
  const SIZE = { bytes: 1580, more: false }

  it('gives the description and the size of a UI app that Dez can show', () => {
    expect(facts()).toStrictEqual({ state: 'ready', description: 'Keeps notes.', size: SIZE })
  })

  it('tells that an app is larger than its listing', () => {
    expect(facts({}, folderTree({ 'index.html': 300 }, true))).toMatchObject({ size: { bytes: 300, more: true } })
  })

  it('tells an app with no folder from one that Dez cannot show', () => {
    expect(facts({ app: MISSING_TREE, manifest: MISSING_TREE, manifestBytes: null, index: MISSING_TREE }, MISSING_TREE)).toStrictEqual({ state: 'missing' })

    for (const [what, changes] of [
      ['no manifest', { manifest: MISSING_TREE, manifestBytes: null }],
      ['a manifest that is not valid', { manifestBytes: new TextEncoder().encode('{"name": "notes"') }],
      ['a script app', { manifestBytes: notesManifest('script') }],
      ['no page', { index: MISSING_TREE }],
      ['a folder at the place of the page', { index: FOLDER_FACTS }],
    ] as Array<[string, Partial<ShowTarget>]>) {
      expect(facts(changes), what).toStrictEqual({ state: 'broken', size: SIZE })
    }
  })

  it('gives no size when a file is at the place of the folder', () => {
    expect(facts({ app: { kind: 'file', size: 3 } }, fileTree(3))).toStrictEqual({ state: 'broken', size: null })
  })
})

describe('shownAppNames', () => {
  it('reads the app of a show result, and of each line of a text with more than one', () => {
    expect(shownAppNames(showResultText('notes'))).toStrictEqual(['notes'])
    expect(shownAppNames(`done\n${shownAppText('notes')}.\n${shownAppText('timer-2')}.\n${shownAppText('notes')}.`)).toStrictEqual(['notes', 'timer-2', 'notes'])
  })

  it('reads the whole name: one that ends with a dash or an underscore, and one that starts with the name of another app', () => {
    expect(shownAppNames(`${shownAppText('a-')}.`)).toStrictEqual(['a-'])
    expect(shownAppNames(`${shownAppText('a_')} in your reply`)).toStrictEqual(['a_'])
    expect(shownAppNames(`${shownAppText('notes2')}.`)).toStrictEqual(['notes2'])
  })

  it.each([
    ['the sentence is not at a line start', `Note: ${shownAppText('notes')}.`],
    ['the text only names the app', 'The app notes is ready.'],
    ['the name is no name of an app', `${shownAppText('Notes')}.`],
    ['the name is too long for an app', `${shownAppText('n'.repeat(65))}.`],
    ['the call was refused', refusal(() => checkShowTarget(show('notes'), target({ index: MISSING_TREE })))],
    ['the reply took no app', appNotShownText()],
  ])('reads no app when %s', (_case, text) => {
    expect(shownAppNames(text)).toStrictEqual([])
  })
})
