import * as z from 'zod'
import { BUILT_IN_PROVIDER_IDS } from './builtins'

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

const providerIdSchema = z.string().refine(
  isValidProviderId,
  'Provider id must be 1-64 letters, digits, "-" or "_", and not a reserved name',
)

export const providerModelConfigSchema = z.object({
  id: z.string().trim().min(1, 'Model id must not be empty'),
  // Display name; the id is shown when it is missing.
  name: z.string().trim().min(1).optional(),
})

const settingBodyValueSchema = z.union([z.string(), z.number(), z.boolean()])

// One toggle in the model picker's provider settings popup. The toggle state
// is stored under `key` in settings.providerSettings[providerId], and every
// chat request writes the matching value at `bodyPath`.
const providerSettingDefSchema = z.object({
  key: z.string().min(1),
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
  // Show the toggle only for model ids that start with this prefix.
  modelIdPrefix: z.string().min(1).optional(),
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

// The whole definition of a provider. Built-ins are literals of this type and
// custom providers are the same JSON in app_state.json, so one Provider class
// serves both.
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
  auth: z.enum(['apiKey', 'githubCopilot']).default('apiKey'),
  // Static headers added to every request.
  headers: headersSchema.optional(),
  // Anthropic `max_tokens`; the OpenAI format ignores it.
  maxOutputTokens: z.number().int().positive().optional(),
  settings: z.array(providerSettingDefSchema).optional(),
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
export type ProviderAuth = ProviderConfig['auth']
