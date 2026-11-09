import sbp from '@sbp/sbp'
import { invoke, type Channel } from '@tauri-apps/api/core'
import { save, type SaveDialogOptions } from '@tauri-apps/plugin-dialog'
import { writeTextFile } from '@tauri-apps/plugin-fs'
import type {
  NativeHttpRequest,
  NativeHttpResponse,
  NativeHttpStreamEvent,
} from '../utils/protocol/nativeHttp'
import type { ConversationFile } from '../model/persistence/types'
import type {
  CopilotChatToken,
  CopilotDeviceFlowResponse,
  NativeMonitors,
} from './nativeTypes'

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

  'dez.native/deleteProviderSecret' (providerId: string): Promise<void> {
    return invoke('delete_provider_secret', { providerId })
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

  'dez.native/listConversationFiles' (includeContent: boolean): Promise<ConversationFile[]> {
    return invoke<ConversationFile[]>('list_conversation_files', { includeContent })
  },

  'dez.native/deleteConversationFile' (id: string): Promise<void> {
    return invoke('delete_conversation_file', { id })
  },

  // `path` is relative to the app folder, with `/` between folders
  // (`assets/images/<uuid>.png`). The content goes as the raw IPC body, so
  // bytes are not sent as a JSON number array; text goes as UTF-8. The path
  // goes unencoded in a header: the Rust path rule (`app_file_path` in
  // src-tauri/src/persistence.rs) allows only header-safe ASCII.
  'dez.native/saveAppFile' (path: string, content: string | Uint8Array): Promise<void> {
    const body = typeof content === 'string' ? new TextEncoder().encode(content) : content
    return invoke('save_app_file', body, { headers: { path } })
  },

  // A missing file reads as ''.
  'dez.native/loadAppFile' (path: string): Promise<string> {
    return invoke<string>('load_app_file', { path })
  },

  // Rejects when the file is missing.
  async 'dez.native/loadAppFileBytes' (path: string): Promise<Uint8Array> {
    return new Uint8Array(await invoke<ArrayBuffer>('load_app_file_bytes', { path }))
  },

  // A missing file is not an error.
  'dez.native/deleteAppFile' (path: string): Promise<void> {
    return invoke('delete_app_file', { path })
  },

  'dez.native/getAppDir' (): Promise<string> {
    return invoke<string>('get_app_dir')
  },

  'dez.native/isWindowFullscreen' (): Promise<boolean> {
    return invoke<boolean>('is_window_fullscreen')
  },

  // Tauri's `availableMonitors()` and `primaryMonitor()`, read on the main
  // thread; see `monitors` in src-tauri/src/commands.rs for why.
  'dez.native/monitors' (): Promise<NativeMonitors> {
    return invoke<NativeMonitors>('monitors')
  },

  // "x11", "wayland", or another GDK backend name on Linux; null on the other
  // platforms (src-tauri/src/commands.rs `gdk_backend`).
  'dez.native/gdkBackend' (): Promise<string | null> {
    return invoke<string | null>('gdk_backend')
  },

  'dez.native/openDevtools' (): Promise<void> {
    return invoke('open_devtools')
  },

  // `onClick` gets one message when the user clicks the notification, after
  // Rust brought the window to the front. It resolves when the notification
  // shows; the wait for a click goes on in Rust.
  'dez.native/showNotification' (title: string, body: string, onClick: Channel<null>): Promise<void> {
    return invoke('show_notification', { title, body, onClick })
  },

  // Milliseconds since the last user input anywhere on the computer, or null
  // when this desktop gives no idle time (src-tauri/src/idle.rs).
  'dez.native/userIdleMs' (): Promise<number | null> {
    return invoke<number | null>('user_idle_ms')
  },

  // Returns the chosen path, or null when the user cancels. The dialog
  // plugin adds that exact path to the fs scope, so `writeTextFile` below
  // may write only files that the user picked here.
  'dez.native/showSaveDialog' (options: SaveDialogOptions): Promise<string | null> {
    return save(options)
  },

  'dez.native/writeTextFile' (path: string, content: string): Promise<void> {
    return writeTextFile(path, content)
  },
})
