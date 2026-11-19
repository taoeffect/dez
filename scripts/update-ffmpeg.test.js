import { describe, expect, it } from 'vitest';
import { hostTriple } from './bundled-programs.js';
import {
  LIBRARIES,
  PLATFORMS,
  TOOLS,
  licenseProblem,
  licenseTextsFile,
  licenseTextsProblem,
  manifestText,
  noticeText,
  parseArgs,
  reportedVersion,
  vendoredFiles,
  vendoredName
} from './update-ffmpeg.js';

const sha = letter => letter.repeat(64);

// The release data of the GitHub API, with the files that Dez takes and
// some that it does not. Each file has its own size and SHA-256.
function release(tag = 'n9.0.2-3') {
  const names = [
    'ffmpeg-linux-arm64', 'ffmpeg-linux-arm64-ubuntu-24.04', 'ffmpeg-linux-x64', 'ffmpeg-macos-arm64',
    'ffmpeg-osx-x64', 'ffmpeg-win-x64.exe', 'ffprobe-linux-arm64', 'ffprobe-linux-x64',
    'ffprobe-linux-x64-ubuntu-24.04', 'ffprobe-macos-arm64', 'LICENSES.txt'
  ];
  return {
    tag_name: tag,
    assets: names.map((name, index) => ({
      name,
      size: 1000 + index,
      digest: `sha256:${sha(index.toString(16))}`
    }))
  };
}

describe('parseArgs', () => {
  it('takes one release tag', () => {
    expect(parseArgs(['n9.0.2-3'])).toEqual({ tag: 'n9.0.2-3' });
    expect(parseArgs(['n9.0-11'])).toEqual({ tag: 'n9.0-11' });
  });

  it('refuses anything but one tag of an FFmpeg version and a build number', () => {
    expect(() => parseArgs([])).toThrow('Expected one release tag, got: (none)');
    expect(() => parseArgs(['n9.0.2-3', 'n9.0.2-4'])).toThrow('Expected one release tag, got: n9.0.2-3 n9.0.2-4');
    expect(() => parseArgs(['n9.0.2'])).toThrow('Invalid release tag: n9.0.2');
    expect(() => parseArgs(['9.0.2-3'])).toThrow('Invalid release tag: 9.0.2-3');
    expect(() => parseArgs(['n9.0.2-3/../x'])).toThrow('Invalid release tag: n9.0.2-3/../x');
  });
});

describe('vendoredFiles', () => {
  it('takes the fully static file of each program for each platform of Dez, with its size and SHA-256', () => {
    expect(vendoredFiles(release())).toEqual([
      { name: 'dez-ffmpeg-aarch64-unknown-linux-gnu', asset: 'ffmpeg-linux-arm64', size: 1000, sha256: sha('0') },
      { name: 'dez-ffprobe-aarch64-unknown-linux-gnu', asset: 'ffprobe-linux-arm64', size: 1006, sha256: sha('6') },
      { name: 'dez-ffmpeg-x86_64-unknown-linux-gnu', asset: 'ffmpeg-linux-x64', size: 1002, sha256: sha('2') },
      { name: 'dez-ffprobe-x86_64-unknown-linux-gnu', asset: 'ffprobe-linux-x64', size: 1007, sha256: sha('7') },
      { name: 'dez-ffmpeg-aarch64-apple-darwin', asset: 'ffmpeg-macos-arm64', size: 1003, sha256: sha('3') },
      { name: 'dez-ffprobe-aarch64-apple-darwin', asset: 'ffprobe-macos-arm64', size: 1009, sha256: sha('9') }
    ]);
  });

  it('refuses a release that lacks a file of one platform', () => {
    const data = release();
    data.assets = data.assets.filter(asset => asset.name !== 'ffprobe-macos-arm64');
    expect(() => vendoredFiles(data)).toThrow('The release n9.0.2-3 has no file ffprobe-macos-arm64.');
  });

  it('refuses a file that GitHub gives no SHA-256 for, as nothing can check it', () => {
    for (const digest of [null, undefined, 'md5:0123', `sha256:${sha('g')}`, `sha256:${sha('a')}0`]) {
      const data = release();
      data.assets.find(asset => asset.name === 'ffmpeg-linux-x64').digest = digest;
      expect(() => vendoredFiles(data)).toThrow('The release n9.0.2-3 gives no SHA-256 for ffmpeg-linux-x64.');
    }
  });
});

describe('licenseTextsFile', () => {
  it('takes the license texts of the release, with their size and SHA-256', () => {
    expect(licenseTextsFile(release())).toEqual({ name: 'LICENSES.txt', asset: 'LICENSES.txt', size: 1010, sha256: sha('a') });
  });

  it('refuses a release with no license texts, as the releases before n9.0.2-4', () => {
    const data = release();
    data.assets = data.assets.filter(asset => asset.name !== 'LICENSES.txt');
    expect(() => licenseTextsFile(data)).toThrow('The release n9.0.2-3 has no file LICENSES.txt.');
  });
});

// A LICENSES.txt as 91-licenses.sh of the build repository writes it, with
// one part for each file of each library id.
function licenseTexts(ids) {
  const rule = '='.repeat(80);
  const parts = ids.map(id => `${rule}\n${id} v1.0: COPYING\n${rule}\n\nThe text of ${id}.\n`);
  return `The license texts of the ffmpeg and ffprobe programs of dez-ffmpeg.\n\n${parts.join('')}`;
}

const ALL_IDS = ['ffmpeg', ...LIBRARIES.map(library => library.id)];

describe('licenseTextsProblem', () => {
  it('takes texts with a part for FFmpeg and for each library, and more than one file of a library', () => {
    expect(licenseTextsProblem(licenseTexts(['ffmpeg', ...ALL_IDS]))).toBeUndefined();
  });

  it('refuses texts that lack a library of LIBRARIES', () => {
    const ids = ALL_IDS.filter(id => id !== 'musl' && id !== 'fribidi');
    expect(licenseTextsProblem(licenseTexts(ids))).toMatch(/^has no license text of fribidi, musl, /);
  });

  it('refuses texts of a library that LIBRARIES does not name, as NOTICE.md would not name it', () => {
    expect(licenseTextsProblem(licenseTexts([...ALL_IDS, 'mbedtls']))).toMatch(/^has the license text of mbedtls, /);
  });

  it('takes a part only from a head between two rule lines', () => {
    const text = licenseTexts(ALL_IDS.filter(id => id !== 'opus')) + 'opus v1.6.1: COPYING\n';
    expect(licenseTextsProblem(text)).toMatch(/^has no license text of opus, /);
  });
});

describe('manifestText', () => {
  it('names each file as the build names it, for every target and program', () => {
    const manifest = JSON.parse(manifestText('n9.0.2-3', vendoredFiles(release()), licenseTextsFile(release())));
    expect(manifest).toMatchObject({
      ffmpegVersion: 'n9.0.2',
      releaseTag: 'n9.0.2-3',
      source: 'https://github.com/taoeffect/dez-ffmpeg/releases/tag/n9.0.2-3'
    });
    // build.rs finds a file by `dez-<program>-<TARGET>`.
    const names = Object.keys(PLATFORMS).flatMap(triple => TOOLS.map(tool => vendoredName(tool, triple)));
    expect(Object.keys(manifest.files).sort()).toEqual(names.sort());
    // The pin of a program: fetch-programs.js downloads it from `url`, and
    // takes only a file of that size and SHA-256.
    expect(manifest.files['dez-ffprobe-x86_64-unknown-linux-gnu']).toEqual({
      asset: 'ffprobe-linux-x64',
      url: 'https://github.com/taoeffect/dez-ffmpeg/releases/download/n9.0.2-3/ffprobe-linux-x64',
      size: 1007,
      sha256: sha('7')
    });
    expect(manifest.licenseTexts).toEqual({ asset: 'LICENSES.txt', size: 1010, sha256: sha('a') });
  });
});

describe('noticeText', () => {
  it('links the source of the FFmpeg version and the build of the release tag', () => {
    const notice = noticeText('n9.1-11');
    expect(notice).toContain('- FFmpeg version: n9.1\n');
    expect(notice).toContain('https://git.ffmpeg.org/gitweb/ffmpeg.git/tag/refs/tags/n9.1>');
    expect(notice).toContain('https://github.com/taoeffect/dez-ffmpeg/releases/tag/n9.1-11)');
    expect(notice).toContain('https://github.com/taoeffect/dez-ffmpeg/tree/n9.1-11>');
    expect(notice).not.toContain('n9.0');
  });

  it('links the library versions of the release tag, and gives the credit that the FreeType License asks for', () => {
    const notice = noticeText('n9.1-11');
    expect(notice).toContain('(https://github.com/taoeffect/dez-ffmpeg/blob/n9.1-11/versions.txt)');
    expect(notice).toContain(
      'FreeType: Portions of this software are copyright © The FreeType Project (https://freetype.org). All rights reserved.'
    );
  });
});

describe('PLATFORMS', () => {
  it('has programs for every computer that hostTriple names', () => {
    for (const [platform, arch] of [['linux', 'arm64'], ['linux', 'x64'], ['darwin', 'arm64']]) {
      expect(PLATFORMS).toHaveProperty(hostTriple(platform, arch));
    }
  });
});

describe('reportedVersion', () => {
  it('reads the version of the first line of both programs', () => {
    expect(reportedVersion('ffmpeg version n9.0.2 Copyright (c) 2000-2026 the FFmpeg developers\nbuilt with gcc'))
      .toBe('n9.0.2');
    expect(reportedVersion('ffprobe version n9.0.2 Copyright (c) 2007-2026 the FFmpeg developers')).toBe('n9.0.2');
  });

  it('gives nothing for another output', () => {
    expect(reportedVersion('')).toBeUndefined();
    expect(reportedVersion('built with gcc\nffmpeg version n9.0.2')).toBeUndefined();
  });
});

describe('licenseProblem', () => {
  const program = configuration => Buffer.from(`\x7fELF\0\0%sconfiguration: ${configuration}\0\0more`);

  it('passes a GPL version 3 build', () => {
    expect(licenseProblem(program('--disable-ffplay --enable-libx264 --enable-gpl --enable-version3 --enable-static')))
      .toBeUndefined();
  });

  it('refuses a build with nonfree parts, which nobody may ship', () => {
    expect(licenseProblem(program('--enable-gpl --enable-version3 --enable-nonfree --enable-libfdk-aac')))
      .toBe('is built with --enable-nonfree, so Dez may not ship it');
  });

  it('refuses a build with another license than the notice names', () => {
    expect(licenseProblem(program('--enable-gpl --enable-static')))
      .toBe('is built without --enable-version3, so NOTICE.md would name the wrong license');
    expect(licenseProblem(program('--enable-version3 --enable-static')))
      .toBe('is built without --enable-gpl, so NOTICE.md would name the wrong license');
  });
});
