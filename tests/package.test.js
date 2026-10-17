import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';
import { verifyPackage } from '../scripts/verify-package.js';

function fixture(t, mutate = () => {}) {
  const root = mkdtempSync(join(tmpdir(), 'reports-package-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const directory of ['dist/plugin', 'backend/target/release', 'archive']) mkdirSync(join(root, directory), { recursive: true });
  const source = { manifestVersion: 2, publisher: 'huwei', name: 'usage-reports', version: '0.1.1', main: 'codex-proxy-reports', runtime: 'trustedProcess', engines: { 'codex-proxy-rs': '~3.29.0' }, resources: {} };
  const contents = { 'codex-proxy-reports': Buffer.from('fixture executable'), 'app.js': Buffer.from('console.log("fixture");'), 'index.html': Buffer.from('<!doctype html>') };
  writeFileSync(join(root, 'plugin.json'), JSON.stringify(source));
  writeFileSync(join(root, 'dist/plugin/management.json'), JSON.stringify({ resources: [{ path: 'app.js' }, { path: 'index.html' }] }));
  for (const [name, bytes] of Object.entries(contents)) writeFileSync(join(root, name === source.main ? 'backend/target/release' : 'dist/plugin', name), bytes);
  const manifest = { ...source, resources: { 'app.js': 'application/javascript', 'index.html': 'text/html' }, package: { protocolVersion: 4, target: { os: 'linux', architecture: 'x86_64' }, files: Object.fromEntries(Object.entries(contents).map(([name, bytes]) => [name, createHash('sha256').update(bytes).digest('hex')])) } };
  mutate({ root, manifest, contents });
  for (const [name, bytes] of Object.entries(contents)) writeFileSync(join(root, 'archive', name), bytes);
  chmodSync(join(root, 'archive', source.main), 0o755);
  writeFileSync(join(root, 'archive/plugin.json'), JSON.stringify(manifest));
  const archive = join(root, 'fixture.tar.gz');
  const result = spawnSync('tar', ['--create', '--gzip', '--file', archive, '--directory', join(root, 'archive'), 'plugin.json', ...Object.keys(contents)], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  writeFileSync(`${archive}.sha256`, `${createHash('sha256').update(readFileSync(archive)).digest('hex')}  ${basename(archive)}\n`);
  return { root, archive };
}

test('verifies an executable package against its registration, local build and checksums', (t) => {
  const { archive, root } = fixture(t);
  assert.equal(verifyPackage(archive, root).version, '0.1.1');
});

test('rejects corrupted member bytes even when the outer archive checksum is valid', (t) => {
  const { archive, root } = fixture(t, ({ contents }) => { contents['app.js'] = Buffer.from('changed after embedded digests were calculated'); });
  assert.throws(() => verifyPackage(archive, root), /app\.js SHA256/);
});

test('rejects a package for a different source version', (t) => {
  const { archive, root } = fixture(t, ({ manifest }) => { manifest.version = '0.1.0'; });
  assert.throws(() => verifyPackage(archive, root), /Packaged version/);
});

test('rejects unexpected files outside the registered payload', (t) => {
  const { archive, root } = fixture(t, ({ contents }) => { contents['unregistered.txt'] = Buffer.from('unexpected payload'); });
  assert.throws(() => verifyPackage(archive, root), /exactly its manifest, binary and registered resources/);
});

test('rejects a valid embedded digest when the packaged resource is from another local build', (t) => {
  const { archive, root } = fixture(t, ({ contents, manifest }) => {
    contents['app.js'] = Buffer.from('another build');
    manifest.package.files['app.js'] = createHash('sha256').update(contents['app.js']).digest('hex');
  });
  assert.throws(() => verifyPackage(archive, root), /app\.js does not match the local build/);
});

test('rejects an incorrect archive checksum sidecar', (t) => {
  const { archive, root } = fixture(t);
  writeFileSync(`${archive}.sha256`, `${'0'.repeat(64)}  ${basename(archive)}\n`);
  assert.throws(() => verifyPackage(archive, root), /Archive SHA256 sidecar/);
});
