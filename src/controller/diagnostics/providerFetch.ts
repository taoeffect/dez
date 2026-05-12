import sbp from '@sbp/sbp'
import { secret, type Secret } from '../../utils/secret'
import { responseOk } from '../../utils/protocol/errors'
import { bytesFromNativeBody, nativeRequestFromFetch, nativeResponseJson, type NativeHttpResponse, type NativeHttpStreamResult } from '../../utils/protocol/nativeHttp'
import { assertProviderResponseOk, providerStatusError } from '../../model/providers/errors'
import { providerChatRequest } from '../../model/providers/requests'
import { getProviderSpec, type ChatMessage, type ModelInfo, type ProviderId, type ProviderSpec, isProviderId } from '../../model/providers'

export interface ProviderFetchProbeResult {
  providerId: string
  modelId: string
  nativeChatOk: boolean
  nativeChatError: string | null
  nativeChatStreaming: boolean
  nativeModelsOk: boolean
  nativeModelsError: string | null
}

export interface ProviderFetchSpikeOptions {
  providers?: ProviderId[]
  prompt?: string
  modelOverride?: Partial<Record<ProviderId, string>>
}

interface ModelProbeResult {
  ok: boolean
  error: string | null
  models: ModelInfo[]
}

interface ChatProbeResult {
  ok: boolean
  error: string | null
  streaming: boolean
}

function sanitizeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  return raw
    .replace(/Authorization\s*[:=]\s*Bearer\s+[^\s,'"}]+/gi, 'Authorization: Bearer [redacted]')
    .replace(/Bearer\s+[^\s,'"}]+/gi, 'Bearer [redacted]')
    .replace(/((?:api[_-]?key|token|authorization)\s*[=:]\s*)[^&\s,'"}]+/gi, '$1[redacted]')
    .replace(/[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}/g, '[redacted]')
    .slice(0, 500)
}

function providerSecretError(): Error {
  return new Error('Provider is not configured')
}

async function configuredProviderIds(): Promise<ProviderId[]> {
  const ids = await sbp('dez.native/getConfiguredProviderIds') as string[]
  return ids.filter(isProviderId)
}

async function providerSecret(providerId: ProviderId): Promise<Secret<string> | null> {
  const value = await sbp('dez.native/getProviderSecret', providerId) as string | null
  return value ? secret(value) : null
}

function resolveRequestedProviders(options?: ProviderFetchSpikeOptions): Promise<ProviderId[]> {
  if (!options?.providers) {
    return configuredProviderIds()
  }

  for (const providerId of options.providers) {
    if (!isProviderId(providerId)) {
      const error = new Error(`Unknown provider: ${providerId}`)
      console.error(error)
      throw error
    }
  }

  return Promise.resolve(options.providers)
}

async function probeModelList(spec: ProviderSpec, providerSecretValue: Secret<string> | null): Promise<ModelProbeResult> {
  try {
    const options = spec.buildModelListRequest(providerSecretValue)
    if (!options) {
      throw providerSecretError()
    }

    const request = {
      ...nativeRequestFromFetch(spec.modelsUrl, options),
      timeoutMs: 20000,
    }
    const response = await sbp('dez.http/request', request) as NativeHttpResponse
    const responseText = new TextDecoder().decode(bytesFromNativeBody(response.body))
    assertProviderResponseOk(response, spec.id, responseText)
    const data = nativeResponseJson<unknown>(response)
    return {
      ok: true,
      error: null,
      models: spec.parseModels(data),
    }
  } catch (error) {
    return {
      ok: false,
      error: sanitizeError(error),
      models: [],
    }
  }
}

function modelMatchesNameOrId(model: ModelInfo, value: string): boolean {
  const normalizedValue = value.toLowerCase()
  return model.id.toLowerCase().includes(normalizedValue) || model.name.toLowerCase().includes(normalizedValue)
}

function selectCopilotSpikeModel(nativeModels: ModelProbeResult): string | null {
  const exactFull = nativeModels.models.find((model) => model.id === 'gpt-5.4' || model.name.toLowerCase() === 'gpt-5.4')
  if (exactFull) {
    return exactFull.id
  }

  const exact = nativeModels.models.find((model) => modelMatchesNameOrId(model, 'gpt-5.4'))
  if (exact) {
    return exact.id
  }

  const gpt5 = nativeModels.models.find((model) => modelMatchesNameOrId(model, 'gpt-5'))
  return gpt5?.id ?? null
}

function selectModel(
  providerId: ProviderId,
  spec: ProviderSpec,
  nativeModels: ModelProbeResult,
  options?: ProviderFetchSpikeOptions,
): string {
  const override = options?.modelOverride?.[providerId]
  if (override) {
    return override
  }

  if (providerId === 'copilot') {
    const copilotModel = selectCopilotSpikeModel(nativeModels)
    if (copilotModel) {
      return copilotModel
    }
  }

  const listedModel = nativeModels.models[0]
  if (listedModel) {
    return listedModel.id
  }

  return spec.fallbackModels?.[0]?.id ?? ''
}

function chatRequestForProvider(
  spec: ProviderSpec,
  providerSecretValue: Secret<string> | null,
  messages: ChatMessage[],
  modelId: string,
) {
  if (!providerSecretValue) {
    throw providerSecretError()
  }

  return providerChatRequest(spec, spec.id, messages, modelId, providerSecretValue)
}
function sseBlocks(buffer: string): { blocks: string[]; rest: string } {
  const parts = buffer.split(/\r?\n\r?\n/)
  return {
    blocks: parts.slice(0, -1),
    rest: parts[parts.length - 1] ?? '',
  }
}

function sseData(block: string): string | null {
  const lines = block.split(/\r?\n/)
  const dataLines = lines
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())

  return dataLines.length > 0 ? dataLines.join('\n') : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isTerminalData(data: string): boolean {
  const trimmed = data.trim()
  if (trimmed === '[DONE]') {
    return true
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown
    return isRecord(parsed) && (parsed.type === 'message_stop' || parsed.type === 'done')
  } catch {
    return false
  }
}

function hasTokenData(data: string): boolean {
  const trimmed = data.trim()
  if (!trimmed || trimmed === '[DONE]') {
    return false
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown
    if (!isRecord(parsed)) {
      return false
    }

    const choices = parsed.choices
    if (Array.isArray(choices)) {
      return choices.some((choice) => {
        if (!isRecord(choice)) {
          return false
        }

        const delta = choice.delta
        if (isRecord(delta) && typeof delta.content === 'string' && delta.content.length > 0) {
          return true
        }

        const message = choice.message
        return isRecord(message) && typeof message.content === 'string' && message.content.length > 0
      })
    }

    const delta = parsed.delta
    if (isRecord(delta) && typeof delta.text === 'string' && delta.text.length > 0) {
      return true
    }

    const content = parsed.content
    return typeof content === 'string' && content.length > 0
  } catch {
    return false
  }
}

async function readFirstToken(chunks: AsyncIterable<Uint8Array>): Promise<boolean> {
  const decoder = new TextDecoder()
  let buffer = ''

  for await (const chunk of chunks) {
    buffer += decoder.decode(chunk, { stream: true })
    const parsed = sseBlocks(buffer)
    buffer = parsed.rest
    const eventData = parsed.blocks
      .map(sseData)
      .filter((data): data is string => data !== null)

    for (let index = 0; index < eventData.length; index += 1) {
      const data = eventData[index]
      if (hasTokenData(data)) {
        const terminalAfterToken = eventData.slice(index + 1).some(isTerminalData)
        return !terminalAfterToken
      }
    }
  }

  throw new Error('No token received before stream ended')
}

async function streamBodyText(chunks: AsyncIterable<Uint8Array>, maxLength = 1000): Promise<string> {
  const decoder = new TextDecoder()
  let text = ''

  for await (const chunk of chunks) {
    const part = decoder.decode(chunk, { stream: true })
    if (text.length < maxLength) {
      text = `${text}${part}`.slice(0, maxLength)
    }
  }

  if (text.length < maxLength) {
    text = `${text}${decoder.decode()}`.slice(0, maxLength)
  }

  return text
}

async function probeChat(
  spec: ProviderSpec,
  providerSecretValue: Secret<string> | null,
  modelId: string,
  prompt: string,
): Promise<ChatProbeResult> {
  if (!modelId) {
    return {
      ok: false,
      error: 'No model available for provider',
      streaming: false,
    }
  }

  let result: NativeHttpStreamResult | null = null
  let timeoutId: ReturnType<typeof setTimeout> | null = null
  let timedOut = false

  try {
    const messages: ChatMessage[] = [{ role: 'user', content: prompt }]
    const request = chatRequestForProvider(spec, providerSecretValue, messages, modelId)
    result = await sbp('dez.http/stream', request) as NativeHttpStreamResult

    if (!responseOk(result.response)) {
      const text = await streamBodyText(result.chunks)
      throw providerStatusError(spec.id, result.response, text)
    }

    const streaming = await Promise.race([
      readFirstToken(result.chunks),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          timedOut = true
          reject(new Error('Probe timed out before first token'))
        }, 20000)
      }),
    ])
    return {
      ok: true,
      error: null,
      streaming,
    }
  } catch (error) {
    return {
      ok: false,
      error: sanitizeError(timedOut ? new Error('Probe timed out before first token') : error),
      streaming: false,
    }
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId)
    }
    if (result) {
      await sbp('dez.http/cancelStream', result.requestId).catch(() => undefined)
    }
  }
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

function buildReport(results: ProviderFetchProbeResult[]): string {
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

export default sbp('sbp/selectors/register', {
  async 'dez.diagnostics/runProviderFetchSpike' (options?: ProviderFetchSpikeOptions): Promise<ProviderFetchProbeResult[]> {
    const providerIds = await resolveRequestedProviders(options)
    const results: ProviderFetchProbeResult[] = []
    const prompt = options?.prompt ?? 'ping'

    for (const providerId of providerIds) {
      const spec = getProviderSpec(providerId)
      if (!spec) {
        const error = new Error(`Unknown provider: ${providerId}`)
        console.error(error)
        throw error
      }

      const providerSecretValue = await providerSecret(providerId)
      const nativeModels = await probeModelList(spec, providerSecretValue)
      const modelId = selectModel(providerId, spec, nativeModels, options)
      const nativeChat = await probeChat(spec, providerSecretValue, modelId, prompt)

      results.push({
        providerId,
        modelId,
        nativeChatOk: nativeChat.ok,
        nativeChatError: nativeChat.error,
        nativeChatStreaming: nativeChat.streaming,
        nativeModelsOk: nativeModels.ok,
        nativeModelsError: nativeModels.error,
      })
    }

    return results
  },

  'dez.diagnostics/printProviderFetchReport' (results: ProviderFetchProbeResult[]): string {
    const report = buildReport(results)
    console.log(report)
    return report
  },
})
