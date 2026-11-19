import { describe, expect, it } from 'vitest';
import { hostTriple } from './bundled-programs.js';
import { pinnedPrograms } from './fetch-programs.js';
import {
  licenseProblem,
  manifestText,
  noticeText,
  parseArgs,
  releaseZipFiles,
  reportedVersion,
  statedSha256,
  vendoredName
} from './update-deno.js';

const sha = letter => letter.repeat(64);

// The release data of the GitHub API, with the files that Dez takes and
// some that it does not. Each file has its own size and SHA-256.
function release(version = '2.9.8') {
  const names = [
    'deno-aarch64-apple-darwin.zip', 'deno-aarch64-apple-darwin.zip.sha256sum', 'deno-aarch64-unknown-linux-gnu.zip',
    'deno-x86_64-apple-darwin.zip', 'deno-x86_64-pc-windows-msvc.zip', 'deno-x86_64-unknown-linux-gnu.zip',
    'denort-x86_64-unknown-linux-gnu.zip', 'deno_src.tar.gz', 'lib.deno.d.ts'
  ];
  return {
    tag_name: `v${version}`,
    assets: names.map((name, index) => ({ name, size: 1000 + index, digest: `sha256:${sha(index.toString(16))}` }))
  };
}

// The files of a release as the script vendors them: each zip file of
// `releaseZipFiles` with the size and the SHA-256 of its program.
const vendoredFiles = (version = '2.9.8') =>
  releaseZipFiles(release(version)).map((file, index) => ({ ...file, size: 5000 + index, sha256: sha('abc'[index]) }));

describe('parseArgs', () => {
  it('takes one Deno version', () => {
    expect(parseArgs(['2.9.8'])).toEqual({ version: '2.9.8' });
    expect(parseArgs(['12.0.10'])).toEqual({ version: '12.0.10' });
  });

  it('refuses anything but one version of three numbers', () => {
    expect(() => parseArgs([])).toThrow('Expected one Deno version, got: (none)');
    expect(() => parseArgs(['2.9.8', '2.9.9'])).toThrow('Expected one Deno version, got: 2.9.8 2.9.9');
    expect(() => parseArgs(['v2.9.8'])).toThrow('Invalid Deno version: v2.9.8');
    expect(() => parseArgs(['2.9'])).toThrow('Invalid Deno version: 2.9');
    expect(() => parseArgs(['2.9.8-rc.1'])).toThrow('Invalid Deno version: 2.9.8-rc.1');
    expect(() => parseArgs(['2.9.8/../x'])).toThrow('Invalid Deno version: 2.9.8/../x');
  });
});

describe('releaseZipFiles', () => {
  it('takes the zip file of each platform of Dez, with the pin that GitHub states and the name of the program in it', () => {
    expect(releaseZipFiles(release())).toEqual([
      {
        name: 'dez-deno-aarch64-unknown-linux-gnu',
        triple: 'aarch64-unknown-linux-gnu',
        asset: 'deno-aarch64-unknown-linux-gnu.zip',
        zip: { member: 'deno', size: 1002, sha256: sha('2') }
      },
      {
        name: 'dez-deno-x86_64-unknown-linux-gnu',
        triple: 'x86_64-unknown-linux-gnu',
        asset: 'deno-x86_64-unknown-linux-gnu.zip',
        zip: { member: 'deno', size: 1005, sha256: sha('5') }
      },
      {
        name: 'dez-deno-aarch64-apple-darwin',
        triple: 'aarch64-apple-darwin',
        asset: 'deno-aarch64-apple-darwin.zip',
        zip: { member: 'deno', size: 1000, sha256: sha('0') }
      }
    ]);
  });

  it('has a program for every computer that hostTriple names', () => {
    const names = releaseZipFiles(release()).map(file => file.name);
    for (const [platform, arch] of [['linux', 'arm64'], ['linux', 'x64'], ['darwin', 'arm64']]) {
      expect(names).toContain(vendoredName(hostTriple(platform, arch)));
    }
  });

  it('refuses a release that lacks the zip file of one platform, or gives no SHA-256 for it', () => {
    const lacking = release();
    lacking.assets = lacking.assets.filter(asset => asset.name !== 'deno-aarch64-apple-darwin.zip');
    expect(() => releaseZipFiles(lacking)).toThrow('The release v2.9.8 has no file deno-aarch64-apple-darwin.zip.');
    const unchecked = release();
    unchecked.assets.find(asset => asset.name === 'deno-x86_64-unknown-linux-gnu.zip').digest = null;
    expect(() => releaseZipFiles(unchecked)).toThrow('The release v2.9.8 gives no SHA-256 for deno-x86_64-unknown-linux-gnu.zip.');
  });
});

describe('statedSha256', () => {
  it('reads the one line of a .sha256sum file of a release, for its file', () => {
    expect(statedSha256(`${sha('a')}  deno\n`, 'deno')).toBe(sha('a'));
    expect(statedSha256(`${sha('b')}  deno-x86_64-unknown-linux-gnu.zip\n`, 'deno-x86_64-unknown-linux-gnu.zip')).toBe(sha('b'));
    // The mark of the binary mode of sha256sum.
    expect(statedSha256(`${sha('c')} *deno\r\n`, 'deno')).toBe(sha('c'));
  });

  it('gives nothing for another file, and for a text of another form', () => {
    expect(statedSha256(`${sha('a')}  deno.exe\n`, 'deno')).toBeUndefined();
    expect(statedSha256(`${sha('a')}  deno\n${sha('b')}  deno\n`, 'deno')).toBeUndefined();
    expect(statedSha256(`${sha('A')}  deno\n`, 'deno')).toBeUndefined();
    expect(statedSha256(`${'a'.repeat(40)}  deno\n`, 'deno')).toBeUndefined();
    expect(statedSha256('<html>Not Found</html>', 'deno')).toBeUndefined();
  });
});

describe('manifestText', () => {
  it('pins the zip file and the program of each platform, and names the release for the Help page', () => {
    const manifest = JSON.parse(manifestText({}, '2.9.8', vendoredFiles()));
    expect(manifest.deno).toEqual({ version: '2.9.8', source: 'https://github.com/denoland/deno/releases/tag/v2.9.8' });
    expect(Object.keys(manifest.files)).toEqual([
      'dez-deno-aarch64-unknown-linux-gnu', 'dez-deno-x86_64-unknown-linux-gnu', 'dez-deno-aarch64-apple-darwin'
    ]);
    // `size` and `sha256` are those of the program file, which build.rs
    // checks; `zip` pins the download.
    expect(manifest.files['dez-deno-x86_64-unknown-linux-gnu']).toEqual({
      asset: 'deno-x86_64-unknown-linux-gnu.zip',
      url: 'https://github.com/denoland/deno/releases/download/v2.9.8/deno-x86_64-unknown-linux-gnu.zip',
      zip: { member: 'deno', size: 1005, sha256: sha('5') },
      size: 5001,
      sha256: sha('b')
    });
  });

  it('writes entries that fetch-programs.js can get the program from', () => {
    const manifest = JSON.parse(manifestText({}, '2.9.8', vendoredFiles()));
    expect(pinnedPrograms(manifest, ['dez-deno'], 'aarch64-apple-darwin')).toEqual([
      {
        name: 'dez-deno-aarch64-apple-darwin',
        url: 'https://github.com/denoland/deno/releases/download/v2.9.8/deno-aarch64-apple-darwin.zip',
        size: 5002,
        sha256: sha('c'),
        zip: { member: 'deno', size: 1000, sha256: sha('0') }
      }
    ]);
  });

  it('keeps the part of another update script as it is, and replaces all of its own part', () => {
    const ffmpeg = { asset: 'ffmpeg-linux-x64', url: 'https://example.com/ffmpeg', size: 7, sha256: sha('d') };
    const before = JSON.parse(manifestText({ releaseTag: 'n9.0.2-4', files: { 'dez-ffmpeg-x86_64-unknown-linux-gnu': ffmpeg } }, '2.9.7', vendoredFiles('2.9.7')));
    // A program of a platform that the script has no more.
    before.files['dez-deno-x86_64-apple-darwin'] = { size: 1 };

    const after = JSON.parse(manifestText(before, '2.9.8', vendoredFiles()));
    expect(after.releaseTag).toBe('n9.0.2-4');
    expect(after.files['dez-ffmpeg-x86_64-unknown-linux-gnu']).toEqual(ffmpeg);
    // Without the part of the other script, the manifest is the one of a
    // first run for the new version: nothing of the old version is left.
    delete after.releaseTag;
    delete after.files['dez-ffmpeg-x86_64-unknown-linux-gnu'];
    expect(after).toEqual(JSON.parse(manifestText({}, '2.9.8', vendoredFiles())));
  });
});

describe('noticeText', () => {
  it('links the release and the source of the Deno version, and the V8 source of its v8 crate', () => {
    const notice = noticeText('2.10.1', '151.0.2');
    expect(notice).toContain('- Deno version: 2.10.1\n');
    expect(notice).toContain('(https://github.com/denoland/deno/releases/tag/v2.10.1)');
    expect(notice).toContain('<https://github.com/denoland/deno/tree/v2.10.1>');
    expect(notice).toContain('(https://github.com/denoland/deno/blob/v2.10.1/LICENSE.md)');
    expect(notice).toContain('<https://github.com/denoland/rusty_v8/tree/v151.0.2>');
    expect(notice).not.toContain('2.9.');
  });
});

describe('licenseProblem', () => {
  it('passes the MIT License, which the notice names', () => {
    expect(licenseProblem('MIT License\n\nCopyright 2018-2026 the Deno authors\n')).toBeUndefined();
  });

  it('refuses another license text, and a source with no license file', () => {
    expect(licenseProblem('Apache License\nVersion 2.0, January 2004\n')).toMatch(/so NOTICE\.md would name the wrong license$/);
    expect(licenseProblem('Not the MIT License of before.\n')).toMatch(/so NOTICE\.md would name the wrong license$/);
    expect(licenseProblem('')).toMatch(/so NOTICE\.md would name the wrong license$/);
  });
});

describe('reportedVersion', () => {
  it('reads the version of the first line', () => {
    expect(reportedVersion('deno 2.9.8 (stable, release, aarch64-unknown-linux-gnu)\nv8 15.0.4-rusty\ntypescript 6.0.3\n')).toBe('2.9.8');
  });

  it('gives nothing for another output', () => {
    expect(reportedVersion('')).toBeUndefined();
    expect(reportedVersion('v8 15.0.4-rusty\ndeno 2.9.8')).toBeUndefined();
  });
});
