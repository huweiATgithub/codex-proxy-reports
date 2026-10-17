import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const json = (path) => JSON.parse(readFileSync(path, 'utf8'));

export function verifyPackage(archivePath, root = process.cwd()) {
  const archive = resolve(archivePath);
  const source = json(join(root, 'plugin.json'));
  const registration = json(join(root, 'dist/plugin/management.json'));
  const resources = registration.resources.map(({ path }) => path);
  const files = [source.main, ...resources].sort();
  const expected = ['plugin.json', ...files].sort();
  const tar = (args, encoding = 'utf8') => {
    const result = spawnSync('tar', ['--file', archive, ...args], { encoding, maxBuffer: 128 * 1024 * 1024 });
    if (result.error) throw result.error;
    assert.equal(result.status, 0, `Cannot read package: ${result.stderr}`);
    return result.stdout;
  };
  const members = tar(['--list', '--gzip']).trimEnd().split('\n');
  for (const member of members) assert.match(member, /^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'Package members must be flat filenames');
  assert.deepEqual([...members].sort(), expected, 'Package must contain exactly its manifest, binary and registered resources');
  const listing = tar(['--list', '--verbose', '--gzip']).trimEnd().split('\n');
  assert.equal(listing.length, members.length);
  for (const entry of listing) assert.equal(entry[0], '-', 'All package members must be regular files');
  assert.equal(listing[members.indexOf(source.main)][3], 'x', 'Packaged binary must be executable');

  const read = (member) => tar(['--extract', '--to-stdout', '--gzip', '--', member], null);
  const manifest = JSON.parse(read('plugin.json').toString('utf8'));
  for (const field of ['manifestVersion', 'publisher', 'name', 'version', 'main', 'runtime', 'engines']) {
    assert.deepEqual(manifest[field], source[field], `Packaged ${field} must match plugin.json`);
  }
  assert.equal(manifest.package.protocolVersion, 4, 'Package protocol must match the v3.29 host');
  assert.deepEqual(manifest.package.target, { os: 'linux', architecture: 'x86_64' }, 'Package must target Linux x86_64');
  assert.deepEqual(Object.keys(manifest.resources).sort(), [...resources].sort(), 'Packaged resources must match management registration');
  assert.deepEqual(Object.keys(manifest.package.files).sort(), files, 'Package digests must cover exactly the binary and resources');
  for (const file of files) {
    const bytes = read(file);
    assert.equal(digest(bytes), manifest.package.files[file], `Packaged ${file} SHA256 does not match its embedded digest`);
    const local = file === source.main ? join(root, 'backend/target/release', file) : join(root, 'dist/plugin', file);
    assert.ok(bytes.equals(readFileSync(local)), `Packaged ${file} does not match the local build`);
  }
  assert.equal(readFileSync(`${archive}.sha256`, 'utf8').trim(), `${digest(readFileSync(archive))}  ${basename(archive)}`, 'Archive SHA256 sidecar does not match the package');
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    assert.equal(process.argv.length, 3, 'Usage: node scripts/verify-package.js PATH');
    verifyPackage(process.argv[2]);
    console.log(`PASS verified package ${basename(process.argv[2])}`);
  } catch (error) {
    console.error(`Package verification failed: ${error.message}`);
    process.exitCode = 1;
  }
}
