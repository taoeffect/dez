import sbp from '@sbp/sbp'
import { parseAnthropicSseData } from '../../model/providers/anthropicSse'
import { parseOpenAiSseData } from '../../model/providers/openaiSse'
import { isProviderId, type ModelInfo, type ProviderId, type ProviderSpec } from '../../model/providers'
import { providerStreamProtocol } from '../../model/providers/requests'
import { decodeSseData } from '../../utils/protocol/sse'
import { secret, type Secret } from '../../utils/secret'
import type { ProviderFetchProbeResult } from './providerFetchTypes'

export function providerSecretError(): Error {
  return new Error('Provider is not configured')
}

export async function configuredProviderIds(): Promise<ProviderId[]> {
  const ids = await sbp('dez.native/getConfiguredProviderIds') as string[]
  return ids.filter(isProviderId)
}

export async function providerSecret(providerId: ProviderId): Promise<Secret<string> | null> {
  const value = await sbp('dez.native/getProviderSecret', providerId) as string | null
  return value ? secret(value) : null
}

export function resolveRequestedProviders(requestedProviders?: ProviderId[]): Promise<ProviderId[]> {
  if (!requestedProviders) {
    return configuredProviderIds()
  }

  for (const providerId of requestedProviders) {
    if (!isProviderId(providerId)) {
      const error = new Error(`Unknown provider: ${providerId}`)
      console.error(error)
      throw error
    }
  }

  return Promise.resolve(requestedProviders)
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
  providerId: ProviderId,
  spec: ProviderSpec,
  models: ModelInfo[],
  modelOverride?: Partial<Record<ProviderId, string>>,
): string {
  const override = modelOverride?.[providerId]
  if (override) {
    return override
  }

  if (providerId === 'copilot') {
    const copilotModel = selectCopilotSpikeModel(models)
    if (copilotModel) {
      return copilotModel
    }
  }

  const listedModel = models[0]
  if (listedModel) {
    return listedModel.id
  }

  return spec.fallbackModels?.[0]?.id ?? ''
}

export async function readFirstToken(providerId: ProviderId, chunks: AsyncIterable<Uint8Array>): Promise<boolean> {
  const parseData = providerStreamProtocol(providerId) === 'anthropic'
    ? parseAnthropicSseData
    : parseOpenAiSseData

  for await (const data of decodeSseData(chunks)) {
    for (const event of parseData(data)) {
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
