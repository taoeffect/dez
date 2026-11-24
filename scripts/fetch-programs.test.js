import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fetchPinnedFile, parseArgs, pinnedNativeFiles, pinnedPrograms, programNames } from './fetch-programs.js';
import { sha256, tarGzFile, zipFile } from './testing.js';

describe('parseArgs', () => {
  it('takes no argument, a target, or a call for the usage text', () => {
    expect(parseArgs([])).toEqual({});
    expect(parseArgs(['--target', 'x86_64-unknown-linux-gnu'])).toEqual({ target: 'x86_64-unknown-linux-gnu' });
    expect(parseArgs(['--help'])).toEqual({ help: true });
    expect(parseArgs(['-h'])).toEqual({ help: true });
  });

  it('refuses anything else', () => {
    expect(() => parseArgs(['--target'])).toThrow('Expected no argument or --target <target triple>, got: --target');
    expect(() => parseArgs(['--target', ''])).toThrow(/^Expected no argument/);
    expect(() => parseArgs(['x86_64-unknown-linux-gnu'])).toThrow(/^Expected no argument/);
    expect(() => parseArgs(['--target', 'a', 'b'])).toThrow(/^Expected no argument/);
    expect(() => parseArgs(['--all'])).toThrow(/^Expected no argument/);
  });
});

describe('programNames', () => {
  it('reads the names of `bundle.externalBin`, as build.rs does', () => {
    expect(programNames({ bundle: { externalBin: ['binaries/dez-ffmpeg', 'binaries/dez-ffprobe'] } }))
      .toEqual(['dez-ffmpeg', 'dez-ffprobe']);
  });

  it('refuses a config with no list, and an entry that is not `binaries/<name>`', () => {
    expect(() => programNames({ bundle: {} })).toThrow('src-tauri/tauri.conf.json has no `bundle.externalBin` list.');
    for (const entry of ['dez-ffmpeg', 'binaries/', 'binaries/sub/dez-ffmpeg', '../binaries/dez-ffmpeg', 7]) {
      expect(() => programNames({ bundle: { externalBin: ['binaries/dez-ffprobe', entry] } }))
        .toThrow(`must be "binaries/<name>", and one is ${JSON.stringify(entry)}.`);
    }
  });
});

describe('pinnedPrograms', () => {
  const pin = letter => ({ asset: `asset-${letter}`, url: `https://example.com/${letter}`, size: 7, sha256: letter.repeat(64) });
  const manifest = {
    files: {
      'dez-ffmpeg-aarch64-unknown-linux-gnu': pin('a'),
      'dez-ffprobe-aarch64-unknown-linux-gnu': pin('b'),
      'dez-ffmpeg-x86_64-unknown-linux-gnu': pin('c'),
      'dez-ffprobe-x86_64-unknown-linux-gnu': pin('d')
    }
  };
  const names = ['dez-ffmpeg', 'dez-ffprobe'];

  it('gives the file and the pin of each program of one target only', () => {
    expect(pinnedPrograms(manifest, names, 'x86_64-unknown-linux-gnu')).toEqual([
      { name: 'dez-ffmpeg-x86_64-unknown-linux-gnu', url: 'https://example.com/c', size: 7, sha256: 'c'.repeat(64) },
      { name: 'dez-ffprobe-x86_64-unknown-linux-gnu', url: 'https://example.com/d', size: 7, sha256: 'd'.repeat(64) }
    ]);
  });

  it('refuses a target that the manifest has no program for, and a part of a target', () => {
    expect(() => pinnedPrograms(manifest, names, 'aarch64-apple-darwin')).toThrow(
      'Dez has no dez-ffmpeg program for the target aarch64-apple-darwin: ' +
        'src-tauri/binaries/manifest.json does not name dez-ffmpeg-aarch64-apple-darwin.'
    );
    expect(() => pinnedPrograms(manifest, names, 'gnu')).toThrow(/does not name dez-ffmpeg-gnu\.$/);
  });

  it('refuses a program of the config that the manifest has no file of', () => {
    expect(() => pinnedPrograms(manifest, [...names, 'dez-deno'], 'x86_64-unknown-linux-gnu')).toThrow(
      /^Dez has no dez-deno program for the target x86_64-unknown-linux-gnu: /
    );
  });

  it('refuses an entry with no URL, size, or SHA-256, as nothing can get or check that program', () => {
    for (const missing of ['url', 'size', 'sha256']) {
      const entry = { ...pin('c'), [missing]: undefined };
      const files = { ...manifest.files, 'dez-ffmpeg-x86_64-unknown-linux-gnu': entry };
      expect(() => pinnedPrograms({ files }, names, 'x86_64-unknown-linux-gnu')).toThrow(
        /^src-tauri\/binaries\/manifest\.json names no URL, size, or SHA-256 for dez-ffmpeg-x86_64-unknown-linux-gnu\. /
      );
    }
  });

  // The entry of a program that comes in a zip file: `url` is the zip file,
  // and `zip` pins it and names the program in it.
  const zipPin = { ...pin('e'), zip: { member: 'deno', size: 3, sha256: 'f'.repeat(64) } };
  const zipFiles = { ...manifest.files, 'dez-deno-x86_64-unknown-linux-gnu': zipPin };

  it('gives the pin of the zip file too, for a program that comes in a zip file', () => {
    expect(pinnedPrograms({ files: zipFiles }, ['dez-deno'], 'x86_64-unknown-linux-gnu')).toEqual([
      {
        name: 'dez-deno-x86_64-unknown-linux-gnu',
        url: 'https://example.com/e',
        size: 7,
        sha256: 'e'.repeat(64),
        zip: { member: 'deno', size: 3, sha256: 'f'.repeat(64) }
      }
    ]);
  });

  it('refuses a zip file with no program name, size, or SHA-256', () => {
    for (const zip of [null, {}, { ...zipPin.zip, member: undefined }, { ...zipPin.zip, size: '3' }, { ...zipPin.zip, sha256: undefined }]) {
      const files = { ...zipFiles, 'dez-deno-x86_64-unknown-linux-gnu': { ...zipPin, zip } };
      expect(() => pinnedPrograms({ files }, ['dez-deno'], 'x86_64-unknown-linux-gnu')).toThrow(
        /^src-tauri\/binaries\/manifest\.json names no file, size, or SHA-256 for the zip file of dez-deno-x86_64-unknown-linux-gnu\. /
      );
    }
  });
});

describe('pinnedNativeFiles', () => {
  const target = 'x86_64-unknown-linux-gnu';
  const nativePin = {
    package: '@skia-canvas/linux-x64-glibc',
    url: 'https://registry.npmjs.org/a.tgz',
    integrity: 'sha512-x',
    tgz: { member: 'package/skia.node', size: 9, sha256: 'a'.repeat(64) },
    size: 7,
    sha256: 'b'.repeat(64)
  };
  const manifest = {
    libraries: {
      three: { package: 'three', version: '1.0.0' },
      'skia-canvas': { package: 'skia-canvas', native: { file: 'lib/skia.node', targets: { [target]: nativePin } } }
    }
  };

  it('gives the path in the libs folder and the pin of each native file of one target', () => {
    expect(pinnedNativeFiles(manifest, target)).toEqual([
      {
        name: 'skia-canvas/lib/skia.node',
        url: nativePin.url,
        size: 7,
        sha256: 'b'.repeat(64),
        tgz: { member: 'package/skia.node', size: 9, sha256: 'a'.repeat(64) }
      }
    ]);
  });

  it('gives nothing for libraries with no native file', () => {
    expect(pinnedNativeFiles({ libraries: { three: manifest.libraries.three } }, target)).toEqual([]);
  });

  it('refuses a target that a native library has no pin for', () => {
    expect(() => pinnedNativeFiles(manifest, 'aarch64-apple-darwin')).toThrow(
      'Dez has no native file of skia-canvas for the target aarch64-apple-darwin: src-tauri/libs/manifest.json does not name one.'
    );
  });

  it('refuses a pin with no URL, size, or SHA-256 of the file or of its package', () => {
    for (const broken of [{ url: undefined }, { size: '7' }, { tgz: { ...nativePin.tgz, sha256: undefined } }, { tgz: undefined }]) {
      const native = { file: 'lib/skia.node', targets: { [target]: { ...nativePin, ...broken } } };
      expect(() => pinnedNativeFiles({ libraries: { 'skia-canvas': { native } } }, target)).toThrow(
        `src-tauri/libs/manifest.json names no URL, size, or SHA-256 for skia-canvas/lib/skia.node of ${target}.`
      );
    }
  });
});

describe('fetchPinnedFile', () => {
  const NAME = 'dez-ffmpeg-x86_64-unknown-linux-gnu';
  const PINNED_BY = 'src-tauri/binaries/manifest.json';
  const program = Buffer.from('\x7fELF the bytes of the pinned program');
  // Another file of the same size, so only the SHA-256 tells the two apart.
  const otherProgram = Buffer.from(program).fill('x', 5, 9);

  // A server of release files: `served` maps a URL path to the bytes that
  // it answers, and `requests` lists the paths that were asked for.
  let server;
  let served;
  let requests;
  let dir;

  beforeAll(async () => {
    server = createServer((request, response) => {
      requests.push(request.url);
      const body = served[request.url];
      if (!body) {
        response.writeHead(404).end();
        return;
      }
      response.end(body);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  });
  afterAll(async () => {
    await new Promise(resolve => server.close(resolve));
  });

  beforeEach(() => {
    served = { '/release/ffmpeg': program };
    requests = [];
    dir = mkdtempSync(join(tmpdir(), 'dez-fetch-programs-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // The pin of `program`, at a URL path of the server.
  const pinned = (path = '/release/ffmpeg') => ({
    name: NAME,
    url: `http://127.0.0.1:${server.address().port}${path}`,
    size: program.length,
    sha256: sha256(program)
  });
  const mode = path => statSync(path).mode & 0o777;
  // The fetch of a program as main runs it: into `dir`, with the
  // downloads in a folder of `dir`.
  const fetchProgram = pin =>
    fetchPinnedFile(join(dir, pin.name), pin, { mode: 0o755, downloadParent: dir, pinnedBy: PINNED_BY, log: () => {} });

  it('downloads a missing program as a file that can run, and leaves no download folder', async () => {
    expect(await fetchProgram(pinned())).toBe(true);
    expect(readFileSync(join(dir, NAME))).toEqual(program);
    expect(mode(join(dir, NAME))).toBe(0o755);
    expect(readdirSync(dir)).toEqual([NAME]);
  });

  it('keeps a program that matches its pin with no request, and lets it run', async () => {
    writeFileSync(join(dir, NAME), program, { mode: 0o600 });
    expect(await fetchProgram(pinned())).toBe(false);
    expect(requests).toEqual([]);
    expect(mode(join(dir, NAME))).toBe(0o755);
  });

  it('puts the pinned program in the place of another file of the same size', async () => {
    writeFileSync(join(dir, NAME), otherProgram);
    expect(await fetchProgram(pinned())).toBe(true);
    expect(readFileSync(join(dir, NAME))).toEqual(program);
  });

  it('refuses a download that is not the pinned file, and puts nothing under the name of the program', async () => {
    served['/release/ffmpeg'] = otherProgram;
    await expect(fetchProgram(pinned())).rejects.toThrow(
      `/release/ffmpeg is not the file that src-tauri/binaries/manifest.json names.\n` +
        `  named: ${program.length} bytes, SHA-256 ${sha256(program)}\n` +
        `  got:   ${otherProgram.length} bytes, SHA-256 ${sha256(otherProgram)}`
    );
    expect(readdirSync(dir)).toEqual([]);
  });

  it('tells the URL and the answer of the server when the download fails, and keeps the file that was there', async () => {
    writeFileSync(join(dir, NAME), otherProgram);
    const { url } = pinned('/release/gone');
    await expect(fetchProgram(pinned('/release/gone'))).rejects.toThrow(`Cannot download ${url}: the server answered 404.`);
    expect(readFileSync(join(dir, NAME))).toEqual(otherProgram);
    expect(readdirSync(dir)).toEqual([NAME]);
  });

  describe('for a program in a zip file', () => {
    const DENO = 'dez-deno-x86_64-unknown-linux-gnu';
    const zip = zipFile([{ name: 'README', bytes: Buffer.from('a text') }, { name: 'deno', bytes: program }]);
    // A zip file with another program under the same name.
    const otherZip = zipFile([{ name: 'deno', bytes: otherProgram }]);

    const zipPinned = (zipBytes = zip) => ({
      ...pinned('/release/deno.zip'),
      name: DENO,
      zip: { member: 'deno', size: zipBytes.length, sha256: sha256(zipBytes) }
    });

    it('takes the program out of the zip file as a file that can run, and leaves nothing else', async () => {
      served['/release/deno.zip'] = zip;
      expect(await fetchProgram(zipPinned())).toBe(true);
      expect(readFileSync(join(dir, DENO))).toEqual(program);
      expect(mode(join(dir, DENO))).toBe(0o755);
      expect(readdirSync(dir)).toEqual([DENO]);
    });

    it('keeps a program that matches its pin with no request', async () => {
      writeFileSync(join(dir, DENO), program);
      expect(await fetchProgram(zipPinned())).toBe(false);
      expect(requests).toEqual([]);
    });

    it('refuses a download that is not the pinned zip file, and puts nothing under the name of the program', async () => {
      served['/release/deno.zip'] = otherZip;
      await expect(fetchProgram(zipPinned())).rejects.toThrow(
        `/release/deno.zip is not the file that src-tauri/binaries/manifest.json names.\n` +
          `  named: ${zip.length} bytes, SHA-256 ${sha256(zip)}\n` +
          `  got:   ${otherZip.length} bytes, SHA-256 ${sha256(otherZip)}`
      );
      expect(readdirSync(dir)).toEqual([]);
    });

    it('refuses a pinned zip file whose program is not the pinned program', async () => {
      served['/release/deno.zip'] = otherZip;
      const { url } = zipPinned();
      await expect(fetchProgram(zipPinned(otherZip))).rejects.toThrow(
        `The file deno of ${url} is not the file that src-tauri/binaries/manifest.json names.\n` +
          `  named: ${program.length} bytes, SHA-256 ${sha256(program)}\n` +
          `  got:   ${otherProgram.length} bytes, SHA-256 ${sha256(otherProgram)}`
      );
      expect(readdirSync(dir)).toEqual([]);
    });

    it('tells the URL of a pinned zip file that does not have the program', async () => {
      served['/release/deno.zip'] = zip;
      const pin = zipPinned();
      pin.zip.member = 'deno.exe';
      await expect(fetchProgram(pin)).rejects.toThrow(`${pin.url}: The zip file has no file deno.exe.`);
      expect(readdirSync(dir)).toEqual([]);
    });
  });

  // The native file of a library: it comes in an npm package (a `.tar.gz`
  // file), goes into a folder of the libs folder, and the download folder
  // is in another folder (src-tauri/binaries/ in main).
  describe('for a native file in an npm package', () => {
    const NATIVE = 'skia-canvas/lib/skia.node';
    const LIBS_PINNED_BY = 'src-tauri/libs/manifest.json';
    const tgz = tarGzFile([{ name: 'package/package.json', text: '{}' }, { name: 'package/skia.node', text: program.toString('latin1') }]);
    const otherTgz = tarGzFile([{ name: 'package/skia.node', text: otherProgram.toString('latin1') }]);
    let libs;
    let downloads;

    beforeEach(() => {
      libs = join(dir, 'libs');
      downloads = join(dir, 'binaries');
      mkdirSync(join(libs, 'skia-canvas', 'lib'), { recursive: true });
      mkdirSync(downloads);
      served['/a.tgz'] = tgz;
    });

    const tgzPinned = (tgzBytes = tgz) => ({
      ...pinned('/a.tgz'),
      name: NATIVE,
      tgz: { member: 'package/skia.node', size: tgzBytes.length, sha256: sha256(tgzBytes) }
    });
    const fetchNative = pin =>
      fetchPinnedFile(join(libs, NATIVE), pin, { mode: 0o644, downloadParent: downloads, pinnedBy: LIBS_PINNED_BY, log: () => {} });

    it('takes the file out of the package with its own mode, and leaves no download folder', async () => {
      expect(await fetchNative(tgzPinned())).toBe(true);
      expect(readFileSync(join(libs, NATIVE))).toEqual(program);
      expect(mode(join(libs, NATIVE))).toBe(0o644);
      expect(readdirSync(join(libs, 'skia-canvas', 'lib'))).toEqual(['skia.node']);
      expect(readdirSync(downloads)).toEqual([]);
    });

    it('refuses a pinned package whose file is not the pinned file, and leaves nothing in the libs folder', async () => {
      served['/a.tgz'] = otherTgz;
      const { url } = tgzPinned();
      await expect(fetchNative(tgzPinned(otherTgz))).rejects.toThrow(
        `The file package/skia.node of ${url} is not the file that ${LIBS_PINNED_BY} names.`
      );
      expect(readdirSync(join(libs, 'skia-canvas', 'lib'))).toEqual([]);
      expect(readdirSync(downloads)).toEqual([]);
    });

    it('tells the URL of a pinned package that does not have the file', async () => {
      const pin = tgzPinned();
      pin.tgz.member = 'package/index.node';
      await expect(fetchNative(pin)).rejects.toThrow(`${pin.url}: The tar file has no file package/index.node.`);
      expect(readdirSync(downloads)).toEqual([]);
    });
  });
});
