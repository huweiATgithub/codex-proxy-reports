import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { checkHostContract, parseCompatibility, releaseMetadata } from '../scripts/host-compatibility.js';

const manifest = JSON.parse(readFileSync('plugin.json', 'utf8'));
const policy = JSON.parse(readFileSync('host-compatibility.json', 'utf8'));
const contract = {
  manifest_schema_versions: [2], protocol_versions: [7],
  capabilities: [{ capability: 'management', versions: [2] }, { capability: 'maintenance', versions: [1] }],
};

test('Host range, SDK pin and verification matrix have independent owners', () => {
  const metadata = releaseMetadata();
  assert.equal(metadata['host-range'], '>=3.41.2, <4.0.0');
  assert.equal(metadata['sdk-revision'], 'e0a3dc20dd907071fc78f81cfba9a58f00a27521');
  assert.equal(metadata['primary-host'], '3.44.0');
  assert.deepEqual(JSON.parse(metadata['host-matrix']).include.map(host => host.version), ['3.41.2', '3.42.1', '3.44.0']);
  const extended = structuredClone(policy);
  extended.hosts.push({ ...extended.hosts.at(-1), version: '3.45.0' });
  assert.doesNotThrow(() => parseCompatibility(manifest, extended));
});

test('rejects untested minimums, out-of-range Hosts and invalid matrix identities', () => {
  for (const mutate of [
    value => value.hosts.shift(),
    value => value.hosts.push({ ...value.hosts[0] }),
    value => { value.hosts[0].revision = 'main'; },
    value => { value.hosts[0].binarySha256 = ''; },
    value => { value.primaryHost = '3.43.0'; },
    value => { value.hosts.at(-1).version = '4.0.0'; },
  ]) {
    const changed = structuredClone(policy);
    mutate(changed);
    assert.throws(() => parseCompatibility(manifest, changed));
  }
});

test('Rust semver syntax is enforced before npm range evaluation', () => {
  for (const range of ['>=3.41.2 <4.0.0', '3.41.2 || 3.44.0', '3.41.2 - 3.44.0', 'v3.41.2', '>=3.41.2\n,<4.0.0']) {
    assert.throws(() => parseCompatibility({ ...manifest, engines: { 'codex-proxy-rs': range } }, policy));
  }
  assert.doesNotThrow(() => parseCompatibility({ ...manifest, engines: { 'codex-proxy-rs': '3.41.2' } }, policy));
});

test('compatible Host numbers still require the SDK protocol and each consumed capability', () => {
  assert.doesNotThrow(() => checkHostContract(policy, contract));
  for (const changed of [
    { ...contract, protocol_versions: [8] },
    { ...contract, manifest_schema_versions: [1] },
    { ...contract, capabilities: contract.capabilities.slice(0, 1) },
    { ...contract, capabilities: [{ capability: 'management', versions: [1] }, contract.capabilities[1]] },
  ]) assert.throws(() => checkHostContract(policy, changed));
  const wrong = structuredClone(manifest);
  wrong.contributes.maintenance.version = 2;
  assert.throws(() => parseCompatibility(wrong, policy));
});
