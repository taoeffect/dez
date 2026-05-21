<p align="center">
  <img src="src-tauri/icons/128x128.png" alt="Dez app icon" width="128" height="128">
</p>

# Dez

A [Tauri](https://v2.tauri.app/)-based chat application inspired by Zed's text threads.

<p align="center">
  <video src="https://github.com/user-attachments/assets/99a4b112-49e5-44eb-9579-00db6623d2fb" controls autoplay muted playsinline width="800"></video>
</p>

## Features

- **Tabbed conversations** — multiple concurrent chats in a single window
- **Multi-provider model selection** — OpenRouter, Z.ai, GitHub Copilot, MiniMax, Venice, and Charm Hyper
- **Saved prompts** — selectable via `/prompt` shortcut (Zed-style)
- **Inline editing** — edit any message in a thread, including agent responses
- **Text pill separators** — toggleable "User" / "Agent" labels between messages
- **Conversation history** — persisted locally with the ability to browse and delete past conversations
- **Multiple cursors** - <kbd>Ctrl+Shift+Up</kbd> and <kbd>Ctrl+Shift+Down</kbd> adds cursors above and below
- **Cross-platform** — macOS and Linux

## UI

The main window contains a tab bar for conversations and buttons to access saved prompts, settings, and conversation history.

## Packaging

Install dependencies before packaging:

```bash
npm ci
```

Build a Linux AppImage on Linux:

```bash
npm run build:linux:appimage
```

The AppImage is written under `src-tauri/target/release/bundle/appimage/`.

Build an Apple Silicon macOS DMG on macOS:

```bash
npm run build:macos:dmg
```

The DMG is written under `src-tauri/target/aarch64-apple-darwin/release/bundle/dmg/`. macOS packaging requires macOS and Xcode tooling; it is not supported as a Linux cross-compilation target.

To run the native build for the current platform only:

```bash
npm run build:desktop
```

## Tagged releases

Pushing a version tag starts the desktop release workflow:

```bash
git tag v0.1.0
git push origin v0.1.0
```

The workflow builds the Linux AppImage on Ubuntu, builds the Apple Silicon DMG on macOS, creates the GitHub Release for the tag if needed, and attaches both files as downloadable release assets. Every release tag should have both artifacts.

## macOS unsigned build note

The macOS DMG is currently unsigned and not notarized. On Apple Silicon Macs, macOS may show "Dez is damaged and can't be opened" or block the app as coming from an unidentified developer.

If that happens, remove the quarantine attribute from the downloaded DMG before opening it. Adjust the filename to match the downloaded artifact:

```bash
xattr -d com.apple.quarantine ~/Downloads/dez_0.1.0_aarch64.dmg
```

If you already copied the app into Applications, run:

```bash
xattr -cr /Applications/Dez.app
```

If macOS reports a permission error, run:

```bash
sudo xattr -cr /Applications/Dez.app
```

Developer ID signing and notarization can be added later to avoid this quarantine workaround for downloaded builds.

## Tech Stack

- [Tauri v2](https://v2.tauri.app/) (Rust backend)
- [Vue 3](https://vuejs.org/) with `<script setup>` SFCs
- TypeScript
- Vite

## License

AGPL-3.0. See [`LICENSE`](LICENSE) for license details.
