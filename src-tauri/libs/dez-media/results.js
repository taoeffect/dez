// @ts-check
// Helpers for the result files of a run of a script app: the file in the
// work folder of the conversation that a model names (`/work/…`), the
// result files of a run (the `save_to` parameter), a JSON text that a model
// reads well, and rounded numbers. The built-in apps of Dez
// (src-tauri/builtin-apps/) write their measurements with them.

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
 * The `save_to` parameter of a run: a path in /work/; undefined when the
 * call does not give it. `name` starts the name of the example file of the
 * error text: "beats" for "/work/beats.json".
 * @param {string} name
 * @param {Record<string, unknown>} parameters
 * @returns {string | undefined}
 */
function saveToParameter(name, parameters) {
  const saveTo = parameters.save_to
  if (saveTo === undefined || typeof saveTo === 'string') return saveTo
  throw new RangeError(`save_to must be a path in ${WORK_ROOT}/, as in "${WORK_ROOT}/${name}.json", not ${JSON.stringify(saveTo)}.`)
}

/**
 * The result file of a run that writes one file, as `workFile` gives it:
 * the `save_to` path of the call, else `fallback`, a path in /work/.
 * Throws a RangeError for a `save_to` that is no path in /work/.
 * @param {string} name  starts the name of the example file of an error
 *   text: "align" for "/work/align.json"
 * @param {Record<string, unknown>} parameters
 * @param {{ workFolder: string }} dez  the `dez` of the run
 * @param {string} fallback
 */
export function resultFile(name, parameters, dez, fallback) {
  return workFile(dez.workFolder, saveToParameter(name, parameters) ?? fallback)
}

/**
 * The result files of a run that writes one file for each input, in the
 * order of `dez.inputs`, as `workFile` gives them: /work/<name>-<id>.json,
 * or the `save_to` path of the call for a run with one input. Throws a
 * RangeError for a `save_to` that is no path in /work/, and for a
 * `save_to` of a run with more than one input.
 * @param {string} name  starts the name of each file: "beats" for
 *   /work/beats-<id>.json
 * @param {Record<string, unknown>} parameters
 * @param {{ inputs: readonly { id: string }[], workFolder: string }} dez  the `dez` of the run
 */
export function resultFiles(name, parameters, dez) {
  const saveTo = saveToParameter(name, parameters)
  if (saveTo === undefined) return dez.inputs.map(({ id }) => workFile(dez.workFolder, `${WORK_ROOT}/${name}-${id}.json`))
  if (dez.inputs.length !== 1) {
    throw new RangeError(`save_to names one file, and the run has ${dez.inputs.length} inputs. Leave it out: each input then gets ${WORK_ROOT}/${name}-<id>.json.`)
  }
  return [workFile(dez.workFolder, saveTo)]
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
