import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fetchProgram, parseArgs, pinnedPrograms, programNames } from './fetch-programs.js';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

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
});

describe('fetchProgram', () => {
  const NAME = 'dez-ffmpeg-x86_64-unknown-linux-gnu';
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
  const quiet = () => {};

  it('downloads a missing program as a file that can run, and leaves no download folder', async () => {
    expect(await fetchProgram(dir, pinned(), quiet)).toBe(true);
    expect(readFileSync(join(dir, NAME))).toEqual(program);
    expect(mode(join(dir, NAME))).toBe(0o755);
    expect(readdirSync(dir)).toEqual([NAME]);
  });

  it('keeps a program that matches its pin with no request, and lets it run', async () => {
    writeFileSync(join(dir, NAME), program, { mode: 0o600 });
    expect(await fetchProgram(dir, pinned(), quiet)).toBe(false);
    expect(requests).toEqual([]);
    expect(mode(join(dir, NAME))).toBe(0o755);
  });

  it('puts the pinned program in the place of another file of the same size', async () => {
    writeFileSync(join(dir, NAME), otherProgram);
    expect(await fetchProgram(dir, pinned(), quiet)).toBe(true);
    expect(readFileSync(join(dir, NAME))).toEqual(program);
  });

  it('refuses a download that is not the pinned file, and puts nothing under the name of the program', async () => {
    served['/release/ffmpeg'] = otherProgram;
    await expect(fetchProgram(dir, pinned(), quiet)).rejects.toThrow(
      `/release/ffmpeg is not the file that src-tauri/binaries/manifest.json names.\n` +
        `  named: ${program.length} bytes, SHA-256 ${sha256(program)}\n` +
        `  got:   ${otherProgram.length} bytes, SHA-256 ${sha256(otherProgram)}`
    );
    expect(readdirSync(dir)).toEqual([]);
  });

  it('tells the URL and the answer of the server when the download fails, and keeps the file that was there', async () => {
    writeFileSync(join(dir, NAME), otherProgram);
    const { url } = pinned('/release/gone');
    await expect(fetchProgram(dir, pinned('/release/gone'), quiet)).rejects.toThrow(
      `Cannot download ${url}: the server answered 404.`
    );
    expect(readFileSync(join(dir, NAME))).toEqual(otherProgram);
    expect(readdirSync(dir)).toEqual([NAME]);
  });
});
