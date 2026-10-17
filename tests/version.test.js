import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { releaseVersion } from '../scripts/version.js';

const fileNames = ['plugin.json', 'package.json', 'package-lock.json', 'backend/Cargo.toml', 'backend/Cargo.lock', 'README.md'];

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'cpr-version-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'backend'));
  const files = {
    'plugin.json': JSON.stringify({ publisher: 'huwei', name: 'usage-reports', version: '0.1.1' }, null, 2) + '\n',
    'package.json': JSON.stringify({ name: 'codex-proxy-usage-reports', version: '0.1.1' }, null, 2) + '\n',
    'package-lock.json': JSON.stringify({
      name: 'codex-proxy-usage-reports', version: '0.1.1', lockfileVersion: 3,
      packages: { '': { version: '0.1.1' }, 'node_modules/example': { version: '0.1.1' } },
    }, null, 2) + '\n',
    'backend/Cargo.toml': '[package]\nname = "codex-proxy-reports"\nversion = "0.1.1"\nedition = "2024"\n\n[dependencies]\nexample = { version = "0.1.1" }\n',
    'backend/Cargo.lock': '# generated\nversion = 4\n\n[[package]]\nname = "gateway-plugin-sdk"\nversion = "0.1.0"\nsource = "git+https://example.invalid/sdk#pinned"\n\n[[package]]\nname = "codex-proxy-reports"\nversion = "0.1.1"\ndependencies = ["gateway-plugin-sdk"]\n\n[[package]]\nname = "example"\nversion = "0.1.1"\n',
    'README.md': '# Reports\n\nInstall huwei.usage-reports-0.1.1-x86_64-unknown-linux-gnu.tar.gz.\nVerify huwei.usage-reports-0.1.1-x86_64-unknown-linux-gnu.tar.gz.sha256.\n',
  };
  for (const [path, text] of Object.entries(files)) writeFileSync(join(root, path), text);
  return {
    root,
    read: path => readFileSync(join(root, path), 'utf8'),
    write: (path, text) => writeFileSync(join(root, path), text),
    snapshot: () => Object.fromEntries(fileNames.map(path => [path, readFileSync(join(root, path), 'utf8')])),
  };
}

test('consistent versions produce workflow metadata without changing files', t => {
  const project = fixture(t);
  const before = project.snapshot();
  assert.deepEqual(releaseVersion(project.root), {
    version: '0.1.1', tag: 'v0.1.1', archive: 'huwei.usage-reports-0.1.1-x86_64-unknown-linux-gnu.tar.gz',
  });
  assert.deepEqual(project.snapshot(), before);
});

test('bumping changes all release versions and artifact references without touching dependencies', t => {
  const project = fixture(t);
  const before = project.snapshot();
  const result = releaseVersion(project.root, '0.2.0');
  assert.equal(JSON.parse(project.read('plugin.json')).version, '0.2.0');
  assert.equal(JSON.parse(project.read('package.json')).version, '0.2.0');
  const lock = JSON.parse(project.read('package-lock.json'));
  assert.equal(lock.version, '0.2.0');
  assert.equal(lock.packages[''].version, '0.2.0');
  assert.equal(lock.packages['node_modules/example'].version, '0.1.1');
  assert.equal(project.read('backend/Cargo.toml'), before['backend/Cargo.toml'].replace('version = "0.1.1"', 'version = "0.2.0"'));
  assert.equal(project.read('backend/Cargo.lock'), before['backend/Cargo.lock'].replace('name = "codex-proxy-reports"\nversion = "0.1.1"', 'name = "codex-proxy-reports"\nversion = "0.2.0"'));
  assert.equal(project.read('README.md'), before['README.md'].replaceAll('huwei.usage-reports-0.1.1-', 'huwei.usage-reports-0.2.0-'));
  assert.deepEqual(result, {
    version: '0.2.0', tag: 'v0.2.0', archive: 'huwei.usage-reports-0.2.0-x86_64-unknown-linux-gnu.tar.gz',
  });
  assert.deepEqual(releaseVersion(project.root), result);
});

test('every source and lock version mismatch is rejected before any file is written', t => {
  const changes = [
    ['plugin.json', text => text.replace('0.1.1', '0.1.9')],
    ['package.json', text => text.replace('0.1.1', '0.1.9')],
    ['package-lock.json', text => text.replace('0.1.1', '0.1.9')],
    ['package-lock.json', text => text.replace('"": {\n      "version": "0.1.1"', '"": {\n      "version": "0.1.9"')],
    ['backend/Cargo.toml', text => text.replace('version = "0.1.1"', 'version = "0.1.9"')],
    ['backend/Cargo.lock', text => text.replace('name = "codex-proxy-reports"\nversion = "0.1.1"', 'name = "codex-proxy-reports"\nversion = "0.1.9"')],
  ];
  for (const [path, change] of changes) {
    const project = fixture(t);
    project.write(path, change(project.read(path)));
    const before = project.snapshot();
    assert.throws(() => releaseVersion(project.root, '0.2.0'), /Version mismatch/, path);
    assert.deepEqual(project.snapshot(), before, path);
  }
});

test('invalid release versions and workflow-output injection are rejected without writes', t => {
  const project = fixture(t);
  const before = project.snapshot();
  for (const version of ['v0.2.0', '01.2.0', '0.2', '0.2.0-rc.1', '0.2.0+build', '0.2.0\n', '0.2.0\ntag=injected', '$(touch injected)', '']) {
    assert.throws(() => releaseVersion(project.root, version), /stable version/, JSON.stringify(version));
    assert.deepEqual(project.snapshot(), before, JSON.stringify(version));
  }
});

test('missing root lock metadata and duplicate Cargo package records fail without writes', t => {
  for (const path of ['package-lock.json', 'backend/Cargo.lock']) {
    const project = fixture(t);
    if (path === 'package-lock.json') {
      const lock = JSON.parse(project.read(path));
      delete lock.packages[''];
      project.write(path, JSON.stringify(lock, null, 2) + '\n');
    } else {
      project.write(path, project.read(path) + '\n[[package]]\nname = "codex-proxy-reports"\nversion = "0.1.1"\n');
    }
    const before = project.snapshot();
    assert.throws(() => releaseVersion(project.root, '0.2.0'), undefined, path);
    assert.deepEqual(project.snapshot(), before, path);
  }
});
