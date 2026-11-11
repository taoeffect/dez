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
  // The name of the request field that gets the value.
  name: string
  // The name that the UI shows.
  label: string
}

// A parameter that takes one value of a list.
export interface OptionsParameter extends ParameterBase {
  // The values that the model takes, each once. Never empty.
  options: OptionValue[]
  // What Dez sends when no one chose a value. Missing: Dez sends no value,
  // and the provider's own default applies.
  default?: OptionValue
}

// A parameter that takes each number from `min` to `max` that is a whole
// count of steps away from `min`.
export interface RangeParameter extends ParameterBase {
  min: number
  max: number
  // The distance between two values, over 0. Missing: 1, so a range with a
  // whole `min` takes whole numbers.
  step?: number
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

// A text `5` is not the number 5: the value goes to the provider as it is.
export function parameterTakes(parameter: OptionsParameter, value: unknown): value is OptionValue
export function parameterTakes(parameter: RangeParameter, value: unknown): value is number
export function parameterTakes(parameter: ModelParameter, value: unknown): value is ParameterValue
export function parameterTakes(parameter: ModelParameter, value: unknown): boolean {
  if ('options' in parameter) return isOptionValue(value) && parameter.options.includes(value)
  if (!('min' in parameter)) return typeof value === 'boolean'
  if (typeof value !== 'number' || !Number.isFinite(value) || value < parameter.min || value > parameter.max) return false
  const steps = rangeSteps(parameter, value)
  return Math.abs(steps - Math.round(steps)) < STEP_TOLERANCE
}

/** The value of a range that is nearest to `value`: a number under `min`
 *  gives `min`, one over `max` gives the highest value, and one between
 *  two steps gives the nearer step. */
export function nearestRangeValue(parameter: RangeParameter, value: number): number {
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
  if ('options' in parameter) return `one of: ${parameter.options.map((option) => JSON.stringify(option)).join(', ')}`
  if (!('min' in parameter)) return 'true or false'
  const step = parameter.step ?? 1
  return step === 1 && Number.isInteger(parameter.min)
    ? `a whole number from ${parameter.min} to ${parameter.max}`
    : `a number from ${parameter.min} to ${parameter.max} in steps of ${step}`
}

/** `chosen` as parameter values, for values that a caller names one by one
 *  (a tool call). Throws for a name that is not a parameter of the model,
 *  and for a value that its parameter does not take. The message tells what
 *  the model takes, for a chat model to read. */
export function checkedParameterValues(parameters: readonly ModelParameter[], chosen: Readonly<Record<string, unknown>>): ParameterValues {
  const values: ParameterValues = {}
  for (const [name, value] of Object.entries(chosen)) {
    const parameter = parameters.find((candidate) => candidate.name === name)
    if (!parameter) {
      const names = parameters.map((candidate) => candidate.name).join(', ')
      throw new Error(`The model has no parameter ${JSON.stringify(name)}. ${names === '' ? 'It has no parameters.' : `Its parameters: ${names}.`}`)
    }
    if (!parameterTakes(parameter, value)) throw new Error(`The parameter ${JSON.stringify(name)} takes ${takesText(parameter)}.`)
    values[name] = value
  }
  return values
}
