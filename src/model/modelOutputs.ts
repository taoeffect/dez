import type { ModelInfo } from './providers/types'

// The output types a model can make, in the order that every list of them
// uses; the types that Dez can send a model (modelInputs.ts) are the same.
// This table is the one place that spells them: the picker filter labels,
// the `model_list` letters, legend, and filter values, the config and
// model-cache schemas, and the sort order all read it.
export const MODEL_OUTPUTS = [
  { id: 'text', letter: 't', label: 'Text' },
  { id: 'image', letter: 'i', label: 'Image' },
  { id: 'audio', letter: 'a', label: 'Audio' },
  { id: 'video', letter: 'v', label: 'Video' },
] as const

export type ModelOutput = (typeof MODEL_OUTPUTS)[number]['id']

export const MODEL_OUTPUT_IDS: readonly ModelOutput[] = MODEL_OUTPUTS.map((output) => output.id)

// What each output letter stands for: "t text, i image, a audio, v video".
export const OUTPUT_LETTER_LEGEND = MODEL_OUTPUTS.map(({ letter, id }) => `${letter} ${id}`).join(', ')

export type OutputTypesResult =
  | { ok: true, types: ModelOutput[] }
  | { ok: false, unknown: string[] }

// Dez sends a model with unknown outputs chat requests, so it counts as a
// text model.
const UNKNOWN_MODEL_OUTPUTS: readonly ModelOutput[] = ['text']

/** The letters of `types` in table order, joined with commas: `t,i`. */
export function outputLetters(types: readonly ModelOutput[]): string {
  return MODEL_OUTPUTS.filter((output) => types.includes(output.id)).map((output) => output.letter).join(',')
}

/** Reads type ids such as `image,video` or `Image VIDEO`: words split by
 *  commas and white space, in which case does not count. The types come in
 *  table order, each once; a text with no word gives none. `unknown` holds
 *  each word that is no type id, once, in text order. */
export function parseOutputTypes(text: string): OutputTypesResult {
  const words = text.toLowerCase().split(/[\s,]+/).filter(Boolean)
  const unknown = [...new Set(words.filter((word) => !MODEL_OUTPUT_IDS.some((id) => id === word)))]
  if (unknown.length > 0) return { ok: false, unknown }
  return { ok: true, types: MODEL_OUTPUT_IDS.filter((id) => words.includes(id)) }
}

/** What the model makes; a model whose provider does not tell counts as a
 *  text model. */
export function effectiveOutputs(model: Pick<ModelInfo, 'outputs'>): readonly ModelOutput[] {
  return model.outputs ?? UNKNOWN_MODEL_OUTPUTS
}

/** The output filter of the model picker and `model_list`: an empty filter
 *  matches every model; else the model must make at least one of the
 *  filter's types. */
export function matchesOutputFilter(model: Pick<ModelInfo, 'outputs'>, filter: readonly ModelOutput[]): boolean {
  return filter.length === 0 || effectiveOutputs(model).some((output) => filter.includes(output))
}

/** The output filter after a click on the checkbox of `output`: the click
 *  adds the type, or removes it when the filter has it. An empty filter is
 *  "All", so a first type replaces "All", and the removal of the last type
 *  gives "All" again. */
export function toggleOutputFilter(filter: readonly ModelOutput[], output: ModelOutput): ModelOutput[] {
  return normalizeOutputs(filter.includes(output) ? filter.filter((id) => id !== output) : [...filter, output])
}

/** The known output types in `values`, each once, in table order. Other
 *  values (from a hand-edited file) are dropped. */
export function normalizeOutputs(values: readonly unknown[]): ModelOutput[] {
  return MODEL_OUTPUT_IDS.filter((id) => values.includes(id))
}
