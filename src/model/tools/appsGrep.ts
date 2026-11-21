import { byteSizeText } from '../../utils/byteSize'
import { countOf, countText } from '../../utils/countText'
import { rawErrorText } from '../../utils/errorText'
import { regExpSource } from '../../utils/regExpSource'
import { startOf } from '../../utils/textCut'
import {
  APPS_MAX_FILE_BYTES,
  APPS_VIRTUAL_ROOT,
  checkTextFile,
  cutListingNote,
  folderArgument,
  integerArgument,
  isPathName,
  NO_APPS,
  NO_TEXT,
  noFolderError,
  parentOf,
  pathIn,
  textArgument,
  type AppsPath,
  type AppsTree,
} from './appsTool'
import {
  GREP_LINE_MAX_CHARACTERS,
  GREP_MAX_BYTES,
  GREP_MAX_CONTEXT,
  GREP_TIME_LIMIT_SECONDS,
  grepRowLines,
  type GrepFileMatches,
  type GrepLineRef,
  type GrepOutcome,
  type GrepRequest,
} from './grepMatch'
import { ToolError, type SubcommandArguments } from './types'

// `apps grep`: the lines of the text files of the apps that a regular
// expression matches, as `rg -n` gives them. controller/appsTool.ts lists
// the folder, reads the files that `grepPlan` picks, and runs the matching
// of grepMatch.ts in a Web Worker, with a time limit.
//
// This module has the pure parts: the checks of a call, the files to
// search, and every text that the calling model reads. Every text here is
// a tool result: it goes to the chat provider, and it holds virtual paths
// only.

// The most characters of the pattern that a text of a result quotes.
const SHOWN_PATTERN_MAX_CHARACTERS = 200
// The most files that the note of the matching lines that a result does
// not show names.
const NOT_SHOWN_MAX_FILES = 20
// The most lines that the note of the lines that can match names.
const SLOW_SHOWN_MAX_LINES = 10

const FILE_LIMIT = byteSizeText(APPS_MAX_FILE_BYTES)
const EXAMPLE_PATTERN = 'convert(Length|Weight)'

export interface GrepCall {
  /** The pattern as the call gave it, for the texts. */
  pattern: string
  literal: boolean
  ignoreCase: boolean
  /** The rule that each line is matched against. */
  regExp: RegExp
  /** The folder or the file to search. */
  path: AppsPath
  /** The glob of `include`, and its rule for the name of a file; null for
   *  every file. */
  include: { glob: string, rule: RegExp } | null
  /** How many lines to show before and after each matching line. */
  context: number
}

// The regular expression of `pattern`. The `u` flag comes first: with it a
// character outside the basic plane (an emoji) is one character for `.`.
// A pattern that only the old rules of JavaScript take compiles with
// them: they take what grep and rg take, such as `\-`, `\"`, and a `{`
// that starts no repeat, each as the character itself.
function patternRegExp(pattern: string, literal: boolean, ignoreCase: boolean): RegExp {
  const caseFlag = ignoreCase ? 'i' : ''
  if (literal) return new RegExp(regExpSource(pattern), `u${caseFlag}`)
  try {
    return new RegExp(pattern, `u${caseFlag}`)
  } catch (error) {
    try {
      return new RegExp(pattern, caseFlag)
    } catch {
      throw new ToolError('`pattern` is no regular expression that JavaScript takes. '
        + 'Put a "\\" before a special character to find the character itself, or set `literal` to true to find the pattern as plain text.', rawErrorText(error))
    }
  }
}

// A glob piece with no braces, as the source of a regular expression: `*`
// is any characters, `?` is one character, and every other character is
// itself.
function globPieceSource(piece: string): string {
  return piece.split('*').map((part) => part.split('?').map(regExpSource).join('.')).join('.*')
}

// The rule of the glob of `include` for the name of a file. `{a,b}` is one
// of its texts, as in rg; braces in braces are no part of the rule.
function globRule(glob: string): RegExp {
  const parts = glob.split(/(\{[^{}]*\})/)
  // `split` puts each `{…}` that it found at an odd index.
  const source = parts.map((part, index) => (index % 2 === 1 ? `(?:${part.slice(1, -1).split(',').map(globPieceSource).join('|')})` : globPieceSource(part)))
  return new RegExp(`^${source.join('')}$`, 'u')
}

/** The search of an `apps grep` call, from its checked arguments. Throws a
 *  `ToolError` for a pattern, a glob, or a context that Dez does not take.
 *  It reads no file: `grepPlan` picks the files from a listing. */
export function grepCall(args: SubcommandArguments): GrepCall {
  const pattern = textArgument(args, 'pattern')
  if (pattern === '') throw new ToolError(`\`pattern\` is empty. Give the regular expression to find, as in "${EXAMPLE_PATTERN}". To see a whole file, call read.`)
  if (/[\n\r]/.test(pattern)) {
    throw new ToolError('`pattern` holds a line break, and grep matches each line by itself, so no line holds one. Search for a part of one line.')
  }
  const literal = args.literal === true
  const ignoreCase = args.ignore_case === true

  const context = integerArgument(args, 'context') ?? 0
  if (context < 0 || context > GREP_MAX_CONTEXT) {
    throw new ToolError(`\`context\` is ${context}, and it is from 0 to ${GREP_MAX_CONTEXT}. To see more lines around a match, call read with a range of lines.`)
  }

  let include: GrepCall['include'] = null
  if (args.include !== undefined) {
    const glob = textArgument(args, 'include').trim()
    if (glob === '') throw new ToolError('`include` is empty. Leave it out to search every file, or give a glob of the names of the files, as in "*.js".')
    if (glob.includes('/')) {
      throw new ToolError('`include` holds "/", and it matches only the name of a file. Give the folder in `path` and a glob of names in `include`, '
        + `as in {"path": "${APPS_VIRTUAL_ROOT}/unit-converter/src", "include": "*.js"}.`)
    }
    include = { glob, rule: globRule(glob) }
  }

  return { pattern, literal, ignoreCase, regExp: patternRegExp(pattern, literal, ignoreCase), path: folderArgument(args), include, context }
}

/** One file that a call searches: the path to read, and the path that the
 *  result shows. */
export interface GrepPlanFile {
  path: AppsPath
  shown: string
}

/** How many files below the folder of a call it does not read: links and
 *  special files (`other`), files of more than `APPS_MAX_FILE_BYTES`
 *  (`large`), files whose paths the tool does not take (`badNames`), and
 *  the files after the first `GREP_MAX_BYTES` (`overBudget`). */
export interface GrepSkips {
  other: number
  large: number
  badNames: number
  overBudget: number
}

/** What a call searches: one file (`file`), or the files below a folder,
 *  sorted by path. `more` tells that the listing of the folder holds only a
 *  part of what is below it. */
export interface GrepSearch {
  kind: 'search'
  file: boolean
  files: GrepPlanFile[]
  skips: GrepSkips
  more: boolean
}

/** The files that a call searches, or the text of a call with nothing to
 *  search. */
export type GrepPlan = GrepSearch | { kind: 'text', text: string }

/** The files that `call` searches, from `tree`, the listing of its path
 *  with `LS_MAX_ENTRIES`. Throws a `ToolError` when nothing is at the path,
 *  and for a path of a file that the tool does not read. */
export function grepPlan({ path, include }: GrepCall, tree: AppsTree): GrepPlan {
  const isRoot = path.names.length === 0
  if (tree.kind === 'missing') {
    if (isRoot) return { kind: 'text', text: NO_APPS }
    if (path.names.length === 1) throw noFolderError(path)
    throw new ToolError(`There is no file or folder ${path.virtual}. Call ls with "${parentOf(path).virtual}" to see what is there.`)
  }
  if (tree.kind !== 'folder') {
    checkTextFile(path, tree)
    return { kind: 'search', file: true, files: [{ path, shown: path.virtual }], skips: { other: 0, large: 0, badNames: 0, overBudget: 0 }, more: false }
  }
  if (isRoot && tree.entries.length === 0) return { kind: 'text', text: NO_APPS }

  const cut = tree.more ? cutListingNote('grep') : ''
  const notFolders = tree.entries.filter((entry) => entry.kind !== 'folder')
  if (notFolders.length === 0) return { kind: 'text', text: `${path.virtual} has no files.${cut}` }
  const named = include === null ? notFolders : notFolders.filter((entry) => include.rule.test(entry.path.slice(entry.path.lastIndexOf('/') + 1)))
  if (named.length === 0) {
    return { kind: 'text', text: `No file in ${path.virtual} has a name that matches ${JSON.stringify(include?.glob)} (${countOf(notFolders.length, 'file')}).${cut}` }
  }

  // A shown path is the path after `/apps/`, as in a result of `find`: a
  // list of the files of every app must not keep every app from Delete
  // Unreferenced Apps (appNames.ts).
  const entries = named.map((entry) => ({ entry, shown: [...path.names, entry.path].join('/') })).sort((a, b) => (a.shown < b.shown ? -1 : 1))
  const skips: GrepSkips = { other: 0, large: 0, badNames: 0, overBudget: 0 }
  const files: GrepPlanFile[] = []
  let bytes = 0
  for (const { entry, shown } of entries) {
    const names = entry.path.split('/')
    if (!names.every(isPathName)) skips.badNames += 1
    else if (entry.kind === 'other') skips.other += 1
    else if (entry.size > APPS_MAX_FILE_BYTES) skips.large += 1
    else if (skips.overBudget > 0 || bytes + entry.size > GREP_MAX_BYTES) skips.overBudget += 1
    else {
      bytes += entry.size
      files.push({ path: names.reduce((folder, name) => pathIn(folder, name), path), shown })
    }
  }
  return { kind: 'search', file: false, files, skips, more: tree.more }
}

/** What the worker gets for `call`: `bytes` are those of `files`, in their
 *  order. */
export function grepRequest({ regExp, context }: GrepCall, files: readonly GrepPlanFile[], bytes: readonly Uint8Array[]): GrepRequest {
  return { source: regExp.source, flags: regExp.flags, context, files: files.map(({ shown }, index) => ({ path: shown, bytes: bytes[index] })) }
}

// The pattern of a call, as a text of a result tells it.
function patternText({ pattern, literal, ignoreCase }: GrepCall): string {
  const shown = pattern.length > SHOWN_PATTERN_MAX_CHARACTERS ? `${startOf(pattern, SHOWN_PATTERN_MAX_CHARACTERS)}…` : pattern
  return `${literal ? 'the text ' : ''}${JSON.stringify(shown)}${ignoreCase ? ' in any case' : ''}`
}

// The note of the matching lines that the rows do not show, with the files
// that have them.
function notShownText(files: readonly GrepFileMatches[], isFile: boolean): string {
  const cut = files.filter((file) => file.shown < file.matches)
  if (cut.length === 0) return ''
  const count = countOf(cut.reduce((sum, file) => sum + file.matches - file.shown, 0), 'more matching line')
  if (isFile) return `Not shown: ${count}. Make the pattern narrower, or read the lines of the file.`
  const listed = cut.slice(0, NOT_SHOWN_MAX_FILES).map((file) => `${file.path} (${countText(file.matches - file.shown)})`)
  if (cut.length > NOT_SHOWN_MAX_FILES) listed.push(`and ${countOf(cut.length - NOT_SHOWN_MAX_FILES, 'more file')}`)
  return `Not shown: ${count}, in ${listed.join(', ')}. Make the pattern narrower, or give a folder or a file in \`path\`, or a glob in \`include\`, to see them.`
}

// The note of the files below the folder of a call that it did not search.
function notSearchedText(skips: GrepSkips, notText: number): string {
  const parts = [
    notText === 0 ? '' : `${countOf(notText, 'file')} that ${notText === 1 ? 'is' : 'are'} no text`,
    skips.large === 0 ? '' : `${countOf(skips.large, 'file')} of more than ${FILE_LIMIT}`,
    skips.other === 0 ? '' : `${countText(skips.other)} ${skips.other === 1 ? 'link or special file' : 'links or special files'}`,
    skips.badNames === 0 ? '' : `${countOf(skips.badNames, 'file')} whose ${skips.badNames === 1 ? 'path' : 'paths'} the apps tool does not take`,
    skips.overBudget === 0
      ? ''
      : `${countOf(skips.overBudget, 'file')} after the first ${byteSizeText(GREP_MAX_BYTES)} of files, all that one call reads: search the folders one by one, or give a glob in \`include\``,
  ].filter((part) => part !== '')
  return parts.length === 0 ? '' : `Not searched: ${parts.join(', ')}.`
}

const CUT_LINES = `A row shows at most ${GREP_LINE_MAX_CHARACTERS} characters of its line, and "…" marks a cut: read gives the whole line.`

const SLOW_PATTERNS = 'A repeat in a repeat, as "(a+)+", or ".*" at the start of a pattern, can take very long on some lines.'

// The note of the lines whose test took so long that the engine of the
// webview can have given up on them (`GREP_SLOW_LINE_MS`): a model must not
// take them for lines that do not match.
function slowLinesText(slowLines: readonly GrepLineRef[], isFile: boolean): string {
  if (slowLines.length === 0) return ''
  const listed = slowLines.slice(0, SLOW_SHOWN_MAX_LINES).map(({ path, line }) => (isFile ? `${line}` : `${path}:${line}`))
  if (slowLines.length > SLOW_SHOWN_MAX_LINES) listed.push(`and ${countText(slowLines.length - SLOW_SHOWN_MAX_LINES)} more`)
  const one = slowLines.length === 1
  return `Not sure: ${countOf(slowLines.length, 'line')} took too long to match, and ${one ? 'it' : 'they'} can match: `
    + `${isFile ? (one ? 'line ' : 'lines ') : ''}${listed.join(', ')}. The engine of regular expressions gives up on a line that takes too long, `
    + `as if the line did not match. ${SLOW_PATTERNS} Make the pattern simpler, or read these lines.`
}

/** The result of a `grep` call: the matching lines of each file that has
 *  one, with the lines around them, sorted by path, and notes of what the
 *  rows do not show. `outcome` is what the matching gave for `plan`.
 *  Throws a `ToolError` for a call on one file that is no text. */
export function grepText(call: GrepCall, plan: GrepSearch, outcome: GrepOutcome): string {
  const { path } = call
  const pattern = patternText(call)
  const cutLines = outcome.cutLines ? CUT_LINES : ''
  if (plan.file) {
    if (outcome.notText > 0) throw new ToolError(`${path.virtual} is no text file (${NO_TEXT}), and grep searches text files only.`)
    const slowLines = slowLinesText(outcome.slowLines, true)
    const [found] = outcome.files
    if (found === undefined) return withNotes([`No line of ${path.virtual} matches ${pattern}.`], [slowLines])
    const head = `${path.virtual}: ${countOf(found.matches, 'line')} ${found.matches === 1 ? 'matches' : 'match'} ${pattern}.`
    return withNotes([head, ...grepRowLines(found.rows, call.context)], [slowLines, notShownText(outcome.files, true), cutLines])
  }

  const cut = plan.more ? cutListingNote('grep') : ''
  const slowLines = slowLinesText(outcome.slowLines, false)
  const notSearched = notSearchedText(plan.skips, outcome.notText)
  if (outcome.files.length === 0) {
    return withNotes([`No line in ${path.virtual} matches ${pattern} (${countOf(outcome.searched, 'file')} searched).${cut}`], [slowLines, notSearched])
  }
  const lines = outcome.files.reduce((sum, file) => sum + file.matches, 0)
  const head = `${path.virtual}: ${countOf(lines, 'line')} in ${outcome.files.length} of ${countOf(outcome.searched, 'file')} ${lines === 1 ? 'matches' : 'match'} ${pattern} `
    + `(paths after ${APPS_VIRTUAL_ROOT}/), by path.${cut}`
  const blocks = outcome.files.flatMap((file) => (file.rows.length === 0 ? [] : ['', file.path, ...grepRowLines(file.rows, call.context)]))
  return withNotes([head, ...blocks], [slowLines, notShownText(outcome.files, false), cutLines, notSearched])
}

// The lines of a result, and after an empty line the notes that are not
// empty.
function withNotes(lines: readonly string[], notes: readonly string[]): string {
  const given = notes.filter((note) => note !== '')
  return [...lines, ...(given.length === 0 ? [] : ['', ...given])].join('\n')
}

/** The error of a search that ran past the time limit, which Dez ended. */
export function grepTimeoutError(): ToolError {
  return new ToolError(`The search ran for more than ${GREP_TIME_LIMIT_SECONDS} seconds, so Dez stopped it. ${SLOW_PATTERNS} `
    + 'Make the pattern simpler, or search fewer files with `path` or `include`.')
}
