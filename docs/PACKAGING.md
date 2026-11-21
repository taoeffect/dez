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

The notification sound (`src/assets/sounds/ding.mp3`) and the fonts that Dez ships for ffmpeg's text filters (`src-tauri/fonts/`) are stored with [Git LFS](https://git-lfs.com/). Install Git LFS and run `git lfs pull` before you build. Without it, the build stops, because a small text file is in place of each font.

The programs that Dez ships (ffmpeg, ffprobe, and Deno) are not in the repository. `node scripts/fetch-programs.js` downloads the programs of your machine into `src-tauri/binaries/` from the URLs in `src-tauri/binaries/manifest.json`. It takes a file only when the file has the size and the SHA-256 that the manifest names. `npm run tauri` and the build commands on this page run the script first; it downloads nothing when the programs are there. A build with `cargo` alone does not run it: when a program is missing, the build stops and names the command to run. For another build target, add `--target <target triple>`.

The license texts (`NOTICE.md` and `LICENSES.txt` in `src-tauri/binaries/` and in `src-tauri/binaries/deno/`, `src-tauri/fonts/*-OFL.txt`) and the manifests are plain Git files.

Build an Apple Silicon macOS DMG on macOS:

```bash
npm run build:macos:dmg
```

The DMG is written under `src-tauri/target/aarch64-apple-darwin/release/bundle/dmg/`. macOS packaging requires macOS and Xcode tooling; it is not supported as a Linux cross-compilation target.

macOS builds need Xcode 26 or newer (`xcrun actool --version`). `build:macos:dmg` and `build:macos:app` first run `scripts/build-macos-icon.js`, which compiles the app icon `src-tauri/icons/Dez.icon` into `src-tauri/icons/Assets.car`. A bare `tauri build` does not compile it, and fails when that file is missing. If the default Xcode is older, select a newer one with `sudo xcode-select -s <path to Xcode.app>`.

The release workflow signs the macOS build ad hoc (`APPLE_SIGNING_IDENTITY=-`). Tauri then signs each program in the app again (ffmpeg, ffprobe, and Deno too), with the hardened runtime and the entitlements of `src-tauri/Entitlements.plist`. Deno compiles JavaScript to machine code while it runs, which the hardened runtime allows only with `com.apple.security.cs.allow-jit`. Without it, Deno stops at its start with `Fatal process out of memory: Failed to reserve virtual memory for CodeRange`. A build with no signing identity keeps the signature of each program as it came. To build as the workflow does, run `APPLE_SIGNING_IDENTITY=- npm run build:macos:dmg`.

To run the native build for the current platform only:

```bash
npm run build:desktop
```

## What Dez needs to run

- Linux: WebKitGTK 2.42 or newer, to build Dez and to run it. Dez calls functions of WebKitGTK 2.42 to set the guards of the app frames (`src-tauri/src/app_frames.rs`). The AppImage includes the WebKitGTK of the build machine, so the build machine must have 2.42 or newer. A build that is not an AppImage uses the WebKitGTK of the system.
- Linux: Landlock, a part of the kernel since Linux 5.13, keeps ffmpeg, ffprobe, and Deno in the Dez folders (`src-tauri/src/confinement.rs`). It must be on: `landlock` is in `/sys/kernel/security/lsm`. Without Landlock, Dez does not run Deno (`js_eval` and script apps give the model an error), and ffmpeg and ffprobe run with only the argument checks of Dez as their guard. Before Linux 6.12, a program that Dez runs can also send a signal to the other programs of the user.
- macOS: the page of an app (a shown app, or a run of a UI app) loads only on macOS 13.3 or newer. Its guard turns off a WebKit feature with an API that an older macOS does not have. The rule of the bundled programs is Seatbelt (`/usr/bin/sandbox-exec`), which is a part of macOS.

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
