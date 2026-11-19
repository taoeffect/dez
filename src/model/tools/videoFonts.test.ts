import { describe, expect, it } from 'vitest'
import { refusal } from './testing'
import { fontProblem, fontsArgument, SHIPPED_FONTS, SHIPPED_FONTS_TEXT } from './videoFonts'

const FONTS = ['NotoSans-Bold.ttf', 'NotoSansArabic-Regular.ttf']

describe('the shipped fonts', () => {
  it('tell the help each file with its family, which a subtitle style names', () => {
    for (const { file, family } of SHIPPED_FONTS) {
      expect(SHIPPED_FONTS_TEXT).toContain(file)
      expect(SHIPPED_FONTS_TEXT).toContain(`"${family}"`)
    }
  })
})

describe('fontsArgument', () => {
  it('gives each named font once, in the order of the call', () => {
    expect(fontsArgument({ fonts: ' NotoSans-Bold.ttf,NotoSansArabic-Regular.ttf  NotoSans-Bold.ttf\n' }, '')).toStrictEqual(FONTS)
    expect(fontsArgument({}, '')).toStrictEqual([])
  })

  it('refuses a name of no shipped font, a name with a folder, and a name in another case, and lists the shipped names', () => {
    const message = refusal(() => fontsArgument({ fonts: 'NotoSans-Bold.ttf Arial.ttf fonts/NotoSans-Bold.ttf notosans-bold.ttf' }, 'Dez started no job.'))

    expect(message).toContain('Unknown values "Arial.ttf", "fonts/NotoSans-Bold.ttf", "notosans-bold.ttf" in `fonts`')
    for (const { file } of SHIPPED_FONTS) expect(message).toContain(file)
    expect(message).toContain('Dez started no job.')
  })
})

describe('fontProblem', () => {
  it.each([
    'drawtext=fontfile=fonts/NotoSans-Bold.ttf:text=Hi',
    // fontfile is the first option of drawtext.
    'drawtext=fonts/NotoSans-Bold.ttf:text=Hi',
    '[0:v]drawtext@title=./fonts/NotoSansArabic-Regular.ttf:text=Hi[v]',
    'drawtext=text=Hi:fontfile= fonts/NotoSans-Bold.ttf :fontsize=40',
    'drawtext=fontfile=fonts/NotoSans-Bold.ttf,drawtext=fontfile=fonts/NotoSansArabic-Regular.ttf',
    'subtitles=c.mkv:fontsdir=fonts',
    // fontsdir is the third option of subtitles and ass.
    'subtitles=c.mkv:640x360:fonts/',
    'ass@a=c.ass::./fonts:shaping=complex',
    // Filters whose names end in "ass".
    'bass=g=3,highpass=f=200',
    'myfonts/NotoSans-Regular.ttf',
    'scale=640:-2',
  ])('lets %j go', (word) => {
    expect(fontProblem([word], FONTS)).toBeNull()
  })

  it.each([
    ['drawtext=fontfile=fonts/NotoSans-Regular.ttf:text=Hi', 'Add it to the `fonts` parameter of the ffmpeg subcommand'],
    ['movie=fonts/NotoSans-Regular.ttf', 'Add it to the `fonts` parameter of the ffmpeg subcommand'],
    ['drawtext=NotoSans-Bold.ttf:text=Hi', 'Give the font as fontfile=fonts/<file>'],
    ['drawtext=FontFile=Arial', 'Give the font as fontfile=fonts/<file>'],
    ['drawtext=text=Hi:fontfile=c.webm', 'Give the font as fontfile=fonts/<file>'],
    ['drawtext=fontfile=fonts/Arial.ttf', 'it names "Arial.ttf" in the fonts folder, and Dez ships no font with that name'],
    ['drawtext=fontfile=fonts/sub/NotoSans-Bold.ttf', 'it names "sub/NotoSans-Bold.ttf" in the fonts folder'],
    ['fonts/out.mp4', 'it names "out.mp4" in the fonts folder'],
    ['subtitles=c.mkv:fontsdir=.', 'give fontsdir=fonts'],
    ['subtitles=c.mkv:640x360:sub', 'give fontsdir=fonts'],
    ['ass=c.ass:fontsdir=fonts/NotoSans-Bold.ttf', 'give fontsdir=fonts'],
    ['Fonts/NotoSans-Bold.ttf', 'it writes the fonts folder as "Fonts/"'],
  ])('refuses %j', (word, cause) => {
    expect(fontProblem([word], FONTS)).toContain(cause)
  })

  it('refuses the fonts folder of a run with no fonts', () => {
    expect(fontProblem(['subtitles=c.mkv:fontsdir=fonts'], [])).toContain('`fonts` names no font')
    expect(fontProblem(['drawtext=fontfile=fonts/NotoSans-Bold.ttf'], [])).toContain('Add it to the `fonts` parameter')
  })

  it('refuses a font that any form of the word names', () => {
    expect(fontProblem(['scale=640:-2', 'drawtext=fontfile=fonts/NotoSans-Regular.ttf'], FONTS)).toContain('NotoSans-Regular.ttf')
  })
})
