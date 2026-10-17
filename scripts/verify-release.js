import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Authenticate API metadata to avoid shared-runner rate limits; download assets anonymously.
export async function verifyRelease({ directory, repository, tag, commit, archive, token, fetchImpl = fetch }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? '') || !/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(tag ?? '') || !/^[a-f0-9]{40}$/.test(commit ?? '')) {
    throw new Error('Expected a repository, stable version tag and source commit.');
  }
  const expectedArchive = `huwei.usage-reports-${tag.slice(1)}-x86_64-unknown-linux-gnu.tar.gz`;
  if (archive !== expectedArchive) throw new Error('Archive name does not match the release tag.');
  const get = async (url, json = false) => {
    const headers = { 'user-agent': 'codex-proxy-reports-release-verification' };
    if (json && token) headers.authorization = `Bearer ${token}`;
    const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw new Error(`Public verification failed: HTTP ${response.status} for ${url}`);
    return json ? response.json() : Buffer.from(await response.arrayBuffer());
  };
  const api = (path) => get(`https://api.github.com/repos/${repository}/${path}`, true);
  const release = await api(`releases/tags/${tag}`);
  if (release.tag_name !== tag || release.draft || release.prerelease) throw new Error('Expected a published stable release.');
  const latest = await api('releases/latest');
  if (latest.id !== release.id) throw new Error('The published release is not the latest stable release.');
  let target = (await api(`git/ref/tags/${tag}`)).object;
  for (let depth = 0; target.type === 'tag' && depth < 10; depth++) target = (await api(`git/tags/${target.sha}`)).object;
  if (target.type !== 'commit' || target.sha !== commit) throw new Error('Published tag does not match the tested source commit.');
  const names = [archive, `${archive}.sha256`, 'SHA256SUMS', 'provenance.jsonl'];
  if (release.assets.length !== names.length || names.some(name => !release.assets.some(asset => asset.name === name))) throw new Error('Unexpected release assets.');
  const hashes = {};
  for (const name of names) {
    const asset = release.assets.find(item => item.name === name);
    const downloaded = await get(asset.browser_download_url);
    if (!downloaded.equals(readFileSync(resolve(directory, name)))) throw new Error(`Public asset differs from the tested artifact: ${name}`);
    const digest = createHash('sha256').update(downloaded).digest('hex');
    if (asset.digest && asset.digest !== `sha256:${digest}`) throw new Error(`GitHub digest mismatch: ${name}`);
    hashes[name] = digest;
  }
  return { repository, tag, commit, release: release.html_url, assets: hashes };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw new Error('Usage: node scripts/verify-release.js ASSET_DIRECTORY');
    // Release metadata can take a few seconds to propagate to public endpoints.
    let result;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        result = await verifyRelease({ directory: process.argv[2], repository: process.env.GH_REPO, tag: process.env.RELEASE_TAG, commit: process.env.RELEASE_COMMIT, archive: process.env.ARCHIVE, token: process.env.GH_TOKEN });
        break;
      } catch (error) {
        if (attempt === 4) throw error;
        await new Promise(done => setTimeout(done, 3000));
      }
    }
    writeFileSync(resolve(process.argv[2], 'public-verification.json'), JSON.stringify(result, null, 2) + '\n');
    console.log(`Verified public release ${result.tag}, source commit and all ${Object.keys(result.assets).length} assets.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
