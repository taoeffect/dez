import { describe, expect, it } from 'vitest';
import { bumpedFiles, versionMismatches } from './bump-version.js';

const json = data => `${JSON.stringify(data, null, 2)}\n`;

// Short copies of the five version files, all at `version`. Cargo.lock has a
// package with the same version before `dez`, which a bump must not change.
function versionFiles(version) {
  return {
    'package.json': json({ name: 'dez', version }),
    'package-lock.json': json({ name: 'dez', version, packages: { '': { name: 'dez', version } } }),
    'src-tauri/tauri.conf.json': json({ productName: 'Dez', version }),
    'src-tauri/Cargo.toml': `[package]\nname = "dez"\nversion = "${version}"\n\n[dependencies]\nserde = "1"\n`,
    'src-tauri/Cargo.lock': `version = 4\n\n[[package]]\nname = "dbus"\nversion = "${version}"\n\n[[package]]\nname = "dez"\nversion = "${version}"\n`
  };
}

describe('versionMismatches', () => {
  it('lists every file when the tag is newer than the files, as for v0.12.1', () => {
    expect(versionMismatches('0.12.1', versionFiles('0.12.0'))).toEqual([
      { path: 'package.json', found: ['0.12.0'] },
      { path: 'package-lock.json', found: ['0.12.0', '0.12.0'] },
      { path: 'src-tauri/tauri.conf.json', found: ['0.12.0'] },
      { path: 'src-tauri/Cargo.toml', found: ['0.12.0'] },
      { path: 'src-tauri/Cargo.lock', found: ['0.12.0'] }
    ]);
  });

  it('finds one stale field in a file whose other field matches', () => {
    const files = versionFiles('0.12.1');
    files['package-lock.json'] = json({ version: '0.12.1', packages: { '': { version: '0.12.0' } } });
    expect(versionMismatches('0.12.1', files)).toEqual([
      { path: 'package-lock.json', found: ['0.12.1', '0.12.0'] }
    ]);
  });

  it('reports a file with no version line, which a bump refuses to update', () => {
    const files = versionFiles('0.12.1');
    files['src-tauri/Cargo.toml'] = '[package]\nname = "dez"\n';
    expect(versionMismatches('0.12.1', files)).toEqual([
      { path: 'src-tauri/Cargo.toml', found: [undefined] }
    ]);
    expect(() => bumpedFiles('0.12.2', files)).toThrow(/Could not update src-tauri\/Cargo\.toml/);
  });
});

describe('bumpedFiles', () => {
  it('updates every file so that the check passes, and only the dez package in Cargo.lock', () => {
    const files = { ...versionFiles('0.12.0'), ...bumpedFiles('0.12.1', versionFiles('0.12.0')) };
    expect(versionMismatches('0.12.1', files)).toEqual([]);
    expect(files['src-tauri/Cargo.lock']).toContain('name = "dbus"\nversion = "0.12.0"');
  });
});
