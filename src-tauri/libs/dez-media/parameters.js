// @ts-check
// The checks of the parameters of a run of a script app (the `parameters`
// of `main`). Each throws a RangeError whose text tells the caller how to
// fix the call. The built-in apps of Dez (src-tauri/builtin-apps/) check
// their parameters with them.

/**
 * The names or the values of `list`, quoted and joined: "a", "b".
 * @param {readonly unknown[]} list
 */
const quotedList = (list) => list.map((item) => JSON.stringify(item)).join(', ')

/**
 * Throws a RangeError that names each parameter that `app` does not take:
 * with a misspelled name, the run would else go on with the default value.
 * @param {string} app  the name of the app, for the error text
 * @param {Record<string, unknown>} parameters
 * @param {readonly string[]} known  the names of the parameters of the app
 */
export function checkParameterNames(app, parameters, known) {
  const unknown = Object.keys(parameters).filter((name) => !known.includes(name))
  if (unknown.length === 0) return
  const noun = unknown.length === 1 ? 'the parameter' : 'the parameters'
  throw new RangeError(`${app} does not take ${noun} ${quotedList(unknown)}. It takes only ${quotedList(known)}.`)
}

/**
 * The number parameter `name`; undefined when the call does not give it,
 * so that the caller sets the default: `numberParameter(…) ?? 0.35`.
 * Throws a RangeError for a value that is no finite number, or that
 * `isValid` does not take.
 * @param {Record<string, unknown>} parameters
 * @param {string} name
 * @param {(value: number) => boolean} isValid
 * @param {string} rule  the numbers that `isValid` takes, for the error
 *   text, as in "a number more than 0, such as 0.35"
 * @returns {number | undefined}
 */
export function numberParameter(parameters, name, isValid, rule) {
  const value = parameters[name]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || !isValid(value)) throw new RangeError(`${name} must be ${rule}, not ${JSON.stringify(value)}.`)
  return value
}

/**
 * The parameter `name`, one of the texts of `values`; the first of
 * `values` when the call does not give it. Throws a RangeError for any
 * other value.
 * @template {string} T
 * @param {Record<string, unknown>} parameters
 * @param {string} name
 * @param {readonly T[]} values
 * @returns {T}
 */
export function choiceParameter(parameters, name, values) {
  const value = parameters[name]
  if (value === undefined) return values[0]
  if (typeof value === 'string' && /** @type {readonly string[]} */ (values).includes(value)) return /** @type {T} */ (value)
  throw new RangeError(`${name} must be one of ${quotedList(values)}, not ${JSON.stringify(value)}.`)
}
