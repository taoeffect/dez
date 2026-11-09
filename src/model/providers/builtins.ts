// Data only: config.ts imports this file at run time, so it may import only
// types, or an import cycle appears.
import type { ProviderConfig } from './config'

// The providers that ship with the app. They are the same JSON a user can add
// as a custom provider. To add a built-in, add a literal here: it needs no
// type union, no Rust change, and no per-provider module. Built-ins skip the
// schema at run time, so every field the schema would fill in is written out
// here (config.test.ts checks this).
export const BUILT_IN_PROVIDER_CONFIGS: readonly ProviderConfig[] = [
  {
    id: 'openrouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiFormat: 'openai',
    models: [],
    fetchModels: true,
    modelImageInput: { path: 'architecture.input_modalities' },
    // A list of request fields that the model takes; it holds "tools" for a
    // model that calls tools.
    modelToolCalling: { path: 'supported_parameters' },
    auth: 'apiKey',
    // OpenRouter passes the marks on to the models that cache only a marked
    // prompt (Claude, Gemini, Qwen), and makes OpenAI's own marks of them for
    // GPT-5.6 and later.
    // https://openrouter.ai/docs/guides/best-practices/prompt-caching
    cacheBreakpoints: true,
    // OpenRouter drops a field that the routed model does not take, so the
    // request is safe for every model. Some models must think, so there is no
    // off field.
    thinking: { enabledBody: { reasoning: { enabled: true } } },
  },
  {
    id: 'zai',
    name: 'Z.ai',
    baseUrl: 'https://api.z.ai/api/coding/paas/v4',
    apiFormat: 'openai',
    // Z.ai's /models reports ids only; these give the known models names.
    models: [
      { id: 'glm-5.2', name: 'GLM 5.2' },
      { id: 'glm-5.1', name: 'GLM 5.1' },
      { id: 'glm-5', name: 'GLM 5' },
      { id: 'glm-5-turbo', name: 'GLM 5 Turbo' },
      { id: 'glm-4.7', name: 'GLM 4.7' },
      { id: 'glm-4.6', name: 'GLM 4.6' },
      { id: 'glm-4.5', name: 'GLM 4.5' },
    ],
    fetchModels: true,
    auth: 'apiKey',
    // GLM-5.3 refuses `type: 'disabled'`, so there is no off field.
    thinking: { enabledBody: { thinking: { type: 'enabled' } } },
  },
  {
    id: 'venice',
    name: 'Venice',
    baseUrl: 'https://api.venice.ai/api/v1',
    apiFormat: 'openai',
    models: [],
    fetchModels: true,
    modelImageInput: { path: 'model_spec.capabilities.supportsVision' },
    modelToolCalling: { path: 'model_spec.capabilities.supportsFunctionCalling' },
    auth: 'apiKey',
    // The Venice docs say that Venice adds the marks for Claude, but a live
    // check got no Claude cache hits without them. Its other models take the
    // marks with no error (also checked live).
    cacheBreakpoints: true,
    // A live check with Claude Haiku 5.5: a mark on a tool message's text
    // part stored nothing, a mark on the message stored the prompt up to it.
    // Its other models took the message mark with no error.
    toolMessageCacheMark: 'message',
    // In a live check, Qwen3-VL cached nothing without it.
    // https://docs.venice.ai/guides/features/prompt-caching
    promptCacheKey: true,
    // Venice adds its own system prompt when this field is missing, so every
    // request turns it off.
    requestBody: { venice_parameters: { include_venice_system_prompt: false } },
    // Every request sends these `venice_parameters` too, with these defaults
    // when the user has not changed a toggle in the provider settings popup.
    settings: [
      {
        key: 'webSearch',
        label: 'Web search',
        type: 'boolean',
        default: true,
        bodyPath: 'venice_parameters.enable_web_search',
        // Venice takes a string here ('auto' | 'on' | 'off'); the other flags
        // are booleans.
        onValue: 'on',
        offValue: 'off',
      },
      {
        key: 'xSearch',
        label: 'X search',
        type: 'boolean',
        default: true,
        bodyPath: 'venice_parameters.enable_x_search',
        // X search applies only to Grok models, and every Grok model id
        // Venice serves starts with `grok-` (e.g. grok-4-20).
        modelIdPrefix: 'grok-',
      },
      {
        key: 'webScraping',
        label: 'Web scraping',
        type: 'boolean',
        default: true,
        bodyPath: 'venice_parameters.enable_web_scraping',
      },
    ],
    // Venice's own off switch, which also removes the thinking from replies.
    thinking: {
      enabledBody: { reasoning: { enabled: true } },
      disabledBody: { venice_parameters: { disable_thinking: true } },
    },
  },
  {
    id: 'charm_hyper',
    name: 'Charm Hyper',
    baseUrl: 'https://hyper.charm.land/v1',
    apiFormat: 'openai',
    models: [],
    fetchModels: true,
    auth: 'apiKey',
    // Hyper's models think by default, and their effort levels differ per
    // model, so no field is sent.
    thinking: {},
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    baseUrl: 'https://api.minimax.io/anthropic',
    apiFormat: 'anthropic',
    models: [
      { id: 'MiniMax-M2.7', name: 'MiniMax M2.7' },
      { id: 'MiniMax-M2.7-highspeed', name: 'MiniMax M2.7 Highspeed' },
      { id: 'MiniMax-M2.5', name: 'MiniMax M2.5' },
      { id: 'MiniMax-M2.5-highspeed', name: 'MiniMax M2.5 Highspeed' },
      { id: 'MiniMax-M2.1', name: 'MiniMax M2.1' },
      { id: 'MiniMax-M2.1-highspeed', name: 'MiniMax M2.1 Highspeed' },
      { id: 'MiniMax-M2', name: 'MiniMax M2' },
    ],
    fetchModels: true,
    auth: 'apiKey',
    // MiniMax recommends 65536 output tokens for these models.
    maxOutputTokens: 65536,
    // M3 on this endpoint thinks only with `adaptive`, and M3.1-Flash refuses
    // `disabled`, so there is no off field.
    thinking: { enabledBody: { thinking: { type: 'adaptive' } } },
  },
  {
    id: 'kimi',
    name: 'Kimi',
    baseUrl: 'https://api.kimi.com/coding',
    apiFormat: 'anthropic',
    models: [
      { id: 'k3.1-pro-highspeed', name: 'Kimi K3.1 Pro Highspeed' },
      { id: 'k3', name: 'Kimi K3' },
    ],
    fetchModels: true,
    auth: 'apiKey',
    // The format's default body (adaptive, summarized) gives signed thinking
    // blocks. K3.1 Pro refuses `disabled` with a 400, so there is no off field;
    // with the toggle off the models still think, and Dez hides it. No
    // User-Agent header: requests work without one, and Kimi's terms forbid
    // a false client name.
    thinking: {},
  },
  {
    id: 'copilot',
    name: 'GitHub Copilot',
    baseUrl: 'https://api.githubcopilot.com',
    apiFormat: 'openai',
    models: [],
    fetchModels: true,
    // VS Code's Copilot Chat (microsoft/vscode, extensions/copilot) reads the
    // same flags. It sends the same header on requests with images, and it
    // sends no `tools` to a model without `tool_calls`
    // (src/platform/endpoint/node/chatEndpoint.ts). `missing: false` does the
    // same here: some models in the list, such as the embedding models, have
    // no `tool_calls` flag.
    modelImageInput: { path: 'capabilities.supports.vision' },
    modelToolCalling: { path: 'capabilities.supports.tool_calls', missing: false },
    auth: 'githubCopilot',
    // The Copilot API expects the headers of a supported editor integration.
    headers: {
      'Editor-Version': 'vscode/1.97.2',
      'Editor-Plugin-Version': 'copilot-chat/0.24.2',
      'User-Agent': 'GitHubCopilotChat/0.24.2',
      'Copilot-Integration-Id': 'vscode-chat',
    },
    imageRequestHeaders: { 'Copilot-Vision-Request': 'true' },
    // Copilot documents no thinking field, and `reasoning_effort` gives a 400
    // on models that do not list it. Its Claude and Gemini models stream
    // thinking without a field.
    thinking: {},
  },
]

export const BUILT_IN_PROVIDER_IDS: readonly string[] = BUILT_IN_PROVIDER_CONFIGS.map((config) => config.id)
