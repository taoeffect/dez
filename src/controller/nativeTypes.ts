import type { MonitorInfo } from './windowFit'

export interface CopilotDeviceFlowResponse {
  user_code: string
  verification_uri: string
  device_code: string
}

export interface CopilotChatToken {
  token: string
  expires_at: number
}

// `monitors` in src-tauri/src/commands.rs: Tauri `Monitor`s.
export interface NativeMonitors {
  monitors: MonitorInfo[]
  primary: MonitorInfo | null
}

// One message on the progress channel of `download_update`
// (src-tauri/src/updater/mod.rs `DownloadProgress`): one at 0, then one per
// 256 KiB, and a last one when the download succeeded. `total` is null when
// the server sends no length.
export interface UpdateDownloadProgress {
  received: number
  total: number | null
}

// What `install_update` did: `replaced` the app, or staged its new
// executable for the relaunch helper (`binary`).
export type UpdateInstallMode = 'replaced' | 'binary'
