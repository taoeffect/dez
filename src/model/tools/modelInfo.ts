import { modelRefKey } from '../chat/modelRef'
import type { ModelRef } from '../chat/types'
import { modelInputs } from '../modelInputs'
import { effectiveOutputs, MODEL_OUTPUT_IDS } from '../modelOutputs'
import type { ModelCache } from '../persistence/types'
import { inputImageRulesFor, maxInputImages, minInputImages } from '../providers/clipImages'
import type { KnownLimit } from '../providers/knownLimits'
import { imageRulesWithLearnedLimit } from '../providers/learnedImageLimit'
import { contextWindowOf, imageLimitOf, messageImageLimitOf } from '../providers/modelFamilies'
import type { ParameterValues } from '../providers/modelParameters'
import { roundedPrice, type ModelPrice } from '../providers/modelPrices'
import type { ProviderMediaQuote } from '../providers/streamTypes'
import { effectiveRequest, MODEL_REQUESTS, type ModelInfo, type ProviderInfo, type ProviderInputImageRules } from '../providers/types'
import { unstoredOutputMessage, unusableModelMessage } from '../providers/unusableModel'
import { argumentWords, unknownValuesText } from './arguments'
import { jsonWithoutLocalPaths } from './localPaths'
import { FIND_MODELS, listedModel, namedModelTarget, type ModelTarget } from './modelArguments'
import { modelUsage } from './modelUsage'
import { ToolError, type ToolArguments, type ToolDefinition } from './types'

/** The most characters of a `model_info` result. A result over it leaves
 *  out entries of the provider, which a call can get one at a time
 *  (`part`). */
export const MODEL_INFO_SIZE_CAP = 50_000

/** The entries of a `model_info` result: the provider's own data about the
 *  model, as it sent it. */
export const MODEL_INFO_PARTS = ['providerEntry', 'mediaEntry', 'priceEntry'] as const

export type ModelInfoPart = (typeof MODEL_INFO_PARTS)[number]

/** The parts of a `model_info` result that the `only` argument names:
 *  `usage`, and `parameters` and `cost` of `dez`. */
export const MODEL_INFO_ONLY_VALUES = ['usage', 'parameters', 'cost'] as const

export type ModelInfoOnlyValue = (typeof MODEL_INFO_ONLY_VALUES)[number]

/** What a `model_info` call asks for in place of the whole result: one
 *  entry of the provider (`part`), or only some of the facts (`only`). */
export type ModelInfoSelection = { part: ModelInfoPart } | { only: readonly ModelInfoOnlyValue[] }

// The description comes from static tables only (no running counts, no
// dates, no random values): the tools array is in the provider's prompt
// cache, so it must be the same bytes in each request of one release of
// Dez. It can change between releases. It does not name each field of the
// result: the result holds every fact that Dez has, and its names tell what
// they are.
export const MODEL_INFO_TOOL: ToolDefinition = {
  name: 'model_info',
  description: 'Give all that Dez knows about one model that the user can use, as JSON. '
    + 'With no `model`, that model is you: the model that the user chose for this reply, which makes this call. '
    + '`id` is its full id, `name` its name, and `provider` the `id` and `name` of its provider. '
    + '`dez` holds the facts that Dez uses, each under a name that tells what it is, for example '
    + `\`request\` (how Dez sends it a request: ${MODEL_REQUESTS.join(', ')}; none means that Dez cannot use it yet), `
    + `\`outputs\` (what it makes: ${MODEL_OUTPUT_IDS.join(', ')}), `
    + `\`inputs\` (what Dez can send it in one request: ${MODEL_OUTPUT_IDS.join(', ')}), `
    + '`released` (its release date, `YYYY-MM-DD`, as `model_list` gives it), '
    + '`contextWindow` (its context window, in tokens), `images` (how many images one request to it can hold), `parameters`, and `cost`. '
    + '`dez.unknown` names the facts that the provider does not tell; their values are what Dez does then, '
    + 'and an unknown `released` has no value. '
    + '`dez.limits` lists rules of the model that Dez knows from other places than the provider\'s data, each with its `source`. '
    + '`usage` tells how to use the model: how a request to it is formed, what it needs, and what comes back. '
    + '`dez` and `usage` can hold more than this text names. '
    + 'Each of `dez.parameters` has a `name`, a `label` (its name in the Dez settings), and `options` (the values that it takes; '
    + 'with `custom`, it also takes the text of another value of the provider that the list does not hold, such as the id of a voice), '
    + 'or `min` and `max` (each number from `min` to `max` in steps of `step`, else in steps of 1; with `anyNumber`, every number from `min` to `max`); '
    + 'a parameter with none of these is a switch (`true` or `false`). '
    + 'Its `default` is the value that Dez sends when no one chose a value, and its `value` the value that Dez sends now: '
    + 'the one from the `parameters` argument, else the one that the user chose, else the default. '
    + 'With no `value`, Dez sends none and the provider\'s own default applies. '
    + '`dez.cost` is the price: `usd`, the price in US dollars of one request with those values '
    + '(with a `note` when other inputs change it or it is an estimate); '
    + 'else the rates of the provider\'s price list, each under a name that tells its unit (for example `usdPer1MInputTokens`); '
    + 'else `error`, which tells why Dez has no price. '
    + 'The entries are the provider\'s own data about the model, as it sent them: '
    + '`providerEntry` (its entry in the provider\'s model list, or in the Dez provider settings), '
    + '`mediaEntry` (its entry in the provider\'s list of media models), and `priceEntry` (its price records). '
    + 'Dez hides the local file paths in them: such a path keeps only its start, and `…` stands for the rest '
    + '(for example `/home/…`). The `id` at the top is never changed. '
    + `A result over ${MODEL_INFO_SIZE_CAP} characters leaves out entries and names them in \`note\`; `
    + 'the `part` argument gives one entry alone.',
  parameters: [
    {
      name: 'model',
      type: 'string',
      description: 'The full id of the model (`provider/model`), as `model_list` gives it. '
        + 'Leave it out to get the info of your own model.',
      required: false,
    },
    {
      name: 'parameters',
      type: 'string',
      description: 'Values for parameters of the model, as the text of a JSON object from parameter name to value '
        + '(for example `{"duration": "5s"}`). `value` and `cost` in the result are then for a request with these values. '
        + 'Use it to learn what a request costs, for the user or before a `model_invoke` call with the same values. It changes no setting.',
      required: false,
    },
    {
      name: 'part',
      type: 'string',
      description: `The name of one entry (${MODEL_INFO_PARTS.map((part) => `\`${part}\``).join(', ')}): `
        + 'the result is then only `id` and that entry. Use it for an entry that `note` names as left out.',
      required: false,
    },
    {
      name: 'only',
      type: 'string',
      description: `Parts of the result to give alone: a comma list of ${MODEL_INFO_ONLY_VALUES.join(', ')}, as in "usage,cost". `
        + '`parameters` and `cost` are `dez.parameters` and `dez.cost`. '
        + 'The result is then only `id` and those parts, which is much shorter than the whole result. '
        + 'Use it when you need only these parts, for example the price of a request with other `parameters` values. '
        + 'Do not use it with `part`.',
      required: false,
    },
  ],
}

/** A provider toggle that applies to the model, with its value now. */
export interface ModelInfoToggle {
  key: string
  label: string
  on: boolean
}

/** What a `model_info` result tells besides the cached model. Each field
 *  is absent when Dez does not know it. */
export interface ModelInfoFacts {
  /** The model's raw entry in the provider's model list. */
  entry?: unknown
  /** The value that Dez sends for each parameter that gets one
   *  (`effectiveParameterValues`). */
  values?: ParameterValues
  /** The toggles that apply to the model (`toggleRows`). */
  toggles?: ModelInfoToggle[]
  /** The rules of each input image of a request (dez.provider/inputImageRules). */
  inputImages?: ProviderInputImageRules
  /** `dez.cost` (`modelCost`). Absent when the call did not ask for it. */
  cost?: ModelInfoCost
  /** The model's raw entry in a model list of the provider's media API. */
  mediaEntry?: unknown
  /** The model's price records, for a provider whose model lists hold no
   *  prices (dez.provider/mediaQuote). */
  priceEntry?: unknown
  /** The known limits of the model (dez.provider/knownLimits). */
  limits?: KnownLimit[]
}

/** The price of a model in a `model_info` result: the provider's price of
 *  one request with the values of the call, else the rates of the
 *  provider's model list (`ModelInfo.price`) in USD, each under a name
 *  that tells its unit, else why Dez has no price. */
export type ModelInfoCost =
  | { usd: number, note?: string }
  | { usdPer1MInputTokens: number, usdPer1MOutputTokens: number, usdPer1MCachedInputTokens?: number, usdPer1MCacheWriteTokens?: number, note?: string }
  | { usdPer1MCharacters: number, usdPer1000Characters: number, note?: string }
  | { usdPerSecond: number, note?: string }
  | { usdPerImage: number, note?: string }
  | { usdPerClip: number, note?: string }
  | { error: string }

function listPriceCost(price: ModelPrice): ModelInfoCost {
  const note = price.note === undefined ? {} : { note: price.note }
  switch (price.unit) {
    case 'token':
      return {
        usdPer1MInputTokens: price.input,
        usdPer1MOutputTokens: price.output,
        ...(price.cachedInput !== undefined && { usdPer1MCachedInputTokens: price.cachedInput }),
        ...(price.cacheWrite !== undefined && { usdPer1MCacheWriteTokens: price.cacheWrite }),
        ...note,
      }
    case 'character': return { usdPer1MCharacters: price.usd, usdPer1000Characters: roundedPrice(price.usd / 1000), ...note }
    case 'second': return { usdPerSecond: price.usd, ...note }
    case 'image': return { usdPerImage: price.usd, ...note }
    case 'clip': return { usdPerClip: price.usd, ...note }
  }
}

/** The `dez.cost` of a model, from the provider's answer to the price
 *  request of one request (dez.provider/mediaQuote; null for a model with
 *  no such request) and the model's list price. The quote wins: it is for
 *  the values of the call, and the list price is for the default values.
 *  So does its error, which tells why those values have no one price. */
export function modelCost(provider: ProviderInfo, model: ModelInfo, quote: ProviderMediaQuote | null): ModelInfoCost {
  if (quote?.usd !== undefined) return { usd: quote.usd, ...(quote.note !== undefined && { note: quote.note }) }
  if (quote?.error !== undefined) return { error: quote.error }
  if (model.price) return listPriceCost(model.price)
  if (quote?.records !== undefined) {
    return {
      error: `${provider.name} gives no one price of a request with these values: its price records are in \`priceEntry\`. `
        + 'Call model_info with `part: priceEntry` when this result does not hold it.',
    }
  }
  return { error: `${provider.name} gives no price for this model.` }
}

/** The provider and the model of a `model_info` call, among the models that
 *  `model_list` lists: the model that the `model` argument names
 *  (`namedModelTarget`), else `replyModel`, the model of the reply that
 *  makes the call.
 *
 *  Throws as `namedModelTarget` does. The reply's own model can be missing
 *  from the list too, as a reply needs no cached model: the last model
 *  check of its provider failed, or the provider's list has the model no
 *  more. That is not a fault of the call, and the error says so. */
export function modelInfoTarget(cache: ModelCache, providers: readonly ProviderInfo[], args: ToolArguments, replyModel: ModelRef): ModelTarget {
  if (args.model !== undefined) return namedModelTarget(cache, providers, String(args.model), 'Leave out `model` to get the info of your own model.')
  const { provider, model } = listedModel(cache, providers, replyModel)
  if (provider && model) return { provider, model }
  throw new ToolError(`Dez cannot give the info of your own model (${JSON.stringify(modelRefKey(replyModel))}) now: it is not among the models that model_list lists. `
    + 'The last model check of its provider can have failed. This is not a fault of the call: tell the user. '
    + `To get the info of another model, give its full id in \`model\`. ${FIND_MODELS}`)
}

/** What the `part` or the `only` argument of a call asks for; undefined for
 *  a call with neither. Throws for a `part` that is no entry, for an `only`
 *  that names no part or a word that is no part, and for a call with both;
 *  the model reads the error. `only` takes the words in any case and order,
 *  split at commas and white space, as `model_list` takes its type lists;
 *  the selection has them in result order. */
export function modelInfoSelection(args: ToolArguments): ModelInfoSelection | undefined {
  if (args.part !== undefined && args.only !== undefined) {
    throw new ToolError('Use `part` or `only`, not both: `part` gives one entry of the provider, and `only` gives `usage`, `dez.parameters`, or `dez.cost`.')
  }
  if (args.part !== undefined) {
    const part = MODEL_INFO_PARTS.find((name) => name === args.part)
    if (!part) throw new ToolError(`${JSON.stringify(args.part)} is not an entry of a model_info result. Use one of: ${MODEL_INFO_PARTS.join(', ')}.`)
    return { part }
  }
  if (args.only === undefined) return undefined

  const valid = `a comma list of: ${MODEL_INFO_ONLY_VALUES.join(', ')}`
  const words = argumentWords(args, 'only').map((word) => word.toLowerCase())
  if (words.length === 0) throw new ToolError(`\`only\` names no part. Use ${valid}, or leave out \`only\` to get the whole result.`)
  const unknown = [...new Set(words.filter((word) => !MODEL_INFO_ONLY_VALUES.some((value) => value === word)))]
  if (unknown.length > 0) throw new ToolError(unknownValuesText('only', unknown, valid))
  return { only: MODEL_INFO_ONLY_VALUES.filter((value) => words.includes(value)) }
}

function prettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2)
}

// The image limits of a chat request to `model`: the most images and
// `asset_view` pictures of one request (`imageLimitOf`), and the most of
// one message when that is fewer (`messageImageLimitOf`). A model with no
// limit of a request has no such number: JSON has no Infinity. Undefined
// with neither.
function chatImageLimits(model: ModelInfo): Record<string, number> | undefined {
  const request = imageLimitOf(model)
  const message = messageImageLimitOf(model)
  const limits = {
    ...(Number.isFinite(request) && { maxImagesPerRequest: request }),
    ...(message < request && { maxImagesPerMessage: message }),
  }
  return Object.keys(limits).length > 0 ? limits : undefined
}

// The facts that Dez uses, as it uses them. A fact that the provider does
// not tell gets the value that Dez acts on, and `unknown` names it; the
// release date, on which Dez does not act, is then only in `unknown`. Image
// input, thinking, tools, and the context window are facts of their own
// only for a chat request, so a model of another kind gets the first three
// only when the provider tells them (`inputs` tells whether a media request
// sends images), and no window. A window that the provider does not tell
// is the one of the model's family (`contextWindowOf`), and so are the
// image limits of a chat model that reads images (`chatImageLimits`).
// `model` holds the image rules of the parameter values that a request
// sends (`modelInfoText`).
function dezFacts(model: ModelInfo, facts: ModelInfoFacts, supportsThinking: boolean): Record<string, unknown> {
  const kind = effectiveRequest(model)
  const chat = kind === 'chat'
  // With no `thinking` in its provider's config, Dez asks no model for
  // thinking and drops the reasoning of its replies (`supportsThinking`).
  const thinking = supportsThinking ? model.thinking : false
  const told = {
    request: model.request,
    outputs: model.outputs,
    released: model.released,
    ...(chat && { imageInput: model.imageInput, toolCalling: model.toolCalling, thinking, contextWindow: model.contextWindow }),
  }
  const unknown = Object.entries(told).flatMap(([name, value]) => (value === undefined ? [name] : []))
  const mediaKind = kind === 'chat' || kind === 'none' ? undefined : kind
  const maxImages = mediaKind && maxInputImages(mediaKind, model.images)
  const chatImages = chat && model.imageInput !== false ? chatImageLimits(model) : undefined
  const { size, limits } = facts.inputImages ?? {}
  const cannotUse = kind === 'none'
    ? unusableModelMessage(model.name, model)
    : model.unstoredOutput === undefined ? undefined : unstoredOutputMessage(model.name, model.unstoredOutput)
  const values = facts.values ?? {}
  return {
    request: kind,
    outputs: effectiveOutputs(model),
    inputs: modelInputs(model),
    ...(model.released !== undefined && { released: model.released }),
    ...((chat || model.imageInput !== undefined) && { imageInput: model.imageInput !== false }),
    ...((chat || model.toolCalling !== undefined) && { toolCalling: model.toolCalling !== false }),
    ...((chat || model.thinking !== undefined) && { thinking: thinking !== false }),
    ...(chat && { contextWindow: contextWindowOf(model) }),
    ...(chatImages && { images: chatImages }),
    ...(unknown.length > 0 && { unknown }),
    ...(facts.toggles !== undefined && facts.toggles.length > 0 && { toggles: facts.toggles }),
    ...(model.unsupportedSettings && { togglesNotTaken: model.unsupportedSettings }),
    ...(model.text && { text: model.text }),
    // `maxImages` is left out when the request takes every image: JSON has
    // no Infinity. `references`: the images go as references of a video,
    // not as its frames, and `promptName` is the name of each in the prompt
    // (`mediaRequestInput`).
    ...(mediaKind && {
      images: {
        minImages: minInputImages(mediaKind, model.images),
        ...(Number.isFinite(maxImages) && { maxImages }),
        ...(model.images?.references && { references: true }),
        ...(model.images?.references?.promptName !== undefined && { promptName: model.images.references.promptName }),
        ...(size && { size }),
        ...(limits && { limits }),
      },
    }),
    // What the model takes of the clips that a message names, by kind
    // (`mediaRequestInput`, `generateMedia`).
    ...(model.clips && { clips: model.clips }),
    // The options come from the provider's entries, so they get the same
    // stand-ins.
    ...(model.parameters && {
      parameters: model.parameters.map((parameter) => jsonWithoutLocalPaths({
        ...parameter,
        ...(Object.hasOwn(values, parameter.name) && { value: values[parameter.name] }),
      })),
    }),
    ...(facts.cost && { cost: facts.cost }),
    ...(model.unstoredOutput !== undefined && { unstoredOutput: model.unstoredOutput }),
    ...(cannotUse !== undefined && { cannotUse }),
    ...(facts.limits !== undefined && facts.limits.length > 0 && { limits: facts.limits }),
  }
}

// The result with `part`: the id and that entry alone. When the result with
// all of the entry is over the cap, the entry goes as the start of its JSON
// text, and the result stays within the cap. The note gives the length of
// that whole result, as that is the length that was checked: the entry's own
// text is shorter (in the result each of its lines has 2 more spaces), and
// can be under the cap.
function partText(id: string, part: ModelInfoPart, value: unknown): string {
  const whole = prettyJson({ id, [part]: value })
  if (whole.length <= MODEL_INFO_SIZE_CAP) return whole

  const text = prettyJson(value)
  const note = `\`${part}\` is cut: with all of it, this result would have ${whole.length} characters, over the limit of ${MODEL_INFO_SIZE_CAP}. `
    + `So \`${part}\` is the start of its JSON text, which has ${text.length} characters.`
  const cut = (length: number) => prettyJson({ id, [part]: text.slice(0, length), note })
  // The escapes of the JSON string make the result longer than the text,
  // so the longest start that fits is searched for.
  let low = 0
  let high = text.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (cut(middle).length <= MODEL_INFO_SIZE_CAP) low = middle
    else high = middle - 1
  }
  return cut(low)
}

// The result with `only`: the id and the parts that it names, under their
// names in the whole result. It has no entry, so it never needs the cap.
// A note tells that the model has no parameters, so that the calling
// model does not look for them again.
function onlyText(id: string, dez: Readonly<Record<string, unknown>>, usage: readonly string[], only: readonly ModelInfoOnlyValue[]): string {
  const kept = (['parameters', 'cost'] as const).filter((name) => only.includes(name) && dez[name] !== undefined)
  const noParameters = only.includes('parameters') && dez.parameters === undefined
  return prettyJson({
    id,
    ...(kept.length > 0 && { dez: Object.fromEntries(kept.map((name) => [name, dez[name]])) }),
    ...(only.includes('usage') && { usage }),
    ...(noParameters && { note: 'Dez knows no parameters of this model.' }),
  })
}

/** The `model_info` result for a model: pretty JSON with its full id, name,
 *  provider, the facts that Dez uses (`dez`), how to use it (`usage`), and
 *  the provider's entries (`facts.entry` as `providerEntry`, `mediaEntry`,
 *  `priceEntry`). The whole result always has `dez` and `usage`. An entry
 *  is left out when the result would be over MODEL_INFO_SIZE_CAP characters
 *  with it, and `note` names each left-out entry with its size. With a
 *  `part` selection, the result is only the id and that entry (`partText`);
 *  it throws when the model has no such entry. With `only`, it is only the
 *  id and the parts that `only` names (`onlyText`).
 *
 *  The local file paths in the entries go as stand-ins (localPaths.ts).
 *  This is done here, and not when a request is built, because the result
 *  is stored in its `<dez:tool>` block as it was sent, and the prompt cache
 *  needs the same bytes in each later request. The model's own id and name
 *  stay as they are, even when a local server uses a path as the id: Dez
 *  needs the id to call the model, and `model_list` gives both. */
export function modelInfoText(provider: ProviderInfo, model: ModelInfo, facts: ModelInfoFacts = {}, selection?: ModelInfoSelection): string {
  const id = modelRefKey({ providerId: provider.id, modelId: model.id })
  const raw: Record<ModelInfoPart, unknown> = { providerEntry: facts.entry, mediaEntry: facts.mediaEntry, priceEntry: facts.priceEntry }

  if (selection && 'part' in selection) {
    const { part } = selection
    if (raw[part] === undefined) throw new ToolError(`Dez has no ${part} for this model now. Call model_info without \`part\` to see which entries it has.`)
    return partText(id, part, jsonWithoutLocalPaths(raw[part]))
  }

  // The image rules of a model can depend on its parameter values
  // (`InputImageRules.whenParameter`): the facts and the usage tell the
  // rules of the values that a request sends now, with the most images
  // that a refusal of the provider told, when that is lower (its row in
  // `dez.limits` tells where it comes from).
  const kind = effectiveRequest(model)
  const ownImages = inputImageRulesFor(model.images, facts.values ?? {})
  const images = kind === 'chat' || kind === 'none' ? ownImages : imageRulesWithLearnedLimit(kind, ownImages, model.learnedImageLimit)
  const requestModel: ModelInfo = { ...model, ...(images && { images }) }
  const dez = dezFacts(requestModel, facts, provider.supportsThinking)
  const usage = modelUsage(requestModel, { toggles: facts.toggles ?? [], inputImages: facts.inputImages ?? {} })
  if (selection) return onlyText(id, dez, usage, selection.only)

  const info = { id, name: model.name, provider: { id: provider.id, name: provider.name }, dez, usage }
  const entries = MODEL_INFO_PARTS.flatMap((name) => (raw[name] === undefined ? [] : [{ name, value: jsonWithoutLocalPaths(raw[name]) }]))
  const noEntry = facts.entry === undefined ? ['Dez has no entry from the provider\'s model list for this model now. Try again later.'] : []
  const sizes = new Map(entries.map(({ name, value }) => [name, prettyJson(value).length]))
  const render = (kept: readonly ModelInfoPart[], leftOut: readonly ModelInfoPart[]) => {
    const notes = [
      ...noEntry,
      ...(leftOut.length > 0
        ? [`Left out to stay within ${MODEL_INFO_SIZE_CAP} characters: ${leftOut.map((name) => `${name} (${sizes.get(name)} characters)`).join(', ')}. `
          + 'Call model_info again with `part` set to one of these names to get that entry alone.']
        : []),
    ]
    return prettyJson({
      ...info,
      ...Object.fromEntries(entries.filter(({ name }) => kept.includes(name)).map(({ name, value }) => [name, value])),
      ...(notes.length > 0 && { note: notes.join(' ') }),
    })
  }

  // Each entry, in order, stays when the result fits with it while every
  // entry after it is still counted as left out: the note only gets
  // shorter when a later entry stays, so the final result fits too.
  const kept: ModelInfoPart[] = []
  const leftOut: ModelInfoPart[] = []
  entries.forEach(({ name }, index) => {
    const rest = entries.slice(index + 1).map((entry) => entry.name)
    if (render([...kept, name], [...leftOut, ...rest]).length <= MODEL_INFO_SIZE_CAP) kept.push(name)
    else leftOut.push(name)
  })
  return render(kept, leftOut)
}
