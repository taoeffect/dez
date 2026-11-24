#!/usr/bin/env node

import { chmodSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  BINARIES_DIR,
  LIBS_DIR,
  LIBS_MANIFEST_NAME,
  MANIFEST_NAME,
  NATIVE_MODE,
  PROGRAM_MODE,
  checkPin,
  downloadArchiveMember,
  downloadPinned,
  hostTriple,
  isPinnedFile,
  tgzMember,
  zipMember
} from './bundled-programs.js';

// Gets the programs that Dez ships (`bundle.externalBin` of
// tauri.conf.json) for one build target: downloads each one from the URL
// that src-tauri/binaries/manifest.json pins for it into src-tauri/binaries/,
// and takes it only when it has the size and the SHA-256 of its pin. The
// native files of the shipped libraries (src-tauri/libs/manifest.json) come
// the same way, into their library folders. A file that is there and
// matches its pin is not downloaded again, so a second run uses no network.
//
// Why: the programs and the native files are not in Git
// (src-tauri/.gitignore), so a new clone has none. `npm run tauri` and the
// `build:*` scripts (package.json) run this script first. src-tauri/build.rs
// checks the same pins in every build, but it downloads nothing: a bare
// `cargo` build of a clone with no programs stops with a text that names
// this script.
//
// The script uses only Node built-ins, so it runs before `npm ci`.

const CONFIG_NAME = 'src-tauri/tauri.conf.json';

const USAGE = `Download the programs that Dez ships, and the native files of its libraries,
for one build target into src-tauri/binaries/ and src-tauri/libs/.

Usage:
  node scripts/fetch-programs.js [--target <target triple>]

Without --target, the script takes the target of this computer. It checks
each file against the size and the SHA-256 that ${MANIFEST_NAME}
or ${LIBS_MANIFEST_NAME} names, and downloads only a file that is missing
or is another file.

Example:
  node scripts/fetch-programs.js --target x86_64-unknown-linux-gnu`;

// The arguments: none, `--target <target triple>`, or a call for the usage
// text. Throws for anything else.
export function parseArgs(args) {
  if (args.length === 0) return {};
  if (args.length === 1 && ['-h', '--help'].includes(args[0])) return { help: true };
  if (args.length === 2 && args[0] === '--target' && args[1] !== '') return { target: args[1] };
  throw new Error(`Expected no argument or --target <target triple>, got: ${args.join(' ')}`);
}

// The names of the programs that Dez ships, from the Tauri config. The rule
// is the one of `bundled_tools` in src-tauri/build.rs: each entry of
// `bundle.externalBin` is `binaries/<name>`.
export function programNames(config) {
  const entries = config?.bundle?.externalBin;
  if (!Array.isArray(entries)) {
    throw new Error(`${CONFIG_NAME} has no \`bundle.externalBin\` list.`);
  }
  return entries.map(entry => {
    const name = typeof entry === 'string' && entry.startsWith('binaries/') ? entry.slice('binaries/'.length) : '';
    if (name === '' || name.includes('/')) {
      throw new Error(
        `${CONFIG_NAME}: each entry of \`bundle.externalBin\` must be "binaries/<name>", and one is ${JSON.stringify(entry)}.`
      );
    }
    return name;
  });
}

// The files of a build target: for each program its file name
// (`<name>-<target triple>`, as Tauri and build.rs name it) and its pin of
// the manifest. Throws when the manifest names no such file, or no URL,
// size, or SHA-256 for it.
//
// A program that its release has only in a zip file (Deno) has a `zip`
// field too: `url` is then the zip file, `zip.size` and `zip.sha256` are
// its pin, and `zip.member` is the name of the program in it. `size` and
// `sha256` are always those of the program file itself, which is what
// build.rs checks.
export function pinnedPrograms(manifest, names, target) {
  const files = manifest?.files ?? {};
  return names.map(program => {
    const name = `${program}-${target}`;
    if (!Object.hasOwn(files, name)) {
      throw new Error(`Dez has no ${program} program for the target ${target}: ${MANIFEST_NAME} does not name ${name}.`);
    }
    const { url, size, sha256, zip } = files[name];
    const vendorScripts = 'The script that vendors the program writes them (scripts/update-ffmpeg.js, scripts/update-deno.js).';
    if (typeof url !== 'string' || !Number.isSafeInteger(size) || typeof sha256 !== 'string') {
      throw new Error(`${MANIFEST_NAME} names no URL, size, or SHA-256 for ${name}. ${vendorScripts}`);
    }
    if (zip === undefined) return { name, url, size, sha256 };
    if (typeof zip?.member !== 'string' || !Number.isSafeInteger(zip.size) || typeof zip.sha256 !== 'string') {
      throw new Error(`${MANIFEST_NAME} names no file, size, or SHA-256 for the zip file of ${name}. ${vendorScripts}`);
    }
    return { name, url, size, sha256, zip: { member: zip.member, size: zip.size, sha256: zip.sha256 } };
  });
}

// The native files of the libraries for a build target: for each library
// with a native file, its path in src-tauri/libs/ (`name`) and its pin of
// the libs manifest. A native file comes in an npm package, a `.tar.gz`
// file: `url` is that file, `tgz.size` and `tgz.sha256` are its pin, and
// `tgz.member` is the name of the native file in it. `size` and `sha256`
// are those of the native file itself, which is what build.rs checks.
// Throws when the manifest names no such file for the target, or no URL,
// size, or SHA-256.
export function pinnedNativeFiles(manifest, target) {
  const vendorScript = 'scripts/update-libs.js writes them.';
  return Object.entries(manifest?.libraries ?? {}).flatMap(([folder, library]) => {
    if (library?.native === undefined) return [];
    const name = `${folder}/${library.native.file}`;
    const targets = library.native.targets ?? {};
    if (!Object.hasOwn(targets, target)) {
      throw new Error(`Dez has no native file of ${folder} for the target ${target}: ${LIBS_MANIFEST_NAME} does not name one.`);
    }
    const { url, size, sha256, tgz } = targets[target];
    if (
      typeof url !== 'string' ||
      !Number.isSafeInteger(size) ||
      typeof sha256 !== 'string' ||
      typeof tgz?.member !== 'string' ||
      !Number.isSafeInteger(tgz.size) ||
      typeof tgz.sha256 !== 'string'
    ) {
      throw new Error(`${LIBS_MANIFEST_NAME} names no URL, size, or SHA-256 for ${name} of ${target}. ${vendorScript}`);
    }
    return [{ name, url, size, sha256, tgz: { member: tgz.member, size: tgz.size, sha256: tgz.sha256 } }];
  });
}

// Makes `path` the file of `pin` (`pinnedPrograms`, `pinnedNativeFiles`),
// with the mode `mode`, and tells whether it downloaded it. A file that
// matches its pin stays. Else the download goes into a new folder of
// `downloadParent` (on the same file system, so a rename moves it), and
// takes the place of the file only after it passed the check: no failed or
// wrong download is ever at `path`. `pinnedBy` names the manifest for the
// error texts.
//
// For a file in an archive (`zip` or `tgz`), the archive must match its
// pin, and then the file that came out of it must match the pin of the
// file.
export async function fetchPinnedFile(path, { name, url, size, sha256, zip, tgz }, { mode, downloadParent, pinnedBy, log = console.log }) {
  const pin = { size, sha256 };
  const archive = zip ?? tgz;
  const downloads = !(await isPinnedFile(path, pin));
  if (downloads) {
    log(`Downloading ${name} (${(archive ?? pin).size} bytes)`);
    const downloadDir = mkdtempSync(join(downloadParent, '.fetch-'));
    try {
      const downloaded = join(downloadDir, basename(path));
      if (archive) {
        const got = await downloadArchiveMember(url, downloaded, mode, archive, zip ? zipMember : tgzMember, pinnedBy);
        checkPin(`The file ${archive.member} of ${url}`, got, pin, pinnedBy);
      } else {
        await downloadPinned(url, downloaded, mode, pin, pinnedBy);
      }
      renameSync(downloaded, path);
    } finally {
      rmSync(downloadDir, { recursive: true, force: true });
    }
  }
  // A download gets its mode less the bits of the umask, and a file that
  // came another way (a copy by hand, a cache) can have any mode.
  chmodSync(path, mode);
  return downloads;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

async function main(args) {
  let options;
  try {
    options = parseArgs(args);
  } catch (error) {
    console.error(`${error.message}\n\n${USAGE}`);
    process.exitCode = 1;
    return;
  }
  if (options.help) {
    console.log(USAGE);
    return;
  }

  const target = options.target ?? hostTriple(process.platform, process.arch);
  if (!target) {
    // Not a failure: `npm run tauri` runs this script before every Tauri
    // command, also before a build for another target, and build.rs stops
    // a build that has no program, with the call that gets it.
    console.log(
      `fetch-programs: Dez ships no programs for this computer (${process.platform} ${process.arch}), ` +
        'so there is nothing to download. For a build of another target: --target <target triple>'
    );
    return;
  }

  try {
    const manifest = readJson(join(BINARIES_DIR, 'manifest.json'));
    const config = readJson(join(BINARIES_DIR, '..', 'tauri.conf.json'));
    const programs = pinnedPrograms(manifest, programNames(config), target);
    const nativeFiles = pinnedNativeFiles(readJson(join(LIBS_DIR, 'manifest.json')), target);
    let downloaded = 0;
    for (const program of programs) {
      const options = { mode: PROGRAM_MODE, downloadParent: BINARIES_DIR, pinnedBy: MANIFEST_NAME };
      if (await fetchPinnedFile(join(BINARIES_DIR, program.name), program, options)) downloaded++;
    }
    // The temp folder of a download is in src-tauri/binaries/, which Git
    // ignores, never in a library folder, which is in Git.
    for (const file of nativeFiles) {
      const options = { mode: NATIVE_MODE, downloadParent: BINARIES_DIR, pinnedBy: LIBS_MANIFEST_NAME };
      if (await fetchPinnedFile(join(LIBS_DIR, file.name), file, options)) downloaded++;
    }
    const count = (number, one, many) => `${number} ${number === 1 ? one : many}`;
    console.log(
      `fetch-programs: the ${count(programs.length, 'program', 'programs')} and the ` +
        `${count(nativeFiles.length, 'native file', 'native files')} of the libraries of ${target}` +
        ` are the files that ${MANIFEST_NAME} and ${LIBS_MANIFEST_NAME} name (${downloaded} downloaded).`
    );
  } catch (error) {
    console.error(`fetch-programs: ${error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  await main(process.argv.slice(2));
}
