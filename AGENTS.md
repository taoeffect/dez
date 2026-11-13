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
npm run preview                # preview the built frontend
cd src-tauri && cargo check
cd src-tauri && cargo test
```

- Tauri build scripts first run `npm run clean:rust` (`scripts/clean-rust.js`).
- `build:linux:appimage` runs `scripts/build-linux-appimage.js`; the AppImage bundles the build host's GStreamer plugins.
- macOS builds need Xcode 26+: `build:macos:*` first run `scripts/build-macos-icon.js`, which compiles `src-tauri/icons/Dez.icon` into the gitignored `src-tauri/icons/Assets.car` (icon name set in `src-tauri/Info.plist`). A bare `tauri build` on macOS fails without that file.
- Releases: run `npm run bump-version` and commit before you tag. A pushed `v*` tag runs `.github/workflows/release-desktop.yml` (version check against the tag, e2e gate, Linux AppImages, macOS DMG, release notes from `scripts/release-notes.js`, GitHub Release). The rules are in the comments of those files.
- CI rules (details in the workflow comments): every job removes the compromised eMudhra CA roots in its first step, and only the "Write release notes" step may reference `ZAI_API_KEY`.

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

```text
ThreadEditor (CodeMirror doc) syncs to the active tab's sections
  -> Mod-Enter (key, Submit button, Conversation › Send) -> dez.controller/submitTab
    -> a model that Dez cannot run, a media input that the model is known not to take (no image,
       no lyrics, a text of a wrong length), or an error in the custom system prompt gets a
       "Cannot send" toast and no request
    -> dez.model builds the request messages and stamps the trailing agent section
    -> dez.stream/start (the system prompt of Settings › System Prompt, and Dez's tools)
      -> dez.provider/streamChat -> dez.http/stream
        -> dez.native/streamHttp -> Rust http_bridge::stream_http (Headers/Chunk/Done/Error)
    -> openaiSse.ts / anthropicSse.ts split answer tokens, thinking tokens, tool calls, and
       (openaiSse.ts) reply images
    -> tokens go to the store, and to the editor if the tab is visible (dez.editor/*)
    -> a reply image is saved in assets/generated/images/ and written as an image reference
    -> a round that ends with tool calls writes <dez:tool> blocks, runs them (dez.controller/tools/run),
       and sends the next round; one reply is one agent section
    -> a model with a media request kind (image, imageEdit, upscale, tts, music, video, imageToVideo,
       videoToVideo, voiceChange, transcription) gets one media round in place of the chat rounds:
       dez.provider/generateMedia (one request, or a queue, poll, retrieve job for a clip; the input
       images go as edit inputs, the image of an upscale, video frames, or references; the clips of
       the message (its tags and @id mentions) as a source, references, or background audio; and the
       text after a "Lyrics:" line as a song's lyrics), then an image reference, a <dez:audio> /
       <dez:video> tag, or (transcription) the text, escaped with ModelTextEscaper
    -> the reply's finish/error/cancel reconciles the editor, adds a user section, and saves
    -> finish/error of a reply the user does not look at -> dez.controller/alertReplyEnded (sound, notification)
```

### Frontend map (`src/`)

- `main.ts`: registers all selectors; dev builds expose `window.__stores`.
- `view/thread/ThreadEditor.vue`: the one CodeMirror `EditorView` (no contenteditable).
- `view/thread/cmEditor.ts`: doc ⇄ sections, sentinels, state fields, role pill widgets, clipboard format, markdown parsing and styles (`dezLanguageSupport`, `dezHighlightStyle`), `dezTheme`.
- `view/thread/modelChip.ts`, `thinkingPill.ts`, `pillDuration.ts`: the model part, the thinking slot and panel, and the reply time of an agent pill.
- `view/thread/editorMeasure.ts`: forced CodeMirror re-measures.
- `view/editor/selectors.ts`: `dez.editor/*`, the active-editor bridge (stream patching, scroll follow, Copy Markdown, `runKeyBinding`).
- `view/editor/find.ts`, `findState.ts`, `findHistory.ts`, `view/thread/FindDropdown.vue`: find and replace.
- `view/editor/tables.ts`: GFM tables shown as tables, in place.
- `view/editor/links.ts`: markdown links (`http`, `https`, `mailto`, `tel`) shown as links, with their source while a selection touches them; a plain click opens one (`dez.controller/openUrl`), and hover shows its URL in a tooltip.
- `view/editor/focus.ts`: focus the editor and keep its scroll; use `focusKeepingScroll`, not `view.focus()`. `syncDomSelection`: fix the caret after code changes the doc right after the editor gets the focus.
- `view/editor/images.ts`, `imageInsert.ts`: images shown in place of their references (with a hover toolbar at the image's top-right corner: the id badge, the image's facts, and a trash that deletes the image after a `dez.ui/confirm` prompt; the right-click menu; and the Backspace and Delete rules), and image and clip paste and drop (which give asset ids; a paste copies the file, a drop copies or links it). `pendingRanges.ts`: doc ranges that the async insert and delete flows follow.
- `view/assetFacts.ts`: the facts text of an image or a clip in its hover toolbar (pixel size or length, format, file size). `view/editor/assetSelection.ts`: an image or a player that a text selection holds fully looks selected (`selectedAssetLook`; the tint is in `dezTheme`).
- `controller/images.ts`: `dez.controller/images/*`: store and delete an image (pasted or generated), its display URL, a stored file's size (`fileSize`), read a stored, linked, or dropped file, a new drawing of an image (`redraw`: crop, scale, flip, turn, fill, color changes, and file type, in the webview, no Rust; the types are in `model/chat/imageDrawing.ts`, the color math in `model/chat/imageColors.ts`), Linux native file drops, and the drop choice (`linkPath`: link a dropped file in place or copy it; `droppedFilePaths`: the paths of a macOS drop).
- `controller/media.ts`: `dez.controller/media/*`: save a clip (move its temp copy, else download its URL, or write the bytes that a tool made), delete a saved clip, read a clip's bytes (`readClip`), cut an audio clip into a WAV file (`cutAudio`: in the webview, no Rust; the types are in `model/chat/audioCut.ts`), the cleanup of old temp copies, and whether a clip URL answers (`urlAnswers`: the player asks it to tell a gone clip from one that the computer cannot play).
- `controller/unusedFiles.ts`: `dez.controller/unusedFiles/*`: find (with progress) and delete the stored files that no text names. The rules are in `model/chat/unusedFiles.ts`; the run of the Settings row is in `view/settings/unusedFiles.ts`.
- `view/editor/toolCalls.ts`: `<dez:tool>` blocks shown as chips, each with a panel of its parameters and result; a block of a tool that Dez does not have shows as an `old/unrecognized tool: <name>` chip; the spacing of the chip lines (`ChipSpacing`).
- `view/editor/media.ts`: `<dez:audio>` and `<dez:video>` tags shown as players (an agent section's made clips, a user section's pasted or dropped clips); the Save and Delete of a clip; the right-click menu. `view/media/`: `MediaPlayer.vue` (the video.js parts in Dez's own skin: the Save control, the expiry clock, the hover toolbar with the id badge and the clip's facts, the card of a clip that is gone or that the computer cannot play), `clipState.ts` (with `clipProblem`, which tells which, and `clipFile`, the local file of the menu), `videoSizes.ts`, `releaseMedia.ts` (the release of a media element that left the document).
- `view/editor/lineBlocks.ts`: the rules that blocks of whole lines share (tool chips, players): text next to one, Backspace, Delete.
- `view/editor/lineCommands.ts`: Delete Line and Duplicate Line, on whole blocks (tool chips, players, prompt pills), never across a section separator.
- `model/chat/`: `Section` / `ContentNode` types and helpers (`content.ts`, `modelRef.ts`, `thinking.ts`, `markdown.ts`, `pillMarker.ts`, `images.ts`, `imageMentions.ts`, `imageDrawing.ts`, `imageColors.ts`, `audioCut.ts`, `mp4Duration.ts`, `toolBlocks.ts`, `mediaTags.ts`, `mediaFiles.ts`, `mediaIds.ts`, `storedFilePaths.ts`, `unusedFiles.ts`, `linkedFiles.ts`).
- `model/state/`: Pinia stores (internal) and `dez.model/*` selectors; views read state through `view/modelState.ts`.
- `controller/stream.ts`, `model/state/streams.ts`, `controller/http.ts`: stream lifecycle (one reply: one request round per group of tool calls, or one media round), per-tab sessions, native HTTP streams.
- `model/tools/`: the Dez tools (tools that Dez runs for a model, not a provider's own tools such as web search): definitions, `registry.ts` (`TOOL_DEFINITIONS`, JSON schemas), `arguments.ts` (argument checks), `subcommands.ts` (a tool with subcommands: a `command` argument, the subcommand's `parameters` as JSON text, and a built-in `help`), `modelList.ts` (`model_list`), `modelInfo.ts` (`model_info`), `modelUsage.ts` (the `usage` texts of `model_info`), `audioTool.ts` (`audio`; its `clip` subcommand cuts a clip), `imageTool.ts` (`image`; its subcommands make new images from the images of a conversation), `localPaths.ts` (stand-ins for local paths in provider data). `controller/tools.ts`: `dez.controller/tools/run`, the code of each tool; a runner gets a `ToolRunContext` (the tab of its call, the reply's model, and writers of an image and a clip into the reply). `model/streams/toolRound.ts`: the pure parts of the tool loop.
- `model/systemPrompt/`: the built-in system prompt (`systemPrompt.md` with `{{name}}` placeholders), the variables of a template (`SYSTEM_PROMPT_VARIABLES`), and its checks (`template.ts`). The `systemPrompt` setting (null: the built-in one; blank: no system prompt) goes with every chat request.
- `model/modelOutputs.ts`: the one table of the output types (text, image, audio, video). `model/modelInputs.ts`: what Dez can send a model, in those types (the `inputs` of `model_list` and `model_info`). `model/modelSearch.ts`: the model filter (search terms and output types) of the model picker and `model_list`.
- `controller/notifications.ts`: the reply-end alerts (sound, system notification; a click opens the reply's tab). `view/sound.ts`: `dez.ui/playDoneSound`. `assets/sounds/`: sound files (Git LFS).
- `model/shortcuts.ts`: the editable shortcut registry (ids, default keys, key event matching, validation, labels, menu accelerators); user overrides are in the settings store.
- `controller/menu.ts`: the native menubar (Tauri only); `dez.controller/menu/suspendAccelerators` turns its keys off while a key is recorded; `dez.controller/menu/popupAsset`: the right-click menu of an image or a player ("Reveal in File Manager"). `view/composables/useKeyboardShortcuts.ts`: app keys.
- `controller/window.ts`, `windowFit.ts`: restore and save the window size and position.
- `view/app/AppLayout.vue`: layout and bottom bar (`ModelSelector.vue`, `view/thread/SubmitButton.vue`, the Help button).
- `view/model-selector/`: `ModelPicker.vue` (a virtual list of the rows from `pickerRows.ts`), `ModelOutputFilter.vue` (the output type filter), `ProviderSettingsPopup.vue` (for the active model: the provider toggles that apply to it, its "Model Parameters", how to write its lyrics, and the input of an upscale).
- `view/history/HistoryPanel.vue`: saved conversations.
- `view/help/HelpView.vue`: the Help panel (General, Tips, Support), opened by Help › Dez Help and the `?` button of the bottom bar (`dez.model/settings/helpOpen`). At most one of Settings, History, and Help is open.
- `view/confirm/`: `dez.ui/confirm`, the in-app yes/no prompt (`ConfirmDialog.vue`, mounted in `AppLayout.vue`); `isModalOpen()` (`useKeyboardShortcuts.ts`) counts it.
- `view/prompts/PromptManager.vue`, `view/thread/PromptAutocomplete.vue`: saved prompts and `/prompt ` insertion.
- `view/settings/SettingsView.vue`, `ProviderManager.vue`, `ShortcutManager.vue`, `SystemPromptSettings.vue`: settings (General holds the "Unused files" row, `unusedFiles.ts`), the providers page, Settings › Shortcuts with its key recorder (Help › Keyboard Shortcuts opens it), and Settings › System Prompt (the custom template, its variables, and Source/Preview; `SystemPromptPreview.vue` is a read-only CodeMirror view of the prompt).
- `view/tabs/TabBar.vue`: tabs, colored busy/done by `dez.model/tabs/activity`, pointer drag to reorder (`dez.model/tabs/move`). The `+` button, keys, and File menu create tabs with `dez.controller/newTab` (`controller/tabs.ts`), which focuses the editor (`dez.editor/focus`). `dez.model/tabs/reopenClosed` brings back a closed tab from a session-only list (`model/state/tabs.ts`).
- `view/modelLabel.ts`: model display names, and `modelTooltipName`, the one text of a model's tooltip (the id first). `view/theme.ts`: theme and editor font size.
- `utils/byteSize.ts`: `byteSizeText`, the one byte-count text. `utils/homePath.ts`: `pathWithTilde`; a view gets a path with `~` for the home folder from `dez.controller/displayPath` (`controller/utils.ts`).
- `utils/errorText.ts`: the shape of every user error text (`errorText`, `ExplainedError`, `explainedError`, `UNEXPECTED_ERROR`).
- `utils/dezLinks.ts`: the URLs of Dez's GitHub pages.

### SBP

[SBP](https://github.com/okTurtles/sbp): calls look like `sbp('domain/action', ...args)`; each domain is a stable API owned by one place:

- `dez.model/*`: `src/model/state/index.ts`
- `dez.persistence/*`: `src/model/persistence/index.ts`
- `dez.provider/*`: `src/model/providers/selectors.ts`
- `dez.controller/*`: `src/controller/`
- `dez.stream/*`: `src/controller/stream.ts`
- `dez.http/*`: `src/controller/http.ts`
- `dez.native/*`: `src/controller/native.ts`, the only frontend module that calls Tauri `invoke()`
- `dez.diagnostics/*`: `src/controller/diagnostics/` (sanitized probes only)
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
- `virtua` (the virtual list of the model picker) and `@videojs/html` (the media player). The tag list `videoJsElements` in `vite.config.ts` must match the video.js elements in `MediaPlayer.vue`.
- npm versions are exact pins, and `.npmrc` (`min-release-age`) refuses a version that is younger than 14 days: pin the newest version that it allows.

### Providers (`src/model/providers/`)

- Every provider is one plain-JSON `ProviderConfig` (`config.ts`), served by one `Provider` class (`provider.ts`) over two wire formats (`apiFormats.ts`: `openai`, `anthropic`). Built-ins are in `builtins.ts`; custom providers are in `app_state.json`; `registry.ts` finds both.
- To add a built-in, add a config literal to `builtins.ts`; no Rust change.
- Put provider differences in config data, never in `if (providerId === …)` branches.
- Provider ids must pass `isValidProviderId` (`config.ts`).
- Chat and model HTTP stays in TypeScript (`dez.provider/*`, `dez.http/*`), not in Rust.
- Thinking support, toggle, and send-back: `thinking.ts`, `apiFormats.ts`. Which models think is config data (`models[].thinking`, `modelThinking`; `config.ts`).
- Toggles are per model: `modelToggles.ts` is the one rule of which toggles (Thinking, Tools, each `settings[]` entry with its `modelIdPrefix` and `modelSupport`) apply to a model. The popup (`dez.provider/settingsDescriptor`) and the chat request (`Provider.chatRequest`) both read it. A toggle that does not apply sends nothing; unknown means "applies".
- `requestBody` (`config.ts`): a fixed part of every chat request body; Venice turns its own system prompt off with it.
- Prompt cache: earlier messages, the system prompt, and the tools array must stay the same bytes in every later request. The one exception: a user message with image parts changes once, when a newer user message comes (see "Images"). The Anthropic format always adds cache marks; OpenAI-format marks and `prompt_cache_key` come from config (`cacheBreakpoints`, `toolMessageCacheMark`, `promptCacheKey`; `apiFormats.ts`, `provider.ts`).
- Images: only the newest user message of a request carries image parts, for its own image references and its `@id` mentions (`model/streams/messages.ts`); an older message sends its references as text. `dez.provider/streamChat` reads the files (stored or linked) and base64-encodes them; a stored SVG goes as a PNG copy that the webview draws (`requestImage`, `selectors.ts`), in chat and media requests. A reference goes as `![image](<metadata>)` before its image part, so models get ids but no path. Which models read images is config data (`models[].imageInput`, `modelImageInput`, `imageRequestHeaders`; `config.ts`); a model known not to read them gets only that text.
- Tools: requests offer the Dez tools unless the provider's Tools toggle is off (`toolsSetting.ts`), the model is known not to call tools (`models[].toolCalling`, `modelToolCalling`; `config.ts`), or its request kind is not `chat`; then the tool blocks go as text. Wire shapes of calls and results: `apiFormats.ts`; request messages: `model/streams/messages.ts`.
- Outputs and request kinds (`MODEL_REQUESTS`, `MEDIA_KINDS` in `types.ts`; `modelOutputs` in `config.ts`; `modelParsing.ts`, `unusableModel.ts`): what a model makes and how Dez asks for it, from config data. `MODEL_INVOKE:` marks the places that a later `model_invoke` tool must change.
- Media (`mediaFormats.ts`, `clipRequests.ts`, `imageSize.ts`, `veniceReferences.ts`, `generatedImages.ts`, `pcmAudio.ts`, `multipart.ts`): the media wire formats (`mediaApi` in `config.ts`), `dez.provider/generateMedia` with its clip job loop (no tab or editor, so a tool can call it), `dez.provider/mediaQuote`, the fit of input images, and the stored image types. Never a resend with fewer images.
- Clip inputs (`clipInputs.ts`): which clips of the newest user message a media request takes, and how they go.
- Chat image output: `imageOutputBody` (`config.ts`) goes into a chat request only for a model whose outputs hold `image`; `openaiSse.ts` reads the images of the reply.
- Model parameters (`modelParameters.ts`, `clipText.ts`, `clipImages.ts`, `keptClipData.ts`): what a media request can set, and the text, image, and clip rules of a model; all data on the model, which `model_info` shows.
- Known limits (`knownLimits.json`, read by `knownLimits.ts`): rules of a model that the provider's data does not state (a provider rule that Dez does not check, or a limit of Dez), matched by media format or provider, request kind, and model id. `model_info` shows them as `dez.limits`; no request is refused by them.
- Learned image limits (`learnedImageLimit.ts`): the image count of a provider's refusal (`TooManyImagesError`) is kept per model, with a hash of the model's raw entries; Dez refuses a message with more images before any request until that entry changes. `model_info` shows it (`dez.images`, a `dez.limits` row).
- HTTP errors (`errors.ts`): status, stream, and connection errors as user texts (the fault and the fix first, the provider's sanitized text in the details). Format code knows no provider name.
- The API key goes only to URLs that Dez builds: a URL from a provider's response (a reply image, a clip) is fetched with no provider headers.

### Toasts

`src/view/toast/`: emit with `dez.ui/toast`; `ToastContainer.vue` (mounted in `AppLayout.vue`) renders them. Payloads and rules: `src/view/toast/README.md`. Chat request errors are sticky error toasts; the thread shows no error text.

### Backend (`src-tauri/src/`)

- **Keep Rust barebones**: a thin, generic OS interface, not a per-feature API. Reuse or generalize an existing command (e.g. `load_app_file(path)` / `save_app_file`, text or bytes at a path under a file root) instead of adding a near-copy, so frontend features rarely need Rust changes.
- `commands.rs`, `http_bridge.rs`, `notification.rs`, `idle.rs`: Tauri commands, registered in `lib.rs`. `open_devtools` (Help › Developer Console) needs the `devtools` feature of the `tauri` crate in release builds (`Cargo.toml`). `temp_folders`, `canonical_path`, and `dragged_file_paths` (the macOS drag pasteboard, through `objc2-app-kit`) tell a file drop to copy or to link.
- `http_bridge.rs`: generic `http_request`, `stream_http`, `cancel_http_stream`, and `download_app_file` (one response body streamed to a file). A request body is text, or bytes as base64 text (`HttpBody::Base64`; `NativeHttpBody` in `src/utils/protocol/nativeHttp.ts`); never send bytes as a JSON number array (slow).
- `notification.rs`: `show_notification`, a system notification whose click brings the window to the front and calls back (zbus on Linux, NSUserNotificationCenter through objc2 on macOS).
- `idle.rs`: `user_idle_ms`, the time since the last user input on the computer, or `null` when unknown.
- `session_bus.rs`: the one shared Linux D-Bus session connection (zbus) for `notification.rs` and `idle.rs`.
- `persistence.rs`: the file roots (`FileRoot`: `app`, the app folder; `cache`, Dez's folder in the OS cache folder), raw private-file I/O, the app-file path rule (subfolders such as `assets/images/`), file move and folder listing, and id sanitization; write every private file with `write_private_file` or `PrivateFileWriter`.
- `key_store.rs`: `provider_keys.json`. `copilot.rs`: Copilot device flow and token refresh.
- `lib.rs`: plugins, permission reasons, app bootstrap.
- `../tauri.linux.conf.json`: the Linux copy of the main window, with Tauri's native file drop on (a test in `lib.rs` keeps the two windows the same otherwise).
- `../tauri.conf.json` `app.macOSPrivateApi` and the `macos-private-api` feature of the `tauri` crate (`Cargo.toml`) go together: they turn on element fullscreen in WKWebView, for the media player.

## Persistence layout

All app data is under `~/.config/dez/`, except the temp copies of clips. TypeScript owns every format; Rust only moves raw strings and bytes. App code uses `dez.persistence/*` only.

- `app_state.json`: tabs, settings (with shortcut overrides, the picker's output filter, the user's model parameter values, and the custom system prompt, `systemPrompt`), window geometry, provider toggles, custom providers (`src/model/persistence/appState.ts`).
- `conversations/<sanitized-id>.md`: conversations (format: `src/model/persistence/conversationFormat.ts`; pill markers: `src/model/chat/pillMarker.ts`; tool calls: `src/model/chat/toolBlocks.ts`).
- `prompts.json`: saved prompt templates (`src/model/persistence/prompts.ts`).
- `model_cache.json`: last-known model lists with each model's outputs, request kind, capability flags, release date, clip data (parameters, text rules, image rules, clip rules, a file type that Dez does not store), and the learned image limit; no secrets and no raw provider entries (`src/model/persistence/modelCache.ts`). It is also the cache that keeps the clip data over a failed media list.
- `assets/images/<uuid>.<ext>`: pasted images, and dropped images that Dez copies; conversations refer to them by absolute path (`src/controller/images.ts`). Only the image trash and Settings › General › Unused files (`src/controller/unusedFiles.ts`) delete them; a text edit or a conversation delete leaves the file.
- `assets/generated/images/<uuid>.<ext>`: images that models and Dez tools made; the rules of `assets/images/` apply.
- `assets/audio/<uuid>.<ext>`, `assets/video/<uuid>.<ext>`: pasted clips, and dropped clips that Dez copies (`imageInsert.ts`; at most `MAX_SAVED_CLIP_BYTES`, `src/model/chat/mediaFiles.ts`).
- `assets/generated/audio/<uuid>.<ext>`, `assets/generated/video/<uuid>.<ext>`: clips that the user saved with the player's Save control, and clips that Dez tools made. Only the player's trash and the Unused files cleanup delete the files of the four clip folders (`src/controller/media.ts`).
- `<OS cache>/dez/media/<uuid>.<ext>` (`~/.cache/dez/media/` on Linux; outside the app folder): temp copies of clips that are not saved. Dez deletes one 24 hours after its file time (`MEDIA_TEMP_LIFETIME_MS`, `src/model/chat/mediaFiles.ts`).
- Linked files: a dropped image or clip that is in no temp folder and no Dez folder stays where it is, and a user section names it by its absolute path (`src/model/chat/linkedFiles.ts`); a section that links a file cannot switch to agent. Dez never deletes it (its trash removes only the text), and the Unused files scan does not list it.
- `provider_keys.json`: API keys and Copilot tokens (`src-tauri/src/key_store.rs`).

Do not ever read, view, print, or `cat` `~/.config/dez/provider_keys.json`; it can contain API keys and OAuth tokens.

## Gotchas

- **Do not leak sentinels**: the section and prompt pill sentinels (`cmEditor.ts`) live only in the editor doc, never on disk or in the clipboard.
- **First section is always `user`**: a role pill belongs to the section after it, so separator index math is easy to get off by one (`cmEditor.ts`).
- **`model`, `thinking`, and `durationMs` are agent-only**: show, save, or send them only when `role === 'agent'` (`durationMs` is never sent); copy them only when set (`modelRefField`, `thinkingField`, `durationField`).
- **Per-section fields flow through the editor**: the editor writes sections back to the store on every doc change; a new field must follow `SectionModel` in `cmEditor.ts`.
- **Section models are not doc text**: undo and redo put back the role and data of the sections they re-insert through `sectionsField`'s history hook (`cmEditor.ts`).
- **The editor holds the old tab for a tick after a switch**: write the view back only to `viewTabId`, and never give it another tab's section models (`ThreadEditor.vue`).
- **Each section is its own markdown text**: `sectionSeparatorMarkdown` (`cmEditor.ts`) ends paragraphs, quotes, and lists at a section separator; code fences and HTML blocks still run into the next sections.
- **Thinking has two copies during a stream** (store and visible editor); see `dez.editor/setSectionThinkingIfVisible`.
- **The thinking panel does not show the stored thinking as it is**: it shows `readableThinking` (`src/model/chat/thinking.ts`) and an encrypted pill in place of encrypted lines (`thinkingPill.ts`). Never change the stored thinking: `field` and `copilot` replays send it back, and the prompt cache needs the same bytes.
- **Agent pill DOM changes in place**: see `RoleSeparatorWidget.eq` and `pillThinkingUpdater` in `cmEditor.ts`.
- **Streams patch only the visible editor**: the store gets every token; the editor only when its tab is active (`dez.editor/appendTokenIfVisible`).
- **Stream scroll follow**: never add code that scrolls an editor view up (`src/view/editor/selectors.ts`).
- **Persistence starts after init**: settings changes made before `dez.model/settings/startPersistence` can be lost.
- **Provider role mapping**: internal role `agent` maps to API role `assistant` in both formats.
- **Copilot auth differs**: device flow commands, not the API-key commands.
- **Tauri capabilities**: a new plugin or core command needs a permission in `src-tauri/capabilities/default.json`; app commands registered in `lib.rs` need none.
- **The window starts hidden**: `dez.controller/window/restore` shows it, so a frontend failure before init shows no window; read the Vite output. On macOS, `lib.rs` shows it at launch so that it comes to the front.
- **Saved window position units differ by platform**: logical points on macOS, physical px elsewhere (`src/controller/window.ts`).
- **Wayland windows have no place**: GTK's Wayland backend cannot read or set the window position (`dez.native/gdkBackend`, `src/controller/window.ts`). The AppImage runs on X11.
- **Image references are plain text**: `![<absolute path>](id=a)` in a text node (old ones have empty parens; an image that a Dez tool made has `id=b|tool=<tool name>`); `src/model/chat/images.ts` is the one recognizer (editor, requests, titles, search). A stored path (a file directly in `assets/images/` or `assets/generated/images/`) counts in every section; a linked path (any other absolute path of an image type, `isLinkedImagePath`) counts only in a user section, so that a model's text never makes Dez read a file of the computer.
- **One id sequence for images and clips** (`src/model/chat/mediaIds.ts`): only a paste, a drop (`pastedMediaIds`, `imageInsert.ts`), or a reply that makes an image or a clip (`newMediaIds`, in the same tick as the write) gives an id. A pasted image or clip whose id another asset of the tab has gets a new id, and the pasted `@id` mentions of it follow (`pastedMediaIdChanges`). Never renumber an id that is in the doc.
- **`@id` mentions**: `@a` in a user message names the image or the clip `a` (`src/model/chat/imageMentions.ts`; `@a-team` is no mention). The text keeps the mention, and the request gets that image at that place while the message is the newest user message; an older message sends only its text. A clip goes only to a media request whose model takes clips (`messageClips`); a chat request gets only the request form of its tag. A mention reads only its own and earlier sections.
- **An image round has no thinking replay**: a chat round that made an image stores no replay, and the thinking of a round whose text holds an image reference of the model never goes back (`roundThinking`, `src/model/streams/messages.ts`). An image that a Dez tool made (its `tool` item, `IMAGE_TOOL_KEY`) does not count.
- **No stored file path to providers**: every request text (user and agent text, prompt bodies, the system prompt, tool arguments and results) goes through `withoutStoredFilePaths` (`src/model/chat/storedFilePaths.ts`, which knows every asset folder, the cache media folder, and the linked paths of image references and media tags) in `sectionsToStreamMessages` and `buildSystemPrompt`, and thinking that holds a path is not sent back; a new request text or a new folder of stored files needs the same.
- **The unused-files scan must read every text that can name a stored file**: a new place that holds such text (a store, a file under `~/.config/dez/`) must be read through `dez.model/heldTexts` (memory) or `dez.persistence/eachConversationText` (disk); else Settings › General › Unused files deletes files that the new place uses. A new folder of stored files joins the scan through `IMAGE_FOLDERS` or `MEDIA_FOLDERS` (`STORED_FILE_FOLDERS`, `src/model/chat/unusedFiles.ts`).
- **Tool calls are plain text**: `<dez:tool>` blocks in agent sections, with the result as the body; `src/model/chat/toolBlocks.ts` is the one writer and recognizer. Model text is escaped so that it never forms a block (`ModelTextEscaper`). Find blocks in one agent section at a time, never in the whole doc.
- **Chip spacing is view only**: a blank line between two tool chips takes no height while no caret is on it, and a chip next to content gets the space of a blank line (`ChipSpacing`, `view/editor/toolCalls.ts`). Never change the text of a reply for its look: the rounds of a reply are read from it (`agentRounds`).
- **Media tags are plain text**: `<dez:audio …/>` and `<dez:video …/>`, each one whole line of a section (an agent section's made clips, a user section's pasted or dropped clips); `src/model/chat/mediaTags.ts` is the one writer and recognizer, and a rewrite keeps unknown attributes. A `src` that names a linked file counts only in a user section (`isLinkedMediaPath`, `sectionClipSource`). A request holds only the tag's request form (`id` and `type`; `agentTextForRequest`, `mediaTagsForRequest`), so a Save, a Delete, or an expiry changes no request bytes, and no path or signed URL goes to a provider (the one exception: the `https` URL of an input clip of a `urlOnly` kind, `clipInputs.ts`). `ModelTextEscaper` covers these tags too.
- **Reply images and clips are written only while the reply is current** (`replyIsCurrent`, `controller/stream.ts`): a cancelled request can still give a response.
- **Raw model entries are in memory only** (`dez.model/modelCache/rawModel`): never in `model_cache.json` or the snapshot, so there is none after an app start until the provider's next model check. So a fact of a model that a request or the UI needs must be a field of `ModelInfo` and of `model_cache.json`. Provider data that a tool result passes on goes through `jsonWithoutLocalPaths` (`src/model/tools/localPaths.ts`) when the result text is built: a tool result is stored as it was sent.
- **One agent section per reply**: tool rounds stay in one section; its thinking keeps one entry per later round (`SectionThinking.rounds`, the `rounds` pill attribute), and each round's replay goes back after its own tool calls.
- **A tool's image or clip goes after the blocks of its group**, at the section end (`ToolRunContext.writeImage`, `writeClip`, `controller/tools.ts`), and the next request of the reply ends at the last tool message (`runChatRounds`, `controller/stream.ts`): text after it would be a prefill.
- **The system prompt and the tools are in the cached prefix**: never put a date, a count, or a random value into `systemPrompt.md`, its placeholder values, or a tool definition. A change of them between releases of Dez is fine.
- **The asset protocol reads every file**: the `assetProtocol` scope in `tauri.conf.json` is `/**` with dot folders (`requireLiteralLeadingDot: false`), as a linked file can be anywhere (the `protocol-asset` comment in `Cargo.toml`). So the webview must never load remote code: it could read any file, `provider_keys.json` too.
- **Clips come through Rust, and local clips play from a blob URL**: a clip response goes to a file with `dez.native/downloadAppFile`, never through `dez.http/stream` as bytes (the one exception: an `audio/pcm` speech response, which `pcmAudio.ts` makes into a WAV file). WebKitGTK loads no media from the asset protocol, so `MediaPlayer.vue` reads a local file and plays a blob URL; its bytes stay in memory until the page collects the `Blob`, not only until the revoke. A clip plays from a provider URL only when its server answers range requests; else Dez keeps a temp copy.
- **A new editor state makes new players**: a stream end or a tab switch stops a clip that plays; other doc changes keep the player's DOM (`updateDOM`, `view/editor/media.ts`).
- **A removed media element frees nothing by itself**: WebKit keeps its player (on Linux a GStreamer pipeline with a connection to the sound server) until `releaseRemovedMedia` (`view/media/releaseMedia.ts`) runs; a media element that Vue can remove needs `v-release-on-remove` (`MediaPlayer.vue`). Never tear a player down at the start of its load (a WebKitGTK deadlock; the comment of `releaseRemovedMedia`).
- **A fullscreen player hides the app's layers**: the delete prompt and the toasts are outside the fullscreen element (the player's card), so code that shows one for a player calls `leaveFullscreen` first (`view/editor/media.ts`). An element that leaves the document ends its fullscreen, so the player must stay attached over a tag rewrite (`MediaWidget.updateDOM`).
- **The card of a video holds a second, empty `<video>`** (`.media-player__stand-in`, `MediaPlayer.vue`): on macOS it keeps WebKit's text recognition view, which takes every click, off a fullscreen clip. Keep it with no source, larger than the clip's video, and after it in the DOM.
- **The model picker draws only the rows in view** (`virtua`): a far row has no DOM. The rows set `pointer-events: auto`, because virtua turns pointer events off on its box for a moment after a scroll; a new clickable row kind needs the same.
- **File drops differ by platform**: WebKitGTK gives the page no dropped `File`, so Linux uses Tauri's native drop (`tauri.linux.conf.json`, `dez.controller/images/watchFileDrops`); macOS keeps HTML5 drops, as the native drop would take text drags too, and pairs each `File` with a path of the drag pasteboard by name and size (`dez.controller/images/droppedFilePaths`; only a Mac can test it). A drop copies a file from a temp folder or a Dez folder, and any file dropped into an agent section; it links any other file (`src/model/chat/linkedFiles.ts`, `imageInsert.ts`). `AppLayout.vue` refuses file drops that no handler took.
- **Read monitors with `dez.native/monitors`**, never the window API's `availableMonitors()`, `primaryMonitor()`, or `currentMonitor()`: in Tauri 2.10 those call GDK off the main thread and can crash the app on X11 (`monitors` in `commands.rs`).
- **Shortcut key order differs by platform**: on Linux the menu accelerator gets the key first; put context checks in the selector both paths call, never only in a key handler.
- **Never hard-code a shortcut key**: every binding path (window handler, CodeMirror keymap, find field, menu accelerators, button titles and keycaps) reads the effective keys from `src/model/shortcuts.ts` and the settings store.
- **CSP disabled**: `"csp": null` in `tauri.conf.json` on purpose during development.
- **Vite port is fixed**: `1420` with `strictPort: true`.
- **`@tauri-apps/plugin-store` is unused**: app files use Dez's own Rust file I/O.
- **Secrets wrapper is not a vault**: `src/utils/secret.ts`; never log provider headers, native HTTP payloads, or diagnostics without sanitization.
- **Sounds are in Git LFS**: clone with LFS (`git lfs pull`); CI checkouts use `lfs: true`. A pointer file builds with no error, and only `play()` fails (the e2e guard in `tests/e2e/notifications.e2e.ts` catches it).
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
- Error texts for the user tell whose fault it is (the message, the model choice, the provider, the network, or Dez) and what to do; raw details (a provider's text, a status, a native error) go last, after "Details:" (`errorText`, `src/utils/errorText.ts`). Throw such a text as an `ExplainedError`; any other error shows as one that Dez did not expect (`explainedError`). Never show only a raw error when Dez knows the cause.
- A Dez tool that gets a bad call answers with a text that tells the model how to fix the call; a failure that is not the call's fault says so and what the model can tell the user. A runner throws a `ToolError` (`src/model/tools/types.ts`); a tool result holds no local path.
- Modifications to the project README must be tiny and generally avoided. Larger modifications require user approval (ask first).
- Dez should avoid taking actions on its own that would result in the user's private info (like file paths) being exposed to providers. It's fine if users type them manually themselves, but for example, when designing features like image drag and drop, the image's file path shouldn't be sent to providers.

## Testing approach

- Unit tests: Vitest with colocated `*.test.ts` files; `npm test` also runs `scripts/*.test.js`. Rust unit tests are in the `src-tauri/src/*.rs` files.
- Shared unit test helpers are in a `testing.ts` module next to their tests (`src/model/providers/testing.ts`, `src/view/editor/testing.ts`); never copy one into a test file.
- Run `npm run build` at the end of a task step with frontend changes (it type-checks), not after every edit.
- Run `npm test` after frontend logic changes.
- Run `cd src-tauri && cargo check` after significant Rust changes, and `cargo test` when touching Rust logic with tests.
- Run `npm run test:e2e` after UI behavior changes covered by `tests/e2e/`. It runs the existing debug binary: rebuild first (`tests/e2e/harness/app.ts`).
- Run `npm run typecheck:e2e` after changing the e2e harness or specs.
- No test may call a real provider or run a paid generation: media specs use mock servers only (`tests/e2e/harness/mockServer.ts`, `media.ts`).
- E2E model list data: a spec whose model needs list data (parameters, text rules, image rules, clip rules) gives the mock its `jsonAnswers` (`startMockProviderApp`, `tests/e2e/harness/mockProviderApp.ts`) and uses a custom provider with `fetchModels: true` (`tests/e2e/music.e2e.ts`).
- The e2e app has its own `HOME`, `XDG_CONFIG_HOME`, and `XDG_CACHE_HOME` in a temp folder (`tests/e2e/harness/app.ts`).
- E2E keys skip GTK, so specs never test Linux menu accelerators; the manual recipe is in `vitest.e2e.config.ts`.
- E2E cannot send real clipboard data or OS file drags: `tests/e2e/images.e2e.ts` builds paste and drop events in the page and emits `tauri://drag-drop`; the manual recipe for real ones is in `vitest.e2e.config.ts`. The e2e app's home is in a temp folder, so a drop from it is copied: a linked-drop spec puts its files in `linkedDropDir` (`tests/e2e/harness/drops.ts`).
- E2E specs that restart the app use `MockProviderApp.relaunch()` (`tests/e2e/harness/mockProviderApp.ts`). `model_cache.json` is saved 1 s after a model check: wait for it with `readModelCache` (`tests/e2e/harness/fixtures.ts`) before a relaunch.
- E2E seeds turn the reply-end alerts off (`quietAppState`, `tests/e2e/harness/fixtures.ts`). Alert specs use the fake notification server (`tests/e2e/harness/notificationServer.ts`) and `setUserIdleMs` (`tests/e2e/notifications.e2e.ts`).
- E2E clicks: never use webdriverio's `.click()`; use `click()`, `pointerClick()`, `pointerClickAt()`, `pointerShiftClickAt()`, or `pointerRightClickAt()` (only where the page cancels the `contextmenu`) from `tests/e2e/harness/dom.ts`. Shared spec helpers (pointer, caret, doc, toasts, mock replies, images, clips, the parameter popup, process reads) are in `tests/e2e/harness/`; never copy one into a spec.
- E2E specs that check a whole chat request body build the expected system prompt and tools with `tests/e2e/harness/chatBody.ts`; a multipart body that the mock got is read with `requestForm` (`tests/e2e/harness/mockServer.ts`).
- E2E picker reads: use `pickerRows`, `pickerGroups`, and `pickModel` (`tests/e2e/harness/thread.ts`), which scroll the virtual list to read every row; `drawnPickerRows` reads only the rows in the DOM.
- E2E clips (`tests/e2e/media-player.e2e.ts`, `tests/e2e/harness/media.ts`, `tests/e2e/fixtures/`): a test clip must be in a format that the CI GStreamer packages decode (VP9 in webm or mp4, wav; `.github/workflows/e2e.yml`).
- E2E specs that open a URL call `stopOpenUrl` (`tests/e2e/harness/dom.ts`), an SBP filter on `dez.controller/openUrl`, so no browser opens.
- **No display server** (every spec fails with `Hook timed out in 120000ms` in `beforeAll`): run under headless `kwin_wayland`; the recipe is in `vitest.e2e.config.ts`.
- For UI changes beyond unit-testable logic, also check by hand with `npm run tauri dev`.
