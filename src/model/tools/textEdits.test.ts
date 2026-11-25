import { describe, expect, it } from 'vitest'
import { planTextEdits, type TextEdit } from './textEdits'

// An edit of `oldString` to `newString`, with `replaceAll` as given.
const edit = (oldString: string, newString: string, replaceAll = false): TextEdit => ({ oldString, newString, replaceAll })

// The texts of the outcomes of `edits` on `text`.
function outcomes(text: string, edits: readonly TextEdit[]): string[] {
  return planTextEdits(text, edits).outcomes.map((outcome) => `${outcome.done ? 'done' : 'failed'}: ${outcome.text}`)
}

const NO_MATCH = '`old_string` is not in the file. Read the file again, and give the text as it is in the file, with its white space and its line ends, '
  + 'but without the `12: ` before each line of a read result: that number is no part of the file.'
const MANY_ADVICE = 'Give more of the text around the place to change, so that `old_string` is in the file once, or set `replace_all` to true to change every place.'

describe('planTextEdits', () => {
  it('applies the edits in the order of the call, each to the text that the edits before it left', () => {
    const plan = planTextEdits('let a = 1\nlet b = 2\n', [edit('a = 1', 'a = 10'), edit('a = 10\nlet b', 'a = 10\nconst b')])

    expect(plan).toStrictEqual({
      outcomes: [{ done: true, text: 'Replaced the text at line 1.' }, { done: true, text: 'Replaced the text at line 1.' }],
      text: 'let a = 10\nconst b = 2\n',
      changed: true,
    })
  })

  it('does the edits that pass when others fail', () => {
    const plan = planTextEdits('one\ntwo\nthree\n', [edit('two', 'TWO'), edit('four', 'FOUR'), edit('three', '')])

    expect(plan.outcomes.map((outcome) => outcome.done)).toStrictEqual([true, false, true])
    expect(plan.text).toBe('one\nTWO\n\n')
  })

  it('fails an empty old_string', () => {
    expect(outcomes('a\n', [edit('', 'b')])).toStrictEqual([
      'failed: `old_string` is empty. Give the text to replace; to make a new file, or to give a file all new text, use write.',
    ])
  })

  it('fails text that is not in the file, and tells when the edits before it changed the file', () => {
    expect(outcomes('alpha\n', [edit('alpah', 'beta')])).toStrictEqual([`failed: ${NO_MATCH}`])
    // The match is exact: white space counts.
    expect(outcomes('  alpha\n', [edit('\talpha', 'beta')])).toStrictEqual([`failed: ${NO_MATCH}`])
    expect(outcomes('alpha\n', [edit('alpha', 'beta'), edit('alpha', 'gamma')])[1]).toBe('failed: `old_string` is not in the file. '
      + 'The edits before this one changed the file first, and this edit looked for its text in what they left. '
      + 'Read the file again, and give the text as it is in the file, with its white space and its line ends, '
      + 'but without the `12: ` before each line of a read result: that number is no part of the file.')
  })

  it('does an edit whose new text is its old text, and changes nothing', () => {
    expect(planTextEdits('a\na\n', [edit('a', 'a')])).toStrictEqual({
      outcomes: [{ done: true, text: 'No change: `new_string` is the same as `old_string`.' }],
      text: 'a\na\n',
      changed: false,
    })
  })

  it('fails text that is at more than one place, with the lines of the first 5', () => {
    expect(outcomes('x = 1\ny = 2\nx = 3\n', [edit('x =', 'z =')])).toStrictEqual([`failed: \`old_string\` is in the file at 2 places, on lines 1 and 3. ${MANY_ADVICE}`])
    expect(outcomes('xx\nx\n', [edit('x', 'z')])).toStrictEqual([`failed: \`old_string\` is in the file at 3 places, on lines 1 and 2. ${MANY_ADVICE}`])
    // Places that overlap count: `}\n}` is at offsets 0 and 2.
    expect(outcomes('}\n}\n}\n', [edit('}\n}', '}')])).toStrictEqual([`failed: \`old_string\` is in the file at 2 places, on lines 1 and 2. ${MANY_ADVICE}`])
    expect(outcomes('x\n'.repeat(12), [edit('x', 'z')])).toStrictEqual([
      `failed: \`old_string\` is in the file at 12 places, the first 5 on lines 1, 2, 3, 4, and 5. ${MANY_ADVICE}`,
    ])
  })

  it('replaces every place with replace_all, left to right and with no overlap', () => {
    const plan = planTextEdits('aaa\nb aa\n', [edit('aa', 'x', true)])

    expect(plan.text).toBe('xa\nb x\n')
    expect(plan.outcomes).toStrictEqual([{ done: true, text: 'Replaced the text at 2 places, on lines 1 and 2.' }])
    expect(planTextEdits('feet\n'.repeat(7), [edit('feet', 'ft', true)]).outcomes[0].text).toBe('Replaced the text at 7 places, the first 5 on lines 1, 2, 3, 4, and 5.')
    expect(planTextEdits('a b\n', [edit('a', '', true)]).outcomes[0].text).toBe('Deleted the text at line 1.')
  })

  it('puts the new text in as it is, with no replacement patterns', () => {
    expect(planTextEdits('cost\n', [edit('cost', '$& $1 $$')]).text).toBe('$& $1 $$\n')
  })

  it('tells the lines of the file after all the edits', () => {
    const plan = planTextEdits('a\nb\nc\nd\n', [edit('c', 'C'), edit('a\n', 'a\n1\n2\n'), edit('b\n', ''), edit('d', 'x\nD')])

    expect(plan.text).toBe('a\n1\n2\nC\nx\nD\n')
    expect(plan.outcomes.map((outcome) => outcome.text)).toStrictEqual([
      'Replaced the text at line 4.',
      'Replaced the text at line 1.',
      'Deleted the text at line 4.',
      'Replaced the text at line 5.',
    ])
    // A place that a later edit replaces goes to the start of its new text.
    expect(planTextEdits('x\none two\n', [edit('two', '2'), edit('x\none 2', 'X')]).outcomes.map((outcome) => outcome.text))
      .toStrictEqual(['Replaced the text at line 1.', 'Replaced the text at line 1.'])
    // The places of an edit that failed move too.
    expect(outcomes('top\nx\nx\n', [edit('x', 'y'), edit('top', 'top\n\n')])[0]).toBe(`failed: \`old_string\` is in the file at 2 places, on lines 4 and 5. ${MANY_ADVICE}`)
  })

  it('matches the \\n of an edit to the \\r\\n of a Windows file, and writes \\r\\n', () => {
    const plan = planTextEdits('one\r\ntwo\r\nthree\r\n', [edit('one\ntwo', 'one\nTWO\n2')])

    expect(plan.text).toBe('one\r\nTWO\r\n2\r\nthree\r\n')
    expect(plan.outcomes).toStrictEqual([{ done: true, text: 'Replaced the text at line 1.' }])
    // An exact match comes first, and a file with no \r\n gets none.
    expect(planTextEdits('a\nb\r\n', [edit('a\nb', 'A\nB')]).text).toBe('A\nB\r\n')
    expect(planTextEdits('a\nb\n', [edit('a\nb', 'A\nB')]).text).toBe('A\nB\n')
  })

  it('writes \\r\\n for each \\n of the new text in a file whose line ends are all \\r\\n', () => {
    expect(planTextEdits('a\r\nb\r\n', [edit('a', 'A\n1')]).text).toBe('A\r\n1\r\nb\r\n')
    expect(planTextEdits('a\r\nb\r\n', [edit('a', 'A\r\n1\n2')]).text).toBe('A\r\n1\r\n2\r\nb\r\n')
    // A place that starts with \n comes after the \r of its line end, which
    // stays: the \n at the start of the new text ends that line.
    expect(planTextEdits('a\r\nb\r\n', [edit('\nb', '\nB\n2')]).text).toBe('a\r\nB\r\n2\r\n')
  })

  it('keeps a byte order mark', () => {
    expect(planTextEdits('\uFEFFconst a = 1\n', [edit('const a = 1', 'const a = 2')]).text).toBe('\uFEFFconst a = 2\n')
  })

  it('tells that the text did not change when the edits put it back', () => {
    expect(planTextEdits('a\n', [edit('a', 'b'), edit('b', 'a')]).changed).toBe(false)
  })
})
