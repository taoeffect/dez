#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const USAGE = `Release a version of Dez, or check or bump its version files.

Usage:
  npm run bump-version -- <version>
  npm run bump-version -- --check <version>
  npm run bump-version -- --files-only <version>
  node scripts/bump-version-and-release.js [--check | --files-only] <version>

With a version alone, it releases that version:
  1. Checks that the version files have no uncommitted change other than
     a version bump, and with "git ls-remote" that your SSH keys can
     push. If a check fails, it stops and changes nothing.
  2. Bumps the version in the npm, Tauri, and Cargo files.
  3. Signs the version with minisign and ~/.minisign/dez-tag-key.key.
  4. Commits the version files, the signed version, and its signature.
  5. Tags the commit v<version>, and pushes the commit and the tag. The
     pushed tag starts the release workflow.

--check changes no file. It fails when a version file or the signed
version holds another version. The release workflow runs it with the
pushed tag.

--files-only bumps the version files and does nothing else: no signature,
no commit, no tag, no push. Use it for test builds.

The version may start with "v". The tag always starts with one "v".

Example:
  npm run bump-version -- 0.6.1
  node scripts/bump-version-and-release.js --check v0.6.1`;

const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

// The release message and its signature, which a release commit holds. The
// message is the version alone, with no `v` and no newline. The developer
// signs it with the commit key, and that secret key is only on the
// developer's machine: CI never gets it. So nobody can authorize a release
// of Dez with control of GitHub alone.
export const MESSAGE_PATH = 'src-tauri/updater/release-version.txt';
export const SIGNATURE_PATH = `${MESSAGE_PATH}.minisig`;

// The public key of the commit key, which the signature of every release
// must verify against.
const COMMIT_PUBLIC_KEY_PATH = 'src-tauri/updater/dez-commit-key.pub';

// The secret key of the commit key, at minisign's standard place for keys.
// The file keeps the earlier name of the key, "tag key".
const COMMIT_SECRET_KEY_PATH = join(homedir(), '.minisign', 'dez-tag-key.key');

// The remote that gets the release commit and the tag.
const PUSH_REMOTE = 'origin';

// A JSON file whose version fields are on the objects that `targets` returns.
function jsonVersions(targets) {
  return {
    read: text => targets(JSON.parse(text)).map(target => target.version),
    write(text, version) {
      const data = JSON.parse(text);
      for (const target of targets(data)) {
        target.version = version;
      }
      return `${JSON.stringify(data, null, 2)}\n`;
    }
  };
}

// A text file whose version is the second group of `pattern`.
function textVersion(pattern) {
  return {
    read: text => [text.match(pattern)?.[2]],
    write(text, version) {
      if (!pattern.test(text)) {
        throw new Error('no version line found');
      }
      return text.replace(pattern, `$1${version}$3`);
    }
  };
}

// Every file that holds the app version, by repo-relative path. Tauri names
// the bundles (the macOS DMG too) with the tauri.conf.json version, and the
// About dialog and the update check use the package.json version
// (__APP_VERSION__), so a release tag must match all of them.
export const VERSION_FILES = {
  'package.json': jsonVersions(data => [data]),
  'package-lock.json': jsonVersions(data => [data, data.packages?.['']].filter(Boolean)),
  'src-tauri/tauri.conf.json': jsonVersions(data => [data]),
  'src-tauri/Cargo.toml': textVersion(/(^\[package\][\s\S]*?^version = ")([^"]+)(")/m),
  'src-tauri/Cargo.lock': textVersion(/(^\[\[package\]\]\nname = "dez"\nversion = ")([^"]+)(")/m)
};

// The files that hold a version other than `version`, each with the
// versions found in it (undefined where a file has no version). `texts`
// maps every path of VERSION_FILES to the file content, and MESSAGE_PATH to
// the message (undefined when the file does not exist). The message must be
// the version exactly, because its signature covers every byte of it.
export function versionMismatches(version, texts) {
  return [
    ...Object.entries(VERSION_FILES).map(([path, file]) => ({ path, found: file.read(texts[path]) })),
    { path: MESSAGE_PATH, found: [texts[MESSAGE_PATH]] }
  ].filter(({ found }) => found.some(value => value !== version));
}

// The new content of every version file that a bump to `version` changes.
// Throws before anything is written when a file cannot be updated.
export function bumpedFiles(version, texts) {
  const changed = {};
  for (const [path, file] of Object.entries(VERSION_FILES)) {
    let updated;
    try {
      updated = file.write(texts[path], version);
    } catch (error) {
      throw new Error(`Could not update ${path}: ${error.message}`);
    }
    if (updated !== texts[path]) {
      changed[path] = updated;
    }
  }
  return changed;
}

const MODE_FLAGS = { '--check': 'check', '--files-only': 'files-only' };

// The mode (`release` unless a flag names another one) and the version
// without a leading `v`. A flag may come before or after the version.
// Throws unless the arguments are exactly one valid version plus at most one
// flag, so a mistyped flag never writes and never releases.
export function parseArgs(args) {
  const flags = args.filter(arg => Object.hasOwn(MODE_FLAGS, arg));
  const rest = args.filter(arg => !Object.hasOwn(MODE_FLAGS, arg));
  if (flags.length > 1) {
    throw new Error(`Expected at most one flag, got: ${flags.join(' ')}`);
  }
  if (rest.length !== 1) {
    throw new Error(`Expected one version, got: ${rest.join(' ') || '(none)'}`);
  }
  const version = rest[0].replace(/^v/i, '');
  if (!VERSION_PATTERN.test(version)) {
    throw new Error(`Invalid version: ${rest[0]}`);
  }
  return { mode: MODE_FLAGS[flags[0]] ?? 'release', version };
}

// The content of every version file, and of the message when it exists.
function readTexts() {
  const read = path => readFileSync(join(repoRoot, path), 'utf8');
  const texts = Object.fromEntries(Object.keys(VERSION_FILES).map(path => [path, read(path)]));
  if (existsSync(join(repoRoot, MESSAGE_PATH))) {
    texts[MESSAGE_PATH] = read(MESSAGE_PATH);
  }
  return texts;
}

// `--check`: throws unless the version files and the message hold `version`.
function check(version) {
  const mismatches = versionMismatches(version, readTexts());
  if (mismatches.length === 0) {
    console.log(`The version files and ${MESSAGE_PATH} hold ${version}.`);
    return;
  }
  // JSON.stringify shows a newline or a space in a wrong message.
  const lines = mismatches.map(({ path, found }) =>
    `- ${path}: ${found.map(value => value === undefined ? 'no version' : JSON.stringify(value)).join(', ')}`
  );
  throw new Error(`These files do not hold version ${version}:
${lines.join('\n')}
Only "npm run bump-version -- ${version}" makes a commit that can be released:
it bumps the files, signs the version, commits, tags, and pushes.`);
}

// Writes `version` into the version files and says which ones changed.
function bumpFiles(version) {
  const changed = bumpedFiles(version, readTexts());
  const paths = Object.keys(changed);
  for (const path of paths) {
    writeFileSync(join(repoRoot, path), changed[path]);
  }
  console.log(paths.length === 0
    ? `The version files already hold ${version}.`
    : `Bumped version to ${version}:\n${paths.map(path => `- ${path}`).join('\n')}`);
}

// Runs a command in the repo root and throws when it fails. The command
// gets the terminal, so ssh, minisign, and git can ask for a passphrase
// there and show their own errors. With `capture`, returns its stdout.
// No output limit: a capture can be a whole version file, and
// package-lock.json can grow past spawnSync's 1 MiB default.
function run(command, args, { capture = false } = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: Infinity,
    stdio: ['inherit', capture ? 'pipe' : 'inherit', 'inherit']
  });
  if (result.error) {
    throw new Error(`Could not run ${command}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`"${command} ${args.join(' ')}" failed.`);
  }
  return result.stdout;
}

// Throws unless the push at the end of a release can work: the SSH keys
// reach the remote, and the tag is new there and here.
//
// It asks with `git ls-remote` and never with `git push`: a push that works
// changes the remote, and a pushed tag starts the release workflow. It asks
// the push URL, which can differ from the fetch URL that `git ls-remote
// origin` would use (remote.origin.pushurl, url.<base>.pushInsteadOf).
// It does not turn prompts off (ssh's BatchMode), so that it uses the keys
// the same way as the push: a key with a passphrase can push too.
//
// The check has a limit: the remote answers every key that may read. On a
// public GitHub repo that is every account's key, so the push can still be
// refused; release() then says what is left on this machine.
function checkPush(tag) {
  let remoteTag;
  try {
    const url = run('git', ['remote', 'get-url', '--push', PUSH_REMOTE], { capture: true }).trim();
    remoteTag = run('git', ['ls-remote', url, `refs/tags/${tag}`], { capture: true }).trim();
  } catch (error) {
    throw new Error(`${error.message}\nYour SSH keys are not able to push to "${PUSH_REMOTE}".`);
  }
  if (remoteTag) {
    throw new Error(`The tag ${tag} already exists on "${PUSH_REMOTE}".`);
  }
  const localTag = spawnSync('git', ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}`], {
    cwd: repoRoot,
    stdio: 'ignore'
  });
  if (localTag.status === 0) {
    throw new Error(`The tag ${tag} already exists.`);
  }
}

// Throws when a version file holds an uncommitted change other than its
// version. The release commit takes each version file whole, so such a
// change (lockfile drift from `npm install` or a cargo build) would go into
// the release with no word about it. Both sides get the same bump, so a
// second run after a failed signature, when the files already hold the new
// version, still passes.
function checkVersionFilesMatchHead(version) {
  const paths = Object.keys(VERSION_FILES);
  const head = Object.fromEntries(paths.map(path =>
    [path, run('git', ['cat-file', 'blob', `HEAD:${path}`], { capture: true })]));
  const here = readTexts();
  const fromHead = { ...head, ...bumpedFiles(version, head) };
  const fromHere = { ...here, ...bumpedFiles(version, here) };
  const changed = paths.filter(path => fromHead[path] !== fromHere[path]);
  if (changed.length > 0) {
    throw new Error(`These files hold changes other than the version. Commit or stash them first:
${changed.map(path => `- ${path}`).join('\n')}`);
  }
}

// Writes the message and signs it with the commit key. minisign asks for
// the key's password, if it has one, on the terminal.
function signVersion(version) {
  writeFileSync(join(repoRoot, MESSAGE_PATH), version);
  run('minisign', ['-S', '-s', COMMIT_SECRET_KEY_PATH, '-m', MESSAGE_PATH, '-x', SIGNATURE_PATH]);
  // A signature that the committed public key does not verify must stop
  // here: no installed Dez would accept that release. -H refuses a legacy
  // (not prehashed) signature, which Dez refuses too.
  try {
    run('minisign', ['-V', '-H', '-q', '-p', COMMIT_PUBLIC_KEY_PATH, '-m', MESSAGE_PATH, '-x', SIGNATURE_PATH]);
  } catch (error) {
    throw new Error(`${error.message}\nThe new signature does not verify against ${COMMIT_PUBLIC_KEY_PATH}: ${COMMIT_SECRET_KEY_PATH} is not the commit key of Dez.`);
  }
}

// Releases `version` (the steps are in USAGE). When a step fails, the error
// ends with `state`: what the steps before it left behind, and how to go on.
function release(version) {
  const tag = `v${version}`;
  const files = [...Object.keys(VERSION_FILES), MESSAGE_PATH, SIGNATURE_PATH];
  // --atomic: when the remote refuses the branch (it has commits that this
  // machine lacks), it must not take the tag either, because the tag alone
  // starts the release workflow.
  const push = ['push', '--atomic', PUSH_REMOTE, 'HEAD', `refs/tags/${tag}`];
  let state = 'Nothing was changed.';
  try {
    checkVersionFilesMatchHead(version);
    checkPush(tag);

    state = `Nothing was committed, but the version files, ${MESSAGE_PATH}, and its signature can hold changes.
Fix the problem and run this command again.`;
    bumpFiles(version);
    signVersion(version);
    // `git add` because the message and the signature are new files in the
    // first release. The paths after `git commit` keep every other staged
    // change out of the release commit, and checkVersionFilesMatchHead()
    // keeps out other changes in the version files.
    run('git', ['add', '--', ...files]);
    run('git', ['commit', '-m', tag, '--', ...files]);

    state = `The release commit is only on this machine, and it has no tag. To finish:
  git tag ${tag}
  git ${push.join(' ')}`;
    run('git', ['tag', tag]);

    state = `The release commit and the tag ${tag} are only on this machine. To push them:
  git ${push.join(' ')}`;
    run('git', push);
  } catch (error) {
    throw new Error(`${error.message}\n${state}`);
  }
  console.log(`Released ${tag}: "${PUSH_REMOTE}" has the commit and the tag, and the tag starts the release workflow.`);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function main(args) {
  if (args.length === 0) {
    console.log(USAGE);
    return;
  }

  let mode, version;
  try {
    ({ mode, version } = parseArgs(args));
  } catch (error) {
    fail(`${error.message}\n\n${USAGE}`);
  }

  try {
    if (mode === 'check') {
      check(version);
    } else if (mode === 'files-only') {
      bumpFiles(version);
    } else {
      release(version);
    }
  } catch (error) {
    fail(error.message);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main(process.argv.slice(2));
}
