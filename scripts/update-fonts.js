#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Vendors the fonts that Dez ships: downloads each font file of FONT_SOURCES
// and the license of its source, checks them, and writes the files and their
// manifest into src-tauri/fonts/. The font files are in Git LFS
// (.gitattributes); the licenses and the manifest are plain Git.
//
// Why Dez ships fonts: the bundled ffmpeg has no fontconfig and no CoreText,
// so its text filters (drawtext, subtitles, ass) find no font of the
// computer, and ffmpeg may open only the files of its work folder. A call
// names the shipped fonts that it needs, and Dez copies them there.
//
// src-tauri/build.rs checks the files against the manifest in every build,
// and `bundle.resources` (tauri.conf.json) ships the folder.

const USAGE = `Vendor the fonts that Dez ships (FONT_SOURCES of this script).

Usage:
  node scripts/update-fonts.js

The script takes no argument. It downloads each font and license from its
pinned URL, checks them, and writes them and manifest.json into
src-tauri/fonts/.`;

// The license of every font. `licenseProblem` checks each license text.
const LICENSE = 'OFL-1.1';

// The commit of notofonts/notofonts.github.io that the Noto fonts come from.
// The family repositories of Noto keep no font files in Git, and give each
// release as one zip of every build form (117 MB for Noto Sans). The files
// of this commit are the same bytes as the files of the release zips that
// FONT_SOURCES names, and `fontProblem` checks that each font has the
// version of its release.
const NOTO_FONTS_COMMIT = 'ebbf5a34c2aaac39770e02d24afcfe9a8ad55e3e';

// The URL of a file of a GitHub repository at a tag or a commit.
function githubFile(repository, ref, path) {
  return `https://raw.githubusercontent.com/${repository}/${ref}/${path}`;
}

// The unhinted build of a Noto family: hints help only small text on a
// screen, and the hinted files are larger.
function notoFonts(family, styles) {
  return styles.map(style => {
    const file = `${family}-${style}.ttf`;
    return { file, url: githubFile('notofonts/notofonts.github.io', NOTO_FONTS_COMMIT, `fonts/${family}/unhinted/ttf/${file}`) };
  });
}

// The files of a repository at its release tag.
function releaseFonts(repository, release, folder, files) {
  return files.map(file => ({ file, url: githubFile(repository, release, `${folder}/${file}`) }));
}

// The fonts that Dez ships, by source: the repository and release tag of the
// fonts, the scripts that they cover, the license file of the release (the
// path in the repository, and the name in src-tauri/fonts/), and the font
// files. Each URL is pinned to a tag or a commit.
//
// One static font per file: the drawtext filter draws with the first face of
// its file, so a collection (.ttc) would give one of its fonts, and a
// variable font only its default style. The Japanese CJK fonts hold the
// whole Pan-CJK glyph set, with the Japanese glyph forms. All the files are
// about 60 MB, of which the CJK files are 58 MB.
export const FONT_SOURCES = [
  {
    repository: 'notofonts/latin-greek-cyrillic',
    release: 'NotoSans-v2.015',
    scripts: 'Latin, Greek, Cyrillic',
    licensePath: 'OFL.txt',
    licenseFile: 'NotoSans-OFL.txt',
    fonts: notoFonts('NotoSans', ['Regular', 'Bold'])
  },
  {
    repository: 'notofonts/arabic',
    release: 'NotoSansArabic-v2.013',
    scripts: 'Arabic',
    licensePath: 'OFL.txt',
    licenseFile: 'NotoSansArabic-OFL.txt',
    fonts: notoFonts('NotoSansArabic', ['Regular', 'Bold'])
  },
  {
    repository: 'notofonts/hebrew',
    release: 'NotoSansHebrew-v3.001',
    scripts: 'Hebrew',
    licensePath: 'OFL.txt',
    licenseFile: 'NotoSansHebrew-OFL.txt',
    fonts: notoFonts('NotoSansHebrew', ['Regular', 'Bold'])
  },
  {
    repository: 'notofonts/devanagari',
    release: 'NotoSansDevanagari-v2.007',
    scripts: 'Devanagari',
    licensePath: 'OFL.txt',
    licenseFile: 'NotoSansDevanagari-OFL.txt',
    fonts: notoFonts('NotoSansDevanagari', ['Regular', 'Bold'])
  },
  {
    repository: 'notofonts/noto-cjk',
    release: 'Sans2.004',
    scripts: 'Chinese, Japanese, Korean (Japanese glyph forms)',
    licensePath: 'LICENSE',
    licenseFile: 'NotoSansCJKjp-OFL.txt',
    fonts: releaseFonts('notofonts/noto-cjk', 'Sans2.004', 'Sans/OTF/Japanese', [
      'NotoSansCJKjp-Regular.otf',
      'NotoSansCJKjp-Bold.otf'
    ])
  },
  {
    repository: 'notofonts/noto-cjk',
    release: 'Serif2.003',
    scripts: 'Chinese, Japanese, Korean (Japanese glyph forms)',
    // The Serif releases have no LICENSE at the root.
    licensePath: 'Serif/LICENSE',
    licenseFile: 'NotoSerifCJKjp-OFL.txt',
    fonts: releaseFonts('notofonts/noto-cjk', 'Serif2.003', 'Serif/OTF/Japanese', ['NotoSerifCJKjp-Black.otf'])
  },
  {
    repository: 'JetBrains/JetBrainsMono',
    release: 'v2.304',
    scripts: 'Latin, Greek, Cyrillic (monospaced)',
    licensePath: 'OFL.txt',
    licenseFile: 'JetBrainsMono-OFL.txt',
    fonts: releaseFonts('JetBrains/JetBrainsMono', 'v2.304', 'fonts/ttf', [
      'JetBrainsMono-Regular.ttf',
      'JetBrainsMono-Bold.ttf'
    ])
  }
];

// The sfnt version of a TrueType or OpenType font: TrueType outlines (two
// forms), or CFF outlines (`OTTO`).
const FONT_SIGNATURES = ['00010000', '74727565', '4f54544f'];

// The table records of an sfnt font: tag → { offset, length }.
function fontTables(bytes) {
  const count = bytes.readUInt16BE(4);
  const tables = new Map();
  for (let index = 0; index < count; index++) {
    const record = 12 + index * 16;
    tables.set(bytes.toString('latin1', record, record + 4), {
      offset: bytes.readUInt32BE(record + 8),
      length: bytes.readUInt32BE(record + 12)
    });
  }
  return tables;
}

// The English (US) Windows names of a font: its family (name ID 1), style
// (name ID 2), and version (name ID 5). libass matches a font by these
// family names and by the full names; a font that has a typographic family
// (name ID 16, "Noto Serif CJK JP" of NotoSerifCJKjp-Black) still has its
// own family in ID 1 ("Noto Serif CJK JP Black"). Throws when one is missing.
export function fontNames(bytes) {
  const table = fontTables(bytes).get('name');
  if (!table) throw new Error('has no name table');
  const count = bytes.readUInt16BE(table.offset + 2);
  const strings = table.offset + bytes.readUInt16BE(table.offset + 4);
  const names = new Map();
  for (let index = 0; index < count; index++) {
    const record = table.offset + 6 + index * 12;
    const [platform, encoding, language, id, length, offset] = [0, 2, 4, 6, 8, 10].map(at =>
      bytes.readUInt16BE(record + at)
    );
    // Windows, Unicode BMP, English (US): UTF-16BE text.
    if (platform === 3 && encoding === 1 && language === 0x409) {
      const text = Buffer.from(bytes.subarray(strings + offset, strings + offset + length));
      names.set(id, text.swap16().toString('utf16le'));
    }
  }
  const [family, style, version] = [1, 2, 5].map(id => names.get(id));
  if (!family || !style || !version) throw new Error('has no English Windows family, style, or version name');
  return { family, style, version };
}

// Why a downloaded file is not a font that Dez may ship as a font of
// `release`, or undefined when it is one.
export function fontProblem(bytes, release) {
  if (bytes.length < 12) return 'is not a font';
  const signature = bytes.toString('hex', 0, 4);
  if (signature === '74746366') return 'is a font collection (ttcf); Dez ships one font per file';
  if (!FONT_SIGNATURES.includes(signature)) return 'is not a TrueType or OpenType font';
  if (fontTables(bytes).has('fvar')) return 'is a variable font (fvar); Dez ships static fonts';
  let version;
  try {
    ({ version } = fontNames(bytes));
  } catch (error) {
    return error.message;
  }
  // The release tags end with the version (NotoSans-v2.015, Sans2.004,
  // v2.304), and the fonts name it as "Version 2.015" (with more text after
  // a `;` in some).
  const releaseVersion = /(\d+\.\d+)$/.exec(release)?.[1];
  const fontVersion = /^Version (\d+\.\d+)\b/.exec(version)?.[1];
  if (!releaseVersion || fontVersion !== releaseVersion) {
    return `has the version "${version}", not the version of the release ${release}`;
  }
  return undefined;
}

// Why a license text is not the SIL Open Font License 1.1 (LICENSE), or
// undefined when it is. The texts break their lines in different places.
export function licenseProblem(text) {
  const words = text.replace(/\s+/g, ' ');
  return words.includes('SIL Open Font License, Version 1.1')
    ? undefined
    : 'is not the SIL Open Font License, Version 1.1';
}

// The text of src-tauri/fonts/manifest.json: what build.rs checks the fonts
// against, what the frontend tells of each font (its names and scripts), and
// where each font and its license come from. `fonts` are the facts of the
// downloaded files: for each font of FONT_SOURCES its source, file, names,
// size, and SHA-256.
export function manifestText(fonts) {
  const manifest = {
    fonts: Object.fromEntries(
      fonts.map(({ source, file, url, family, style, size, sha256 }) => [
        file,
        {
          family,
          style,
          scripts: source.scripts,
          repository: `https://github.com/${source.repository}`,
          release: source.release,
          url,
          license: LICENSE,
          licenseFile: source.licenseFile,
          licenseUrl: githubFile(source.repository, source.release, source.licensePath),
          size,
          sha256
        }
      ])
    )
  };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

// The bytes of a URL.
async function download(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`The server answered ${response.status} for ${url}.`);
  }
  return Buffer.from(await response.arrayBuffer());
}

// The file names that a manifest text names: the fonts and their licenses.
function manifestFiles(text) {
  const fonts = Object.entries(JSON.parse(text).fonts ?? {});
  return new Set(fonts.flatMap(([file, font]) => [file, font.licenseFile]));
}

async function main(args) {
  if (args.length > 0) {
    console.log(USAGE);
    process.exitCode = ['-h', '--help'].includes(args[0]) ? 0 : 1;
    return;
  }

  const fontsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src-tauri', 'fonts');
  const manifestPath = join(fontsDir, 'manifest.json');
  mkdirSync(fontsDir, { recursive: true });
  // The downloads go into a folder next to the final files (the same file
  // system, so a rename moves them), and the final files change only after
  // every check passed: a failed run leaves the vendored fonts whole.
  const downloadDir = mkdtempSync(join(fontsDir, '.update-'));
  try {
    const fonts = [];
    for (const source of FONT_SOURCES) {
      const licenseUrl = githubFile(source.repository, source.release, source.licensePath);
      const license = await download(licenseUrl);
      const problem = licenseProblem(license.toString('utf8'));
      if (problem) throw new Error(`${licenseUrl} ${problem}.`);
      writeFileSync(join(downloadDir, source.licenseFile), license);

      for (const { file, url } of source.fonts) {
        console.log(`Downloading ${file}`);
        const bytes = await download(url);
        const fontProblemText = fontProblem(bytes, source.release);
        if (fontProblemText) throw new Error(`${url} ${fontProblemText}.`);
        const { family, style } = fontNames(bytes);
        writeFileSync(join(downloadDir, file), bytes);
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        fonts.push({ source, file, url, family, style, size: bytes.length, sha256 });
      }
    }

    const manifest = manifestText(fonts);
    const kept = manifestFiles(manifest);
    // The files of the old list that the new one drops: the folder is
    // shipped as a whole (`bundle.resources`).
    const dropped = existsSync(manifestPath)
      ? [...manifestFiles(readFileSync(manifestPath, 'utf8'))].filter(file => !kept.has(file))
      : [];
    for (const file of kept) {
      renameSync(join(downloadDir, file), join(fontsDir, file));
    }
    for (const file of dropped) {
      rmSync(join(fontsDir, file), { force: true });
    }
    writeFileSync(manifestPath, manifest);

    console.log(`Vendored ${fonts.length} fonts in src-tauri/fonts/.
Next: build and test Dez, then commit the folder. "git lfs ls-files" must list the fonts.`);
  } catch (error) {
    console.error(`update-fonts: ${error.message}`);
    process.exitCode = 1;
  } finally {
    rmSync(downloadDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  await main(process.argv.slice(2));
}
