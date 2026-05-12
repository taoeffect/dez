import type { ModelInfo, ProviderId } from '../../model/providers'

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

export interface ModelProbeResult {
  ok: boolean
  error: string | null
  models: ModelInfo[]
}

export interface ChatProbeResult {
  ok: boolean
  error: string | null
  streaming: boolean
}
