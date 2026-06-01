import { spawnSync } from 'node:child_process';

const commands = {
  linux: {
    build: ['npm', ['run', 'build:linux:appimage']],
    otherPlatform: 'macOS Apple Silicon DMG builds must run on macOS or the tagged-release workflow.',
    releaseNote: 'This local AppImage is for the current Linux host architecture only.'
  },
  darwin: {
    build: ['npm', ['run', 'build:macos:dmg']],
    otherPlatform: 'Linux AppImage builds must run on Linux or the tagged-release workflow.',
    releaseNote: 'This local DMG is for Apple Silicon macOS only.'
  }
};

const command = commands[process.platform];

if (!command) {
  console.error('Desktop packaging is supported from Linux for AppImage and macOS for Apple Silicon DMG.');
  console.error('Use the tagged-release workflow to build all desktop artifacts.');
  process.exit(1);
}

const [executable, args] = command.build;
const result = spawnSync(executable, args, { stdio: 'inherit', shell: process.platform === 'win32' });

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

console.log(command.releaseNote);
console.log(command.otherPlatform);
console.log('Use the tagged-release workflow to build all release artifacts.');
