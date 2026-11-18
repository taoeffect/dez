<p align="center">
  <img src="src-tauri/icons/128x128.png" alt="Dez app icon" width="128" height="128">
</p>

<h1 align="center">Dez - Plain text AI multimedia studio!</h1>

Talk with AI in a fully editable plaintext document. Inspired by Zed's text threads feature (no longer with us, RIP).

https://github.com/user-attachments/assets/6523d6b6-e225-4409-8d27-bb55f19e1060

# Features 🌟

- 📝 Saved prompts via `/prompt`
- 🗂️ Tabbed conversations
- 🤖 Supports OpenRouter, Z.ai, GitHub Copilot, Kimi, MiniMax, Venice, and Charm Hyper
- 🏠 Local models: add any OpenAI- or Anthropic-compatible server as a [custom provider](docs/CUSTOM_PROVIDERS.md)
- 🎨 Create and edit images, video, music, and voice overs with hundreds of models
- 🔎 Web search and URL reading with Venice models (X search with Grok)
- 🗜️ Automatic compaction of long tasks that keeps assets and jobs
- ✏️ Edit any message, including AI replies
- ⚡ Run many replies at once, across tabs
- 📚 Conversation history saved on your device
- 💾 Save as Markdown (<kbd>Cmd/Ctrl+S</kbd>)
- 📋 Copy clean Markdown (<kbd>Cmd/Ctrl+Shift+C</kbd>)
- ⌨️ Multiple cursors (<kbd>Ctrl+Shift+Up/Down</kbd>)
- 🔍 Find & replace (<kbd>Cmd/Ctrl+F</kbd>)
- 📊 Inline Markdown tables
- 🖼️ Paste or drop images; file paths never go to providers
- 🧭 Native menubar with every shortcut
- 📂 Open your data folder from Settings
- 💻 macOS and Linux

# Docs

- [Custom providers](docs/CUSTOM_PROVIDERS.md): add any OpenAI- or Anthropic-compatible server, such as llama-server, LM Studio, or Ollama
- [Packaging](docs/PACKAGING.md): build the Linux AppImage and the macOS DMG, make a tagged release, and open an unsigned macOS build

# Tech Stack

- [Tauri v2](https://v2.tauri.app/) (Rust backend)
- [Vue 3](https://vuejs.org/) with `<script setup>` SFCs
- TypeScript
- Vite

# License

AGPL-3.0. See [`LICENSE`](LICENSE) for license details.
