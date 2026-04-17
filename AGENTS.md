# AGENTS.md

## Commands

```bash
# Development (frontend only, no Tauri)
npm run dev

# Development (full app with Tauri backend)
npm run tauri dev

# Build
npm run tauri build        # production binary
npm run build              # frontend only (vue-tsc --noEmit && vite build)

# Type-check frontend
npx vue-tsc --noEmit

# Check Rust backend
cd src-tauri && cargo check
```

No test framework is configured. No linter or formatter is set up.

## Pre-release: no backwards compatibility

Dez is pre-release software with no users yet. **Do not add backwards-compatibility shims, legacy format parsers, or migration code for on-disk formats (conversation files, app state, prompt store, provider keys).** When a format changes, remove the old code paths outright. Breaking changes are acceptable; users can delete `~/.config/dez/` to reset.

## Project-level plan

The project contains a top-level PLAN.md file that is being implemented via the 'tasks' skill.

If the user asks you to "continue the plan" or something to that effect, read the top-level PLAN.md file, load the 'tasks' skill, and verify what step we're currently on (the PLAN.md file might be out of date, so check for existence of task files first) and then either continue the current task (if it's not finished), or create a new task for the current part of the plan we're on.

When a project-level step is completed, remember to update the top-level PLAN.md to mark it as completed.

## Architecture

Tauri v2 desktop app: Rust backend + Vue 3 / TypeScript / Vite frontend. State management via Pinia.

### Data Flow

```
User types in ThreadEditor (contenteditable div)
  → threadStore updates sections[]
  → Cmd/Ctrl+Enter triggers useStreaming.startStreaming()
    → invoke('send_message', { tabId, messages, providerId, modelId, onEvent: Channel })
      → Rust: commands::send_message spawns tokio task
        → ProviderRegistry finds provider by id
        → provider.stream_chat() sends HTTP request, parses SSE
        → tokens sent via mpsc → forwarded to Tauri Channel
    → Frontend Channel.onmessage appends tokens to the trailing agent section
    → ThreadEditor rebuilds DOM from store state during streaming
```

### Frontend (`src/`)

- **Single contenteditable surface** — `ThreadEditor.vue` is NOT a traditional chat UI. It's one `contenteditable="true"` div that imperatively manages its own DOM via `buildDOM()`. The store is the source of truth; DOM is rebuilt from store state (not the other way around for structure). Text edits sync back to the store via `readDOMToStore()` on input events.
- **Sections model** — A conversation is `Section[]` where each section has `{ id, role: 'user'|'agent', content }`. Pill separators between sections are non-editable DOM elements rendered inline. Shift+Enter splits into a new section.
- **Stores**: `tabStore` owns all tab state (including sections and activeModel per tab) and talks to Rust via `save_app_state`/`load_app_state`/`save_conversation`/`load_conversation`. `threadStore` is a computed proxy over the active tab's data. `settingsStore` holds UI/settings state and delegates persistence to `tabStore.saveAppState()` via a debounced `persistCallback` wired in `App.vue`.
- **Composables**: `useStreaming` manages the streaming lifecycle. `useKeyboardShortcuts` handles global shortcuts. `useMessageParser` and `useCodeHighlighter` handle rendering concerns.
- **Streaming state** (`isStreaming`, `streamingTabId`, `streamingError`) uses module-level refs in `useStreaming.ts` — these are shared singletons across all component instances, not per-composable-call state. The `streamingTabId` guard in `channel.onmessage` ensures tokens for a tab the user has switched away from still update the correct store, but UI indicators only show for the active tab.

### Backend (`src-tauri/src/`)

- **Provider trait** — `LlmProvider` in `providers/mod.rs` defines `stream_chat(messages, model, tx)` returning tokens via an unbounded mpsc channel. All four providers (OpenRouter, Z.ai, Copilot, MiniMax) implement this trait via `#[async_trait]` and are all wired up with working `stream_chat` + `list_models` implementations.
- **SSE parsing** — `stream_openai_sse()` in `providers/mod.rs` is a shared helper for OpenAI-compatible SSE streams. All four providers currently reuse it (their APIs are OpenAI-compatible on the streaming side).
- **Provider downcasting** — `LlmProvider` exposes `as_any`/`as_any_mut` so `commands.rs` can downcast to `CopilotProvider` for the device-flow commands. `ProviderRegistry::extract_credentials` uses the same pattern to pull Copilot's multi-field credentials out for key_store.
- **Generation cancellation** — Each tab's active generation is tracked by `JoinHandle` in `GenerationState` (keyed by `tab_id`). `cancel_generation` aborts the tokio task. `send_message` auto-cancels any prior generation for the same tab before starting a new one.
- **ProviderRegistry** — Constructed once at startup in `lib.rs`, wrapped in `Arc<Mutex<>>`, and passed as Tauri managed state. `send_message` holds the registry lock for the entire duration of `stream_chat` (potential bottleneck for concurrent tabs across different providers).
- **Error serialization** — `ProviderError` implements `Serialize` manually (as a string) because Tauri command errors must be serializable.

### Persistence layout

All app data lives under `~/.config/dez/` (path computed from `$HOME` directly, not via Tauri's path API):

- `app_state.json` — tabs, active tab, theme, pill-separator toggle, default-model preferences. Read/written by `persistence::{load,save}_app_state` via the `load_app_state` / `save_app_state` commands.
- `conversations/<sanitized-id>.txt` — one file per conversation. Custom plain-text format with an HTML-comment header (`<!-- title: X | model: Y | created: N -->`) and `--- USER ---` / `--- AGENT ---` separators. See `persistence::serialize_conversation` / `parse_conversation`.
- `provider_keys.json` — per-provider credentials (OpenRouter/Z.ai/MiniMax API keys + Copilot's GitHub token, Copilot token, and expiry). Written with mode `0600` on Unix. Loaded at startup in `lib.rs::run()` and re-applied via `provider.configure()` / direct field assignment for Copilot.

The frontend never touches these files directly — all persistence goes through Tauri commands defined in `commands.rs` (registered in `lib.rs::run()`). `@tauri-apps/plugin-store` is available as a dependency but is NOT used for app state anymore.

### Copilot OAuth flow

Copilot auth is a two-step device flow:

1. `copilot_start_device_flow` → calls GitHub's device-code endpoint, returns `{ device_code, user_code, verification_uri, interval }`. UI shows `user_code` to the user and opens `verification_uri`.
2. `copilot_poll_device_flow` → polls GitHub's token endpoint with `device_code`. Once it gets an `access_token`, stores it as `github_token` and calls `ensure_copilot_token()` to exchange it for a short-lived Copilot token (from `api.github.com/copilot_internal/v2/token`). Returns `true` when authenticated.

The Copilot token expires (`copilot_token_expires_at`) and is refreshed by `ensure_copilot_token()` on startup and whenever needed before `stream_chat`. Unlike the other providers, Copilot does NOT use `set_api_key` / `provider.configure()` — use the device-flow commands instead.

## Gotchas

- **Role mapping**: The app uses `'agent'` internally but OpenAI-compatible APIs expect `'assistant'`. Every provider's `stream_chat` maps `role == "agent"` → `"assistant"` inline when building the request body. Any new provider must replicate this mapping or API calls will 400.
- **ThreadEditor DOM management**: `buildDOM()` does a full `innerHTML = ''` and rebuild. The `syncing` flag prevents `readDOMToStore()` from firing during programmatic DOM updates. If you add DOM mutation logic, always check/set this flag.
- **Browser cloning blocks on Enter**: When the user presses Enter inside contenteditable, the browser may clone the `section-block` div. `readDOMToStore()` handles this by grouping blocks with the same `data-section-id`. Don't assume one block per section in DOM.
- **Settings persistence is indirect**: `settingsStore` does not persist itself. It schedules a debounced (200ms) call to `persistCallback`, which `App.vue` wires to `tabStore.saveAppState()`. The full app state (tabs + settings) is persisted together. Calling `settingsStore.init()` before `App.vue` sets up that callback will silently drop the first persistence.
- **Tauri Channel streaming**: The frontend passes a `Channel<StreamEvent>` to `invoke()`. The Rust side spawns a task that writes to mpsc, and a second task forwards mpsc → Tauri Channel. The `StreamEvent` is a tagged enum serialized as `{ kind, data }` (e.g. `{ kind: "Token", data: { content: "..." } }`).
- **CSP is disabled**: `tauri.conf.json` sets `"csp": null`. This is intentional during development.
- **Capabilities**: Only `core:default`, `opener:default`, and `store:default` are granted in `capabilities/default.json`. New Tauri plugins need their permissions added here.
- **Registry lock held across HTTP**: `send_message` calls `registry_arc.lock().await` and holds the guard across the entire `provider.stream_chat(...)` call. Concurrent streams across tabs are serialized on this mutex. If you need real concurrency, extract per-provider state into its own `Arc<Mutex<>>` first.

Do not ever read or view or `cat` the file `~/.config/dez/provider_keys.json` as it can contain API keys.

## Code Conventions

- Vue 3 `<script setup>` SFCs with TypeScript
- Pinia stores use the composition API (setup function) style, not options style
- Rust uses `thiserror` for error types, `async-trait` for async trait methods
- No CSS framework — all styles are component-scoped or in `App.vue` global styles using CSS custom properties (`--color-*`)
- IDs generated via `crypto.randomUUID()`
- Theme support: light/dark/system via `data-theme` attribute on `<html>` and `prefers-color-scheme` media query
- Rust/TS field naming crosses a boundary: most `persistence.rs` structs use `#[serde(rename = "camelCase")]` on individual fields to match the TS side. Don't assume a global `rename_all` — check the struct.
