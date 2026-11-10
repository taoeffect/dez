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

## Checking the DMG

The `.minisig` is a [minisign](https://jedisct1.github.io/minisign/) signature made with this public key: `RWS6gAnb0vnjQ7T83fKgSY5FBFm1yKek6p7vW4Qu31q5PRfZO8EUCMH3`. To check the DMG yourself, download both files into the same folder and run (with this release's version in place of `X.Y.Z`):

```bash
minisign -Vm Dez_X.Y.Z_aarch64.dmg -P RWS6gAnb0vnjQ7T83fKgSY5FBFm1yKek6p7vW4Qu31q5PRfZO8EUCMH3
```
