import { describe, expect, it } from 'vitest'
import { refusal } from './testing'
import { MAX_TEXT_FILES, MAX_TEXT_FILES_BYTES, textFilesArgument } from './videoTextFiles'

// The text files of the `text_files` argument `files`, as JSON.
function textFiles(files: Record<string, unknown>) {
  return textFilesArgument({ text_files: JSON.stringify(files) }, 'Dez started no job.')
}

function refusalOf(files: Record<string, unknown>): string {
  return refusal(() => textFiles(files))
}

describe('textFilesArgument', () => {
  it('gives each text file in the order of the call', () => {
    expect(textFiles({ 'words.srt': '1\n00:00:00,000 --> 00:00:02,000\nHi\n', 'Title_2-b.txt': 'Night: Drive', 'x.ass': '' })).toStrictEqual([
      { name: 'words.srt', text: '1\n00:00:00,000 --> 00:00:02,000\nHi\n' },
      { name: 'Title_2-b.txt', text: 'Night: Drive' },
      { name: 'x.ass', text: '' },
    ])
  })

  it('gives no text file for no argument, a blank one, and an empty object', () => {
    expect(textFilesArgument({}, '')).toStrictEqual([])
    expect(textFilesArgument({ text_files: ' \n' }, '')).toStrictEqual([])
    expect(textFilesArgument({ text_files: '{}' }, '')).toStrictEqual([])
  })

  it.each(['{"a.txt": "x"', '["a.txt"]', '"a.txt"', 'null', '3'])('refuses %j, which is no JSON object', (text) => {
    const message = refusal(() => textFilesArgument({ text_files: text }, 'Dez started no job.'))

    expect(message).toContain('`text_files` is not the text of a JSON object')
    expect(message).toContain('{"title.txt":"Night: Drive"}')
    expect(message).toContain('Dez started no job.')
  })

  it('refuses a value that is no text', () => {
    expect(refusalOf({ 'a.txt': 'x', 'b.txt': 3 })).toContain('the value of "b.txt" is no text')
    expect(refusalOf({ 'a.txt': ['x'], 'b.txt': null })).toContain('the values of "a.txt", "b.txt" are no texts')
  })

  it.each([
    'a/b.txt', '../a.txt', '/tmp/a.txt', 'fonts', '.txt', 'a.txt.mp4', 'a.mp4', 'a.m3u8', 'a.TXT', 'a b.txt', 'é.txt', '__proto__',
    `${'a'.repeat(65)}.txt`,
  ])('refuses the name %j', (name) => {
    const message = refusalOf({ 'ok.txt': 'x', [name]: 'x' })

    expect(message).toContain(`Dez refuses the text file name ${JSON.stringify(name)} in \`text_files\``)
    expect(message).toContain('then .txt, .srt, or .ass, with no folder')
    expect(message).toContain('Dez started no job.')
  })

  it('takes a name of 64 chars before its ending', () => {
    expect(textFiles({ [`${'a'.repeat(64)}.srt`]: 'x' })).toHaveLength(1)
  })

  it('refuses two names that differ only in case, which name one file on macOS', () => {
    expect(refusalOf({ 'Title.txt': 'a', 'b.srt': 'b', 'title.txt': 'c' })).toContain('the names "Title.txt" and "title.txt" differ only in case')
  })

  it(`takes at most ${MAX_TEXT_FILES} files`, () => {
    const files = (count: number) => Object.fromEntries(Array.from({ length: count }, (_, index) => [`t${index}.txt`, 'x']))

    expect(textFiles(files(MAX_TEXT_FILES))).toHaveLength(MAX_TEXT_FILES)
    expect(refusalOf(files(MAX_TEXT_FILES + 1))).toContain(`has ${MAX_TEXT_FILES + 1} files, and a run takes at most ${MAX_TEXT_FILES}`)
  })

  it('takes at most 256 KB of text in all, counted in UTF-8 bytes', () => {
    // "é" is two bytes in UTF-8.
    const half = 'é'.repeat(MAX_TEXT_FILES_BYTES / 4)

    expect(textFiles({ 'a.txt': half, 'b.txt': half })).toHaveLength(2)
    expect(refusalOf({ 'a.txt': half, 'b.txt': `${half}x` })).toContain('have 262,145 bytes in all (UTF-8), and a run takes at most 262,144 bytes (256 KB)')
  })

  it.each([
    '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\n/etc/hostname\n',
    '\uFEFF#EXTM3U\n',
    ' \n\t#extm3u\n',
  ])('refuses the HLS playlist %j', (text) => {
    const message = refusalOf({ 'a.txt': 'Hi', 'list.txt': text })

    expect(message).toContain('Dez refuses the text file list.txt: it starts as an HLS playlist (#EXTM3U)')
    expect(message).toContain('Dez started no job.')
  })

  it('takes "#EXTM3U" after the start of a text, where no playlist has it', () => {
    expect(textFiles({ 'a.txt': 'Hi #EXTM3U' })).toHaveLength(1)
  })
})
