import sbp from '@sbp/sbp'
import { requireProvider, type ModelInfo, type Provider, type ProviderId, type ProviderInfo } from '../../model/providers'
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

export async function readFirstToken(provider: Provider, chunks: AsyncIterable<Uint8Array>): Promise<boolean> {
  for await (const data of decodeSseData(chunks)) {
    for (const event of provider.format.parseSseData(data)) {
      if (event.kind === 'done') {
        return false
      }

      if (event.token.length > 0) {
        return true
      }
    }
  }

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
