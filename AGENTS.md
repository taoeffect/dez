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

# Release notes body for a tag (the release workflow runs it; needs gh, a
# clone with full history and tags, REVIEW_MODEL, REVIEW_PROVIDER, and the
# provider's API key, e.g. ZAI_API_KEY; prints to stdout without --out)
node scripts/release-notes.js <tag> [--out <file>]

# Preview built frontend
npm run preview

# Type-check frontend
npx vue-tsc --noEmit

# Rust backend checks/tests
cd src-tauri && cargo check
cd src-tauri && cargo test
```

Tagged releases are driven by `.github/workflows/release-desktop.yml`: pushing a `v*` tag first runs the E2E UI tests workflow as a reusable job, and only if it passes builds Linux x86_64 and Linux ARM64 AppImages on Ubuntu, an unsigned Apple Silicon DMG on macOS, writes the release notes, creates the GitHub Release if needed, and uploads all artifacts. Linux release asset names include the architecture, e.g. `Dez_<version>_linux_x86_64.AppImage` and `Dez_<version>_linux_arm64.AppImage`.

The `release-notes` job runs `scripts/release-notes.js`. The release body is `.github/release-notes-template.md` (the only source of that text), then a `## Changes` part that the `REVIEW_MODEL` model writes from the commit messages since the previous release, in the style of the v0.8.0 notes. `REVIEW_MODEL` and `REVIEW_PROVIDER` are variables of the GitHub environment `Default`, not repository variables. `ZAI_API_KEY` is a secret of `Default` and also a repository secret, so the environment does not limit it: only the "Write release notes" step may reference it, and no other job may reference it or use `secrets: inherit`. The `release-notes` job runs no `npm ci`, and the script uses only Node built-ins. If the notes fail, no release is made; "Re-run failed jobs" retries without a rebuild. A release that already exists keeps its notes, because a maintainer may have edited them. Then the notes job does not run the script, so a model failure cannot stop the asset upload. To write new notes for an existing release, run the script locally, then `gh release edit <tag> --notes-file <file>`.

Every CI job removes the compromised eMudhra CA roots in its first step, before any network request. Ubuntu jobs run the shared okTurtles action `okTurtles/libcheloniajs/.github/actions/fix-ubuntu-ca-roots@main` and get `NODE_OPTIONS: --use-openssl-ca` (in the workflow `env` of `e2e.yml`; in the job `env` of the Ubuntu jobs in `release-desktop.yml`, so the macOS job does not get it). The macOS job runs its own inline fix. A new job must do the same. The header of that action's [`action.yml`](https://github.com/okTurtles/libcheloniajs/blob/main/.github/actions/fix-ubuntu-ca-roots/action.yml) gives the reasons and all the rules for callers.

Frontend unit tests use Vitest with colocated `*.test.ts` files; `npm test` also runs the colocated `scripts/*.test.js` tests of the Node scripts. Observed automated tests include Rust unit tests in `src-tauri/src/commands.rs` and `src-tauri/src/key_store.rs`.

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
  -> Mod-Enter (the key, the Submit button, or Conversation › Send) calls dez.controller/submitTab
    -> dez.model/streamMessagesForTab builds the request messages (sectionsToStreamMessages: an agent section of the request model with a thinking replay carries its thinking)
    -> dez.model/ensureTrailingAgentSectionForTab stamps the agent section with the request model
    -> dez.stream/start creates a stream session + native HTTP request id
      -> dez.provider/streamChat builds provider-specific requests in TypeScript
      -> dez.http/stream owns a Tauri Channel and byte stream
        -> dez.native/streamHttp invokes Rust http_bridge::stream_http
          -> Rust spawns a Tokio task, streams reqwest chunks, and emits Headers/Chunk/Done/Error
      -> TypeScript decodes SSE frames; the format's stream parser (openaiSse.ts / anthropicSse.ts) splits answer tokens from thinking tokens
    -> dez.stream/receiveToken appends tokens to the captured agent section
    -> dez.editor/appendTokenIfVisible patches the active CodeMirror view only when visible
    -> onThinking: appendThinkingToTabSection updates the store, then dez.editor/setSectionThinkingIfVisible updates the visible pill
    -> on success, setThinkingReplayForTabSection stores the thinking replay before the finish saves the conversation
    -> finish/error/cancel reconciles the editor, appends a trailing user section, and persists
    -> on error, dez.stream/start logs it and shows a sticky error toast; if the request failed before any answer text or thinking, the finish removes the agent section instead and adds no user section, so the tab is as the user typed it
```

### Frontend (`src/`)

- **Single editor surface**: `ThreadEditor.vue` owns one CodeMirror `EditorView`; the old contenteditable/chat-message architecture is no longer current. Avoid DOM-first fixes. The CodeMirror document is flattened text with sentinel markers, and store state is reconstructed through helpers in `src/view/thread/cmEditor.ts`.
- **Conversation model**: A tab owns `Section[]`, where each section is `{ id, role: 'user'|'agent', content: ContentNode[], model?: ModelRef, thinking?: SectionThinking }`. `ContentNode` is `TextNode` or `PromptNode`. Shared helpers are in `src/model/chat/content.ts`. `model` is the `{ providerId, modelId }` that wrote an agent response; the key is absent when the model is unknown (old files, hand-made sections, new user sections), so code that copies sections copies it only when set. A section toggled from agent to user keeps its `model` in memory, so toggling it back shows the model again; check `role === 'agent'` before you show or save a model. Model key helpers (`modelRefKey`, `parseModelRefKey`, `sameModelRef`) are in `src/model/chat/modelRef.ts`.
- **Section thinking**: `thinking` is `{ text, replay? }` (types in `src/model/chat/types.ts`). `text` is what the pill shows. `replay` is what goes back to the provider; it is valid only for the section's `model`, and a section without it never sends its thinking back. The rules of `model` apply: copy it only when set, with `thinkingField()` from `src/model/chat/thinking.ts` (never `thinking: undefined`), and show, save, or send it only when `role === 'agent'`. Thinking is not in `content` and not in the CodeMirror doc, so previews, search, titles, find, Save As Markdown, and Copy Markdown never see it.
- **CodeMirror sentinels**: `cmEditor.ts` uses ASCII Record Separator `SECTION_SEP = '\u001E'` as an in-buffer section boundary. Prompt pills are encoded with private-use sentinels `PILL_OPEN`, `PILL_BODY`, `PILL_CLOSE`, and `PILL_NL`; these are live-editor implementation details and must not be written to disk or exposed in clipboard text.
- **State fields**: `sectionsField` mirrors per-section `{ id, role, model?, thinking? }`; `pillsField` stores prompt metadata (`name`, `promptId`, `expanded`) keyed by the in-doc pill id. Text lives in the CodeMirror doc, not these fields. `thinkingExpandedField` (`src/view/thread/thinkingPill.ts`) holds the ids of the open thinking panels; it is view state and is never saved. `streamingSectionField` (`modelChip.ts`) is the id of the section that streams.
- **Role separators**: Role pills are CodeMirror replacement widgets over `SECTION_SEP` lines. They always show; no setting hides them. The first section is normalized to `user`; toggling a role only applies to separators after the first section, and a mousedown anywhere on a separator's pill, its model part too, toggles that role (the thinking triangle and panel are the exceptions). When an agent section has a model, its agent pill also shows that model after the role word, in the same pill (`addModelToPill` in `src/view/thread/modelChip.ts`): the model name, the provider name, a switch icon when the model differs from the nearest earlier agent section that has a model, and an animation while that section streams. Every model uses the same agent accent color; the name, not a color, tells models apart. The pill with a model has the same height as the other pills and never wraps; a long model name ends in an ellipsis. Names come from `dez.provider/modelDisplayNames` through `modelLabel()` in `src/view/modelLabel.ts` (config name, then cached name, then the model id; an unknown provider shows no provider name). The model is widget DOM, not doc text, so find and copy never see it.
- **Thinking in the agent pill**: `src/view/thread/thinkingPill.ts` draws the left slot of an agent pill and its thinking panel. While the section streams and has no thinking yet, the slot is a spinner; when the section has thinking, it is a disclosure triangle. A mousedown on the triangle opens or closes the panel. The panel is a read-only textarea that updates live and scrolls; CodeMirror ignores events in it (`isThinkingPanelEvent`), so selection and copy work natively there. See the thinking pill gotcha below.
- **History panel**: `src/view/history/HistoryPanel.vue` lists saved conversations. A row shows the conversation header model with the same `modelLabel()` names as the agent pills, so a custom provider shows its name, not its UUID id; the model's tooltip (`title`) is the raw `provider/model` key. History search still matches the raw key, not the display names.
- **Prompt pills**: Saved prompts are managed in `PromptManager.vue` and persisted by `promptsStore`. Typing `/prompt ` in `ThreadEditor.vue` opens `PromptAutocomplete.vue`; accepting inserts a prompt sentinel sequence plus metadata. Prompt body text is copied per insertion and does not mutate the saved prompt template.
- **Find/replace**: `src/view/editor/find.ts` is the CodeMirror find engine (matching, highlights, navigation, replace). It uses only `SearchQuery` and its cursors from `@codemirror/search`, not the built-in search panel, commands, or keymap. `findState.ts` holds the dropdown state that must survive `view.setState()`, `findHistory.ts` is the in-memory search history, and `src/view/thread/FindDropdown.vue` is the UI. Workflows are the `dez.editor/openFind`, `closeFind`, `selectFindMatch`, and `replaceFindMatches` selectors; global keys are in `src/view/composables/useKeyboardShortcuts.ts`. Matches skip sentinels, separator lines, pill markers, and collapsed prompt bodies, so a replace never touches them; iterate matches only through `findMatches()`.
- **Markdown tables**: `src/view/editor/tables.ts` shows valid GFM tables in the thread editor as tables, in place. `findMarkdownTables()` is its own section-aware scanner, because the editor's markdown language has no GFM. `markdownTables()` is the CodeMirror extension that `buildState()` in `ThreadEditor.vue` adds; the table CSS is in `dezTheme` in `cmEditor.ts`. The rule: a top-level GFM table renders if and only if its source is valid, wherever the cursor is. Tables in blockquotes never render; the `findMarkdownTables()` comment says which tables in list items do. No table text is replaced: every character stays in the DOM and keeps its caret position, and CSS only makes the delimiter row and the splitting pipes transparent. So an edit that breaks the syntax shows the raw source, and a fix renders the table again. Table row lines hold only cell marks (no widgets or replace decorations), or the browser adds extra columns. `markdownTables()` also draws the editor selection (it hides the `drawSelection()` layer) and forwards clicks in the margin beside table rows.
- **Model state**: Pinia stores under `src/model/state/**` are internal model implementation details. `dez.model/*` selectors own tab mutations, active models, titles, settings, custom provider configs, prompts, stream session state, app-state serialization, and persistence watchers; view code reads reactive state through `src/view/modelState.ts`.
- **Streaming state**: `src/model/state/streams.ts` tracks per-tab sessions. `src/controller/stream.ts` owns lifecycle/cancellation, `src/model/providers/**` builds provider requests and parses streamed tokens, `src/controller/http.ts` owns active native HTTP streams, and `src/view/editor/selectors.ts` owns the active CodeMirror bridge. Each API format makes one parser per stream (`createStreamParser`, in `openaiSse.ts` and `anthropicSse.ts`); it splits answer tokens from thinking tokens, and at the end gives the thinking replay of a complete thinking. Thinking tokens do not count in the session `tokenCount`.
- **Settings › Providers**: `src/view/settings/ProviderManager.vue` is the provider page, with the same master-detail layout as `PromptManager.vue`. Built-ins show a "Built-in" badge and cannot be edited or deleted; custom providers can. The page calls the `dez.controller/providers/*` workflows in `src/controller/providers.ts`. A provider that supports thinking shows a "Thinking" switch. A custom provider also has a "Supports thinking" checkbox: checked writes `thinking: {}` into its config, and unchecked removes the key.
- **Menubar and shortcuts**: `src/controller/menu.ts` builds the native menubar in TypeScript (`dez.controller/menu/install`, called from `dez.controller/app/init`; skipped outside Tauri, so `npm run dev` has no menu). Every shortcut has a menu item, and the item and the key handler call the same selector. App keys are in `src/view/composables/useKeyboardShortcuts.ts`; editor keys stay in the CodeMirror keymaps, and menu items run them through `dez.editor/runKeyBinding`. The Settings › General shortcut list is `shortcuts` in `SettingsView.vue`. See the key order gotcha below.
- **Esc**: Esc closes the innermost open thing first: the model dropdown, a Settings or History modal, the prompt autocomplete, or find. With none open, it stops the active tab's stream (`dez.stream/stop`): an editor keymap in `ThreadEditor.vue` when the editor has focus, else the window handler. Conversation › Stop does the same, but has no accelerator: on Linux an `Escape` accelerator would take Esc from find, the dropdowns and the modals. `tests/e2e/submit-stop.e2e.ts` covers the order.
- **Bottom bar**: `AppLayout.vue` has a `<footer class="bottom-bar">` with `ModelSelector.vue` on the left (its model dropdown and gear popup open upward) and `src/view/thread/SubmitButton.vue` on the right. The button says "Submit" with the keycap `⌘↩` (macOS) or `Ctrl+↩` and runs `dez.editor/runKeyBinding('Mod-Enter')`, the same path as the key and Conversation › Send. While the active tab streams, it says "Stop" with `Esc` and calls `dez.stream/stop`; it is the only Stop button. It prevents `mousedown`, so a click keeps the focus and caret in the editor. `.app-layout` sets `--toast-inset-bottom` to the bar height, so the bottom toasts stay above the bar and a sticky error toast never covers the button.
- **Copy Markdown**: Edit › Copy Markdown (`CmdOrCtrl+Shift+C`) runs `dez.editor/copyMarkdown`. A focused text field (an input, or a thinking panel) copies its own selected text as is, because on Linux the menu accelerator takes the key from every field; a password field gives nothing. Else the focused editor copies `serializeSelectionAsMarkdown` (`cmEditor.ts`). Copy Markdown and Save As Markdown (`serializeConversationAsMarkdown`) render messages with the one helper `messagesAsMarkdown` (`src/model/chat/markdown.ts`), so a copy of a whole tab is the saved file without its `# Title` line: no `dez:` markers, no thinking, prompt bodies inline, and a `## User` / `## Agent` heading for each section whose role pill is in the selection (the first section's pill counts from doc position 0). A selection inside one section's text copies that text as is.
- **Editor font size**: Cmd/Ctrl+= and Cmd/Ctrl+- (the page key handler and View › Increase/Decrease Font Size) call `dez.model/settings/changeEditorFontSize(±1)`. The size is `editorFontSize` in the settings store and `app_state.json` (px, default 15, 10 to 32; the parse rounds and clamps a hand-edited value). `dez.ui/applyEditorFontSize` (`src/view/theme.ts`) sets `--dez-editor-font-size` on `<html>`, and `dezTheme` (`cmEditor.ts`) builds every editor size from it with `editorSize(px)`, so text, pills, the thinking panel and tables scale together. One size serves every tab. The app chrome (tab bar, bottom bar, find, modals, toasts, prompt autocomplete) keeps its size. `ThreadEditor.vue` watches the setting and calls `measureTextSize` (`src/view/thread/editorMeasure.ts`). `tests/e2e/font-size.e2e.ts` covers it.
- **Window size and position**: `src/controller/window.ts` restores the main window at startup and saves its geometry. `dez.controller/app/init` calls `dez.controller/window/restore` right after the settings load. It fits the saved `window` from `app_state.json` to the monitors there are now (`fitWindowGeometry` in `src/controller/windowFit.ts`: the size is clamped to the work area, the top-left corner is moved inside it, and a window with no part on a monitor is centered on the primary monitor). Then it sets the size (logical px), the position (physical px), and maximized, and it always shows the window. With nothing saved, the default 900x700 window is centered. `dez.controller/window/startTracking` saves the geometry 500 ms after the last move or resize through `dez.model/settings/setWindowGeometry`. It does not save a minimized or fullscreen window, and a maximized window keeps its last normal size and position with `maximized: true`. Fullscreen comes from `dez.native/isWindowFullscreen` (Rust `is_window_fullscreen`), not from `isFullscreen()`: on Linux, tao does not see a fullscreen that the window manager makes, so the command reads the GDK state. Cleanup drops a pending save, so a move just before quit can be lost. Wayland gives no window positions: there only the size and maximized are restored. With GTK client-side decorations (Linux, mostly Wayland), the read size is larger than the set size; the tracker takes that extent away (see the comment in `window.ts`), or the window would grow at each launch. `tests/e2e/window.e2e.ts` covers it; no spec covers fullscreen, because only a window manager can make one and CI has none.
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
- **Thinking**: a config that has `thinking` (`{ enabledBody?, disabledBody? }`) supports thinking. Without it, Dez sends no thinking fields, ignores reasoning in replies, and shows no Thinking toggle. When the toggle is on, `Provider.chatRequest` deep-merges `enabledBody` into the body (absent: the format's `thinkingBody`, which for `anthropic` is adaptive thinking with summarized display, and for `openai` is nothing); when it is off, it merges `disabledBody` if set. The merge runs after the `settings` writes.
- **Thinking toggle**: it is stored at `settings.providerSettings[providerId].thinking`, and a missing value means on. `THINKING_SETTING_KEY` and `isThinkingEnabled()` are in `src/model/providers/thinking.ts`, and `config.ts` refuses a `settings[]` entry with that key. Two UIs change this one value: the Thinking row of the model picker's gear popup (`ProviderSettingsPopup.vue`, so "Reset to defaults" resets it too) and the Thinking switch in Settings › Providers. Views learn support from `supportsThinking` in `dez.provider/infos` and `dez.provider/settingsDescriptor`, never from registry imports.
- **Thinking send-back**: when the toggle is on, `chatMessagesBody` in `apiFormats.ts` sends the replay of each same-model agent message in the wire shape of its kind: `openai` sends a `reasoning_content` or `reasoning` field, `reasoning_details`, or Copilot's `reasoning_text` plus `reasoning_opaque`; `anthropic` sends the thinking blocks before the text. A replay of the other format is skipped. A signed replay keeps a `prefixHash` of the messages before it (`ThinkingPrefixHasher` in `thinking.ts`). It goes back only while the messages before it still have that hash: a replay whose prefix changed (the user edited an earlier message) is dropped, and a later replay that still matches is sent. Do not add other drop rules; the comment on `chatMessagesBody` tells why the hash check is enough.

### Toasts

Toast UI lives under `src/view/toast/`. Toasts are emitted through the SBP selector `dez.ui/toast` and rendered by `ToastContainer.vue`; `AppLayout.vue` mounts the app-wide container. Toast actions that open external URLs should use `dez.controller/openUrl`. See `src/view/toast/README.md` for payload fields, examples, area behavior, and display rules.

Errors of a chat request (and Send with no model) show as error toasts with no `duration`, so they stay until the user closes them; the thread shows no error text. The error card is red-tinted, grows with its text up to 560 px, and scrolls a long message. Its colors are the `--color-error*` variables in `App.vue` (light and dark). E2E specs read open error toasts with `openErrorToasts` in `tests/e2e/harness/thread.ts`.

### Backend (`src-tauri/src/`)

- **Keep Rust barebones**: The Rust layer should stay as small as possible — a thin, generic interface to the OS, not a per-feature API. Prefer generic, reusable commands/functions over adding a new bespoke command for every feature. When a new feature needs native behavior that resembles existing behavior (e.g. reading/writing another JSON file under `~/.config/dez/`), reuse or generalize the existing mechanism rather than copy-pasting another near-identical command, so adding frontend features rarely requires touching Rust. For example, single-file JSON persistence goes through generic `load_app_file(name)` / `save_app_file(name, content)` commands where TypeScript chooses the file name (with path-traversal-safe sanitization in Rust), instead of one command per file.
- **Command entry points**: Tauri commands live in `commands.rs` and `http_bridge.rs`; `lib.rs` registers them with `tauri::generate_handler!`. The only frontend direct `invoke()` call sites should be selectors in `src/controller/native.ts`.
- **Native HTTP bridge**: Provider model listing and chat streaming are TypeScript-owned. Rust exposes generic `http_request`, `stream_http`, and `cancel_http_stream` commands backed by a shared `reqwest::Client` and `HttpStreamState` map of `requestId -> JoinHandle`.
- **Streaming events**: `http_bridge.rs` emits `{ kind, data }` Tauri Channel events: `Headers`, `Chunk`, `Done`, and `Error`. TypeScript assembles bytes and parses provider-specific SSE.
- **Credentials**: `key_store.rs` reads/writes `~/.config/dez/provider_keys.json` with mode `0600` on Unix. The store is generic: one `api_key` entry per provider id (built-in or custom), plus a `copilot` entry with GitHub/Copilot token fields (chat tokens refresh via `copilot.rs`). `save_provider_secret` and `delete_provider_secret` refuse `copilot` and invalid ids. If the file cannot be read or parsed, every key command fails, so no save can overwrite the stored keys.
- **Persistence**: `persistence.rs` only performs private-file raw string I/O and id sanitization. TypeScript owns app-state, prompt, and conversation format parsing/serialization. `write_private_file` in `persistence.rs` (a `0600` temp file, then a rename) writes every private file, `provider_keys.json` too; use it for any new one.
- **Plugins and app folder**: `lib.rs` registers the `opener`, `fs`, `dialog`, and `store` plugins. Save As Markdown has no Rust command: `dez.native/showSaveDialog` (dialog plugin) adds the picked path to the fs scope at run time, and `dez.native/writeTextFile` (fs plugin) writes it, so the webview can write only files the user picked. A click on its "Conversation saved" toast runs `dez.controller/revealInFileManager(path)` (`src/controller/utils.ts`), which shows the file with the opener plugin's `revealItemInDir` (allowed by `opener:default`, with no path scope): Finder selects it on macOS, and on Linux the plugin needs an `org.freedesktop.FileManager1` D-Bus service (Dolphin, Nautilus); a failure shows an error toast. Open Dez Folder gets the path from the generic `get_app_dir` command (creates `~/.config/dez/` if missing) and opens it with the opener plugin's `openPath`.

## Persistence layout

All app data is under `~/.config/dez/`, computed from `$HOME` in Rust rather than Tauri's path API.

- `app_state.json`: tabs, active tab id, theme, editor font size (`editorFontSize`), main window geometry (`window`: `{ width, height, x, y, maximized }`, a logical size and a physical position), default model settings, last-used model, favorites, provider setting toggles (`providerSettings`, the Thinking toggle too), and custom provider configs (`customProviders`). Dez never writes keys into it: at startup, a hand-added `apiKey` in a `customProviders` entry moves into `provider_keys.json` and is removed from `app_state.json`. A hand-added `headers` value is kept as written, so a key that a user puts in a header stays in this file. Runtime parsing/serialization is TypeScript-owned in `src/model/persistence/appState.ts`; Rust only reads/writes raw JSON via the generic `load_app_file('app_state.json')` / `save_app_file('app_state.json', content)` commands.
- `conversations/<sanitized-id>.md`: Markdown-like conversation files with a header and Dez XML-ish structural markers. Conversation ids are sanitized to ASCII alphanumeric, `-`, and `_` before use as filenames. Runtime parsing/serialization is TypeScript-owned in `src/model/persistence/conversationFormat.ts`; Rust only reads/writes/lists/deletes raw files through the raw conversation-file commands.
- `prompts.json`: saved prompt templates (`{ id, name, content }[]`). Runtime parsing/serialization is TypeScript-owned in `src/model/persistence/prompts.ts`; Rust only reads/writes raw JSON via the generic `load_app_file('prompts.json')` / `save_app_file('prompts.json', content)` commands.
- `model_cache.json`: per-provider cached model lists plus a `working` flag and timestamps, used so the model selector opens instantly with the last-known models while a background refresh reconciles availability. Shape is `{ version, providers: { <providerId>: { models, working, updatedAt, lastCheckedAt } } }`. Runtime parsing/serialization is TypeScript-owned in `src/model/persistence/modelCache.ts` (Zod-tolerant); Rust only reads/writes raw JSON via the generic `load_app_file('model_cache.json')` / `save_app_file('model_cache.json', content)` commands. Stores only model ids/names/provider — never secrets.
- `provider_keys.json`: one object, `{ "<providerId>": { "api_key": "…" }, …, "copilot": { <GitHub/Copilot tokens> } }`, for built-in and custom providers alike. Files are written with mode `0600` on Unix.

Do not ever read, view, print, or `cat` `~/.config/dez/provider_keys.json`; it can contain API keys and OAuth tokens.

### Conversation file format

- Header: `<!-- title: X | model: provider/model | created: N -->`. The header `model:` is the tab's last selected model, not the model of each response.
- Section markers: `<dez:pill type="user"/>` and `<dez:pill type="agent"/>` on their own lines. An agent pill with a section model is `<dez:pill type="agent" model="provider/model"/>`. Only agent pills get `model`; it is ignored on user pills. Attribute order does not matter, and a missing or bad `model` value means "no model" (old files load with no model, and Dez does not fill it in from the header). The file and the clipboard write and read pill markers only through `src/model/chat/pillMarker.ts`.
- An agent section with thinking is a container instead: the opening line `<dez:pill type="agent" model="provider/model" replay="{…}">`, then the exact thinking text (not trimmed, not indented), then a `</dez:pill>` line. Sections with no thinking keep the self-closing marker. In the text, each run of `<`, zero or more `\`, an optional `/`, and `dez:pill` gets one more `\` on write and loses one on read, so the text holds no marker and reads back byte for byte (a `field` replay sends it back to the provider). `replay` is JSON; a missing value or an unknown shape means no replay, which is not an error. A body on a user pill is dropped, and an opening tag with no closing line before the next marker (a hand edit lost it) reads as a self-closing marker, so a later container's closing line never turns section text into thinking.
- Marker attribute values (`model`, clipboard prompt `name`) are escaped with `src/utils/markerAttribute.ts`: `&`, `"`, LF, and CR become `&amp;`, `&quot;`, `&#10;`, and `&#13;`, so a marker stays on one line. The conversation file writes prompt names unescaped.
- Prompt markers: `<dez:prompt name="NAME"> ... </dez:prompt>` wraps a prompt insertion body.
- Literal `</dez:prompt>` inside a prompt body is escaped as `<\/dez:prompt>` on save.
- Prompt `expanded` is not persisted as UI state on load; frontend rehydrates loaded prompts collapsed.
- Clipboard serialization in `cmEditor.ts` uses the same `dez:` marker namespace and strips live CodeMirror sentinels. Copied agent pills carry `model`, and thinking with its replay, so a paste keeps them.

The frontend never touches these files directly; use `dez.persistence/*` selectors from app code. `src/controller/native.ts` is the only frontend layer that should invoke raw Tauri file commands.

## Gotchas

- **AGENTS may outlive implementation details**: This code recently moved from contenteditable DOM reconstruction to CodeMirror. If an older note mentions `buildDOM()` or `readDOMToStore()`, verify against `ThreadEditor.vue`/`cmEditor.ts` before following it.
- **Do not leak sentinels**: `SECTION_SEP` and prompt private-use codepoints are only for the live CodeMirror doc. `stripLiveSentinels`, clipboard serializers, and persistence conversion exist to keep them out of user-visible text and disk files.
- **First section role invariant**: `cmEditor.ts` normalizes the first section to `user`. Role separator widgets represent the section after the separator, so index math around separators is easy to get off by one.
- **Prompt newlines in collapsed pills**: Collapsed prompt bodies escape `\n` as `PILL_NL` because CodeMirror inline replacement decorations do not correctly collapse multi-line ranges. Expanded pills restore real newlines for editable body text.
- **Settings persistence is model-owned**: `dez.model/settings/startPersistence` installs debounced app-state persistence and theme watchers after `dez.controller/app/init` loads initial state. Calling model settings mutations before startup completes can race initial persistence readiness.
- **Prompt persistence is separate**: Saved prompt templates persist through `dez.model/prompts/startPersistence` to `prompts.json`; prompt insertions inside conversations persist as conversation content nodes/markers and are independent copies.
- **Active-tab streaming patch**: Streaming always mutates the agent section captured at stream start. Only the currently active tab's registered CodeMirror view is patched through `dez.editor/appendTokenIfVisible`; tab/store guards prevent tokens from applying to the wrong visible editor.
- **Stream scroll follow**: `src/view/editor/selectors.ts` owns it. When a reply starts, the visible view scrolls to the bottom and follows the reply. A scroll up by the user stops the follow: the reply streams on, and the view stays still, also at the stream end. A scroll down to the bottom starts the follow again. The stop test is "the view moved up and is not at its bottom", because new text and CodeMirror's scroll anchoring never move a view up. So do not add code that scrolls a view up, or that scrolls a view that does not follow. `tests/e2e/stream-follow.e2e.ts` covers the rules.
- **Section model flows through the editor**: During a stream, every token is a doc change, and `syncDocToTab` in `ThreadEditor.vue` writes the editor's `sectionsField` back to the store with `dez.model/tabs/replaceSections`. So a per-section field such as `model` or `thinking` must be in `SectionModel` (`cmEditor.ts`), `docToSections`, `dez.model/thread/sectionsIdentity`, and the editor's section equality checks, or the store loses it on the first token.
- **Thinking has two copies during a stream**: a thinking change is not a doc change, so the editor does not write it back to the store. The stream changes the store (`appendThinkingToTabSection`) and the visible editor (`dez.editor/setSectionThinkingIfVisible`) separately. The copies are separate objects, so compare them by value (`sameThinking`). Store objects are reactive proxies, which `structuredClone` refuses; copy thinking with `thinkingField()`. When a stream ends, `resetViewToActiveTab` rebuilds the editor state from the store and keeps the open thinking panels of the same tab.
- **Thinking pill DOM changes in place**: `RoleSeparatorWidget.eq` ignores thinking on purpose. For a changed widget, CodeMirror moves the pill into a new line element (also with `updateDOM`), which blurs the panel and scrolls it to the top. The view plugin `pillThinkingUpdater` (`cmEditor.ts`) changes the thinking parts in place instead. Every other part that the pill draws must be in `eq` (`sameModelChip` for the model), or CodeMirror keeps stale pill DOM. Every editor state that uses `roleSeparators` needs `thinkingExpandedField` and `streamingSectionField`. An in-place change of the pill's height must call `measureLineHeights` (`src/view/thread/editorMeasure.ts`): `requestMeasure()` alone does not update CodeMirror's line heights when the doc is shorter than the editor, so the caret and clicks go to the wrong place. A change of the editor font size needs `measureTextSize` from the same file.
- **Concurrent streaming path**: Chat streaming no longer goes through a Rust provider registry. `src/controller/stream.ts` tracks request ids per tab, and `http_bridge.rs` tracks request ids globally for native cancellation.
- **Provider role mapping**: The app uses internal role `agent`. Both API formats (`openai` and `anthropic`) must map `agent` to API role `assistant` when building requests.
- **Copilot auth path differs**: Copilot does not use the API-key commands; `save_provider_secret` refuses `copilot`. Use `copilot_start_device_flow` and `copilot_poll_device_flow`; tokens are then persisted via `key_store`.
- **Tauri capabilities**: `src-tauri/capabilities/default.json` grants `core:default`, `core:app:allow-app-hide` (macOS "Hide Dez"), `core:window:allow-close` (Linux File › Quit), `core:window:allow-set-size`, `allow-set-position`, `allow-maximize`, `allow-show`, and `allow-set-focus` (window restore), `opener:default`, `opener:allow-open-path` scoped to `$HOME/.config/dez` (Open Dez Folder), `store:default`, `dialog:allow-save`, and `fs:allow-write-text-file` (no static fs scope). Add permissions there when adding Tauri plugins or calling another plugin/core command.
- **The window starts hidden**: `tauri.conf.json` sets `"visible": false`, and `dez.controller/window/restore` shows the window, also when the restore fails. So when the frontend fails before `dez.controller/app/init` runs (for example a compile error in `npm run tauri dev`), no window shows: read the Vite output. The page loads before the window shows, and a WebDriver pointer action on the hidden window fails with "move target out of bounds"; so the e2e `createSession` waits until the window shows.
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
- Never modify the features list in the project README without explicit user request.

## Testing approach

- Run `npm run build` at the end of a task step if frontend changes were made, not after every edit; it performs TypeScript/Vue type-checking before Vite build.
- Run `npm test` after frontend logic changes, especially persistence or editor helper changes covered by colocated `*.test.ts` files.
- Run `cd src-tauri && cargo check` after significant Rust changes for feedback.
- Run `cd src-tauri && cargo test` when touching Rust logic with tests, including the release/update helpers in `src-tauri/src/commands.rs`.
- Run `npm run test:e2e` after UI behavior changes covered by the WebDriver e2e specs under `tests/e2e/` (Linux only; requires the debug binary, `tauri-driver`, and `WebKitWebDriver`).
- Run `npm run typecheck:e2e` after changing the e2e harness or specs; `npm run build` does not type-check files under `tests/e2e/`.
- WebDriver keys (`browser.keys`) skip GTK, so e2e specs test the page key handlers, never the Linux menu accelerators or menu clicks. To check those by hand: run rootful Xwayland on kwin (`WAYLAND_DISPLAY=wayland-dez Xwayland :5 -geometry 1280x800 -ac`), start the app with `env -u WAYLAND_DISPLAY DISPLAY=:5 GDK_BACKEND=x11`, send real keys with XTest (`libXtst`), and click items through AT-SPI inside `dbus-run-session` (start `/usr/libexec/at-spi-bus-launcher --launch-immediately` and `/usr/libexec/at-spi2-registryd` first).
- Clicks in e2e: `click()` (`tests/e2e/harness/dom.ts`) runs `el.click()`, with no `mousedown` and no focus change. `pointerClick()` sends real mouse events through WebDriver pointer actions; use it when focus or `mousedown` matters. wry refuses the WebDriver `element/click` endpoint, so never use webdriverio's `.click()`.
- Use type-check/build and targeted manual verification via `npm run tauri dev` when UI behavior changes beyond unit-testable helper logic.

### GUI tests without a display (sandboxes)

An agent sandbox can have `DISPLAY` and `WAYLAND_DISPLAY` set while no display server runs: `$XDG_RUNTIME_DIR` has no `wayland-*` socket and `/tmp/.X11-unix` does not exist. Then the app window cannot open, and every e2e spec fails only with `Hook timed out in 120000ms` in `beforeAll`, with no display error. CI uses `xvfb-run`, but `Xvfb` may not be installed, and an install needs sudo. Use KDE's headless compositor instead; it needs no sudo:

```bash
# 1. Start it as a long-lived background process (e.g. a named service).
#    It prints nothing when ready, so do not wait for a log line.
kwin_wayland --virtual --socket wayland-dez --width 2560 --height 1600 \
  --no-lockscreen --no-global-shortcuts

# 2. It is ready when its socket exists (about 1 s after start).
test -S "$XDG_RUNTIME_DIR/wayland-dez"

# 3. Run the app or tests against it. WAYLAND_DISPLAY is the setting that
#    matters; the other two force GTK to use Wayland.
env -u DISPLAY GDK_BACKEND=wayland WAYLAND_DISPLAY=wayland-dez npm run test:e2e
```

- Stop the compositor when you are done.
- kwin gives its virtual screen scale 2 (`--scale 1` does not change it), so the command above makes a 1280x800 logical screen. The app fits its window to the screen: on a smaller screen the window is smaller than its 900x700 default, and specs that need that size fail.
- Do not use `broadwayd` (GTK's browser backend). Window sizes come out negative, CodeMirror throws in its height map, and CSS transitions crash `WebKitWebProcess`.
- To look at the UI, write a throwaway spec that calls `browser.saveScreenshot('/tmp/<name>.png')`, open the PNG, then delete the spec and the PNG. Under kwin the screenshots are real renders at 2x device pixels.
- `npm run test:e2e` uses the existing `src-tauri/target/debug/dez` as is. After source changes, rebuild it with `npm run tauri build -- --debug --no-bundle`, or the suite tests stale code. A plain `cargo build` binary does not work for e2e.
