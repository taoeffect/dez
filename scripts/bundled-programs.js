import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

// What the scripts of the programs that Dez ships share (fetch-programs.js,
// update-ffmpeg.js, update-deno.js): the folder of the programs, the build
// targets, a download that gives the size and the SHA-256 of what it wrote,
// the check of a file against a pin, a reader of one file of a zip file,
// and the rule of the manifest that the update scripts share.
//
// The programs are not in Git (src-tauri/.gitignore). manifest.json of
// their folder pins the URL, the size, and the SHA-256 of each one: a
// script, and src-tauri/build.rs, takes only a file that has the size and
// the SHA-256 of its pin.

// The folder of the programs, and the name of its manifest in a text for a
// reader.
export const BINARIES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src-tauri', 'binaries');
export const MANIFEST_NAME = 'src-tauri/binaries/manifest.json';

// The mode of a program file. Tauri copies the file next to the Dez program
// with its mode.
export const PROGRAM_MODE = 0o755;

// The build targets that Dez ships programs for, as Rust target triples.
export const TARGETS = ['aarch64-unknown-linux-gnu', 'x86_64-unknown-linux-gnu', 'aarch64-apple-darwin'];

// The target triple of the computer that runs the script, or undefined when
// Dez ships no programs for it.
export function hostTriple(platform, arch) {
  if (platform === 'linux' && arch === 'arm64') return 'aarch64-unknown-linux-gnu';
  if (platform === 'linux' && arch === 'x64') return 'x86_64-unknown-linux-gnu';
  if (platform === 'darwin' && arch === 'arm64') return 'aarch64-apple-darwin';
  return undefined;
}

// The manifest after one update script vendored its programs. `fields` are
// the top-level fields of the script, `files` its new entries of `files`,
// and `isOwnFile` tells whether a file name of the manifest is one of its
// programs.
//
// Each update script writes only its own part: the fields and the entries
// of the other scripts stay as they are. An entry keeps its place in the
// file, so a new version changes only the lines of its programs. An own
// entry that `files` does not name is gone (a program or a target that the
// script dropped).
export function manifestWith(manifest, fields, files, isOwnFile) {
  const kept = Object.entries(manifest.files ?? {}).filter(([name]) => !isOwnFile(name) || Object.hasOwn(files, name));
  return { ...manifest, ...fields, files: { ...Object.fromEntries(kept), ...files } };
}

// The text of the manifest file.
export function manifestFileText(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

// The answer of the server for `url`. Throws when the server gives none, or
// answers with an error status.
async function successfulResponse(url, headers) {
  const response = await fetch(url, { headers });
  if (!response.ok || !response.body) {
    throw new Error(`the server answered ${response.status}`);
  }
  return response;
}

// The error of a download that failed. A network failure of `fetch` has
// only the text "fetch failed"; its cause tells what failed (the name
// lookup, the connection).
function downloadError(url, error) {
  return new Error(`Cannot download ${url}: ${error.cause?.message ?? error.message}.`, { cause: error });
}

// Downloads `url` into a new file `path` with the mode `mode` (less the
// bits of the umask), and gives the size and the SHA-256 of the bytes that
// it wrote. A failed download can leave a part of the file: the caller
// downloads into a folder that it removes.
export async function download(url, path, mode) {
  const hash = createHash('sha256');
  let size = 0;
  try {
    const response = await successfulResponse(url);
    await pipeline(
      Readable.fromWeb(response.body),
      async function* (chunks) {
        for await (const chunk of chunks) {
          hash.update(chunk);
          size += chunk.length;
          yield chunk;
        }
      },
      createWriteStream(path, { mode })
    );
  } catch (error) {
    throw downloadError(url, error);
  }
  return { size, sha256: hash.digest('hex') };
}

// The bytes of `url`, for a file that a script reads and does not keep (a
// checksum file of a release, a license text). `headers` are the request
// headers that a server asks for.
export async function downloadBytes(url, headers) {
  try {
    const response = await successfulResponse(url, headers);
    return Buffer.from(await response.arrayBuffer());
  } catch (error) {
    throw downloadError(url, error);
  }
}

// The data of the release `tag` of a GitHub repository (`owner/name`), from
// the GitHub API.
export async function githubRelease(repo, tag) {
  const url = `https://api.github.com/repos/${repo}/releases/tags/${tag}`;
  const response = await fetch(url, { headers: { Accept: 'application/vnd.github+json' } });
  if (!response.ok) {
    throw new Error(`GitHub answered ${response.status} for ${url}. Check the tag: https://github.com/${repo}/releases`);
  }
  return response.json();
}

// A file of the release data of the GitHub API (`githubRelease`), with the
// size and the SHA-256 that GitHub states. Throws when the release has no
// such file, or gives no SHA-256 for it (releases from before GitHub made
// digests): Dez vendors no file that it cannot check.
export function releaseFile(release, assetName) {
  const asset = (release.assets ?? []).find(candidate => candidate.name === assetName);
  if (!asset) {
    throw new Error(`The release ${release.tag_name} has no file ${assetName}.`);
  }
  const sha256 = /^sha256:([0-9a-f]{64})$/.exec(asset.digest ?? '')?.[1];
  if (!sha256) {
    throw new Error(`The release ${release.tag_name} gives no SHA-256 for ${assetName}.`);
  }
  return { asset: assetName, size: asset.size, sha256 };
}

// Throws unless `got`, the size and the SHA-256 of a file, are those of
// `pin`. `what` names the file, and `pinnedBy` tells who names the pin, for
// the error text.
export function checkPin(what, got, pin, pinnedBy) {
  if (got.size !== pin.size || got.sha256 !== pin.sha256) {
    throw new Error(
      `${what} is not the file that ${pinnedBy} names.\n` +
        `  named: ${pin.size} bytes, SHA-256 ${pin.sha256}\n` +
        `  got:   ${got.size} bytes, SHA-256 ${got.sha256}`
    );
  }
}

// Downloads `url` into a new file `path` (`download`), and throws unless
// the file has the size and the SHA-256 of `pin`. `pinnedBy` tells who
// names them, for the error text.
export async function downloadPinned(url, path, mode, pin, pinnedBy) {
  checkPin(url, await download(url, path, mode), pin, pinnedBy);
}

const ZIP_END_SIGNATURE = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
const ZIP_ENTRY_SIGNATURE = 0x02014b50;
const ZIP_LOCAL_SIGNATURE = 0x04034b50;
// The value of a 32-bit field whose real value is in a Zip64 record.
const ZIP64_MARK = 0xffffffff;

// The bytes of the file `name` of a zip file, from the bytes of the zip
// file.
//
// Why Dez has its own reader: Node has none, and a program of a release can
// come only in a zip file (Deno). Such a zip file is plain, so the reader
// is small: it finds the list of the files from the end record, and takes
// one file, stored or deflated. It throws for a zip file that it cannot
// read: no such file, an encrypted file, the Zip64 form (a file of 4 GB or
// more, or 65535 files or more), or another compression method.
//
// It does not check the CRC-32 of the file: the caller checks its SHA-256.
//
// https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT
export function zipMember(zip, name) {
  // The end record is the last part of the file. Only a comment can come
  // after it.
  const end = zip.lastIndexOf(ZIP_END_SIGNATURE);
  if (end < 0 || end + 22 > zip.length) {
    throw new Error('It is not a zip file, or a part of it is missing: it has no end record.');
  }
  const count = zip.readUInt16LE(end + 10);
  let entry = zip.readUInt32LE(end + 16);
  if (count === 0xffff || entry === ZIP64_MARK) {
    throw new Error('The zip file has the Zip64 form, which this script does not read.');
  }

  for (let index = 0; index < count; index++) {
    if (entry + 46 > zip.length || zip.readUInt32LE(entry) !== ZIP_ENTRY_SIGNATURE) {
      throw new Error('The list of the files of the zip file is damaged.');
    }
    const nameLength = zip.readUInt16LE(entry + 28);
    if (zip.toString('utf8', entry + 46, entry + 46 + nameLength) === name) {
      return zipEntryBytes(zip, entry, name);
    }
    entry += 46 + nameLength + zip.readUInt16LE(entry + 30) + zip.readUInt16LE(entry + 32);
  }
  throw new Error(`The zip file has no file ${name}.`);
}

// The bytes of the file whose entry in the list of the files of a zip file
// starts at `entry`.
function zipEntryBytes(zip, entry, name) {
  const problem = text => new Error(`Cannot read ${name} of the zip file: ${text}.`);
  const flags = zip.readUInt16LE(entry + 8);
  const method = zip.readUInt16LE(entry + 10);
  const packedSize = zip.readUInt32LE(entry + 20);
  const size = zip.readUInt32LE(entry + 24);
  const local = zip.readUInt32LE(entry + 42);
  if (flags & 1) throw problem('it is encrypted');
  if (packedSize === ZIP64_MARK || size === ZIP64_MARK || local === ZIP64_MARK) {
    throw problem('it has the Zip64 form, which this script does not read');
  }
  if (local + 30 > zip.length || zip.readUInt32LE(local) !== ZIP_LOCAL_SIGNATURE) {
    throw problem('its place in the zip file is damaged');
  }
  // The data starts after the local header, which has a name and an extra
  // field of its own: their lengths can be other ones than in the list.
  const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
  const packed = zip.subarray(start, start + packedSize);

  let bytes;
  if (method === 0) {
    bytes = packed;
  } else if (method === 8) {
    try {
      // The limit stops a damaged file that grows without end. Node takes
      // no limit of 0.
      bytes = inflateRawSync(packed, { maxOutputLength: Math.max(size, 1) });
    } catch (error) {
      throw problem(`its data is damaged (${error.message})`);
    }
  } else {
    throw problem(`it has the compression method ${method}, and this script reads only stored and deflated files`);
  }
  if (packed.length !== packedSize || bytes.length !== size) {
    throw problem('its data is damaged (it has another size than the zip file states)');
  }
  return bytes;
}

// Downloads the zip file `url`, and writes its file `zip.member` into a new
// file `path` with the mode `mode`. Throws unless the zip file has
// `zip.size` and `zip.sha256` (`downloadPinned`). Gives the size and the
// SHA-256 of the file that it wrote, which the caller checks against a pin
// of that file. The zip file is next to `path` during the call.
export async function downloadZipMember(url, path, mode, zip, pinnedBy) {
  const zipPath = `${path}.zip`;
  await downloadPinned(url, zipPath, 0o600, zip, pinnedBy);
  let bytes;
  try {
    bytes = zipMember(readFileSync(zipPath), zip.member);
  } catch (error) {
    throw new Error(`${url}: ${error.message}`, { cause: error });
  }
  rmSync(zipPath);
  writeFileSync(path, bytes, { mode });
  return { size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}

// Whether `path` is a file with the size and the SHA-256 of `pin`. The size
// comes first, as it needs no read of the file.
export async function isPinnedFile(path, pin) {
  const stats = statSync(path, { throwIfNoEntry: false });
  if (!stats?.isFile() || stats.size !== pin.size) return false;
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest('hex') === pin.sha256;
}
