# Packaging

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

The notification sound (`src/assets/sounds/ding.mp3`), the ffmpeg and ffprobe programs that Dez ships (`src-tauri/binaries/`), and the fonts that Dez ships for ffmpeg's text filters (`src-tauri/fonts/`) are stored with [Git LFS](https://git-lfs.com/). Their license texts (`src-tauri/binaries/NOTICE.md`, `src-tauri/fonts/*-OFL.txt`) and manifests are plain Git files. Install Git LFS and run `git lfs pull` before you build. Without it, the build stops, because a small text file is in place of each program and each font.

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
