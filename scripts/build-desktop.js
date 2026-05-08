import { spawnSync } from 'node:child_process';

const commands = {
  linux: {
    build: ['npm', ['run', 'build:linux:appimage']],
    otherPlatform: 'macOS Apple Silicon DMG builds must run on macOS or the tagged-release workflow.'
  },
  darwin: {
    build: ['npm', ['run', 'build:macos:dmg']],
    otherPlatform: 'Linux AppImage builds must run on Linux or the tagged-release workflow.'
  },
  win32: {
    build: ['npm', ['run', 'build:win']],
    otherPlatform: 'Linux AppImage builds must run on Linux and macOS DMG builds must run on macOS. Use the tagged-release workflow to build all desktop artifacts.'
  }
};

const command = commands[process.platform];

if (!command) {
  console.error('Desktop packaging is supported from Linux for AppImage, macOS for Apple Silicon DMG, and Windows for MSI.');
  console.error('Use the tagged-release workflow to build all desktop artifacts.');
  process.exit(1);
}

const [executable, args] = command.build;
const result = spawnSync(executable, args, { stdio: 'inherit', shell: process.platform === 'win32' });

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

console.log(command.otherPlatform);
console.log('Use the tagged-release workflow to build both desktop artifacts for a release.');