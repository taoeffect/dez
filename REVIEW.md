# Code Review

**Base**: `master`
**Head**: `macos-build`
**Date**: 2026-05-05

---

## 1. 🔴 Release workflow cannot install dependencies with the committed lockfile

- [x] Addressed
- [ ] Dismissed

The release workflow uses `npm ci` in both build jobs (`.github/workflows/release-desktop.yml:39-40` and `.github/workflows/release-desktop.yml:74-75`), but the lockfile was not updated for the current `package.json`. The changed `package.json:9-12` adds packaging scripts that call `tauri`, and the existing `package-lock.json` root package still records `@tauri-apps/cli` as `^2` instead of the committed `=2` spec. `npm ci` requires `package.json` and `package-lock.json` to be in sync, so tagged releases will fail before either desktop artifact is built.

Update and commit the lockfile after the script/package metadata changes:

```bash
npm install --package-lock-only
```

Then rerun `npm ci` locally to verify the same command used by the workflow succeeds.

## 2. 🟡 macOS job uploads the wrong DMG path for native arm64 runners

- [ ] Addressed
- [x] Dismissed

The macOS job runs on `macos-latest` (`.github/workflows/release-desktop.yml:52-54`), which is already an Apple Silicon runner. For native Tauri builds, the output bundle is normally written under `src-tauri/target/release/bundle/dmg/`, while the workflow uploads only `src-tauri/target/aarch64-apple-darwin/release/bundle/dmg/*.dmg` (`.github/workflows/release-desktop.yml:80-85`). If Tauri treats the build as a native host build despite the explicit target, `actions/upload-artifact` will fail with `if-no-files-found: error` after a successful DMG build.

Make the workflow robust by accepting the native path, or avoid the custom target path by building natively on the arm64 runner:

```yaml
      - name: Build unsigned Apple Silicon DMG
        run: npm run build:macos:dmg

      - name: Upload DMG artifact
        uses: actions/upload-artifact@v4
        with:
          name: dez-macos-aarch64-dmg
          path: |
            src-tauri/target/release/bundle/dmg/*.dmg
            src-tauri/target/aarch64-apple-darwin/release/bundle/dmg/*.dmg
          if-no-files-found: error
```

Alternatively, change `build:macos:dmg` to a native `tauri build --bundles dmg` command and keep the upload path at `src-tauri/target/release/bundle/dmg/*.dmg`.

## 3. 🟡 Linux release job is missing required Tauri system dependencies

- [x] Addressed
- [ ] Dismissed

The Linux job installs WebKit/AppIndicator/SVG dependencies and `patchelf` (`.github/workflows/release-desktop.yml:29-37`), but it omits required Tauri Linux build packages such as `libxdo-dev` and `libssl-dev`. This project uses Tauri and `reqwest` (`src-tauri/Cargo.toml:20-27`), so the Ubuntu AppImage build can fail during Rust dependency compilation or Tauri linking on a clean runner.

Install the full Tauri Linux prerequisite set in the workflow:

```yaml
      - name: Install Tauri Linux dependencies
        run: |
          sudo apt-get update
          sudo apt-get install -y \
            build-essential \
            file \
            libwebkit2gtk-4.1-dev \
            libgtk-3-dev \
            libxdo-dev \
            libssl-dev \
            libayatana-appindicator3-dev \
            librsvg2-dev \
            patchelf
```
