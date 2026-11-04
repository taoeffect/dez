// Data only: config.ts imports this file at run time, so it may import only
// types, or an import cycle appears.
import type { ProviderConfig } from './config'

// The providers that ship with the app. They are the same JSON a user can add
// as a custom provider. They skip the schema at run time, so every field the
// schema would fill in is written out here (config.test.ts checks this).
export const BUILT_IN_PROVIDER_CONFIGS: readonly ProviderConfig[] = [
  {
    id: 'openrouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiFormat: 'openai',
    models: [],
    fetchModels: true,
    auth: 'apiKey',
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
  },
  {
    id: 'venice',
    name: 'Venice',
    baseUrl: 'https://api.venice.ai/api/v1',
    apiFormat: 'openai',
    models: [],
    fetchModels: true,
    auth: 'apiKey',
    // Every request sends all four `venice_parameters`, with these defaults
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
      {
        key: 'veniceSystemPrompt',
        label: 'Venice system prompt',
        type: 'boolean',
        default: false,
        bodyPath: 'venice_parameters.include_venice_system_prompt',
      },
    ],
  },
  {
    id: 'charm_hyper',
    name: 'Charm Hyper',
    baseUrl: 'https://hyper.charm.land/v1',
    apiFormat: 'openai',
    models: [],
    fetchModels: true,
    auth: 'apiKey',
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
  },
  {
    id: 'copilot',
    name: 'GitHub Copilot',
    baseUrl: 'https://api.githubcopilot.com',
    apiFormat: 'openai',
    models: [],
    fetchModels: true,
    auth: 'githubCopilot',
    // The Copilot API expects the headers of a supported editor integration.
    headers: {
      'Editor-Version': 'vscode/1.97.2',
      'Editor-Plugin-Version': 'copilot-chat/0.24.2',
      'User-Agent': 'GitHubCopilotChat/0.24.2',
      'Copilot-Integration-Id': 'vscode-chat',
    },
  },
]

export const BUILT_IN_PROVIDER_IDS: readonly string[] = BUILT_IN_PROVIDER_CONFIGS.map((config) => config.id)
