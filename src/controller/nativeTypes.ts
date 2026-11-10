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

// The folders that the app-file selectors reach (`FileRoot` in
// src-tauri/src/persistence.rs): the app folder, and Dez's folder in the OS
// cache folder.
export type AppFileRoot = 'app' | 'cache'

// A path relative to a root, with `/` between folders.
export interface AppFileRef {
  root: AppFileRoot
  path: string
}

// One file of `dez.native/listAppFiles`. `updatedAt` is in milliseconds since
// the Unix epoch.
export interface AppFileEntry {
  name: string
  updatedAt: number
}
