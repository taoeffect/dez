import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

// What the scripts of the programs that Dez ships share (fetch-programs.js,
// update-ffmpeg.js): the folder of the programs, the target triple of this
// computer, a download that gives the size and the SHA-256 of what it wrote,
// and the check of a file against a pin.
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

// The target triple of the computer that runs the script, or undefined when
// Dez ships no programs for it.
export function hostTriple(platform, arch) {
  if (platform === 'linux' && arch === 'arm64') return 'aarch64-unknown-linux-gnu';
  if (platform === 'linux' && arch === 'x64') return 'x86_64-unknown-linux-gnu';
  if (platform === 'darwin' && arch === 'arm64') return 'aarch64-apple-darwin';
  return undefined;
}

// Downloads `url` into a new file `path` with the mode `mode` (less the
// bits of the umask), and gives the size and the SHA-256 of the bytes that
// it wrote. A failed download can leave a part of the file: the caller
// downloads into a folder that it removes.
export async function download(url, path, mode) {
  const hash = createHash('sha256');
  let size = 0;
  try {
    const response = await fetch(url);
    if (!response.ok || !response.body) {
      throw new Error(`the server answered ${response.status}`);
    }
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
    // A network failure of `fetch` has only the text "fetch failed"; its
    // cause tells what failed (the name lookup, the connection).
    throw new Error(`Cannot download ${url}: ${error.cause?.message ?? error.message}.`, { cause: error });
  }
  return { size, sha256: hash.digest('hex') };
}

// Downloads `url` into a new file `path` (`download`), and throws unless
// the file has the size and the SHA-256 of `pin`. `pinnedBy` tells who
// names them, for the error text.
export async function downloadPinned(url, path, mode, pin, pinnedBy) {
  const got = await download(url, path, mode);
  if (got.size !== pin.size || got.sha256 !== pin.sha256) {
    throw new Error(
      `${url} is not the file that ${pinnedBy} names.\n` +
        `  named: ${pin.size} bytes, SHA-256 ${pin.sha256}\n` +
        `  got:   ${got.size} bytes, SHA-256 ${got.sha256}`
    );
  }
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
