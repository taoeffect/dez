import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const version = process.argv[2];

if (!version) {
  console.error('Usage: node scripts/bump-version.js <version>');
  process.exit(1);
}

if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`Invalid version: ${version}`);
  process.exit(1);
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const changedFiles = [];

function writeIfChanged(filePath, content) {
  const current = readFileSync(filePath, 'utf8');

  if (current === content) {
    return;
  }

  writeFileSync(filePath, content);
  changedFiles.push(filePath);
}

function updateJson(relativePath, updater) {
  const filePath = join(repoRoot, relativePath);
  const data = JSON.parse(readFileSync(filePath, 'utf8'));
  updater(data);
  writeIfChanged(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

function updateText(relativePath, updater) {
  const filePath = join(repoRoot, relativePath);
  writeIfChanged(filePath, updater(readFileSync(filePath, 'utf8')));
}

function replaceRequired(content, pattern, replacement, relativePath) {
  if (!pattern.test(content)) {
    throw new Error(`Could not update ${relativePath}`);
  }

  return content.replace(pattern, replacement);
}

updateJson('package.json', data => {
  data.version = version;
});

updateJson('package-lock.json', data => {
  data.version = version;

  if (data.packages?.['']) {
    data.packages[''].version = version;
  }
});

updateJson('src-tauri/tauri.conf.json', data => {
  data.version = version;
});

updateText('src-tauri/Cargo.toml', content =>
  replaceRequired(content, /(^\[package\][\s\S]*?^version = ")([^"]+)(")/m, `$1${version}$3`, 'src-tauri/Cargo.toml')
);

updateText('src-tauri/Cargo.lock', content =>
  replaceRequired(content, /(^\[\[package\]\]\nname = "dez"\nversion = ")([^"]+)(")/m, `$1${version}$3`, 'src-tauri/Cargo.lock')
);

if (changedFiles.length === 0) {
  console.log(`Version already ${version}.`);
} else {
  console.log(`Bumped version to ${version}:`);
  for (const filePath of changedFiles) {
    console.log(`- ${filePath.slice(repoRoot.length + 1)}`);
  }
}
