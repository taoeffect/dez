import { describe, expect, it } from 'vitest';
import { denoSourceLicenses } from './deno-licenses.js';
import { tarGzFile } from './testing.js';

describe('denoSourceLicenses', () => {
  it('gives the lock and the license files of the source, but not those of its tests', () => {
    const archive = tarGzFile([
      { name: 'deno/Cargo.lock', text: 'version = 4\n' },
      { name: 'deno/LICENSE.md', text: 'MIT License\n' },
      { name: 'deno/cli/tsc/dts/node/LICENSE', text: 'MIT, DefinitelyTyped\n' },
      { name: 'deno/tests/registry/npm/chalk/LICENSE', text: 'MIT, chalk\n' },
      { name: 'deno/cli/main.rs', text: 'fn main() {}' }
    ]);
    expect(denoSourceLicenses(archive)).toEqual({
      lock: 'version = 4\n',
      files: [
        { path: 'LICENSE.md', text: 'MIT License' },
        { path: 'cli/tsc/dts/node/LICENSE', text: 'MIT, DefinitelyTyped' }
      ]
    });
  });

  it('refuses a source with no lock, as nothing names the crates of the program', () => {
    const archive = tarGzFile([{ name: 'deno/LICENSE.md', text: 'MIT License\n' }, { name: 'deno/cli/Cargo.lock', text: '' }]);
    expect(() => denoSourceLicenses(archive)).toThrow(/^The Deno source of the release has no Cargo\.lock, /);
  });
});
