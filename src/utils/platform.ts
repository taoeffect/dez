// CodeMirror maps `Mod` to Meta when its `browser.mac` is true, and in a
// desktop webview that is this test (`@codemirror/view` does not export
// `browser`). Synthetic key events, key handlers, and menu accelerators must
// agree with the editor's bindings, so every macOS check uses this constant.
export const isMacPlatform = /Mac/.test(navigator.platform)
