function parseVersionTag(value, label) {
  if (typeof value !== 'string' || /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.exec(value)?.[0] !== value) {
    throw new Error(`${label} must be a stable version such as v0.1.2.`);
  }
  return { tag: value, parts: value.slice(1).split('.').map(component => BigInt(component)) };
}

export async function checkReleaseTarget({ tag, commit, repository, token, fetchImpl = fetch }) {
  const targetVersion = parseVersionTag(tag, 'RELEASE_TAG');
  if (typeof repository !== 'string' || /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9._-]{1,100}$/.exec(repository)?.[0] !== repository || ['.', '..'].includes(repository.split('/')[1])) {
    throw new Error('GH_REPO must be a GitHub owner/repository name.');
  }
  if (typeof commit !== 'string' || /^[0-9a-fA-F]{40}$/.exec(commit)?.[0] !== commit) {
    throw new Error('RELEASE_COMMIT must be a full 40-character Git commit SHA.');
  }
  const expectedCommit = commit.toLowerCase();
  if (typeof token !== 'string' || !token.trim()) throw new Error('GH_TOKEN is required to check draft releases.');

  async function request(path) {
    try {
      return await fetchImpl(`https://api.github.com/repos/${repository}/${path}`, {
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28',
        },
        redirect: 'error',
        signal: AbortSignal.timeout(30000),
      });
    } catch {
      throw new Error('Could not check GitHub release target: request failed.');
    }
  }

  async function json(response) {
    try { return await response.json(); } catch { throw new Error('Could not check release target: invalid GitHub response.'); }
  }
  function gitObject(value) {
    if (!value || !['commit', 'tag'].includes(value.type) || typeof value.sha !== 'string' || /^[0-9a-f]{40}$/.exec(value.sha)?.[0] !== value.sha) {
      throw new Error('Could not resolve release tag: invalid GitHub object.');
    }
    return { type: value.type, sha: value.sha };
  }

  const referenceResponse = await request(`git/ref/tags/${tag}`);
  if (referenceResponse.status === 404) throw new Error(`Git tag ${tag} does not exist in ${repository}.`);
  if (referenceResponse.status !== 200) throw new Error(`Could not check Git tag: GitHub returned HTTP ${referenceResponse.status}.`);
  const reference = await json(referenceResponse);
  if (reference?.ref !== `refs/tags/${tag}`) throw new Error('Could not resolve release tag: invalid GitHub reference.');
  let object = gitObject(reference.object);
  for (let depth = 0; object.type === 'tag'; depth++) {
    if (depth >= 16) throw new Error('Could not resolve release tag: annotated tag nesting exceeds 16 levels.');
    const response = await request(`git/tags/${object.sha}`);
    if (response.status !== 200) throw new Error(`Could not resolve annotated tag: GitHub returned HTTP ${response.status}.`);
    const annotated = await json(response);
    if (annotated?.sha !== object.sha) throw new Error('Could not resolve annotated tag: invalid GitHub object.');
    object = gitObject(annotated.object);
  }
  if (object.sha !== expectedCommit) throw new Error(`Git tag ${tag} does not point to RELEASE_COMMIT.`);

  const releaseResponse = await request(`releases/tags/${tag}`);
  if (releaseResponse.status === 200) throw new Error(`Release ${tag} already exists in ${repository}.`);
  if (releaseResponse.status !== 404) throw new Error(`Could not check release availability: GitHub returned HTTP ${releaseResponse.status}.`);

  // The release-by-tag endpoint only promises published releases. Authenticated
  // release listings also include drafts for callers with repository push access.
  for (let page = 1; ; page++) {
    const response = await request(`releases?per_page=100&page=${page}`);
    if (response.status !== 200) throw new Error(`Could not check draft releases: GitHub returned HTTP ${response.status}.`);
    const releases = await json(response);
    if (!Array.isArray(releases) || releases.some((release) => typeof release?.tag_name !== 'string')) {
      throw new Error('Could not check draft releases: invalid GitHub response.');
    }
    const tags = releases.map((release) => release.tag_name);
    if (tags.includes(tag)) throw new Error(`Release ${tag} already exists in ${repository}, including drafts.`);
    if (tags.length < 100) break;
  }

  const latestResponse = await request('releases/latest');
  if (latestResponse.status === 200) {
    const latestVersion = parseVersionTag((await json(latestResponse))?.tag_name, 'Latest release tag');
    const different = targetVersion.parts.findIndex((component, index) => component !== latestVersion.parts[index]);
    if (different === -1 || targetVersion.parts[different] < latestVersion.parts[different]) {
      throw new Error(`Release ${tag} must be newer than the latest stable release ${latestVersion.tag}.`);
    }
  } else if (latestResponse.status !== 404) {
    throw new Error(`Could not check latest release: GitHub returned HTTP ${latestResponse.status}.`);
  }
  return { tag, commit: expectedCommit, repository };
}

if (import.meta.main) {
  try {
    const { tag, commit, repository } = await checkReleaseTarget({ tag: process.env.RELEASE_TAG, commit: process.env.RELEASE_COMMIT, repository: process.env.GH_REPO, token: process.env.GH_TOKEN });
    console.log(`Release ${tag} is available for ${repository} at ${commit}.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
