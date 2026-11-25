import { mediaFileExtension } from '../chat/mediaFiles'
import { UnusableAnswerError } from './errors'
import type { InputClipPart } from './mediaFormats'
import { isOptionValue, type ModelParameter, type OptionsParameter, type OptionValue } from './modelParameters'
import { isRecord, valueAtPath } from './modelParsing'
import type { MultipartField } from './multipart'
import type { TimedSegment, TimedWord, TranscriptTimes } from './types'

// The small parts that more than one media format (`MediaFormat`) uses.
// A leaf module: mediaFormats.ts imports each format module, so a format
// module that imported these from mediaFormats.ts would make an import
// cycle.

// A URL that a player can load: http or https, with no space or line break
// (a media tag is one line).
export function isClipUrl(value: unknown): value is string {
  return typeof value === 'string' && /^https?:\/\/\S+$/i.test(value)
}

// The texts and numbers of a list in a model entry, each once, in the
// list's order.
export function listedValues(list: unknown): OptionValue[] {
  return [...new Set((Array.isArray(list) ? list : []).filter(isOptionValue))]
}

// The parameter of a request field that takes one of `options`, and, with
// `custom`, also a text that the list does not hold; none when it has no
// option and takes no such text. `defaultValue` is its default when it is
// an option.
export function optionsParameter(name: string, label: string, options: OptionValue[], defaultValue?: unknown, custom = false): ModelParameter[] {
  if (options.length === 0 && !custom) return []
  const parameter: OptionsParameter = { name, label, options }
  if (isOptionValue(defaultValue) && options.includes(defaultValue)) parameter.default = defaultValue
  if (custom) parameter.custom = true
  return [parameter]
}

// The switch of a request field that a model takes only when its entry
// says so (`supported` is true). With no `defaultValue`, a switch that the
// user did not turn on puts no field into the request.
export function switchParameter(name: string, label: string, supported: unknown, defaultValue?: boolean): ModelParameter[] {
  if (supported !== true) return []
  return [{ name, label, ...(defaultValue !== undefined && { default: defaultValue }) }]
}

// The seconds of a length, as a model list writes it: a number (OpenRouter)
// or a text such as `5s` (Venice). NaN for any other entry, such as `auto`.
export function lengthSeconds(length: OptionValue): number {
  if (typeof length === 'number') return length > 0 ? length : Number.NaN
  const match = /^(\d+(?:\.\d+)?)s?$/i.exec(length)
  return match ? Number(match[1]) : Number.NaN
}

// The lines of a resolution: names of lines (`480p`, `768P`) and of
// thousands (`2k`, `4K`) count. NaN for a name such as `2x` or
// `true_1080p`, which has no place in the order.
export function resolutionLines(resolution: OptionValue): number {
  const match = typeof resolution === 'string' ? /^(\d+)([pk])$/i.exec(resolution) : null
  return match ? Number(match[1]) * (match[2].toLowerCase() === 'k' ? 1000 : 1) : Number.NaN
}

// The parameter of a length or a resolution, from the list of a model
// entry. Its default is the lowest value: Dez shows no price before a
// request, so with no choice a request asks for the cheapest clip that the
// model makes. For one model, the default length and size of a provider
// can cost 5 to 20 times more. The options go from low to high; the values
// that `size` gives no number come last, in the list's order, and are never
// the default.
export function lowestFirstParameter(name: string, label: string, list: unknown, size: (value: OptionValue) => number): ModelParameter[] {
  const values = listedValues(list)
  const sized = values.filter((value) => !Number.isNaN(size(value))).sort((a, b) => size(a) - size(b))
  return optionsParameter(name, label, [...sized, ...values.filter((value) => Number.isNaN(size(value)))], sized[0])
}

// The one clip of a request to a model that changes or writes down a clip
// (its `source` clip), with its bytes. The submit and `generateMedia` send
// no such request without it (`missingClipProblem`), and no model of these
// kinds takes a clip only by its web address.
export function sourceClip(clips: readonly InputClipPart[]): { bytes: Uint8Array, mediaType: string } {
  const clip = clips.find((part) => part.use === 'source')
  if (!clip || 'url' in clip) throw new Error('The request has no source clip to send.')
  return clip
}

// The form file `name` of a clip. The file name tells the type by its
// extension (some servers read that) and names no local path.
export function clipFormFile(name: string, { bytes, mediaType }: { bytes: Uint8Array, mediaType: string }): MultipartField {
  return { name, file: { bytes, mediaType, fileName: `clip.${mediaFileExtension(mediaType, null) ?? 'bin'}` } }
}

export function jsonBody(body: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(body))
  } catch {
    throw new UnusableAnswerError('The answer is not valid JSON.')
  }
}

// The text of a transcription answer (its JSON `data`): `{ text, … }` for
// each API that Dez knows. An empty text is the transcript of a clip with
// no speech.
export function transcriptText(data: unknown): string {
  const text = isRecord(data) ? data.text : undefined
  if (typeof text !== 'string') throw new UnusableAnswerError('The answer holds no text.')
  return text
}

// A time of a transcription answer, rounded to the millisecond: the
// answers hold float noise, such as 47.480000000000004.
function answerSeconds(value: number): number {
  return Math.round(value * 1000) / 1000
}

// The entries of a list of a transcription answer that hold a text at `key`
// and a `start` and `end` in seconds (0 or more, `end` not before `start`).
function timedEntries(list: unknown, key: 'word' | 'text'): TimedSegment[] {
  if (!Array.isArray(list)) return []
  return list.flatMap((entry) => {
    if (!isRecord(entry)) return []
    const { [key]: text, start, end } = entry
    if (typeof text !== 'string' || typeof start !== 'number' || typeof end !== 'number') return []
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start) return []
    return [{ text, start: answerSeconds(start), end: answerSeconds(end) }]
  })
}

// The times of a transcription answer that asked for them: the lists at
// `paths.words` (`{ word, start, end }`) and `paths.segments` (`{ text,
// start, end }`), and the length of the clip at `duration`. Models
// differ: one gives only words, another only segments. Dez drops each
// entry that is not of that form. Undefined when no entry is left.
export function transcriptTimes(data: unknown, paths: { words: string, segments: string }): TranscriptTimes | undefined {
  const words: TimedWord[] = timedEntries(valueAtPath(data, paths.words), 'word').map(({ text, start, end }) => ({ word: text, start, end }))
  const segments = timedEntries(valueAtPath(data, paths.segments), 'text')
  if (words.length === 0 && segments.length === 0) return undefined
  const duration = isRecord(data) ? data.duration : undefined
  return { duration: typeof duration === 'number' && Number.isFinite(duration) && duration > 0 ? answerSeconds(duration) : null, words, segments }
}
