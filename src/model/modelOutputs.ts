import type { ModelInfo } from './providers/types'

// The output types a model can make, in the order that every list of them
// uses. This table is the one place that spells them: the picker filter
// labels, the `model_list` letters and legend, the config and model-cache
// schemas, and the sort order all read it.
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

export type OutputLettersResult =
  | { ok: true, outputs: ModelOutput[] }
  | { ok: false, error: string }

// Dez sends a model with unknown outputs chat requests, so it counts as a
// text model.
const UNKNOWN_MODEL_OUTPUTS: readonly ModelOutput[] = ['text']

/** The letters of `outputs` in table order, joined with commas: `t,i`. */
export function outputLetters(outputs: readonly ModelOutput[]): string {
  return MODEL_OUTPUTS.filter((output) => outputs.includes(output.id)).map((output) => output.letter).join(',')
}

/** Reads output letters such as `iv` or `i, V`: commas and white space are
 *  ignored, and case does not count. The outputs come in table order, each
 *  once; a text with no letters gives none. An unknown letter is an error
 *  that names the valid letters. */
export function parseOutputLetters(text: string): OutputLettersResult {
  const letters = [...text.toLowerCase().replace(/[\s,]+/g, '')]
  const unknown = [...new Set(letters.filter((letter) => !MODEL_OUTPUTS.some((output) => output.letter === letter)))]
  if (unknown.length > 0) {
    const quoted = unknown.map((letter) => `"${letter}"`).join(', ')
    return {
      ok: false,
      error: `Unknown output letter${unknown.length === 1 ? '' : 's'} ${quoted}. Valid letters: ${OUTPUT_LETTER_LEGEND}.`,
    }
  }
  return { ok: true, outputs: MODEL_OUTPUTS.filter((output) => letters.includes(output.letter)).map((output) => output.id) }
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

/** The known output types in `values`, each once, in table order. Other
 *  values (from a hand-edited file) are dropped. */
export function normalizeOutputs(values: readonly unknown[]): ModelOutput[] {
  return MODEL_OUTPUT_IDS.filter((id) => values.includes(id))
}
