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

## Project-level plan

The project contains a top-level PLAN.md file that is being implemented via the 'tasks' skill.

If the user asks you to "continue the plan" or something to that effect, read the top-level PLAN.md file, load the 'tasks' skill, and verify what step we're currently on (the PLAN.md file might be out of date, so check for existence of task files first) and then either continue the current task (if it's not finished), or create a new  task for the current part of the plan we're on.

When a project-level step is completed, remember update the top-level PLAN.md to mark it as completed.

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
    → Frontend Channel.onmessage appends tokens to agent section
    → requestAnimationFrame loop rebuilds DOM during streaming
```

### Frontend (`src/`)

- **Single contenteditable surface** — `ThreadEditor.vue` is NOT a traditional chat UI. It's one `contenteditable="true"` div that imperatively manages its own DOM via `buildDOM()`. The store is the source of truth; DOM is rebuilt from store state (not the other way around for structure). Text edits sync back to the store via `readDOMToStore()` on input events.
- **Sections model** — A conversation is `Section[]` where each section has `{ id, role: 'user'|'agent', content }`. Pill separators between sections are non-editable DOM elements rendered inline. Shift+Enter splits into a new section.
- **Stores**: `tabStore` owns all tab state (including sections and activeModel per tab). `threadStore` is a computed proxy over the active tab's data. `settingsStore` persists to disk via `@tauri-apps/plugin-store`.
- **Composables**: `useStreaming` manages the streaming lifecycle. `useKeyboardShortcuts` handles global shortcuts. `useMessageParser` and `useCodeHighlighter` handle rendering concerns.
- **Streaming state** (`isStreaming`, `streamingTabId`, `streamingError`) uses module-level refs in `useStreaming.ts` — these are shared singletons across all component instances, not per-composable-call state.

### Backend (`src-tauri/src/`)

- **Provider trait** — `LlmProvider` in `providers/mod.rs` defines `stream_chat(messages, model, tx)` returning tokens via an unbounded mpsc channel. All providers implement this trait via `#[async_trait]`.
- **SSE parsing** — `stream_openai_sse()` in `providers/mod.rs` is a shared helper for OpenAI-compatible SSE streams. Providers with compatible APIs (OpenRouter, Copilot) reuse it.
- **Generation cancellation** — Each tab's active generation is tracked by `JoinHandle` in `GenerationState`. `cancel_generation` aborts the tokio task. `send_message` auto-cancels any prior generation for the same tab.
- **ProviderRegistry** — Constructed once at startup in `lib.rs`, wrapped in `Arc<Mutex<>>`, and passed as Tauri managed state. Holds the lock during the entire `stream_chat` call (potential bottleneck for concurrent tabs).
- **Error serialization** — `ProviderError` implements `Serialize` manually (as a string) because Tauri command errors must be serializable.

## Gotchas

- **Role mapping**: The app uses `'agent'` internally but OpenAI-compatible APIs expect `'assistant'`. The mapping happens in each provider's `stream_chat()` — see `openrouter.rs:92`. Forgetting this mapping will cause API errors.
- **ThreadEditor DOM management**: `buildDOM()` does a full `innerHTML = ''` and rebuild. The `syncing` flag prevents `readDOMToStore()` from firing during programmatic DOM updates. If you add DOM mutation logic, always check/set this flag.
- **Browser cloning blocks on Enter**: When the user presses Enter inside contenteditable, the browser may clone the `section-block` div. `readDOMToStore()` handles this by grouping blocks with the same `data-section-id`. Don't assume one block per section in DOM.
- **Settings persistence**: Uses `@tauri-apps/plugin-store` with `autoSave: true`, stored in `settings.json`. The `init()` must be called on mount (done in `App.vue`).
- **Tauri Channel streaming**: The frontend passes a `Channel<StreamEvent>` to `invoke()`. The Rust side spawns a task that writes to mpsc, and a second task forwards mpsc → Tauri Channel. The `StreamEvent` is tagged enum (`kind`/`data` in JSON).
- **Providers not yet implemented**: Zed, Copilot, and MiniMax providers exist as stubs with hardcoded model lists. Only OpenRouter has a real `stream_chat` and `list_models` implementation.
- **CSP is disabled**: `tauri.conf.json` sets `"csp": null`. This is intentional during development.
- **Capabilities**: Only `core:default`, `opener:default`, and `store:default` are granted in `capabilities/default.json`. New Tauri plugins need their permissions added here.

## Code Conventions

- Vue 3 `<script setup>` SFCs with TypeScript
- Pinia stores use the composition API (setup function) style, not options style
- Rust uses `thiserror` for error types, `async-trait` for async trait methods
- No CSS framework — all styles are component-scoped or in `App.vue` global styles using CSS custom properties (`--color-*`)
- IDs generated via `crypto.randomUUID()`
- Theme support: light/dark/system via `data-theme` attribute on `<html>` and `prefers-color-scheme` media query
