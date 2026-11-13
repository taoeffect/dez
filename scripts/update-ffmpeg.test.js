import { describe, expect, it } from 'vitest';
import {
  PLATFORMS,
  TOOLS,
  hostTriple,
  licenseProblem,
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
function release(tag = 'n8.1.2-2') {
  const names = [
    'ffmpeg-linux-arm64', 'ffmpeg-linux-arm64-ubuntu-24.04', 'ffmpeg-linux-x64', 'ffmpeg-osx-arm64',
    'ffmpeg-osx-x64', 'ffmpeg-win-x64.exe', 'ffprobe-linux-arm64', 'ffprobe-linux-x64',
    'ffprobe-linux-x64-ubuntu-24.04', 'ffprobe-osx-arm64'
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
    expect(parseArgs(['n8.1.2-2'])).toEqual({ tag: 'n8.1.2-2' });
    expect(parseArgs(['n9.0-11'])).toEqual({ tag: 'n9.0-11' });
  });

  it('refuses anything but one tag of an FFmpeg version and a build number', () => {
    expect(() => parseArgs([])).toThrow('Expected one release tag, got: (none)');
    expect(() => parseArgs(['n8.1.2-2', 'n8.1.2-3'])).toThrow('Expected one release tag, got: n8.1.2-2 n8.1.2-3');
    expect(() => parseArgs(['n8.1.2'])).toThrow('Invalid release tag: n8.1.2');
    expect(() => parseArgs(['8.1.2-2'])).toThrow('Invalid release tag: 8.1.2-2');
    expect(() => parseArgs(['n8.1.2-2/../x'])).toThrow('Invalid release tag: n8.1.2-2/../x');
  });
});

describe('vendoredFiles', () => {
  it('takes the fully static file of each program for each platform of Dez, with its size and SHA-256', () => {
    expect(vendoredFiles(release())).toEqual([
      { name: 'dez-ffmpeg-aarch64-unknown-linux-gnu', asset: 'ffmpeg-linux-arm64', size: 1000, sha256: sha('0') },
      { name: 'dez-ffprobe-aarch64-unknown-linux-gnu', asset: 'ffprobe-linux-arm64', size: 1006, sha256: sha('6') },
      { name: 'dez-ffmpeg-x86_64-unknown-linux-gnu', asset: 'ffmpeg-linux-x64', size: 1002, sha256: sha('2') },
      { name: 'dez-ffprobe-x86_64-unknown-linux-gnu', asset: 'ffprobe-linux-x64', size: 1007, sha256: sha('7') },
      { name: 'dez-ffmpeg-aarch64-apple-darwin', asset: 'ffmpeg-osx-arm64', size: 1003, sha256: sha('3') },
      { name: 'dez-ffprobe-aarch64-apple-darwin', asset: 'ffprobe-osx-arm64', size: 1009, sha256: sha('9') }
    ]);
  });

  it('refuses a release that lacks a file of one platform', () => {
    const data = release();
    data.assets = data.assets.filter(asset => asset.name !== 'ffprobe-osx-arm64');
    expect(() => vendoredFiles(data)).toThrow('The release n8.1.2-2 has no file ffprobe-osx-arm64.');
  });

  it('refuses a file that GitHub gives no SHA-256 for, as nothing can check it', () => {
    for (const digest of [null, undefined, 'md5:0123', `sha256:${sha('g')}`, `sha256:${sha('a')}0`]) {
      const data = release();
      data.assets.find(asset => asset.name === 'ffmpeg-linux-x64').digest = digest;
      expect(() => vendoredFiles(data)).toThrow('The release n8.1.2-2 gives no SHA-256 for ffmpeg-linux-x64.');
    }
  });
});

describe('manifestText', () => {
  it('names each file as the build names it, for every target and program', () => {
    const manifest = JSON.parse(manifestText('n8.1.2-2', vendoredFiles(release())));
    expect(manifest).toMatchObject({
      ffmpegVersion: 'n8.1.2',
      releaseTag: 'n8.1.2-2',
      source: 'https://github.com/shaka-project/static-ffmpeg-binaries/releases/tag/n8.1.2-2'
    });
    // build.rs finds a file by `dez-<program>-<TARGET>`.
    const names = Object.keys(PLATFORMS).flatMap(triple => TOOLS.map(tool => vendoredName(tool, triple)));
    expect(Object.keys(manifest.files).sort()).toEqual(names.sort());
    expect(manifest.files['dez-ffprobe-x86_64-unknown-linux-gnu']).toEqual({
      asset: 'ffprobe-linux-x64',
      size: 1007,
      sha256: sha('7')
    });
  });
});

describe('noticeText', () => {
  it('links the source of the FFmpeg version and the build of the release tag', () => {
    const notice = noticeText('n9.0-11');
    expect(notice).toContain('- FFmpeg version: n9.0\n');
    expect(notice).toContain('https://git.ffmpeg.org/gitweb/ffmpeg.git/tag/refs/tags/n9.0>');
    expect(notice).toContain('https://github.com/shaka-project/static-ffmpeg-binaries/releases/tag/n9.0-11)');
    expect(notice).toContain('https://github.com/shaka-project/static-ffmpeg-binaries/tree/n9.0-11>');
    expect(notice).not.toContain('n8.');
  });
});

describe('hostTriple', () => {
  it('gives the target triple of each platform of Dez, and none for another computer', () => {
    expect(hostTriple('linux', 'arm64')).toBe('aarch64-unknown-linux-gnu');
    expect(hostTriple('linux', 'x64')).toBe('x86_64-unknown-linux-gnu');
    expect(hostTriple('darwin', 'arm64')).toBe('aarch64-apple-darwin');
    expect(hostTriple('darwin', 'x64')).toBeUndefined();
    expect(hostTriple('win32', 'x64')).toBeUndefined();
    // Every triple that it gives has programs.
    for (const [platform, arch] of [['linux', 'arm64'], ['linux', 'x64'], ['darwin', 'arm64']]) {
      expect(PLATFORMS).toHaveProperty(hostTriple(platform, arch));
    }
  });
});

describe('reportedVersion', () => {
  it('reads the version of the first line of both programs', () => {
    expect(reportedVersion('ffmpeg version n8.1.2 Copyright (c) 2000-2026 the FFmpeg developers\nbuilt with gcc'))
      .toBe('n8.1.2');
    expect(reportedVersion('ffprobe version n8.1.2 Copyright (c) 2007-2026 the FFmpeg developers')).toBe('n8.1.2');
  });

  it('gives nothing for another output', () => {
    expect(reportedVersion('')).toBeUndefined();
    expect(reportedVersion('built with gcc\nffmpeg version n8.1.2')).toBeUndefined();
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
