import { describe, expect, it } from 'vitest';
import {
  badPaths,
  fftModule,
  importClosures,
  lockedPackages,
  nativePackages,
  npmTarballUrl,
  readmeLicense,
  skiaCanvasModule,
  skiaDeps
} from './update-libs.js';

describe('lockedPackages', () => {
  const libraries = [
    { folder: 'chart.js', package: 'chart.js', version: '4.6.1' },
    { folder: 'kurkle-color', package: '@kurkle/color', version: '0.3.4' },
    { folder: 'skia-canvas', package: 'skia-canvas', version: '4.0.1', unshippedDependencies: ['detect-libc'] }
  ];
  const lock = npm => ({ version: '5', npm });
  const npm = {
    '@kurkle/color@0.3.4': { integrity: 'sha512-k' },
    'chart.js@4.6.1': { integrity: 'sha512-c', dependencies: ['@kurkle/color'] },
    'detect-libc@2.1.2': { integrity: 'sha512-d' },
    'skia-canvas@4.0.1': { integrity: 'sha512-s', dependencies: ['detect-libc'] }
  };

  it('gives the sha512 of each library by folder, when each dependency is a library or one that Dez does not ship', () => {
    expect(lockedPackages(lock(npm), libraries)).toEqual({ 'chart.js': 'sha512-c', 'kurkle-color': 'sha512-k', 'skia-canvas': 'sha512-s' });
  });

  it('refuses a new dependency that no run could load', () => {
    const more = { ...npm, 'ms@2.1.3': { integrity: 'sha512-m' }, 'chart.js@4.6.1': { integrity: 'sha512-c', dependencies: ['@kurkle/color', 'ms'] } };
    expect(() => lockedPackages(lock(more), libraries)).toThrow(/^chart\.js@4\.6\.1 depends on ms, which Dez does not ship\./);
  });

  it('refuses a library that a package uses at another version than the list', () => {
    const two = {
      ...npm,
      '@kurkle/color@0.3.2': { integrity: 'sha512-o' },
      'chart.js@4.6.1': { integrity: 'sha512-c', dependencies: ['@kurkle/color@0.3.2'] }
    };
    expect(() => lockedPackages(lock(two), libraries)).toThrow('chart.js@4.6.1 uses @kurkle/color 0.3.2, and LIBRARIES has @kurkle/color 0.3.4.');
  });

  it('refuses a package that the lock has at another version or with no sha512, and another lock version', () => {
    const { 'chart.js@4.6.1': chart, ...rest } = npm;
    expect(() => lockedPackages(lock({ ...rest, 'chart.js@4.6.0': chart }), libraries)).toThrow('deno.lock names no sha512 of chart.js@4.6.1.');
    expect(() => lockedPackages(lock({ ...npm, 'chart.js@4.6.1': { ...chart, integrity: 'sha1-c' } }), libraries)).toThrow(
      'deno.lock names no sha512 of chart.js@4.6.1.'
    );
    expect(() => lockedPackages({ version: '4', npm }, libraries)).toThrow('deno.lock has the version 4, and this script reads the version 5.');
  });
});

describe('nativePackages', () => {
  const library = {
    package: 'skia-canvas',
    version: '4.0.1',
    native: {
      packages: {
        'aarch64-unknown-linux-gnu': '@skia-canvas/linux-arm64-glibc',
        'x86_64-unknown-linux-gnu': '@skia-canvas/linux-x64-glibc',
        'aarch64-apple-darwin': '@skia-canvas/darwin-arm64'
      }
    }
  };
  const optionalDependencies = ['@skia-canvas/darwin-arm64', '@skia-canvas/linux-arm64-glibc', '@skia-canvas/linux-x64-glibc', '@skia-canvas/win32-x64'];
  const npm = {
    'skia-canvas@4.0.1': { integrity: 'sha512-s', optionalDependencies },
    '@skia-canvas/darwin-arm64@4.0.1': { integrity: 'sha512-d' },
    '@skia-canvas/linux-arm64-glibc@4.0.1': { integrity: 'sha512-a' },
    '@skia-canvas/linux-x64-glibc@4.0.1': { integrity: 'sha512-x' }
  };

  it('gives the package file and the sha512 of the native package of each build target', () => {
    expect(nativePackages({ npm }, library)).toEqual([
      {
        target: 'aarch64-unknown-linux-gnu',
        package: '@skia-canvas/linux-arm64-glibc',
        version: '4.0.1',
        url: 'https://registry.npmjs.org/@skia-canvas/linux-arm64-glibc/-/linux-arm64-glibc-4.0.1.tgz',
        integrity: 'sha512-a'
      },
      {
        target: 'x86_64-unknown-linux-gnu',
        package: '@skia-canvas/linux-x64-glibc',
        version: '4.0.1',
        url: 'https://registry.npmjs.org/@skia-canvas/linux-x64-glibc/-/linux-x64-glibc-4.0.1.tgz',
        integrity: 'sha512-x'
      },
      {
        target: 'aarch64-apple-darwin',
        package: '@skia-canvas/darwin-arm64',
        version: '4.0.1',
        url: 'https://registry.npmjs.org/@skia-canvas/darwin-arm64/-/darwin-arm64-4.0.1.tgz',
        integrity: 'sha512-d'
      }
    ]);
  });

  it('refuses a native package that the library does not name, or that the lock has no sha512 of', () => {
    const fewer = { ...npm, 'skia-canvas@4.0.1': { integrity: 'sha512-s', optionalDependencies: optionalDependencies.slice(1) } };
    expect(() => nativePackages({ npm: fewer }, library)).toThrow('skia-canvas 4.0.1 names no native package @skia-canvas/darwin-arm64.');
    const { '@skia-canvas/linux-x64-glibc@4.0.1': _, ...noSha } = npm;
    expect(() => nativePackages({ npm: { ...noSha, '@skia-canvas/linux-x64-glibc@4.0.0': {} } }, library)).toThrow(
      'deno.lock names no sha512 of @skia-canvas/linux-x64-glibc@4.0.0.'
    );
  });

  it('refuses a build target with no native package in the list', () => {
    const { 'aarch64-apple-darwin': _, ...packages } = library.native.packages;
    expect(() => nativePackages({ npm }, { ...library, native: { packages } })).toThrow(
      'LIBRARIES names no native package of skia-canvas for the target aarch64-apple-darwin.'
    );
  });
});

describe('npmTarballUrl', () => {
  it('names the package file without the scope of the package', () => {
    expect(npmTarballUrl('three', '0.187.0')).toBe('https://registry.npmjs.org/three/-/three-0.187.0.tgz');
    expect(npmTarballUrl('@kurkle/color', '0.3.4')).toBe('https://registry.npmjs.org/@kurkle/color/-/color-0.3.4.tgz');
  });
});

describe('fftModule', () => {
  const source = "'use strict';\n\nfunction FFT(size) {\n  this.size = size;\n}\nmodule.exports = FFT;\n";

  it('makes an ES module whose default export is what the CommonJS file exports', async () => {
    const module = await import(`data:text/javascript,${encodeURIComponent(fftModule(source))}`);
    expect(new module.default(8).size).toBe(8);
  });

  it('refuses a file of another form', () => {
    expect(() => fftModule('export default FFT;\n')).toThrow(/^lib\/fft\.js of fft\.js has no line `module\.exports = FFT;`/);
  });
});

describe('readmeLicense', () => {
  it('gives the text of the license section, up to the next heading', () => {
    const readme = '# fft.js\n\nText.\n\n#### LICENSE\n\nThis software is licensed under the MIT License.\n\nPermission is hereby granted.\n\n## More\n\nOther.\n';
    expect(readmeLicense(readme)).toBe('This software is licensed under the MIT License.\n\nPermission is hereby granted.\n');
  });

  it('gives the text up to the end of a README that ends with it', () => {
    expect(readmeLicense('# a\n\n#### LICENSE\n\nMIT\n')).toBe('MIT\n');
  });

  it('refuses a README with no license section', () => {
    expect(() => readmeLicense('# fft.js\n\nThe license is MIT.\n')).toThrow('The README of fft.js has no section LICENSE.');
  });
});

describe('skiaCanvasModule', () => {
  const indexMjs = `import skia_canvas from './index.js'

const { Canvas, Image } = skia_canvas

export {
  skia_canvas as default,
  Canvas, Image,
  App,
}
`;

  it('exports each name of the export list of index.mjs, and the module as the default', () => {
    const text = skiaCanvasModule(indexMjs);
    expect(text).toContain("const skiaCanvas = createRequire(import.meta.url)('./index.js');");
    expect(text).toContain('export default skiaCanvas;');
    expect(text).toContain('export const {\n  Canvas,\n  Image,\n  App,\n} = skiaCanvas;\n');
  });

  it('refuses a list that renames an export, and a file with no list', () => {
    expect(() => skiaCanvasModule(indexMjs.replace('App,', 'App as Application,'))).toThrow(
      'lib/index.mjs of skia-canvas exports in a form that the script does not read: App as Application.'
    );
    expect(() => skiaCanvasModule("export * from './index.js'\n")).toThrow(/^lib\/index\.mjs of skia-canvas has no `export \{ … \}` list/);
  });
});

describe('skiaDeps', () => {
  const deps = `vars = {
  "checkout_chromium": False,
}

deps = {
  "buildtools"                            : "https://chromium.googlesource.com/chromium/src/buildtools.git@${'0'.repeat(40)}",
  "third_party/externals/brotli"          : "https://skia.googlesource.com/external/github.com/google/brotli.git@${'a'.repeat(40)}",
  #"third_party/externals/dawn"           : "https://dawn.googlesource.com/dawn.git@${'b'.repeat(40)}",
  "third_party/externals/vulkanmemoryallocator" : "https://chromium.googlesource.com/external/github.com/GPUOpen-LibrariesAndSDKs/VulkanMemoryAllocator@${'c'.repeat(40)}",
}
`;

  it('gives the URL and the commit of each library of third_party/externals, but not those of comments', () => {
    expect(skiaDeps(deps)).toEqual([
      { name: 'brotli', url: 'https://skia.googlesource.com/external/github.com/google/brotli', commit: 'a'.repeat(40) },
      {
        name: 'vulkanmemoryallocator',
        url: 'https://chromium.googlesource.com/external/github.com/GPUOpen-LibrariesAndSDKs/VulkanMemoryAllocator',
        commit: 'c'.repeat(40)
      }
    ]);
  });

  it('refuses a library in another form, so that none is missed', () => {
    const other = `${deps}  "third_party/externals/zlib": Var("zlib_url") + "@${'d'.repeat(40)}",\n`;
    expect(() => skiaDeps(other)).toThrow(/^The DEPS file of Skia names a library in a form that the script does not read: "third_party\/externals\/zlib"/);
  });
});

describe('importClosures', () => {
  // A module graph as `deno info --json` gives it: the entry imports each
  // root, and `link` is a resolved import of a module.
  const link = specifier => ({ specifier, code: { specifier } });
  const info = {
    roots: ['file:///w/entry.js'],
    modules: [
      {
        kind: 'esm',
        specifier: 'file:///w/entry.js',
        dependencies: [link('a'), link('b'), link('c'), { specifier: 'd', code: { error: 'Import "d" not in import map' } }, link('e')]
      },
      { kind: 'esm', specifier: 'file:///l/a.js', dependencies: [link('file:///l/shared.js'), link('node:module')] },
      { kind: 'esm', specifier: 'file:///l/shared.js', dependencies: [link('file:///l/a.js')] },
      {
        kind: 'esm',
        specifier: 'file:///l/b.js',
        dependencies: [link('file:///l/shared.js'), { specifier: './types.d.ts', type: { specifier: 'file:///l/types.d.ts' } }]
      },
      { kind: 'esm', specifier: 'file:///l/types.d.ts', dependencies: [] },
      { kind: 'esm', specifier: 'file:///l/c.js', dependencies: [link('file:///l/gone.js')] },
      { specifier: 'file:///l/gone.js', error: 'Module not found "file:///l/gone.js".' },
      { kind: 'esm', specifier: 'file:///l/e.js', dependencies: [link('npm:ms@2')] },
      { kind: 'npm', specifier: 'npm:ms@2' }
    ],
    redirects: { a: 'file:///l/a.js', b: 'file:///l/b.js', c: 'file:///l/c.js', e: 'file:///l/e.js' }
  };
  const closures = importClosures(info);

  it('gives each file that an import loads, through cycles, redirects, and type imports, and no Node module', () => {
    expect(closures.get('a')).toEqual({ files: ['file:///l/a.js', 'file:///l/shared.js'] });
    expect(closures.get('b')).toEqual({ files: ['file:///l/a.js', 'file:///l/b.js', 'file:///l/shared.js', 'file:///l/types.d.ts'] });
  });

  it('gives the problem of an import that does not resolve, loads a missing file, or loads a module that is no file', () => {
    expect(closures.get('c')).toEqual({ problem: 'Module not found "file:///l/gone.js".' });
    expect(closures.get('d')).toEqual({ problem: 'Import "d" not in import map' });
    expect(closures.get('e')).toEqual({ problem: 'npm:ms@2 is not a file of the libraries' });
  });
});

describe('badPaths', () => {
  it('gives the paths that the rule of the app files refuses', () => {
    const paths = ['three/build/three.module.js', '@kurkle/color/LICENSE.md', 'a/b c.js', 'a/../b.js', 'a/./b.js', 'chart.js/dist/chunks/helpers.dataset.js'];
    expect(badPaths(paths)).toEqual(['@kurkle/color/LICENSE.md', 'a/b c.js', 'a/../b.js', 'a/./b.js']);
  });
});
