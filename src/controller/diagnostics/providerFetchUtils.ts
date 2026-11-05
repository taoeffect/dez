import sbp from '@sbp/sbp'
import { requireProvider, type ModelInfo, type Provider, type ProviderId, type ProviderInfo, type SseTokenEvent } from '../../model/providers'
import { decodeSseData } from '../../utils/protocol/sse'
import type { ProviderFetchProbeResult } from './providerFetchTypes'

export function providerSecretError(): Error {
  return new Error('Provider is not configured')
}

// Every provider that can be used now: built-ins with a key, GitHub Copilot
// when signed in, and providers that need no key.
async function configuredProviderIds(): Promise<ProviderId[]> {
  const providers = await sbp('dez.provider/infos') as ProviderInfo[]
  return providers.filter((provider) => provider.configured).map((provider) => provider.id)
}

export async function resolveRequestedProviders(requestedProviders?: ProviderId[]): Promise<Provider[]> {
  const providerIds = requestedProviders ?? await configuredProviderIds()

  return providerIds.map(requireProvider)
}

function modelMatchesNameOrId(model: ModelInfo, value: string): boolean {
  const normalizedValue = value.toLowerCase()
  return model.id.toLowerCase().includes(normalizedValue) || model.name.toLowerCase().includes(normalizedValue)
}

function selectCopilotSpikeModel(models: ModelInfo[]): string | null {
  const exactFull = models.find((model) => model.id === 'gpt-5.4' || model.name.toLowerCase() === 'gpt-5.4')
  if (exactFull) {
    return exactFull.id
  }

  const exact = models.find((model) => modelMatchesNameOrId(model, 'gpt-5.4'))
  if (exact) {
    return exact.id
  }

  const gpt5 = models.find((model) => modelMatchesNameOrId(model, 'gpt-5'))
  return gpt5?.id ?? null
}

export function selectProbeModel(
  provider: Provider,
  models: ModelInfo[],
  modelOverride?: Partial<Record<ProviderId, string>>,
): string {
  const override = modelOverride?.[provider.id]
  if (override) {
    return override
  }

  if (provider.config.auth === 'githubCopilot') {
    const copilotModel = selectCopilotSpikeModel(models)
    if (copilotModel) {
      return copilotModel
    }
  }

  const listedModel = models[0] ?? provider.configModels()[0]
  return listedModel?.id ?? ''
}

// Thinking text counts too: a model that thinks first sends it before any
// answer text.
export async function readFirstToken(provider: Provider, chunks: AsyncIterable<Uint8Array>): Promise<boolean> {
  const parser = provider.format.createStreamParser(provider.supportsThinking)
  let ended = false
  const hasToken = (events: SseTokenEvent[]): boolean => {
    for (const event of events) {
      if (event.kind === 'done') {
        ended = true
        return false
      }
      if (event.token.length > 0) return true
    }
    return false
  }

  for await (const data of decodeSseData(chunks)) {
    if (hasToken(parser.parse(data))) return true
    if (ended) break
  }

  // Text held back for a possible inline tag comes out only at the end, also
  // when the stream ended with `[DONE]`.
  if (hasToken(parser.finish().events)) return true
  if (ended) return false
  throw new Error('No token received before stream ended')
}

function status(ok: boolean, error: string | null): string {
  return ok ? 'ok' : `fail${error ? ` (${error})` : ''}`
}

function chatStatus(ok: boolean, streaming: boolean, error: string | null): string {
  if (!ok) {
    return status(false, error)
  }

  return `ok, streaming: ${streaming ? 'yes' : 'no'}`
}

export function buildProviderFetchReport(results: ProviderFetchProbeResult[]): string {
  const lines = ['Provider native HTTP diagnostic report', '']

  for (const result of results) {
    lines.push(`${result.providerId} (${result.modelId || 'no model selected'})`)
    lines.push(`  native models: ${status(result.nativeModelsOk, result.nativeModelsError)}`)
    lines.push(`  native chat: ${chatStatus(result.nativeChatOk, result.nativeChatStreaming, result.nativeChatError)}`)
    lines.push('')
  }

  const nativeReady = results.length > 0 && results.every((result) => result.nativeModelsOk && result.nativeChatOk && result.nativeChatStreaming)

  lines.push('Summary')
  lines.push(nativeReady ? '  Native HTTP is ready for all probed providers.' : '  Review failed native HTTP probes above.')

  return lines.join('\n')
}
