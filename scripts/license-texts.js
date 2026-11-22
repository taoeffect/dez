import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { downloadBytes, tarFiles } from './bundled-programs.js';

// The license texts of a program or a native library that Dez ships, from
// the sources that built it: the rule that scripts/deno-licenses.js (the
// Deno program) and scripts/update-libs.js (the native file of
// skia-canvas) share.
//
// Why a rule, and not a list of libraries: the makers publish no file with
// the licenses of the code in their program, and a list in a script would
// miss each library that a new version adds. So the texts are the license
// files, found by their names (`isLicenseFile`), of every source that a
// release pins: a source archive, a Git repository at a commit and its
// submodules, and each crate file of crates.io that a `Cargo.lock` names
// (the lock pins it by its SHA-256).
//
// So every text comes from a file that a hash pins: a SHA-256 of a source
// file, a Git commit, or a checksum of the lock.
//
// The rule takes more than the program holds (a crate of another platform,
// a build tool), and never less than the sources name as their licenses.
// The other way, a list of names with no texts, would be small, but the MIT
// and the Apache licenses ask for their text with each copy.

const CRATES_IO_SOURCE = 'registry+https://github.com/rust-lang/crates.io-index';

// crates.io asks each program for a User-Agent that names it.
const USER_AGENT = 'dez-scripts (https://github.com/taoeffect/dez)';
const GITHUB_API_HEADERS = { Accept: 'application/vnd.github+json', 'User-Agent': USER_AGENT };

// The downloads of the crate files that run at the same time.
const CRATE_DOWNLOADS = 12;
// The requests to one Git host that run at the same time.
const GIT_REQUESTS = 4;

const LICENSE_NAME = /licen[sc]e|^(?:copying|copyright|notice|patents)/i;
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

// A license text as the license texts file holds it: with `\n` line ends,
// no space at the end of a line, and no empty lines around it. So a text
// that two sources hold with other line ends is one text.
export function normalText(bytes) {
  return bytes
    .toString('utf8')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[^\S\n]+$/gm, '')
    .replace(/^\n+|\n+$/g, '');
}

// The crate files that a `Cargo.lock` names: the name, the version, and the
// SHA-256 of each one. A package with no source is a part of the workspace
// of the lock (the program itself). Throws for a package from another
// source than crates.io (a Git repository): the lock has no checksum of its
// files.
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
export function archiveFiles(archive, root) {
  const files = [];
  for (const { name, bytes } of tarFiles(gunzipSync(archive))) {
    if (name.startsWith(root)) files.push({ path: name.slice(root.length), bytes });
  }
  return files;
}

// The files of `files` that `isLicense` takes, each with its path and its
// text, in the order of the paths.
export function licenseTexts(files, isLicense) {
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

// Git keeps a link as a blob with the mode 120000, whose bytes are the path
// of its target, not a text (the source archives, `archiveFiles`, give no
// link either). GitHub gives the mode of a tree entry as octal text,
// Gitiles as a number.
const LINK_MODE = 0o120000;

// Whether an entry of a Git file tree, as GitHub or Gitiles lists it, is a
// regular file: not a folder, a submodule, or a link.
export function isRegularFile(entry) {
  const mode = typeof entry.mode === 'string' ? Number.parseInt(entry.mode, 8) : entry.mode;
  return entry.type === 'blob' && mode !== LINK_MODE;
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
export async function repositoryLicenses(url, commit, deep) {
  const github = /^https:\/\/github\.com\/([^/]+\/[^/]+)$/.exec(url)?.[1];
  const gitiles = /^https:\/\/[a-z0-9-]+\.googlesource\.com\//.test(url);
  let paths;
  let fileBytes;
  if (github) {
    paths = (await githubTree(github, commit, deep)).filter(isRegularFile).map(entry => entry.path);
    fileBytes = path => githubFile(github, commit, path);
  } else if (gitiles && !deep) {
    // Gitiles puts the line `)]}'` before its JSON, and gives the text of a
    // file as base64.
    const listing = (await downloadBytes(`${url}/+/${commit}/?format=JSON`)).toString('utf8');
    paths = JSON.parse(listing.slice(listing.indexOf('\n'))).entries.filter(isRegularFile).map(entry => entry.name);
    fileBytes = async path => Buffer.from((await downloadBytes(`${url}/+/${commit}/${path}?format=TEXT`)).toString('ascii'), 'base64');
  } else if (gitiles) {
    throw new Error(`The script reads only the top folder of a Git repository on googlesource.com, so it cannot read all the license files of ${url}.`);
  } else {
    throw new Error(`The script cannot read the files of the Git repository ${url}: it knows only GitHub and googlesource.com.`);
  }
  return mapLimited(paths.filter(isLicenseFile).sort(), GIT_REQUESTS, async path => ({
    path,
    text: normalText(await fileBytes(path))
  }));
}

// The bytes of the file `path` of a GitHub repository (`owner/name`) at
// one commit.
export function githubFile(repo, commit, path) {
  return downloadBytes(`https://raw.githubusercontent.com/${repo}/${commit}/${path}`, { 'User-Agent': USER_AGENT });
}

// The commit of the tag `tag` of a GitHub repository. Every later request
// names the commit, so a tag that moves during the run changes nothing.
export async function githubTagCommit(repo, tag) {
  const url = `https://api.github.com/repos/${repo}/commits/${encodeURIComponent(tag)}`;
  const commit = JSON.parse(await downloadBytes(url, GITHUB_API_HEADERS)).sha;
  if (!/^[0-9a-f]{40}$/.test(commit ?? '')) {
    throw new Error(`GitHub names no commit for the tag ${tag} of ${repo}.`);
  }
  return commit;
}

// The license sources of a GitHub repository (`owner/name`) at one commit:
// the repository itself, with the license files of every folder, and each
// of its Git submodules at the commit that it pins. `title` names the
// repository in the heads of the texts. Gives the sources as
// `licenseTextsFile` takes them, and the submodules (`submodulesOf`).
//
// A submodule of `deepSubmodules` (its path) is read in full: it holds
// parts of other projects, each with its license next to it (the V8 source,
// the Skia source). Each other submodule is one project, which has its
// license files in its top folder. Throws when the repository has no
// submodule of `deepSubmodules`, before any download of a submodule.
export async function githubRepositorySources(repo, commit, title, deepSubmodules, log) {
  log(`Reading the license files of ${title} and its submodules`);
  const tree = await githubTree(repo, commit, true);
  const ownFiles = await mapLimited(
    tree.filter(entry => isRegularFile(entry) && isLicenseFile(entry.path)).map(entry => entry.path),
    GIT_REQUESTS,
    async path => ({ path, text: normalText(await githubFile(repo, commit, path)) })
  );
  // A repository with no submodule has no .gitmodules file.
  const hasSubmodules = tree.some(entry => entry.type === 'commit');
  const gitmodules = hasSubmodules ? (await githubFile(repo, commit, '.gitmodules')).toString('utf8') : '';
  const submodules = submodulesOf(gitmodules, tree);
  const missing = deepSubmodules.filter(path => !submodules.some(submodule => submodule.path === path));
  if (missing.length > 0) {
    throw new Error(`${title} has no submodule ${missing.join(', ')}, so the script cannot find the license files that it holds.`);
  }

  const sources = [{ title: `${title} (https://github.com/${repo} at ${commit})`, files: ownFiles }];
  // One host at a time gets requests: the submodules run one after another.
  for (const { path, url, commit: pinned } of submodules) {
    const files = await repositoryLicenses(url, pinned, deepSubmodules.includes(path));
    sources.push({ title: `${title} submodule ${path} (${url} at ${pinned})`, files });
  }
  return { sources, submodules };
}

// The license of each crate file that the lock names, in the order of the
// lock: `crateLicenses`, with the name and the version of the crate. Each
// crate file must have the SHA-256 that the lock names.
export async function downloadedCrateLicenses(crates, log) {
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
