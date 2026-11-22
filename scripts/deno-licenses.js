import {
  archiveFiles,
  downloadedCrateLicenses,
  githubRepositorySources,
  githubTagCommit,
  isLicenseFile,
  licenseTexts,
  lockedCrates
} from './license-texts.js';

// The license texts of the Deno program that Dez ships: what
// scripts/update-deno.js writes into src-tauri/binaries/deno/LICENSES.txt,
// by the rule of scripts/license-texts.js. The sources that a Deno release
// pins are:
//
// 1. The Deno source of the release (`deno_src.tar.gz`), with the SHA-256
//    that GitHub gives for it.
// 2. rusty_v8 at the tag of the `v8` crate version, and each of its Git
//    submodules at the commit that it pins. One of them is the V8 source,
//    which keeps the license of each part that it holds next to that part.
//    Others are ICU, Abseil, and libc++. The `v8` crate file itself holds
//    none of these license files.
// 3. Each crate file of crates.io that `Cargo.lock` of the Deno source
//    names. The lock pins it by its SHA-256.

const RUSTY_V8_REPO = 'denoland/rusty_v8';
// The submodule of rusty_v8 with the V8 source.
const V8_SUBMODULE = 'v8';

// What the Deno source of a release (the bytes of `deno_src.tar.gz`) gives:
// the text of its `Cargo.lock`, and its license files.
export function denoSourceLicenses(sourceArchive) {
  const files = archiveFiles(sourceArchive, 'deno/');
  const lock = files.find(file => file.path === 'Cargo.lock');
  if (!lock) {
    throw new Error('The Deno source of the release has no Cargo.lock, so the script cannot find the crates of the program.');
  }
  return { lock: lock.bytes.toString('utf8'), files: licenseTexts(files, file => isLicenseFile(file.path)) };
}

// The license sources of rusty_v8 at the tag of a `v8` crate version: the
// repository itself, and each of its submodules. The V8 source is read in
// full: it holds parts of other projects below third_party/.
async function rustyV8Sources(v8Version, log) {
  const commit = await githubTagCommit(RUSTY_V8_REPO, `v${v8Version}`);
  const { sources } = await githubRepositorySources(RUSTY_V8_REPO, commit, `rusty_v8 ${v8Version}`, [V8_SUBMODULE], log);
  return sources;
}

// The license sources of the Deno program of one release, from the Deno
// source of the release (the bytes of `deno_src.tar.gz`): `sources` and
// `crates` as `licenseTextsFile` takes them, the version of the `v8` crate,
// and the text of the license of Deno itself (LICENSE.md of its source;
// empty when the source has none). The head comment of this file tells the
// sources.
export async function denoLicenseSources(version, sourceArchive, log = console.log) {
  const { lock, files } = denoSourceLicenses(sourceArchive);
  const crates = lockedCrates(lock);
  const v8Versions = crates.filter(crate => crate.name === 'v8').map(crate => crate.version);
  if (v8Versions.length !== 1) {
    throw new Error(`Cargo.lock of Deno ${version} names ${v8Versions.length} versions of the v8 crate, and the script reads the source of one.`);
  }

  const v8Sources = await rustyV8Sources(v8Versions[0], log);
  const crateLicenseList = await downloadedCrateLicenses(crates, log);
  return {
    v8Version: v8Versions[0],
    denoLicense: files.find(file => file.path === 'LICENSE.md')?.text ?? '',
    sources: [
      { title: `Deno ${version} (deno_src.tar.gz of the release)`, files },
      ...v8Sources,
      ...crateLicenseList.map(crate => ({ title: `crate ${crate.name} ${crate.version}`, files: crate.files }))
    ],
    crates: crateLicenseList.map(({ name, version: crateVersion, license }) => ({ name, version: crateVersion, license }))
  };
}
