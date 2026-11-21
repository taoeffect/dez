import { describe, expect, it } from 'vitest'
import { grepCall, grepPlan, grepRequest, grepText, type GrepCall, type GrepSearch } from './appsGrep'
import { APPS_MAX_FILE_BYTES, type AppsTree } from './appsTool'
import { grepFiles } from './grepMatch'
import { appsArgs as args, fileTree as file, folderTree as folder, grepResult, MISSING_TREE as MISSING, refusal, textBytes } from './testing'

// `apps grep`: the checks of a call, the files that it searches, and the
// texts that the calling model reads. The matching itself has its own
// tests (grepMatch.test.ts).

const call = (parameters: Record<string, unknown>): GrepCall => grepCall(args('grep', parameters))
const rule = (parameters: Record<string, unknown>): RegExp => call(parameters).regExp

// The plan of a call with `parameters` on a path with the listing `tree`,
// which must search files.
function search(parameters: Record<string, unknown>, tree: AppsTree): GrepSearch {
  const plan = grepPlan(call(parameters), tree)
  if (plan.kind !== 'search') throw new Error(`The call searches nothing: ${plan.text}`)
  return plan
}

describe('grepCall', () => {
  it('reads a pattern by Unicode characters, and one that only the old rules take as grep does', () => {
    expect(rule({ pattern: '^.$' }).test('😀')).toBe(true)
    expect(rule({ pattern: 'a\\-b' }).test('a-b')).toBe(true)
    expect(rule({ pattern: 'x{' }).test('x{')).toBe(true)
    expect(rule({ pattern: 'say \\"hi\\"' }).test('say "hi"')).toBe(true)
  })

  it('finds a literal pattern as plain text, and a pattern in any case', () => {
    expect(rule({ pattern: 'a.b(', literal: true }).test('x a.b(1)')).toBe(true)
    expect(rule({ pattern: 'a.b(', literal: true }).test('axb(')).toBe(false)
    expect(rule({ pattern: 'FOO', ignore_case: true }).test('foo')).toBe(true)
    expect(rule({ pattern: 'A-B', literal: true, ignore_case: true }).test('a-b')).toBe(true)
  })

  it('refuses a pattern that is empty, that no line can match, or that is no regular expression', () => {
    expect(refusal(() => call({ pattern: '' })))
      .toBe('`pattern` is empty. Give the regular expression to find, as in "convert(Length|Weight)". To see a whole file, call read.')
    expect(refusal(() => call({ pattern: 'a\nb' }))).toBe('`pattern` holds a line break, and grep matches each line by itself, so no line holds one. Search for a part of one line.')
    expect(refusal(() => call({ pattern: 'f(' }))).toMatch(new RegExp('^`pattern` is no regular expression that JavaScript takes\\. '
      + 'Put a "\\\\" before a special character to find the character itself, or set `literal` to true to find the pattern as plain text\\.\n\nDetails: .*f\\('))
  })

  it('takes 0 to 10 lines of context', () => {
    expect(call({ pattern: 'a', context: 10 }).context).toBe(10)
    expect(refusal(() => call({ pattern: 'a', context: 11 })))
      .toBe('`context` is 11, and it is from 0 to 10. To see more lines around a match, call read with a range of lines.')
    expect(refusal(() => call({ pattern: 'a', context: -1 }))).toContain('`context` is -1')
  })

  it('refuses an `include` that is empty or that names a folder', () => {
    expect(refusal(() => call({ pattern: 'a', include: ' ' }))).toBe('`include` is empty. Leave it out to search every file, or give a glob of the names of the files, as in "*.js".')
    expect(refusal(() => call({ pattern: 'a', include: 'src/*.js' }))).toBe('`include` holds "/", and it matches only the name of a file. '
      + 'Give the folder in `path` and a glob of names in `include`, as in {"path": "/apps/unit-converter/src", "include": "*.js"}.')
  })
})

describe('grepPlan', () => {
  it('searches the files below a folder by path, and skips those that it does not read', () => {
    const plan = search({ pattern: 'a', path: '/apps/notes' }, folder({
      'b.js': 10,
      'a.js': 10,
      src: null,
      'src/c.js': 3,
      'big.txt': APPS_MAX_FILE_BYTES + 1,
      link: 'other',
      'bad name.js': 5,
    }))

    expect(plan.files.map(({ path, shown }) => [path.virtual, shown])).toStrictEqual([
      ['/apps/notes/a.js', 'notes/a.js'],
      ['/apps/notes/b.js', 'notes/b.js'],
      ['/apps/notes/src/c.js', 'notes/src/c.js'],
    ])
    expect(plan.skips).toStrictEqual({ other: 1, large: 1, badNames: 1, overBudget: 0 })
  })

  it('takes only the files whose name matches the glob of `include`', () => {
    const tree = folder({ 'a.ts': 1, 'b.css': 1, 'c.js': 1, 'a.tsx': 1, 'B.TS': 1, 'src/d.ts': 1, 'ts/e.js': 1, 'f.js': 1, 'ab.js': 1 })
    const shown = (include: string) => search({ pattern: 'a', include }, tree).files.map((entry) => entry.shown)

    expect(shown('*.{ts,css}')).toStrictEqual(['a.ts', 'b.css', 'src/d.ts'])
    expect(shown('?.js')).toStrictEqual(['c.js', 'f.js', 'ts/e.js'])
  })

  it('reads at most the bytes of 16 files of the largest size in one call', () => {
    const plan = search({ pattern: 'a' }, folder(Object.fromEntries(Array.from({ length: 17 }, (_, index) => [`app/f${index + 10}.txt`, APPS_MAX_FILE_BYTES]))))

    expect(plan.files).toHaveLength(16)
    expect(plan.skips.overBudget).toBe(1)
  })

  it('tells what is at a path that has no file to search', () => {
    const text = (parameters: Record<string, unknown>, tree: AppsTree) => {
      const plan = grepPlan(call({ pattern: 'a', ...parameters }), tree)
      return plan.kind === 'text' ? plan.text : plan
    }

    expect(text({}, MISSING)).toBe('There are no apps yet. Make one with init.')
    expect(text({}, folder())).toBe('There are no apps yet. Make one with init.')
    expect(text({ path: '/apps/notes' }, folder({ data: null }))).toBe('/apps/notes has no files.')
    expect(text({ path: '/apps/notes', include: '*.ts' }, folder({ 'a.js': 1, 'b.js': 2 }))).toBe('No file in /apps/notes has a name that matches "*.ts" (2 files).')
    expect(refusal(() => text({ path: '/apps/todo' }, MISSING))).toBe('There is no app /apps/todo. Call list_apps to see the apps that are there.')
    expect(refusal(() => text({ path: '/apps/notes/src' }, MISSING))).toBe('There is no file or folder /apps/notes/src. Call ls with "/apps/notes" to see what is there.')
  })

  it('searches one file, and refuses one that the tool does not read', () => {
    expect(search({ pattern: 'a', path: '/apps/notes/main.js', include: '*.ts' }, file(12)).files.map((entry) => entry.shown)).toStrictEqual(['/apps/notes/main.js'])
    expect(refusal(() => grepPlan(call({ pattern: 'a', path: '/apps/notes/big.txt' }), file(APPS_MAX_FILE_BYTES + 1)))).toContain('a file of at most')
    expect(refusal(() => grepPlan(call({ pattern: 'a', path: '/apps/notes/link' }), { kind: 'other', size: 0, entries: [], more: false })))
      .toContain('the apps tool opens plain files only')
  })
})

describe('grepText', () => {
  it('gives the matching lines of each file under its path after /apps/, with the lines around them', () => {
    expect(grepResult({ pattern: 'unit', path: '/apps/notes', context: 1 }, {
      'main.js': 'import units\nconst a = 1\nconst b = 2\nconst c = 3\nunit()\n',
      'src/a.js': 'no\nunits\n',
      'b.css': 'none',
    })).toBe([
      '/apps/notes: 3 lines in 2 of 3 files match "unit" (paths after /apps/), by path.',
      '',
      'notes/main.js',
      '1: import units',
      '2- const a = 1',
      '--',
      '4- const c = 3',
      '5: unit()',
      '',
      'notes/src/a.js',
      '1- no',
      '2: units',
    ].join('\n'))
  })

  it('tells the matching lines that it does not show, by file', () => {
    const result = grepResult({ pattern: 'x', path: '/apps/notes' }, { 'main.js': 'x\n'.repeat(205), 'other.js': 'x\nx\nx\n' })

    expect(result.startsWith('/apps/notes: 208 lines in 2 of 2 files match "x" (paths after /apps/), by path.\n\nnotes/main.js\n1: x\n')).toBe(true)
    expect(result).not.toContain('notes/other.js\n')
    expect(result.endsWith('200: x\n\nNot shown: 8 more matching lines, in notes/main.js (5), notes/other.js (3). '
      + 'Make the pattern narrower, or give a folder or a file in `path`, or a glob in `include`, to see them.')).toBe(true)
  })

  it('tells the files that it did not search, and a line that it cut', () => {
    expect(grepResult({ pattern: 'a.b', literal: true, ignore_case: true }, {
      'notes/main.js': 'none',
      'notes/data.bin': new Uint8Array([0x61, 0]),
      'notes/big.txt': new Uint8Array(APPS_MAX_FILE_BYTES + 1),
    })).toBe('No line in /apps matches the text "a.b" in any case (1 file searched).\n\nNot searched: 1 file that is no text, 1 file of more than 2.0 MB.')
    expect(grepResult({ pattern: 'b' }, { 'notes/min.js': `${'a'.repeat(500)}b` }).endsWith('\n\nA row shows at most 300 characters of its line, and "…" marks a cut: read gives the whole line.'))
      .toBe(true)
  })

  it('searches one file with no path line, and refuses one that is no text', () => {
    const fileCall = call({ pattern: 'b', path: '/apps/notes/main.js' })
    const plan = search({ pattern: 'b', path: '/apps/notes/main.js' }, file(6))
    const text = (bytes: Uint8Array) => grepText(fileCall, plan, grepFiles(grepRequest(fileCall, plan.files, [bytes])))

    expect(text(textBytes('a\nb\nb\n'))).toBe('/apps/notes/main.js: 2 lines match "b".\n2: b\n3: b')
    expect(text(textBytes('a\n'))).toBe('No line of /apps/notes/main.js matches "b".')
    expect(refusal(() => text(new Uint8Array([0x62, 0]))))
      .toBe('/apps/notes/main.js is no text file (it holds a zero byte, or bytes that are no UTF-8), and grep searches text files only.')
  })

  it('tells the lines that took too long to match, as they can match', () => {
    const parameters = { pattern: '(a+)+$', path: '/apps/notes' }
    const plan = search(parameters, folder({ 'a.txt': 3, 'b.txt': 3 }))
    const slowLines = Array.from({ length: 12 }, (_, index) => ({ path: 'notes/a.txt', line: index + 1 }))
    const why = 'The engine of regular expressions gives up on a line that takes too long, as if the line did not match. '
      + 'A repeat in a repeat, as "(a+)+", or ".*" at the start of a pattern, can take very long on some lines. Make the pattern simpler, or read these lines.'

    expect(grepText(call(parameters), plan, { files: [], searched: 2, notText: 0, cutLines: false, slowLines })).toBe('No line in /apps/notes matches "(a+)+$" (2 files searched).\n\n'
      + `Not sure: 12 lines took too long to match, and they can match: ${slowLines.slice(0, 10).map(({ line }) => `notes/a.txt:${line}`).join(', ')}, and 2 more. ${why}`)

    const fileParameters = { pattern: '(a+)+$', path: '/apps/notes/a.txt' }
    const filePlan = search(fileParameters, file(3))
    const slowText = (lines: number[]) => grepText(call(fileParameters), filePlan, {
      files: [], searched: 1, notText: 0, cutLines: false, slowLines: lines.map((line) => ({ path: '/apps/notes/a.txt', line })),
    })
    expect(slowText([4])).toBe(`No line of /apps/notes/a.txt matches "(a+)+$".\n\nNot sure: 1 line took too long to match, and it can match: line 4. ${why}`)
    expect(slowText([4, 9])).toBe(`No line of /apps/notes/a.txt matches "(a+)+$".\n\nNot sure: 2 lines took too long to match, and they can match: lines 4, 9. ${why}`)
  })
})
