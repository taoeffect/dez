import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hostTriple, isPinnedFile, manifestWith, zipMember } from './bundled-programs.js';
import { sha256, zipFile } from './testing.js';

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
  const pin = { size: bytes.length, sha256: sha256(bytes) };
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

describe('manifestWith', () => {
  const entry = letter => ({ url: `https://example.com/${letter}`, size: 7, sha256: letter.repeat(64) });
  const manifest = {
    releaseTag: 'n1-1',
    files: { 'dez-a-linux': entry('a'), 'dez-b-linux': entry('b'), 'dez-a-macos': entry('c'), 'dez-b-macos': entry('d') },
    licenseTexts: { size: 3 }
  };
  const isA = name => name.startsWith('dez-a-');

  it('changes only the fields and the entries of one script, and each entry keeps its place', () => {
    const next = manifestWith(manifest, { releaseTag: 'n2-1' }, { 'dez-a-macos': entry('e'), 'dez-a-linux': entry('f') }, isA);
    expect(next).toEqual({
      releaseTag: 'n2-1',
      files: { 'dez-a-linux': entry('f'), 'dez-b-linux': entry('b'), 'dez-a-macos': entry('e'), 'dez-b-macos': entry('d') },
      licenseTexts: { size: 3 }
    });
    // The order is the order of the lines of the manifest file.
    expect(Object.keys(next)).toEqual(Object.keys(manifest));
    expect(Object.keys(next.files)).toEqual(Object.keys(manifest.files));
  });

  it('drops an own entry that the script does not name again, and adds new ones after the others', () => {
    const next = manifestWith(manifest, { a: { version: '2' } }, { 'dez-a-linux': entry('f'), 'dez-a-windows': entry('g') }, isA);
    expect(Object.keys(next.files)).toEqual(['dez-a-linux', 'dez-b-linux', 'dez-b-macos', 'dez-a-windows']);
    expect(Object.keys(next)).toEqual(['releaseTag', 'files', 'licenseTexts', 'a']);
  });

  it('gives the entries of a first script to a manifest with no files', () => {
    expect(manifestWith({}, { a: 1 }, { 'dez-a-linux': entry('a') }, isA)).toEqual({ a: 1, files: { 'dez-a-linux': entry('a') } });
  });
});

describe('zipMember', () => {
  const program = Buffer.from('\x7fELF the bytes of a program, the bytes of a program, the bytes of a program');
  const files = [
    { name: 'README', bytes: Buffer.from('a text') },
    { name: 'deno', bytes: program },
    { name: 'stored', bytes: Buffer.from('bytes with no compression'), method: 0 },
    { name: 'empty', bytes: Buffer.alloc(0) }
  ];
  const zip = zipFile(files);

  it('gives the bytes of one file, deflated or stored', () => {
    for (const { name, bytes } of files) {
      expect(zipMember(zip, name)).toEqual(bytes);
    }
  });

  it('reads a zip file that has a comment after its end record', () => {
    const comment = Buffer.from('a comment of the zip file');
    const withComment = Buffer.concat([zip, comment]);
    withComment.writeUInt16LE(comment.length, zip.length - 2);
    expect(zipMember(withComment, 'deno')).toEqual(program);
  });

  it('refuses a name that the zip file does not have', () => {
    expect(() => zipMember(zip, 'deno.exe')).toThrow('The zip file has no file deno.exe.');
    expect(() => zipMember(zip, 'den')).toThrow('The zip file has no file den.');
  });

  it('refuses bytes that are no zip file, and a zip file that is cut', () => {
    expect(() => zipMember(Buffer.from('<html>Not Found</html>'), 'deno')).toThrow(/it has no end record\.$/);
    expect(() => zipMember(zip.subarray(0, zip.length - 30), 'deno')).toThrow(/it has no end record\.$/);
    expect(() => zipMember(Buffer.alloc(0), 'deno')).toThrow(/it has no end record\.$/);
  });

  it('refuses a file that it cannot read as it is: encrypted, or with another compression method', () => {
    const encrypted = zipFile([{ name: 'deno', bytes: program, flags: 1 }]);
    expect(() => zipMember(encrypted, 'deno')).toThrow('Cannot read deno of the zip file: it is encrypted.');
    // 12 is bzip2.
    const bzip2 = zipFile([{ name: 'deno', bytes: program, method: 12 }]);
    expect(() => zipMember(bzip2, 'deno')).toThrow(/^Cannot read deno of the zip file: it has the compression method 12, /);
  });

  it('refuses a file whose data does not inflate, or has another size than the zip file states', () => {
    // The data of the one file starts after its header: 30 bytes, the name,
    // and the extra field of 13 bytes.
    const dataStart = 30 + 'deno'.length + 13;
    const damaged = zipFile([{ name: 'deno', bytes: program }]);
    damaged.fill(0xff, dataStart, dataStart + 4);
    expect(() => zipMember(damaged, 'deno')).toThrow(/^Cannot read deno of the zip file: its data is damaged/);

    // A stored file that is shorter than the zip file states.
    const stored = zipFile([{ name: 'deno', bytes: program, method: 0 }]);
    stored.writeUInt32LE(program.length - 1, stored.lastIndexOf('PK\x01\x02') + 24);
    expect(() => zipMember(stored, 'deno')).toThrow(/^Cannot read deno of the zip file: its data is damaged/);
  });

  it('refuses the Zip64 form, where the sizes are in other records', () => {
    const large = zipFile([{ name: 'deno', bytes: program }]);
    large.writeUInt32LE(0xffffffff, large.lastIndexOf('PK\x01\x02') + 24);
    expect(() => zipMember(large, 'deno')).toThrow(/Zip64 form/);
    const many = zipFile([{ name: 'deno', bytes: program }]);
    many.writeUInt16LE(0xffff, many.length - 12);
    expect(() => zipMember(many, 'deno')).toThrow(/Zip64 form/);
  });
});
