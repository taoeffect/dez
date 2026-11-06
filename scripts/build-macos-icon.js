import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Compiles the Icon Composer document src-tauri/icons/Dez.icon into
// src-tauri/icons/Assets.car (generated, gitignored). tauri.conf.json
// `bundle.macOS.files` copies it to Contents/Resources, and
// src-tauri/Info.plist names it with CFBundleIconName.
//
// Why: macOS 26 draws a legacy .icns icon that is not a full-bleed square
// (Dez's icon.icns is a rounded tile with transparent margins) scaled down on
// a light rounded plate. It draws an icon at full size when it comes from an
// asset catalog compiled from a `.icon` document. icon.icns stays in the
// bundle as CFBundleIconFile.
//
// Tauri CLI 2.10 cannot take a `.icon` in `bundle.icon`, so the
// build:macos:* npm scripts run this before `tauri build`. Only actool from
// Xcode 26 or newer reads `.icon` documents, so this needs macOS.
//
// https://developer.apple.com/videos/play/wwdc2025/220/
// https://www.hendrik-erz.de/post/supporting-liquid-glass-icons-in-apps-without-xcode
// https://github.com/tauri-apps/tauri/pull/14671

const iconsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src-tauri', 'icons');
const outputCar = join(iconsDir, 'Assets.car');
// actool names the icon in Assets.car after the `.icon` document. The
// `--app-icon` value and CFBundleIconName in src-tauri/Info.plist must match.
const iconName = 'Dez';
// Dez ships for Apple Silicon only, so macOS 11 is the oldest system. A target
// below 26 makes actool also store flat images of the icon for older macOS.
const minimumMacOS = '11.0';

function fail(message) {
  console.error(`build-macos-icon: ${message}`);
  process.exit(1);
}

// stdin must be /dev/null ('ignore'): with a closed stdin actool fails with
// "Bad file descriptor" and can leave a broken ibtoold daemon that makes later
// runs fail too (https://github.com/tauri-apps/tauri/issues/15315).
function actool(args, output) {
  return spawnSync('xcrun', ['actool', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', output, output]
  });
}

if (process.platform !== 'darwin') {
  fail('the macOS app icon can only be compiled on macOS with Xcode 26 or newer.');
}

const versionResult = actool(['--version', '--output-format', 'human-readable-text'], 'pipe');
const version = versionResult.stdout?.match(/short-bundle-version:\s*([\d.]+)/)?.[1];

if (versionResult.error || versionResult.status !== 0 || !version) {
  fail(`could not run actool; install Xcode 26 or newer.\n${versionResult.error?.message || versionResult.stderr || ''}`);
}

if (Number.parseInt(version, 10) < 26) {
  fail(`actool ${version} cannot read .icon documents. Select Xcode 26 or newer: sudo xcode-select -s <path to Xcode.app>`);
}

const workDir = mkdtempSync(join(tmpdir(), 'dez-icon-'));
const compileResult = actool([
  join(iconsDir, `${iconName}.icon`),
  '--compile', workDir,
  '--output-format', 'human-readable-text',
  '--notices', '--warnings', '--errors',
  '--output-partial-info-plist', join(workDir, 'partial-info.plist'),
  '--app-icon', iconName,
  '--enable-on-demand-resources', 'NO',
  '--development-region', 'en',
  '--target-device', 'mac',
  '--minimum-deployment-target', minimumMacOS,
  '--platform', 'macosx'
], 'inherit');
const compiledCar = join(workDir, 'Assets.car');
const compiled = !compileResult.error && compileResult.status === 0 && existsSync(compiledCar);

if (compiled) {
  try {
    copyFileSync(compiledCar, outputCar);
  } catch (error) {
    rmSync(workDir, { recursive: true, force: true });
    fail(`could not write ${outputCar}: ${error.message}`);
  }
}

rmSync(workDir, { recursive: true, force: true });

if (!compiled) {
  fail(`actool did not compile ${iconName}.icon (its output is above). After a "Bad file descriptor" error, stop the stale daemon with \`killall ibtoold\` and build again.${compileResult.error ? `\n${compileResult.error.message}` : ''}`);
}

console.log(`build-macos-icon: wrote ${outputCar} (actool ${version})`);
