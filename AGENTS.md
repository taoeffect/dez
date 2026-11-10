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
npm run bump-version -- <version>                    # a real release: bumps the version files, signs, commits, tags, pushes
npm run bump-version -- [--check | --files-only] <version>   # only check, or only bump, the npm, Tauri, and Cargo version files
node scripts/release-notes.js <tag> [--out <file>]   # release notes body for a tag
npm run preview                # preview the built frontend
cd src-tauri && cargo check
cd src-tauri && cargo test
```

- Tauri build scripts first run `npm run clean:rust` (`scripts/clean-rust.js`).
- `build:linux:appimage` runs `scripts/build-linux-appimage.js`; the AppImage bundles the build host's GStreamer plugins.
- macOS builds need Xcode 26+: `build:macos:*` first run `scripts/build-macos-icon.js`, which compiles `src-tauri/icons/Dez.icon` into the gitignored `src-tauri/icons/Assets.car` (icon name set in `src-tauri/Info.plist`). A bare `tauri build` on macOS fails without that file.
- Releases: `npm run bump-version -- <version>` (`scripts/bump-version-and-release.js`) makes the whole release: it bumps the version files, signs the version with the developer's commit key (public key: `src-tauri/updater/dez-commit-key.pub`), commits, tags `v<version>`, and pushes. Never run it for a test or a temporary bump; use `--files-only`. A pushed `v*` tag runs `.github/workflows/release-desktop.yml` (version check against the tag, e2e gate, Linux AppImages, macOS DMG and its minisign signature, release notes from `scripts/release-notes.js`, GitHub Release). The rules are in the comments of those files.
- CI rules (details in the workflow comments): every job removes the compromised eMudhra CA roots in its first step, only the "Write release notes" step may reference `ZAI_API_KEY`, only the "Sign manifest" step may reference `MINISIGN_SECRET_KEY`, and its job (`sign-macos-manifest`) pins every action to a commit SHA.

## Git conventions

Commit messages must use an 80-character maximum line width for both subject and body.

## Architecture

Dez follows an SBP MVC pattern: selectors are the cross-layer API, and code lives in the owning MVC layer. Tauri v2 is the Rust backend; Vue 3 / TypeScript / Vite is the frontend. Pinia setup stores are internal model details.

- `src/model/`: domain state, persistence formats, providers, chat/stream model logic, and model selectors.
- `src/controller/`: user workflows, startup/shutdown, native/Tauri boundaries, the native menubar, HTTP runtime orchestration, updates, and diagnostics.
- `src/view/`: Vue UI, view composables, CodeMirror editor services, toast/theme/clipboard UI selectors, and reactive read adapters.
- `src/utils/`: cross-layer utilities only.
- `src-tauri/`: Rust commands, native HTTP bridge, persistence file I/O, credential storage, the macOS updater, and app bootstrap.

 Always build code cleanly, modularly, and with proper architecture and separation of concerns.

### Runtime data flow

```text
ThreadEditor (CodeMirror doc) syncs to the active tab's sections
  -> Mod-Enter (key, Submit button, Conversation › Send) -> dez.controller/submitTab
    -> dez.model builds the request messages and stamps the trailing agent section
    -> dez.stream/start (Dez's system prompt and tools) -> dez.provider/streamChat -> dez.http/stream
      -> dez.native/streamHttp -> Rust http_bridge::stream_http (Headers/Chunk/Done/Error)
    -> openaiSse.ts / anthropicSse.ts split answer tokens, thinking tokens, and tool calls
    -> tokens go to the store, and to the editor if the tab is visible (dez.editor/*)
    -> a round that ends with tool calls writes <dez:tool> blocks, runs them (dez.controller/tools/run),
       and sends the next round; one reply is one agent section
    -> the reply's finish/error/cancel reconciles the editor, adds a user section, and saves
    -> finish/error of a reply the user does not look at -> dez.controller/alertReplyEnded (sound, notification)
```

### Frontend map (`src/`)

- `main.ts`: registers all selectors; dev builds expose `window.__stores`.
- `view/thread/ThreadEditor.vue`: the one CodeMirror `EditorView` (no contenteditable).
- `view/thread/cmEditor.ts`: doc ⇄ sections, sentinels, state fields, role pill widgets, clipboard format, `dezTheme`.
- `view/thread/modelChip.ts`, `thinkingPill.ts`, `pillDuration.ts`: the model part, the thinking slot and panel, and the reply time of an agent pill.
- `view/thread/editorMeasure.ts`: forced CodeMirror re-measures.
- `view/editor/selectors.ts`: `dez.editor/*`, the active-editor bridge (stream patching, scroll follow, Copy Markdown, `runKeyBinding`).
- `view/editor/find.ts`, `findState.ts`, `findHistory.ts`, `view/thread/FindDropdown.vue`: find and replace.
- `view/editor/tables.ts`: GFM tables shown as tables, in place.
- `view/editor/links.ts`: markdown links (`http`, `https`, `mailto`, `tel`) shown as links, with their source while a selection touches them; a plain click opens one (`dez.controller/openUrl`), and hover shows its URL in a tooltip.
- `view/editor/focus.ts`: focus the editor and keep its scroll; use `focusKeepingScroll`, not `view.focus()`. `syncDomSelection`: fix the caret after code changes the doc right after the editor gets the focus.
- `view/editor/images.ts`, `imageInsert.ts`: images shown in place of their references (with a hover toolbar at the image's top-right corner: the id badge and a trash that deletes the image after a `dez.ui/confirm` prompt, each with a tooltip; and the Backspace and Delete rules), and image paste and drop (which give image ids). `pendingRanges.ts`: doc ranges that the async insert and delete flows follow.
- `controller/images.ts`: `dez.controller/images/*`: store and delete an image, its display URL, read a dropped file, Linux native file drops.
- `view/editor/toolCalls.ts`: `<dez:tool>` blocks shown as chips, each with a panel of its parameters and result.
- `model/chat/`: `Section` / `ContentNode` types and helpers (`content.ts`, `modelRef.ts`, `thinking.ts`, `markdown.ts`, `pillMarker.ts`, `images.ts`, `toolBlocks.ts`).
- `model/state/`: Pinia stores (internal) and `dez.model/*` selectors; views read state through `view/modelState.ts`.
- `controller/stream.ts`, `model/state/streams.ts`, `controller/http.ts`: stream lifecycle (one reply, one request round per group of tool calls), per-tab sessions, native HTTP streams.
- `model/tools/`: the Dez tools (tools that Dez runs for a model, not a provider's own tools such as web search): definitions, `registry.ts` (`TOOL_DEFINITIONS`, JSON schemas, argument checks), `modelList.ts` (`model_list`). `controller/tools.ts`: `dez.controller/tools/run`, the code of each tool. `model/streams/toolRound.ts`: the pure parts of the tool loop.
- `model/systemPrompt/`: Dez's system prompt (`systemPrompt.md` with `{{name}}` placeholders, `template.ts`), sent with every chat request.
- `model/modelSearch.ts`: the model filter of the model picker and `model_list`.
- `controller/notifications.ts`: the reply-end alerts (sound, system notification; a click opens the reply's tab). `view/sound.ts`: `dez.ui/playDoneSound`. `assets/sounds/`: sound files (Git LFS).
- `model/shortcuts.ts`: the editable shortcut registry (ids, default keys, key event matching, validation, labels, menu accelerators); user overrides are in the settings store.
- `controller/menu.ts`: the native menubar (Tauri only); `dez.controller/menu/suspendAccelerators` turns its keys off while a key is recorded. `view/composables/useKeyboardShortcuts.ts`: app keys.
- `controller/window.ts`, `windowFit.ts`: restore and save the window size and position.
- `view/app/AppLayout.vue`: layout and bottom bar (`ModelSelector.vue`, `view/thread/SubmitButton.vue`).
- `view/history/HistoryPanel.vue`: saved conversations.
- `view/confirm/`: `dez.ui/confirm`, the in-app yes/no prompt (`ConfirmDialog.vue`, mounted in `AppLayout.vue`); `isModalOpen()` (`useKeyboardShortcuts.ts`) counts it. `view/composables/modal.ts`: the focus restore, Tab trap, and overlay-click dismissal that the in-app modals share (`ConfirmDialog.vue`, `UpdateWindow.vue`, `UpdateRefusedDialog.vue`).
- `view/prompts/PromptManager.vue`, `view/thread/PromptAutocomplete.vue`: saved prompts and `/prompt ` insertion.
- `view/settings/SettingsView.vue`, `ProviderManager.vue`, `ShortcutManager.vue`: settings, the providers page, and Settings › Shortcuts with its key recorder (Help › Keyboard Shortcuts opens it).
- `controller/updates.ts`: the update check and its reports (`dez.controller/checkForUpdates`), the macOS install (`dez.controller/updates/install`: download, install, save, relaunch), the report of a refused update (`dez.controller/updates/reportRefusal`), and the startup report of the last install (`dez.controller/updates/reportLastInstall`). `model/updates/`: Zod parsing of GitHub's release list and of each release's change notes; `refusal.ts`: the failed check of a refused update and the report text. `model/state/updates.ts`: the store behind `dez.model/updates/*`. `view/updates/UpdateWindow.vue`: the update window (the changes of each newer release, Download and Install, progress); Settings › General shows the check status. `view/updates/UpdateRefusedDialog.vue`: the dialog of an update that failed a release check (the release may be compromised); it has its own store state, `isModalOpen()` counts it, and only Esc and its Close button close it.
- `view/tabs/TabBar.vue`: tabs, colored busy/done by `dez.model/tabs/activity`, pointer drag to reorder (`dez.model/tabs/move`). The `+` button, keys, and File menu create tabs with `dez.controller/newTab` (`controller/tabs.ts`), which focuses the editor (`dez.editor/focus`). `dez.model/tabs/reopenClosed` brings back a closed tab from a session-only list (`model/state/tabs.ts`).
- `view/modelLabel.ts`: model display names. `view/theme.ts`: theme and editor font size.

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

### Providers (`src/model/providers/`)

- Every provider is one plain-JSON `ProviderConfig` (`config.ts`), served by one `Provider` class (`provider.ts`) over two wire formats (`apiFormats.ts`: `openai`, `anthropic`). Built-ins are in `builtins.ts`; custom providers are in `app_state.json`; `registry.ts` finds both.
- To add a built-in, add a config literal to `builtins.ts`; no Rust change.
- Put provider differences in config data, never in `if (providerId === …)` branches.
- Provider ids must pass `isValidProviderId` (`config.ts`).
- Chat and model HTTP stays in TypeScript (`dez.provider/*`, `dez.http/*`), not in Rust.
- Thinking support, toggle, and send-back: `thinking.ts`, `apiFormats.ts`.
- `requestBody` (`config.ts`): a fixed part of every chat request body; Venice turns its own system prompt off with it.
- Prompt cache: earlier messages, the system prompt, and the tools array must stay the same bytes in every later request. The Anthropic format always adds cache marks; OpenAI-format marks and `prompt_cache_key` come from config (`cacheBreakpoints`, `toolMessageCacheMark`, `promptCacheKey`; `apiFormats.ts`, `provider.ts`).
- Images: a user message with image references becomes text and image parts (`model/streams/messages.ts`); `dez.provider/streamChat` reads the files and base64-encodes them. A reference goes as `![image](<metadata>)` before its image part, so models get ids but no path. Which models read images is config data (`models[].imageInput`, `modelImageInput`, `imageRequestHeaders`; `config.ts`); a model known not to read them gets only that text.
- Tools: requests offer the Dez tools unless the provider's Tools toggle is off (`toolsSetting.ts`) or the model is known not to call tools (`models[].toolCalling`, `modelToolCalling`; `config.ts`); then the tool blocks go as text. Wire shapes of calls and results: `apiFormats.ts`; request messages: `model/streams/messages.ts`.

### Toasts

`src/view/toast/`: emit with `dez.ui/toast`; `ToastContainer.vue` (mounted in `AppLayout.vue`) renders them. Payloads and rules: `src/view/toast/README.md`. Chat request errors are sticky error toasts; the thread shows no error text.

### Backend (`src-tauri/src/`)

- **Keep Rust barebones**: a thin, generic OS interface, not a per-feature API. Reuse or generalize an existing command (e.g. `load_app_file(path)` / `save_app_file`, text or bytes at a path relative to the app folder) instead of adding a near-copy, so frontend features rarely need Rust changes. The one exception is the macOS updater (`updater/`).
- `commands.rs`, `http_bridge.rs`, `notification.rs`, `idle.rs`: Tauri commands, registered in `lib.rs`. `open_devtools` (Help › Developer Console) needs the `devtools` feature of the `tauri` crate in release builds (`Cargo.toml`).
- `http_bridge.rs`: generic `http_request`, `stream_http`, `cancel_http_stream`.
- `notification.rs`: `show_notification`, a system notification whose click brings the window to the front and calls back (zbus on Linux, NSUserNotificationCenter through objc2 on macOS).
- `idle.rs`: `user_idle_ms`, the time since the last user input on the computer, or `null` when unknown.
- `session_bus.rs`: the one shared Linux D-Bus session connection (zbus) for `notification.rs` and `idle.rs`.
- `persistence.rs`: raw private-file I/O, the app-file path rule (subfolders such as `assets/images/`), and id sanitization; write every private file with `write_private_file`.
- `key_store.rs`: `provider_keys.json`. `copilot.rs`: Copilot device flow and token refresh.
- `updater/`: the macOS self-updater. It is a feature of its own because a generic "replace a file" or "run a process" command would let a compromised webview install code (module docs in `mod.rs`). `mod.rs`: the commands `can_install_update`, `download_update`, `install_update`, `relaunch_after_update`; `verify.rs`: the key, URL, version, and signature rules; `macos.rs`: mount, bundle checks, swap, binary fallback, and the relaunch helper. The release public key is `src-tauri/updater/minisign.pub`; test fixtures are in `src-tauri/updater/test-fixtures/`.
- `lib.rs`: plugins, permission reasons, app bootstrap.
- `../tauri.linux.conf.json`: the Linux copy of the main window, with Tauri's native file drop on (a test in `lib.rs` keeps the two windows the same otherwise).

## Persistence layout

All app data is under `~/.config/dez/`. TypeScript owns every format; Rust only moves raw strings and bytes. App code uses `dez.persistence/*` only.

- `app_state.json`: tabs, settings (with shortcut overrides), window geometry, provider toggles, custom providers (`src/model/persistence/appState.ts`).
- `conversations/<sanitized-id>.md`: conversations (format: `src/model/persistence/conversationFormat.ts`; pill markers: `src/model/chat/pillMarker.ts`; tool calls: `src/model/chat/toolBlocks.ts`).
- `prompts.json`: saved prompt templates (`src/model/persistence/prompts.ts`).
- `model_cache.json`: last-known model lists, no secrets (`src/model/persistence/modelCache.ts`).
- `assets/images/<uuid>.<ext>`: pasted and dropped images; conversations refer to them by absolute path (`src/controller/images.ts`). Only the image trash deletes them; a text edit or a conversation delete leaves the file.
- `updates/pending.json`: the version that an update install relaunched Dez into; the next startup reads and deletes it and reports the result (`src/model/persistence/pendingUpdate.ts`). `updates/update.log`: the log of the update's relaunch helper, which Rust writes (`UPDATE_LOG`, `src-tauri/src/updater/mod.rs`).
- `provider_keys.json`: API keys and Copilot tokens (`src-tauri/src/key_store.rs`).

Do not ever read, view, print, or `cat` `~/.config/dez/provider_keys.json`; it can contain API keys and OAuth tokens.

## Gotchas

- **Do not leak sentinels**: the section and prompt pill sentinels (`cmEditor.ts`) live only in the editor doc, never on disk or in the clipboard.
- **First section is always `user`**: a role pill belongs to the section after it, so separator index math is easy to get off by one (`cmEditor.ts`).
- **`model`, `thinking`, and `durationMs` are agent-only**: show, save, or send them only when `role === 'agent'` (`durationMs` is never sent); copy them only when set (`modelRefField`, `thinkingField`, `durationField`).
- **Per-section fields flow through the editor**: the editor writes sections back to the store on every doc change; a new field must follow `SectionModel` in `cmEditor.ts`.
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
- **Image references are plain text**: `![<absolute path>](id=a)` in a text node (old ones have empty parens); `src/model/chat/images.ts` is the one recognizer (editor, requests, titles, search), and only files directly in `assets/images/` count. Only a paste or a drop gives ids (`pastedImageIds`, `imageInsert.ts`); never renumber an id in the doc.
- **No image path to providers**: every request text (user and agent text, prompt bodies, tool arguments and results) goes through `withoutImagePaths` (`src/model/chat/images.ts`) in `sectionsToStreamMessages`, and thinking that holds a path is not sent back; a new request text needs the same.
- **Tool calls are plain text**: `<dez:tool>` blocks in agent sections, with the result as the body; `src/model/chat/toolBlocks.ts` is the one writer and recognizer. Model text is escaped so that it never forms a block (`ModelTextEscaper`). Find blocks in one agent section at a time, never in the whole doc.
- **One agent section per reply**: tool rounds stay in one section; its thinking keeps one entry per later round (`SectionThinking.rounds`, the `rounds` pill attribute), and each round's replay goes back after its own tool calls.
- **The system prompt and the tools are in the cached prefix**: never put a date, a count, or a random value into `systemPrompt.md`, its placeholder values, or a tool definition.
- **The asset scope must match the app folder**: the `assetProtocol` scope in `tauri.conf.json` names the folder that `base_dir()` (`persistence.rs`) builds.
- **File drops differ by platform**: WebKitGTK gives the page no dropped `File`, so Linux uses Tauri's native drop (`tauri.linux.conf.json`, `dez.controller/images/watchFileDrops`); macOS keeps HTML5 drops, as the native drop would take text drags too. `AppLayout.vue` refuses file drops that no handler took.
- **Read monitors with `dez.native/monitors`**, never the window API's `availableMonitors()`, `primaryMonitor()`, or `currentMonitor()`: in Tauri 2.10 those call GDK off the main thread and can crash the app on X11 (`monitors` in `commands.rs`).
- **Shortcut key order differs by platform**: on Linux the menu accelerator gets the key first; put context checks in the selector both paths call, never only in a key handler.
- **Never hard-code a shortcut key**: every binding path (window handler, CodeMirror keymap, find field, menu accelerators, button titles and keycaps) reads the effective keys from `src/model/shortcuts.ts` and the settings store.
- **CSP disabled**: `"csp": null` in `tauri.conf.json` on purpose during development.
- **Vite port is fixed**: `1420` with `strictPort: true`.
- **`@tauri-apps/plugin-store` is unused**: app files use Dez's own Rust file I/O.
- **Secrets wrapper is not a vault**: `src/utils/secret.ts`; never log provider headers, native HTTP payloads, or diagnostics without sanitization.
- **Sounds are in Git LFS**: clone with LFS (`git lfs pull`); CI checkouts use `lfs: true`. A pointer file builds with no error, and only `play()` fails (the e2e guard in `tests/e2e/notifications.e2e.ts` catches it).
- **Every release needs a `.minisig`**: an installed macOS Dez installs a DMG only when its minisign signature verifies against the compiled-in `src-tauri/updater/minisign.pub` (CI's "Sign DMG" step). A release without one cannot update macOS installs, and a new key locks out every installed Dez that has the old one. `README.md` and `.github/release-notes-template.md` publish the key, so a key change updates them too.
- **The updater trusts only Rust-side inputs**: the webview passes only a version and the `.minisig` text; Rust builds the download URL, holds the key, and keeps every path in its own state and private temp dir, never under `~/.config/dez`. Never add an updater input that is a path or a URL.
- **macOS can refuse the self-update**: `can_install_update` refuses dev builds, App Translocation, and disk-image or read-only volumes; App Management (TCC) can deny writes to the app's folder (then the binary fallback, then an error that names App Management). Each build has a new ad-hoc code identity, so TCC grants can reset after an update.
- **Never write into a running binary**: macOS kills a process whose executable changes in place (`Killed: 9`). The relaunch helper copies to a new file and `mv`s it over (`HELPER_SCRIPT`, `macos.rs`).
- **Save before Dez quits itself**: a quit loses the saves that debounces still hold, so the update relaunch first calls `dez.controller/window/flushGeometry`, then `dez.model/persistence/flush` (which saves the geometry that the first one puts into the settings).
- **Minimum macOS 13.0** (`bundle.macOS.minimumSystemVersion`, `tauri.conf.json`): the updater mounts the DMG with `diskutil image attach`, as `hdiutil` is deprecated on macOS 27.
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
- Modifications to the project README must be tiny and generally avoided. Larger modifications require user approval (ask first).
- Dez should avoid taking actions on its own that would result in the user's private info (like file paths) being exposed to providers. It's fine if users type them manually themselves, but for example, when designing features like image drag and drop, the image's file path shouldn't be sent to providers.

## Testing approach

- Unit tests: Vitest with colocated `*.test.ts` files; `npm test` also runs `scripts/*.test.js`. Rust unit tests are in the `src-tauri/src/` files.
- Run `npm run build` at the end of a task step with frontend changes (it type-checks), not after every edit.
- Run `npm test` after frontend logic changes.
- Run `cd src-tauri && cargo check` after significant Rust changes, and `cargo test` when touching Rust logic with tests.
- The macOS updater has no e2e: its Rust tests build a fake app and DMG (macOS 14+), and the end-to-end check is a manual smoke test with test-hook builds (cargo feature `updater-test-hooks`, `VITE_DEZ_RELEASES_API_URL`); the recipe is in `src-tauri/src/updater/verify.rs`.
- Run `npm run test:e2e` after UI behavior changes covered by `tests/e2e/`. It runs the existing debug binary: rebuild first (`tests/e2e/harness/app.ts`).
- Run `npm run typecheck:e2e` after changing the e2e harness or specs.
- E2E keys skip GTK, so specs never test Linux menu accelerators; the manual recipe is in `vitest.e2e.config.ts`.
- E2E cannot send real clipboard data or OS file drags: `tests/e2e/images.e2e.ts` builds paste and drop events in the page and emits `tauri://drag-drop`; the manual recipe for real ones is in `vitest.e2e.config.ts`.
- E2E specs that restart the app use `MockProviderApp.relaunch()` (`tests/e2e/harness/mockProviderApp.ts`).
- E2E seeds turn the reply-end alerts off (`quietAppState`, `tests/e2e/harness/fixtures.ts`). Alert specs use the fake notification server (`tests/e2e/harness/notificationServer.ts`) and `setUserIdleMs` (`tests/e2e/notifications.e2e.ts`).
- E2E clicks: never use webdriverio's `.click()`; use `click()`, `pointerClick()`, or `pointerClickAt()` from `tests/e2e/harness/dom.ts`. Shared spec helpers (pointer, caret, doc, toasts, mock replies) are in `tests/e2e/harness/`; never copy one into a spec.
- E2E specs that check a whole chat request body build the expected system prompt and tools with `tests/e2e/harness/chatBody.ts`.
- E2E specs that open a URL stop `dez.controller/openUrl` with an SBP filter, so no browser opens (`tests/e2e/links.e2e.ts`).
- **No display server** (every spec fails with `Hook timed out in 120000ms` in `beforeAll`): run under headless `kwin_wayland`; the recipe is in `vitest.e2e.config.ts`.
- For UI changes beyond unit-testable logic, also check by hand with `npm run tauri dev`.
