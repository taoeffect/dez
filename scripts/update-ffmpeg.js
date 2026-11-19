#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  BINARIES_DIR,
  PROGRAM_MODE,
  downloadPinned,
  githubRelease,
  hostTriple,
  manifestFileText,
  manifestWith,
  releaseFile
} from './bundled-programs.js';

// Vendors the ffmpeg and ffprobe programs that Dez ships: downloads the
// files of one release of the build repository for every platform of Dez,
// and the license texts of the release, checks each file against the SHA-256
// that GitHub gives for it, and writes the files, their manifest, and their
// license notice into src-tauri/binaries/.
//
// The programs are not in Git (src-tauri/.gitignore); the other files are.
// The manifest pins the URL, the size, and the SHA-256 of each program, and
// scripts/fetch-programs.js downloads the programs of a build target again
// from it. So the manifest is what a commit of a new version holds.
//
// src-tauri/build.rs checks the files of the build target against the
// manifest in every build, `bundle.externalBin` (tauri.conf.json) puts them
// next to the Dez program, and `bundle.resources` ships NOTICE.md and the
// license texts.
//
// Why this source: FFmpeg publishes no programs of its own. Dez builds them
// in its own repository, from the build scripts of the Shaka Project
// (SHAKA_REPO), with more libraries (the drawtext, subtitles, and ass
// filters, and PNG). The builds are static, have no `--enable-nonfree` part
// (so Dez may ship them), come for the three platforms of Dez from one build,
// and GitHub gives a SHA-256 for each file.

const BUILD_REPO = 'taoeffect/dez-ffmpeg';
const SHAKA_REPO = 'shaka-project/static-ffmpeg-binaries';
const BUILD_REPO_URL = `https://github.com/${BUILD_REPO}`;

const USAGE = `Vendor the ffmpeg and ffprobe programs of one release of ${BUILD_REPO}.

Usage:
  node scripts/update-ffmpeg.js <release tag>

The tag is an FFmpeg version and the build number of the release.
The releases: ${BUILD_REPO_URL}/releases

Example:
  node scripts/update-ffmpeg.js n9.0.2-3`;

// The tag rule of the build repository: the FFmpeg version, then the number
// of the build of that version (its README, "Tag names").
const TAG_PATTERN = /^(n\d+(?:\.\d+)+)-\d+$/;

// The programs that Dez ships.
export const TOOLS = ['ffmpeg', 'ffprobe'];

// The platforms of Dez: the Rust target triple of a build, and the platform
// part of the release file names. The Linux files are fully static (musl)
// builds.
export const PLATFORMS = {
  'aarch64-unknown-linux-gnu': 'linux-arm64',
  'x86_64-unknown-linux-gnu': 'linux-x64',
  'aarch64-apple-darwin': 'macos-arm64'
};

// The name of a program in src-tauri/binaries/. Tauri takes the file
// `<name>-<target triple>` for `externalBin: ["binaries/<name>"]`. The
// names are not `ffmpeg` and `ffprobe`, as a deb or rpm bundle would put
// them into /usr/bin.
export function vendoredName(tool, triple) {
  return `dez-${tool}-${triple}`;
}

// The one argument: a release tag. Throws for anything else.
export function parseArgs(args) {
  if (args.length !== 1) {
    throw new Error(`Expected one release tag, got: ${args.join(' ') || '(none)'}`);
  }
  if (!TAG_PATTERN.test(args[0])) {
    throw new Error(`Invalid release tag: ${args[0]}`);
  }
  return { tag: args[0] };
}

// The FFmpeg version of a release tag (`n8.1.2-2` gives `n8.1.2`).
export function ffmpegVersionOfTag(tag) {
  return TAG_PATTERN.exec(tag)[1];
}

// The license texts of the programs and of their libraries: a file of each
// release (build-scripts/91-licenses.sh of the build repository), and its
// name in src-tauri/binaries/.
export const LICENSE_TEXTS = 'LICENSES.txt';

// The programs to vendor: for each program of each platform its name in Dez,
// its release file, and its size and SHA-256 (`releaseFile`).
export function vendoredFiles(release) {
  return Object.entries(PLATFORMS).flatMap(([triple, platform]) =>
    TOOLS.map(tool => ({ name: vendoredName(tool, triple), ...releaseFile(release, `${tool}-${platform}`) }))
  );
}

// The license texts to vendor (`LICENSE_TEXTS`), with their size and
// SHA-256. Releases before n9.0.2-4 have no such file.
export function licenseTextsFile(release) {
  return { name: LICENSE_TEXTS, ...releaseFile(release, LICENSE_TEXTS) };
}

// The URL of a file of a release. The script builds it from the tag and from
// a file name of its own; it takes no URL of the API answer.
function releaseFileUrl(tag, asset) {
  return `${BUILD_REPO_URL}/releases/download/${tag}/${asset}`;
}

// The text of src-tauri/binaries/manifest.json: what build.rs checks the
// programs against, and where they come from. The `url`, `size`, and
// `sha256` of a program are its pin: scripts/fetch-programs.js downloads
// the program from that URL, and takes only that file.
//
// `manifest` is the manifest of before. The script changes only its own
// part (`manifestWith`): the manifest also has the programs of the other
// update scripts (update-deno.js).
export function manifestText(manifest, tag, files, licenseTexts) {
  return manifestFileText(
    manifestWith(
      manifest,
      {
        ffmpegVersion: ffmpegVersionOfTag(tag),
        releaseTag: tag,
        source: `${BUILD_REPO_URL}/releases/tag/${tag}`,
        licenseTexts: { asset: licenseTexts.asset, size: licenseTexts.size, sha256: licenseTexts.sha256 }
      },
      Object.fromEntries(
        files.map(({ name, asset, size, sha256 }) => [name, { asset, url: releaseFileUrl(tag, asset), size, sha256 }])
      ),
      name => TOOLS.some(tool => name.startsWith(vendoredName(tool, '')))
    )
  );
}

// The libraries that the builds hold (the scripts of build-scripts/ in the
// build repository), each with its license: its id (its name in versions.txt
// and in LICENSE_TEXTS), the name and the link that NOTICE.md gives, and its
// license. `licenseTextsProblem` checks this list against the license texts
// of each release, so a library that a build adds or drops stops the script
// until the list (and so NOTICE.md) names it.
export const LIBRARIES = [
  { id: 'libvpx', name: 'libvpx', url: 'https://chromium.googlesource.com/webm/libvpx', license: 'the BSD 3-Clause License' },
  { id: 'svt-av1', name: 'SVT-AV1', url: 'https://gitlab.com/AOMediaCodec/SVT-AV1', license: 'the BSD 3-Clause Clear License' },
  { id: 'x264', name: 'x264', url: 'https://code.videolan.org/videolan/x264', license: 'the GNU General Public License, version 2 or later' },
  { id: 'x265', name: 'x265', url: 'https://bitbucket.org/multicoreware/x265_git', license: 'the GNU General Public License, version 2 or later' },
  { id: 'lame', name: 'LAME', url: 'https://lame.sourceforge.io/', license: 'the GNU Library General Public License, version 2 or later' },
  { id: 'opus', name: 'Opus', url: 'https://opus-codec.org/', license: 'the BSD 3-Clause License' },
  { id: 'zlib', name: 'zlib', url: 'https://zlib.net/', license: 'the zlib License' },
  // FreeType gives a choice of two licenses. Dez takes the FreeType
  // License, which asks for a credit in the documentation (FREETYPE_CREDIT).
  { id: 'freetype', name: 'FreeType', url: 'https://freetype.org/', license: 'the FreeType License (FTL)' },
  { id: 'harfbuzz', name: 'HarfBuzz', url: 'https://github.com/harfbuzz/harfbuzz', license: 'the MIT License ("Old MIT")' },
  {
    id: 'fribidi',
    name: 'FriBidi',
    url: 'https://github.com/fribidi/fribidi',
    license: 'the GNU Lesser General Public License, version 2.1 or later'
  },
  { id: 'libass', name: 'libass', url: 'https://github.com/libass/libass', license: 'the ISC License' },
  // The Linux files are static musl builds (PLATFORMS).
  { id: 'musl', name: 'musl (only in the Linux files)', url: 'https://musl.libc.org/', license: 'the MIT License' }
];

// The head of a part of LICENSE_TEXTS: a rule line, the line
// "<id> <version>: <file>", and another rule line (91-licenses.sh of the
// build repository writes them).
const LICENSE_TEXT_HEAD = /^={80}\n(\S+) \S+: .+\n={80}$/gm;

// Why the license texts of a release do not fit LIBRARIES, or undefined when
// they do: they must have a part for FFmpeg and for each library of the list,
// and for no other one.
export function licenseTextsProblem(text) {
  const found = new Set(Array.from(text.matchAll(LICENSE_TEXT_HEAD), match => match[1]));
  const named = ['ffmpeg', ...LIBRARIES.map(library => library.id)];
  const missing = named.filter(id => !found.has(id));
  if (missing.length > 0) {
    return `has no license text of ${missing.join(', ')}, which LIBRARIES of this script names. If the build dropped it, remove it there`;
  }
  const unnamed = [...found].filter(id => !named.includes(id));
  return unnamed.length > 0
    ? `has the license text of ${unnamed.join(', ')}, which LIBRARIES of this script does not name. Add it there, so that NOTICE.md names it`
    : undefined;
}

// The credit text that the FreeType License (docs/FTL.TXT of FreeType)
// asks for, without the year, as the FreeType version moves with the
// releases of the build repository.
const FREETYPE_CREDIT =
  'Portions of this software are copyright © The FreeType Project (https://freetype.org). All rights reserved.';

// The text of src-tauri/binaries/NOTICE.md: the license notice of the
// programs and of their libraries, with the links to their source. It is
// written with the manifest, so that it never names another version than
// the files have.
export function noticeText(tag) {
  const version = ffmpegVersionOfTag(tag);
  const libraries = LIBRARIES.map(({ name, url, license }) => `- [${name}](${url}): ${license}`).join('\n');
  return `# ffmpeg and ffprobe in Dez

<!-- Written by scripts/update-ffmpeg.js. Do not edit it by hand. -->

Dez ships two programs of the [FFmpeg](https://ffmpeg.org/) project next to its own program: \`dez-ffmpeg\` (ffmpeg) and \`dez-ffprobe\` (ffprobe). Dez runs them as separate programs. They are not a part of the Dez program, and the license of Dez does not apply to them.

- FFmpeg version: ${version}
- Builder: Dez, [${BUILD_REPO}](${BUILD_REPO_URL}), from the build scripts of the Shaka Project, [${SHAKA_REPO}](https://github.com/${SHAKA_REPO})
- Release: [${tag}](${BUILD_REPO_URL}/releases/tag/${tag})

The programs and \`${LICENSE_TEXTS}\` are files of that release, not changed. \`manifest.json\` has the release file, the size, and the SHA-256 of each one. This file is for the Dez version of this branch or tag: for another Dez version, read it at the tag of that version.

## License

The programs have the [GNU General Public License, version 3](https://www.gnu.org/licenses/gpl-3.0.html) or later: the builds are configured with \`--enable-gpl --enable-version3\`, and without \`--enable-nonfree\`. \`dez-ffmpeg -L\` prints the license terms, and \`dez-ffmpeg -version\` prints the configuration.

## Libraries

The programs hold these libraries. Their versions are in [\`versions.txt\`](${BUILD_REPO_URL}/blob/${tag}/versions.txt) of the release.

${libraries}

FreeType: ${FREETYPE_CREDIT}

## License texts

\`${LICENSE_TEXTS}\` has the license texts of FFmpeg and of each library, copied from the source code of the build. The Dez bundle ships it and this file in the \`ffmpeg\` folder of its resources.

## Source code

- FFmpeg ${version}: <https://git.ffmpeg.org/gitweb/ffmpeg.git/tag/refs/tags/${version}> (a copy: <https://github.com/FFmpeg/FFmpeg/tree/${version}>)
- The build scripts, which get the source of each library at the version of \`versions.txt\`: <${BUILD_REPO_URL}/tree/${tag}>

## Another version

\`node scripts/update-ffmpeg.js <release tag>\` gets the files of another release, checks them, and writes them, \`manifest.json\`, and this file.
`;
}

// The version that a program reports: the third word of the first line of
// its `-version` output ("ffmpeg version n8.1.2 Copyright …").
export function reportedVersion(versionOutput) {
  return /^ff(?:mpeg|probe) version (\S+)/.exec(versionOutput)?.[1];
}

// Why the license notice (`noticeText`) would be false for a program, or
// undefined when it is true. The check reads the bytes of the file: FFmpeg
// keeps its configure line as text in the program (`-version` prints it),
// so the check works for a program of another platform too, which this
// computer cannot run. A build with `--enable-nonfree` may not be shipped.
export function licenseProblem(bytes) {
  if (bytes.includes('--enable-nonfree')) {
    return 'is built with --enable-nonfree, so Dez may not ship it';
  }
  const missing = ['--enable-gpl', '--enable-version3'].find(flag => !bytes.includes(flag));
  return missing && `is built without ${missing}, so NOTICE.md would name the wrong license`;
}

// Downloads a file of the release (`releaseFile`) into `path`, and throws
// unless it is the file that GitHub states.
async function downloadReleaseFile(tag, file, path, mode) {
  console.log(`Downloading ${file.asset} (${file.size} bytes)`);
  await downloadPinned(releaseFileUrl(tag, file.asset), path, mode, file, 'GitHub');
}

// Runs a downloaded program of this computer with `-version` and throws
// unless it reports the FFmpeg version of the release tag.
function checkHostProgram(path, name, version) {
  const result = spawnSync(path, ['-version'], { encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    throw new Error(`${name} does not run on this computer: ${result.error?.message ?? result.stderr}`);
  }
  const reported = reportedVersion(result.stdout);
  if (reported !== version) {
    throw new Error(`${name} reports the version ${reported ?? '(none)'}, not ${version}.`);
  }
}

async function main(args) {
  if (args.length === 0) {
    console.log(USAGE);
    return;
  }

  let tag;
  try {
    ({ tag } = parseArgs(args));
  } catch (error) {
    console.error(`${error.message}\n\n${USAGE}`);
    process.exit(1);
  }

  // The downloads go into a folder next to the final files (the same file
  // system, so a rename moves them), and the final files change only after
  // every check passed: a failed run leaves the vendored version whole.
  const downloadDir = mkdtempSync(join(BINARIES_DIR, '.update-'));
  try {
    const release = await githubRelease(BUILD_REPO, tag);
    const files = vendoredFiles(release);
    const licenseTexts = licenseTextsFile(release);

    for (const file of files) {
      const path = join(downloadDir, file.name);
      await downloadReleaseFile(tag, file, path, PROGRAM_MODE);
      const problem = licenseProblem(readFileSync(path));
      if (problem) throw new Error(`${file.asset} ${problem}.`);
    }

    const licenseTextsPath = join(downloadDir, licenseTexts.name);
    await downloadReleaseFile(tag, licenseTexts, licenseTextsPath, 0o644);
    const licenseTextsIssue = licenseTextsProblem(readFileSync(licenseTextsPath, 'utf8'));
    if (licenseTextsIssue) throw new Error(`${licenseTexts.asset} ${licenseTextsIssue}.`);

    const version = ffmpegVersionOfTag(tag);
    const triple = hostTriple(process.platform, process.arch);
    if (triple) {
      for (const tool of TOOLS) {
        const name = vendoredName(tool, triple);
        checkHostProgram(join(downloadDir, name), name, version);
      }
      console.log(`The programs of this computer (${triple}) run and report ${version}.`);
    } else {
      console.log('Dez ships no programs for this computer, so the script did not run one.');
    }

    for (const file of [...files, licenseTexts]) {
      renameSync(join(downloadDir, file.name), join(BINARIES_DIR, file.name));
    }
    const manifestPath = join(BINARIES_DIR, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    writeFileSync(manifestPath, manifestText(manifest, tag, files, licenseTexts));
    writeFileSync(join(BINARIES_DIR, 'NOTICE.md'), noticeText(tag));

    console.log(`Vendored FFmpeg ${version} (release ${tag}) in src-tauri/binaries/.
Next: build and test Dez, then commit manifest.json, NOTICE.md, and LICENSES.txt.
Git ignores the programs: scripts/fetch-programs.js gets them from the URLs of the manifest.`);
  } catch (error) {
    console.error(`update-ffmpeg: ${error.message}`);
    process.exitCode = 1;
  } finally {
    rmSync(downloadDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  await main(process.argv.slice(2));
}
