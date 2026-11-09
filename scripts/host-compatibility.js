import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import semver from 'semver';
import { releaseVersion } from './version.js';

function parseHostRange(value) {
  if (typeof value !== 'string' || /[\r\n]/.test(value)) return null;
  const comparators = value.split(',').map(part => {
    // Rust VersionReq uses comma-separated AND, and bare versions mean caret.
    const match = /^(>=|<=|>|<|=|\^|~)? *([^\s|<>=~^]+)$/.exec(part.trim());
    if (!match || match[2].startsWith('v')) return null;
    const wildcard = match[2].split('.').some(part => ['*', 'x', 'X'].includes(part));
    return `${match[1] ?? (wildcard ? '' : '^')}${match[2]}`;
  });
  return comparators.includes(null) ? null : semver.validRange(comparators.join(' '));
}

export function parseCompatibility(manifest, policy) {
  const range = parseHostRange(manifest.engines?.['codex-proxy-rs']);
  assert.ok(range, 'Expected a valid Rust semver Host range');
  const minimum = semver.minVersion(range)?.version;
  const required = policy?.requirements;
  assert.equal(manifest.manifestVersion, required?.manifestVersion, 'Manifest schema requirement mismatch');
  assert.ok(Number.isSafeInteger(required?.protocolVersion) && required.protocolVersion > 0, 'Expected an SDK protocol requirement');
  assert.ok(required.capabilities && Object.keys(required.capabilities).length > 0, 'Expected capability requirements');
  for (const [name, version] of Object.entries(required.capabilities)) {
    assert.ok(Number.isSafeInteger(version) && version > 0, 'Expected a capability version');
    assert.equal(manifest.contributes?.[name]?.version, version, `${name} capability requirement mismatch`);
  }
  assert.ok(Array.isArray(policy.hosts) && policy.hosts.length, 'Expected verification Hosts');
  const seen = new Set();
  for (const host of policy.hosts) {
    assert.ok(semver.valid(host.version) === host.version && semver.prerelease(host.version) === null && !host.version.includes('+'), 'Expected stable Host versions');
    assert.ok(!seen.has(host.version), 'Duplicate verification Host');
    seen.add(host.version);
    assert.ok(semver.satisfies(host.version, range), `Host ${host.version} is outside the declared range`);
    assert.match(host.revision, /^[a-f0-9]{40}$/, 'Expected a pinned Host revision');
    for (const field of ['binarySha256', 'sourceSha256']) assert.match(host[field], /^[a-f0-9]{64}$/, 'Expected pinned Host archive checksums');
  }
  assert.ok(minimum !== '0.0.0' && seen.has(minimum), 'Verification must include the minimum supported Host');
  assert.ok(seen.has(policy.primaryHost), 'Primary Host must be in the verification matrix');
  return policy;
}

export function loadCompatibility(directory = process.cwd()) {
  const read = path => JSON.parse(readFileSync(resolve(directory, path), 'utf8'));
  return parseCompatibility(read('plugin.json'), read('host-compatibility.json'));
}

export function checkHostContract(policy, contract) {
  const required = policy.requirements;
  assert.ok(contract.manifest_schema_versions?.includes(required.manifestVersion), 'Host does not support the manifest schema');
  assert.ok(contract.protocol_versions?.includes(required.protocolVersion), 'Host does not support the SDK protocol');
  for (const [name, version] of Object.entries(required.capabilities)) {
    assert.ok(contract.capabilities?.some(capability => capability.capability === name && capability.versions.includes(version)), `Host does not support ${name} v${version}`);
  }
}

export function releaseMetadata(directory = process.cwd()) {
  const version = releaseVersion(directory);
  const policy = loadCompatibility(directory);
  const cargo = readFileSync(resolve(directory, 'backend/Cargo.toml'), 'utf8');
  const sdk = cargo.match(/^gateway-plugin-sdk = \{ git = "https:\/\/github.com\/zyycn\/codex-proxy-rs", rev = "([a-f0-9]{40})",/m)?.[1];
  assert.ok(sdk, 'SDK dependency must pin a full upstream revision');
  const lock = readFileSync(resolve(directory, 'backend/Cargo.lock'), 'utf8');
  assert.ok(lock.includes(`source = "git+https://github.com/zyycn/codex-proxy-rs?rev=${sdk}#${sdk}"`), 'SDK lock revision mismatch');
  return { ...version, 'host-range': JSON.parse(readFileSync(resolve(directory, 'plugin.json'), 'utf8')).engines['codex-proxy-rs'], 'sdk-revision': sdk, 'primary-host': policy.primaryHost, 'host-matrix': JSON.stringify({ include: policy.hosts }) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length === 3 && args[0] === '--check-host') {
      const policy = loadCompatibility();
      assert.ok(policy.hosts.some(host => host.version === args[2]), 'Unknown verification Host');
      checkHostContract(policy, JSON.parse(readFileSync(resolve(args[1], 'backend/crates/gateway-plugin/runtime/plugin-host-compatibility.json'), 'utf8')));
      console.log(`Host ${args[2]} supports the required SDK protocol and capabilities.`);
    } else if (args.length === 2 && args[0] === '--host') {
      const host = loadCompatibility().hosts.find(host => host.version === args[1]);
      assert.ok(host, 'Unknown verification Host');
      console.log([host.version, host.revision, host.binarySha256, host.sourceSha256].join(' '));
    } else {
      assert.equal(args.length, 0, 'Usage: host-compatibility.js [--host VERSION | --check-host SOURCE_DIRECTORY VERSION]');
      console.log(Object.entries(releaseMetadata()).map(([name, value]) => `${name}=${value}`).join('\n'));
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
