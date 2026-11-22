import { describe, expect, it } from 'vitest'
import { appTagText } from '../chat/appTags'
import { compactionBlockText } from '../chat/compaction'
import { compactionNotesText, type NotesApp } from '../chat/compactionNotes'
import { notesData } from '../chat/testing'
import { folderTree, notesManifest, textBytes } from '../tools/testing'
import {
  MENTION_FILE_BYTES,
  MENTION_MAX_BYTES,
  MENTION_MAX_FILES,
  appMentionFolder,
  carriedAppLines,
  compactionApp,
  fileMentions,
  mentionFiles,
  sectionAppNames,
  type MentionFolder,
} from './compactionApps'
import { reply, user } from './testing'

const NOTES_APP: NotesApp = { name: 'notes', kind: 'ui', description: 'Keeps notes.' }

describe('sectionAppNames', () => {
  it('gives each app that a section names one time, by a path or by a tag, in the order of the names', () => {
    const sections = [
      user('u1', 'Change /apps/timer/main.js so that it counts down.'),
      reply('r1', `Done.\n${appTagText('notes')}\nI also read /apps/timer/manifest.json.`),
      reply('r2', `${appTagText('board')}\n`),
    ]

    expect(sectionAppNames(sections)).toStrictEqual(['board', 'notes', 'timer'])
    expect(sectionAppNames([user('u1', 'Make an app for my notes.')])).toStrictEqual([])
  })

  it('gives the apps of the notes of the compaction before', () => {
    const block = compactionBlockText({ count: 1, lastId: null, pictures: [] }, compactionNotesText(notesData({ apps: [NOTES_APP] })))

    expect(sectionAppNames([reply('n', `${block}\nThe reply so far.`)])).toStrictEqual(['notes'])
  })

  it('leaves out a built-in app: Dez ships it, so the notes need not keep it', () => {
    const sections = [reply('r1', `Done.\n${appTagText('notes')}\nI ran /apps/dez-media/main.ts too.`)]

    expect(sectionAppNames(sections)).toStrictEqual(['notes'])
  })
})

describe('carriedAppLines', () => {
  it('gives the app lines of the notes of the first section, and none with no compaction', () => {
    const block = compactionBlockText({ count: 1, lastId: null, pictures: [] }, compactionNotesText(notesData({ apps: [NOTES_APP] })))

    expect(carriedAppLines([reply('n', block), user('u', 'Go on.')])).toStrictEqual(new Map([['notes', NOTES_APP]]))
    expect(carriedAppLines([user('u', 'Use /apps/notes.')])).toStrictEqual(new Map())
    expect(carriedAppLines([])).toStrictEqual(new Map())
  })
})

describe('compactionApp', () => {
  const tree = folderTree({ 'manifest.json': 80, 'index.html': 400 })

  it('tells the kind and the description of the manifest that Dez read now, not the ones of the notes before', () => {
    const carried: NotesApp = { name: 'notes', kind: 'script', description: 'An old text.' }

    expect(compactionApp('notes', { name: 'notes', tree, manifest: notesManifest('ui') }, carried)).toStrictEqual(NOTES_APP)
  })

  it('still gives a line for an app with no manifest', () => {
    const app = compactionApp('notes', { name: 'notes', tree: folderTree({ 'main.js': 10 }), manifest: null }, undefined)

    expect(app).toMatchObject({ name: 'notes', kind: '?' })
    expect(app.description).toContain('manifest.json')
  })

  it('keeps the line of the notes before for an app that Dez could not read, and tells so for an app with no line', () => {
    expect(compactionApp('notes', null, NOTES_APP)).toStrictEqual(NOTES_APP)

    const app = compactionApp('notes', null, undefined)
    expect(app).toMatchObject({ name: 'notes', kind: '?' })
    expect(app.description).toContain('could not read')
  })
})

describe('mentionFiles', () => {
  const files = (folders: readonly MentionFolder[]) => mentionFiles(folders).map((path) => path.file)
  const app = (name: string, tree: MentionFolder['tree']) => appMentionFolder({ name, tree })

  it('takes the plain files with bytes, the ones nearest to their folder first, then by folder and by path', () => {
    const notes = folderTree({ 'main.js': 10, 'lib': null, 'lib/z.js': 10, 'lib/a.js': 10, 'empty.txt': 0, 'link': 'other' })
    const board = folderTree({ 'index.html': 10, 'lib': null, 'lib/b.js': 10 })
    const work: MentionFolder = { folder: { root: 'app', file: 'work/c1', virtual: '/work' }, tree: folderTree({ 'plan.txt': 10, 'frames': null, 'frames/list.txt': 10 }) }

    expect(mentionFiles([app('board', board), app('notes', notes), work])).toStrictEqual([
      { root: 'app', file: 'apps/board/index.html', virtual: '/apps/board/index.html' },
      { root: 'app', file: 'apps/notes/main.js', virtual: '/apps/notes/main.js' },
      { root: 'app', file: 'work/c1/plan.txt', virtual: '/work/plan.txt' },
      { root: 'app', file: 'apps/board/lib/b.js', virtual: '/apps/board/lib/b.js' },
      { root: 'app', file: 'apps/notes/lib/a.js', virtual: '/apps/notes/lib/a.js' },
      { root: 'app', file: 'apps/notes/lib/z.js', virtual: '/apps/notes/lib/z.js' },
      { root: 'app', file: 'work/c1/frames/list.txt', virtual: '/work/frames/list.txt' },
    ])
  })

  it('reads a built-in app from the files that Dez ships', () => {
    expect(mentionFiles([app('dez-media', folderTree({ 'main.ts': 10 }))])).toStrictEqual([
      { root: 'resource', file: 'builtin-apps/dez-media/main.ts', virtual: '/apps/dez-media/main.ts' },
    ])
  })

  it('leaves out a file that is larger than the limit of one file', () => {
    const tree = folderTree({ 'data.bin': MENTION_FILE_BYTES + 1, 'main.js': MENTION_FILE_BYTES })

    expect(files([app('notes', tree)])).toStrictEqual(['apps/notes/main.js'])
  })

  it('takes no more files than the limit of one compaction', () => {
    const tree = folderTree(Object.fromEntries(Array.from({ length: MENTION_MAX_FILES + 5 }, (_, index) => [`f${String(index).padStart(4, '0')}.js`, 10])))
    const taken = files([app('notes', tree)])

    expect(taken).toHaveLength(MENTION_MAX_FILES)
    expect(taken[0]).toBe('apps/notes/f0000.js')
  })

  it('leaves out a file that the rest of the bytes of one compaction cannot hold, and takes a smaller one after it', () => {
    // The `a` files and `b.js` leave 100 bytes of the limit.
    const whole = MENTION_MAX_BYTES / MENTION_FILE_BYTES - 1
    const entries: Record<string, number> = Object.fromEntries(Array.from({ length: whole }, (_, index) => [`a${String(index).padStart(2, '0')}.js`, MENTION_FILE_BYTES]))
    entries['b.js'] = MENTION_FILE_BYTES - 100
    entries['c.js'] = 101
    entries['d.js'] = 100
    const taken = files([app('notes', folderTree(entries))])

    expect(taken).toContain('apps/notes/b.js')
    expect(taken).not.toContain('apps/notes/c.js')
    expect(taken.at(-1)).toBe('apps/notes/d.js')
  })
})

describe('fileMentions', () => {
  it('gives each id that the text of a file names with @id, one time', () => {
    expect(fileMentions(textBytes('const INPUTS = ["@a", "@c"]\n// @a is the photo, me@example.com is no id.'))).toStrictEqual(new Set(['a', 'c']))
    expect(fileMentions(textBytes('export default () => 1'))).toStrictEqual(new Set())
  })

  it('gives no id for a file with a zero byte: it is no text', () => {
    expect(fileMentions(new Uint8Array([0x40, 0x61, 0x20, 0x00, 0x40, 0x62]))).toStrictEqual(new Set())
  })

  it('still gives the ids of a text with bytes that are no UTF-8', () => {
    expect(fileMentions(new Uint8Array([0xff, 0xfe, 0x20, ...textBytes('use @b here')]))).toStrictEqual(new Set(['b']))
  })
})
