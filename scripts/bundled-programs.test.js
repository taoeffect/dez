import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hostTriple, isPinnedFile } from './bundled-programs.js';

describe('hostTriple', () => {
  it('gives the target triple of each platform of Dez, and none for another computer', () => {
    expect(hostTriple('linux', 'arm64')).toBe('aarch64-unknown-linux-gnu');
    expect(hostTriple('linux', 'x64')).toBe('x86_64-unknown-linux-gnu');
    expect(hostTriple('darwin', 'arm64')).toBe('aarch64-apple-darwin');
    expect(hostTriple('darwin', 'x64')).toBeUndefined();
    expect(hostTriple('win32', 'x64')).toBeUndefined();
  });
});

describe('isPinnedFile', () => {
  const bytes = Buffer.from('the bytes of a program');
  const pin = { size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  let dir;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dez-bundled-programs-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('takes the file that has the size and the SHA-256 of the pin', async () => {
    writeFileSync(join(dir, 'program'), bytes);
    expect(await isPinnedFile(join(dir, 'program'), pin)).toBe(true);
  });

  it('refuses a file of another size, and a file of the same size with other bytes', async () => {
    writeFileSync(join(dir, 'short'), bytes.subarray(1));
    expect(await isPinnedFile(join(dir, 'short'), pin)).toBe(false);
    writeFileSync(join(dir, 'other'), Buffer.from(bytes).fill('x', 0, 1));
    expect(await isPinnedFile(join(dir, 'other'), pin)).toBe(false);
  });

  it('refuses a missing file and a folder', async () => {
    expect(await isPinnedFile(join(dir, 'missing'), pin)).toBe(false);
    mkdirSync(join(dir, 'folder'));
    expect(await isPinnedFile(join(dir, 'folder'), pin)).toBe(false);
  });
});
