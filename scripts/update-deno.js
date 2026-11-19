#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  BINARIES_DIR,
  PROGRAM_MODE,
  TARGETS,
  downloadBytes,
  downloadPinned,
  downloadZipMember,
  githubRelease,
  hostTriple,
  manifestFileText,
  manifestWith,
  releaseFile
} from './bundled-programs.js';
import { denoLicenseSources, licenseTextsFile } from './deno-licenses.js';

// Vendors the Deno program that Dez ships as `dez-deno`: downloads the zip
// file of one Deno release for every platform of Dez, checks each zip file
// against the SHA-256 that GitHub gives for it, takes the program out, and
// writes the programs, their part of the manifest, and their license notice
// and license texts into src-tauri/binaries/.
//
// The programs are not in Git (src-tauri/.gitignore); the other files are.
// The manifest pins, for each program, the zip file (URL, size, SHA-256)
// and the program in it (name, size, SHA-256), and scripts/fetch-programs.js
// gets the program of a build target again from these pins. So the manifest
// is what a commit of a new version holds.
//
// src-tauri/build.rs checks the program of the build target against the
// manifest in every build, `bundle.externalBin` (tauri.conf.json) puts it
// next to the Dez program, and `bundle.resources` ships the license notice
// and the license texts.
//
// Why this source: the Deno project publishes its own builds for the three
// platforms of Dez, and GitHub gives a SHA-256 for each file of a release.
// A release has the program only in a zip file.
//
// The manifest also has the programs of scripts/update-ffmpeg.js. Each of
// the two scripts changes only its own part (`manifestWith`), and each has
// a license notice of its own: this one is in the folder NOTICE_FOLDER.

const DENO_REPO = 'denoland/deno';
const DENO_REPO_URL = `https://github.com/${DENO_REPO}`;

const USAGE = `Vendor the Deno program of one release of ${DENO_REPO} as dez-deno.

Usage:
  node scripts/update-deno.js <version>

The releases: ${DENO_REPO_URL}/releases

The script also downloads the Deno source of the release and each Rust
crate that it names (about 300 MB), for their license texts.

Example:
  node scripts/update-deno.js 2.9.8`;

// A Deno version. A release tag is `v` and the version.
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

// The name of the program in a zip file of a release.
const ZIP_MEMBER = 'deno';

// The Deno source of a release, as a file of the release.
const SOURCE_ARCHIVE = 'deno_src.tar.gz';

// The folder of src-tauri/binaries/ with the license notice and the
// license texts of Deno. Its name must not start with `dez-`: Git ignores
// such names in the folder of the programs.
export const NOTICE_FOLDER = 'deno';

// The name of the program in src-tauri/binaries/. Tauri takes the file
// `<name>-<target triple>` for `externalBin: ["binaries/<name>"]`. The name
// is not `deno`, as a deb or rpm bundle would put it into /usr/bin.
export function vendoredName(triple) {
  return `dez-deno-${triple}`;
}

// The one argument: a Deno version. Throws for anything else.
export function parseArgs(args) {
  if (args.length !== 1) {
    throw new Error(`Expected one Deno version, got: ${args.join(' ') || '(none)'}`);
  }
  if (!VERSION_PATTERN.test(args[0])) {
    throw new Error(`Invalid Deno version: ${args[0]}`);
  }
  return { version: args[0] };
}

// The zip files to vendor the program from: for each platform of Dez the
// name of the program in Dez, the zip file of the release, and the pin of
// the zip file (`zip`, as an entry of the manifest has it) from the size
// and the SHA-256 that GitHub states. Deno names its release files by the
// Rust target triple.
export function releaseZipFiles(release) {
  return TARGETS.map(triple => {
    const { asset, size, sha256 } = releaseFile(release, `deno-${triple}.zip`);
    return { name: vendoredName(triple), triple, asset, zip: { member: ZIP_MEMBER, size, sha256 } };
  });
}

// The URL of a file of a release. The script builds it from the version and
// from a file name of its own; it takes no URL of the API answer.
function releaseFileUrl(version, asset) {
  return `${DENO_REPO_URL}/releases/download/v${version}/${asset}`;
}

// The SHA-256 that the text of a `.sha256sum` file of a release states for
// the file `fileName`: one line "<SHA-256>  <file name>", as the sha256sum
// program writes it. Undefined for a text of another form, or for another
// file.
export function statedSha256(text, fileName) {
  const match = /^([0-9a-f]{64}) [ *](.+)$/.exec(text.trim());
  return match?.[2] === fileName ? match[1] : undefined;
}

// The text of src-tauri/binaries/manifest.json after this script vendored
// `files` (`releaseZipFiles`, each with the `size` and the `sha256` of its
// program). `manifest` is the manifest of before: the script changes only
// its own part.
//
// The `size` and `sha256` of a program are those of the program file, which
// build.rs checks. `url` and `zip` tell scripts/fetch-programs.js where the
// program comes from: the zip file with its pin, and the name of the
// program in it. `deno` is what the Help page reads.
export function manifestText(manifest, version, files) {
  return manifestFileText(
    manifestWith(
      manifest,
      { deno: { version, source: `${DENO_REPO_URL}/releases/tag/v${version}` } },
      Object.fromEntries(
        files.map(({ name, asset, zip, size, sha256 }) => [name, { asset, url: releaseFileUrl(version, asset), zip, size, sha256 }])
      ),
      name => name.startsWith(vendoredName(''))
    )
  );
}

// Why the license notice (`noticeText`) would be false for a release, or
// undefined when it is true: the notice names the license of Deno, and
// `license` is the text of LICENSE.md of the Deno source of the release.
export function licenseProblem(license) {
  return /^MIT License$/m.test(license)
    ? undefined
    : 'LICENSE.md of the Deno source is not the MIT License, so NOTICE.md would name the wrong license';
}

// The text of src-tauri/binaries/deno/NOTICE.md: the license notice of the
// program, with the rule of the license texts and the links to the source.
// It is written with the manifest, so that it never names another version
// than the files have. `v8Version` is the version of the `v8` crate of the
// release.
//
// The notice does not tell that a Dez bundle has the file of the release
// byte for byte: linuxdeploy, which makes the AppImage, sets a library
// search path (RUNPATH) in each program of the bundle that links
// dynamically, and Deno is one.
export function noticeText(version, v8Version) {
  const tag = `v${version}`;
  return `# Deno in Dez

<!-- Written by scripts/update-deno.js. Do not edit it by hand. -->

Dez ships the program of the [Deno](https://deno.com/) project next to its own program, as \`dez-deno\`. Dez runs it as a separate program. It is not a part of the Dez program, and the license of Dez does not apply to it.

- Deno version: ${version}
- Release: [${tag}](${DENO_REPO_URL}/releases/tag/${tag})

The program is the file \`${ZIP_MEMBER}\` of a zip file of that release. \`manifest.json\` of the folder above this one has, for each platform, the zip file with its size and its SHA-256, and the size and the SHA-256 of the program. Dez does not change the code of the program. The tools that build a Dez bundle can change other parts of its file: in the AppImage, the program has one more library search path. This file is for the Dez version of this branch or tag: for another Dez version, read it at the tag of that version.

## License

Deno has the [MIT License](${DENO_REPO_URL}/blob/${tag}/LICENSE.md).

The program also holds code of other projects, each with its own license: the V8 JavaScript engine and the libraries that V8 is built with (ICU is one), and the Rust crates that Deno is built with.

## License texts

\`LICENSES.txt\` has the license texts. The Deno project publishes no list of the code in the program, so the texts come from a rule, not from a list of names. The rule takes each file with the name of a license file (\`LICENSE\`, \`COPYING\`, \`NOTICE\`, and the like) of these sources, but not the files of their tests:

- The Deno source of the release (\`${SOURCE_ARCHIVE}\`).
- [rusty_v8](https://github.com/denoland/rusty_v8) at the version of the \`v8\` crate of the release (${v8Version}), and each Git submodule of it at the commit that it pins: all of the V8 source, and the top folder of each other one (ICU, Abseil, libc++, and more).
- Each Rust crate that \`Cargo.lock\` of the Deno source names, from the crate file of crates.io that the lock pins.

The head of each text names the files that have it, each with its source. The end of \`LICENSES.txt\` lists each crate with the license that it states: some crates have no license file of their own.

The rule takes more than the program holds: a crate that only another platform uses, a tool of the build, or a part of a source that is not compiled into the program. So a text in \`LICENSES.txt\` does not tell that the program holds the code of that text.

The Dez bundle ships \`LICENSES.txt\` and this file in the \`${NOTICE_FOLDER}\` folder of its resources.

## Source code

- Deno ${version}: <${DENO_REPO_URL}/tree/${tag}>
- The Rust crates: <https://crates.io/>, each at the version that [\`Cargo.lock\`](${DENO_REPO_URL}/blob/${tag}/Cargo.lock) names
- V8, as Deno builds it: <https://github.com/denoland/rusty_v8/tree/v${v8Version}>

## Another version

\`node scripts/update-deno.js <version>\` gets the programs of another release, checks them, and writes them, their part of \`manifest.json\`, \`LICENSES.txt\`, and this file.
`;
}

// The first lines of src-tauri/binaries/deno/LICENSES.txt, before the
// license texts (`licenseTextsFile`).
function licenseTextsIntro(version) {
  return `The license texts of Deno ${version}, the program that Dez ships as dez-deno.

Written by scripts/update-deno.js. Do not edit it by hand. NOTICE.md, next to
this file, tells the rule that finds the texts.

Each license text is in this file once. The lines between the two rule lines
before a text name each file that has this text: the source, then the path of
the file in that source. The list of the Rust crates, each with the license
that it states, is at the end of the file.

This file has more texts than the program has code: see NOTICE.md.`;
}

// The version that the program reports: the second word of the first line
// of its `--version` output ("deno 2.9.8 (stable, release, …)").
export function reportedVersion(versionOutput) {
  return /^deno (\S+)/.exec(versionOutput)?.[1];
}

// Runs a downloaded program of this computer with `--version` and throws
// unless it reports the Deno version of the release.
function checkHostProgram(path, name, version) {
  // The check must not make Deno ask its servers for a newer version.
  const env = { ...process.env, DENO_NO_UPDATE_CHECK: '1' };
  const result = spawnSync(path, ['--version'], { encoding: 'utf8', env });
  if (result.error || result.status !== 0) {
    throw new Error(`${name} does not run on this computer: ${result.error?.message ?? result.stderr}`);
  }
  const reported = reportedVersion(result.stdout);
  if (reported !== version) {
    throw new Error(`${name} reports the version ${reported ?? '(none)'}, not ${version}.`);
  }
}

// The SHA-256 that the release states for `fileName` in its `.sha256sum`
// file `asset`. Throws when the file states none.
async function releaseStatedSha256(version, asset, fileName) {
  const text = (await downloadBytes(releaseFileUrl(version, asset))).toString('utf8');
  const sha256 = statedSha256(text, fileName);
  if (!sha256) {
    throw new Error(`${asset} of the release states no SHA-256 for ${fileName}.`);
  }
  return sha256;
}

// Downloads the zip file of one platform into `downloadDir`, writes its
// program there under the name of the program in Dez, and gives the file
// (`releaseZipFiles`) with the size and the SHA-256 of the program.
//
// Three statements must agree. GitHub states the SHA-256 of the zip file
// (the pin of the download). The Deno project states it too, and the
// SHA-256 of the program in the zip file, in two `.sha256sum` files of the
// release: a zip file that was put in the place of another, or a reader
// that takes other bytes out of it, fails here.
async function vendoredProgram(version, file, downloadDir) {
  const zipSha256 = await releaseStatedSha256(version, `${file.asset}.sha256sum`, file.asset);
  if (zipSha256 !== file.zip.sha256) {
    throw new Error(
      `${file.asset}.sha256sum of the release states the SHA-256 ${zipSha256} for ${file.asset}, and GitHub states ${file.zip.sha256}.`
    );
  }
  console.log(`Downloading ${file.asset} (${file.zip.size} bytes)`);
  const program = await downloadZipMember(
    releaseFileUrl(version, file.asset),
    join(downloadDir, file.name),
    PROGRAM_MODE,
    file.zip,
    'GitHub'
  );
  const programSums = `deno-${file.triple}.sha256sum`;
  const programSha256 = await releaseStatedSha256(version, programSums, ZIP_MEMBER);
  if (programSha256 !== program.sha256) {
    throw new Error(
      `${programSums} of the release states the SHA-256 ${programSha256} for the program, ` +
        `and ${ZIP_MEMBER} of ${file.asset} has ${program.sha256}.`
    );
  }
  return { ...file, ...program };
}

async function main(args) {
  if (args.length === 0) {
    console.log(USAGE);
    return;
  }

  let version;
  try {
    ({ version } = parseArgs(args));
  } catch (error) {
    console.error(`${error.message}\n\n${USAGE}`);
    process.exit(1);
  }

  // The downloads go into a folder next to the final files (the same file
  // system, so a rename moves them), and the final files change only after
  // every check passed: a failed run leaves the vendored version whole.
  const downloadDir = mkdtempSync(join(BINARIES_DIR, '.update-'));
  try {
    const release = await githubRelease(DENO_REPO, `v${version}`);
    const zipFiles = releaseZipFiles(release);
    const sourceArchive = releaseFile(release, SOURCE_ARCHIVE);

    const files = [];
    for (const file of zipFiles) {
      files.push(await vendoredProgram(version, file, downloadDir));
    }

    const triple = hostTriple(process.platform, process.arch);
    if (triple) {
      const name = vendoredName(triple);
      checkHostProgram(join(downloadDir, name), name, version);
      console.log(`The program of this computer (${triple}) runs and reports ${version}.`);
    } else {
      console.log('Dez ships no programs for this computer, so the script did not run one.');
    }

    console.log(`Downloading ${sourceArchive.asset} (${sourceArchive.size} bytes)`);
    const sourcePath = join(downloadDir, sourceArchive.asset);
    await downloadPinned(releaseFileUrl(version, sourceArchive.asset), sourcePath, 0o600, sourceArchive, 'GitHub');
    const licenses = await denoLicenseSources(version, readFileSync(sourcePath));
    const problem = licenseProblem(licenses.denoLicense);
    if (problem) throw new Error(`${problem}.`);

    for (const file of files) {
      renameSync(join(downloadDir, file.name), join(BINARIES_DIR, file.name));
    }
    const manifestPath = join(BINARIES_DIR, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    writeFileSync(manifestPath, manifestText(manifest, version, files));
    const noticeDir = join(BINARIES_DIR, NOTICE_FOLDER);
    mkdirSync(noticeDir, { recursive: true });
    writeFileSync(join(noticeDir, 'NOTICE.md'), noticeText(version, licenses.v8Version));
    writeFileSync(
      join(noticeDir, 'LICENSES.txt'),
      licenseTextsFile(licenseTextsIntro(version), licenses.sources, licenses.crates)
    );

    console.log(`Vendored Deno ${version} in src-tauri/binaries/.
Next: build and test Dez, then commit manifest.json, ${NOTICE_FOLDER}/NOTICE.md, and ${NOTICE_FOLDER}/LICENSES.txt.
Git ignores the programs: scripts/fetch-programs.js gets them from the URLs of the manifest.`);
  } catch (error) {
    console.error(`update-deno: ${error.message}`);
    process.exitCode = 1;
  } finally {
    rmSync(downloadDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  await main(process.argv.slice(2));
}
