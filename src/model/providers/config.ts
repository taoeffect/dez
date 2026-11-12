import * as z from 'zod'
import { MODEL_OUTPUT_IDS } from '../modelOutputs'
import { BUILT_IN_PROVIDER_IDS } from './builtins'
import { THINKING_SETTING_KEY } from './thinking'
import { TOOLS_SETTING_KEY } from './toolsSetting'
import { MEDIA_KINDS, MODEL_REQUESTS } from './types'

// Provider ids are JSON keys in provider_keys.json, the `provider` half of a
// conversation header's `model: provider/model` (split at the first `/`), and
// model picker group keys, so they use a small charset with no `/`.
const PROVIDER_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

// Ids are also keys of plain objects (model cache, errors, provider
// settings) and of the picker's Favorites group. `Object.prototype` names
// such as `__proto__` and `constructor` would replace or read inherited
// members instead of an entry.
const RESERVED_PROVIDER_IDS = new Set(['__favorites__'])

export function isValidProviderId(value: string): boolean {
  return PROVIDER_ID_PATTERN.test(value)
    && !(value in Object.prototype)
    && !RESERVED_PROVIDER_IDS.has(value)
}

// Request paths are added to the base URL as text, so a query or fragment
// would swallow them. Test the text for `?` and `#`: an empty query or
// fragment (`…/v1?`) has `URL.search`/`URL.hash` of ''. The base URL is saved
// in plain text in app_state.json, so it must not hold a user name or password.
function isValidBaseUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:')
      && !/[?#]/.test(value)
      && !url.username
      && !url.password
  } catch {
    return false
  }
}

export function trimTrailingSlashes(url: string): string {
  return url.replace(/\/+$/, '')
}

export const API_FORMAT_IDS = ['openai', 'anthropic'] as const

// Wire formats of a provider's own image, audio, and video API (`mediaApi`;
// mediaFormats.ts tells which request kinds each one serves).
export const MEDIA_API_FORMAT_IDS = ['venice', 'openrouter'] as const

const providerIdSchema = z.string().refine(
  isValidProviderId,
  'Provider id must be 1-64 letters, digits, "-" or "_", and not a reserved name',
)

export const providerModelConfigSchema = z.object({
  id: z.string().trim().min(1, 'Model id must not be empty'),
  // Display name; the id is shown when it is missing.
  name: z.string().trim().min(1).optional(),
  // Whether the model reads images. Wins over the flag the server reports
  // (`modelImageInput`); missing: the server's flag, or unknown.
  imageInput: z.boolean().optional(),
  // Whether the model calls tools. Wins over the flag the server reports
  // (`modelToolCalling`); missing: the server's flag, or unknown.
  toolCalling: z.boolean().optional(),
  // Whether the model thinks, for a provider with `thinking`. Wins over the
  // flag the server reports (`modelThinking`); missing: the server's flag,
  // or unknown.
  thinking: z.boolean().optional(),
  // What the model makes. Wins over what the server reports; missing: the
  // server's outputs, or unknown. A config model is always listed, so it
  // must make at least one type.
  outputs: z.array(z.enum(MODEL_OUTPUT_IDS)).min(1, 'Model outputs must not be empty').optional(),
  // How Dez sends the model a request. Wins over the server's kind; missing:
  // the server's kind, or `chat`.
  request: z.enum(MODEL_REQUESTS).optional(),
})

// A dot path into one `/models` entry, such as
// 'architecture.input_modalities' (modelParsing.ts).
const modelEntryPathSchema = z.string().refine(
  (path) => path.split('.').every((segment) => segment.length > 0),
  'Model entry path must be dot-separated names, none empty',
)

// Where a `/models` entry says whether the model has a capability. A boolean
// there is the flag; a list means "has it" when it holds the capability's
// list value ("image" for `modelImageInput`, "tools" for
// `modelToolCalling`, "reasoning" for `modelThinking`, and the first name of
// the toggle's `bodyPath` for `settings[].modelSupport`); anything else is
// unknown (modelParsing.ts). `missing` is the flag of an entry with no value
// at the path, for a server that leaves out a capability the model lacks;
// without it, no value is unknown.
const modelCapabilityPathSchema = z.object({
  path: modelEntryPathSchema,
  missing: z.boolean().optional(),
})

const settingBodyValueSchema = z.union([z.string(), z.number(), z.boolean()])

// One toggle in the model picker's provider settings popup. The toggle state
// is stored under `key` in settings.providerSettings[providerId], and a chat
// request to a model that the toggle applies to writes the matching value at
// `bodyPath` (`modelToggles` in modelToggles.ts). The Thinking and Tools
// toggles are stored there too, so their keys are reserved.
export const providerSettingDefSchema = z.object({
  key: z.string().min(1)
    .refine((key) => key !== THINKING_SETTING_KEY, `Setting key "${THINKING_SETTING_KEY}" is reserved for the Thinking toggle`)
    .refine((key) => key !== TOOLS_SETTING_KEY, `Setting key "${TOOLS_SETTING_KEY}" is reserved for the Tools toggle`),
  label: z.string().trim().min(1),
  type: z.literal('boolean'),
  default: z.boolean(),
  // Dot path in the chat request body, e.g. 'venice_parameters.enable_web_search'.
  // A `__proto__` segment would make the body writer in provider.ts assign
  // the object's prototype instead of a JSON field, so the value would be lost.
  bodyPath: z.string().refine(
    (path) => path.split('.').every((segment) => segment.length > 0 && segment !== '__proto__'),
    'Body path must be dot-separated names, none empty or "__proto__"',
  ),
  // Written when the toggle is on (default true) / off (default false).
  onValue: settingBodyValueSchema.optional(),
  offValue: settingBodyValueSchema.optional(),
  // The toggle applies only to model ids that start with this prefix.
  modelIdPrefix: z.string().min(1).optional(),
  // Where the server's model list says whether a model takes the toggle. It
  // does not apply to a model that is known not to take it
  // (`ModelInfo.unsupportedSettings`).
  modelSupport: modelCapabilityPathSchema.optional(),
})

// The native HTTP bridge (reqwest) cannot send a header whose name is not an
// HTTP token, or whose value has a control character other than tab. It then
// fails every request with only "builder error", so reject such headers here.
// Zod reports a bad record key as "Invalid key in record" and drops the key
// schema's own message, so the record's `error` option sets that message.
const headersSchema = z.record(
  z.string().regex(/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/),
  z.string().refine(
    (value) => !/[\x00-\x08\x0A-\x1F\x7F]/.test(value),
    'Header value must not contain a line break or a control character other than tab',
  ),
  {
    error: (issue) => issue.code === 'invalid_key'
      ? 'Header name must not be empty and may use only letters, digits, and !#$%&\'*+-.^_`|~'
      : undefined,
  },
)

// Object.prototype names. A request body part may not use them as keys at any
// depth, and the merge into the chat body and the stream parsers skip them,
// so neither reads or sets an inherited member.
export const FORBIDDEN_BODY_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype'])

function hasForbiddenBodyKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasForbiddenBodyKey)
  if (value === null || typeof value !== 'object') return false
  return Object.entries(value).some(([key, entry]) => FORBIDDEN_BODY_KEYS.has(key) || hasForbiddenBodyKey(entry))
}

// A JSON object that is deep-merged into the chat request body. Zod's record
// and JSON schemas silently drop a `__proto__` key (JSON.parse makes it an
// own property), so the raw input is checked before them.
const requestBodyPartSchema = z.unknown()
  .refine((value) => !hasForbiddenBodyKey(value), 'Body keys must not be "__proto__", "constructor", or "prototype"')
  .pipe(z.record(z.string(), z.json()))

// Present: the provider supports thinking. Dez asks for it as the user's
// Thinking toggle says, and shows the thinking the provider streams. Absent:
// Dez sends no thinking fields, ignores reasoning in replies, and shows no
// toggle.
const thinkingConfigSchema = z.object({
  // Merged when the toggle is on. Absent: the API format's default request
  // (adaptive, summarized thinking for Anthropic; nothing for OpenAI).
  enabledBody: requestBodyPartSchema.optional(),
  // Merged when the toggle is off. Absent: nothing, because many models
  // refuse a request that turns thinking off.
  disabledBody: requestBodyPartSchema.optional(),
})

// What a model makes and how Dez sends it a request, from the type that its
// `/models` entry reports at `path` (a string is one type, a list is many).
// `values` maps each raw type to its outputs and request kind. A type with
// no `request` gives `none` (Dez cannot use the model yet); a model whose
// types make no outputs (embeddings) is left out of the list. Types
// missing from `values` are skipped, and an entry with no known type stays
// unknown (a chat model, as with no config). How many types combine:
// modelParsing.ts.
const modelOutputsConfigSchema = z.object({
  path: modelEntryPathSchema,
  values: z.record(z.string(), z.object({
    outputs: z.array(z.enum(MODEL_OUTPUT_IDS)),
    request: z.enum(MODEL_REQUESTS).optional(),
    // The type counts only for an entry that has a value at this path;
    // else it is skipped, like a type that `values` does not name. For a
    // server that reports a type that the model cannot make: OpenRouter's
    // routers (`openrouter/auto`) report "image", but they have no image
    // price, and they refuse a request that asks for image output.
    requiredPath: modelEntryPathSchema.optional(),
    // For a server whose type does not tell the request kind: a second
    // value of the entry, at `path`, does. A value that `values` names
    // gives its kind (a boolean value by its text, `true` or `false`); any
    // other value, or none, gives `request`. Venice reports every video
    // model as `video`, and only `model_spec.constraints.model_type` tells
    // a model that needs just a text (`text-to-video`) from one that needs
    // an image or a video.
    requestBy: z.object({
      path: modelEntryPathSchema,
      values: z.record(z.string(), z.enum(MODEL_REQUESTS)),
    }).optional(),
  })),
})

// The whole definition of a provider. Built-ins are literals of this type and
// custom providers are the same JSON in app_state.json, so one Provider class
// serves both. Put every difference between providers in this data (headers,
// maxOutputTokens, settings, thinking), never in a branch on the provider id.
// Behavior that depends on the sign-in reads `auth` ('githubCopilot').
export const providerConfigSchema = z.object({
  id: providerIdSchema,
  name: z.string().trim().min(1, 'Name must not be empty'),
  // OpenAI format: include `/v1`. Anthropic format: SDK style, without `/v1`.
  baseUrl: z.string()
    .trim()
    .overwrite(trimTrailingSlashes)
    .refine(isValidBaseUrl, 'Base URL must be an http:// or https:// URL with no query, fragment, user name, or password'),
  apiFormat: z.enum(API_FORMAT_IDS).default('openai'),
  // Always listed; merged in front of the models the server reports.
  models: z.array(providerModelConfigSchema).default(() => []),
  // false: never call the models endpoint, list only `models`.
  fetchModels: z.boolean().default(true),
  // Query parameters of the model-list request, for a server that lists only
  // its chat models unless asked (Venice `type=all`). A field of its own,
  // because `baseUrl` may not hold a query.
  modelListQuery: z.record(z.string(), z.string()).optional(),
  modelImageInput: modelCapabilityPathSchema.optional(),
  modelToolCalling: modelCapabilityPathSchema.optional(),
  // Which models think, for a provider with `thinking`: a model that is known
  // not to think gets no Thinking toggle and no thinking fields.
  modelThinking: modelCapabilityPathSchema.optional(),
  modelOutputs: modelOutputsConfigSchema.optional(),
  auth: z.enum(['apiKey', 'githubCopilot']).default('apiKey'),
  // Static headers added to every request.
  headers: headersSchema.optional(),
  // Added only to a chat request that sends an image, after `headers`.
  imageRequestHeaders: headersSchema.optional(),
  // Anthropic `max_tokens`; the OpenAI format ignores it.
  maxOutputTokens: z.number().int().positive().optional(),
  // OpenAI format: mark the last two user messages (or tool results) with
  // Anthropic's `cache_control`, for a server that passes the marks on to the
  // models that cache only a marked prompt (Claude). The Anthropic format
  // always marks them (apiFormats.ts).
  cacheBreakpoints: z.boolean().optional(),
  // OpenAI format with `cacheBreakpoints`: where a `tool` message takes its
  // mark. `part` (the default): on its content as one text part, as a user
  // message does. `message`: on the message itself, the content staying a
  // string. Servers differ: Venice drops a part mark on a tool message and
  // uses a message mark (checked live); OpenRouter uses a part mark, and a
  // message mark on a tool message can hang the request there (live report:
  // https://github.com/NousResearch/hermes-agent/issues/57845).
  toolMessageCacheMark: z.enum(['part', 'message']).optional(),
  // OpenAI format: send the conversation id as `prompt_cache_key`, so the
  // server sends all the requests of a conversation to the machine that
  // holds its prompt cache. The Anthropic format ignores it.
  promptCacheKey: z.boolean().optional(),
  // A fixed part of every chat request body, merged right after the API
  // format's body and before the settings and the thinking body, so those can
  // add keys to the same objects.
  requestBody: requestBodyPartSchema.optional(),
  // Merged into the body of a chat request to a model whose known outputs
  // hold `image` (ModelInfo.outputs), right after `requestBody`: the part
  // asks the server for image output (OpenRouter's `modalities`). Missing:
  // no chat request asks for images. Only the OpenAI format reads the
  // images of a reply (openaiSse.ts).
  imageOutputBody: requestBodyPartSchema.optional(),
  // The wire format of the provider's own image, audio, and video requests.
  // Missing: the provider has none, so its media models get no requests. A
  // request of a kind that the format does not serve fails the same way.
  mediaApi: z.object({
    format: z.enum(MEDIA_API_FORMAT_IDS),
    // Fixed parts of the body of the request that asks for an image or a
    // clip, for a fact about a model that no model list tells. A part is
    // merged (as `requestBody` is) into a request of the kind `request` to a
    // model whose id starts with `modelIdPrefix`, after the format's own
    // fields and the values of the model's parameters, so it wins over
    // both. The parts go in list order. OpenRouter's entries do not tell
    // which speech models answer only with raw PCM.
    modelRequestBodies: z.array(z.object({
      request: z.enum(MEDIA_KINDS),
      modelIdPrefix: z.string().min(1),
      body: requestBodyPartSchema,
    })).optional(),
  }).optional(),
  settings: z.array(providerSettingDefSchema).optional(),
  thinking: thinkingConfigSchema.optional(),
})

// Custom providers come from app_state.json or Settings. They cannot take a
// built-in id, and GitHub Copilot sign-in exists only for the built-in.
export const customProviderConfigSchema = providerConfigSchema.extend({
  id: providerIdSchema.refine(
    (id) => !BUILT_IN_PROVIDER_IDS.includes(id),
    'Provider id belongs to a built-in provider',
  ),
  auth: z.literal('apiKey', 'Custom providers use API key auth').default('apiKey'),
})

// Zod issues as "path: message" text. Zod messages name the expected type or
// values, never the input, so this is safe to log for configs that hold keys
// (a hand-added `apiKey`, or a key in `headers`).
export function configIssueText(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.map(String).join('.') || '(entry)'}: ${issue.message}`)
    .join('; ')
}

export type ApiFormatId = (typeof API_FORMAT_IDS)[number]
export type ProviderSettingDef = z.infer<typeof providerSettingDefSchema>
export type ProviderConfig = z.infer<typeof providerConfigSchema>
export type ProviderThinkingConfig = z.infer<typeof thinkingConfigSchema>
export type ModelCapabilityPath = z.infer<typeof modelCapabilityPathSchema>
export type ModelOutputsConfig = z.infer<typeof modelOutputsConfigSchema>
export type MediaApiFormatId = (typeof MEDIA_API_FORMAT_IDS)[number]
export type ProviderAuth = ProviderConfig['auth']
