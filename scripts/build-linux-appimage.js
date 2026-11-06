import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { machine } from 'node:os';

// Runs `tauri build --bundles appimage` (extra arguments are passed on) with
// the GStreamer paths that the AppImage bundler needs on this host.
//
// Why: `bundle.linux.appimage.bundleMediaFramework` (tauri.conf.json) makes
// the bundler run linuxdeploy-plugin-gstreamer, which copies the host's
// GStreamer plugins into the AppImage so that it can play the reply-done
// sound. That plugin looks for them only in Debian's multiarch path, then in
// /usr/lib/gstreamer-1.0, and fails when neither exists. Fedora and other
// lib64 distros keep the plugins in /usr/lib64/gstreamer-1.0 and the helpers
// (gst-plugin-scanner) in /usr/libexec/gstreamer-1.0. The plugin reads
// GSTREAMER_PLUGINS_DIR and GSTREAMER_HELPERS_DIR; values that the caller
// sets are kept.
//
// https://github.com/tauri-apps/linuxdeploy-plugin-gstreamer/blob/master/linuxdeploy-plugin-gstreamer.sh

const debianLibDir = `/usr/lib/${machine()}-linux-gnu`;
const env = { ...process.env };

function useWhenDebianPathMissing(name, debianPath, fallbackPath) {
  if (env[name] || existsSync(debianPath) || !existsSync(fallbackPath)) return;
  env[name] = fallbackPath;
  console.log(`build-linux-appimage: ${name}=${fallbackPath}`);
}

useWhenDebianPathMissing(
  'GSTREAMER_PLUGINS_DIR',
  `${debianLibDir}/gstreamer-1.0`,
  '/usr/lib64/gstreamer-1.0'
);
useWhenDebianPathMissing(
  'GSTREAMER_HELPERS_DIR',
  `${debianLibDir}/gstreamer1.0/gstreamer-1.0`,
  '/usr/libexec/gstreamer-1.0'
);

// The same plugin also needs `patchelf` on PATH. Without it, a build fails
// late, after the release compile, with only "failed to run linuxdeploy"
// (the plugin's "patchelf not found" shows only with --verbose).
if (spawnSync('patchelf', ['--version'], { stdio: 'ignore' }).error) {
  console.error(
    'build-linux-appimage: patchelf not found. The AppImage GStreamer step needs it: ' +
      'install the patchelf package (Fedora: sudo dnf install patchelf; ' +
      'Debian/Ubuntu: sudo apt install patchelf).'
  );
  process.exit(1);
}

const result = spawnSync(
  'tauri',
  ['build', '--bundles', 'appimage', ...process.argv.slice(2)],
  { stdio: 'inherit', env }
);
if (result.error) console.error('build-linux-appimage: could not run tauri:', result.error);
process.exit(result.status ?? 1);
