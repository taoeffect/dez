import fontsManifest from '../../../src-tauri/fonts/manifest.json'
import { unknownValuesText } from './arguments'
import { tellUserConsole } from './programRuns'
import { ToolError, type ToolArguments } from './types'

// The fonts of the text that an ffmpeg run of the `video` tool draws
// (videoTool.ts). The ffmpeg that Dez ships has no fontconfig, so a run
// sees no font of the system: only the fonts that Dez ships
// (src-tauri/fonts/, a resource of the bundle). A call names the fonts
// that it needs in its `fonts` parameter, and its run gets a copy of each
// one in the subfolder `fonts` of its work folder (controller/videoTool.ts).
//
// The checks of a call (`fontProblem`) refuse a font option that names
// another font or another folder before the run: drawtext fails with no
// font, and libass (the `subtitles` and `ass` filters) draws no text, with
// no error, when its folder has no font of the style's family.

/** A font that Dez ships, from src-tauri/fonts/manifest.json. */
export interface ShippedFont {
  /** The name of its file, in the fonts folder of the bundle and of a run. */
  file: string
  /** Its family (name ID 1), which a subtitle style names. */
  family: string
  /** The scripts that it draws. */
  scripts: string
}

/** The fonts that Dez ships, in the order of the manifest. */
export const SHIPPED_FONTS: readonly ShippedFont[] = Object.entries(fontsManifest.fonts)
  .map(([file, { family, scripts }]) => ({ file, family, scripts }))

/** The folder of the fonts: in the resource folder of the bundle, and in
 *  the work folder of a run. */
export const FONT_FOLDER = 'fonts'

const SHIPPED_NAMES = SHIPPED_FONTS.map(({ file }) => file).join(', ')

/** The fonts that Dez ships, for the help: each family, with its files and
 *  its scripts. A constant of the build, so the help keeps its bytes. */
export const SHIPPED_FONTS_TEXT = [...new Set(SHIPPED_FONTS.map(({ family }) => family))]
  .map((family) => {
    const fonts = SHIPPED_FONTS.filter((font) => font.family === family)
    return `"${family}" (${fonts.map(({ file }) => file).join(', ')}) for ${fonts[0].scripts}`
  })
  .join('; ')

/** The fonts that the `fonts` argument of an ffmpeg call names, each one
 *  once, in the order of the call. The names are separated by white space
 *  or commas, as the ids of `clips`. Throws a `ToolError` for a name of no
 *  font that Dez ships; `notDone` tells what Dez did not do. */
export function fontsArgument(args: ToolArguments, notDone: string): string[] {
  const value = typeof args.fonts === 'string' ? args.fonts : ''
  const names = [...new Set(value.split(/[\s,]+/).filter((name) => name !== ''))]
  const unknown = names.filter((name) => !SHIPPED_FONTS.some(({ file }) => file === name))
  if (unknown.length > 0) {
    throw new ToolError(`${unknownValuesText('fonts', unknown, `the file names, with no folder, of the fonts that Dez ships: ${SHIPPED_NAMES}`)} ${notDone}`)
  }
  return names
}

/** The text of a run whose font Dez cannot find in its own install. */
export function fontNotFoundText(file: string, tool: string): string {
  return `Dez cannot find the font ${file}, which it ships with the app, so it did not run ffmpeg. The install of Dez lacks its fonts. ${tellUserConsole(tool)}`
}

// The chars of a name in an ffmpeg argument, as the inside of a character
// class (as in videoTool.ts).
const NAME_CHARS = 'A-Za-z0-9_'
// The end of a value of a filter's options: a separator of the options, or
// of the filter graph.
const VALUE_CHARS = String.raw`[^:,;[\]]`
// A file of the fonts folder, as `fonts/<file>`: at the start of the word
// or of a value, or after a `/` (`./fonts/x`). A name char, a `.`, or a `-`
// before it makes another folder (`my-fonts/x`). The case of the folder
// does not count here, so that a check can tell the right case: on Linux,
// `Fonts/` names no folder of the run.
const FONT_PATH = new RegExp(String.raw`(?:^|[^${NAME_CHARS}.-])(fonts)/([A-Za-z0-9._-]*)`, 'gi')
// The font of drawtext: the value of a `fontfile` key, or the first value
// with no key of drawtext, as `fontfile` is its first option. The filter
// can have an instance name (`drawtext@a=…`). A filter takes values with no
// key only before its first key, so a first value with a `=` is a key.
const FONT_FILE_VALUE = new RegExp(
  String.raw`(?:^|[^${NAME_CHARS}])fontfile\s*=(${VALUE_CHARS}*)`
    + String.raw`|(?:^|[^${NAME_CHARS}])drawtext(?:@[^=,;[]*)?\s*=([^:=,;[\]]*)(?=$|[:,;[\]])`,
  'gi',
)
// The fonts folder of libass: the value of a `fontsdir` key, or the third
// value with no key of `subtitles` or `ass` (after the file name and
// `original_size`).
const FONTS_DIR_VALUE = new RegExp(
  String.raw`(?:^|[^${NAME_CHARS}])fontsdir\s*=(${VALUE_CHARS}*)`
    + String.raw`|(?:^|[^${NAME_CHARS}])(?:subtitles|ass)(?:@[^=,;[]*)?\s*=[^:=,;[\]]*:[^:=,;[\]]*:([^:=,;[\]]*)(?=$|[:,;[\]])`,
  'gi',
)
// The forms of a font value that name the fonts folder of the run, and its
// files. The option parser of ffmpeg drops quotes and trims white space.
const FONT_FILE_FORM = new RegExp(String.raw`^(?:\./)?${FONT_FOLDER}/(.+)$`)
const FONTS_DIR_FORM = new RegExp(String.raw`^(?:\./)?${FONT_FOLDER}/?$`)

const ADD_TO_FONTS = 'Add it to the `fonts` parameter of the ffmpeg subcommand, so that the fonts folder of the run gets a copy of it.'

// Why Dez refuses a word that names the font file `file` of the fonts
// folder; null for a font that the run gets.
function fontFileProblem(file: string, fonts: readonly string[]): string | null {
  if (!SHIPPED_FONTS.some((font) => font.file === file)) {
    return `it names ${JSON.stringify(file)} in the fonts folder, and Dez ships no font with that name. The fonts that Dez ships: ${SHIPPED_NAMES}.`
  }
  if (!fonts.includes(file)) return `it names the font ${file}, but \`fonts\` does not name it. ${ADD_TO_FONTS}`
  return null
}

/** Why Dez refuses a word of an ffmpeg or ffprobe command line for its
 *  fonts; null for a word that can go. `forms` are the forms of the word
 *  that the argument checks of videoTool.ts read (the word, without its
 *  quotes, and as the filter graph parser gives it), and `fonts` are the
 *  fonts of the run (none for ffprobe). The text starts with "it", for the
 *  refusal text of the word. */
export function fontProblem(forms: readonly string[], fonts: readonly string[]): string | null {
  const values = (pattern: RegExp) => forms.flatMap((form) => [...form.matchAll(pattern)].map((match) => (match[1] ?? match[2]).replaceAll('\'', '').trim()))

  for (const value of values(FONT_FILE_VALUE)) {
    const file = FONT_FILE_FORM.exec(value)?.[1]
    if (file === undefined) {
      return 'its font is no file of the fonts folder. This ffmpeg has no font of the system: drawtext reads a font only from the fonts folder of the run. '
        + `Give the font as fontfile=fonts/<file>, and the file in \`fonts\`. The fonts that Dez ships: ${SHIPPED_NAMES}.`
    }
    const problem = fontFileProblem(file, fonts)
    if (problem !== null) return problem
  }
  for (const value of values(FONTS_DIR_VALUE)) {
    // libass reads every file of its folder, and the work folder holds the
    // clips of the run.
    if (!FONTS_DIR_FORM.test(value)) {
      return 'its fonts folder is not the fonts folder of the run. libass reads every file of its folder: give fontsdir=fonts, and the fonts of the text in `fonts`.'
    }
    if (fonts.length === 0) {
      return 'it names the fonts folder, but `fonts` names no font, so the folder has none. Add the fonts of the text to the `fonts` parameter of the ffmpeg subcommand.'
    }
  }
  for (const form of forms) {
    for (const [, folder, file] of form.matchAll(FONT_PATH)) {
      if (folder !== FONT_FOLDER) return `it writes the fonts folder as "${folder}/". Write it as fonts/, in lower case.`
      const problem = file === '' ? null : fontFileProblem(file, fonts)
      if (problem !== null) return problem
    }
  }
  return null
}
