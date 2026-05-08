import sbp from '@sbp/sbp'
import { invoke, type Channel } from '@tauri-apps/api/core'
import type {
  NativeHttpRequest,
  NativeHttpResponse,
  NativeHttpStreamEvent,
} from '../core/protocol/nativeHttp'
import type {
  ConversationFile,
  CopilotChatToken,
  CopilotDeviceFlowResponse,
  LatestRelease,
} from './types'

// TODO: in the future, use the star selector here to just directly invoke these
// without having to have a copy of every rust-function here. You'll have to forgive the AI.

export default sbp('sbp/selectors/register', {
  'dez.native/getProviderSecret' (providerId: string): Promise<string | null> {
    return invoke<string | null>('get_provider_secret', { providerId })
  },

  'dez.native/getCopilotChatToken' (): Promise<CopilotChatToken> {
    return invoke<CopilotChatToken>('get_copilot_chat_token')
  },

  'dez.native/saveProviderSecret' (providerId: string, secret: string): Promise<void> {
    return invoke('save_provider_secret', { providerId, secret })
  },

  'dez.native/getConfiguredProviderIds' (): Promise<string[]> {
    return invoke<string[]>('get_configured_provider_ids')
  },

  'dez.native/httpRequest' (request: NativeHttpRequest): Promise<NativeHttpResponse> {
    return invoke<NativeHttpResponse>('http_request', { request })
  },

  'dez.native/streamHttp' (request: NativeHttpRequest, requestId: string, onEvent: Channel<NativeHttpStreamEvent>): Promise<void> {
    return invoke('stream_http', { request, requestId, onEvent })
  },

  'dez.native/cancelHttpStream' (requestId: string): Promise<void> {
    return invoke('cancel_http_stream', { requestId })
  },

  'dez.native/getLatestRelease' (): Promise<LatestRelease> {
    return invoke<LatestRelease>('get_latest_release')
  },

  'dez.native/copilotStartDeviceFlow' (): Promise<CopilotDeviceFlowResponse> {
    return invoke<CopilotDeviceFlowResponse>('copilot_start_device_flow')
  },

  'dez.native/copilotPollDeviceFlow' (deviceCode: string): Promise<boolean> {
    return invoke<boolean>('copilot_poll_device_flow', { deviceCode })
  },

  'dez.native/saveConversationFile' (id: string, content: string): Promise<void> {
    return invoke('save_conversation_file', { id, content })
  },

  'dez.native/loadConversationFile' (id: string): Promise<string> {
    return invoke<string>('load_conversation_file', { id })
  },

  'dez.native/listConversationFiles' (): Promise<ConversationFile[]> {
    return invoke<ConversationFile[]>('list_conversation_files')
  },

  'dez.native/deleteConversationFile' (id: string): Promise<void> {
    return invoke('delete_conversation_file', { id })
  },

  'dez.native/saveAppStateJson' (content: string): Promise<void> {
    return invoke('save_app_state_json', { content })
  },

  'dez.native/loadAppStateJson' (): Promise<string> {
    return invoke<string>('load_app_state_json')
  },

  'dez.native/savePromptsJson' (content: string): Promise<void> {
    return invoke('save_prompts_json', { content })
  },

  'dez.native/loadPromptsJson' (): Promise<string> {
    return invoke<string>('load_prompts_json')
  },
})
