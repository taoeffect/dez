/*
E2E UI tests: `npm run test:e2e`. Linux only. They need `tauri-driver`,
`WebKitWebDriver`, and the debug app binary (see `resolveBinary` in
tests/e2e/harness/app.ts). `npm run build` does not type-check tests/e2e;
run `npm run typecheck:e2e`.

No display server (e.g. an agent sandbox)
-----------------------------------------
`DISPLAY` and `WAYLAND_DISPLAY` can be set while no server runs:
`$XDG_RUNTIME_DIR` has no `wayland-*` socket and /tmp/.X11-unix does not
exist. Then the app window cannot open, and every spec fails only with
"Hook timed out in 120000ms" in `beforeAll`, with no display error. CI uses
`xvfb-run`, but `Xvfb` may be missing and an install needs sudo. KDE's
headless compositor needs no sudo:

  # 1. Start it as a long-lived background process. It prints nothing
  #    when ready, so do not wait for a log line.
  kwin_wayland --virtual --socket wayland-dez --width 2560 --height 1600 \
    --no-lockscreen --no-global-shortcuts

  # 2. It is ready when its socket exists (about 1 s after start).
  test -S "$XDG_RUNTIME_DIR/wayland-dez"

  # 3. Run the app or tests against it. WAYLAND_DISPLAY is the setting that
  #    matters; the other two force GTK to use Wayland (the app tries X11
  #    first, src-tauri/src/lib.rs).
  env -u DISPLAY GDK_BACKEND=wayland WAYLAND_DISPLAY=wayland-dez npm run test:e2e

- Stop the compositor when you are done.
- kwin gives its virtual screen scale 2 (`--scale 1` does not change it), so
  the command above makes a 1280x800 logical screen. The app fits its window
  to the screen: on a smaller screen the window is smaller than its 900x700
  default, and specs that need that size fail.
- Do not run the specs on GTK X11 under kwin's own Xwayland (`kwin_wayland
  --xwayland`). It sets `Xft.dpi: 192`, so WebKit zooms the page 2x and
  WebDriver pointer actions land at half the place; and KWin maximizes a
  window that fills the screen, so `window.e2e.ts` fails. For X11 use a
  rootful Xwayland with no window manager (below) or `xvfb-run`, as CI does.
- Do not use `broadwayd` (GTK's browser backend). Window sizes come out
  negative, CodeMirror throws in its height map, and CSS transitions crash
  `WebKitWebProcess`.
- To look at the UI, write a throwaway spec that calls
  `browser.saveScreenshot('/tmp/<name>.png')`, open the PNG, then delete the
  spec and the PNG. Under kwin the screenshots are real renders at 2x device
  pixels.

Menu accelerators and menu clicks (manual check)
------------------------------------------------
WebDriver keys (`browser.keys`) skip GTK, so specs test the page key
handlers, never the Linux menu accelerators or menu clicks. To check those
by hand, run rootful Xwayland on the kwin compositor above:

  WAYLAND_DISPLAY=wayland-dez Xwayland :5 -geometry 1280x800 -ac

Start the app with `env -u WAYLAND_DISPLAY DISPLAY=:5 GDK_BACKEND=x11`. Send
real keys with XTest (`libXtst`). Click menu items through AT-SPI inside
`dbus-run-session`; start `/usr/libexec/at-spi-bus-launcher
--launch-immediately` and `/usr/libexec/at-spi2-registryd` first.
*/

import { defineConfig } from "vitest/config";

// E2E specs drive the real Tauri app over WebDriver; they live outside
// `src/` and use the `*.e2e.ts` suffix so the default unit-test include
// pattern (`**/*.{test,spec}.*`) never collects them.
export default defineConfig({
  test: {
    include: ["tests/e2e/**/*.e2e.ts"],
    // Binary resolution (and the opt-in DEZ_E2E_BUILD=1 build) happens in
    // globalSetup: a cold debug tauri build takes minutes and would trip
    // hookTimeout if run inside a spec's beforeAll.
    globalSetup: ["tests/e2e/harness/globalSetup.ts"],
    // Launching the real app takes tens of seconds; unit-scale timeouts
    // would kill specs mid-launch.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    pool: "forks",
    // One app instance per tauri-driver port/HOME at a time: parallel files
    // would fight over the driver session. false forces maxWorkers to 1.
    fileParallelism: false,
  },
});
