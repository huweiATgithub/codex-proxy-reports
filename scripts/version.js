import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootVersion = /^( {2}"version"\s*:\s*")([^"\r\n]*)(")/m;
const lockPackageVersion = /(^ {4}""\s*:\s*\{[\s\S]*?^ {6}"version"\s*:\s*")([^"\r\n]*)(")/m;
const cargoVersion = /^(version\s*=\s*")([^"\r\n]*)(")/m;

function stableVersion(value, label) {
  if (typeof value !== 'string' || value.match(/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/)?.[0] !== value) {
    throw new Error(`${label} must be a stable version in X.Y.Z format.`);
  }
  return value;
}

function field(text, pattern, label) {
  const matches = [...text.matchAll(new RegExp(pattern.source, `${pattern.flags}g`))];
  if (matches.length !== 1) throw new Error(`Expected exactly one ${label} version field.`);
  return matches[0];
}

function replaceVersion(text, pattern, version, label) {
  const match = field(text, pattern, label);
  return text.slice(0, match.index) + match[1] + version + match[3] + text.slice(match.index + match[0].length);
}

function cargoPackage(text, lockfile) {
  const headers = [...text.matchAll(lockfile ? /^\[\[package\]\][ \t]*\r?$/gm : /^\[[^\r\n]+\][ \t]*\r?$/gm)];
  const blocks = headers.map((header, index) => ({
    start: header.index,
    end: headers[index + 1]?.index ?? text.length,
    text: text.slice(header.index, headers[index + 1]?.index ?? text.length),
  }));
  const matches = blocks.filter(block => lockfile
    ? /^name\s*=\s*"codex-proxy-reports"[ \t]*\r?$/m.test(block.text)
    : /^\[package\][ \t]*\r?$/m.test(block.text));
  if (matches.length !== 1) throw new Error('Expected exactly one codex-proxy-reports Cargo package.');
  return matches[0];
}

export function releaseVersion(directory, requested) {
  if (requested !== undefined) stableVersion(requested, 'Requested version');
  const paths = ['plugin.json', 'package.json', 'package-lock.json', 'backend/Cargo.toml', 'backend/Cargo.lock', 'README.md'];
  const files = new Map(paths.map(path => [path, readFileSync(resolve(directory, path), 'utf8')]));
  const plugin = JSON.parse(files.get('plugin.json'));
  const npm = JSON.parse(files.get('package.json'));
  const lock = JSON.parse(files.get('package-lock.json'));
  const manifestPackage = cargoPackage(files.get('backend/Cargo.toml'), false);
  const lockedPackage = cargoPackage(files.get('backend/Cargo.lock'), true);
  const versions = {
    'plugin.json': plugin.version,
    'package.json': npm.version,
    'package-lock.json': lock.version,
    'package-lock.json packages[""]': lock.packages?.['']?.version,
    'backend/Cargo.toml': field(manifestPackage.text, cargoVersion, 'Cargo manifest')[2],
    'backend/Cargo.lock': field(lockedPackage.text, cargoVersion, 'Cargo lock package')[2],
  };
  const version = stableVersion(plugin.version, 'plugin.json');
  for (const [label, value] of Object.entries(versions)) {
    stableVersion(value, label);
    if (value !== version) throw new Error(`Version mismatch: ${label} is ${value}; plugin.json is ${version}.`);
  }

  if (requested !== undefined) {
    const updates = new Map(files);
    for (const path of ['plugin.json', 'package.json', 'package-lock.json']) {
      updates.set(path, replaceVersion(files.get(path), rootVersion, requested, path));
    }
    updates.set('package-lock.json', replaceVersion(updates.get('package-lock.json'), lockPackageVersion, requested, 'npm root package'));
    for (const [path, block] of [['backend/Cargo.toml', manifestPackage], ['backend/Cargo.lock', lockedPackage]]) {
      updates.set(path, files.get(path).slice(0, block.start) + replaceVersion(block.text, cargoVersion, requested, path) + files.get(path).slice(block.end));
    }
    updates.set('README.md', files.get('README.md').replaceAll(`huwei.usage-reports-${version}-`, `huwei.usage-reports-${requested}-`));
    for (const [path, text] of updates) {
      if (text !== files.get(path)) writeFileSync(resolve(directory, path), text);
    }
  }

  const outputVersion = requested ?? version;
  return {
    version: outputVersion,
    tag: `v${outputVersion}`,
    archive: `huwei.usage-reports-${outputVersion}-x86_64-unknown-linux-gnu.tar.gz`,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length > 3) throw new Error('Usage: node scripts/version.js [X.Y.Z]');
    const metadata = releaseVersion(process.cwd(), process.argv[2]);
    console.log(Object.entries(metadata).map(([key, value]) => `${key}=${value}`).join('\n'));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
