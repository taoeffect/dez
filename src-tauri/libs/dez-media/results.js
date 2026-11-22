// @ts-check
// Helpers for the result files of a run of a script app: the file in the
// work folder of the conversation that a model names (`/work/…`), a JSON
// text that a model reads well, and rounded numbers. The built-in apps of
// Dez (src-tauri/builtin-apps/) write their measurements with them.

// The path of the work folder of the conversation as a model writes and
// reads it (WORK_VIRTUAL_ROOT, src/model/tools/conversationWork.ts).
const WORK_ROOT = '/work'

// The rules of a path of the apps tool (`appsPath`, src/model/tools/
// appsTool.ts), so that the tool can read the file: the names that the
// file selectors take, their length, and their count. A test of
// tests/dez-media/ checks that the two rules agree.
const NAME = /^[A-Za-z0-9._-]+$/
const MAX_NAME_LENGTH = 100
const MAX_PATH_NAMES = 12
// Names that Dez takes for the start of a path of the user's computer, and
// hides from a model (`HIDDEN_NAMES`, appsTool.ts).
const HIDDEN_NAMES = ['home', 'Users']

/**
 * The file that `path` names in the work folder of the conversation, from
 * the path as a model writes it (`/work/beats/song.json`): `path`, the
 * file to open below `workFolder` (`dez.workFolder` of a run), and `shown`,
 * the path as the model reads it.
 *
 * Throws a RangeError for a path that is not below /work/, and for a name
 * that the apps tool does not take: each name has only ASCII letters,
 * digits, "-", "_", and "." (not "." or ".."), and at most 100 characters,
 * with at most 12 names after /work/.
 * @param {string} workFolder
 * @param {string} path
 */
export function workFile(workFolder, path) {
  const quoted = JSON.stringify(path)
  if (!path.startsWith(`${WORK_ROOT}/`)) throw new RangeError(`${quoted} is no file in ${WORK_ROOT}/, the work folder of the conversation: give a path such as "${WORK_ROOT}/result.json".`)
  const names = path.slice(WORK_ROOT.length + 1).split('/')
  if (names.length > MAX_PATH_NAMES) throw new RangeError(`${quoted} has ${names.length} names after ${WORK_ROOT}/, and a path has at most ${MAX_PATH_NAMES}.`)
  for (const name of names) {
    if (name === '') throw new RangeError(`${quoted} has an empty name: give the path of a file, with one "/" between two names.`)
    if (name === '.' || name === '..' || !NAME.test(name)) {
      throw new RangeError(`${quoted} holds the name ${JSON.stringify(name)}: a name has only ASCII letters, digits, "-", "_", and ".", and is not "." or "..".`)
    }
    if (name.length > MAX_NAME_LENGTH) throw new RangeError(`${quoted} holds a name of ${name.length} characters, and a name has at most ${MAX_NAME_LENGTH}.`)
    if (HIDDEN_NAMES.includes(name)) throw new RangeError(`${quoted} holds the name "${name}", which Dez takes for a folder of the user's computer and hides: use another name.`)
  }
  return { path: [workFolder, ...names].join('/'), shown: path }
}

/**
 * The JSON text of a result, for a file that code reads and a model reads
 * too: each field of the top object on its own line, and each object of a
 * list in a field on its own line. A list of numbers stays on one line, so
 * 500 beat times are one line, not 500. Ends with a line end.
 * @param {unknown} value
 */
export function resultJson(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return `${JSON.stringify(value)}\n`
  const fields = Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .map(([key, item]) => `  ${JSON.stringify(key)}: ${fieldJson(item)}`)
  return fields.length === 0 ? '{}\n' : `{\n${fields.join(',\n')}\n}\n`
}

/**
 * The JSON of one field of a result (`resultJson`).
 * @param {unknown} item
 */
function fieldJson(item) {
  const isObject = (/** @type {unknown} */ entry) => entry !== null && typeof entry === 'object' && !Array.isArray(entry)
  if (!Array.isArray(item) || item.length === 0 || !item.every(isObject)) return JSON.stringify(item)
  return `[\n${item.map((entry) => `    ${JSON.stringify(entry)}`).join(',\n')}\n  ]`
}

/**
 * `value` rounded to `decimals` digits after the point, such as a time in
 * seconds to the millisecond: roundTo(1.23456, 3) is 1.235. A half goes up,
 * as with Math.round (not to the even digit, as np.round does).
 * @param {number} value
 * @param {number} decimals
 */
export function roundTo(value, decimals) {
  const scale = 10 ** decimals
  return Math.round(value * scale) / scale
}
