<p align="center">
  <img src="src-tauri/icons/128x128.png" alt="Dez app icon" width="128" height="128">
</p>

# Dez

Talk with AI in a fully editable plaintext document. Inspired by Zed's text threads feature (no longer with us, RIP).

<p align="center">
  <video src="https://github.com/user-attachments/assets/99a4b112-49e5-44eb-9579-00db6623d2fb" controls autoplay muted playsinline width="800"></video>
</p>

## Features

- **Saved prompts** — selectable via `/prompt` shortcut (Zed-style)
- **Tabbed conversations** — multiple concurrent chats in a single window
- **Multi-provider model selection** — OpenRouter, Z.ai, GitHub Copilot, Kimi, MiniMax, Venice, and Charm Hyper, plus your own [custom providers](#custom-providers): any OpenAI- or Anthropic-compatible server, such as llama-server, LM Studio, or Ollama
- **Web search & URL scraping** - Venice-based models can search the Internet and read URLs you give them
- **X search** - Via Grok models on Venice
- **Inline editing** — edit any message in a thread, including agent responses
- **Per-response model labels** — switch models mid-convo and remember who said what
- **Multiple simultaneous responses** — Ask different AIs the same question across multiple tabs at once
- **Conversation history** — persisted locally with the ability to browse and delete past conversations
- **Save as Markdown** - <kbd>Cmd/Ctrl+S</kbd> saves the current conversation to a Markdown file you pick
- **Copy Markdown** - <kbd>Cmd/Ctrl+Shift+C</kbd> copies the selection as plain Markdown, with no response pills and no thinking
- **Multiple cursors** - <kbd>Ctrl+Shift+Up</kbd> and <kbd>Ctrl+Shift+Down</kbd> adds cursors above and below
- **Find & replace** - <kbd>Cmd/Ctrl+F</kbd> opens a find bar with live highlights
- **Markdown tables** - Renders GFM-flavored markdown tables inline
- **Images** - paste or drop images, they're rendered inline and image-ready models can view them
- **Native menubar** - File, Edit, Conversation, View, Window, and Help menus with an item for every keyboard shortcut
- **Open Dez Folder** - a button in Settings › General opens the folder where Dez keeps its data (`~/.config/dez/`)
- **Cross-platform** — macOS and Linux

## UI

The main window contains a tab bar for conversations and buttons to access saved prompts, settings, and conversation history.

Dez opens its window at the size where you left it. On macOS and on X11 (also the AppImage, which runs through Xwayland in a Wayland session), it also opens at the place where you left it. In a Wayland session, Dez is a Wayland app: a Wayland app cannot read or set the place of its window, so the desktop picks the place.

## Notifications

When a reply finishes or fails while you are not looking at it, Dez plays a short sound and shows a system notification. You are not looking at a reply when its tab is in the background, when you use another window, or when you have been away from the computer for more than 1 minute (no keyboard, mouse, or touch input). Click the notification to bring Dez to the front and go to the tab of the reply. A reply that you stop gives no alert.

Settings › Notifications turns the sound and the notification on or off, and sets the volume of the sound. When you let go of the volume slider after a click or a drag, Dez plays the sound at the new volume. The sound and the notification are on by default.

To know if you are away, Dez asks the system for the time since your last input. On Linux, this works on KDE Plasma, on GNOME, on other Wayland desktops that support the `ext-idle-notify` protocol (such as Sway, Hyprland, niri, and COSMIC), and in X11 sessions. On other Wayland desktops, Dez cannot tell if you are away, so only a reply in a background tab or a reply while you use another window gives an alert.

On Linux, Dez plays the sound with GStreamer. The AppImage includes the GStreamer plugins. Other Linux builds, such as `npm run tauri dev`, need the GStreamer base and good plugins on the system (Debian/Ubuntu: `gstreamer1.0-plugins-base` and `gstreamer1.0-plugins-good`; Fedora: `gstreamer1-plugins-base` and `gstreamer1-plugins-good`).

## Images

Paste an image into a conversation, or drop image files on its text. Dez copies each image to `~/.config/dez/assets/images/` and puts a Markdown reference to the copy in the text: `![<full path of the copy>](id=a)`. The editor shows the image in place of the reference. Dez keeps PNG, JPEG, GIF, and WebP images as they are, and changes other image types to PNG. When the clipboard holds text and an image, a paste puts in the text.

Each image in a conversation has a short id: `a`, `b`, … `z`, `aa`, `ab`, and so on. Put the pointer on an image to see a small toolbar in its top-right corner, with the image's id and a trash button. Keep the pointer on the id or on the trash button to see what it is for. A new image gets the id after the highest id in the conversation. When you paste text with an image reference that has no id, or that has the id of a different image in the conversation, Dez gives that image a new id. Dez does not change the ids that are already in a conversation. Images from before Dez gave ids have no id.

The reference is text, so you can copy, cut, and undo it as other text. To see the reference of an image:

- Press <kbd>Backspace</kbd> (<kbd>delete</kbd> on a Mac) just after the image. Dez removes the last `)` and shows the reference. Type `)` to show the image again.
- Press <kbd>Delete</kbd> just before the image. Dez removes the first `!` and shows the reference. Type `!` to show the image again.

Dez sends the images in your messages to the model. Venice, OpenRouter, and GitHub Copilot tell Dez which of their models read images. A model that does not read images gets the text `[image]` in place of each image, and Dez shows a warning. Dez sends images to all other models; if a model cannot read them, the server's error shows. For a custom provider, you can set which models read images (`imageInput`, `modelImageInput` in [Custom providers](#custom-providers)).

To delete an image, put the pointer on it and click the trash button. Dez asks: "Are you sure you want to delete this image?" Click **Yes** or press <kbd>Enter</kbd> to delete the image file from `~/.config/dez/assets/images/` and remove the reference from the text. Click **No**, press <kbd>Esc</kbd>, or click outside the question to keep the image. You cannot undo the delete. Other references to the same file, for example a copied reference in a different conversation, then show "Image not found". An "Image not found" box has a trash button too, which removes only the reference. When a reference points to an image in a different Dez folder, the trash removes only the reference and deletes no file.

Dez deletes an image file only when you click its trash button. An image stays in `~/.config/dez/assets/images/` when you remove its reference with the keyboard or delete the conversation. A conversation refers to its images by full path, so the images do not show if you move the Dez folder to a different home folder.

## Custom providers

A custom provider is any server that speaks the OpenAI chat completions API or the Anthropic messages API. This includes local servers such as llama-server, LM Studio, Ollama, and vLLM, and hosted APIs that are compatible with one of the two.

To add one, open Settings › Providers and click **+ Add provider**. Set the name, the API format, and the base URL. An API key is optional: local servers usually need none. Add model ids if the server does not list its models. If the server's models think, check **Supports thinking** (see [Thinking](#thinking)).

You can also add custom providers by hand in `~/.config/dez/app_state.json`. **Close Dez first.** Dez saves this file while it runs, so it overwrites changes made while it is open.

```json
{
  "customProviders": [
    {
      "id": "ollama",
      "name": "Ollama",
      "baseUrl": "http://localhost:11434/v1",
      "models": [{ "id": "llama3.2", "name": "Llama 3.2" }]
    },
    {
      "id": "claude-proxy",
      "name": "Claude proxy",
      "baseUrl": "https://llm.example.com",
      "apiFormat": "anthropic",
      "apiKey": "sk-..."
    }
  ]
}
```

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | 1 to 64 letters, digits, `-`, or `_`. It must not be a built-in id (`openrouter`, `zai`, `venice`, `charm_hyper`, `minimax`, `copilot`), `__favorites__`, or a JavaScript `Object.prototype` name such as `__proto__` or `constructor`. |
| `name` | yes | The name in the model picker and in Settings. |
| `baseUrl` | yes | An `http://` or `https://` URL with no query (`?`), fragment (`#`), user name, or password. See the base URL rule below. |
| `apiFormat` | no | `openai` (default) or `anthropic`. |
| `models` | no | Models that always show, as `{ "id": "...", "name": "..." }`. The name is optional. Add `"imageInput": true` or `false` to tell Dez if the model reads images (see [Images](#images)); it has priority over `modelImageInput`. |
| `fetchModels` | no | `true` (default) also lists the models that the server reports. `false` never asks the server. |
| `modelImageInput` | no | Where the server's model list tells if a model reads images, as `{ "path": "..." }`: a dot path in each model entry, e.g. `architecture.input_modalities`. A `true` or `false` there is the answer; a list there means "reads images" when it holds `"image"`. |
| `apiKey` | no | When Dez starts, it moves the key into `~/.config/dez/provider_keys.json` and removes it from `app_state.json`. |
| `headers` | no | Extra HTTP headers for every request, as `{ "Name": "value" }`. A name may use only letters, digits, and ``!#$%&'*+-.^_`\|~``. A value must not contain a line break or a control character other than tab. Dez stores headers as plain text in `app_state.json`, so put an API key in `apiKey`, not in a header. |
| `imageRequestHeaders` | no | Extra HTTP headers only for a chat request that sends an image, with the same rules as `headers`. |
| `maxOutputTokens` | no | `max_tokens` for the Anthropic format (default 32000). |
| `cacheBreakpoints` | no | OpenAI format: `true` marks the last two user messages with Anthropic's `cache_control`, for a server that passes the marks on to models that cache only a marked prompt (such as Claude). The Anthropic format always adds the marks. |
| `promptCacheKey` | no | OpenAI format: `true` sends the conversation id as `prompt_cache_key`, so the server can send all the requests of a conversation to the machine that holds its prompt cache. |
| `settings` | no | On/off toggles for the provider settings popup in the model picker. Each toggle writes a value into the chat request. See the Venice `settings` in [`src/model/providers/builtins.ts`](src/model/providers/builtins.ts). The key `thinking` is reserved for the Thinking toggle. |
| `thinking` | no | Set it when the server's models think. See [Thinking](#thinking). Checking **Supports thinking** writes `{}`; unchecking it removes the field. |

The base URL rule:

- **OpenAI format**: the base URL includes the version, the same as in the OpenAI SDKs. Dez sends chats to `<baseUrl>/chat/completions` and gets models from `<baseUrl>/models`. Common local base URLs are `http://localhost:8080/v1` (llama-server), `http://localhost:1234/v1` (LM Studio), `http://localhost:11434/v1` (Ollama), and `http://localhost:8000/v1` (vLLM).
- **Anthropic format**: the base URL has no `/v1`, the same as in the Anthropic SDKs, e.g. `https://api.anthropic.com`. Dez sends chats to `<baseUrl>/v1/messages` and gets models from `<baseUrl>/v1/models`. If the base URL ends in `/v1`, Dez removes it.

Dez drops an entry that is not valid, and the other providers still load. The next time Dez saves `app_state.json`, the dropped entry is no longer in the file, so keep a copy of your edits until they work.

A provider shows in the model picker only while its last model check worked. If a local server was off when Dez started, start the server, then click **Check again** in Settings › Providers. The model picker also checks again when you open it, at most once a minute per provider.

### Thinking

A custom provider that has `thinking` gets the Thinking toggle (on by default) in Settings › Providers and in the model picker's settings popup. While the toggle is on, Dez shows the thinking that the server streams, and sends the thinking of earlier responses of the same model back to the server.

Dez reads thinking from these parts of a reply:

- **OpenAI format**: the `reasoning_content`, `reasoning`, `reasoning_text`, or `reasoning_details` field of a delta, or a reply that starts with `<think>` or `<thought>`.
- **Anthropic format**: `thinking` and `redacted_thinking` blocks.

`thinking` is an object with two optional fields. Each one is a JSON object that Dez merges into the chat request: objects merge key by key, and other values replace. `enabledBody: {}` sends nothing.

| Field | Sent when | Default |
|---|---|---|
| `enabledBody` | the Thinking toggle is on | OpenAI format: nothing. Anthropic format: `{ "thinking": { "type": "adaptive", "display": "summarized" } }`. |
| `disabledBody` | the Thinking toggle is off | nothing |

Some servers reject a field for thinking that their model does not support. For example, Claude Sonnet 4.5, Opus 4.5, and Haiku 4.5 reject `adaptive`. For those, set `enabledBody` by hand, e.g. `{ "thinking": { "type": "enabled", "budget_tokens": 8000 } }`, or uncheck **Supports thinking**.

## Packaging

Install dependencies before packaging:

```bash
npm ci
```

Build a Linux AppImage on Linux for the current machine architecture:

```bash
npm run build:linux:appimage
```

The AppImage is written under `src-tauri/target/release/bundle/appimage/`. A local Linux build is native to the host machine, so run it on x86_64 Linux for an x86_64 AppImage or on ARM64 Linux for an ARM64 AppImage.

The AppImage includes the GStreamer plugins of the build machine, so that the notification sound plays. The build needs `patchelf` (Debian/Ubuntu: `sudo apt install patchelf`; Fedora: `sudo dnf install patchelf`) and the GStreamer base and good plugins.

The notification sound (`src/assets/sounds/ding.mp3`) is stored with [Git LFS](https://git-lfs.com/). Install Git LFS and run `git lfs pull` before you build. Without it, the build has a small text file in place of the sound, and the sound does not play.

Build an Apple Silicon macOS DMG on macOS:

```bash
npm run build:macos:dmg
```

The DMG is written under `src-tauri/target/aarch64-apple-darwin/release/bundle/dmg/`. macOS packaging requires macOS and Xcode tooling; it is not supported as a Linux cross-compilation target.

macOS builds need Xcode 26 or newer (`xcrun actool --version`). `build:macos:dmg` and `build:macos:app` first run `scripts/build-macos-icon.js`, which compiles the app icon `src-tauri/icons/Dez.icon` into `src-tauri/icons/Assets.car`. A bare `tauri build` does not compile it, and fails when that file is missing. If the default Xcode is older, select a newer one with `sudo xcode-select -s <path to Xcode.app>`.

To run the native build for the current platform only:

```bash
npm run build:desktop
```

## Tagged releases

First set the version in the npm, Tauri, and Cargo files, and commit them. Then push a version tag on that commit to start the desktop release workflow:

```bash
npm run bump-version -- 0.1.0
git commit -m "v0.1.0" package.json package-lock.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock
git tag v0.1.0
git push origin HEAD v0.1.0
```

The workflow first checks that the version files hold the tag's version (`npm run bump-version -- --check v0.1.0` runs the same check on your machine). The bundles get their names from `src-tauri/tauri.conf.json`, and the app shows the `package.json` version in About and in the update check, so on a mismatch the workflow stops before any build and makes no release. Then delete the tag (`git tag -d v0.1.0 && git push origin :refs/tags/v0.1.0`), bump and commit, and tag again.

When the check passes, the workflow builds Linux x86_64 and Linux ARM64 AppImages on Ubuntu, builds the Apple Silicon DMG on macOS, writes the release notes, creates the GitHub Release for the tag if needed, and attaches all release assets. Linux downloads are labeled by architecture, for example `Dez_0.1.0_linux_x86_64.AppImage` and `Dez_0.1.0_linux_arm64.AppImage`; ARM users should choose the `arm64` AppImage. The macOS download is `Dez_0.1.0_aarch64.dmg`.

### Release notes

The release notes start with the text of `.github/release-notes-template.md`. Then an AI model writes a `## Changes` part from the commit messages since the previous release, with **NEW**, **ENHANCEMENT**, and **FIXES** groups, and the last line names the model. If the release has no new commits, or the model finds no change that needs a note, the notes are the template text only. The workflow reads the model settings and the API key from the GitHub environment `Default` (Settings › Environments):

- Variable `REVIEW_MODEL`: the model id, for example `glm-5.3`.
- Variable `REVIEW_PROVIDER`: the API endpoint. Now the only value is `zai-coding-plan` (the Z.ai coding plan).
- Secret `ZAI_API_KEY`: the Z.ai API key. The repository also has a repository secret with this name, so the environment does not keep the key from other jobs. Only the "Write release notes" step uses it, and it gets the `Default` value: an environment secret wins over a repository secret with the same name.

If the release notes job fails, the workflow makes no release. Click **Re-run failed jobs** to try again; the builds do not run again.

A release that already exists keeps its notes, because you may have edited them. Then the workflow does not ask the AI model for notes; it only attaches the assets. To write new notes for a release, run the script on your machine with `ZAI_API_KEY` set in your shell. The script needs `gh` and a clone with all tags:

```bash
REVIEW_MODEL=glm-5.3 REVIEW_PROVIDER=zai-coding-plan \
  node scripts/release-notes.js v0.1.0 --out notes.md
gh release edit v0.1.0 --notes-file notes.md
```

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
