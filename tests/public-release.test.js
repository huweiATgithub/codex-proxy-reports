import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { verifyRelease } from '../scripts/verify-release.js';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'reports-public-release-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const tag = 'v0.1.2', commit = 'a'.repeat(40), repository = 'owner/reports';
  const archive = 'huwei.usage-reports-0.1.2-x86_64-unknown-linux-gnu.tar.gz';
  const names = [archive, `${archive}.sha256`, 'SHA256SUMS', 'provenance.jsonl'];
  const bodies = new Map(names.map(name => [name, Buffer.from(`verified candidate: ${name}`)]));
  for (const [name, bytes] of bodies) writeFileSync(join(directory, name), bytes);
  const release = { id: 42, tag_name: tag, draft: false, prerelease: false, html_url: `https://github.com/${repository}/releases/tag/${tag}`, assets: names.map(name => ({ name, browser_download_url: `https://github.com/${repository}/releases/download/${tag}/${name}`, digest: `sha256:${createHash('sha256').update(bodies.get(name)).digest('hex')}` })) };
  const responses = new Map([
    [`releases/tags/${tag}`, release], ['releases/latest', release],
    [`git/ref/tags/${tag}`, { object: { type: 'tag', sha: 'b'.repeat(40) } }],
    [`git/tags/${'b'.repeat(40)}`, { object: { type: 'commit', sha: commit } }],
  ]);
  const options = { directory, repository, tag, commit, archive, token: 'metadata-only-token', fetchImpl: async (url, init) => {
    if (url.startsWith('https://api.github.com/')) {
      assert.equal(init.headers.authorization, 'Bearer metadata-only-token');
      const value = responses.get(url.split(`/repos/${repository}/`)[1]);
      return new Response(JSON.stringify(value), { status: value ? 200 : 404 });
    }
    assert.equal(init.headers.authorization, undefined, 'Downloads must prove unauthenticated access');
    const bytes = bodies.get(url.split('/').at(-1));
    return new Response(bytes, { status: bytes ? 200 : 404 });
  } };
  return { options, release, responses, bodies };
}

test('public release verifies stable metadata, annotated tag, every asset and public access', async t => {
  const { options } = fixture(t);
  const result = await verifyRelease(options);
  assert.equal(result.commit, options.commit);
  assert.equal(Object.keys(result.assets).length, 4);
});

test('public release rejects changed download bytes even when metadata names match', async t => {
  const { options, bodies } = fixture(t);
  bodies.set(options.archive, Buffer.from('different package'));
  await assert.rejects(verifyRelease(options), /differs from the tested artifact/);
});

test('public release rejects draft, prerelease and non-latest publication', async t => {
  for (const state of ['draft', 'prerelease', 'not-latest']) {
    const { options, release, responses } = fixture(t);
    if (state === 'not-latest') responses.set('releases/latest', { id: 43 });
    else release[state] = true;
    await assert.rejects(verifyRelease(options), /stable release/);
  }
});

test('public release rejects a tag that points at an untested commit', async t => {
  const { options, responses } = fixture(t);
  responses.set(`git/tags/${'b'.repeat(40)}`, { object: { type: 'commit', sha: 'c'.repeat(40) } });
  await assert.rejects(verifyRelease(options), /tested source commit/);
});

test('public release rejects missing assets and conflicting GitHub digests', async t => {
  for (const mode of ['missing', 'digest']) {
    const { options, release } = fixture(t);
    if (mode === 'missing') release.assets.pop();
    else release.assets[0].digest = `sha256:${'f'.repeat(64)}`;
    await assert.rejects(verifyRelease(options), mode === 'missing' ? /Unexpected release assets/ : /GitHub digest mismatch/);
  }
});

test('public release fails when assets are not publicly downloadable', async t => {
  const { options, bodies } = fixture(t);
  bodies.delete('provenance.jsonl');
  await assert.rejects(verifyRelease(options), /HTTP 404/);
});
