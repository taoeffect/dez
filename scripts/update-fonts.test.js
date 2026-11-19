import { describe, expect, it } from 'vitest';
import { FONT_SOURCES, fontNames, fontProblem, licenseProblem, manifestText } from './update-fonts.js';

// A name record of a font: platform, encoding, language, name ID, text.
const english = (id, text) => [3, 1, 0x409, id, text];

// A small sfnt font: its signature, a name table of the given name records
// (Windows texts are UTF-16BE, Mac texts Latin-1), and more tables with no
// content.
function font({
  signature = '00010000',
  names = [english(1, 'Noto Sans'), english(2, 'Regular'), english(5, 'Version 2.015')],
  tables = []
} = {}) {
  const texts = names.map(([platform, , , , text]) =>
    platform === 3 ? Buffer.from(text, 'utf16le').swap16() : Buffer.from(text, 'latin1')
  );
  const nameHeader = Buffer.alloc(6 + names.length * 12);
  nameHeader.writeUInt16BE(names.length, 2);
  nameHeader.writeUInt16BE(nameHeader.length, 4);
  let textOffset = 0;
  names.forEach(([platform, encoding, language, id], index) => {
    const record = 6 + index * 12;
    [platform, encoding, language, id, texts[index].length, textOffset].forEach((value, at) =>
      nameHeader.writeUInt16BE(value, record + at * 2)
    );
    textOffset += texts[index].length;
  });
  const contents = [['name', Buffer.concat([nameHeader, ...texts])], ...tables.map(tag => [tag, Buffer.alloc(4)])];

  const header = Buffer.alloc(12 + contents.length * 16);
  header.write(signature, 0, 'hex');
  header.writeUInt16BE(contents.length, 4);
  let offset = header.length;
  contents.forEach(([tag, content], index) => {
    const record = 12 + index * 16;
    header.write(tag, record, 'latin1');
    header.writeUInt32BE(offset, record + 8);
    header.writeUInt32BE(content.length, record + 12);
    offset += content.length;
  });
  return Buffer.concat([header, ...contents.map(([, content]) => content)]);
}

describe('fontProblem', () => {
  it.each([
    ['Version 2.015', 'NotoSans-v2.015'],
    ['Version 2.004;hotconv 1.0.118;makeotfexe 2.5.65603', 'Sans2.004'],
    ['Version 2.304; ttfautohint (v1.8.4.7-5d5b)', 'v2.304']
  ])('takes a static font whose version "%s" is the version of %s', (version, release) => {
    const names = [english(1, 'A'), english(2, 'Regular'), english(5, version)];
    expect(fontProblem(font({ names }), release)).toBeUndefined();
    expect(fontProblem(font({ names, signature: '4f54544f' }), release)).toBeUndefined();
  });

  it('refuses a collection, a variable font, and a file that is no font', () => {
    expect(fontProblem(font({ signature: '74746366' }), 'NotoSans-v2.015')).toMatch(/collection/);
    expect(fontProblem(font({ tables: ['fvar'] }), 'NotoSans-v2.015')).toMatch(/variable font/);
    const pointer = Buffer.from('version https://git-lfs.github.com/spec/v1\noid sha256:aa\nsize 431364\n');
    expect(fontProblem(pointer, 'NotoSans-v2.015')).toMatch(/not a TrueType or OpenType font/);
    expect(fontProblem(Buffer.from('<html>'), 'NotoSans-v2.015')).toMatch(/not a font/);
  });

  it('refuses a font of another release, or with no version name', () => {
    const names = version => [english(1, 'A'), english(2, 'Regular'), english(5, version)];
    expect(fontProblem(font({ names: names('Version 2.014') }), 'NotoSans-v2.015')).toMatch(
      /"Version 2.014", not the version of the release NotoSans-v2.015/
    );
    expect(fontProblem(font({ names: names('Version 2.0150') }), 'NotoSans-v2.015')).toMatch(/not the version/);
    expect(fontProblem(font({ names: [english(1, 'A'), english(2, 'Regular')] }), 'NotoSans-v2.015')).toMatch(
      /no English Windows family, style, or version/
    );
  });
});

describe('fontNames', () => {
  it('reads the English Windows names, not those of another platform or language', () => {
    const names = [
      [1, 0, 0, 1, 'Mac Family'],
      [3, 1, 0x411, 1, 'ノト'],
      english(1, 'Noto Serif CJK JP Black'),
      english(2, 'Regular'),
      english(5, 'Version 2.003'),
      english(16, 'Noto Serif CJK JP'),
      english(17, 'Black')
    ];
    expect(fontNames(font({ names }))).toEqual({
      family: 'Noto Serif CJK JP Black',
      style: 'Regular',
      version: 'Version 2.003'
    });
  });
});

describe('licenseProblem', () => {
  it('takes the OFL 1.1 with its lines broken anywhere, and refuses another license', () => {
    expect(licenseProblem('This Font Software is licensed under the SIL Open Font License,\nVersion 1.1.\n')).toBeUndefined();
    expect(licenseProblem('Licensed under the Apache License, Version 2.0')).toMatch(/not the SIL Open Font License/);
    expect(licenseProblem('SIL Open Font License, Version 1.0')).toMatch(/not the SIL Open Font License/);
  });
});

describe('manifestText', () => {
  it('names each font file with its names, source, license, size, and SHA-256', () => {
    const [notoSans, , , , cjkSans] = FONT_SOURCES;
    const fonts = [
      { source: notoSans, ...notoSans.fonts[0], family: 'Noto Sans', style: 'Regular', size: 10, sha256: 'a'.repeat(64) },
      { source: cjkSans, ...cjkSans.fonts[1], family: 'Noto Sans CJK JP', style: 'Bold', size: 20, sha256: 'b'.repeat(64) }
    ];
    const manifest = JSON.parse(manifestText(fonts));
    expect(Object.keys(manifest.fonts)).toEqual(['NotoSans-Regular.ttf', 'NotoSansCJKjp-Bold.otf']);
    expect(manifest.fonts['NotoSansCJKjp-Bold.otf']).toEqual({
      family: 'Noto Sans CJK JP',
      style: 'Bold',
      scripts: 'Chinese, Japanese, Korean (Japanese glyph forms)',
      repository: 'https://github.com/notofonts/noto-cjk',
      release: 'Sans2.004',
      url: 'https://raw.githubusercontent.com/notofonts/noto-cjk/Sans2.004/Sans/OTF/Japanese/NotoSansCJKjp-Bold.otf',
      license: 'OFL-1.1',
      licenseFile: 'NotoSansCJKjp-OFL.txt',
      licenseUrl: 'https://raw.githubusercontent.com/notofonts/noto-cjk/Sans2.004/LICENSE',
      size: 20,
      sha256: 'b'.repeat(64)
    });
    expect(manifest.fonts['NotoSans-Regular.ttf'].licenseUrl).toBe(
      'https://raw.githubusercontent.com/notofonts/latin-greek-cyrillic/NotoSans-v2.015/OFL.txt'
    );
  });
});

describe('FONT_SOURCES', () => {
  it('pins every font URL to its release tag or to a commit', () => {
    // raw.githubusercontent.com/<owner>/<repository>/<ref>/<path>
    const unpinned = FONT_SOURCES.flatMap(source =>
      source.fonts
        .map(({ url }) => url)
        .filter(url => {
          const ref = url.split('/')[5];
          return ref !== source.release && !/^[0-9a-f]{40}$/.test(ref);
        })
    );
    expect(unpinned).toEqual([]);
  });

  // Git LFS (.gitattributes) and the build check take only these names.
  it('names each font file and each license file once, with a font ending', () => {
    const files = FONT_SOURCES.flatMap(source => source.fonts.map(({ file }) => file));
    const licenses = FONT_SOURCES.map(source => source.licenseFile);
    expect(new Set([...files, ...licenses]).size).toBe(files.length + licenses.length);
    for (const file of files) expect(file).toMatch(/^[A-Za-z0-9-]+\.(ttf|otf)$/);
    for (const file of licenses) expect(file).toMatch(/^[A-Za-z0-9-]+-OFL\.txt$/);
  });
});
