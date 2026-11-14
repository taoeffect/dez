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

// One file of `dez.native/listAppFiles`, or one folder when the call asks
// for the folders. `updatedAt` is in milliseconds since the Unix epoch (for
// a folder: the last time that it got or lost a file), and `size` is in
// bytes (0 for a folder).
export interface AppFileEntry {
  name: string
  updatedAt: number
  size: number
}

// The programs that Dez ships and can run (`bundle.externalBin` in
// src-tauri/tauri.conf.json).
export type BundledTool = 'dez-ffmpeg' | 'dez-ffprobe'

// A file that a run gets in its work folder before the program starts: a
// copy of the file at the absolute path `source`, with the file name `name`.
// A program can write to the copy; the file at `source` stays as it is.
export interface BundledToolInput {
  name: string
  source: string
}

// One run of `dez.native/runBundledTool` (`ToolRun` in bundled_tools.rs).
export interface BundledToolRun {
  tool: BundledTool
  args: string[]
  // The work folder, as a path in the cache root: the program runs in it,
  // so a relative path in `args` names a file of it. It is made when it is
  // missing, and only the user can open it. More than one run can use one
  // folder; an input whose `name` the folder has is refused.
  folder: string
  inputs: BundledToolInput[]
  // The time limit of the program. The input copies do not count.
  timeoutMs: number
  // The most bytes of output (stdout and stderr together) that a run gives.
  // A program that writes more is stopped.
  maxOutputBytes: number
}

export interface BundledToolOutput {
  stream: 'stdout' | 'stderr'
  text: string
}

// How a run ended. `code` is null when a signal that Dez did not send ended
// the program. For every kind but `exited`, Dez stopped the program, and it
// is gone when the run ends.
export type BundledToolEnd =
  | { kind: 'exited', code: number | null }
  | { kind: 'timedOut' }
  | { kind: 'cancelled' }
  | { kind: 'outputTooLarge' }

// The channel events of a run (`ToolRunEvent` in bundled_tools.rs). `end` is
// the last one.
export type BundledToolEvent =
  | { kind: 'output', data: BundledToolOutput }
  | { kind: 'end', data: BundledToolEnd }
