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

// What a path of `dez.native/listFileTree` is. `other` is all that is no
// regular file and no folder: a link (the listing follows none), a named
// pipe, a socket.
export type FileTreeEntryKind = 'file' | 'folder' | 'other'

// One file, folder, or other entry below the folder of a tree listing.
// `path` is from that folder, with `/` between folders; it can hold a name
// that is no valid path segment of the app-file selectors (a script of an
// app can make any name). `size` is in bytes, and 0 for all but a file.
// `updatedAt` is in milliseconds since the Unix epoch; null when the time
// cannot be read, so never take such an entry for an old one.
export interface FileTreeEntry {
  path: string
  kind: FileTreeEntryKind
  size: number
  updatedAt: number | null
}

// What `dez.native/listFileTree` gives: the facts of the path itself
// (`missing`: nothing is there) and, for a folder, the entries below it, in
// no fixed order. `more` tells that the folder holds more entries than the
// call asked for.
export interface FileTree {
  kind: FileTreeEntryKind | 'missing'
  size: number
  updatedAt: number | null
  entries: FileTreeEntry[]
  more: boolean
}

// The programs that Dez ships and can run (`bundle.externalBin` in
// src-tauri/tauri.conf.json). The backend has the rules of each one
// (`ProgramRules` in bundled_tools.rs): what its `args` are, which folders
// it can open, and whether it runs on a computer whose OS cannot confine it.
export type BundledTool = 'dez-ffmpeg' | 'dez-ffprobe' | 'dez-deno'

// A file that a run gets in its work folder before the program starts: a
// copy of the file at the absolute path `source`, with the name `name`: a
// file name, or one subfolder and a file name (`fonts/a.ttf`), where the
// subfolder is made private as the work folder. A program can write to the
// copy; the file at `source` stays as it is.
export interface BundledToolInput {
  name: string
  source: string
}

// One run of `dez.native/runBundledTool` (`ToolRun` in bundled_tools.rs).
export interface BundledToolRun {
  tool: BundledTool
  // ffmpeg and ffprobe: the arguments of the program. Deno: only the name
  // of the script file in the work folder; the backend writes the rest of
  // the command line.
  args: string[]
  // The work folder, as a path in the cache root: the program runs in it,
  // so a relative path in `args` names a file of it. It is made when it is
  // missing, and only the user can open it. More than one run can use one
  // folder; an input whose `name` the folder has is refused. A Deno run can
  // open no file outside it, so its folder must be one folder of the work
  // root (`work/<id>`); Deno keeps its own files there in `deno-dir/`.
  folder: string
  inputs: BundledToolInput[]
  // The time limit of the program. The input copies do not count.
  timeoutMs: number
  // The most bytes of output (stdout and stderr together) that a run gives.
  // A program that writes more is stopped.
  maxOutputBytes: number
  // Whether the program gets an input that stays open to the end of the
  // run, for the texts of `dez.native/writeBundledToolInput`. Without it,
  // a program that reads its input gets the end at once.
  stdin?: boolean
  // The name of one folder of `apps/` in the app folder, which must be
  // there. The program can then read and change the files of that folder.
  // Only a Deno run can have one.
  appFolder?: string
  // The name of a built-in app: one folder of `builtin-apps/` in the files
  // that Dez ships, which the program can then only read. Only a Deno run
  // can have one, and not with `appFolder`.
  builtInApp?: string
  // The id of a conversation. The program can then read and change the
  // files of its work folder (`work/<id>` in the app folder), which the
  // backend makes when it is missing. Only a Deno run can have one.
  conversationFolder?: string
  // Whether the program can load the native library of skia-canvas, whose
  // code opens files with no check of Deno. Only a Deno run with
  // `appFolder` or `builtInApp` can have it: never the code of a model.
  nativeCanvas?: boolean
  // The time zone of the program (`Europe/Berlin`), so that its local time
  // is the one of the user: a program gets no other fact of the computer.
  timeZone?: string
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
