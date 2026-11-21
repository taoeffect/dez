import sbp from '@sbp/sbp'
import { Channel, invoke } from '@tauri-apps/api/core'
import { homeDir, resolveResource } from '@tauri-apps/api/path'
import { save, type SaveDialogOptions } from '@tauri-apps/plugin-dialog'
import { writeTextFile } from '@tauri-apps/plugin-fs'
import type {
  NativeDownloadRule,
  NativeHttpDownload,
  NativeHttpRequest,
  NativeHttpResponse,
  NativeHttpStreamEvent,
} from '../utils/protocol/nativeHttp'
import type { ConversationFile } from '../model/persistence/types'
import type {
  AppFileEntry,
  AppFileRef,
  AppFileRoot,
  BundledToolEnd,
  BundledToolEvent,
  BundledToolOutput,
  BundledToolRun,
  CopilotChatToken,
  CopilotDeviceFlowResponse,
  FileTree,
  LatestRelease,
} from './nativeTypes'
import { holdingCachePath } from './cacheHolds'

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

  // Stops a `streamHttp` or a `downloadAppFile` request.
  'dez.native/cancelHttpStream' (requestId: string): Promise<void> {
    return invoke('cancel_http_stream', { requestId })
  },

  // Sends a request and writes the response body to `file`, so the bytes of
  // a clip do not pass through the webview. Only a response that the rule
  // accepts is saved (`download_app_file` in src-tauri/src/http_bridge.rs);
  // read `saved` of the result. Rejects on a network error, a body over
  // `rule.maxBytes`, and a cancel. A download into the cache root holds its
  // target while it runs, so that Delete Unreferenced Files does not take
  // its files (cacheHolds.ts); every download of a clip comes here, the
  // ones of the model layer too.
  'dez.native/downloadAppFile' (request: NativeHttpRequest, requestId: string, file: AppFileRef, rule: NativeDownloadRule): Promise<NativeHttpDownload> {
    const download = () => invoke<NativeHttpDownload>('download_app_file', { request, requestId, root: file.root, path: file.path, rule })
    return file.root === 'cache' ? holdingCachePath(file.path, download) : download()
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

  'dez.native/listConversationFiles' (includeContent: boolean): Promise<ConversationFile[]> {
    return invoke<ConversationFile[]>('list_conversation_files', { includeContent })
  },

  'dez.native/deleteConversationFile' (id: string): Promise<void> {
    return invoke('delete_conversation_file', { id })
  },

  // `path` is relative to a root folder (the app folder when `root` is
  // missing), with `/` between folders (`assets/images/<uuid>.png`). The
  // content goes as the raw IPC body, so bytes are not sent as a JSON number
  // array; text goes as UTF-8. The root and the path go unencoded in
  // headers: the Rust path rule (`app_file_path` in
  // src-tauri/src/persistence.rs) allows only header-safe ASCII.
  'dez.native/saveAppFile' (path: string, content: string | Uint8Array, root: AppFileRoot = 'app'): Promise<void> {
    const body = typeof content === 'string' ? new TextEncoder().encode(content) : content
    return invoke('save_app_file', body, { headers: { root, path } })
  },

  // A missing file reads as ''.
  'dez.native/loadAppFile' (path: string): Promise<string> {
    return invoke<string>('load_app_file', { path })
  },

  // Rejects when the file is missing. In a place that programs own (the
  // cache root, and `apps/` of the app root; `is_program_owned` in
  // src-tauri/src/persistence.rs) it also rejects for all that is no regular
  // file. It has no size limit: ask `dez.native/listFileTree` for the size
  // of a file that a program can have made.
  async 'dez.native/loadAppFileBytes' (path: string, root: AppFileRoot = 'app'): Promise<Uint8Array> {
    return new Uint8Array(await invoke<ArrayBuffer>('load_app_file_bytes', { root, path }))
  },

  // A missing file is not an error. With `folder`, the path names a folder,
  // which goes with all that it holds; only a folder of the cache root, or
  // one below `apps/` of the app root, can be deleted.
  'dez.native/deleteAppFile' (path: string, root: AppFileRoot = 'app', { folder = false }: { folder?: boolean } = {}): Promise<void> {
    return invoke('delete_app_file', { root, path, folder })
  },

  // Makes a folder that only the user can open, with the missing folders
  // above it. A folder that is there already is not an error. Only in the
  // cache root, and below `apps/` of the app root. Make the folder of an app
  // with this: a save or a move makes a missing folder that others can open.
  'dez.native/createFolder' (path: string, root: AppFileRoot = 'app'): Promise<void> {
    return invoke('create_folder', { root, path })
  },

  // Moves a file, also from one root to the other. A file at `to` is
  // replaced; a missing file at `from` rejects. Only the user can read the
  // file after the move.
  //
  // A folder at `from` moves with all that it holds, where a folder can be
  // deleted (`dez.native/deleteAppFile`), and only inside one file system.
  // Unlike a file, it replaces nothing: a file or a folder at `to` rejects.
  'dez.native/moveAppFile' (from: AppFileRef, to: AppFileRef): Promise<void> {
    return invoke('move_app_file', { fromRoot: from.root, fromPath: from.path, toRoot: to.root, toPath: to.path })
  },

  // The files directly in a folder, or with `folders` the folders directly
  // in it, in no fixed order. A missing folder lists as empty. Left out: an
  // entry whose name is no valid path segment of the app-file selectors.
  'dez.native/listAppFiles' (path: string, root: AppFileRoot = 'app', { folders = false }: { folders?: boolean } = {}): Promise<AppFileEntry[]> {
    return invoke<AppFileEntry[]>('list_app_files', { root, path, folders })
  },

  // What is at a path and, for a folder, every entry below it at any depth
  // (`FileTree`). Unlike `dez.native/listAppFiles` it leaves nothing out,
  // and it follows no link. It lists at most `maxEntries` entries, so that a
  // folder which a program filled costs a known amount of work; with 0 it
  // tells only what the path is, and whether a folder holds anything.
  'dez.native/listFileTree' (path: string, maxEntries: number, root: AppFileRoot = 'app'): Promise<FileTree> {
    return invoke<FileTree>('list_file_tree', { root, path, maxEntries })
  },

  // The absolute path of a root folder.
  'dez.native/getAppDir' (root: AppFileRoot = 'app'): Promise<string> {
    return invoke<string>('get_app_dir', { root })
  },

  // Runs a program that Dez ships (src-tauri/src/bundled_tools.rs) to its
  // end, and resolves with how it ended; only `exited` is an end that the
  // program chose. `onOutput` gets the output while the program runs, as
  // pieces of text in the order of each stream (a piece is not a line).
  // Rejects when the run did not start: a bad folder path or input file, a
  // `runId` that is active, a program that is missing, a run that the rules
  // of its program refuse. The error of a program that must be confined, on
  // a computer whose OS cannot confine it, starts with `No confinement: `
  // (`NO_CONFINEMENT` in src-tauri/src/confinement.rs).
  //
  // The channel is made here, not by the caller as for `streamHttp`: the end
  // of a run is its last channel event (a command result can come before
  // the last output), so this selector can give it as its result.
  'dez.native/runBundledTool' (run: BundledToolRun, runId: string, onOutput: (output: BundledToolOutput) => void): Promise<BundledToolEnd> {
    return new Promise((resolve, reject) => {
      let outputFailed = false
      const onEvent = new Channel<BundledToolEvent>((event) => {
        if (event.kind === 'end') {
          resolve(event.data)
          return
        }
        if (outputFailed) return
        // A throw out of a channel handler stops the channel: it holds
        // every later event back, the end too. So a failure of `onOutput`
        // rejects the run here and stops the program, which has no reader
        // any more.
        try {
          onOutput(event.data)
        } catch (error) {
          outputFailed = true
          console.error('The output handler of a bundled tool failed:', error)
          reject(error)
          invoke('cancel_bundled_tool', { runId }).catch((cancelError: unknown) => {
            console.error('Failed to stop a bundled tool:', cancelError)
          })
        }
      })
      invoke('run_bundled_tool', { run, runId, onEvent }).catch(reject)
    })
  },

  // Stops a `runBundledTool` run, which then ends as `cancelled`. The
  // backend runs each command as its own task, so a cancel can come before
  // its run: the backend keeps the newest few cancels of runs that are not
  // active, and such a run starts as stopped. A cancel after the end of its
  // run is kept too, so give each run a new `runId`.
  'dez.native/cancelBundledTool' (runId: string): Promise<void> {
    return invoke('cancel_bundled_tool', { runId })
  },

  // Writes `text` to the input of a `runBundledTool` run with `stdin`, after
  // the texts of the earlier writes; the program gets it as it is, so a line
  // needs its `\n`. Resolves when the text is in the queue of the run, which
  // waits while the program does not read. Rejects when no run with this id
  // is active, when the run has no `stdin`, and when its program closed its
  // input. The backend runs each command as its own task, so:
  // - a write can come before its run is active: write only after the run
  //   gave an output;
  // - two writes at the same time have no order: wait for each one.
  // The input stays open to the end of the run; there is no way to close it.
  'dez.native/writeBundledToolInput' (runId: string, text: string): Promise<void> {
    return invoke('write_bundled_tool_input', { runId, text })
  },

  // The canonical paths of the OS temp folders that exist
  // (src-tauri/src/commands.rs `temp_folders`).
  'dez.native/tempFolders' (): Promise<string[]> {
    return invoke<string[]>('temp_folders')
  },

  // The absolute path of a file with no symlink, `.`, or `..` in it. Rejects
  // for a missing file.
  'dez.native/canonicalPath' (path: string): Promise<string> {
    return invoke<string>('canonical_path', { path })
  },

  // The paths of the files of the newest file drag on macOS (the drag
  // pasteboard); an empty list on other platforms.
  'dez.native/draggedFilePaths' (): Promise<string[]> {
    return invoke<string[]>('dragged_file_paths')
  },

  // The user's home folder (Tauri's path API, which `core:default` in
  // src-tauri/capabilities/default.json allows).
  'dez.native/homeDir' (): Promise<string> {
    return homeDir()
  },

  // The absolute path of a file of the bundle's resource folder
  // (`bundle.resources` of src-tauri/tauri.conf.json), from its path in that
  // folder, as in `fonts/NotoSans-Regular.ttf`. A cargo build has the
  // resources next to its program (tauri-build copies them there). It does
  // not check that the file is there. `core:default` allows it.
  'dez.native/resourcePath' (relative: string): Promise<string> {
    return resolveResource(relative)
  },

  'dez.native/isWindowFullscreen' (): Promise<boolean> {
    return invoke<boolean>('is_window_fullscreen')
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
