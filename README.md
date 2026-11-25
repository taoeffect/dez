<p align="center">
  <img src="src-tauri/icons/128x128.png" alt="Dez app icon" width="128" height="128">
</p>

<h1 align="center">Dez - Plain text AI multimedia studio!</h1>

Talk with AI in a fully editable plaintext document.

# Full Feature List 🌟

- 📝 Saved prompts via `/prompt`
- 🗂️ Tabbed conversations
- 🤖 Supports Venice, TrustedRouter, OpenRouter, APIMart, Charm Hyper, Z.ai, Anthropic Console, MiniMax, Kimi, and GitHub Copilot
- 🏠 Local models: add any OpenAI- or Anthropic-compatible server as a [custom provider](docs/CUSTOM_PROVIDERS.md)
- 🎨 Create and edit images, video, music, and voice overs with hundreds of models
- 🛠️ Scripts and mini-apps, like games and video effects
- 🧩 Everything AI needs to create beat-matched music videos with fancy font overlays built-in
- 🔒 Sandboxed: Dez won't harm your computer. (Seatbelt on macOS, Landlock on Linux)
- 🤫 Private: Dez hides your system file paths from providers
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
- 🗑️ Finds and deletes unreferenced files
- 💻 macOS and Linux

# Examples

Music video made with Dez in ~35 minutes:

https://github.com/user-attachments/assets/36c4a447-6ab3-4dc0-b2cc-27190f65ba61

Video game mini-apps:

https://github.com/user-attachments/assets/55d4c8b8-88b0-4f10-914c-bb7c982c16e5

And so much more!

# Docs

- [Custom providers](docs/CUSTOM_PROVIDERS.md): add any OpenAI- or Anthropic-compatible server, such as llama-server, LM Studio, or Ollama
- [Packaging](docs/PACKAGING.md): build the Linux AppImage and the macOS DMG, make a tagged release, and open an unsigned macOS build

https://github.com/user-attachments/assets/6980f983-bfcf-4146-9cfb-6658b37774d5

# Tech Stack

- [Tauri v2](https://v2.tauri.app/) (Rust backend)
- [Vue 3](https://vuejs.org/) with `<script setup>` SFCs
- TypeScript
- Vite

# License

AGPL-3.0. See [`LICENSE`](LICENSE) for license details.
