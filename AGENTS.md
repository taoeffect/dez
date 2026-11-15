# AGENTS.md

This file is a high-level project overview (table of contents) and project Gotchas. Keep additions at that level: name the module, file, or rule in a short line. Never nitty-gritty details, those belong in code docstrings, comments, tests, etc.

If `CLAUDE.md` exists in this repository, it is a symlink to this file; edit only `AGENTS.md`, never `CLAUDE.md` directly.

## Commands

```bash
npm ci                         # install dependencies before building or packaging
npm run dev                    # frontend only, no Tauri shell
npm run tauri dev              # full desktop app
npm run build                  # frontend only: vue-tsc --noEmit && vite build
npm run tauri build            # production Tauri bundle; on Linux use build:linux:appimage (GStreamer paths, patchelf)
npm test                       # unit tests (Vitest)
npm run test:watch             # unit tests in watch mode
npm run test:e2e               # WebDriver UI tests on the real app; Linux only (see vitest.e2e.config.ts)
npm run typecheck:e2e          # type-check tests/e2e (`npm run build` does not)
npm run build:desktop          # native bundle for the current platform
npm run build:linux:appimage   # Linux AppImage for the host arch; Linux only; needs patchelf
npm run build:macos:dmg        # Apple Silicon macOS DMG; macOS only
npm run build:macos:app        # Apple Silicon macOS .app; macOS only
npm run bump-version -- [--check] <version>          # npm, Tauri, and Cargo version files; --check only checks
node scripts/release-notes.js <tag> [--out <file>]   # release notes body for a tag
node scripts/update-ffmpeg.js <release tag>           # vendor the ffmpeg and ffprobe programs of a release
npm run preview                # preview the built frontend
cd src-tauri && cargo check
cd src-tauri && cargo test
```

- Tauri build scripts first run `npm run clean:rust` (`scripts/clean-rust.js`).
- `build:linux:appimage` runs `scripts/build-linux-appimage.js`; the AppImage bundles the build host's GStreamer plugins.
- macOS builds need Xcode 26+: `build:macos:*` first compile the app icon (`scripts/build-macos-icon.js`); a bare `tauri build` on macOS fails without it.
- Releases: run `npm run bump-version` and commit before you tag. A pushed `v*` tag runs `.github/workflows/release-desktop.yml`.
- CI rules are in the workflow comments: the CA roots step that starts every job, the one step that may read `ZAI_API_KEY`, the Git LFS files of a job (`.github/actions/pull-lfs-files`).

## Git conventions

Commit messages must use an 80-character maximum line width for both subject and body.

## Architecture

Dez follows an SBP MVC pattern: selectors are the cross-layer API, and code lives in the owning MVC layer. Tauri v2 is the Rust backend; Vue 3 / TypeScript / Vite is the frontend. Pinia setup stores are internal model details.

- `src/model/`: domain state, persistence formats, providers, chat/stream model logic, and model selectors.
- `src/controller/`: user workflows, startup/shutdown, native/Tauri boundaries, the native menubar, HTTP runtime orchestration, updates, and diagnostics.
- `src/view/`: Vue UI, view composables, CodeMirror editor services, toast/theme/clipboard UI selectors, and reactive read adapters.
- `src/utils/`: cross-layer utilities only.
- `src-tauri/`: Rust commands, native HTTP bridge, persistence file I/O, credential storage, and app bootstrap.

 Always build code cleanly, modularly, and with proper architecture and separation of concerns.

### Runtime data flow

The main path of one reply. The comments of each step tell the rest; start at the top comment of `src/controller/stream.ts`.

```text
ThreadEditor (CodeMirror doc) syncs to the active tab's sections
  -> Mod-Enter (key, Submit button, Conversation › Send) -> dez.controller/submitTab
    -> a message that cannot go gets a "Cannot send" toast and no request
    -> dez.stream/start: one reply is one agent section
      -> chat rounds: dez.provider/streamChat -> dez.http/stream
           -> dez.native/streamHttp -> Rust http_bridge::stream_http
         -> openaiSse.ts / anthropicSse.ts split the stream (tokens, thinking, tool calls, usage, images, audio)
         -> tokens go to the store, and to the editor if the tab is visible (dez.editor/*)
         -> a round that ends with tool calls runs them (dez.controller/tools/run), then sends the next round
         -> slow tool work runs as jobs of the reply (controller/jobs.ts)
         -> a conversation near a limit of its model is compacted before a chat request (compactIfDue)
      -> or, for a media model, one media round: dez.provider/generateMedia
    -> finish/error/cancel reconciles the editor, adds a user section, and saves
    -> finish/error of a reply the user does not look at -> dez.controller/alertReplyEnded
```

### Frontend map (`src/`)

- `main.ts`: registers all selectors; dev builds expose `window.__stores`.
- `view/thread/ThreadEditor.vue`: the one CodeMirror `EditorView` (no contenteditable).
- `view/thread/cmEditor.ts`: doc ⇄ sections, sentinels, state fields, role pill widgets, clipboard format, markdown parsing and styles, `dezTheme`.
- `view/thread/modelChip.ts`, `thinkingPill.ts`, `pillDuration.ts`: the parts of an agent pill (model, thinking, reply time).
- `view/thread/editorMeasure.ts`: forced CodeMirror re-measures.
- `view/editor/selectors.ts`: `dez.editor/*`, the active-editor bridge (stream patching, scroll follow, Copy Markdown, the rebuild after a compaction).
- `view/editor/find.ts`, `findState.ts`, `findHistory.ts`, `view/thread/FindDropdown.vue`: find and replace.
- `view/editor/tables.ts`, `links.ts`, `mentions.ts`: GFM tables, markdown links, and `@id` mentions, shown in place.
- `view/editor/focus.ts`: focus the editor and keep its scroll; use `focusKeepingScroll`, not `view.focus()`.
- `view/editor/images.ts`, `imageInsert.ts`, `pendingRanges.ts`: images shown in place of their references; image and clip paste and drop.
- `view/editor/media.ts`, `view/media/`: `<dez:audio>` and `<dez:video>` tags shown as players (`MediaPlayer.vue`, video.js parts in Dez's own skin).
- `view/editor/toolCalls.ts`: `<dez:tool>` blocks shown as chips, each with a panel.
- `view/editor/hiddenAssets.ts`, `compactionChip.ts`: the hidden assets of a chip, and the compaction chip with its panel.
- `view/editor/lineBlocks.ts`, `compaction.ts`, `lineCommands.ts`: the edit rules of whole-line blocks (chips, players, the compaction tag line).
- `view/editor/agentTextEdits.ts`: whether a user edit changed the text of a reply (the edited mark of a tab).
- `view/editor/assetSelection.ts`, `view/assetFacts.ts`, `view/assetIcons.ts`: the selected look, the facts text, and the symbol of an asset.
- `controller/images.ts`: `dez.controller/images/*`: store, delete, read, and redraw images; file drops.
- `controller/media.ts`, `clipSources.ts`: `dez.controller/media/*`: save, delete, read, and decode clips; the cleanup of old temp copies.
- `controller/unusedFiles.ts`, `cacheHolds.ts`, `workFolders.ts`: find and delete the files and cache entries that nothing uses.
- `model/chat/`: `Section` / `ContentNode` types and helpers, and the text forms of a conversation, each with one writer and recognizer:
  - `images.ts` (image references), `mediaTags.ts` (clips), `toolBlocks.ts` (tool calls), `pillMarker.ts` (pill markers), `compaction.ts`, `compactionNotes.ts` (the compaction tag and notes).
  - `mediaIds.ts`, `imageMentions.ts`, `assetMentions.ts` (asset ids and `@id` mentions), `hiddenAssets.ts`, `shownPictures.ts`.
  - `storedFilePaths.ts`, `linkedFiles.ts`, `mediaFiles.ts`, `unusedFiles.ts` (stored, linked, and unused files).
- `model/state/`: Pinia stores (internal) and `dez.model/*` selectors; views read state through `view/modelState.ts`.
- `controller/thread.ts`: `dez.controller/submitTab`. `controller/tabs.ts`: `dez.controller/newTab`.
- `controller/stream.ts`, `model/state/streams.ts`, `controller/http.ts`: stream lifecycle (one reply), per-tab sessions, native HTTP streams.
- `model/streams/`: the pure parts of a reply: `messages.ts` (request messages), `toolRound.ts`, `mediaRequest.ts`, `pictureBudget.ts`.
- `model/chat/contextSize.ts`, `model/streams/contextEstimate.ts`: the context size of a tab (the provider's count, plus Dez's estimate; no tokenizer).
- Compaction (a model's notes take the place of the conversation): `controller/compaction.ts`, `model/streams/compaction*.ts`, `compactedSections.ts`; `compactIfDue` (`controller/stream.ts`) runs it.
- `model/tools/`: the Dez tools (Dez runs them for a model; not a provider's own tools): `registry.ts` (`TOOL_DEFINITIONS`), `arguments.ts`, `subcommands.ts`, and one module per tool.
- `controller/tools.ts`: `dez.controller/tools/run`, the runner of each tool (`ToolRunContext`).
- `controller/modelInvoke.ts`, `videoTool.ts`, `audioTool.ts`, `assetInfo.ts`, `assetView.ts`: the work of a tool; they register no selector.
- `controller/jobs.ts`, `model/tools/jobs.ts`: `ReplyJobs`, the jobs of one reply, and the job tools.
- `model/tools/programRuns.ts`, `controller/programRuns.ts`, `model/tools/workFolders.ts`: what the tools that run ffmpeg or ffprobe share, and their work folders.
- `model/systemPrompt/`: the built-in system prompt (`systemPrompt.md`), the variables of a template, and its checks.
- `model/modelOutputs.ts`, `modelInputs.ts`, `modelSearch.ts`: the output types, what Dez can send a model, and the model filter.
- `controller/notifications.ts`, `view/sound.ts`, `assets/sounds/`: the reply-end alerts (sound, system notification).
- `controller/diagnostics/`: `dez.diagnostics/*`: sanitized probes, and the developer's request log (`requestLog.ts`).
- `model/shortcuts.ts`: the editable shortcut registry; user overrides are in the settings store.
- `controller/menu.ts`: the native menubar (Tauri only). `view/composables/useKeyboardShortcuts.ts`: app keys.
- `controller/window.ts`, `windowFit.ts`: restore and save the window size and position.
- `view/app/AppLayout.vue`: layout and bottom bar (`ModelSelector.vue`, `view/thread/UsageLabel.vue`, `view/thread/SubmitButton.vue`, the Help button).
- `view/thread/UsageLabel.vue`, `tokenLabel.ts`, `costLabel.ts`: the token count and the cost of the active tab's conversation.
- `view/composables/useActiveContextSize.ts`: the one view read of the context size; never read it in a `computed`.
- `view/model-selector/`: `ModelPicker.vue` (a virtual list), `ModelOutputFilter.vue`, `ProviderSettingsPopup.vue` (toggles and "Model Parameters" of the active model).
- `view/history/HistoryPanel.vue`: saved conversations.
- `view/help/HelpView.vue`: the Help panel. Keep its texts true when a rule that they tell changes (the Assets page tells the asset rules).
- `view/confirm/`: `dez.ui/confirm`, the in-app yes/no prompt.
- `view/prompts/PromptManager.vue`, `view/thread/PromptAutocomplete.vue`: saved prompts and `/prompt ` insertion.
- `view/settings/`: Settings (`SettingsView.vue`, `ProviderManager.vue`, `ShortcutManager.vue`, `SystemPromptSettings.vue`, `unusedFiles.ts`).
- `view/tabs/TabBar.vue`: tabs (activity colors, drag to reorder).
- `view/modelLabel.ts`: model display names and tooltip text. `view/theme.ts`: theme and editor font size.
- `utils/`: one place for each shared rule: `byteSize.ts`, `formatName.ts`, `homePath.ts`, `errorText.ts`, `abort.ts`, `dezLinks.ts`.

### SBP

[SBP](https://github.com/okTurtles/sbp): calls look like `sbp('domain/action', ...args)`; each domain is a stable API owned by one place:

- `dez.model/*`: `src/model/state/index.ts`
- `dez.persistence/*`: `src/model/persistence/index.ts`
- `dez.provider/*`: `src/model/providers/selectors.ts`
- `dez.controller/*`: `src/controller/`
- `dez.stream/*`: `src/controller/stream.ts`
- `dez.http/*`: `src/controller/http.ts`
- `dez.native/*`: `src/controller/native.ts`, the only frontend module that calls Tauri `invoke()`
- `dez.diagnostics/*`: `src/controller/diagnostics/` (sanitized probes, and the developer's request log; no secrets)
- `dez.editor/*`: `src/view/editor/selectors.ts`
- `dez.ui/*`: `src/view/toast/selectors.ts`, `src/view/confirm/selectors.ts`, `src/view/theme.ts`, `src/view/clipboard.ts`, `src/view/sound.ts`

Rules:

- Components call `dez.controller/*` for workflows, `dez.ui/*` for UI services, and data domains only for direct reads.
- Components and stores never call `dez.native/*`, import Tauri APIs, call `invoke()`, or `fetch()` at runtime.
- Put selector behavior in the registered function body (`export default sbp('sbp/selectors/register', { 'domain/selector': function (...) { ... } })`), not in a same-file wrapper helper.
- No selectors that only forward to another selector, and no controller aliases for simple model mutations (call `dez.model/settings/historyOpen`, not a new `dez.controller/openHistory`).
- Selectors are for high-level, cross-module actions; file-local handlers and helpers are plain functions. Prefer one selector with options over near-duplicates.

### Dependencies

- Zod for runtime validation at untrusted or persisted data boundaries, so malformed JSON never breaks startup.
- `@sbp/okturtles.eventqueue` to serialize async operations that must not race.
- `turtledash` for lodash-style helpers; use its `debounce`, not ad hoc timers.
- `w3c-keyname`, at the version CodeMirror uses, so that shortcut matching (`model/shortcuts.ts`) agrees with CodeMirror keymaps.
- `virtua` (the model picker's list) and `@videojs/html` (the media player); `videoJsElements` in `vite.config.ts` must match the video.js elements in `MediaPlayer.vue`.
- `.npmrc` makes npm write exact pins (`save-exact`) and refuse a version that is younger than 14 days (`min-release-age`): pin the newest version that it allows.

### Providers (`src/model/providers/`)

- Every provider is one plain-JSON `ProviderConfig` (`config.ts`), served by one `Provider` class (`provider.ts`) over two wire formats (`apiFormats.ts`: `openai`, `anthropic`).
- Built-ins are in `builtins.ts` (add a config literal; no Rust change); custom providers are in `app_state.json`; `registry.ts` finds both.
- Put provider differences in config data, never in `if (providerId === …)` branches. Format code knows no provider name.
- Provider ids must pass `isValidProviderId` (`config.ts`).
- Chat and model HTTP stays in TypeScript (`dez.provider/*`, `dez.http/*`), not in Rust.
- What a model can do is config data, kept on `ModelInfo`: thinking (`thinking.ts`), outputs and request kinds (`types.ts`, `modelParsing.ts`), image input, tool calling.
- Toggles are per model: `modelToggles.ts` is the one rule, which the popup and the chat request both read.
- Prompt cache: earlier messages, the system prompt, and the tools array must stay the same bytes in every later request, until a compaction (`apiFormats.ts`, `model/streams/messages.ts`).
- Images of a chat request: which message carries an image and the two image limits are in `model/streams/messages.ts`; the one send size in `imageSize.ts`, `chatImageCopies.ts`.
- Tools: when a request offers the Dez tools is in `toolsSetting.ts`; the wire shapes of calls and results are in `apiFormats.ts`.
- Media requests: `dez.provider/generateMedia` (`mediaFormats.ts`, `clipRequests.ts`, `clipInputs.ts`). Never a resend with fewer images.
- Prices (`modelPrices.ts`, `chatUsage.ts`): a price that Dez cannot find is unknown (null), never 0.
- Model parameters (`modelParameters.ts`): Dez refuses a value only when the provider's data tells that the provider refuses it.
- Limits of a model: `knownLimits.json` (rules that the provider's data does not state), `learnedImageLimit.ts`, `modelFamilies.json` (context windows and image limits, from the makers' docs).
- HTTP errors (`errors.ts`): each failed request has a text for its reader, the user or a calling model.
- The API key goes only to URLs that Dez builds: a URL from a provider's response (a reply image, a clip) is fetched with no provider headers.

### Toasts

`src/view/toast/`: emit with `dez.ui/toast`. Payloads and rules: `src/view/toast/README.md`. Chat request errors are sticky error toasts; the thread shows no error text.

### Backend (`src-tauri/src/`)

- **Keep Rust barebones**: a thin, generic OS interface, not a per-feature API. Reuse or generalize a command (e.g. `load_app_file`) instead of adding a near-copy.
- `commands.rs`, `http_bridge.rs`, `notification.rs`, `idle.rs`: Tauri commands, registered in `lib.rs`.
- `http_bridge.rs`: generic HTTP request, stream, and download. A request body is text or base64 text, never a JSON number array (slow).
- `bundled_tools.rs`, `confinement.rs`: one run of a program of `../binaries/` in a work folder of the cache root, under an OS rule on the files that it can open.
- `notification.rs`, `idle.rs`, `session_bus.rs`: system notifications, the user's idle time, and the one Linux D-Bus session connection.
- `persistence.rs`: the file roots (`app`, `cache`) and raw private-file I/O; write every private file with `write_private_file` or `PrivateFileWriter`.
- `key_store.rs`: `provider_keys.json`. `copilot.rs`: Copilot device flow and token refresh.
- `lib.rs`: plugins, permission reasons, app bootstrap, and the quit hook that stops the bundled tools.
- `../tauri.linux.conf.json`: the Linux copy of the main window, with Tauri's native file drop on.
- `../binaries/`: the ffmpeg and ffprobe programs that Dez ships (Git LFS), with `manifest.json`; only `scripts/update-ffmpeg.js` writes it, and `../build.rs` checks it.

## Persistence layout

All app data is under `~/.config/dez/`, except the temp copies of clips and the work folders of the bundled tools. TypeScript owns every format; Rust only moves raw strings and bytes.

The JSON and conversation files go through `dez.persistence/*` only; the asset files go through `dez.native/*` from their controllers.

- `app_state.json`: tabs, settings, window geometry, provider toggles, custom providers (`src/model/persistence/appState.ts`).
- `conversations/<sanitized-id>.md`: conversations (`src/model/persistence/conversationFormat.ts`).
- `prompts.json`: saved prompt templates (`src/model/persistence/prompts.ts`).
- `model_cache.json`: last-known model lists and fresh price quotes; no secrets and no raw provider entries (`src/model/persistence/modelCache.ts`).
- `assets/images/`, `assets/audio/`, `assets/video/`: pasted files, and dropped files that Dez copies (`src/controller/images.ts`, `media.ts`).
- `assets/generated/images/`, `audio/`, `video/`: files that models and Dez tools made, and clips that the user saved.
- `assets/generated/views/`: the copies of the pictures that Dez showed a model (`src/model/chat/shownPictures.ts`).
- `<OS cache>/dez/media/`: temp copies of clips that are not saved (`src/model/chat/mediaFiles.ts`).
- `<OS cache>/dez/work/<id>/`: the work folder of a bundled tool (`src/model/tools/workFolders.ts`).
- Linked files: a dropped file that is in no temp folder and no Dez folder stays where it is (`src/model/chat/linkedFiles.ts`). Dez never deletes it.
- A text edit or a conversation delete leaves the stored files. Its trash, Delete Unused Files (`src/model/chat/unusedFiles.ts`), or a compaction (`src/model/streams/compactionFiles.ts`) deletes one.
- `provider_keys.json`: API keys and Copilot tokens (`src-tauri/src/key_store.rs`).

Do not ever read, view, print, or `cat` `~/.config/dez/provider_keys.json`; it can contain API keys and OAuth tokens.

## Gotchas

Each line names a trap and the code whose comments tell it in full. Read those comments before you change that code.

### Editor and sections

- **Do not leak sentinels**: the section and prompt pill sentinels (`cmEditor.ts`) live only in the editor doc, never on disk or in the clipboard.
- **First section is `user`, or the compaction section** of a compacted conversation; its role follows its text and never toggles (`firstSectionRole`, `src/model/chat/compaction.ts`).
- **A role pill belongs to the section after it**, so separator index math is easy to get off by one (`cmEditor.ts`).
- **`model`, `thinking`, and `durationMs` are agent-only**: show, save, or send them only when `role === 'agent'`, and copy them only when set (`src/model/chat/types.ts`).
- **Per-section fields flow through the editor**: the editor writes sections back to the store on every doc change; a new field must follow `SectionModel` in `cmEditor.ts`.
- **Section models are not doc text**: undo and redo put back the role and data of the sections they re-insert (`sectionsField`, `cmEditor.ts`).
- **Only a user edit has a `userEvent`**: a new user edit path must set one; a new program write must not (`view/editor/agentTextEdits.ts`).
- **The editor holds the old tab for a tick after a switch**: write the view back only to `viewTabId`, and never give it another tab's section models (`ThreadEditor.vue`).
- **A compaction swaps the sections under the editor**: `dez.model/tabs/compact` and `dez.editor/rebuildIfVisible` run in the same tick (`compactIfDue`), and it cannot be undone.
- **Each section is its own markdown text** (`sectionSeparatorMarkdown`, `cmEditor.ts`); code fences and HTML blocks still run into the next sections.
- **Thinking has two copies during a stream** (store and visible editor); see `dez.editor/setSectionThinkingIfVisible`.
- **Never change the stored thinking**: replays send it back, and the prompt cache needs the same bytes. The panel shows `readableThinking` (`src/model/chat/thinking.ts`).
- **Agent pill DOM changes in place**: see `RoleSeparatorWidget.eq` and `pillThinkingUpdater` in `cmEditor.ts`.
- **Streams patch only the visible editor**: the store gets every token; the editor only when its tab is active (`dez.editor/appendTokenIfVisible`).
- **Stream scroll follow**: never add code that scrolls an editor view up (`src/view/editor/selectors.ts`).
- **Chip spacing is view only** (`ChipSpacing`, `view/editor/toolCalls.ts`): never change the text of a reply for its look, as the rounds of a reply are read from it.
- **Never hard-code a shortcut key**: every binding path reads the effective keys from `src/model/shortcuts.ts` and the settings store.
- **Shortcut key order differs by platform**: on Linux the menu accelerator gets the key first; put context checks in the selector both paths call, never only in a key handler.

### Conversation text and assets

- **Image references, media tags, and tool calls are plain text** in a section; each has one writer and recognizer (`images.ts`, `mediaTags.ts`, `toolBlocks.ts` in `src/model/chat/`).
- **Model text never forms a tag or a block**: `ModelTextEscaper` covers the tool blocks, the media tags, and the compaction tag.
- **Find tool blocks in one agent section at a time**, never in the whole doc (`src/model/chat/toolBlocks.ts`).
- **A linked path counts only in a user section** (`isLinkedImagePath`, `isLinkedMediaPath`), so that a model's text never makes Dez read a file of the computer.
- **One id sequence for images and clips** (`src/model/chat/mediaIds.ts`): never renumber an id that is in the doc, and never give an id that the conversation used before.
- **`@id` mentions** (`src/model/chat/imageMentions.ts`): the request builder and the editor chips find mentions in the same text pieces (`assetTextPieces`); keep the two on that one rule.
- **A hidden asset and a kept asset are normal assets with a mark**: only the view hides them (`src/model/chat/hiddenAssets.ts`, `compaction.ts`).
- **The notes of a compaction section are read back** (`src/model/chat/compactionNotes.ts`): a change of a line's form needs a reader of the old form.
- **The unused-files scan must read every text that can name a stored file**: a new text place, stored-file folder, or kind of cache entry must join it (`src/controller/unusedFiles.ts`).
- **Long work in the cache root holds its entry** with `holdingCachePath` (`src/controller/cacheHolds.ts`), or the cleanup deletes it.

### Requests and replies

- **A request never starts with an agent message**: the compaction section goes as a `user` message (`sectionsToStreamMessages`, `src/model/streams/messages.ts`).
- **Provider role mapping**: internal role `agent` maps to API role `assistant` in both formats.
- **No stored file path to providers**: every request text goes through `withoutStoredFilePaths` (`src/model/chat/storedFilePaths.ts`); a new request text needs the same.
- **A request holds at most the request form of a media tag** (`mediaTagsForRequest`), so a Save, a Delete, or an expiry changes no request bytes.
- **The system prompt and the tools are in the cached prefix**: never put a date, a count, or a random value into `systemPrompt.md`, its placeholder values, or a tool definition.
- **The pictures of `asset_view` stay until the next compaction**, as the same bytes in every request (`src/model/chat/shownPictures.ts`).
- **One picture count**: the picture budget, the compaction check, and what a compaction leaves read the same limits (`src/model/streams/pictureBudget.ts`).
- **An image round has no thinking replay** (`roundThinking`, `src/model/streams/messages.ts`).
- **One agent section per reply**: tool rounds stay in one section, and its thinking keeps one entry for each later round (`SectionThinking.rounds`).
- **A tool's image or clip goes after the blocks of its group**, and the next request ends at the last tool message: text after it would be a prefill (`runChatRounds`).
- **A request names a tool's image or clip only in the tool result** (`madeAssetText`, `src/model/tools/jobs.ts`; `roundRequestText`, `src/model/streams/messages.ts`).
- **Slow tool work is a job** (`ReplyJobs`, `controller/jobs.ts`): the tool returns the job's id at once, and the work writes nothing into the reply.
- **Reply images and clips are written only while the reply is current** (`replyIsCurrent`, `controller/stream.ts`): a cancelled request can still give a response.
- **Raw model entries are in memory only** (`dez.model/modelCache/rawModel`): a fact of a model that a request or the UI needs must be a field of `ModelInfo`.
- **Provider data in a tool result** goes through `jsonWithoutLocalPaths` (`src/model/tools/localPaths.ts`): a tool result is stored as it was sent.
- **Persistence starts after init**: settings changes made before `dez.model/settings/startPersistence` can be lost.

### Media and bundled programs

- **Clips come through Rust**: a clip response goes to a file with `dez.native/downloadAppFile`, not through `dez.http/stream` (the exception: the audio of a chat answer, `chatAudio.ts`).
- **Local clips play from a blob URL**: WebKitGTK loads no media from the asset protocol (`MediaPlayer.vue`).
- **A new editor state makes new players**: a stream end or a tab switch stops a clip that plays (`view/editor/media.ts`).
- **A removed media element frees nothing by itself**: a media element that Vue can remove needs `v-release-on-remove` (`view/media/releaseMedia.ts`).
- **A fullscreen player hides the app's layers**: code that shows a prompt or a toast for a player calls `leaveFullscreen` first (`view/editor/media.ts`).
- **File drops differ by platform**: Tauri's native drop on Linux, HTML5 drops on macOS (`dez.controller/images/watchFileDrops`, `droppedFilePaths`); a drop copies or links its file.
- **A bundled tool gets copies, never links**, and Rust does not check its arguments: the caller keeps every path outside the work folder out of them (`src-tauri/src/bundled_tools.rs`).
- **The argument rule of the `video` tool is string checks; the OS rule guards the files** (`src/model/tools/videoTool.ts`, `src-tauri/src/confinement.rs`): keep both.
- **After `scripts/update-ffmpeg.js`**, check `REFUSED_PROTOCOLS` and `REFUSED_DEVICES` (`src/model/tools/videoTool.ts`) against the new ffmpeg.

### App, build, and tools

- **The asset protocol reads every file** (`assetProtocol` in `tauri.conf.json`), so the webview must never load remote code.
- **CSP disabled**: `"csp": null` in `tauri.conf.json` on purpose during development.
- **Tauri capabilities**: a new plugin or core command needs a permission in `src-tauri/capabilities/default.json`; app commands registered in `lib.rs` need none.
- **Copilot auth differs**: device flow commands, not the API-key commands.
- **The window starts hidden**: `dez.controller/window/restore` shows it, so a frontend failure before init shows no window; read the Vite output.
- **Saved window position units differ by platform**: logical points on macOS, physical px elsewhere (`src/controller/window.ts`).
- **Wayland windows have no place**: GTK's Wayland backend cannot read or set the window position (`src/controller/window.ts`). The AppImage runs on X11.
- **The model picker draws only the rows in view** (`virtua`, `ModelPicker.vue`): a far row has no DOM.
- **Vite port is fixed**: `1420` with `strictPort: true`.
- **`@tauri-apps/plugin-store` is unused**: app files use Dez's own Rust file I/O.
- **Secrets wrapper is not a vault**: `src/utils/secret.ts`; never log provider headers, native HTTP payloads, or diagnostics without sanitization.
- **Sounds and the ffmpeg programs are in Git LFS**: clone with LFS (`git lfs pull`). A pointer file in place of a sound builds with no error; one in place of a program stops the build.
- **tauri-build puts the bundled programs next to a debug build**: keep it at 2.7 or newer (`src-tauri/Cargo.toml`).
- When using the `agentic_fetch` tool:
  - If searching the web, *ALWAYS* tell the tool to never use local tools like Grep, and only search the web
  - If searching local folders, *ALWAYS* tell the tool to restrict its searches to this folder only and to never search outside of it

## Code conventions

- Vue SFCs use `<script setup lang="ts">`.
- Pinia stores use setup-function style, not options-style stores.
- TypeScript is strict with `noUnusedLocals` / `noUnusedParameters`; unused imports or parameters break `npm run build`.
- In `src/`, imports omit semicolons and use single quotes; config files keep their double quotes. Match the surrounding file.
- Frontend ids come from `crypto.randomUUID()`.
- Rust uses `thiserror` for error types.
- Rust/TypeScript JSON names are mapped by hand, often with per-field `#[serde(rename = "camelCase")]`; check each struct before changing payloads.
- Styling uses component-scoped CSS or CodeMirror theme rules in `cmEditor.ts`; global theme variables are in `src/view/app/App.vue`. No CSS framework.
- Theme is `data-theme` on `<html>` with a `prefers-color-scheme` fallback.

## Comments

ALWAYS add comments above any code that could be considered confusing, unclear, hackish, or non-idiomatic explaining why the code exists, what scenarios it covers, and what it does.

Brief comments are encouraged above functions that do anything non-trivial explaining the "why and what" of the function.

## Misc. Directives

- When a file needs to move to a new location with only small changes, use the `cp` command to copy it and then the Edit tool instead of reconstructing it manually.
- Import the live SBP function only from the package: `import sbp from '@sbp/sbp'`. Do not import `sbp` via relative paths like `./sbp` or `../sbp`; relative imports are only for selector registration side effects or local SBP types/modules.
- When using the 'tasks' skill, if while working you discover that the steps in a `STEP-*` file are wrong, incomplete, or not the best approach, rewrite that step file to follow the better approach before continuing.
- Any errors should be logged with `console.error` (in addition to being thrown when throwing is still needed).
- Error texts for the user tell whose fault it is and what to do, with raw details last (`src/utils/errorText.ts`). Throw one as an `ExplainedError`; never show only a raw error when Dez knows why.
- A Dez tool that gets a bad call answers with a text that tells the model how to fix the call. A runner throws a `ToolError` (`src/model/tools/types.ts`); a tool result holds no local path.
- Modifications to the project README must be tiny and generally avoided. Larger modifications require user approval (ask first).
- Dez should avoid taking actions on its own that would result in the user's private info (like file paths) being exposed to providers.
  - It's fine if users type them manually themselves, but for example, when designing features like image drag and drop, the image's file path shouldn't be sent to providers.

## Testing approach

- Unit tests: Vitest with colocated `*.test.ts` files; `npm test` also runs `scripts/*.test.js`. Rust unit tests are in the `src-tauri/src/*.rs` files.
- Shared unit test helpers are in a `testing.ts` module next to their tests; never copy one into a test file.
- Run `npm run build` at the end of a task step with frontend changes (it type-checks), not after every edit.
- Run `npm test` after frontend logic changes.
- Run `cd src-tauri && cargo check` after significant Rust changes, and `cargo test` when touching Rust logic with tests.
- Run `npm run test:e2e` after UI behavior changes covered by `tests/e2e/`. It runs the existing debug binary: rebuild first (`tests/e2e/harness/app.ts`).
- Run `npm run typecheck:e2e` after changing the e2e harness or specs.
- No test may call a real provider or run a paid generation: media specs use mock servers only (`tests/e2e/harness/mockServer.ts`, `media.ts`).
- Shared e2e helpers are in `tests/e2e/harness/`; never copy one into a spec. Read the header of a harness module before you use it.
- E2E clicks: never use webdriverio's `.click()`; use the click helpers of `tests/e2e/harness/dom.ts`.
- E2E model data: a spec answers the model list data and the price requests of its model with `jsonAnswers` (`tests/e2e/harness/mockProviderApp.ts`; see `tests/e2e/music.e2e.ts`).
- The e2e app has its own `HOME`, `XDG_CONFIG_HOME`, and `XDG_CACHE_HOME` in a temp folder (`tests/e2e/harness/app.ts`).
- E2E cannot send GTK menu accelerators, real clipboard data, or OS file drags; the manual recipes are in `vitest.e2e.config.ts`.
- E2E specs that restart the app use `MockProviderApp.relaunch()`, after a wait for `model_cache.json` with `readModelCache` (`tests/e2e/harness/fixtures.ts`).
- E2E seeds turn the reply-end alerts off (`quietAppState`); alert specs use the fake notification server (`tests/e2e/harness/notificationServer.ts`).
- E2E clips must be in a format that the CI GStreamer packages decode (VP9 in webm or mp4, wav, Opus in WebM; `.github/workflows/e2e.yml`).
- E2E bundled tools: the specs run the real ffmpeg and ffprobe of the debug build (`tests/e2e/bundled-tools.e2e.ts`, `tests/e2e/video-tool.e2e.ts`).
- A `browser.execute` result must not be an object with a set `error` field: webdriverio takes it for a failure of the script.
- E2E specs that open a URL call `stopOpenUrl` (`tests/e2e/harness/dom.ts`), so no browser opens.
- **No display server** (every spec fails with `Hook timed out in 120000ms` in `beforeAll`): run under headless `kwin_wayland`; the recipe is in `vitest.e2e.config.ts`.
- For UI changes beyond unit-testable logic, also check by hand with `npm run tauri dev`.
