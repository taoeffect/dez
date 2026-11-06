#!/usr/bin/env node

import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const USAGE = `Bump the app version across npm, Tauri, and Cargo files, or check it.

Usage:
  npm run bump-version -- <version>
  npm run bump-version -- --check <version>
  node scripts/bump-version.js [--check] <version>

--check changes no file. It fails when a file holds another version.
The release workflow runs it with the pushed tag.

Example:
  npm run bump-version -- 0.6.1
  node scripts/bump-version.js --check v0.6.1`;

const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

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
// versions found in it (undefined where a file has no version).
// `texts` maps every path of VERSION_FILES to the file content.
export function versionMismatches(version, texts) {
  return Object.entries(VERSION_FILES)
    .map(([path, file]) => ({ path, found: file.read(texts[path]) }))
    .filter(({ found }) => found.some(value => value !== version));
}

// The new content of every file that a bump to `version` changes.
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

// The `--check` flag, which may come before or after the version, and the
// version without a leading `v`. Throws unless the arguments are exactly one
// valid version plus the optional flag, so a misplaced flag never writes.
export function parseArgs(args) {
  const check = args.includes('--check');
  const rest = args.filter(arg => arg !== '--check');
  if (rest.length !== 1) {
    throw new Error(`Expected one version, got: ${rest.join(' ') || '(none)'}`);
  }
  const version = rest[0].replace(/^v/i, '');
  if (!VERSION_PATTERN.test(version)) {
    throw new Error(`Invalid version: ${rest[0]}`);
  }
  return { check, version };
}

function main(args) {
  if (args.length === 0) {
    console.log(USAGE);
    return;
  }

  let check, version;
  try {
    ({ check, version } = parseArgs(args));
  } catch (error) {
    console.error(`${error.message}\n\n${USAGE}`);
    process.exit(1);
  }

  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  const texts = Object.fromEntries(
    Object.keys(VERSION_FILES).map(path => [path, readFileSync(join(repoRoot, path), 'utf8')])
  );

  if (check) {
    const mismatches = versionMismatches(version, texts);
    if (mismatches.length === 0) {
      console.log(`All version files hold ${version}.`);
      return;
    }
    const lines = mismatches.map(({ path, found }) =>
      `- ${path}: ${found.map(value => value ?? 'no version').join(', ')}`
    );
    console.error(`These files do not hold version ${version}:
${lines.join('\n')}
Run "npm run bump-version -- ${version}", commit the files, and tag that commit.`);
    process.exit(1);
  }

  let changed;
  try {
    changed = bumpedFiles(version, texts);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }

  const paths = Object.keys(changed);
  if (paths.length === 0) {
    console.log(`Version already ${version}.`);
    return;
  }
  for (const path of paths) {
    writeFileSync(join(repoRoot, path), changed[path]);
  }
  console.log(`Bumped version to ${version}:\n${paths.map(path => `- ${path}`).join('\n')}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main(process.argv.slice(2));
}
