# Dez — Development Plan

## Progress

- [x] 1. Foundation & Window Shell (`foundation`)
- [x] 2. Chat Message UI (`chat-ui`)
- [x] 3. Inline Editing (`inline-editing`)
- [x] 4. Editor-Style Thread Redesign (`editor-thread`)
- [x] 5. LLM Provider Abstraction (`providers`)
- [x] 6. Settings & Configuration (`settings`)
- [ ] 7. Model Selector Taskbar (`model-selector`)
- [ ] 8. Tabbed Conversations (`tabs`)
- [ ] 9. Streaming Chat Integration (`streaming`)
- [ ] 10. Local Persistence (`persistence`)
- [ ] 11. Saved Prompts (`saved-prompts`)
- [ ] 12. Conversation History Browser (`history`)
- [ ] 13. Polish & Cross-Platform (`polish`)

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

## 9. Streaming Chat Integration — `streaming`

Wire the LLM providers into the chat UI with streaming token delivery.

- Use Tauri Channels (`Channel<T>`) to stream tokens from Rust to the frontend
- Create a `send_message` Tauri command that accepts conversation context and streams the response
- Update `ThreadEditor.vue` to append tokens in real-time to the end of the document
- Add a "Stop" button to cancel in-flight generation
- Handle errors gracefully (network failures, rate limits, invalid API keys) with inline error messages
- Show a typing/thinking indicator while waiting for the first token

## 10. Local Persistence — `persistence`

Persist conversations to disk so they survive app restarts.

- Choose storage format: SQLite via `tauri-plugin-sql` or JSON files via `tauri-plugin-fs`
- Design a data schema: `Conversation { id, title, model, messages[], createdAt, updatedAt }`
- Create Rust commands: `save_conversation`, `load_conversation`, `list_conversations`, `delete_conversation`
- Auto-save on every new message
- Load last-open tabs on app launch
- Generate conversation titles automatically (first user message truncated, or LLM-generated later)

## 11. Saved Prompts — `saved-prompts`

Allow users to create, edit, and quickly insert saved prompt templates.

- Store prompts as JSON in app data directory (via Tauri FS plugin)
- Create a `PromptManager.vue` overlay/modal for CRUD operations on prompts
- Implement `/prompt` slash-command in the thread editor to open a fuzzy-searchable prompt picker
- Inserting a prompt replaces the current input or appends to it
- Each prompt has a `name`, `content`, and optional `description`

## 12. Conversation History Browser — `history`

Provide a UI to browse, search, and manage past conversations.

- Create a `HistoryPanel.vue` sidebar or modal listing all saved conversations
- Show title, date, model used, and message count
- Search/filter conversations by title or content
- Click to open a conversation in a new tab
- Delete conversations with confirmation
- Sort by most recent (default) or alphabetical

## 13. Polish & Cross-Platform — `polish`

Final pass for UX quality, performance, and platform compatibility.

- Test and fix rendering on macOS (WKWebView) and Linux (WebKitGTK)
- Add window menu bar with standard items (File, Edit, View, Help)
- Implement native Cmd/Ctrl+C/V/X/A clipboard integration
- Add app icon and metadata for packaging
- Performance audit: virtualize long message lists if needed
- Accessibility pass: keyboard navigation, ARIA labels, focus management
- Package with `tauri build` for `.dmg` (macOS) and `.AppImage` / `.deb` (Linux)
