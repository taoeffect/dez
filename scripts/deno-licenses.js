import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { downloadBytes } from './bundled-programs.js';

// The license texts of the Deno program that Dez ships: what
// scripts/update-deno.js writes into src-tauri/binaries/deno/LICENSES.txt.
//
// Why a rule, and not a list of libraries: Deno publishes no file with the
// licenses of the code in its program, and a list in this script would miss
// each library that a new Deno version adds. So the texts are the license
// files, found by their names (`isLicenseFile`), of every source that the
// release pins:
//
// 1. The Deno source of the release (`deno_src.tar.gz`).
// 2. rusty_v8 at the tag of the `v8` crate version, and each of its Git
//    submodules at the commit that it pins. One of them is the V8 source,
//    which keeps the license of each part that it holds next to that part.
//    Others are ICU, Abseil, and libc++. The `v8` crate file itself holds
//    none of these license files.
// 3. Each crate file of crates.io that `Cargo.lock` of the Deno source
//    names. The lock pins it by its SHA-256.
//
// So every text comes from a file that a hash pins: the SHA-256 that GitHub
// gives for the source file, a Git commit, or a checksum of the lock.
//
// The rule takes more than the program holds (a crate of another platform,
// a build tool), and never less than the sources name as their licenses.
// The other way, a list of names with no texts, would be small, but the MIT
// and the Apache licenses ask for their text with each copy.

const CRATES_IO_SOURCE = 'registry+https://github.com/rust-lang/crates.io-index';
const RUSTY_V8_REPO = 'denoland/rusty_v8';
// The submodule of rusty_v8 with the V8 source.
const V8_SUBMODULE = 'v8';

// crates.io asks each program for a User-Agent that names it.
const USER_AGENT = 'dez-update-deno (https://github.com/taoeffect/dez)';
const GITHUB_API_HEADERS = { Accept: 'application/vnd.github+json', 'User-Agent': USER_AGENT };

// The downloads of the crate files that run at the same time.
const CRATE_DOWNLOADS = 12;
// The requests to one Git host that run at the same time.
const GIT_REQUESTS = 4;

const LICENSE_NAME = /licen[sc]e|^(?:copying|copyright|notice|unlicense|patents)/i;
// Files with a license name that are code or data, not a license text
// (`licenses.rs`, `copying-phase.cc`, `license-check.sh`, `license.html`).
const NOT_A_TEXT = /\.(?:a|c|cc|cpp|h|hpp|html|js|pem|pl|pm|py|rs|sh|stderr|ts)$/i;
const TEST_FOLDERS = new Set(['test', 'tests']);

// Whether the file at `path` (a path in a source, with `/`) is a license
// text by its name: `LICENSE`, `LICENSE-MIT`, `COPYING.LGPLv2.1`, `NOTICE`,
// `THIRD-PARTY-LICENSES`, and the like, at any depth. A file of the tests
// of a source is not one: the tests are not a part of a program.
export function isLicenseFile(path) {
  const folders = path.split('/');
  const name = folders.pop();
  return LICENSE_NAME.test(name) && !NOT_A_TEXT.test(name) && !folders.some(folder => TEST_FOLDERS.has(folder.toLowerCase()));
}

// The text of a header field of a tar file: the bytes up to the first NUL.
function tarField(header, start, length) {
  const field = header.subarray(start, start + length);
  const end = field.indexOf(0);
  return field.toString('utf8', 0, end < 0 ? length : end);
}

// The files of a tar file (its bytes, not compressed): the name and the
// bytes of each regular file. Folders and links are left out.
//
// Why Dez has its own reader: Node has none. The reader knows the forms of
// a long name that the archives of the script use: the GNU long name (an
// entry of the type `L` before the file; cargo and GNU tar write it), and
// the prefix field of a POSIX header. It throws for a pax header, which
// can also hold a name, so that no file gets a part of its name.
//
// https://www.gnu.org/software/tar/manual/html_node/Standard.html
export function* tarFiles(tar) {
  let longName;
  let offset = 0;
  // Empty blocks end the file.
  while (offset + 512 <= tar.length && tar[offset] !== 0) {
    const header = tar.subarray(offset, offset + 512);
    const size = Number.parseInt(tarField(header, 124, 12), 8);
    const type = String.fromCharCode(header[156]);
    if (!Number.isSafeInteger(size) || offset + 512 + size > tar.length) {
      throw new Error('The tar file is damaged, or a part of it is missing.');
    }
    if (type === 'x') {
      throw new Error('The tar file has pax headers, which this script does not read.');
    }
    const bytes = tar.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;

    if (type === 'L') {
      longName = tarField(bytes, 0, bytes.length);
      continue;
    }
    // Only a POSIX header (the magic `ustar` and a NUL) has a prefix field.
    // A GNU header has other data in its place.
    const prefix = tarField(header, 257, 6) === 'ustar' && header[262] === 0 ? tarField(header, 345, 155) : '';
    const name = longName ?? (prefix === '' ? '' : `${prefix}/`) + tarField(header, 0, 100);
    longName = undefined;
    // `0`, or a NUL in an old tar file, is a regular file.
    if (type === '0' || type === '\0') yield { name, bytes };
  }
}

// A license text as the license texts file holds it: with `\n` line ends,
// no space at the end of a line, and no empty lines around it. So a text
// that two sources hold with other line ends is one text.
function normalText(bytes) {
  return bytes
    .toString('utf8')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[^\S\n]+$/gm, '')
    .replace(/^\n+|\n+$/g, '');
}

// The crate files that a `Cargo.lock` names: the name, the version, and the
// SHA-256 of each one. A package with no source is a part of the workspace
// of the lock (Deno itself). Throws for a package from another source than
// crates.io (a Git repository): the lock has no checksum of its files.
export function lockedCrates(lock) {
  return lock
    .split(/^\[\[package\]\]$/m)
    .slice(1)
    .flatMap(block => {
      const value = key => new RegExp(`^${key} = "([^"]*)"$`, 'm').exec(block)?.[1];
      const [name, version, source, checksum] = ['name', 'version', 'source', 'checksum'].map(value);
      if (source === undefined) return [];
      if (source !== CRATES_IO_SOURCE || !/^[0-9a-f]{64}$/.test(checksum ?? '')) {
        throw new Error(
          `Cargo.lock names the package ${name} ${version} from ${source}, with no SHA-256 of a crate file of crates.io. ` +
            'This script takes the license texts of a crate only from a crate file that the lock pins.'
        );
      }
      return [{ name, version, checksum }];
    });
}

// The regular files of a `.tar.gz` archive that has all its files in the
// one folder `root` (a crate file, the Deno source): the path in that
// folder and the bytes of each one.
function archiveFiles(archive, root) {
  const files = [];
  for (const { name, bytes } of tarFiles(gunzipSync(archive))) {
    if (name.startsWith(root)) files.push({ path: name.slice(root.length), bytes });
  }
  return files;
}

// The files of `files` that `isLicense` takes, each with its path and its
// text, in the order of the paths.
function licenseTexts(files, isLicense) {
  return files
    .filter(isLicense)
    .map(file => ({ path: file.path, text: normalText(file.bytes) }))
    .sort((a, b) => (a.path < b.path ? -1 : 1));
}

// What a crate file tells about the license of its crate: the license that
// its Cargo.toml states (an SPDX expression, or the name of its license
// file), and its license files, each with its path in the crate and its
// text.
export function crateLicenses({ name, version }, crateFile) {
  const files = archiveFiles(crateFile, `${name}-${version}/`);
  // cargo writes Cargo.toml of a crate file in one form, with each of these
  // keys on a line of its own.
  const manifest = files.find(file => file.path === 'Cargo.toml')?.bytes.toString('utf8') ?? '';
  const stated = /^license = "([^"]*)"$/m.exec(manifest)?.[1];
  const licenseFile = /^license-file = "([^"]*)"$/m.exec(manifest)?.[1];
  return {
    license: stated ?? (licenseFile ? `see ${licenseFile}` : 'not stated'),
    // The license file that Cargo.toml names can have any name.
    files: licenseTexts(files, file => isLicenseFile(file.path) || file.path === licenseFile)
  };
}

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

// The submodules of a Git repository: the path, the URL, and the pinned
// commit of each one. `gitmodules` is the text of its `.gitmodules` file,
// and `tree` the entries of its file tree as the GitHub API gives them,
// where a submodule has the type `commit` and the commit as its `sha`.
export function submodulesOf(gitmodules, tree) {
  const commits = new Map(tree.filter(entry => entry.type === 'commit').map(entry => [entry.path, entry.sha]));
  const submodules = gitmodules
    .split(/^\[submodule /m)
    .slice(1)
    .map(section => {
      const path = /^\s*path = (\S+)$/m.exec(section)?.[1];
      const url = /^\s*url = (\S+)$/m.exec(section)?.[1];
      const commit = commits.get(path);
      if (!path || !url || !commit) {
        throw new Error(`The script cannot read a submodule of .gitmodules (path ${path}, URL ${url}, commit ${commit}).`);
      }
      return { path, url: url.replace(/\.git$/, ''), commit };
    });
  // Each submodule of the tree must have its URL, or its license files
  // would be missing with no error.
  const unnamed = [...commits.keys()].filter(path => !submodules.some(submodule => submodule.path === path));
  if (unnamed.length > 0) {
    throw new Error(`.gitmodules names no URL for the submodule ${unnamed.join(', ')}.`);
  }
  return submodules;
}

const RULE = '='.repeat(80);

// The text of the license texts file. `sources` are the sources in the
// order of the file, each `{ title, files }` with the files of
// `crateLicenses`. `crates` are the crates of the program, each with the
// license that it states.
//
// A text that more than one file has (the Apache License of some hundred
// crates) is in the file once, at the place of its first file, and its head
// names each file that has it. A head is the lines between two rule lines.
export function licenseTextsFile(intro, sources, crates) {
  const heads = new Map();
  for (const { title, files } of sources) {
    for (const { path, text } of files) {
      if (text === '') continue;
      if (!heads.has(text)) heads.set(text, []);
      heads.get(text).push(`${title}: ${path}`);
    }
  }
  const texts = Array.from(heads, ([text, lines]) => `${RULE}\n${lines.join('\n')}\n${RULE}\n\n${text}\n`);
  const crateList = crates.map(({ name, version, license }) => `${name} ${version}: ${license}`).join('\n');
  return `${intro}\n\n${texts.join('\n')}\n${RULE}\nThe Rust crates of the program, each with the license that it states\n${RULE}\n\n${crateList}\n`;
}

// Runs `work` for each item, at most `limit` at a time, and gives the
// results in the order of the items. After a failure, no new work starts.
async function mapLimited(items, limit, work) {
  const results = new Array(items.length);
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (next < items.length && !failed) {
      const index = next++;
      try {
        results[index] = await work(items[index]);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: limit }, worker));
  return results;
}

// The entries of the file tree of a commit of a GitHub repository: all of
// them for `deep`, else those of the root folder.
async function githubTree(repo, commit, deep) {
  const url = `https://api.github.com/repos/${repo}/git/trees/${commit}${deep ? '?recursive=1' : ''}`;
  const data = JSON.parse(await downloadBytes(url, GITHUB_API_HEADERS));
  if (data.truncated) {
    throw new Error(`GitHub gives only a part of the file tree of ${repo} at ${commit}, so the script cannot find all its license files.`);
  }
  return data.tree;
}

// The license files of a Git repository at one commit, on one of the two
// hosts of the sources (GitHub, and the Gitiles servers of Google): the
// path and the text of each one. With `deep`, the files of every folder,
// else those of the root folder.
async function repositoryLicenses(url, commit, deep) {
  const github = /^https:\/\/github\.com\/([^/]+\/[^/]+)$/.exec(url)?.[1];
  let paths;
  let fileBytes;
  if (github) {
    paths = (await githubTree(github, commit, deep)).filter(entry => entry.type === 'blob').map(entry => entry.path);
    fileBytes = path => downloadBytes(`https://raw.githubusercontent.com/${github}/${commit}/${path}`, { 'User-Agent': USER_AGENT });
  } else if (/^https:\/\/[a-z0-9-]+\.googlesource\.com\//.test(url) && !deep) {
    // Gitiles puts the line `)]}'` before its JSON, and gives the text of a
    // file as base64.
    const listing = (await downloadBytes(`${url}/+/${commit}/?format=JSON`)).toString('utf8');
    paths = JSON.parse(listing.slice(listing.indexOf('\n'))).entries.filter(entry => entry.type === 'blob').map(entry => entry.name);
    fileBytes = async path => Buffer.from((await downloadBytes(`${url}/+/${commit}/${path}?format=TEXT`)).toString('ascii'), 'base64');
  } else {
    throw new Error(`The script cannot read the files of the Git repository ${url}: it knows only GitHub and googlesource.com.`);
  }
  return mapLimited(paths.filter(isLicenseFile).sort(), GIT_REQUESTS, async path => ({
    path,
    text: normalText(await fileBytes(path))
  }));
}

// The license sources of rusty_v8 at the tag of a `v8` crate version: the
// repository itself, and each of its submodules.
async function rustyV8Sources(v8Version, log) {
  const repoUrl = `https://github.com/${RUSTY_V8_REPO}`;
  const tag = `v${v8Version}`;
  // The commit of the tag: every later request names the commit, so a tag
  // that moves during the run changes nothing.
  const commitUrl = `https://api.github.com/repos/${RUSTY_V8_REPO}/commits/${tag}`;
  const commit = JSON.parse(await downloadBytes(commitUrl, GITHUB_API_HEADERS)).sha;
  if (!/^[0-9a-f]{40}$/.test(commit ?? '')) {
    throw new Error(`GitHub names no commit for the tag ${tag} of ${RUSTY_V8_REPO}.`);
  }
  log(`Reading the license files of rusty_v8 ${v8Version} and its submodules`);

  const tree = await githubTree(RUSTY_V8_REPO, commit, true);
  const rawUrl = `https://raw.githubusercontent.com/${RUSTY_V8_REPO}/${commit}`;
  const ownFiles = await mapLimited(
    tree.filter(entry => entry.type === 'blob' && isLicenseFile(entry.path)).map(entry => entry.path),
    GIT_REQUESTS,
    async path => ({ path, text: normalText(await downloadBytes(`${rawUrl}/${path}`, { 'User-Agent': USER_AGENT })) })
  );
  const gitmodules = (await downloadBytes(`${rawUrl}/.gitmodules`, { 'User-Agent': USER_AGENT })).toString('utf8');
  const submodules = submodulesOf(gitmodules, tree);
  if (!submodules.some(submodule => submodule.path === V8_SUBMODULE)) {
    throw new Error(`rusty_v8 ${v8Version} has no submodule ${V8_SUBMODULE}, so the script cannot find the license files of V8.`);
  }

  const sources = [{ title: `rusty_v8 ${v8Version} (${repoUrl} at ${commit})`, files: ownFiles }];
  // One host at a time gets requests: the submodules run one after another.
  // The V8 source is read in full: it holds parts of other projects below
  // third_party/, each with its license next to it. Each other submodule
  // is one project, which has its license files in its top folder.
  for (const { path, url, commit: pinned } of submodules) {
    const files = await repositoryLicenses(url, pinned, path === V8_SUBMODULE);
    sources.push({ title: `rusty_v8 submodule ${path} (${url} at ${pinned})`, files });
  }
  return sources;
}

// The license of each crate file that the lock names, in the order of the
// lock: `crateLicenses`, with the name and the version of the crate. Each
// crate file must have the SHA-256 that the lock names.
async function downloadedCrateLicenses(crates, log) {
  log(`Downloading the ${crates.length} crate files of Cargo.lock for their license files`);
  return mapLimited(crates, CRATE_DOWNLOADS, async crate => {
    // A `+` of a version must not be a space for the server.
    const fileName = encodeURIComponent(`${crate.name}-${crate.version}.crate`);
    const url = `https://static.crates.io/crates/${crate.name}/${fileName}`;
    const bytes = await downloadBytes(url, { 'User-Agent': USER_AGENT });
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (sha256 !== crate.checksum) {
      throw new Error(`${url} is not the crate file that Cargo.lock names: it has the SHA-256 ${sha256}, not ${crate.checksum}.`);
    }
    return { ...crate, ...crateLicenses(crate, bytes) };
  });
}

// The license sources of the Deno program of one release, from the Deno
// source of the release (the bytes of `deno_src.tar.gz`): `sources` and
// `crates` as `licenseTextsFile` takes them, the version of the `v8` crate,
// and the text of the license of Deno itself (LICENSE.md of its source;
// empty when the source has none). The head comment of this file tells the
// rule.
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
