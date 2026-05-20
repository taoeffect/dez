# AGENTS.md

## Commands

```bash
# Install dependencies before building or packaging
npm ci

# Development (frontend only, no Tauri shell)
npm run dev

# Development (full desktop app)
npm run tauri dev

# Build
npm run build              # frontend only: vue-tsc --noEmit && vite build
npm run tauri build        # production Tauri bundle

# Deterministic persistence fixture checks
npm run check:persistence

# Platform packaging
npm run build:desktop          # native bundle for the current platform only
npm run build:linux:appimage   # Linux AppImage; Linux only
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

Tagged releases are driven by `.github/workflows/release-desktop.yml`: pushing a `v*` tag builds a Linux AppImage on Ubuntu, an unsigned Apple Silicon DMG on macOS, creates the GitHub Release if needed, and uploads both artifacts.

No frontend test framework, ESLint, or formatter is configured. Observed automated tests include Rust unit tests in `src-tauri/src/commands.rs`; persistence behavior also has deterministic fixture checks through `npm run check:persistence`.

## Git conventions

Commit messages must use an 80-character maximum line width for both subject and body.

## Project-level plan

The top-level `PLAN.md` tracks project work. If asked to "continue the plan", read `PLAN.md`, load the `tasks` skill, verify the current task state from task files (the plan can be stale), then continue the unfinished task or create the next task. When a project-level step is completed, update `PLAN.md`.

## Architecture

Dez follows an SBP MVC pattern: selectors are the cross-layer API, and code should live in the owning MVC layer. Tauri v2 provides the Rust backend; Vue 3 / TypeScript / Vite provide the frontend. State management uses Pinia setup stores as internal model implementation details.

Top-level source sketch:

- `src/model/`: domain state, persistence formats, providers, chat/stream model logic, and model selectors.
- `src/controller/`: user workflows, startup/shutdown, native/Tauri boundaries, HTTP runtime orchestration, updates, and diagnostics.
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
- **Model state**: Pinia stores under `src/model/state/**` are internal model implementation details. `dez.model/*` selectors own tab mutations, active models, titles, settings, prompts, stream session state, app-state serialization, and persistence watchers; view code reads reactive state through `src/view/modelState.ts`.
- **Streaming state**: `src/model/state/streams.ts` tracks per-tab sessions and errors. `src/controller/stream.ts` owns lifecycle/cancellation, `src/model/providers/**` builds provider requests and parses streamed tokens, `src/controller/http.ts` owns active native HTTP streams, and `src/view/editor/selectors.ts` owns the active CodeMirror bridge.
- **Dev global**: In dev builds, `src/main.ts` exposes `window.__stores = { tab, settings, prompts }` for webview console testing.

### SBP

[SBP](https://github.com/okTurtles/sbp) (Selector-Based Programming) is a selector-string message-passing style: calls look like `sbp('domain/action', ...args)`, and selectors are registered under domains that act as stable APIs. In this project, `src/sbp/README.md` documents selector domains and boundary rules. `src/main.ts` imports `src/sbp` once to register selector modules and exposes `window.sbp = sbp`.

Components should call `dez.controller/*` for workflows, `dez.ui/*` for UI services, and high-level data domains only when direct data reads are needed. Components and stores must not call `dez.native/*`, import Tauri APIs, call `invoke()`, or perform runtime `fetch()`. `src/sbp/native.ts` is the only frontend layer that should call Tauri `invoke()` directly; `src/sbp/http.ts` owns native HTTP streaming; `src/sbp/persistence.ts` owns raw file routing plus TypeScript persistence parsing/serialization; `src/sbp/provider.ts` owns provider metadata/model/stream behavior; `src/sbp/stream.ts` owns stream lifecycle; `src/sbp/editor.ts` owns the active CodeMirror bridge; `src/sbp/model.ts` exposes cloned app snapshots/store-backed model selectors; `src/sbp/diagnostics.ts` is for sanitized development/support probes only.

SBP selector definitions should contain the selector behavior directly in the registered function body, e.g. `export default sbp('sbp/selectors/register', { 'domain/selector': function (...) { ... } })`. Do not write selectors that merely delegate to same-file helper functions for the selector behavior. Shared constants, module state, types, and true reusable pure helpers/core-domain helpers may live outside selectors, but avoid same-file wrapper-helper indirection, just put the function definition right there as the value of the selector.

Avoid wrapper selectors that do nothing except call another selector with identical parameters. Controller/core selectors should add meaningful boundary behavior such as workflow orchestration, normalization, error handling, state refresh, lifecycle management, cloning, or validation. Do not create alternate controller names for simple model mutations; call the model selector directly instead, e.g. use `dez.model/settings/historyOpen` rather than adding `dez.controller/openHistory`.

Selectors should represent high-level, cross-module actions that are useful to call without importing a function. Do not create selectors for simple, frequent, file-local behavior such as event handlers, scroll bookkeeping, or small helpers used only inside the registration file; make those normal functions or inline callbacks instead. A selector can still be appropriate with only one current call site when it represents a high-level user- or system-initiated workflow. Prefer one meaningful selector with options over near-duplicate selectors for scheduled/manual variants, and let internal scheduled callers use that selector when it preserves the API boundary and avoids duplicate workflow code.

### Dependencies

- Use Zod for runtime schema validation at untrusted or persisted data boundaries, especially when malformed JSON should be tolerated without breaking startup.
- Use `@sbp/okturtles.eventqueue` to serialize async operations that must not race each other.
- Use `turtledash` as a lightweight lodash-style utility package; its `debounce` helper is preferred over ad hoc `setTimeout` / `clearTimeout` debounce code.

### Providers

Provider definitions live in `src/model/providers/**`; adding a provider requires registering a `ProviderSpec`, extending the `ProviderId` union in `src/model/providers/types.ts`, adding credential handling in `src-tauri/src/key_store.rs`, and wiring any settings UI expectations. Chat/model HTTP behavior should stay TypeScript-owned behind `dez.provider/*` and `dez.http/*`, not in Rust provider adapters.

### Toasts

Toast UI lives under `src/view/toast/`. Toasts are emitted through the SBP selector `dez.ui/toast` and rendered by `ToastContainer.vue`; `AppLayout.vue` mounts the app-wide container. Toast actions that open external URLs should use `dez.controller/openUrl`. See `src/view/toast/README.md` for payload fields, examples, area behavior, and display rules.

### Backend (`src-tauri/src/`)

- **Command entry points**: Tauri commands live in `commands.rs` and `http_bridge.rs`; `lib.rs` registers them with `tauri::generate_handler!`. The only frontend direct `invoke()` call sites should be selectors in `src/sbp/native.ts`.
- **Native HTTP bridge**: Provider model listing and chat streaming are TypeScript-owned. Rust exposes generic `http_request`, `stream_http`, and `cancel_http_stream` commands backed by a shared `reqwest::Client` and `HttpStreamState` map of `requestId -> JoinHandle`.
- **Streaming events**: `http_bridge.rs` emits `{ kind, data }` Tauri Channel events: `Headers`, `Chunk`, `Done`, and `Error`. TypeScript assembles bytes and parses provider-specific SSE.
- **Credentials**: `key_store.rs` reads/writes `~/.config/dez/provider_keys.json` with mode `0600` on Unix. Normal providers store `api_key`; Copilot stores GitHub/Copilot token fields and refreshes chat tokens via `copilot.rs`.
- **Persistence**: `persistence.rs` only performs private-file raw string I/O and id sanitization. TypeScript owns app-state, prompt, and conversation format parsing/serialization.

## Persistence layout

All app data is under `~/.config/dez/`, computed from `$HOME` in Rust rather than Tauri's path API.

- `app_state.json`: tabs, active tab id, pill visibility, theme, default model settings, last-used model, and favorites. Runtime parsing/serialization is TypeScript-owned in `src/core/persistence/appState.ts`; Rust only reads/writes raw JSON via `load_app_state_json` / `save_app_state_json`.
- `conversations/<sanitized-id>.md`: Markdown-like conversation files with a header and Dez XML-ish structural markers. Conversation ids are sanitized to ASCII alphanumeric, `-`, and `_` before use as filenames. Runtime parsing/serialization is TypeScript-owned in `src/core/persistence/conversationFormat.ts`; Rust only reads/writes/lists/deletes raw files through the raw conversation-file commands.
- `prompts.json`: saved prompt templates (`{ id, name, content }[]`). Runtime parsing/serialization is TypeScript-owned in `src/core/persistence/prompts.ts`; Rust only reads/writes raw JSON via `load_prompts_json` / `save_prompts_json`.
- `provider_keys.json`: provider API keys plus Copilot GitHub/Copilot tokens. Files are written with mode `0600` on Unix.

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
- **Concurrent streaming path**: Chat streaming no longer goes through a Rust provider registry. `src/sbp/stream.ts` tracks request ids per tab, and `http_bridge.rs` tracks request ids globally for native cancellation.
- **Provider role mapping**: The app uses internal role `agent`. OpenAI-compatible provider adapters must map `agent` to API role `assistant` when building requests.
- **Copilot auth path differs**: Copilot does not use normal `set_api_key`/`configure` flow. Use `copilot_start_device_flow` and `copilot_poll_device_flow`; tokens are then persisted via `key_store`.
- **Tauri capabilities**: `src-tauri/capabilities/default.json` currently grants `core:default`, `opener:default`, and `store:default`. Add permissions there when adding Tauri plugins.
- **CSP disabled**: `src-tauri/tauri.conf.json` sets `"csp": null` intentionally during development.
- **Vite port is fixed**: Tauri dev expects Vite on port `1420` with `strictPort: true`; if the port is occupied, dev startup fails instead of choosing another port.
- **App state plugin unused for core state**: `@tauri-apps/plugin-store` is installed and permissioned, but app state, prompts, conversations, and provider keys are persisted by custom Rust file I/O.
- **Secrets wrapper is not a vault**: `src/core/secret.ts` redacts `toString()`/`toJSON()`, but code can still call `.reveal()`. Do not log provider request headers, native HTTP payloads, or diagnostic data without explicit sanitization.
- When using the `agentic_fetch` tool:
  - If searching the web, *ALWAYS* tell the tool to never use local tools like Grep, and only search the web
  - If searching local folders, *ALWAYS* tell the tool to restrict its searches to this folder only and to never search outside of it

## Code conventions

- Vue SFCs use `<script setup lang="ts">`.
- Pinia stores use setup-function style, not options-style stores.
- TypeScript is strict and has `noUnusedLocals` / `noUnusedParameters`; unused imports or parameters break `npm run build`.
- Frontend imports commonly omit semicolons and use single quotes in `src/`; config files use double quotes where already present. Match the surrounding file.
- IDs in the frontend are generated with `crypto.randomUUID()`.
- Rust uses `thiserror` for error types and `async-trait` for async provider trait implementations.
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
- Run `npm run check:persistence` after changes to `src/core/persistence/**`, persistence selectors, raw persistence IPC, or app/history/prompt persistence routing.
- Run `cd src-tauri && cargo check` after significant Rust changes for feedback.
- Run `cd src-tauri && cargo test` when touching Rust logic with tests, including the release/update helpers in `src-tauri/src/commands.rs`.
- There are no observed frontend unit tests; use type-check/build and targeted manual verification via `npm run tauri dev` when UI behavior changes.
