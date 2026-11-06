# AGENTS.md

This file is a high-level project overview (table of contents) and project Gotchas. Keep additions at that level: name the module, file, or rule in a short line. Never nitty-gritty details, those belong in code docstrings, comments, tests, etc.

If `CLAUDE.md` exists in this repository, it is a symlink to this file; edit only `AGENTS.md`, never `CLAUDE.md` directly.

## Commands

```bash
npm ci                         # install dependencies before building or packaging
npm run dev                    # frontend only, no Tauri shell
npm run tauri dev              # full desktop app
npm run build                  # frontend only: vue-tsc --noEmit && vite build
npm run tauri build            # production Tauri bundle
npm test                       # unit tests (Vitest)
npm run test:watch             # unit tests in watch mode
npm run test:e2e               # WebDriver UI tests on the real app; Linux only (see vitest.e2e.config.ts)
npm run typecheck:e2e          # type-check tests/e2e (`npm run build` does not)
npm run build:desktop          # native bundle for the current platform
npm run build:linux:appimage   # Linux AppImage for the host arch; Linux only
npm run build:macos:dmg        # Apple Silicon macOS DMG; macOS only
npm run build:macos:app        # Apple Silicon macOS .app; macOS only
npm run bump-version -- <version>                    # npm, Tauri, and Cargo version files
node scripts/release-notes.js <tag> [--out <file>]   # release notes body for a tag
npm run preview                # preview the built frontend
cd src-tauri && cargo check
cd src-tauri && cargo test
```

- Tauri build scripts first run `npm run clean:rust` (`scripts/clean-rust.js`).
- macOS builds need Xcode 26+: `build:macos:*` first run `scripts/build-macos-icon.js`, which compiles `src-tauri/icons/Dez.icon` into the gitignored `src-tauri/icons/Assets.car` (icon name set in `src-tauri/Info.plist`). A bare `tauri build` on macOS fails without that file.
- Releases: a pushed `v*` tag runs `.github/workflows/release-desktop.yml` (e2e gate, Linux AppImages, macOS DMG, release notes from `scripts/release-notes.js`, GitHub Release). The rules are in the comments of those files.
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

### Runtime data flow

```text
ThreadEditor (CodeMirror doc) syncs to the active tab's sections
  -> Mod-Enter (key, Submit button, Conversation › Send) -> dez.controller/submitTab
    -> dez.model builds the request messages and stamps the trailing agent section
    -> dez.stream/start -> dez.provider/streamChat -> dez.http/stream
      -> dez.native/streamHttp -> Rust http_bridge::stream_http (Headers/Chunk/Done/Error)
    -> openaiSse.ts / anthropicSse.ts split answer tokens from thinking tokens
    -> tokens go to the store, and to the editor if the tab is visible (dez.editor/*)
    -> finish/error/cancel reconciles the editor, adds a user section, and saves
```

### Frontend map (`src/`)

- `main.ts`: registers all selectors; dev builds expose `window.__stores`.
- `view/thread/ThreadEditor.vue`: the one CodeMirror `EditorView` (no contenteditable).
- `view/thread/cmEditor.ts`: doc ⇄ sections, sentinels, state fields, role pill widgets, clipboard format, `dezTheme`.
- `view/thread/modelChip.ts`, `thinkingPill.ts`: the model part and the thinking slot and panel of an agent pill.
- `view/thread/editorMeasure.ts`: forced CodeMirror re-measures.
- `view/editor/selectors.ts`: `dez.editor/*`, the active-editor bridge (stream patching, scroll follow, Copy Markdown, `runKeyBinding`).
- `view/editor/find.ts`, `findState.ts`, `findHistory.ts`, `view/thread/FindDropdown.vue`: find and replace.
- `view/editor/tables.ts`: GFM tables shown as tables, in place.
- `model/chat/`: `Section` / `ContentNode` types and helpers (`content.ts`, `modelRef.ts`, `thinking.ts`, `markdown.ts`, `pillMarker.ts`).
- `model/state/`: Pinia stores (internal) and `dez.model/*` selectors; views read state through `view/modelState.ts`.
- `controller/stream.ts`, `model/state/streams.ts`, `controller/http.ts`: stream lifecycle, per-tab sessions, native HTTP streams.
- `model/shortcuts.ts`: the editable shortcut registry (ids, default keys, key event matching, validation, labels, menu accelerators); user overrides are in the settings store.
- `controller/menu.ts`: the native menubar (Tauri only); `dez.controller/menu/suspendAccelerators` turns its keys off while a key is recorded. `view/composables/useKeyboardShortcuts.ts`: app keys.
- `controller/window.ts`, `windowFit.ts`: restore and save the window size and position.
- `view/app/AppLayout.vue`: layout and bottom bar (`ModelSelector.vue`, `view/thread/SubmitButton.vue`).
- `view/history/HistoryPanel.vue`: saved conversations.
- `view/prompts/PromptManager.vue`, `view/thread/PromptAutocomplete.vue`: saved prompts and `/prompt ` insertion.
- `view/settings/SettingsView.vue`, `ProviderManager.vue`, `ShortcutManager.vue`: settings, the providers page, and Settings › Shortcuts with its key recorder (Help › Keyboard Shortcuts opens it).
- `view/tabs/TabBar.vue`: tabs, colored busy/done by `dez.model/tabs/activity`. `dez.model/tabs/reopenClosed` brings back a closed tab from a session-only list (`model/state/tabs.ts`).
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
- `dez.ui/*`: `src/view/toast/selectors.ts`, `src/view/theme.ts`, `src/view/clipboard.ts`

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

### Toasts

`src/view/toast/`: emit with `dez.ui/toast`; `ToastContainer.vue` (mounted in `AppLayout.vue`) renders them. Payloads and rules: `src/view/toast/README.md`. Chat request errors are sticky error toasts; the thread shows no error text.

### Backend (`src-tauri/src/`)

- **Keep Rust barebones**: a thin, generic OS interface, not a per-feature API. Reuse or generalize an existing command (e.g. `load_app_file(name)` / `save_app_file(name, content)`) instead of adding a near-copy, so frontend features rarely need Rust changes.
- `commands.rs`, `http_bridge.rs`: Tauri commands, registered in `lib.rs`. `open_devtools` (Help › Developer Console) needs the `devtools` feature of the `tauri` crate in release builds (`Cargo.toml`).
- `http_bridge.rs`: generic `http_request`, `stream_http`, `cancel_http_stream`.
- `persistence.rs`: raw private-file I/O and id sanitization; write every private file with `write_private_file`.
- `key_store.rs`: `provider_keys.json`. `copilot.rs`: Copilot device flow and token refresh.
- `lib.rs`: plugins, permission reasons, app bootstrap.

## Persistence layout

All app data is under `~/.config/dez/`. TypeScript owns every format; Rust only moves raw strings. App code uses `dez.persistence/*` only.

- `app_state.json`: tabs, settings (with shortcut overrides), window geometry, provider toggles, custom providers (`src/model/persistence/appState.ts`).
- `conversations/<sanitized-id>.md`: conversations (format: `src/model/persistence/conversationFormat.ts`; pill markers: `src/model/chat/pillMarker.ts`).
- `prompts.json`: saved prompt templates (`src/model/persistence/prompts.ts`).
- `model_cache.json`: last-known model lists, no secrets (`src/model/persistence/modelCache.ts`).
- `provider_keys.json`: API keys and Copilot tokens (`src-tauri/src/key_store.rs`).

Do not ever read, view, print, or `cat` `~/.config/dez/provider_keys.json`; it can contain API keys and OAuth tokens.

## Gotchas

- **Do not leak sentinels**: the section and prompt pill sentinels (`cmEditor.ts`) live only in the editor doc, never on disk or in the clipboard.
- **First section is always `user`**: a role pill belongs to the section after it, so separator index math is easy to get off by one (`cmEditor.ts`).
- **`model` and `thinking` are agent-only**: show, save, or send them only when `role === 'agent'`; copy them only when set (`modelRefField`, `thinkingField`).
- **Per-section fields flow through the editor**: the editor writes sections back to the store on every doc change; a new field must follow `SectionModel` in `cmEditor.ts`.
- **Thinking has two copies during a stream** (store and visible editor); see `dez.editor/setSectionThinkingIfVisible`.
- **Agent pill DOM changes in place**: see `RoleSeparatorWidget.eq` and `pillThinkingUpdater` in `cmEditor.ts`.
- **Streams patch only the visible editor**: the store gets every token; the editor only when its tab is active (`dez.editor/appendTokenIfVisible`).
- **Stream scroll follow**: never add code that scrolls an editor view up (`src/view/editor/selectors.ts`).
- **Persistence starts after init**: settings changes made before `dez.model/settings/startPersistence` can be lost.
- **Provider role mapping**: internal role `agent` maps to API role `assistant` in both formats.
- **Copilot auth differs**: device flow commands, not the API-key commands.
- **Tauri capabilities**: a new plugin or core command needs a permission in `src-tauri/capabilities/default.json`; app commands registered in `lib.rs` need none.
- **The window starts hidden**: `dez.controller/window/restore` shows it, so a frontend failure before init shows no window; read the Vite output. On macOS, `lib.rs` shows it at launch so that it comes to the front.
- **Saved window position units differ by platform**: logical points on macOS, physical px elsewhere (`src/controller/window.ts`).
- **Shortcut key order differs by platform**: on Linux the menu accelerator gets the key first; put context checks in the selector both paths call, never only in a key handler.
- **Never hard-code a shortcut key**: every binding path (window handler, CodeMirror keymap, find field, menu accelerators, button titles and keycaps) reads the effective keys from `src/model/shortcuts.ts` and the settings store.
- **CSP disabled**: `"csp": null` in `tauri.conf.json` on purpose during development.
- **Vite port is fixed**: `1420` with `strictPort: true`.
- **`@tauri-apps/plugin-store` is unused**: app files use Dez's own Rust file I/O.
- **Secrets wrapper is not a vault**: `src/utils/secret.ts`; never log provider headers, native HTTP payloads, or diagnostics without sanitization.
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
- Never modify the features list in the project README without explicit user request.

## Testing approach

- Unit tests: Vitest with colocated `*.test.ts` files; `npm test` also runs `scripts/*.test.js`. Rust unit tests are in the `src-tauri/src/*.rs` files.
- Run `npm run build` at the end of a task step with frontend changes (it type-checks), not after every edit.
- Run `npm test` after frontend logic changes.
- Run `cd src-tauri && cargo check` after significant Rust changes, and `cargo test` when touching Rust logic with tests.
- Run `npm run test:e2e` after UI behavior changes covered by `tests/e2e/`. It runs the existing debug binary: rebuild first (`tests/e2e/harness/app.ts`).
- Run `npm run typecheck:e2e` after changing the e2e harness or specs.
- E2E keys skip GTK, so specs never test Linux menu accelerators; the manual recipe is in `vitest.e2e.config.ts`.
- E2E specs that restart the app use `MockProviderApp.relaunch()` (`tests/e2e/harness/mockProviderApp.ts`).
- E2E clicks: never use webdriverio's `.click()`; use `click()` or `pointerClick()` from `tests/e2e/harness/dom.ts`.
- **No display server** (every spec fails with `Hook timed out in 120000ms` in `beforeAll`): run under headless `kwin_wayland`; the recipe is in `vitest.e2e.config.ts`.
- For UI changes beyond unit-testable logic, also check by hand with `npm run tauri dev`.
