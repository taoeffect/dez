# Desktop builds

Linux AppImage and Apple Silicon macOS DMG builds are attached to this release. The `.minisig` file is the DMG's signature, which Dez checks when it updates itself.

## Running the macOS app

The macOS app is not signed because we are not paying Apple's ransom fee to distribute the app through Apple's signing and notarization program. Because of that, macOS may block the app after you copy it to Applications.

After copying `Dez.app` to `/Applications`, run:

```bash
xattr -cr /Applications/Dez.app
```

Then open Dez from `/Applications`. Dez needs macOS 13 or later.

You need these steps only once: after that, Dez updates itself (Dez › Check for Updates…, then **Download and Install**).
