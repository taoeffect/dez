# Dez

A chat application inspired by Zed's text threads, built with Tauri v2, Vue 3, and TypeScript.

**Status: In Development**

## Planned Features

- **Tabbed conversations** — multiple concurrent chats in a single window
- **Multi-provider model selection** — Z.ai, OpenRouter, Github Copilot, and MiniMax Coding Plan
- **Saved prompts** — selectable via `/prompt` shortcut (Zed-style)
- **Inline editing** — edit any message in a thread, including agent responses
- **Text pill separators** — toggleable "User" / "Agent" labels between messages
- **Conversation history** — persisted locally with the ability to browse and delete past conversations
- **Cross-platform** — macOS and Linux

## UI

The main window contains a tab bar for conversations and buttons to access saved prompts, settings, and conversation history.

## Tech Stack

- [Tauri v2](https://v2.tauri.app/) (Rust backend)
- [Vue 3](https://vuejs.org/) with `<script setup>` SFCs
- TypeScript
- Vite

## Recommended IDE Setup

- [VS Code](https://code.visualstudio.com/) + [Vue - Official](https://marketplace.visualstudio.com/items?itemName=Vue.volar) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)
