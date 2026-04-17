# Dez — Development Plan

## Progress

- [x] 1. Foundation & Window Shell (`foundation`)
- [x] 2. Chat Message UI (`chat-ui`)
- [x] 3. Inline Editing (`inline-editing`)
- [x] 4. Editor-Style Thread Redesign (`editor-thread`)
- [x] 5. LLM Provider Abstraction (`providers`)
- [x] 6. Settings & Configuration (`settings`)
- [x] 7. Model Selector Taskbar (`model-selector`)
- [x] 8. Tabbed Conversations (`tabs`)
- [x] 9. Unified Editor Surface (`unified-editor`)
- [x] 10. Streaming Chat Integration (`streaming`)
- [x] 11. Provider Implementations (`provider-impls`)
- [x] 12. Provider Key Persistence (`provider-keys`)
- [ ] 13. Local Persistence (`persistence`)
- [ ] 14. Favorite Models (`favorite-models`)
- [ ] 15. Saved Prompts (`saved-prompts`)
- [ ] 16. Conversation History Browser (`history`)
- [ ] 17. Polish & Cross-Platform (`polish`)

---

## 1. Foundation & Window Shell — `foundation`

Set up the base Tauri + Vue 3 app with a working window, proper project structure, and essential keyboard shortcuts.

- Clean the scaffolded starter code (remove demo content)
- Establish Vue component directory structure (`components/`, `composables/`, `stores/`, `types/`)
- Set up Pinia for state management
- Configure the main window (title, default size, min size) in `tauri.conf.json`
- Wire up basic keyboard shortcuts via Tauri (Cmd/Ctrl+N new tab, Cmd/Ctrl+W close tab, Cmd/Ctrl+T new tab)
- Add a top-level `AppLayout.vue` with a placeholder tab bar and a main content area
- Verify the app builds and launches on Linux and macOS

## 2. Chat Message UI — `chat-ui`

Build the core chat thread view — the single most important UI surface.

- Create `ChatThread.vue` component that renders a list of messages
- Create `ChatMessage.vue` for individual messages (supports user and agent roles)
- Add text pill separators ("User" / "Agent" labels) between role changes, toggleable via a local setting
- Implement a `ChatInput.vue` composable textarea at the bottom with auto-resize
- Display messages as plain text with syntax highlighting for code blocks (no Markdown rendering — matches Zed's approach)
- Use `shiki` or `highlight.js` for code block syntax highlighting
- Auto-scroll to bottom on new messages, with scroll-lock when user scrolls up

## 3. Inline Editing — `inline-editing`

Let users edit any message in the thread, including agent responses.

- Double-click or press Enter on a message to enter edit mode
- Replace the message bubble with an editable textarea pre-filled with the original content
- On save, update the message in state and persist to disk
- Optionally allow "re-run from here" — resend the conversation up to the edited message and regenerate the agent response
- Visual indicator (pencil icon or "edited" label) on edited messages

## 4. Editor-Style Thread Redesign — `editor-thread`

Completely redesign the chat UI to work like Zed's text threads: a single living, always-editable document — not a chat view with an input field.

- **Remove the ChatInput / ChatThread / ChatMessage separation.** Replace with a single `ThreadEditor.vue` component that is one continuous editable document, exactly like a text/source-code editor. The user's cursor is always active; there is no "view mode" vs "edit mode" — the entire document is always editable.
- **Pill separators as role toggles.** "User" and "Agent" pill labels sit between sections of text. Clicking a pill toggles its value between "User" and "Agent". In normal conversation flow, pills alternate automatically.
- **Always editable everywhere.** The user types directly into the document at any position — adding new text at the bottom, revising earlier messages, or modifying agent responses. There is no input box, no send button, no message bubbles, no "enter edit mode" gesture. It is a plain text editor.
- **Cmd/Ctrl+Enter to submit.** Pressing Cmd+Enter (macOS) or Ctrl+Enter (Linux) submits the full thread to the LLM for continuation/inference. The agent's response streams in at the end of the document after an auto-inserted "Agent" pill.
- **Content model.** The store holds an ordered list of `{ role, content }` sections. The editor renders them as contiguous text separated by pill labels. Edits update the corresponding section in the store.
- **Code block handling.** Code blocks within sections still get syntax highlighting (read-only rendered blocks or inline highlighting).
- **Remove old components.** Delete `ChatInput.vue`, `ChatMessage.vue`, `ChatThread.vue` and the inline-editing overlay code added in step 3. Replace with the new editor component.

## 5. LLM Provider Abstraction — `providers`

Create a unified Rust-side interface for talking to multiple LLM providers.

- Define a `Provider` trait in Rust with `stream_chat(messages, model) -> Stream<Token>`
- Implement provider adapters:
  - **OpenRouter** — standard OpenAI-compatible API
  - **Z.ai** — uses the Zed AI endpoint
  - **GitHub Copilot** — OAuth + Copilot chat completions API
  - **MiniMax Coding Plan** — MiniMax API
- Store API keys securely (system keychain via `tauri-plugin-stronghold` or OS keyring)
- Expose a `list_models(provider)` command to the frontend
- Expose a `get_configured_providers` command so the UI knows which providers are ready

## 6. Settings & Configuration — `settings`

Central place to manage providers, API keys, and UI preferences.

- Create a `SettingsView.vue` (either a new tab type or a modal)
- Sections:
  - **Providers**: add/remove API keys, select default model per provider
  - **Appearance**: toggle text pill separators, choose theme (light/dark/system)
  - **General**: default new-tab model, auto-save interval, keyboard shortcut reference
- Persist settings via `tauri-plugin-store` or a JSON config file
- Settings changes take effect immediately (reactive via Pinia store)

## 7. Model Selector Taskbar — `model-selector`

A persistent taskbar at the bottom of the window for selecting the active LLM model.

- Create a `ModelSelector.vue` component anchored to the bottom of the chat view
- Display the currently selected model name as a clickable button
- On click, open a dropdown/popover with:
  - A search field to fuzzy-filter available models across all configured providers
  - Models grouped by provider
  - Visual indicator for which provider each model belongs to
- A gear icon or "Configure" link that opens the provider settings section (from step 5) to add/edit API keys
- Selecting a model updates the active conversation's model immediately
- Remember the last-used model as the default for new conversations

## 8. Tabbed Conversations — `tabs`

Enable multiple concurrent conversations in a single window.

- Create `TabBar.vue` component with horizontally scrollable tabs
- Each tab holds an independent conversation (own message list, own model selection)
- Support creating, closing, and switching tabs
- Show a "+" button to create new tabs
- Middle-click or close icon to close tabs
- Persist tab order and active tab in memory (not yet to disk — that comes in persistence)
- Keyboard navigation: Cmd/Ctrl+1-9 to switch tabs, Cmd/Ctrl+Shift+[ / ] to cycle

## 9. Unified Editor Surface — `unified-editor`

Make the main content area behave as a single, cohesive text editor rather than a collection of separate components that merely look like one.

- **Full-surface editing**: The main textarea must fill the entire content area. Clicking anywhere in the blank space should focus and place the cursor, not just where placeholder text appears. The placeholder ("Start typing") must be fully visible and vertically centered or top-aligned.
- **Seamless cross-pill text selection**: Users must be able to click and drag across the entire document — including across pill separators — to select text, exactly as if it were a single text editor. Selection must not stop at pill boundaries.
- **Copy behavior with pill conversion**: When text is copied from a selection that spans pills, the pills should be serialized as plain-text dividers in the clipboard:
  - User pill: `------------------- USER -----------------------`
  - Agent pill: `------------------- AGENT -----------------------`
- This may require rethinking the current approach of separate `<textarea>` elements per section. Consider a single contenteditable surface, a single textarea with virtual pill rendering, or a similar architecture that naturally supports contiguous selection.

## 10. Streaming Chat Integration — `streaming`

Wire the LLM providers into the chat UI with streaming token delivery.

- Use Tauri Channels (`Channel<T>`) to stream tokens from Rust to the frontend
- Create a `send_message` Tauri command that accepts conversation context and streams the response
- Update `ThreadEditor.vue` to append tokens in real-time to the end of the document
- Add a "Stop" button to cancel in-flight generation
- Handle errors gracefully (network failures, rate limits, invalid API keys) with inline error messages
- Show a typing/thinking indicator while waiting for the first token

## 11. Provider Implementations — `provider-impls`

Implement real API integrations for the remaining LLM providers (OpenRouter is already complete from step 10).

- **Z.ai** — Implement `stream_chat` using the Zed AI SSE endpoint, handle auth
- **GitHub Copilot** — Implement OAuth device flow for token acquisition, then `stream_chat` via the Copilot chat completions API (OpenAI-compatible SSE)
- **MiniMax** — Implement `stream_chat` using the MiniMax API, handle their SSE format
- Replace hardcoded `list_models` stubs with real API calls where the provider supports dynamic model listing
- Ensure all providers handle auth errors, rate limits, and network failures gracefully through `StreamEvent::Error`

## 12. Provider Key Persistence — `provider-keys`

Persist provider API keys and OAuth tokens to disk so they survive app restarts.

- Store credentials in `~/.config/dez/provider_keys.json` (same path on both macOS and Linux)
- On startup, read the file and call `configure()` on each provider that has a saved key
- For GitHub Copilot, persist the GitHub OAuth token (and cached Copilot token + expiry); on launch, auto-exchange for a fresh Copilot token if expired
- After any key save or Copilot auth, write the updated credentials to disk immediately
- Create the directory and file if they don't exist
- File format: `{ "openrouter": { "api_key": "..." }, "zed": { "api_key": "..." }, "minimax": { "api_key": "..." }, "copilot": { "github_token": "...", "copilot_token": "...", "copilot_token_expires_at": 123 } }`
- Set restrictive file permissions (0600) to protect secrets

## 13. Local Persistence — `persistence`

Persist conversations and application state to disk so they survive app restarts.

- Store conversations as plain text files in `~/.config/dez/conversations/`, one file per conversation
- Use `--- USER ---` and `--- AGENT ---` separator strings between sections; on load, parse these to reconstruct the pill-separated section model
- Store all application settings in `~/.config/dez/settings.json` — this includes open tabs (with references to conversation files), currently selected models per tab, default models per provider, favorited models, theme, and any other preferences
- Create Rust commands: `save_conversation`, `load_conversation`, `list_conversations`, `delete_conversation`
- Auto-save on every new message
- On app launch, read `settings.json` to restore open tabs and their associated conversation files
- Generate conversation titles automatically (first user message truncated, or LLM-generated later)

## 14. Favorite Models — `favorite-models`

Allow users to star/favorite models in the model selector for quick access.

- Add a star icon next to each model in the `ModelSelector.vue` dropdown
- Clicking the star toggles the model as a favorite; persist favorites in `~/.config/dez/settings.json`
- Add a "Favorites" section at the top of the model selector dropdown that lists all starred models across providers
- Favorites section appears above the per-provider model groups
- If no models are favorited, the Favorites section is hidden

## 15. Saved Prompts — `saved-prompts`

Allow users to create, edit, and quickly insert saved prompt templates.

- Store prompts as JSON in app data directory (via Tauri FS plugin)
- Create a `PromptManager.vue` overlay/modal for CRUD operations on prompts
- Implement `/prompt` slash-command in the thread editor to open a fuzzy-searchable prompt picker
- Inserting a prompt replaces the current input or appends to it
- Each prompt has a `name`, `content`, and optional `description`

## 16. Conversation History Browser — `history`

Provide a UI to browse, search, and manage past conversations.

- Create a `HistoryPanel.vue` sidebar or modal listing all saved conversations
- Show title, date, model used, and message count
- Search/filter conversations by title or content
- Click to open a conversation in a new tab
- Delete conversations with confirmation
- Sort by most recent (default) or alphabetical

## 17. Polish & Cross-Platform — `polish`

Final pass for UX quality, performance, and platform compatibility.

- Test and fix rendering on macOS (WKWebView) and Linux (WebKitGTK)
- Add window menu bar with standard items (File, Edit, View, Help)
- Implement native Cmd/Ctrl+C/V/X/A clipboard integration
- Add app icon and metadata for packaging
- Performance audit: virtualize long message lists if needed
- Accessibility pass: keyboard navigation, ARIA labels, focus management
- Package with `tauri build` for `.dmg` (macOS) and `.AppImage` / `.deb` (Linux)
