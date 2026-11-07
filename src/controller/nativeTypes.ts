import type { MonitorInfo } from './windowFit'

export interface LatestRelease {
  version: string
  url: string
}

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
