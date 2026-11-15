// The parameters of a media model: what a request to it can set, such as
// the scale of an upscale, the length of a clip, or the voice of speech. A
// media format reads them from the provider's model data or its docs
// (`ImageFormat.parameters`, `ClipFormat.parameters` in mediaFormats.ts).
// The user sets values in the provider settings popup, and the `model_info`
// tool shows the parameters to a chat model.

// A value of a list of options.
export type OptionValue = string | number

// A value of a parameter, as the provider's API takes it.
export type ParameterValue = OptionValue | boolean

interface ParameterBase {
  // The name of the request field that gets the value. The one exception
  // is a parameter that the format's request reads itself and sends as no
  // field (OpenRouter's `images_as`, mediaFormats.ts).
  name: string
  // The name that the UI shows.
  label: string
}

// A parameter that takes one value of a list.
export interface OptionsParameter extends ParameterBase {
  // The values that the model lists, each once. Empty only with `custom`.
  options: OptionValue[]
  // What Dez sends when no one chose a value. Missing: Dez sends no value,
  // and the provider's own default applies.
  default?: OptionValue
  // The list is not complete: the model also takes a text that `options`
  // does not hold, such as a voice id of its provider that the model list
  // leaves out (`isCustomValue`). Dez cannot check such a text, so the
  // provider does. Missing: the list is closed, and the provider refuses
  // every other value.
  custom?: true
}

// A parameter that takes the numbers from `min` to `max`: each number that
// is a whole count of steps away from `min`, or, with `anyNumber`, every
// number of the range.
export interface RangeParameter extends ParameterBase {
  min: number
  max: number
  // The distance between two values, over 0. Missing: 1, so a range with a
  // whole `min` takes whole numbers.
  step?: number
  // The model takes every number of the range. `step` is then no rule of
  // the model: it is only the step of the arrows of the settings field.
  // Missing: the model takes only the numbers on a step.
  anyNumber?: true
  // As for OptionsParameter.
  default?: number
}

// A parameter that is on or off. It has no field of its own that tells its
// kind: a parameter with no `options` and no `min` is a switch.
export interface SwitchParameter extends ParameterBase {
  // As for OptionsParameter.
  default?: boolean
}

export type ModelParameter = OptionsParameter | RangeParameter | SwitchParameter

// Parameter name -> value.
export type ParameterValues = Record<string, ParameterValue>

export function isOptionValue(value: unknown): value is OptionValue {
  return (typeof value === 'string' && value !== '') || (typeof value === 'number' && Number.isFinite(value))
}

export function isParameterValue(value: unknown): value is ParameterValue {
  return isOptionValue(value) || typeof value === 'boolean'
}

// A copy that shares no list with `parameter`.
export function cloneModelParameter(parameter: ModelParameter): ModelParameter {
  return 'options' in parameter ? { ...parameter, options: [...parameter.options] } : { ...parameter }
}

// The count of steps from `min` to `value`; a whole number for a value that
// the range takes.
function rangeSteps(parameter: RangeParameter, value: number): number {
  return (value - parameter.min) / (parameter.step ?? 1)
}

// The numbers of a range with a step under 1 are not exact in binary
// (0.7 + 2 * 0.05 is 0.7999999999999999), so a value counts as on a step
// when it is this near to one.
const STEP_TOLERANCE = 1e-9

/** The most characters of a text that the list of a parameter with
 *  `custom` does not hold. It is the longest voice id that the docs of a
 *  provider tell (Venice's speech request: "`voice` | string, ≤ 512"). A
 *  longer text is a mistake of the caller, such as a prompt in the wrong
 *  field. */
export const MAX_CUSTOM_VALUE_LENGTH = 512

// A control character or a line break.
const NOT_ONE_LINE = /[\p{Cc}\p{Zl}\p{Zp}]/u

// Whether `value` is a text that a parameter with `custom` takes in place
// of a listed value: one line that is not blank. The text goes to the
// provider as it is, and only the provider knows if it names a thing.
function isCustomValue(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '' && value.length <= MAX_CUSTOM_VALUE_LENGTH && !NOT_ONE_LINE.test(value)
}

// A text `5` is not the number 5: the value goes to the provider as it is.
// (A tool call that writes a number as a text gets the number:
// `valueOfCall`.)
export function parameterTakes(parameter: OptionsParameter, value: unknown): value is OptionValue
export function parameterTakes(parameter: RangeParameter, value: unknown): value is number
export function parameterTakes(parameter: ModelParameter, value: unknown): value is ParameterValue
export function parameterTakes(parameter: ModelParameter, value: unknown): boolean {
  if ('options' in parameter) return isOptionValue(value) && (parameter.options.includes(value) || (parameter.custom === true && isCustomValue(value)))
  if (!('min' in parameter)) return typeof value === 'boolean'
  if (typeof value !== 'number' || !Number.isFinite(value) || value < parameter.min || value > parameter.max) return false
  if (parameter.anyNumber) return true
  const steps = rangeSteps(parameter, value)
  return Math.abs(steps - Math.round(steps)) < STEP_TOLERANCE
}

/** The value of a range that is nearest to `value`: a number under `min`
 *  gives `min`, one over `max` gives the highest value, and one between
 *  two steps gives the nearer step. A range with `anyNumber` has no steps,
 *  so a number of the range stays as it is. */
export function nearestRangeValue(parameter: RangeParameter, value: number): number {
  if (parameter.anyNumber) return Math.min(parameter.max, Math.max(parameter.min, value))
  const step = parameter.step ?? 1
  const lastStep = Math.floor(rangeSteps(parameter, parameter.max) + STEP_TOLERANCE)
  const steps = Math.min(lastStep, Math.max(0, Math.round(rangeSteps(parameter, value))))
  // 10 decimals take away the binary noise of the product (0.25 + 11 *
  // 0.05 is 0.8000000000000002), and keep every step that a provider names.
  return Number((parameter.min + steps * step).toFixed(10))
}

/** The value that a request sends for each parameter of a model: the chosen
 *  value when the parameter takes it, else the parameter's default. A
 *  parameter with neither gets no entry. A chosen value that the model does
 *  not take counts as not chosen, so a stored choice never breaks a request
 *  after the provider changed the model. */
export function effectiveParameterValues(parameters: readonly ModelParameter[], chosen: Readonly<Record<string, unknown>> = {}): ParameterValues {
  const values: ParameterValues = {}
  for (const parameter of parameters) {
    const choice = Object.hasOwn(chosen, parameter.name) ? chosen[parameter.name] : undefined
    const value = parameterTakes(parameter, choice) ? choice : parameter.default
    if (value !== undefined) values[parameter.name] = value
  }
  return values
}

function takesText(parameter: ModelParameter): string {
  if ('options' in parameter) {
    const options = parameter.options.map((option) => JSON.stringify(option)).join(', ')
    if (!parameter.custom) return `one of: ${options}`
    return options === ''
      ? `a text of one line (at most ${MAX_CUSTOM_VALUE_LENGTH} characters)`
      : `one of: ${options}, or the text of another value that the provider takes (one line, at most ${MAX_CUSTOM_VALUE_LENGTH} characters)`
  }
  if (!('min' in parameter)) return 'true or false'
  if (parameter.anyNumber) return `a number from ${parameter.min} to ${parameter.max}`
  const step = parameter.step ?? 1
  return step === 1 && Number.isInteger(parameter.min)
    ? `a whole number from ${parameter.min} to ${parameter.max}`
    : `a number from ${parameter.min} to ${parameter.max} in steps of ${step}`
}

// The text of a number, as a calling model writes one (`"30"` for 30).
const NUMBER_TEXT = /^-?\d+(?:\.\d+)?$/

// A value of a tool call as its parameter takes it. A calling model
// writes a number as a text at times. When the parameter does not take
// the text and takes the number, the value is clear, so it counts as the
// number. A stored choice gets no such help (`effectiveParameterValues`):
// Dez wrote it.
function valueOfCall(parameter: ModelParameter, value: unknown): unknown {
  if (typeof value !== 'string' || parameterTakes(parameter, value) || !NUMBER_TEXT.test(value)) return value
  const number = Number(value)
  return parameterTakes(parameter, number) ? number : value
}

/** `chosen` as parameter values, for values that a caller names one by one
 *  (a tool call). Throws for a name that is not a parameter of the model,
 *  and for a value that its parameter does not take. The message tells what
 *  the model takes, for a chat model to read. A provider can take a field
 *  that Dez has no parameter for, so the text of an unknown name tells
 *  only what Dez has. */
export function checkedParameterValues(parameters: readonly ModelParameter[], chosen: Readonly<Record<string, unknown>>): ParameterValues {
  const values: ParameterValues = {}
  for (const [name, value] of Object.entries(chosen)) {
    const parameter = parameters.find((candidate) => candidate.name === name)
    if (!parameter) {
      const names = parameters.map((candidate) => candidate.name).join(', ')
      throw new Error(names === ''
        ? 'Dez has no parameters for this model: leave out `parameters`.'
        : `Dez has no parameter ${JSON.stringify(name)} for this model. Its parameters: ${names}.`)
    }
    const taken = valueOfCall(parameter, value)
    if (!parameterTakes(parameter, taken)) throw new Error(`The parameter ${JSON.stringify(name)} takes ${takesText(parameter)}.`)
    values[name] = taken
  }
  return values
}
