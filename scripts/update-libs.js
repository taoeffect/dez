#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  BINARIES_DIR,
  LIBS_DIR,
  LIBS_MANIFEST_NAME,
  MANIFEST_NAME,
  NATIVE_MODE,
  TARGETS,
  checkHostProgram,
  downloadBytes,
  hostTriple,
  isPinnedFile,
  manifestFileText,
  tgzMember
} from './bundled-programs.js';
import {
  downloadedCrateLicenses,
  githubFile,
  githubRepositorySources,
  githubTagCommit,
  licenseTextsFile,
  lockedCrates,
  repositoryLicenses
} from './license-texts.js';
import { DENO_VERSION_CALL } from './update-deno.js';

// Vendors the libraries that Dez ships for the code of its runs (`js_eval`,
// the script apps, the UI apps) into src-tauri/libs/: the npm packages of
// LIBRARIES at the versions of the list, with only the files that their
// imports load, an import map, the license texts, and a manifest.
//
// The libraries ship in the app bundle (`bundle.resources`), never in a Dez
// folder: each run reads them there, read only, by their bare names through
// import_map.json.
//
// The files are in Git: they are text, Dez ships them as they are, and a
// review sees each change. The one exception is the native file of
// skia-canvas (lib/skia.node, one file for each platform, about 37 MB):
// manifest.json pins it for each build target (the npm package with its
// size and SHA-256, and the native file in it), Git ignores it, and
// scripts/fetch-programs.js gets the file of a build target from that pin.
// src-tauri/build.rs checks every file of the manifest in every build.
//
// How:
//
// 1. The bundled Deno gets the packages (`deno add`, in a new project with a
//    new Deno cache). Its lock file names each package with the sha512 that
//    the registry states, which Deno checked.
// 2. The script takes the files that the entries of the import map load
//    (the module graph of `deno info`), and the addons of three.js in
//    THREE_ADDON_FOLDERS whose modules all load: an addon that needs a part
//    of three.js that Dez does not ship (WebGPU, TSL) is left out.
// 3. It downloads the native package of skia-canvas of each build target,
//    checks it against the sha512 of the lock, and takes the native file out.
// 4. It runs the libraries of this computer in the bundled Deno, with the
//    flags of a run of Dez: each import loads, and skia-canvas draws.
//
// The script owns its library folders, import_map.json, and manifest.json.
// The folders of OWN_LIBRARIES are Dez's code, in Git: the script names
// them in the import map and loads them in its checks, but never changes
// them, and the manifest pins none of their files. Another folder of
// src-tauri/libs/ stays as it is.

const USAGE = `Vendor the libraries that Dez ships for the code of its runs into src-tauri/libs/.

Usage:
  node scripts/update-libs.js

The libraries and their versions are the list LIBRARIES of the script:
change the list for another version. The script runs the dez-deno program
of this computer (node scripts/fetch-programs.js gets it). It downloads the
npm packages, the native packages of skia-canvas for every build target,
and the sources of the license texts of the native file: the Rust crates
that it is built with, and the license files of Skia and its libraries.`;

// The folders of three.js (below examples/jsm/) whose addons Dez ships.
// The other folders hold parts for WebGPU, WebXR, or a browser page only,
// or files that need a decoder that Dez does not ship (DRACO, Basis).
const THREE_ADDON_FOLDERS = [
  'animation',
  'controls',
  'curves',
  'environments',
  'exporters',
  'geometries',
  'helpers',
  'lines',
  'loaders',
  'math',
  'modifiers',
  'postprocessing',
  'shaders',
  'utils'
];

// The licenses that Dez ships a library with, each with a sentence that its
// text must hold. A package states its license in package.json, and its
// license file must be that license.
const ALLOWED_LICENSES = { MIT: 'Permission is hereby granted, free of charge, to any person obtaining a copy' };

// The libraries. For each one:
//
// - `folder`: its folder in src-tauri/libs/ (a name that the apps tool and
//   the app scheme take: no `@` or `/`).
// - `package`, `version`, `repository`: the npm package, and its source.
// - `licenseFile`: its license text, in its folder.
// - `imports`: the entries of the import map, each a path in its folder. A
//   name that ends with `/` maps a prefix (`three/addons/`).
// - `files`: files that the module graph does not find, as a run loads them
//   with `require` (CommonJS). A path that ends with `/` is every file of
//   that folder.
// - `generated(read)`: files that the script writes into the folder, from
//   the text of the files of the package (`read(path)`).
// - `unshippedDependencies`: npm dependencies of the package that Dez does
//   not ship, as the code of the package loads them only for a part that
//   Dez does not offer (skia-canvas: the images of a URL, sharp).
// - `native`: the native file of the library (`file`, in its folder), and
//   the npm package that has it for each build target, as `member`. Its
//   license texts come from `repository` at the tag `v<version>`.
export const LIBRARIES = [
  {
    folder: 'three',
    package: 'three',
    version: '0.187.0',
    repository: 'https://github.com/mrdoob/three.js',
    licenseFile: 'LICENSE',
    imports: { three: 'build/three.module.js', 'three/addons/': 'examples/jsm/' },
    addons: { prefix: 'three/addons/', folders: THREE_ADDON_FOLDERS }
  },
  {
    folder: 'chart.js',
    package: 'chart.js',
    version: '4.6.1',
    repository: 'https://github.com/chartjs/Chart.js',
    licenseFile: 'LICENSE.md',
    imports: { 'chart.js': 'dist/chart.js', 'chart.js/auto': 'auto/auto.js', 'chart.js/helpers': 'helpers/helpers.js' }
  },
  {
    folder: 'kurkle-color',
    package: '@kurkle/color',
    version: '0.3.4',
    repository: 'https://github.com/kurkle/color',
    licenseFile: 'LICENSE.md',
    imports: { '@kurkle/color': 'dist/color.esm.js' }
  },
  {
    folder: 'fft.js',
    package: 'fft.js',
    version: '4.0.4',
    repository: 'https://github.com/indutny/fft.js',
    licenseFile: 'LICENSE',
    imports: { 'fft.js': 'lib/fft.esm.js' },
    generated: read => ({ 'lib/fft.esm.js': fftModule(read('lib/fft.js')), LICENSE: readmeLicense(read('README.md')) })
  },
  {
    folder: 'skia-canvas',
    package: 'skia-canvas',
    version: '4.0.1',
    repository: 'https://github.com/samizdatco/skia-canvas',
    licenseFile: 'LICENSE',
    imports: { 'skia-canvas': 'lib/mod.mjs' },
    files: ['lib/index.js', 'lib/urls.js', 'lib/classes/', 'lib/fonts/fonts.conf', 'lib/index.d.ts'],
    generated: read => ({ 'lib/mod.mjs': skiaCanvasModule(read('lib/index.mjs')), 'lib/package.json': COMMONJS_PACKAGE }),
    unshippedDependencies: ['detect-libc', 'follow-redirects', 'https-proxy-agent'],
    native: {
      file: 'lib/skia.node',
      member: 'package/skia.node',
      packages: {
        'aarch64-unknown-linux-gnu': '@skia-canvas/linux-arm64-glibc',
        'x86_64-unknown-linux-gnu': '@skia-canvas/linux-x64-glibc',
        'aarch64-apple-darwin': '@skia-canvas/darwin-arm64'
      }
    }
  }
];

// Dez's own libraries: folders of src-tauri/libs/ that hold Dez's code, not
// an npm package. `imports` as in LIBRARIES. dez-media imports fft.js by a
// relative path, so it loads only next to the vendored libraries.
// 'dez-media/canvas' imports skia-canvas, and 'dez-media/frames' writes
// files with node:fs, so only a Deno run loads them.
export const OWN_LIBRARIES = [
  { folder: 'dez-media', imports: { 'dez-media': 'mod.js', 'dez-media/canvas': 'canvas.js', 'dez-media/frames': 'frames.js' } }
];

// The names of the files that the script writes next to the library
// folders.
const IMPORT_MAP = 'import_map.json';
const MANIFEST = 'manifest.json';
// The license texts of a native file, in the folder of its library.
const NATIVE_LICENSES = 'NATIVE-LICENSES.txt';

// The package.json of a folder of CommonJS files (`require` of a `.js`
// file). Deno takes a `.js` file as CommonJS by the `type` of the closest
// package.json: with none of its own, the file would follow a package.json
// above the libs folder, such as that of this repository (`"type":
// "module"`) in a debug build. The libs ship no package.json of their
// packages.
const COMMONJS_PACKAGE = '{ "type": "commonjs" }\n';

// The Git repository of the Rust bindings of Skia, which skia-canvas is
// built with, and the path of its Skia submodule.
const RUST_SKIA_REPO = 'rust-skia/rust-skia';
const SKIA_SUBMODULE = 'skia-bindings/skia';

// The environment variables that skia-canvas reads (the place of its
// fonts, a proxy for the images of a URL, the strict mode of its checks).
// A run of Dez with skia-canvas allows exactly these.
const SKIA_CANVAS_ENV = [
  'SKIA_CANVAS_STRICT',
  'LC_ALL',
  'LC_MESSAGES',
  'LANG',
  'LANGUAGE',
  'https_proxy',
  'HTTPS_PROXY',
  'http_proxy',
  'HTTP_PROXY'
];

// The arguments: none, or a call for the usage text. Throws for anything
// else.
export function parseArgs(args) {
  if (args.length === 0) return {};
  if (args.length === 1 && ['-h', '--help'].includes(args[0])) return { help: true };
  throw new Error(`Expected no argument, got: ${args.join(' ')}`);
}

// The import map of the libraries, as a run reads it: each entry is a path
// relative to the map, so the map works in any place of the libs folder
// (the app bundle has another place on each computer, and an AppImage on
// each start).
export function importMap(libraries) {
  const imports = {};
  for (const library of libraries) {
    for (const [name, path] of Object.entries(library.imports)) {
      imports[name] = `./${library.folder}/${path}`;
    }
  }
  return { imports };
}

// The text of a JSON file that the script writes.
function jsonText(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

// The package name of a dependency of a package in deno.lock: the lock
// writes `name` when it has one version of the package, else
// `name@version`.
function dependencyName(dependency) {
  const at = dependency.indexOf('@', 1);
  return at < 0 ? dependency : dependency.slice(0, at);
}

// The name and the version of a dependency of a package in deno.lock
// (`dependencyName`).
function lockDependency(npm, dependency) {
  const name = dependencyName(dependency);
  if (name !== dependency) return { name, version: dependency.slice(name.length + 1) };
  const versions = Object.keys(npm)
    .filter(key => key.startsWith(`${name}@`))
    .map(key => key.slice(name.length + 1));
  if (versions.length !== 1) {
    throw new Error(`deno.lock names ${versions.length} versions of ${name}, and the script cannot tell which one a package uses.`);
  }
  return { name, version: versions[0] };
}

// The sha512 integrity that deno.lock (the text of the lock file, version
// 5) names for the package of each library, by folder. Throws unless the
// lock has each package at the version of the list, and each dependency of
// a package is a library of the list at its version, or one of its
// `unshippedDependencies`: a new dependency of a new version would be a
// module that no run can load.
export function lockedPackages(lock, libraries) {
  if (lock.version !== '5') {
    throw new Error(`deno.lock has the version ${lock.version}, and this script reads the version 5.`);
  }
  const npm = lock.npm ?? {};
  const byPackage = new Map(libraries.map(library => [library.package, library]));
  return Object.fromEntries(
    libraries.map(library => {
      const key = `${library.package}@${library.version}`;
      const entry = npm[key];
      if (!/^sha512-/.test(entry?.integrity ?? '')) {
        throw new Error(`deno.lock names no sha512 of ${key}.`);
      }
      for (const dependency of entry.dependencies ?? []) {
        const { name, version } = lockDependency(npm, dependency);
        const shipped = byPackage.get(name);
        if (shipped && shipped.version !== version) {
          throw new Error(`${key} uses ${name} ${version}, and LIBRARIES has ${name} ${shipped.version}.`);
        }
        if (!shipped && !(library.unshippedDependencies ?? []).includes(name)) {
          throw new Error(
            `${key} depends on ${name}, which Dez does not ship. Add it to LIBRARIES, or to the unshippedDependencies ` +
              'of the library when the library loads it only for a part that Dez does not offer.'
          );
        }
      }
      return [library.folder, entry.integrity];
    })
  );
}

// The URL of the package file of an npm package in the npm registry.
export function npmTarballUrl(name, version) {
  const base = name.slice(name.lastIndexOf('/') + 1);
  return `https://registry.npmjs.org/${name}/-/${base}-${version}.tgz`;
}

// The native packages of a library (`library.native`) for each build
// target: the package, the URL of its package file, and the sha512 that
// deno.lock names for it. Throws unless the package of the library names
// the native package as an optional dependency, and the lock has its
// sha512.
export function nativePackages(lock, library) {
  const npm = lock.npm ?? {};
  const optional = npm[`${library.package}@${library.version}`]?.optionalDependencies ?? [];
  return TARGETS.map(target => {
    const name = library.native.packages[target];
    if (!name) {
      throw new Error(`LIBRARIES names no native package of ${library.package} for the target ${target}.`);
    }
    const dependency = optional.find(candidate => dependencyName(candidate) === name);
    if (!dependency) {
      throw new Error(`${library.package} ${library.version} names no native package ${name}.`);
    }
    const { version } = lockDependency(npm, dependency);
    const integrity = npm[`${name}@${version}`]?.integrity;
    if (!/^sha512-/.test(integrity ?? '')) {
      throw new Error(`deno.lock names no sha512 of ${name}@${version}.`);
    }
    return { target, package: name, version, url: npmTarballUrl(name, version), integrity };
  });
}

// The sha512 integrity (as npm and deno.lock write it) of some bytes.
export function sha512Integrity(bytes) {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
}

// The size and the SHA-256 of some bytes, as a pin of a manifest.
function bytesPin(bytes) {
  return { size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}

// The ES module form of lib/fft.js of fft.js, which is CommonJS: an import
// loads a `.js` file as an ES module (in Deno, unless the closest
// package.json states `"type": "commonjs"`), and a UI page has no
// `require`. The code of the file is the same; only `module` comes from
// the lines around it.
export function fftModule(source) {
  if (!/^module\.exports = FFT;$/m.test(source)) {
    throw new Error('lib/fft.js of fft.js has no line `module.exports = FFT;`: check its form by hand.');
  }
  return (
    '// The ES module form of lib/fft.js (CommonJS), written by scripts/update-libs.js.\n' +
    'const module = { exports: {} };\n' +
    `${source.replace(/\n$/, '')}\n` +
    'export default module.exports;\n'
  );
}

// The license text of a package that has it only in its README (fft.js):
// the text of the section `#### LICENSE`, up to the next heading.
export function readmeLicense(readme) {
  const match = /^#+ LICENSE[^\S\n]*\n([\s\S]*?)(?=^#|(?![\s\S]))/m.exec(readme);
  const text = match?.[1].trim();
  if (!text) {
    throw new Error('The README of fft.js has no section LICENSE.');
  }
  return `${text}\n`;
}

// The names of the `export { … }` list of lib/index.mjs of skia-canvas,
// and the ES module entry for Dez with them (lib/mod.mjs).
//
// Why not index.mjs itself: it imports the CommonJS file index.js with an
// `import` of its default export, and Deno 2.9 refuses that import (no
// export `default`). lib/mod.mjs loads index.js with `require`, as Node does.
export function skiaCanvasModule(indexMjs) {
  const list = /^export \{([^}]*)\}/m.exec(indexMjs)?.[1];
  if (list === undefined) {
    throw new Error('lib/index.mjs of skia-canvas has no `export { … }` list: check its form by hand.');
  }
  const names = list
    .split(',')
    .map(name => name.trim())
    .filter(name => name !== '' && !/^\w+ as default$/.test(name));
  const bad = names.filter(name => !/^[A-Za-z_$][\w$]*$/.test(name));
  if (bad.length > 0) {
    throw new Error(`lib/index.mjs of skia-canvas exports in a form that the script does not read: ${bad.join(', ')}.`);
  }
  return `// The ES module entry of skia-canvas for Dez, written by scripts/update-libs.js
// from lib/index.mjs. The package is CommonJS, so this file loads index.js
// with \`require\`, as Node does.
import { createRequire } from 'node:module';

const skiaCanvas = createRequire(import.meta.url)('./index.js');

export default skiaCanvas;
export const {
${names.map(name => `  ${name},`).join('\n')}
} = skiaCanvas;
`;
}

// The libraries of the DEPS file of Skia (the text of the file): the name,
// the Git URL, and the pinned commit of each one. Throws for a line that
// names a library in another form, so that none is missed.
export function skiaDeps(deps) {
  return deps.split('\n').flatMap(line => {
    if (/^\s*#/.test(line) || !line.includes('third_party/externals/')) return [];
    const match = /^\s*"third_party\/externals\/([^"]+)"\s*:\s*"([^"@]+)@([0-9a-f]{40})",?$/.exec(line);
    if (!match) {
      throw new Error(`The DEPS file of Skia names a library in a form that the script does not read: ${line.trim()}`);
    }
    return [{ name: match[1], url: match[2].replace(/\.git$/, ''), commit: match[3] }];
  });
}

// The files of each import of a module graph: `info` is the JSON of
// `deno info --json` for an entry that imports each root, and the result
// maps each import of the entry (as the entry writes it) to the `file:`
// URLs of the modules that it loads, or to the problem that stops it.
//
// A module of Node (`node:module`) loads with no file. Anything else that
// is not a file (an `npm:` or a remote module), or a module that does not
// resolve or load, is a problem: Dez runs with no network and no npm.
export function importClosures(info) {
  const modules = new Map(info.modules.map(module => [module.specifier, module]));
  const redirects = info.redirects ?? {};
  const closure = dependency => {
    const files = new Set();
    const seen = new Set();
    const pending = [dependency];
    while (pending.length > 0) {
      const next = pending.pop();
      for (const link of [next.code, next.type]) {
        if (!link) continue;
        if (link.error) return { problem: link.error };
        let specifier = link.specifier;
        while (Object.hasOwn(redirects, specifier)) specifier = redirects[specifier];
        if (seen.has(specifier)) continue;
        seen.add(specifier);
        if (specifier.startsWith('node:')) continue;
        const module = modules.get(specifier);
        if (module?.kind === 'node') continue;
        if (!module || module.error) return { problem: module?.error ?? `deno info gives no module ${specifier}` };
        if (!specifier.startsWith('file:')) return { problem: `${specifier} is not a file of the libraries` };
        files.add(specifier);
        pending.push(...(module.dependencies ?? []));
      }
    }
    return { files: [...files].sort() };
  };
  const entry = modules.get(info.roots[0]);
  return new Map((entry?.dependencies ?? []).map(dependency => [dependency.specifier, closure(dependency)]));
}

// The paths (relative, with `/`) that a run of Dez cannot open, with a
// segment that the rule of the app files refuses (`is_app_file_segment`,
// src-tauri/src/persistence.rs): the apps tool reads the libraries.
export function badPaths(paths) {
  return paths.filter(path => path.split('/').some(segment => !/^[A-Za-z0-9._-]+$/.test(segment) || segment === '.' || segment === '..'));
}

// The text of src-tauri/libs/manifest.json. `libraries` holds, by folder,
// the facts of each library (the Help page names them) and the pins of its
// native file; `files` the size and the SHA-256 of each file in Git that
// the script writes (build.rs checks them).
export function manifestText(libraries, files) {
  return manifestFileText({
    libraries,
    files: Object.fromEntries(Object.keys(files).sort().map(path => [path, files[path]]))
  });
}

// The first lines of NATIVE-LICENSES.txt of a library, before the license
// texts (`licenseTextsFile`).
function nativeLicensesIntro(library, facts) {
  const packages = Object.values(library.native.packages).map(name => `- ${name}`);
  return `The license texts of the native file of ${library.package} ${library.version} (${library.native.file}),
which Dez ships with the library. The file is the build of the ${library.package}
project for each platform, from these npm packages:

${packages.join('\n')}

Written by scripts/update-libs.js. Do not edit it by hand.

The native file holds the Rust code of ${library.package}, the Rust crates that
it is built with, and Skia with the libraries that Skia is built with. The
project publishes no list of them, so the texts come from a rule: each file
with the name of a license file (LICENSE, COPYING, NOTICE, and the like) of
these sources, but not the files of their tests:

- ${library.package} at the tag v${library.version} (${facts.commit}), with its Cargo.lock.
- rust-skia (https://github.com/${RUST_SKIA_REPO}) at the version of the
  skia-bindings crate (${facts.rustSkiaVersion}), with all of its Skia submodule.
- The top folder of each library of the DEPS file of that Skia source, at
  the commit that it pins.
- Each Rust crate that Cargo.lock names, from the crate file of crates.io
  that the lock pins.

Each license text is in this file once. The lines between the two rule lines
before a text name each file that has this text: the source, then the path of
the file in that source. The list of the Rust crates, each with the license
that it states, is at the end of the file.

The rule takes more than the native file holds: a crate that only another
platform uses, a tool of the build, or a library that the build of Skia does
not take. So a text in this file does not tell that the native file holds
the code of that text.`;
}

// The text of NATIVE-LICENSES.txt of a library with a native file (the
// intro, `nativeLicensesIntro`, tells the sources).
async function nativeLicensesText(library, log) {
  const repo = /^https:\/\/github\.com\/([^/]+\/[^/]+)$/.exec(library.repository)?.[1];
  if (!repo) throw new Error(`The script reads the license texts of a native file only from GitHub, not ${library.repository}.`);
  const commit = await githubTagCommit(repo, `v${library.version}`);
  const own = await githubRepositorySources(repo, commit, `${library.package} ${library.version}`, [], log);
  const crates = lockedCrates((await githubFile(repo, commit, 'Cargo.lock')).toString('utf8'));

  const bindings = crates.filter(crate => crate.name === 'skia-bindings').map(crate => crate.version);
  if (bindings.length !== 1) {
    throw new Error(`Cargo.lock of ${library.package} names ${bindings.length} versions of skia-bindings, and the script reads one.`);
  }
  const rustSkiaVersion = bindings[0];
  const rustSkiaCommit = await githubTagCommit(RUST_SKIA_REPO, rustSkiaVersion);
  const rustSkia = await githubRepositorySources(
    RUST_SKIA_REPO,
    rustSkiaCommit,
    `rust-skia ${rustSkiaVersion}`,
    [SKIA_SUBMODULE],
    log
  );
  const skia = rustSkia.submodules.find(submodule => submodule.path === SKIA_SUBMODULE);
  const skiaRepo = /^https:\/\/github\.com\/([^/]+\/[^/]+)$/.exec(skia?.url ?? '')?.[1];
  if (!skiaRepo) {
    throw new Error(`rust-skia ${rustSkiaVersion} has no submodule ${SKIA_SUBMODULE} on GitHub, so the script cannot read the DEPS file of Skia.`);
  }

  const deps = skiaDeps((await githubFile(skiaRepo, skia.commit, 'DEPS')).toString('utf8'));
  log(`Reading the license files of the ${deps.length} libraries of the DEPS file of Skia`);
  const depSources = [];
  // One host at a time gets requests: the libraries run one after another.
  for (const { name, url, commit: pinned } of deps) {
    depSources.push({ title: `Skia library ${name} (${url} at ${pinned})`, files: await repositoryLicenses(url, pinned, false) });
  }

  const crateLicenseList = await downloadedCrateLicenses(crates, log);
  const sources = [
    ...own.sources,
    ...rustSkia.sources,
    ...depSources,
    ...crateLicenseList.map(crate => ({ title: `crate ${crate.name} ${crate.version}`, files: crate.files }))
  ];
  const crateList = crateLicenseList.map(({ name, version, license }) => ({ name, version, license }));
  return licenseTextsFile(nativeLicensesIntro(library, { commit, rustSkiaVersion }), sources, crateList);
}

// The files below `dir`, as paths relative to it with `/`, in order.
function filesBelow(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => relative(dir, join(entry.parentPath, entry.name)).split(sep).join('/'))
    .sort();
}

// Runs the bundled Deno with `args` in `cwd`. Gives its output; throws with
// its error output when it fails. The environment has only what Deno needs,
// as in a run of Dez: the Deno cache of the script, no update check, and no
// colors. `userEnv` adds to it (the network settings of the user, for
// `deno add`).
function runDeno(deno, args, { cwd, denoDir, userEnv = {} }) {
  const env = { ...userEnv, DENO_DIR: denoDir, DENO_NO_UPDATE_CHECK: '1', NO_COLOR: '1' };
  const result = spawnSync(deno, args, { cwd, env, encoding: 'utf8', maxBuffer: 1 << 30 });
  if (result.error || result.status !== 0) {
    throw new Error(`deno ${args[0]} failed: ${result.error?.message ?? result.stderr.trim()}`);
  }
  return result.stdout;
}

// The roots of the module graph of the libraries in `dir` (the import
// specifiers that an entry imports): each entry of the import map, and each
// addon (`library.addons`) by its prefix. `required` is false for an addon:
// an addon whose modules do not all load is left out.
function graphRoots(dir, libraries) {
  return libraries.flatMap(library => {
    const names = Object.keys(library.imports).filter(name => !name.endsWith('/'));
    const roots = names.map(specifier => ({ specifier, required: true }));
    if (!library.addons) return roots;
    const { prefix, folders } = library.addons;
    const prefixDir = join(dir, library.folder, library.imports[prefix]);
    for (const folder of folders) {
      for (const path of filesBelow(join(prefixDir, folder)).filter(file => file.endsWith('.js'))) {
        roots.push({ specifier: `${prefix}${folder}/${path}`, required: false });
      }
    }
    return roots;
  });
}

// The module graph of `roots` (`graphRoots`) with the import map of `dir`:
// `importClosures` of a `deno info` run on an entry that imports each root.
function moduleGraph(deno, dir, roots, work) {
  const entry = join(work, 'graph-entry.js');
  writeFileSync(entry, roots.map(root => `import ${JSON.stringify(root.specifier)};\n`).join(''));
  const args = ['info', '--json', '--no-config', '--no-remote', '--no-npm', '--no-lock', `--import-map=${join(dir, IMPORT_MAP)}`, entry];
  return importClosures(JSON.parse(runDeno(deno, args, { cwd: work, denoDir: join(work, 'deno-dir') })));
}

// Runs the libraries in `dir` (with their native files of this computer)
// in the bundled Deno with the flags of a run of Dez: static imports of
// each entry of the import map and of one addon of each prefix, and a red
// square that skia-canvas draws. Throws unless each import gives exports
// and the pixel is red.
function smokeRun(deno, dir, roots, work) {
  const firstAddons = new Map();
  for (const { specifier, required } of roots) {
    const library = specifier.split('/')[0];
    if (!required && !firstAddons.has(library)) firstAddons.set(library, specifier);
  }
  const names = [...roots.filter(root => root.required).map(root => root.specifier), ...firstAddons.values()];
  const script = `${names.map((name, index) => `import * as module${index} from ${JSON.stringify(name)};`).join('\n')}
const { Canvas } = module${names.indexOf('skia-canvas')};
const canvas = new Canvas(4, 4, { gpu: false });
const context = canvas.getContext('2d');
context.fillStyle = 'rgb(255, 0, 0)';
context.fillRect(0, 0, 4, 4);
const pixel = Array.from(canvas.toBufferSync('raw').subarray(0, 4));
const exports = [${names.map((_, index) => `Object.keys(module${index}).length`).join(', ')}];
console.log(JSON.stringify({ exports, pixel }));
`;
  const path = join(work, 'smoke.js');
  writeFileSync(path, script);
  const canvasLib = join(dir, 'skia-canvas', 'lib');
  const output = runDeno(
    deno,
    [
      'run',
      '--no-prompt',
      '--no-remote',
      '--no-npm',
      '--no-config',
      '--no-lock',
      `--import-map=${join(dir, IMPORT_MAP)}`,
      `--allow-read=${canvasLib}`,
      `--allow-ffi=${join(canvasLib, 'skia.node')}`,
      `--allow-env=${SKIA_CANVAS_ENV.join(',')}`,
      path
    ],
    { cwd: work, denoDir: join(work, 'deno-dir') }
  );
  const { exports, pixel } = JSON.parse(output);
  const empty = names.filter((_, index) => exports[index] === 0);
  if (empty.length > 0) throw new Error(`These imports give no exports in Deno: ${empty.join(', ')}.`);
  if (pixel.join() !== '255,0,0,255') throw new Error(`skia-canvas drew the pixel ${pixel.join(', ')}, not red.`);
  return names;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

// The bundled Deno of this computer, after a check that it is the pinned
// file of src-tauri/binaries/manifest.json and that it runs.
async function hostDeno() {
  const triple = hostTriple(process.platform, process.arch);
  if (!triple) {
    throw new Error(`Dez ships no Deno program for this computer (${process.platform} ${process.arch}), and the script runs it.`);
  }
  const name = `dez-deno-${triple}`;
  const path = join(BINARIES_DIR, name);
  const manifest = readJson(join(BINARIES_DIR, 'manifest.json'));
  if (!(await isPinnedFile(path, manifest.files?.[name] ?? {}))) {
    throw new Error(`src-tauri/binaries/${name} is not the file that ${MANIFEST_NAME} names: run node scripts/fetch-programs.js.`);
  }
  checkHostProgram(path, name, manifest.deno?.version, DENO_VERSION_CALL);
  return path;
}

// Puts the package of each library, with its generated files, into
// `<full>/<folder>/`, and checks its license. `packageDir` is the folder
// of a package in the Deno cache. Gives the paths of the generated files of
// each library, by folder.
function stagePackages(full, libraries, packageDir) {
  const generatedPaths = {};
  for (const library of libraries) {
    const source = packageDir(library);
    const { license } = readJson(join(source, 'package.json'));
    if (!Object.hasOwn(ALLOWED_LICENSES, license)) {
      throw new Error(`${library.package} ${library.version} has the license ${license}, which Dez ships no library with.`);
    }
    const folder = join(full, library.folder);
    cpSync(source, folder, { recursive: true });
    const generated = library.generated?.(path => readFileSync(join(source, path), 'utf8')) ?? {};
    for (const [path, text] of Object.entries(generated)) {
      mkdirSync(dirname(join(folder, path)), { recursive: true });
      writeFileSync(join(folder, path), text);
    }
    generatedPaths[library.folder] = Object.keys(generated);
    const licenseText = readFileSync(join(folder, library.licenseFile), 'utf8').replace(/\s+/g, ' ');
    if (!licenseText.includes(ALLOWED_LICENSES[license])) {
      throw new Error(`${library.licenseFile} of ${library.package} is not the ${license} license that its package.json states.`);
    }
  }
  return generatedPaths;
}

// The paths in `<full>/` of the files to ship: the files that the roots
// load (`closures`), and of each library its license file, its `files`,
// and its generated files (`generatedPaths`, by folder).
function shippedPaths(full, libraries, closures, generatedPaths) {
  const paths = new Set();
  for (const { files } of closures.values()) {
    for (const url of files) {
      const path = relative(full, fileURLToPath(url)).split(sep).join('/');
      if (path.startsWith('../')) throw new Error(`A library loads a file outside the libraries: ${url}.`);
      paths.add(path);
    }
  }
  for (const library of libraries) {
    const folder = join(full, library.folder);
    const own = [library.licenseFile, ...generatedPaths[library.folder]];
    for (const file of library.files ?? []) {
      if (file.endsWith('/')) {
        own.push(...filesBelow(join(folder, file)).map(path => `${file}${path}`));
      } else {
        own.push(file);
      }
    }
    for (const path of own) {
      if (!existsSync(join(folder, path))) throw new Error(`${library.package} ${library.version} has no file ${path}.`);
      paths.add(`${library.folder}/${path}`);
    }
  }
  return [...paths].sort();
}

async function main(args) {
  let options;
  try {
    options = parseArgs(args);
  } catch (error) {
    console.error(`${error.message}\n\n${USAGE}`);
    process.exitCode = 1;
    return;
  }
  if (options.help) {
    console.log(USAGE);
    return;
  }

  // The work goes into a folder next to the libs folder (the same file
  // system, so a rename moves a folder), and the libs folder changes only
  // after every check passed: a failed run leaves the vendored libraries
  // whole.
  let work;
  try {
    const deno = await hostDeno();
    work = mkdtempSync(join(LIBS_DIR, '..', '.libs-update-'));
    const denoDir = join(work, 'deno-dir');
    const project = join(work, 'project');
    mkdirSync(project);
    writeFileSync(join(project, 'deno.json'), '{}\n');
    console.log('Getting the npm packages with deno add');
    runDeno(deno, ['add', ...LIBRARIES.map(library => `npm:${library.package}@${library.version}`)], {
      cwd: project,
      denoDir,
      // The network settings of the user (a proxy, a CA file) reach the
      // registry.
      userEnv: process.env
    });
    const lock = readJson(join(project, 'deno.lock'));
    const integrities = lockedPackages(lock, LIBRARIES);

    const full = join(work, 'full');
    const generatedPaths = stagePackages(full, LIBRARIES, library =>
      join(denoDir, 'npm', 'registry.npmjs.org', library.package, library.version)
    );
    writeFileSync(join(full, IMPORT_MAP), jsonText(importMap(LIBRARIES)));

    const allRoots = graphRoots(full, LIBRARIES);
    const graph = moduleGraph(deno, full, allRoots, work);
    const dropped = [];
    for (const root of allRoots) {
      const { problem } = graph.get(root.specifier) ?? { problem: 'deno info gives no import of it' };
      if (problem && root.required) throw new Error(`The import ${root.specifier} does not load: ${problem}`);
      if (problem) dropped.push(root.specifier);
    }
    const roots = allRoots.filter(root => !dropped.includes(root.specifier));
    if (dropped.length > 0) {
      console.log(`Left out ${dropped.length} addons whose modules do not all load:\n  ${dropped.join('\n  ')}`);
    }
    const closures = new Map(roots.map(root => [root.specifier, graph.get(root.specifier)]));

    const libs = join(work, 'libs');
    for (const path of shippedPaths(full, LIBRARIES, closures, generatedPaths)) {
      mkdirSync(dirname(join(libs, path)), { recursive: true });
      copyFileSync(join(full, path), join(libs, path));
    }
    // Copies, so that the checks below load Dez's own libraries next to the
    // new vendored files. The swap does not move them.
    for (const own of OWN_LIBRARIES) {
      cpSync(join(LIBS_DIR, own.folder), join(libs, own.folder), { recursive: true });
    }
    writeFileSync(join(libs, IMPORT_MAP), jsonText(importMap([...LIBRARIES, ...OWN_LIBRARIES])));

    const libraryFacts = {};
    for (const library of LIBRARIES) {
      const facts = {
        package: library.package,
        version: library.version,
        license: readJson(join(full, library.folder, 'package.json')).license,
        licenseFile: library.licenseFile,
        repository: library.repository,
        tarball: npmTarballUrl(library.package, library.version),
        integrity: integrities[library.folder]
      };
      if (library.native) {
        const targets = {};
        for (const native of nativePackages(lock, library)) {
          console.log(`Downloading ${native.package} ${native.version}`);
          const tgz = await downloadBytes(native.url);
          if (sha512Integrity(tgz) !== native.integrity) {
            throw new Error(`${native.url} is not the file that deno.lock names (its sha512 is another one).`);
          }
          const bytes = tgzMember(tgz, library.native.member);
          targets[native.target] = {
            package: native.package,
            url: native.url,
            integrity: native.integrity,
            tgz: { member: library.native.member, ...bytesPin(tgz) },
            ...bytesPin(bytes)
          };
          if (native.target === hostTriple(process.platform, process.arch)) {
            writeFileSync(join(libs, library.folder, library.native.file), bytes, { mode: NATIVE_MODE });
          }
        }
        facts.native = { file: library.native.file, targets };
        writeFileSync(join(libs, library.folder, NATIVE_LICENSES), await nativeLicensesText(library, console.log));
      }
      libraryFacts[library.folder] = facts;
    }

    const nativePaths = LIBRARIES.filter(library => library.native).map(library => `${library.folder}/${library.native.file}`);
    const ownFolders = OWN_LIBRARIES.map(own => `${own.folder}/`);
    const shipped = filesBelow(libs);
    const bad = badPaths(shipped);
    if (bad.length > 0) {
      throw new Error(`The apps tool cannot open these files, as a part of a name has another character than A-Z, a-z, 0-9, ., _, or -:\n  ${bad.join('\n  ')}`);
    }

    // The final folder has all that its imports load, and runs.
    const checkedRoots = [...roots, ...graphRoots(libs, OWN_LIBRARIES)];
    const check = moduleGraph(deno, libs, checkedRoots, work);
    for (const root of checkedRoots) {
      const problem = check.get(root.specifier)?.problem;
      if (problem) throw new Error(`The import ${root.specifier} does not load from the vendored files: ${problem}`);
    }
    const smoked = smokeRun(deno, libs, checkedRoots, work);
    console.log(`The libraries run in Deno: ${smoked.join(', ')}, and skia-canvas draws.`);

    const files = Object.fromEntries(
      shipped
        .filter(path => !nativePaths.includes(path) && !ownFolders.some(folder => path.startsWith(folder)))
        .map(path => [path, bytesPin(readFileSync(join(libs, path)))])
    );
    const manifest = manifestText(libraryFacts, files);

    // The swap: the old folders of the script (those of the old manifest
    // too, for a library that the list dropped) go into the work folder,
    // which the end of the run deletes.
    mkdirSync(LIBS_DIR, { recursive: true });
    const manifestPath = join(LIBS_DIR, MANIFEST);
    const oldFolders = existsSync(manifestPath) ? Object.keys(readJson(manifestPath).libraries ?? {}) : [];
    const old = join(work, 'old');
    mkdirSync(old);
    for (const folder of new Set([...oldFolders, ...LIBRARIES.map(library => library.folder)])) {
      if (existsSync(join(LIBS_DIR, folder))) renameSync(join(LIBS_DIR, folder), join(old, folder));
    }
    for (const library of LIBRARIES) {
      renameSync(join(libs, library.folder), join(LIBS_DIR, library.folder));
    }
    renameSync(join(libs, IMPORT_MAP), join(LIBS_DIR, IMPORT_MAP));
    writeFileSync(manifestPath, manifest);

    console.log(`Vendored ${LIBRARIES.length} libraries in src-tauri/libs/ (${Object.keys(files).length} files).
Next: build and test Dez, then commit src-tauri/libs/.
Git ignores the native files: scripts/fetch-programs.js gets them from the pins of ${LIBS_MANIFEST_NAME}.`);
  } catch (error) {
    console.error(`update-libs: ${error.message}`);
    process.exitCode = 1;
  } finally {
    if (work) rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  await main(process.argv.slice(2));
}
