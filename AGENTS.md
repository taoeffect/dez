# AGENTS.md

If `CLAUDE.md` exists in this repository, it is a symlink to this file; edit only `AGENTS.md`, never `CLAUDE.md` directly.

## Commands

```bash
# Install dependencies before building or packaging
npm ci

# Rust build auto-cleanup: Tauri build scripts run `npm run clean:rust`
# first, which deletes Rust build artifacts older than 14 days from
# src-tauri/target via scripts/clean-rust.js. cargo-sweep is optional;
# without it the cleanup is skipped and builds still work.

# Development (frontend only, no Tauri shell)
npm run dev

# Development (full desktop app)
npm run tauri dev

# Build
npm run build              # frontend only: vue-tsc --noEmit && vite build
npm run tauri build        # production Tauri bundle

# Frontend unit tests
npm test

# Frontend unit tests in watch mode
npm run test:watch

# E2E UI tests (WebDriver driving the real Tauri app; Linux only, needs
# tauri-driver + WebKitWebDriver; build the debug binary first; with no
# display server, see "GUI tests without a display" under Testing approach)
npm run test:e2e

# Type-check the e2e harness and specs (not covered by `npm run build`)
npm run typecheck:e2e

# Platform packaging
npm run build:desktop          # native bundle for the current platform only
npm run build:linux:appimage   # Linux AppImage for host arch; Linux only
npm run build:macos:dmg        # Apple Silicon macOS DMG; macOS only

# Version bump
npm run bump-version -- <version>   # updates npm, Tauri, and Cargo version files

# Preview built frontend
npm run preview

# Type-check frontend
npx vue-tsc --noEmit

# Rust backend checks/tests
cd src-tauri && cargo check
cd src-tauri && cargo test
```

Tagged releases are driven by `.github/workflows/release-desktop.yml`: pushing a `v*` tag first runs the E2E UI tests workflow as a reusable job, and only if it passes builds Linux x86_64 and Linux ARM64 AppImages on Ubuntu, an unsigned Apple Silicon DMG on macOS, creates the GitHub Release if needed, and uploads all artifacts. Linux release asset names include the architecture, e.g. `Dez_<version>_linux_x86_64.AppImage` and `Dez_<version>_linux_arm64.AppImage`.

Every CI job removes the compromised eMudhra CA roots in its first step, before any network request. Ubuntu jobs run the shared okTurtles action `okTurtles/libcheloniajs/.github/actions/fix-ubuntu-ca-roots@main` and get `NODE_OPTIONS: --use-openssl-ca` (in the workflow `env` of `e2e.yml`; in the job `env` of the Ubuntu jobs in `release-desktop.yml`, so the macOS job does not get it). The macOS job runs its own inline fix. A new job must do the same. The header of that action's [`action.yml`](https://github.com/okTurtles/libcheloniajs/blob/main/.github/actions/fix-ubuntu-ca-roots/action.yml) gives the reasons and all the rules for callers.

Frontend unit tests use Vitest with colocated `*.test.ts` files. Observed automated tests include Rust unit tests in `src-tauri/src/commands.rs` and `src-tauri/src/key_store.rs`.

## Git conventions

Commit messages must use an 80-character maximum line width for both subject and body.

## Architecture

Dez follows an SBP MVC pattern: selectors are the cross-layer API, and code should live in the owning MVC layer. Tauri v2 provides the Rust backend; Vue 3 / TypeScript / Vite provide the frontend. State management uses Pinia setup stores as internal model implementation details.

Top-level source sketch:

- `src/model/`: domain state, persistence formats, providers, chat/stream model logic, and model selectors.
- `src/controller/`: user workflows, startup/shutdown, native/Tauri boundaries, the native menubar, HTTP runtime orchestration, updates, and diagnostics.
- `src/view/`: Vue UI, view composables, CodeMirror editor services, toast/theme/clipboard UI selectors, and reactive read adapters.
- `src/utils/`: cross-layer utilities only.
- `src-tauri/`: Rust commands, native HTTP bridge, persistence file I/O, credential storage, and app bootstrap.

SBP is covered in more detail in a section below.

### Runtime data flow

```text
User edits ThreadEditor (CodeMirror document)
  -> ThreadEditor syncs CodeMirror doc to tabStore.activeTab.sections
  -> Mod-Enter calls dez.controller/submitTab
    -> dez.stream/start creates a stream session + native HTTP request id
      -> dez.provider/streamChat builds provider-specific requests in TypeScript
      -> dez.http/stream owns a Tauri Channel and byte stream
        -> dez.native/streamHttp invokes Rust http_bridge::stream_http
          -> Rust spawns a Tokio task, streams reqwest chunks, and emits Headers/Chunk/Done/Error
      -> TypeScript decodes SSE frames and provider token deltas
    -> dez.stream/receiveToken appends tokens to the captured agent section
    -> dez.editor/appendTokenIfVisible patches the active CodeMirror view only when visible
    -> finish/error/cancel reconciles the editor, appends a trailing user section, and persists
```

### Frontend (`src/`)

- **Single editor surface**: `ThreadEditor.vue` owns one CodeMirror `EditorView`; the old contenteditable/chat-message architecture is no longer current. Avoid DOM-first fixes. The CodeMirror document is flattened text with sentinel markers, and store state is reconstructed through helpers in `src/view/thread/cmEditor.ts`.
- **Conversation model**: A tab owns `Section[]`, where each section is `{ id, role: 'user'|'agent', content: ContentNode[] }`. `ContentNode` is `TextNode` or `PromptNode`. Shared helpers are in `src/model/chat/content.ts`.
- **CodeMirror sentinels**: `cmEditor.ts` uses ASCII Record Separator `SECTION_SEP = '\u001E'` as an in-buffer section boundary. Prompt pills are encoded with private-use sentinels `PILL_OPEN`, `PILL_BODY`, `PILL_CLOSE`, and `PILL_NL`; these are live-editor implementation details and must not be written to disk or exposed in clipboard text.
- **State fields**: `sectionsField` mirrors per-section `{ id, role }`; `pillsField` stores prompt metadata (`name`, `promptId`, `expanded`) keyed by the in-doc pill id. Text lives in the CodeMirror doc, not these fields.
- **Role separators**: Role pills are CodeMirror replacement widgets over `SECTION_SEP` lines. The first section is normalized to `user`; toggling a role only applies to separators after the first section.
- **Prompt pills**: Saved prompts are managed in `PromptManager.vue` and persisted by `promptsStore`. Typing `/prompt ` in `ThreadEditor.vue` opens `PromptAutocomplete.vue`; accepting inserts a prompt sentinel sequence plus metadata. Prompt body text is copied per insertion and does not mutate the saved prompt template.
- **Find/replace**: `src/view/editor/find.ts` is the CodeMirror find engine (matching, highlights, navigation, replace). It uses only `SearchQuery` and its cursors from `@codemirror/search`, not the built-in search panel, commands, or keymap. `findState.ts` holds the dropdown state that must survive `view.setState()`, `findHistory.ts` is the in-memory search history, and `src/view/thread/FindDropdown.vue` is the UI. Workflows are the `dez.editor/openFind`, `closeFind`, `selectFindMatch`, and `replaceFindMatches` selectors; global keys are in `src/view/composables/useKeyboardShortcuts.ts`. Matches skip sentinels, separator lines, pill markers, and collapsed prompt bodies, so a replace never touches them; iterate matches only through `findMatches()`.
- **Markdown tables**: `src/view/editor/tables.ts` shows valid GFM tables in the thread editor as tables, in place. `findMarkdownTables()` is its own section-aware scanner, because the editor's markdown language has no GFM. `markdownTables()` is the CodeMirror extension that `buildState()` in `ThreadEditor.vue` adds; the table CSS is in `dezTheme` in `cmEditor.ts`. The rule: a top-level GFM table renders if and only if its source is valid, wherever the cursor is. Tables in blockquotes never render; the `findMarkdownTables()` comment says which tables in list items do. No table text is replaced: every character stays in the DOM and keeps its caret position, and CSS only makes the delimiter row and the splitting pipes transparent. So an edit that breaks the syntax shows the raw source, and a fix renders the table again. Table row lines hold only cell marks (no widgets or replace decorations), or the browser adds extra columns. `markdownTables()` also draws the editor selection (it hides the `drawSelection()` layer) and forwards clicks in the margin beside table rows.
- **Model state**: Pinia stores under `src/model/state/**` are internal model implementation details. `dez.model/*` selectors own tab mutations, active models, titles, settings, custom provider configs, prompts, stream session state, app-state serialization, and persistence watchers; view code reads reactive state through `src/view/modelState.ts`.
- **Streaming state**: `src/model/state/streams.ts` tracks per-tab sessions and errors. `src/controller/stream.ts` owns lifecycle/cancellation, `src/model/providers/**` builds provider requests and parses streamed tokens, `src/controller/http.ts` owns active native HTTP streams, and `src/view/editor/selectors.ts` owns the active CodeMirror bridge.
- **Settings › Providers**: `src/view/settings/ProviderManager.vue` is the provider page, with the same master-detail layout as `PromptManager.vue`. Built-ins show a "Built-in" badge and cannot be edited or deleted; custom providers can. The page calls the `dez.controller/providers/*` workflows in `src/controller/providers.ts`.
- **Menubar and shortcuts**: `src/controller/menu.ts` builds the native menubar in TypeScript (`dez.controller/menu/install`, called from `dez.controller/app/init`; skipped outside Tauri, so `npm run dev` has no menu). Every shortcut has a menu item, and the item and the key handler call the same selector. App keys are in `src/view/composables/useKeyboardShortcuts.ts`; editor keys stay in the CodeMirror keymaps, and menu items run them through `dez.editor/runKeyBinding`. The Settings › General shortcut list is `shortcuts` in `SettingsView.vue`. See the key order gotcha below.
- **Dev global**: In dev builds, `src/main.ts` exposes `window.__stores = { tab, settings, prompts }` for webview console testing.

### SBP

[SBP](https://github.com/okTurtles/sbp) (Selector-Based Programming) is a selector-string message-passing style: calls look like `sbp('domain/action', ...args)`, and selectors are registered under domains that act as stable APIs. In this project, selector domains and their boundary rules are documented in this section. `src/main.ts` imports the `./model`, `./controller`, and `./view` index modules once to register all selectors and exposes `window.sbp = sbp`.

Components should call `dez.controller/*` for workflows, `dez.ui/*` for UI services, and high-level data domains only when direct data reads are needed. Components and stores must not call `dez.native/*`, import Tauri APIs, call `invoke()`, or perform runtime `fetch()`. Selectors are colocated with their owning layer: `src/controller/native.ts` (`dez.native/*`) is the only frontend module that should call Tauri `invoke()` directly; `src/controller/http.ts` (`dez.http/*`) owns native HTTP streaming; `src/model/persistence/index.ts` (`dez.persistence/*`) owns raw file routing plus TypeScript persistence parsing/serialization; `src/model/providers/selectors.ts` (`dez.provider/*`) owns provider metadata/model/stream behavior; `src/controller/stream.ts` (`dez.stream/*`) owns stream lifecycle; `src/view/editor/selectors.ts` (`dez.editor/*`) owns the active CodeMirror bridge; `src/model/state/index.ts` (`dez.model/*`) exposes cloned app snapshots/store-backed model selectors; `src/controller/diagnostics/` (`dez.diagnostics/*`) is for sanitized development/support probes only.

SBP selector definitions should contain the selector behavior directly in the registered function body, e.g. `export default sbp('sbp/selectors/register', { 'domain/selector': function (...) { ... } })`. Do not write selectors that merely delegate to same-file helper functions for the selector behavior. Shared constants, module state, types, and true reusable pure helpers/core-domain helpers may live outside selectors, but avoid same-file wrapper-helper indirection, just put the function definition right there as the value of the selector.

Avoid wrapper selectors that do nothing except call another selector with identical parameters. Controller/core selectors should add meaningful boundary behavior such as workflow orchestration, normalization, error handling, state refresh, lifecycle management, cloning, or validation. Do not create alternate controller names for simple model mutations; call the model selector directly instead, e.g. use `dez.model/settings/historyOpen` rather than adding `dez.controller/openHistory`.

Selectors should represent high-level, cross-module actions that are useful to call without importing a function. Do not create selectors for simple, frequent, file-local behavior such as event handlers, scroll bookkeeping, or small helpers used only inside the registration file; make those normal functions or inline callbacks instead. A selector can still be appropriate with only one current call site when it represents a high-level user- or system-initiated workflow. Prefer one meaningful selector with options over near-duplicate selectors for scheduled/manual variants, and let internal scheduled callers use that selector when it preserves the API boundary and avoids duplicate workflow code.

### Dependencies

- Use Zod for runtime schema validation at untrusted or persisted data boundaries, especially when malformed JSON should be tolerated without breaking startup.
- Use `@sbp/okturtles.eventqueue` to serialize async operations that must not race each other.
- Use `turtledash` as a lightweight lodash-style utility package; its `debounce` helper is preferred over ad hoc `setTimeout` / `clearTimeout` debounce code.

### Providers

Every provider is one `ProviderConfig`: plain JSON with a Zod schema in `src/model/providers/config.ts`. One `Provider` class (`provider.ts`) serves every config, and `apiFormats.ts` holds the two wire formats: `openai` (chat completions) and `anthropic` (messages). Built-ins are config literals in `builtins.ts`. Custom providers are the same JSON in `app_state.json` (`customProviders`, checked with `customProviderConfigSchema`). `registry.ts` finds both kinds.

- To add a built-in, add a config literal to `builtins.ts`. It needs no type union, no Rust change, and no per-provider module.
- Put provider differences in config data (`headers`, `maxOutputTokens`, and declarative `settings` toggles such as the Venice flags), never in `if (providerId === …)` branches. Behavior that depends on auth reads `config.auth` (`'githubCopilot'` for Copilot).
- Provider ids must pass `isValidProviderId` (`^[A-Za-z0-9_-]{1,64}$`, and not an `Object.prototype` name or `__favorites__`), because they are JSON keys in `provider_keys.json`, keys of plain objects and picker groups, and the text before the first `/` in a conversation header's `model:`.
- Chat/model HTTP behavior stays TypeScript-owned behind `dez.provider/*` and `dez.http/*`, not in Rust provider adapters.

### Toasts

Toast UI lives under `src/view/toast/`. Toasts are emitted through the SBP selector `dez.ui/toast` and rendered by `ToastContainer.vue`; `AppLayout.vue` mounts the app-wide container. Toast actions that open external URLs should use `dez.controller/openUrl`. See `src/view/toast/README.md` for payload fields, examples, area behavior, and display rules.

### Backend (`src-tauri/src/`)

- **Keep Rust barebones**: The Rust layer should stay as small as possible — a thin, generic interface to the OS, not a per-feature API. Prefer generic, reusable commands/functions over adding a new bespoke command for every feature. When a new feature needs native behavior that resembles existing behavior (e.g. reading/writing another JSON file under `~/.config/dez/`), reuse or generalize the existing mechanism rather than copy-pasting another near-identical command, so adding frontend features rarely requires touching Rust. For example, single-file JSON persistence goes through generic `load_app_file(name)` / `save_app_file(name, content)` commands where TypeScript chooses the file name (with path-traversal-safe sanitization in Rust), instead of one command per file.
- **Command entry points**: Tauri commands live in `commands.rs` and `http_bridge.rs`; `lib.rs` registers them with `tauri::generate_handler!`. The only frontend direct `invoke()` call sites should be selectors in `src/controller/native.ts`.
- **Native HTTP bridge**: Provider model listing and chat streaming are TypeScript-owned. Rust exposes generic `http_request`, `stream_http`, and `cancel_http_stream` commands backed by a shared `reqwest::Client` and `HttpStreamState` map of `requestId -> JoinHandle`.
- **Streaming events**: `http_bridge.rs` emits `{ kind, data }` Tauri Channel events: `Headers`, `Chunk`, `Done`, and `Error`. TypeScript assembles bytes and parses provider-specific SSE.
- **Credentials**: `key_store.rs` reads/writes `~/.config/dez/provider_keys.json` with mode `0600` on Unix. The store is generic: one `api_key` entry per provider id (built-in or custom), plus a `copilot` entry with GitHub/Copilot token fields (chat tokens refresh via `copilot.rs`). `save_provider_secret` and `delete_provider_secret` refuse `copilot` and invalid ids. If the file cannot be read or parsed, every key command fails, so no save can overwrite the stored keys.
- **Persistence**: `persistence.rs` only performs private-file raw string I/O and id sanitization. TypeScript owns app-state, prompt, and conversation format parsing/serialization. `write_private_file` in `persistence.rs` (a `0600` temp file, then a rename) writes every private file, `provider_keys.json` too; use it for any new one.
- **Plugins and app folder**: `lib.rs` registers the `opener`, `fs`, `dialog`, and `store` plugins. Save As Markdown has no Rust command: `dez.native/showSaveDialog` (dialog plugin) adds the picked path to the fs scope at run time, and `dez.native/writeTextFile` (fs plugin) writes it, so the webview can write only files the user picked. Open Dez Folder gets the path from the generic `get_app_dir` command (creates `~/.config/dez/` if missing) and opens it with the opener plugin's `openPath`.

## Persistence layout

All app data is under `~/.config/dez/`, computed from `$HOME` in Rust rather than Tauri's path API.

- `app_state.json`: tabs, active tab id, pill visibility, theme, default model settings, last-used model, favorites, and custom provider configs (`customProviders`). Dez never writes keys into it: at startup, a hand-added `apiKey` in a `customProviders` entry moves into `provider_keys.json` and is removed from `app_state.json`. A hand-added `headers` value is kept as written, so a key that a user puts in a header stays in this file. Runtime parsing/serialization is TypeScript-owned in `src/model/persistence/appState.ts`; Rust only reads/writes raw JSON via the generic `load_app_file('app_state.json')` / `save_app_file('app_state.json', content)` commands.
- `conversations/<sanitized-id>.md`: Markdown-like conversation files with a header and Dez XML-ish structural markers. Conversation ids are sanitized to ASCII alphanumeric, `-`, and `_` before use as filenames. Runtime parsing/serialization is TypeScript-owned in `src/model/persistence/conversationFormat.ts`; Rust only reads/writes/lists/deletes raw files through the raw conversation-file commands.
- `prompts.json`: saved prompt templates (`{ id, name, content }[]`). Runtime parsing/serialization is TypeScript-owned in `src/model/persistence/prompts.ts`; Rust only reads/writes raw JSON via the generic `load_app_file('prompts.json')` / `save_app_file('prompts.json', content)` commands.
- `model_cache.json`: per-provider cached model lists plus a `working` flag and timestamps, used so the model selector opens instantly with the last-known models while a background refresh reconciles availability. Shape is `{ version, providers: { <providerId>: { models, working, updatedAt, lastCheckedAt } } }`. Runtime parsing/serialization is TypeScript-owned in `src/model/persistence/modelCache.ts` (Zod-tolerant); Rust only reads/writes raw JSON via the generic `load_app_file('model_cache.json')` / `save_app_file('model_cache.json', content)` commands. Stores only model ids/names/provider — never secrets.
- `provider_keys.json`: one object, `{ "<providerId>": { "api_key": "…" }, …, "copilot": { <GitHub/Copilot tokens> } }`, for built-in and custom providers alike. Files are written with mode `0600` on Unix.

Do not ever read, view, print, or `cat` `~/.config/dez/provider_keys.json`; it can contain API keys and OAuth tokens.

### Conversation file format

- Header: `<!-- title: X | model: provider/model | created: N -->`.
- Section markers: `<dez:pill type="user"/>` and `<dez:pill type="agent"/>` on their own lines.
- Prompt markers: `<dez:prompt name="NAME"> ... </dez:prompt>` wraps a prompt insertion body.
- Literal `</dez:prompt>` inside a prompt body is escaped as `<\/dez:prompt>` on save.
- Prompt `expanded` is not persisted as UI state on load; frontend rehydrates loaded prompts collapsed.
- Clipboard serialization in `cmEditor.ts` uses the same `dez:` marker namespace and strips live CodeMirror sentinels.

The frontend never touches these files directly; use `dez.persistence/*` selectors from app code. `src/controller/native.ts` is the only frontend layer that should invoke raw Tauri file commands.

## Gotchas

- **AGENTS may outlive implementation details**: This code recently moved from contenteditable DOM reconstruction to CodeMirror. If an older note mentions `buildDOM()` or `readDOMToStore()`, verify against `ThreadEditor.vue`/`cmEditor.ts` before following it.
- **Do not leak sentinels**: `SECTION_SEP` and prompt private-use codepoints are only for the live CodeMirror doc. `stripLiveSentinels`, clipboard serializers, and persistence conversion exist to keep them out of user-visible text and disk files.
- **First section role invariant**: `cmEditor.ts` normalizes the first section to `user`. Role separator widgets represent the section after the separator, so index math around separators is easy to get off by one.
- **Prompt newlines in collapsed pills**: Collapsed prompt bodies escape `\n` as `PILL_NL` because CodeMirror inline replacement decorations do not correctly collapse multi-line ranges. Expanded pills restore real newlines for editable body text.
- **Settings persistence is model-owned**: `dez.model/settings/startPersistence` installs debounced app-state persistence and theme watchers after `dez.controller/app/init` loads initial state. Calling model settings mutations before startup completes can race initial persistence readiness.
- **Prompt persistence is separate**: Saved prompt templates persist through `dez.model/prompts/startPersistence` to `prompts.json`; prompt insertions inside conversations persist as conversation content nodes/markers and are independent copies.
- **Active-tab streaming patch**: Streaming always mutates the agent section captured at stream start. Only the currently active tab's registered CodeMirror view is patched through `dez.editor/appendTokenIfVisible`; tab/store guards prevent tokens from applying to the wrong visible editor.
- **Concurrent streaming path**: Chat streaming no longer goes through a Rust provider registry. `src/controller/stream.ts` tracks request ids per tab, and `http_bridge.rs` tracks request ids globally for native cancellation.
- **Provider role mapping**: The app uses internal role `agent`. Both API formats (`openai` and `anthropic`) must map `agent` to API role `assistant` when building requests.
- **Copilot auth path differs**: Copilot does not use the API-key commands; `save_provider_secret` refuses `copilot`. Use `copilot_start_device_flow` and `copilot_poll_device_flow`; tokens are then persisted via `key_store`.
- **Tauri capabilities**: `src-tauri/capabilities/default.json` grants `core:default`, `core:app:allow-app-hide` (macOS "Hide Dez"), `core:window:allow-close` (Linux File › Quit), `opener:default`, `opener:allow-open-path` scoped to `$HOME/.config/dez` (Open Dez Folder), `store:default`, `dialog:allow-save`, and `fs:allow-write-text-file` (no static fs scope). Add permissions there when adding Tauri plugins or calling another plugin/core command.
- **Shortcut key order differs by platform**: On Linux, a GTK menu accelerator takes the key before the webview, so the page key handler never sees it. On macOS, the page sees keys first and the menu gets only keys the page did not handle (not yet tested on a Mac). So context checks (a modal is open, find is closed, editor focus) belong in the selector that both paths call, never only in a key handler. `dez.editor/runKeyBinding` does nothing while a modal is open and the editor has no focus.
- **CSP disabled**: `src-tauri/tauri.conf.json` sets `"csp": null` intentionally during development.
- **Vite port is fixed**: Tauri dev expects Vite on port `1420` with `strictPort: true`; if the port is occupied, dev startup fails instead of choosing another port.
- **App state plugin unused for core state**: `@tauri-apps/plugin-store` is installed and permissioned, but app state, prompts, conversations, and provider keys are persisted by custom Rust file I/O.
- **Secrets wrapper is not a vault**: `src/utils/secret.ts` redacts `toString()`/`toJSON()`, but code can still call `.reveal()`. Do not log provider request headers, native HTTP payloads, or diagnostic data without explicit sanitization.
- When using the `agentic_fetch` tool:
  - If searching the web, *ALWAYS* tell the tool to never use local tools like Grep, and only search the web
  - If searching local folders, *ALWAYS* tell the tool to restrict its searches to this folder only and to never search outside of it

## Code conventions

- Vue SFCs use `<script setup lang="ts">`.
- Pinia stores use setup-function style, not options-style stores.
- TypeScript is strict and has `noUnusedLocals` / `noUnusedParameters`; unused imports or parameters break `npm run build`.
- Frontend imports commonly omit semicolons and use single quotes in `src/`; config files use double quotes where already present. Match the surrounding file.
- IDs in the frontend are generated with `crypto.randomUUID()`.
- Rust uses `thiserror` for error types.
- Rust/TypeScript JSON naming crosses a boundary manually. Many Rust fields use individual `#[serde(rename = "camelCase")]` attributes rather than a global `rename_all`; check each struct before changing payloads.
- Styling uses component-scoped CSS or CodeMirror theme rules in `cmEditor.ts`; global theme variables live in `App.vue`. No CSS framework is configured.
- Theme is controlled with `data-theme` on `<html>` plus `prefers-color-scheme` fallback.

## Comments

ALWAYS add comments above any code that could be considered confusing, unclear, hackish, or non-idiomatic explaining why the code exists, what scenarios it covers, and what it does.

Brief comments are encouraged above functions that do anything non-trivial explaining the "why and what" of the function.

## Misc. Directives

- When a file needs to move to a new location with only small changes, use the `cp` command to copy it and then the Edit tool instead of reconstructing it manually.
- Import the live SBP function only from the package: `import sbp from '@sbp/sbp'`. Do not import `sbp` via relative paths like `./sbp` or `../sbp`; relative imports are only for selector registration side effects or local SBP types/modules.
- When using the 'tasks' skill, if while working you discover that the steps in a `STEP-*` file are wrong, incomplete, or not the best approach, rewrite that step file to follow the better approach before continuing.
- Any errors should be logged with `console.error` (in addition to being thrown when throwing is still needed).

## Testing approach

- Run `npm run build` at the end of a task step if frontend changes were made, not after every edit; it performs TypeScript/Vue type-checking before Vite build.
- Run `npm test` after frontend logic changes, especially persistence or editor helper changes covered by colocated `*.test.ts` files.
- Run `cd src-tauri && cargo check` after significant Rust changes for feedback.
- Run `cd src-tauri && cargo test` when touching Rust logic with tests, including the release/update helpers in `src-tauri/src/commands.rs`.
- Run `npm run test:e2e` after UI behavior changes covered by the WebDriver e2e specs under `tests/e2e/` (Linux only; requires the debug binary, `tauri-driver`, and `WebKitWebDriver`).
- Run `npm run typecheck:e2e` after changing the e2e harness or specs; `npm run build` does not type-check files under `tests/e2e/`.
- WebDriver keys (`browser.keys`) skip GTK, so e2e specs test the page key handlers, never the Linux menu accelerators or menu clicks. To check those by hand: run rootful Xwayland on kwin (`WAYLAND_DISPLAY=wayland-dez Xwayland :5 -geometry 1280x800 -ac`), start the app with `env -u WAYLAND_DISPLAY DISPLAY=:5 GDK_BACKEND=x11`, send real keys with XTest (`libXtst`), and click items through AT-SPI inside `dbus-run-session` (start `/usr/libexec/at-spi-bus-launcher --launch-immediately` and `/usr/libexec/at-spi2-registryd` first).
- Use type-check/build and targeted manual verification via `npm run tauri dev` when UI behavior changes beyond unit-testable helper logic.

### GUI tests without a display (sandboxes)

An agent sandbox can have `DISPLAY` and `WAYLAND_DISPLAY` set while no display server runs: `$XDG_RUNTIME_DIR` has no `wayland-*` socket and `/tmp/.X11-unix` does not exist. Then the app window cannot open, and every e2e spec fails only with `Hook timed out in 120000ms` in `beforeAll`, with no display error. CI uses `xvfb-run`, but `Xvfb` may not be installed, and an install needs sudo. Use KDE's headless compositor instead; it needs no sudo:

```bash
# 1. Start it as a long-lived background process (e.g. a named service).
#    It prints nothing when ready, so do not wait for a log line.
kwin_wayland --virtual --socket wayland-dez --width 1280 --height 800 \
  --no-lockscreen --no-global-shortcuts

# 2. It is ready when its socket exists (about 1 s after start).
test -S "$XDG_RUNTIME_DIR/wayland-dez"

# 3. Run the app or tests against it. WAYLAND_DISPLAY is the setting that
#    matters; the other two force GTK to use Wayland.
env -u DISPLAY GDK_BACKEND=wayland WAYLAND_DISPLAY=wayland-dez npm run test:e2e
```

- Stop the compositor when you are done.
- Do not use `broadwayd` (GTK's browser backend). Window sizes come out negative, CodeMirror throws in its height map, and CSS transitions crash `WebKitWebProcess`.
- To look at the UI, write a throwaway spec that calls `browser.saveScreenshot('/tmp/<name>.png')`, open the PNG, then delete the spec and the PNG. Under kwin the screenshots are real renders at 2x device pixels.
- `npm run test:e2e` uses the existing `src-tauri/target/debug/dez` as is. After source changes, rebuild it with `npm run tauri build -- --debug --no-bundle`, or the suite tests stale code. A plain `cargo build` binary does not work for e2e.
