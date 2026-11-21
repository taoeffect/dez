#!/usr/bin/env node

import { chmodSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  BINARIES_DIR,
  MANIFEST_NAME,
  PROGRAM_MODE,
  checkPin,
  downloadPinned,
  downloadZipMember,
  hostTriple,
  isPinnedFile
} from './bundled-programs.js';

// Gets the programs that Dez ships (`bundle.externalBin` of
// tauri.conf.json) for one build target: downloads each one from the URL
// that src-tauri/binaries/manifest.json pins for it into src-tauri/binaries/,
// and takes it only when it has the size and the SHA-256 of its pin. A
// program that is there and matches its pin is not downloaded again, so a
// second run uses no network.
//
// Why: the programs are not in Git (src-tauri/.gitignore), so a new clone has
// none. `npm run tauri` and the `build:*` scripts (package.json) run this
// script first. src-tauri/build.rs checks the same pins in every build, but
// it downloads nothing: a bare `cargo` build of a clone with no programs
// stops with a text that names this script.
//
// The script uses only Node built-ins, so it runs before `npm ci`.

const CONFIG_NAME = 'src-tauri/tauri.conf.json';

const USAGE = `Download the programs that Dez ships for one build target into src-tauri/binaries/.

Usage:
  node scripts/fetch-programs.js [--target <target triple>]

Without --target, the script takes the target of this computer. It checks
each program against the size and the SHA-256 that ${MANIFEST_NAME}
names, and downloads only a program that is missing or is another file.

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

// Makes `<dir>/<name>` the pinned file of a program, and tells whether it
// downloaded it. A file that matches its pin stays. Else the download goes
// into a folder next to it (the same file system, so a rename moves it), and
// takes the place of the program only after it passed the check: no failed
// or wrong download is ever under the name of a program.
//
// For a program in a zip file (`zip`, see `pinnedPrograms`), the zip file
// must match its pin, and then the program that came out of it must match
// the pin of the program.
export async function fetchProgram(dir, { name, url, size, sha256, zip }, log = console.log) {
  const path = join(dir, name);
  const pin = { size, sha256 };
  const downloads = !(await isPinnedFile(path, pin));
  if (downloads) {
    log(`Downloading ${name} (${(zip ?? pin).size} bytes)`);
    const downloadDir = mkdtempSync(join(dir, '.fetch-'));
    try {
      const downloaded = join(downloadDir, name);
      if (zip) {
        const got = await downloadZipMember(url, downloaded, PROGRAM_MODE, zip, MANIFEST_NAME);
        checkPin(`The file ${zip.member} of ${url}`, got, pin, MANIFEST_NAME);
      } else {
        await downloadPinned(url, downloaded, PROGRAM_MODE, pin, MANIFEST_NAME);
      }
      renameSync(downloaded, path);
    } finally {
      rmSync(downloadDir, { recursive: true, force: true });
    }
  }
  // A download gets its mode less the bits of the umask, and a file that
  // came another way (a copy by hand, a cache) can have any mode.
  chmodSync(path, PROGRAM_MODE);
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
    let downloaded = 0;
    for (const program of programs) {
      if (await fetchProgram(BINARIES_DIR, program)) downloaded++;
    }
    console.log(
      `fetch-programs: the ${programs.length} programs of ${target} are the files that ${MANIFEST_NAME} names` +
        ` (${downloaded} downloaded).`
    );
  } catch (error) {
    console.error(`fetch-programs: ${error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  await main(process.argv.slice(2));
}
