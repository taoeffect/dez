// The user's Tools toggle (the "Tools" row of the model picker's gear popup,
// ProviderSettingsPopup.vue) is stored with the popup toggles, under this
// key in settings.providerSettings[providerId]. A provider config may not use
// it as a `settings[]` key (config.ts refuses it). Off: requests to that
// provider offer no Dez tools, for a server that refuses every request with a
// `tools` field because its model cannot call tools (e.g. some Ollama
// models).
export const TOOLS_SETTING_KEY = 'tools'

// The stored toggles are sparse: a provider whose toggle the user never
// flipped gets the tools.
export const TOOLS_DEFAULT = true
