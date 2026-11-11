// The parameters of a media model: what a request to it can set, such as
// the length of a clip or the voice of speech. A media format reads them
// from the provider's model data (`ClipFormat.parameters` in
// mediaFormats.ts). The user sets values in the provider settings popup, and
// the `model_info` tool shows the parameters to a chat model.

// A value of a parameter, as the provider's API takes it.
export type ParameterValue = string | number

interface ParameterBase {
  // The name of the request field that gets the value.
  name: string
  // The name that the UI shows.
  label: string
}

// A parameter that takes one value of a list.
export interface OptionsParameter extends ParameterBase {
  // The values that the model takes, each once. Never empty.
  options: ParameterValue[]
  // What Dez sends when no one chose a value. Missing: Dez sends no value,
  // and the provider's own default applies.
  default?: ParameterValue
}

// A parameter that takes each whole number from `min` to `max`.
export interface RangeParameter extends ParameterBase {
  min: number
  max: number
  // As for OptionsParameter.
  default?: number
}

export type ModelParameter = OptionsParameter | RangeParameter

// Parameter name -> value.
export type ParameterValues = Record<string, ParameterValue>

export function isParameterValue(value: unknown): value is ParameterValue {
  return (typeof value === 'string' && value !== '') || (typeof value === 'number' && Number.isFinite(value))
}

// A copy that shares no list with `parameter`.
export function cloneModelParameter(parameter: ModelParameter): ModelParameter {
  return 'options' in parameter ? { ...parameter, options: [...parameter.options] } : { ...parameter }
}

// A text `5` is not the number 5: the value goes to the provider as it is.
export function parameterTakes(parameter: ModelParameter, value: unknown): value is ParameterValue {
  if ('options' in parameter) return isParameterValue(value) && parameter.options.includes(value)
  return typeof value === 'number' && Number.isInteger(value) && value >= parameter.min && value <= parameter.max
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
  return 'options' in parameter
    ? `one of: ${parameter.options.map((option) => JSON.stringify(option)).join(', ')}`
    : `a whole number from ${parameter.min} to ${parameter.max}`
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
