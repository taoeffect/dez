#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Vendors the ffmpeg and ffprobe programs that Dez ships: downloads the
// files of one release of the build repository for every platform of Dez,
// checks each file against the SHA-256 that GitHub gives for it, and writes
// the files, their manifest, and their license notice into
// src-tauri/binaries/. The files are in Git LFS (.gitattributes).
//
// src-tauri/build.rs checks the files of the build target against the
// manifest in every build, and `bundle.externalBin` (tauri.conf.json) puts
// them next to the Dez program.
//
// Why this source: FFmpeg publishes no programs of its own. These builds
// are static, have no `--enable-nonfree` part (so Dez may ship them), come
// for the three platforms of Dez from one build, and GitHub gives a SHA-256
// for each file.

const BUILD_REPO = 'shaka-project/static-ffmpeg-binaries';
const BUILD_REPO_URL = `https://github.com/${BUILD_REPO}`;

const USAGE = `Vendor the ffmpeg and ffprobe programs of one release of ${BUILD_REPO}.

Usage:
  node scripts/update-ffmpeg.js <release tag>

The tag is an FFmpeg version and the build number of the release.
The releases: ${BUILD_REPO_URL}/releases

Example:
  node scripts/update-ffmpeg.js n8.1.2-2`;

// The tag rule of the build repository: the FFmpeg version, then the number
// of the build of that version (its README, "Tag names").
const TAG_PATTERN = /^(n\d+(?:\.\d+)+)-\d+$/;

// The programs that Dez ships.
export const TOOLS = ['ffmpeg', 'ffprobe'];

// The platforms of Dez: the Rust target triple of a build, and the platform
// part of the release file names. The plain Linux names are the fully
// static (musl) builds; the `-ubuntu-…` files of a release need the
// libraries of that Ubuntu.
export const PLATFORMS = {
  'aarch64-unknown-linux-gnu': 'linux-arm64',
  'x86_64-unknown-linux-gnu': 'linux-x64',
  'aarch64-apple-darwin': 'osx-arm64'
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

// The files to vendor, from the release data of the GitHub API: for each
// program of each platform its name in Dez, its release file, and the size
// and SHA-256 that GitHub states. Throws when the release has no such file,
// or gives no SHA-256 for it (releases from before GitHub made digests):
// Dez vendors no file that it cannot check.
export function vendoredFiles(release) {
  const assets = new Map((release.assets ?? []).map(asset => [asset.name, asset]));
  const files = [];
  for (const [triple, platform] of Object.entries(PLATFORMS)) {
    for (const tool of TOOLS) {
      const assetName = `${tool}-${platform}`;
      const asset = assets.get(assetName);
      if (!asset) {
        throw new Error(`The release ${release.tag_name} has no file ${assetName}.`);
      }
      const sha256 = /^sha256:([0-9a-f]{64})$/.exec(asset.digest ?? '')?.[1];
      if (!sha256) {
        throw new Error(`The release ${release.tag_name} gives no SHA-256 for ${assetName}.`);
      }
      files.push({ name: vendoredName(tool, triple), asset: assetName, size: asset.size, sha256 });
    }
  }
  return files;
}

// The text of src-tauri/binaries/manifest.json: what build.rs checks the
// programs against, and where they come from.
export function manifestText(tag, files) {
  const manifest = {
    ffmpegVersion: ffmpegVersionOfTag(tag),
    releaseTag: tag,
    source: `${BUILD_REPO_URL}/releases/tag/${tag}`,
    files: Object.fromEntries(
      files.map(({ name, asset, size, sha256 }) => [name, { asset, size, sha256 }])
    )
  };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

// The text of src-tauri/binaries/NOTICE.md: the license notice of the
// programs, with the links to their source. It is written with the
// manifest, so that it never names another version than the files have. It
// names no library of the builds: the build repository lists them.
export function noticeText(tag) {
  const version = ffmpegVersionOfTag(tag);
  return `# ffmpeg and ffprobe in Dez

<!-- Written by scripts/update-ffmpeg.js. Do not edit it by hand. -->

Dez ships two programs of the [FFmpeg](https://ffmpeg.org/) project next to its own program: \`dez-ffmpeg\` (ffmpeg) and \`dez-ffprobe\` (ffprobe). Dez runs them as separate programs. They are not a part of the Dez program, and the license of Dez does not apply to them.

- FFmpeg version: ${version}
- Builder: the Shaka Project, [${BUILD_REPO}](${BUILD_REPO_URL})
- Release: [${tag}](${BUILD_REPO_URL}/releases/tag/${tag})

The files of this folder are the files of that release, not changed. \`manifest.json\` has the release file, the size, and the SHA-256 of each one. This file is for the Dez version of this branch or tag: for another Dez version, read it at the tag of that version.

## License

The programs have the [GNU General Public License, version 3](https://www.gnu.org/licenses/gpl-3.0.html) or later: the builds are configured with \`--enable-gpl --enable-version3\`, and without \`--enable-nonfree\`. \`dez-ffmpeg -L\` prints the license terms, and \`dez-ffmpeg -version\` prints the configuration.

## Source code

- FFmpeg ${version}: <https://git.ffmpeg.org/gitweb/ffmpeg.git/tag/refs/tags/${version}> (a copy: <https://github.com/FFmpeg/FFmpeg/tree/${version}>)
- The build scripts, and the versions of the libraries that the builds hold (\`versions.txt\`): <${BUILD_REPO_URL}/tree/${tag}>

## Another version

\`node scripts/update-ffmpeg.js <release tag>\` gets the files of another release, checks them, and writes them, \`manifest.json\`, and this file.
`;
}

// The target triple of the computer that runs the script, or undefined when
// Dez ships no programs for it.
export function hostTriple(platform, arch) {
  if (platform === 'linux' && arch === 'arm64') return 'aarch64-unknown-linux-gnu';
  if (platform === 'linux' && arch === 'x64') return 'x86_64-unknown-linux-gnu';
  if (platform === 'darwin' && arch === 'arm64') return 'aarch64-apple-darwin';
  return undefined;
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

// Downloads `url` into the file `path` and gives the size and the SHA-256
// of the bytes that it wrote.
async function download(url, path) {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`GitHub answered ${response.status} for ${url}.`);
  }
  const hash = createHash('sha256');
  let size = 0;
  await pipeline(
    Readable.fromWeb(response.body),
    async function* (chunks) {
      for await (const chunk of chunks) {
        hash.update(chunk);
        size += chunk.length;
        yield chunk;
      }
    },
    // 0755: Git keeps the executable bit of an LFS file, and Tauri copies
    // the file with its mode.
    createWriteStream(path, { mode: 0o755 })
  );
  return { size, sha256: hash.digest('hex') };
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

  const binariesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src-tauri', 'binaries');
  // The downloads go into a folder next to the final files (the same file
  // system, so a rename moves them), and the final files change only after
  // every check passed: a failed run leaves the vendored version whole.
  const downloadDir = mkdtempSync(join(binariesDir, '.update-'));
  try {
    const releaseUrl = `https://api.github.com/repos/${BUILD_REPO}/releases/tags/${tag}`;
    const response = await fetch(releaseUrl, { headers: { Accept: 'application/vnd.github+json' } });
    if (!response.ok) {
      throw new Error(`GitHub answered ${response.status} for ${releaseUrl}. Check the tag: ${BUILD_REPO_URL}/releases`);
    }
    const files = vendoredFiles(await response.json());

    for (const file of files) {
      console.log(`Downloading ${file.asset} (${file.size} bytes)`);
      // A URL that the script builds, not one of the API answer.
      const url = `${BUILD_REPO_URL}/releases/download/${tag}/${file.asset}`;
      const path = join(downloadDir, file.name);
      const got = await download(url, path);
      if (got.size !== file.size || got.sha256 !== file.sha256) {
        throw new Error(
          `${file.asset} is not the file that GitHub states.\n` +
            `  stated: ${file.size} bytes, SHA-256 ${file.sha256}\n` +
            `  got:    ${got.size} bytes, SHA-256 ${got.sha256}`
        );
      }
      const problem = licenseProblem(readFileSync(path));
      if (problem) throw new Error(`${file.asset} ${problem}.`);
    }

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

    for (const file of files) {
      renameSync(join(downloadDir, file.name), join(binariesDir, file.name));
    }
    writeFileSync(join(binariesDir, 'manifest.json'), manifestText(tag, files));
    writeFileSync(join(binariesDir, 'NOTICE.md'), noticeText(tag));

    console.log(`Vendored FFmpeg ${version} (release ${tag}) in src-tauri/binaries/.
Next: build and test Dez, then commit the folder. "git lfs ls-files" must list the six programs.`);
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
