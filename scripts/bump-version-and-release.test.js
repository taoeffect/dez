import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { MESSAGE_PATH, SIGNATURE_PATH, bumpedFiles, parseArgs, versionMismatches } from './bump-version-and-release.js';

const json = data => `${JSON.stringify(data, null, 2)}\n`;

// Short copies of the five version files, all at `version`. Cargo.lock has a
// package with the same version before `dez`, which a bump must not change.
// `type` is for the tests that run a copy of the script next to these
// files: without it, Node takes a `.js` file with `import` as CommonJS.
function versionFiles(version) {
  return {
    'package.json': json({ name: 'dez', type: 'module', version }),
    'package-lock.json': json({ name: 'dez', version, packages: { '': { name: 'dez', version } } }),
    'src-tauri/tauri.conf.json': json({ productName: 'Dez', version }),
    'src-tauri/Cargo.toml': `[package]\nname = "dez"\nversion = "${version}"\n\n[dependencies]\nserde = "1"\n`,
    'src-tauri/Cargo.lock': `version = 4\n\n[[package]]\nname = "dbus"\nversion = "${version}"\n\n[[package]]\nname = "dez"\nversion = "${version}"\n`
  };
}

// The files of a release commit of `version`: the version files and the
// signed message.
function releasedFiles(version) {
  return { ...versionFiles(version), [MESSAGE_PATH]: version };
}

describe('versionMismatches', () => {
  it('lists every file when the tag is newer than the files, as for v0.12.1', () => {
    expect(versionMismatches('0.12.1', releasedFiles('0.12.0'))).toEqual([
      { path: 'package.json', found: ['0.12.0'] },
      { path: 'package-lock.json', found: ['0.12.0', '0.12.0'] },
      { path: 'src-tauri/tauri.conf.json', found: ['0.12.0'] },
      { path: 'src-tauri/Cargo.toml', found: ['0.12.0'] },
      { path: 'src-tauri/Cargo.lock', found: ['0.12.0'] },
      { path: MESSAGE_PATH, found: ['0.12.0'] }
    ]);
  });

  it('finds one stale field in a file whose other field matches', () => {
    const files = releasedFiles('0.12.1');
    files['package-lock.json'] = json({ version: '0.12.1', packages: { '': { version: '0.12.0' } } });
    expect(versionMismatches('0.12.1', files)).toEqual([
      { path: 'package-lock.json', found: ['0.12.1', '0.12.0'] }
    ]);
  });

  it('reports a file with no version line, which a bump refuses to update', () => {
    const files = releasedFiles('0.12.1');
    files['src-tauri/Cargo.toml'] = '[package]\nname = "dez"\n';
    expect(versionMismatches('0.12.1', files)).toEqual([
      { path: 'src-tauri/Cargo.toml', found: [undefined] }
    ]);
    expect(() => bumpedFiles('0.12.2', files)).toThrow(/Could not update src-tauri\/Cargo\.toml/);
  });

  it('accepts only a message that is the version exactly, as its signature covers each byte', () => {
    for (const message of ['0.12.1\n', 'v0.12.1', undefined]) {
      expect(versionMismatches('0.12.1', { ...versionFiles('0.12.1'), [MESSAGE_PATH]: message })).toEqual([
        { path: MESSAGE_PATH, found: [message] }
      ]);
    }
  });
});

describe('bumpedFiles', () => {
  it('updates every version file, and only the dez package in Cargo.lock', () => {
    const files = { ...releasedFiles('0.12.0'), ...bumpedFiles('0.12.1', releasedFiles('0.12.0')) };
    // The message stays: only a release writes it, together with its signature.
    expect(versionMismatches('0.12.1', files)).toEqual([{ path: MESSAGE_PATH, found: ['0.12.0'] }]);
    expect(files['src-tauri/Cargo.lock']).toContain('name = "dbus"\nversion = "0.12.0"');
  });
});

describe('parseArgs', () => {
  it('releases only when the version comes with no flag', () => {
    expect(parseArgs(['0.6.1'])).toEqual({ mode: 'release', version: '0.6.1' });
    expect(parseArgs(['--check', 'v0.6.1'])).toEqual({ mode: 'check', version: '0.6.1' });
    expect(parseArgs(['0.6.1', '--check'])).toEqual({ mode: 'check', version: '0.6.1' });
    expect(parseArgs(['--files-only', '0.6.1'])).toEqual({ mode: 'files-only', version: '0.6.1' });
  });

  it('refuses anything but one valid version and one flag, so a mistyped flag never releases', () => {
    expect(() => parseArgs(['--check'])).toThrow('Expected one version, got: (none)');
    expect(() => parseArgs(['0.6.1', '0.6.2'])).toThrow('Expected one version, got: 0.6.1 0.6.2');
    expect(() => parseArgs(['0.6.1', '--chek'])).toThrow('Expected one version, got: 0.6.1 --chek');
    expect(() => parseArgs(['--file-only', '0.6.1'])).toThrow('Expected one version, got: --file-only 0.6.1');
    expect(() => parseArgs(['--check', '--files-only', '0.6.1'])).toThrow('Expected at most one flag, got: --check --files-only');
    expect(() => parseArgs(['0.6'])).toThrow('Invalid version: 0.6');
  });
});

// The release itself runs git and minisign, so these tests run a copy of the
// script in a throwaway repo. The script finds its repo from its own path
// and the commit key from HOME, and both are in a temp folder here: no run
// can reach the real repo, the real remote, or the real keys.
describe('a release in a throwaway repo', { timeout: 30_000 }, () => {
  const SCRIPT = 'scripts/bump-version-and-release.js';
  const PUBLIC_KEY = 'src-tauri/updater/dez-commit-key.pub';
  const hasMinisign = spawnSync('minisign', ['-v']).status === 0;
  const roots = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // A repo at 0.1.0 on `main` with a copy of the script, and a bare repo as
  // its `origin` that has the same commit. With `keys`, HOME has a commit
  // key with no password, and the repo has its public key; with
  // `keys: 'wrong'`, the repo has the public key of another key.
  function sandbox({ keys } = {}) {
    const root = mkdtempSync(join(tmpdir(), 'dez-release-test-'));
    roots.push(root);
    const work = join(root, 'work');
    const home = join(root, 'home');
    // Only these variables: no git config of the machine, and no real HOME.
    const env = {
      PATH: process.env.PATH,
      HOME: home,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com'
    };
    const exec = (command, args, cwd = work) => {
      const result = spawnSync(command, args, { cwd, env, encoding: 'utf8' });
      if (result.status !== 0) {
        throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr}`);
      }
      // Not trim(): the first line of `git status --porcelain` can start
      // with a space.
      return result.stdout.trimEnd();
    };
    const git = (...args) => exec('git', args);
    const write = (path, text) => {
      mkdirSync(dirname(join(work, path)), { recursive: true });
      writeFileSync(join(work, path), text);
    };

    mkdirSync(join(home, '.minisign'), { recursive: true });
    exec('git', ['init', '--quiet', '--bare', '--initial-branch=main', join(root, 'remote.git')], root);
    exec('git', ['init', '--quiet', '--initial-branch=main', work], root);
    for (const [path, text] of Object.entries(versionFiles('0.1.0'))) {
      write(path, text);
    }
    mkdirSync(join(work, 'scripts'));
    copyFileSync(fileURLToPath(new URL('./bump-version-and-release.js', import.meta.url)), join(work, SCRIPT));
    if (keys) {
      // -W: no password. The script signs with the key in HOME.
      const makeKey = (publicKey, secretKey) => exec('minisign', ['-G', '-W', '-p', publicKey, '-s', secretKey]);
      mkdirSync(join(work, dirname(PUBLIC_KEY)), { recursive: true });
      makeKey(keys === 'wrong' ? join(root, 'unused.pub') : PUBLIC_KEY, join(home, '.minisign', 'dez-tag-key.key'));
      if (keys === 'wrong') {
        makeKey(PUBLIC_KEY, join(root, 'other.key'));
      }
    }
    git('add', '--all');
    git('commit', '--quiet', '--message=start');
    git('remote', 'add', 'origin', join(root, 'remote.git'));
    git('push', '--quiet', '--set-upstream', 'origin', 'main');

    return {
      root,
      work,
      exec,
      git,
      write,
      // Runs the script copy. stdin is empty, so nothing can wait for a prompt.
      script: (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd: work, env, encoding: 'utf8', input: '' }),
      // What a failed run must leave as it was.
      state: () => ({
        head: git('rev-parse', 'HEAD'),
        changes: git('status', '--porcelain'),
        tags: git('tag'),
        remote: git('ls-remote', '--refs', 'origin')
      })
    };
  }

  it.skipIf(!hasMinisign)('bumps, signs the version, commits only the release files, tags with one v, and pushes', () => {
    const box = sandbox({ keys: true });
    // A staged change that is not part of a release.
    box.write('notes.txt', 'draft\n');
    box.git('add', 'notes.txt');

    const result = box.script('v0.2.0');
    expect(result.status, result.stderr).toBe(0);

    const head = box.git('rev-parse', 'HEAD');
    expect(box.git('ls-remote', '--refs', 'origin')).toBe(`${head}\trefs/heads/main\n${head}\trefs/tags/v0.2.0`);
    expect(box.git('log', '-1', '--format=%s')).toBe('v0.2.0');
    expect(box.git('diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD').split('\n')).toEqual(
      [...Object.keys(versionFiles('0.2.0')), MESSAGE_PATH, SIGNATURE_PATH].sort()
    );
    expect(box.git('status', '--porcelain')).toBe('A  notes.txt');

    expect(readFileSync(join(box.work, MESSAGE_PATH), 'utf8')).toBe('0.2.0');
    // Throws unless the committed signature verifies against the committed key.
    box.exec('minisign', ['-V', '-H', '-q', '-p', PUBLIC_KEY, '-m', MESSAGE_PATH, '-x', SIGNATURE_PATH]);
    expect(box.script('--check', 'v0.2.0').status).toBe(0);
  });

  // No commit key exists here, so the run also fails if it gets to signing.
  it('changes nothing when the remote cannot be reached', () => {
    const box = sandbox();
    const before = box.state();
    box.git('remote', 'set-url', 'origin', join(box.root, 'missing.git'));

    const result = box.script('0.2.0');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Your SSH keys are not able to push to "origin".\nNothing was changed.');
    box.git('remote', 'set-url', 'origin', join(box.root, 'remote.git'));
    expect(box.state()).toEqual(before);
  });

  it('changes nothing when the tag exists, on the remote or here', () => {
    const box = sandbox();
    box.git('tag', 'v0.2.0');
    const local = box.state();
    let result = box.script('0.2.0');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('The tag v0.2.0 already exists.\nNothing was changed.');
    expect(box.state()).toEqual(local);

    box.git('push', '--quiet', 'origin', 'v0.2.0');
    box.git('tag', '--delete', 'v0.2.0');
    const remote = box.state();
    result = box.script('0.2.0');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('The tag v0.2.0 already exists on "origin".\nNothing was changed.');
    expect(box.state()).toEqual(remote);
  });

  // No commit key exists here, so the run also fails if it gets to signing.
  it('changes nothing when a version file holds another change', () => {
    const box = sandbox();
    box.write('package-lock.json', json({
      name: 'dez',
      version: '0.1.0',
      packages: { '': { name: 'dez', version: '0.1.0' }, 'node_modules/drift': { version: '9.9.9' } }
    }));
    const before = box.state();

    const result = box.script('0.2.0');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('- package-lock.json\nNothing was changed.');
    expect(box.state()).toEqual(before);
  });

  it.skipIf(!hasMinisign)('makes no commit when the signature is not from the committed key', () => {
    const box = sandbox({ keys: 'wrong' });
    const before = box.state();

    const result = box.script('0.2.0');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`The new signature does not verify against ${PUBLIC_KEY}`);
    expect(result.stderr).toContain('Nothing was committed');
    expect(box.state()).toEqual({ ...before, changes: expect.stringContaining(MESSAGE_PATH) });
  });

  // The way on after a failed signature is to run the command again, when
  // the version files already hold the new version. The check for other
  // changes in those files must let that run through.
  it.skipIf(!hasMinisign)('releases on a second run after the signing failed', () => {
    const box = sandbox({ keys: true });
    const key = join(box.root, 'home', '.minisign', 'dez-tag-key.key');
    renameSync(key, `${key}.away`);
    let result = box.script('0.2.0');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Nothing was committed');

    renameSync(`${key}.away`, key);
    result = box.script('0.2.0');
    expect(result.status, result.stderr).toBe(0);
    expect(box.git('log', '-1', '--format=%s')).toBe('v0.2.0');
    expect(box.git('status', '--porcelain')).toBe('');
  });

  it.skipIf(!hasMinisign)('keeps the tag off the remote when the remote refuses the branch', () => {
    const box = sandbox({ keys: true });
    // The remote gets a commit that this repo then loses, as when another
    // machine pushed first.
    box.git('commit', '--quiet', '--allow-empty', '--message=elsewhere');
    box.git('push', '--quiet', 'origin', 'main');
    box.git('reset', '--quiet', '--hard', 'HEAD~1');
    const remote = box.git('ls-remote', '--refs', 'origin');

    const result = box.script('0.2.0');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`The release commit and the tag v0.2.0 are only on this machine. To push them:
  git push --atomic origin HEAD refs/tags/v0.2.0`);
    expect(box.git('ls-remote', '--refs', 'origin')).toBe(remote);
    expect(box.git('rev-parse', 'v0.2.0')).toBe(box.git('rev-parse', 'HEAD'));
    expect(box.git('log', '-1', '--format=%s')).toBe('v0.2.0');
  });

  it('--files-only bumps the version files and makes no message, commit, or tag', () => {
    const box = sandbox();
    const before = box.state();

    expect(box.script('--files-only', '0.2.0').status).toBe(0);
    expect(box.state()).toEqual({
      ...before,
      changes: Object.keys(versionFiles('0.2.0')).sort().map(path => ` M ${path}`).join('\n')
    });
    expect(existsSync(join(box.work, MESSAGE_PATH))).toBe(false);
    expect(box.script('--check', '0.2.0').stderr).toContain(`- ${MESSAGE_PATH}: no version`);
  });
});
