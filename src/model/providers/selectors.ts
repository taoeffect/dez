import sbp from '@sbp/sbp'
import { IMAGE_FOLDER, imageMediaType, storedImageFile } from '../chat/images'
import type { MessagePart } from '../chat/types'
import { modelRefKey } from '../chat/modelRef'
import type { ModelCache } from '../persistence/types'
import { bytesToBase64 } from '../../utils/base64'
import { fileNameOf } from '../../utils/fileName'
import { secret, type Secret } from '../../utils/secret'
import { nativeResponseJson, nativeResponseText, type NativeHttpResponse, type NativeHttpStreamResult } from '../../utils/protocol/nativeHttp'
import { assertProviderResponseOk } from './errors'
import type { Provider, ProviderChatRequest } from './provider'
import { getProvider, listProviders, requireProvider } from './registry'
import { streamProviderTokens } from './streaming'
import type { ProviderChatInputMessage, ProviderStreamChatInput, ProviderStreamChatResult } from './streamTypes'
import { ProviderNotConfiguredError, type ChatMessage, type ChatPart, type ModelDisplayNames, type ProviderId, type ProviderInfo, type ProviderModelsResult, type ProviderSettingsDescriptor } from './types'

// The stored key, or null when there is none. Throws for GitHub Copilot when
// the user is not signed in.
export async function providerSecret(providerId: ProviderId): Promise<Secret<string> | null> {
  const value = await sbp('dez.native/getProviderSecret', providerId) as string | null
  return value ? secret(value) : null
}

async function refreshCopilotSecret(): Promise<Secret<string>> {
  const value = await sbp('dez.native/getCopilotChatToken') as { token: string }
  return secret(value.token)
}

// Providers that do not require a key send requests without auth headers
// when no key is stored, or when the key store cannot be read (like
// dez.provider/infos, which then treats them as configured).
async function requestSecret(provider: Provider, refreshCopilot = false): Promise<Secret<string> | null> {
  let value: Secret<string> | null
  try {
    value = refreshCopilot ? await refreshCopilotSecret() : await providerSecret(provider.id)
  } catch (error) {
    if (provider.requiresKey) throw error
    console.error(`Failed to read the API key of provider ${provider.id}:`, error)
    value = null
  }

  if (!value && provider.requiresKey) {
    throw new ProviderNotConfiguredError(provider.id)
  }

  return value
}

// The messages with the bytes of each image part, read once for the request
// and its Copilot retry. The app folder is read only when a message has an
// image.
async function readMessageImages(messages: ProviderChatInputMessage[]): Promise<ChatMessage[]> {
  let appDir: Promise<string> | undefined
  const readPart = async (part: MessagePart): Promise<ChatPart> => {
    if (part.type === 'text') return part
    appDir ??= sbp('dez.native/getAppDir') as Promise<string>
    return readImagePart(part.path, await appDir)
  }

  return Promise.all(messages.map(async ({ content, ...message }) => ({
    ...message,
    content: typeof content === 'string' ? content : await Promise.all(content.map(readPart)),
  })))
}

// Only a stored image of this Dez folder is read (`storedImageFile`): the
// folder that dez.controller/images/save writes and the asset protocol
// serves. So a reference copied from another home or machine fails like a
// missing file, as it shows in the editor. The error names only the file,
// like the editor's broken-image box; the log has the cause.
async function readImagePart(path: string, appDir: string): Promise<ChatPart> {
  try {
    const file = storedImageFile(path, appDir)
    const mediaType = imageMediaType(path)
    if (!file || !mediaType) {
      throw new Error(`The image is not in the image folder ${appDir}/${IMAGE_FOLDER}`)
    }
    const bytes = await sbp('dez.native/loadAppFileBytes', file) as Uint8Array
    return { type: 'image', mediaType, data: bytesToBase64(bytes) }
  } catch (error) {
    console.error(`Failed to read the image ${path}:`, error)
    throw new Error(`Image not found: ${fileNameOf(path)}`)
  }
}

async function nativeChatStream(
  provider: Provider,
  input: ProviderStreamChatInput,
  messages: ChatMessage[],
  requestId: string,
  refreshCopilot = false,
): Promise<{ result: NativeHttpStreamResult, thinking: ProviderChatRequest['thinking'] }> {
  const secretValue = await requestSecret(provider, refreshCopilot)
  const context = { conversationId: input.conversationId, system: input.system, tools: input.tools }
  const { request, thinking } = provider.chatRequest(messages, input.modelId, secretValue, input.providerSettings, context)
  return { result: await sbp('dez.http/stream', request, requestId) as NativeHttpStreamResult, thinking }
}

export default sbp('sbp/selectors/register', {
  async 'dez.provider/infos' (): Promise<ProviderInfo[]> {
    let keyIds: string[] = []
    try {
      keyIds = await sbp('dez.native/getConfiguredProviderIds') as string[]
    } catch (error) {
      // Still list every provider, as if no key were stored, so providers
      // that need no key stay usable.
      console.error('Failed to read configured provider ids:', error)
    }

    const keys = new Set(keyIds)
    return listProviders().map((provider) => provider.info(keys))
  },

  // Synchronous read for the provider settings popup: the provider's display
  // name, the toggles shown for this model, and whether it has the Thinking
  // toggle, instead of the whole Provider. Takes a plain string, so views need
  // no id check; null for unknown ids.
  'dez.provider/settingsDescriptor' (providerId: string, modelId: string): ProviderSettingsDescriptor | null {
    const provider = getProvider(providerId)
    return provider
      ? { name: provider.name, settings: provider.visibleSettings(modelId), supportsThinking: provider.supportsThinking }
      : null
  },

  // Synchronous and reactive: it reads the custom providers and the model
  // cache through model selectors, so a view computed over it updates when
  // either changes. A name set in a provider config beats the cached name,
  // because the cache keeps the name from the last fetch and a config edit
  // does not refetch.
  'dez.provider/modelDisplayNames' (): ModelDisplayNames {
    const providers = new Map<ProviderId, string>()
    const models = new Map<string, string>()

    const cache = sbp('dez.model/modelCache/snapshot') as ModelCache
    for (const [providerId, entry] of Object.entries(cache.providers)) {
      for (const model of entry?.models ?? []) {
        models.set(modelRefKey({ providerId, modelId: model.id }), model.name)
      }
    }

    for (const provider of listProviders()) {
      providers.set(provider.id, provider.name)
      for (const model of provider.config.models) {
        if (model.name) models.set(modelRefKey({ providerId: provider.id, modelId: model.id }), model.name)
      }
    }

    return { providers, models }
  },

  // Never throws for a known provider: every failure becomes `ok: false`, the
  // basis for the provider's "working" status in the model cache.
  async 'dez.provider/listModelsResult' (providerId: ProviderId): Promise<ProviderModelsResult> {
    const provider = requireProvider(providerId)

    try {
      const request = provider.modelListRequest(await requestSecret(provider))
      if (!request) {
        return { ok: true, models: provider.configModels() }
      }

      const response = await sbp('dez.native/httpRequest', request) as NativeHttpResponse
      assertProviderResponseOk(response, provider, nativeResponseText(response))
      return { ok: true, models: provider.mergeModels(provider.parseModels(nativeResponseJson<unknown>(response))) }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`Failed to list models for provider ${providerId}:`, error)
      return { ok: false, models: [], error: message }
    }
  },

  async 'dez.provider/streamChat' (input: ProviderStreamChatInput): Promise<ProviderStreamChatResult> {
    const provider = requireProvider(input.providerId)
    const requestId = input.requestId ?? crypto.randomUUID()
    const messages = await readMessageImages(input.messages)
    let stream = await nativeChatStream(provider, input, messages, requestId)

    // A 401 can mean the cached Copilot chat token expired early; get a fresh
    // one and retry once. The refused response is never parsed, so its
    // thinking cannot mix with the retry's.
    if (provider.config.auth === 'githubCopilot' && stream.result.response.status === 401) {
      await sbp('dez.http/cancelStream', stream.result.requestId)
      stream = await nativeChatStream(provider, input, messages, requestId, true)
    }

    const thinkingReplay = await streamProviderTokens(provider, input, stream.result, stream.thinking)
    return thinkingReplay
      ? { requestId: stream.result.requestId, thinkingReplay }
      : { requestId: stream.result.requestId }
  },
})
