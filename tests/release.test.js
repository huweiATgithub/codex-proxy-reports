import assert from 'node:assert/strict';
import test from 'node:test';
import { checkReleaseTarget } from '../scripts/check-release.js';

const configuration = { tag: 'v0.1.2', commit: '0123456789abcdef0123456789abcdef01234567', repository: 'huweiATgithub/codex-proxy-reports', token: 'github_test_token' };
const annotatedSha = 'b'.repeat(40);
function mockRequests(responses) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      assert.ok(responses.length, `Unexpected GitHub request: ${url}`);
      const response = responses.shift();
      if (response instanceof Error) throw response;
      return response;
    },
  };
}
const missing = () => new Response(null, { status: 404 });
const listing = (releases = []) => Response.json(releases);
const reference = (type = 'commit', sha = configuration.commit) => Response.json({ ref: `refs/tags/${configuration.tag}`, object: { type, sha } });
const annotation = (type = 'commit', sha = configuration.commit) => Response.json({ sha: annotatedSha, object: { type, sha } });

test('a lightweight tag at the expected commit can release after checking published and draft releases', async () => {
  const mock = mockRequests([reference(), missing(), listing(), Response.json({ tag_name: 'v0.1.1' })]);
  assert.deepEqual(await checkReleaseTarget({ ...configuration, commit: configuration.commit.toUpperCase(), fetchImpl: mock.fetchImpl }), { tag: configuration.tag, commit: configuration.commit, repository: configuration.repository });
  assert.deepEqual(mock.calls.map(({ url }) => url), [
    'https://api.github.com/repos/huweiATgithub/codex-proxy-reports/git/ref/tags/v0.1.2',
    'https://api.github.com/repos/huweiATgithub/codex-proxy-reports/releases/tags/v0.1.2',
    'https://api.github.com/repos/huweiATgithub/codex-proxy-reports/releases?per_page=100&page=1',
    'https://api.github.com/repos/huweiATgithub/codex-proxy-reports/releases/latest',
  ]);
  assert.ok(mock.calls.every(({ options }) => options.headers.authorization === `Bearer ${configuration.token}` && options.redirect === 'error'));
});

test('an annotated tag resolves to its underlying commit before checking release availability', async () => {
  const mock = mockRequests([reference('tag', annotatedSha), annotation(), missing(), listing(), Response.json({ tag_name: 'v0.1.1' })]);
  assert.equal((await checkReleaseTarget({ ...configuration, fetchImpl: mock.fetchImpl })).commit, configuration.commit);
  assert.equal(mock.calls[1].url, `https://api.github.com/repos/${configuration.repository}/git/tags/${annotatedSha}`);
});

test('a missing Git tag refuses release without checking further endpoints', async () => {
  const mock = mockRequests([missing()]);
  await assert.rejects(checkReleaseTarget({ ...configuration, fetchImpl: mock.fetchImpl }), /Git tag v0\.1\.2 does not exist/);
  assert.equal(mock.calls.length, 1);
});

test('lightweight and annotated tags pointing to a different commit refuse publication', async () => {
  for (const responses of [[reference('commit', 'a'.repeat(40))], [reference('tag', annotatedSha), annotation('commit', 'a'.repeat(40))]]) {
    const mock = mockRequests(responses);
    await assert.rejects(checkReleaseTarget({ ...configuration, fetchImpl: mock.fetchImpl }), /does not point to RELEASE_COMMIT/);
  }
});

test('an existing release refuses publication even when the tag points to the expected commit', async () => {
  const mock = mockRequests([reference(), Response.json({ tag_name: 'v0.1.2', draft: false })]);
  await assert.rejects(checkReleaseTarget({ ...configuration, fetchImpl: mock.fetchImpl }), /Release v0\.1\.2 already exists/);
});

test('a draft found on a later release page refuses publication despite the direct release endpoint returning 404', async () => {
  const earlier = Array.from({ length: 100 }, (_, index) => ({ tag_name: `v0.0.${index}`, draft: false }));
  const mock = mockRequests([reference(), missing(), listing(earlier), listing([{ tag_name: 'v0.1.2', draft: true }])]);
  await assert.rejects(checkReleaseTarget({ ...configuration, fetchImpl: mock.fetchImpl }), /Release v0\.1\.2 already exists.*drafts/);
  assert.equal(mock.calls.at(-1).url, 'https://api.github.com/repos/huweiATgithub/codex-proxy-reports/releases?per_page=100&page=2');
});

for (const status of [403, 500]) {
  test(`HTTP ${status} fails closed at every GitHub lookup`, async () => {
    const steps = [() => [], () => [reference('tag', annotatedSha)], () => [reference()], () => [reference(), missing()], () => [reference(), missing(), listing()]];
    for (const preceding of steps) {
      const mock = mockRequests([...preceding(), new Response(null, { status })]);
      await assert.rejects(checkReleaseTarget({ ...configuration, fetchImpl: mock.fetchImpl }), new RegExp(`GitHub returned HTTP ${status}`));
    }
  });
}

test('404 responses from annotated-tag resolution and draft listing fail closed', async () => {
  for (const responses of [[reference('tag', annotatedSha), missing()], [reference(), missing(), missing()]]) {
    const mock = mockRequests(responses);
    await assert.rejects(checkReleaseTarget({ ...configuration, fetchImpl: mock.fetchImpl }), /GitHub returned HTTP 404/);
  }
});

test('transport failure fails closed without exposing its potentially sensitive message', async () => {
  const mock = mockRequests([new Error(`Connection failed with ${configuration.token}`)]);
  await assert.rejects(checkReleaseTarget({ ...configuration, fetchImpl: mock.fetchImpl }), (error) => {
    assert.match(error.message, /request failed/);
    assert.equal(error.message.includes(configuration.token), false);
    return true;
  });
});

test('malformed or unexpected Git objects fail closed', async () => {
  const responses = [
    [new Response('invalid JSON')],
    [Response.json({ ref: 'refs/tags/wrong', object: { type: 'commit', sha: configuration.commit } })],
    [reference('blob')],
    [reference('commit', 'invalid')],
    [reference('tag', annotatedSha), Response.json({ sha: 'a'.repeat(40), object: { type: 'commit', sha: configuration.commit } })],
  ];
  for (const values of responses) {
    const mock = mockRequests(values);
    await assert.rejects(checkReleaseTarget({ ...configuration, fetchImpl: mock.fetchImpl }), /invalid GitHub/);
  }
});

test('annotated tag resolution is bounded when the API keeps returning tag objects', async () => {
  const mock = mockRequests([reference('tag', annotatedSha), ...Array.from({ length: 16 }, () => annotation('tag', annotatedSha))]);
  await assert.rejects(checkReleaseTarget({ ...configuration, fetchImpl: mock.fetchImpl }), /nesting exceeds 16 levels/);
  assert.equal(mock.calls.length, 17);
});

test('malformed draft listings fail closed', async () => {
  for (const response of [new Response('invalid JSON'), listing({ message: 'Unexpected response' }), listing([{}])]) {
    const mock = mockRequests([reference(), missing(), response]);
    await assert.rejects(checkReleaseTarget({ ...configuration, fetchImpl: mock.fetchImpl }), /invalid GitHub response/);
  }
});

test('the first release is allowed only when the latest-release endpoint returns 404', async () => {
  const mock = mockRequests([reference(), missing(), listing(), missing()]);
  assert.equal((await checkReleaseTarget({ ...configuration, fetchImpl: mock.fetchImpl })).tag, configuration.tag);
});

test('a version equal to or older than the latest stable release refuses publication', async () => {
  for (const latest of ['v0.1.2', 'v0.1.3', 'v0.2.0', 'v1.0.0']) {
    const mock = mockRequests([reference(), missing(), listing(), Response.json({ tag_name: latest })]);
    await assert.rejects(checkReleaseTarget({ ...configuration, fetchImpl: mock.fetchImpl }), /must be newer than the latest stable release/);
  }
});

test('stable versions compare numerically without losing precision', async () => {
  for (const [tag, latest] of [['v0.10.0', 'v0.9.9'], ['v1.0.0', 'v0.99.99'], ['v9007199254740993.0.0', 'v9007199254740992.99.99']]) {
    const currentReference = Response.json({ ref: `refs/tags/${tag}`, object: { type: 'commit', sha: configuration.commit } });
    const mock = mockRequests([currentReference, missing(), listing(), Response.json({ tag_name: latest })]);
    assert.equal((await checkReleaseTarget({ ...configuration, tag, fetchImpl: mock.fetchImpl })).tag, tag);
  }
});

test('invalid latest-release metadata fails closed', async () => {
  for (const response of [new Response('invalid JSON'), Response.json({}), Response.json({ tag_name: 'v0.1.1-rc.1' }), Response.json({ tag_name: '0.1.1' })]) {
    const mock = mockRequests([reference(), missing(), listing(), response]);
    await assert.rejects(checkReleaseTarget({ ...configuration, fetchImpl: mock.fetchImpl }), /invalid GitHub response|Latest release tag must be a stable version/);
  }
});

test('invalid tags, repository paths, commit SHAs and missing authentication are rejected before making requests', async () => {
  const mock = mockRequests([]);
  for (const tag of [undefined, '0.1.2', 'v01.1.2', 'v0.1.2-rc.1', 'v0.1.2+build', 'v0.1.2/other', 'v0.1.2\n']) {
    await assert.rejects(checkReleaseTarget({ ...configuration, tag, fetchImpl: mock.fetchImpl }), /RELEASE_TAG/);
  }
  for (const repository of [undefined, 'https://github.com/owner/repo', 'owner/repo/extra', 'owner/..', '-owner/repo', 'owner/repo?query', 'owner/repo\n']) {
    await assert.rejects(checkReleaseTarget({ ...configuration, repository, fetchImpl: mock.fetchImpl }), /GH_REPO/);
  }
  for (const commit of [undefined, 'a'.repeat(39), 'a'.repeat(41), 'g'.repeat(40), `${configuration.commit}\n`]) {
    await assert.rejects(checkReleaseTarget({ ...configuration, commit, fetchImpl: mock.fetchImpl }), /RELEASE_COMMIT/);
  }
  for (const token of [undefined, '', ' ']) {
    await assert.rejects(checkReleaseTarget({ ...configuration, token, fetchImpl: mock.fetchImpl }), /GH_TOKEN/);
  }
  assert.equal(mock.calls.length, 0);
});
