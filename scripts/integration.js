import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createWriteStream, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startUpstream } from '../tests/integration/upstream.js';

const options = {};
for (let index = 2; index < process.argv.length; index++) {
  const flag = process.argv[index];
  assert.ok(flag.startsWith('--'), `Expected an option, received ${flag}`);
  options[flag.slice(2)] = process.argv[index + 1]?.startsWith('--') || !process.argv[index + 1] ? true : process.argv[++index];
}
if (!options['host-binary'] || !options['host-web'] || !options.package) {
  console.error('Usage: node scripts/integration.js --host-binary /path/codex-proxy-rs --host-web /path/web/dist --package /path/plugin.tar.gz [--plugin-cli /path/cpr-plugin] [--postgres-container isolated-pg --redis-container isolated-redis] [--browser] [--keep]');
  process.exit(2);
}

const temporary = mkdtempSync(join(tmpdir(), 'codex-reports-integration-'));
const suffix = randomBytes(5).toString('hex');
const pgName = options['postgres-container'] || `codex-reports-pg-${suffix}`;
const redisName = options['redis-container'] || `codex-reports-redis-${suffix}`;
const database = `cpr_reports_${suffix}`;
const pgPort = Number(options['postgres-port'] || 25439);
const redisPort = Number(options['redis-port'] || 26389);
const hostPort = Number(options.port || 4189);
const base = `http://127.0.0.1:${hostPort}`;
const password = 'reports-integration-only-0123456789abcdef';
const adminPassword = 'reports-integration-password-2026';
const dockerArguments = options['docker-config'] ? ['--config', options['docker-config']] : [];
const ownedContainers = [];
const checks = [];
let pgUser = 'cpr_reports', pgPassword = password, redisPassword = password;
let effectivePgPort = pgPort, effectiveRedisPort = redisPort;
let databaseCreated = false, host, upstream, cookie, view, instanceId, browser;
const command = (binary, args, input) => {
  const result = spawnSync(binary, args, { input, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${binary} ${args[0]} failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
};
const docker = (args, input) => command('docker', [...dockerArguments, ...args], input);
const sql = (statement) => docker(['exec', '-i', pgName, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', pgUser, '-d', database], statement);
const literal = (value) => `'${String(value).replaceAll("'", "''")}'`;
const delay = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds));
async function until(action, label, timeout = 30000, interval = 200) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try { return await action(); } catch (error) { if (error.fatal) throw error; last = error; await delay(interval); }
  }
  throw new Error(`${label}: ${last?.message || 'timed out'}`);
}
function pass(label) { checks.push(label); console.log(`PASS ${label}`); }
async function json(path, body, expected = 200) {
  const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000) });
  const text = await response.text();
  assert.equal(response.status, expected, `${path}: ${text}`);
  const value = JSON.parse(text);
  if (value.code !== undefined) { assert.equal(value.code, 200, text); return value.data; }
  return value;
}
async function management(path, values, expected = 200) {
  const target = view.target;
  const route = `/api/admin/plugins/extensions/${target.instanceId}/${target.artifactSha256}/${target.revision}/api/${path}`;
  const response = await fetch(base + route, { method: values === undefined ? 'GET' : 'POST', headers: { cookie, ...(values === undefined ? {} : { 'content-type': 'application/json' }) }, body: values === undefined ? undefined : JSON.stringify(values), signal: AbortSignal.timeout(20000) });
  const text = await response.text();
  assert.equal(response.status, expected, `${path}: ${text}`);
  return JSON.parse(text);
}
async function refreshView() {
  view = await until(async () => {
    const views = await json('/api/admin/plugins/extensions');
    const found = views.find((item) => item.target.instanceId === instanceId);
    assert.ok(found, 'enabled report management page');
    return found;
  }, 'plugin management registration');
}
async function startHost() {
  const log = createWriteStream(join(temporary, 'host.log'), { flags: 'a' });
  const environment = { ...process.env };
  for (const name of Object.keys(environment)) if (name.startsWith('CPR_')) delete environment[name];
  host = spawn(resolve(options['host-binary']), ['serve'], { cwd: temporary, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
  host.stdout.pipe(log); host.stderr.pipe(log);
  await until(async () => { assert.equal(host.exitCode, null, `host exited; inspect ${temporary}/host.log`); await json('/api/auth/status'); }, 'host startup', 60000);
  const response = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'admin', password: adminPassword }) });
  assert.equal(response.status, 200, await response.text());
  cookie = response.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie, 'administrator session cookie');
}
async function stopHost() {
  if (!host || host.exitCode !== null) return;
  const exited = once(host, 'exit'); host.kill('SIGTERM');
  const timer = setTimeout(() => host.kill('SIGKILL'), 10000);
  try { await exited; } finally { clearTimeout(timer); }
}
const makeKey = (name) => json('/api/admin/client-keys/create', { name, groupIds: [], maxConcurrency: 0, requestsPerMinute: 0 }, 201);
async function modelRequest(key, marker, { model = 'gpt-5.4', effort = 'low', subagent, userAgent = `reports-integration/${marker}`, generate = true, expected = 200 } = {}) {
  const metadata = subagent ? { 'x-codex-turn-metadata': JSON.stringify({ subagent_kind: subagent, ...(marker === 'INTEGRATION-compaction' ? { request_kind: 'compaction' } : {}) }) } : {};
  const response = await fetch(base + '/v1/responses', { method: 'POST', headers: { authorization: `Bearer ${key.plaintextKey}`, 'content-type': 'application/json', 'user-agent': userAgent }, body: JSON.stringify({ model, store: false, stream: false, generate, ...(effort === null ? {} : { reasoning: { effort } }), input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: marker }] }], ...(Object.keys(metadata).length ? { client_metadata: metadata } : {}) }), signal: AbortSignal.timeout(20000) });
  const text = await response.text();
  assert.equal(response.status, expected, `${marker}: ${text}`);
  return JSON.parse(text);
}
async function completeTask(configuration) {
  const startedAt = Date.now();
  const submitted = await management('api/tasks', configuration, 202);
  assert.ok(['queued', 'running'].includes(submitted.task.state));
  const finished = await until(async () => {
    const { task } = await management('api/task');
    assert.equal(task.id, submitted.task.id);
    if (['failed', 'interrupted'].includes(task.state)) throw Object.assign(new Error(JSON.stringify(task)), { fatal: true });
    assert.equal(task.state, 'complete', JSON.stringify(task));
    return task;
  }, 'report task completion', Number(options['task-timeout-ms'] || 600000), 1000);
  console.log(`Report task ${finished.id} completed in ${Date.now() - startedAt} ms`);
  return { task: finished, elapsedMs: Date.now() - startedAt };
}
async function browserSmoke(saved) {
  const originalTask = (await management('api/task')).task;
  const { chromium } = await import('@playwright/test');
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}) });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
  const errors = [], submissions = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => { if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/api/api/tasks')) submissions.push(request.url()); });
  await page.context().addCookies([{ name: cookie.split('=')[0], value: cookie.slice(cookie.indexOf('=') + 1), url: base }]);
  await page.goto(`${base}/plugins/${instanceId}/${view.pages[0].id}`);
  const ui = page.frameLocator('iframe');
  await ui.locator('#home-view').waitFor({ timeout: 30000 });
  const openReport = ui.locator('#reports-list').getByRole('button', { name: /^Open report/ }).first();
  await openReport.waitFor({ timeout: 30000 });
  assert.equal(await ui.locator('#new-report').isVisible(), true);
  assert.equal(await ui.locator('#report-view').isVisible(), false, 'landing waits for an explicit report selection');
  await openReport.click();
  await ui.locator('#charts .chart-card').first().waitFor({ timeout: 30000 });
  assert.equal(await ui.locator('#home-view').isVisible(), false);
  assert.equal(await ui.locator('#charts .chart-card').count(), 2);
  assert.equal(await ui.locator('#charts .usage-chart').count(), 2);
  assert.equal(await ui.locator('#report-total').textContent(), '109 retained requests');
  assert.ok((await ui.locator('#report-window').textContent()).includes('UTC'));
  assert.equal(await page.locator('iframe').getAttribute('sandbox'), 'allow-scripts');
  await ui.locator('#reuse').click();
  await ui.locator('#configure-step').waitFor();
  assert.equal(await ui.locator('#wizard-view').isVisible(), true);
  assert.equal(await ui.locator('#report-view').isVisible(), false);
  assert.equal(await ui.locator('#timezone').inputValue(), saved.configuration.timezone);
  assert.equal(await ui.locator('#window-kind').inputValue(), 'custom');
  assert.equal(await ui.locator('#start-date').inputValue(), saved.configuration.window.start_date);
  assert.equal(await ui.locator('#end-date').inputValue(), saved.configuration.window.end_date);
  await ui.locator('#continue-review').click();
  await ui.locator('#review-step').waitFor();
  assert.equal(await ui.locator('#configure-step').isVisible(), false);
  assert.equal(await ui.locator('#review-step').locator('input, select, textarea').count(), 0, 'review presents read-only configuration');
  assert.ok((await ui.locator('#confirmation-summary').textContent()).includes(saved.configuration.timezone));
  assert.equal(await ui.locator('#confirm-generate').isVisible(), true);
  await ui.locator('#back-to-edit').click();
  await ui.locator('#configure-step').waitFor();
  assert.equal(await ui.locator('#start-date').inputValue(), saved.configuration.window.start_date);
  await ui.locator('#continue-review').click();
  await ui.locator('#review-step').waitFor();
  await ui.locator('#wizard-view [data-home]').click();
  await ui.locator('#home-view').waitFor();
  assert.equal(submissions.length, 0, 'opening reports, reusing settings, reviewing, editing and returning home do not submit');
  assert.equal((await management('api/task')).task.id, originalTask.id);
  await openReport.click();
  await ui.locator('#charts .chart-card').first().waitFor();
  await ui.locator('.enlarge').first().click();
  await ui.locator('#chart-dialog .usage-chart').waitFor();
  assert.equal(await ui.locator('#chart-dialog-title').textContent(), saved.keys[0].name);
  await ui.getByRole('button', { name: 'Close enlarged chart', exact: true }).click();
  await page.screenshot({ path: join(temporary, 'real-host-report.png'), fullPage: true, animations: 'disabled' });
  assert.deepEqual(errors, []);
  await browser.close(); browser = undefined;
  pass('actual host iframe opens saved reports explicitly, reviews reused settings without submission and enlarges charts without errors');
}
function isolatedContainer(name) {
  const inspected = JSON.parse(docker(['inspect', name]))[0];
  assert.ok(inspected.Config.Labels?.purpose?.includes('disposable') || name.startsWith('codex-reports-'), `Existing container ${name} must be explicitly labeled disposable`);
  return inspected;
}
async function run() {
  if (!options['postgres-container']) {
    docker(['run', '-d', '--name', pgName, '--label', 'purpose=codex-reports-disposable', '-e', `POSTGRES_USER=${pgUser}`, '-e', `POSTGRES_PASSWORD=${password}`, '-e', 'POSTGRES_DB=postgres', '-p', `127.0.0.1:${pgPort}:5432`, 'postgres:17-alpine']);
    ownedContainers.push(pgName);
  } else {
    const inspected = isolatedContainer(pgName);
    const environment = Object.fromEntries(inspected.Config.Env.map((item) => { const separator = item.indexOf('='); return [item.slice(0, separator), item.slice(separator + 1)]; }));
    pgUser = options['database-user'] || environment.POSTGRES_USER;
    pgPassword = options['database-password'] || environment.POSTGRES_PASSWORD;
    effectivePgPort = Number(options['postgres-port'] || inspected.NetworkSettings.Ports['5432/tcp'][0].HostPort);
  }
  if (!options['redis-container']) {
    docker(['run', '-d', '--name', redisName, '--label', 'purpose=codex-reports-disposable', '-p', `127.0.0.1:${redisPort}:6379`, 'redis:7-alpine', 'redis-server', '--requirepass', password]);
    ownedContainers.push(redisName);
  } else {
    const inspected = isolatedContainer(redisName);
    redisPassword = options['redis-password'] || inspected.Config.Cmd[inspected.Config.Cmd.indexOf('--requirepass') + 1];
    effectiveRedisPort = Number(options['redis-port'] || inspected.NetworkSettings.Ports['6379/tcp'][0].HostPort);
  }
  await until(() => docker(['exec', pgName, 'pg_isready', '-U', pgUser]), 'PostgreSQL startup');
  docker(['exec', '-i', pgName, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', pgUser, '-d', 'postgres'], `CREATE DATABASE "${database}"`);
  databaseCreated = true;
  upstream = await startUpstream();
  mkdirSync(join(temporary, 'deploy'));
  writeFileSync(join(temporary, 'deploy/config.yaml'), `schema_version: 1\nhost:\n  timezone: America/New_York\n  listen: {host: 127.0.0.1, port: ${hostPort}}\n  runtime_data_dir: ../runtime\n  logging:\n    level: info\n    stdout: true\n    file: {enabled: false, directory: ../logs, retention_days: 7, max_file_size_mb: 20}\nstore:\n  database: {url: 'postgres://${pgUser}@127.0.0.1:${effectivePgPort}/${database}', password: '${pgPassword}'}\n  redis: {url: 'redis://127.0.0.1:${effectiveRedisPort}/9', password: '${redisPassword}'}\nadmin:\n  default_username: admin@cpr.local\n  default_password: '${adminPassword}'\n  session_ttl_minutes: 10080\n  session_absolute_ttl_minutes: 43200\napi:\n  asset_directory: '${resolve(options['host-web'])}'\n  cors_allowed_origins: []\n  request_timeout_seconds: null\n  request_id_header: x-request-id\nopenai:\n  api: {base_url: '${upstream.url}/v1'}\n  stream_max_retries: 0\n`);
  await startHost();
  pass('official host bootstrap, fresh PostgreSQL database and administrator authentication');
  const hostVersion = command(resolve(options['host-binary']), ['--version']);
  assert.match(hostVersion, /3\.29\./);
  if (options['plugin-cli']) command(resolve(options['plugin-cli']), ['--version']);
  const archive = readFileSync(resolve(options.package));
  const packageSha256 = createHash('sha256').update(archive).digest('hex');
  const response = await fetch(base + `/api/admin/plugins/artifacts/upload?sha256=${packageSha256}`, { method: 'POST', headers: { cookie, 'content-type': 'application/gzip' }, body: archive });
  const installed = await response.json();
  assert.equal(response.status, 201, JSON.stringify(installed));
  assert.equal(installed.data.configurationRequired, false);
  instanceId = installed.data.defaultInstanceId;
  assert.ok(instanceId);
  const instance = (await json('/api/admin/plugins/instances')).find((item) => item.id === instanceId);
  assert.ok(instance.enabled);
  assert.equal(instance.compatibilityWarning, null);
  assert.deepEqual(instance.configuration, {});
  assert.deepEqual(instance.bindings, []);
  assert.equal(installed.data.artifact.metadata.contributes.middleware, undefined);
  await refreshView();
  assert.ok(view.pages.length > 0);
  assert.deepEqual(await management('api/task'), { task: null });
  assert.deepEqual(await management('api/reports'), { reports: [] });
  const managementBase = `/api/admin/plugins/extensions/${view.target.instanceId}/${view.target.artifactSha256}/${view.target.revision}/api/`;
  for (const [method, path] of [['GET', 'api/task'], ['POST', 'api/tasks']]) {
    const denied = await fetch(base + managementBase + path, { method, ...(method === 'POST' ? { headers: { 'content-type': 'application/json' }, body: '{}' } : {}) });
    assert.ok([401, 403].includes(denied.status), 'report management requires administrator authentication');
  }
  pass('default install registers management and maintenance with no configuration or middleware');
  await json('/api/admin/accounts/import', { provider: 'openai', data: { provider: 'openai', authentication_kind: 'api_key', name: 'Reports controlled upstream', base_url: `${upstream.url}/v1`, api_key: 'sk-integration-only', transport: 'http' } }, 201);
  const primary = await makeKey('Reports primary');
  const secondary = await makeKey('Reports secondary');
  for (let offset = 0; offset < 101; offset += 3) await Promise.all(Array.from({ length: Math.min(3, 101 - offset) }, (_, index) => modelRequest(primary, `INTEGRATION-bulk-${offset + index}`)));
  await modelRequest(primary, 'INTEGRATION-subagent-a', { effort: 'high', subagent: 'review' });
  await modelRequest(primary, 'INTEGRATION-subagent-b', { effort: 'high', subagent: 'worker' });
  await modelRequest(primary, 'INTEGRATION-UA-excluded', { userAgent: 'prompt-reports/1.0' });
  await modelRequest(primary, 'INTEGRATION-both-excluded', { model: 'gpt-5.6-luna', userAgent: 'prompt-reports/2.0' });
  await modelRequest(primary, 'INTEGRATION-model-excluded', { model: 'gpt-5.6-luna' });
  await modelRequest(primary, 'INTEGRATION-UA-case-sensitive', { userAgent: 'Prompt-reports/1.0' });
  await modelRequest(primary, 'INTEGRATION-unspecified-effort', { effort: null });
  await modelRequest(secondary, 'INTEGRATION-secondary', { model: 'gpt-5.3', effort: 'max', subagent: 'worker' });
  await modelRequest(secondary, 'INTEGRATION-at-start', { model: 'gpt-5.3' });
  await modelRequest(secondary, 'INTEGRATION-at-end', { model: 'gpt-5.3' });
  await modelRequest(secondary, 'INTEGRATION-before-start', { model: 'gpt-5.3' });
  await modelRequest(secondary, 'INTEGRATION-secondary-unspecified', { model: 'gpt-5.3', effort: null });
  await modelRequest(secondary, 'INTEGRATION-compaction', { model: 'gpt-5.3', subagent: 'compact' });
  // Prewarm requires a WebSocket upstream. Reuse a delivered HTTP fixture and
  // mark only its native request kind in this disposable database instead.
  await modelRequest(secondary, 'INTEGRATION-prewarm');
  await modelRequest(secondary, 'INTEGRATION-failure', { expected: 400 });
  await modelRequest(secondary, 'INTEGRATION-incomplete', { expected: 500 });
  await until(() => assert.equal(Number(sql('SELECT count(*) FROM model_requests')), 117), 'host persists controlled requests');
  assert.equal(sql("SELECT request_kind FROM model_requests WHERE request_observation_json #>> '{request,userAgent}' = 'reports-integration/INTEGRATION-compaction'"), 'compaction');
  assert.equal(sql('SELECT count(*) FROM model_request_observations WHERE subagent_kind IS NOT NULL'), '4');
  assert.equal(sql("SELECT reasoning_effort FROM model_request_observations WHERE user_agent = 'reports-integration/INTEGRATION-secondary'"), 'max');
  const today = new Date();
  const dayStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - 1));
  const dayEnd = new Date(dayStart.getTime() + 86400000);
  const day = dayStart.toISOString().slice(0, 10);
  sql(`UPDATE model_requests SET started_at = ${literal(new Date(dayStart.getTime() + 3600000).toISOString())};
UPDATE model_requests SET request_kind = 'prewarm' WHERE request_observation_json #>> '{request,userAgent}' = 'reports-integration/INTEGRATION-prewarm';
UPDATE model_requests SET started_at = ${literal(dayStart.toISOString())} WHERE request_observation_json #>> '{request,userAgent}' = 'reports-integration/INTEGRATION-at-start';
UPDATE model_requests SET started_at = ${literal(dayEnd.toISOString())} WHERE request_observation_json #>> '{request,userAgent}' = 'reports-integration/INTEGRATION-at-end';
UPDATE model_requests SET started_at = ${literal(new Date(dayStart.getTime() - 1).toISOString())} WHERE request_observation_json #>> '{request,userAgent}' = 'reports-integration/INTEGRATION-before-start';
UPDATE model_requests SET attempt_count = 3 WHERE request_observation_json #>> '{request,userAgent}' = 'reports-integration/INTEGRATION-bulk-0';`);
  const emptyKeys = [];
  for (let offset = 0; offset < 103; offset += 10) emptyKeys.push(...await Promise.all(Array.from({ length: Math.min(10, 103 - offset) }, (_, index) => makeKey(`Reports empty ${offset + index}`))));
  pass('real upstream writes paginated success/failure history and a cancelled transport-incomplete stream, with native prewarm and timestamp fixtures');
  const configuration = { window: { kind: 'custom', start_date: day, end_date: day }, timezone: 'UTC', exclusions: { user_agent_patterns: ['^prompt'], models: ['codex-auto-review', 'gpt-5.6-luna'] } };
  await management('api/tasks', { ...configuration, exclusions: { user_agent_patterns: ['('], models: [] } }, 400);
  await management('api/tasks', { ...configuration, timezone: 'Invalid/Zone' }, 400);
  assert.deepEqual(await management('api/task'), { task: null });
  pass('invalid regular expressions and timezones reject submission before creating a task');
  const startedAt = Date.now();
  const submitted = await management('api/tasks', configuration, 202);
  assert.ok(['queued', 'running'].includes(submitted.task.state));
  await management('api/tasks', configuration, 409);
  pass('shared unfinished task rejects concurrent submission with HTTP 409');
  const task = await until(async () => { const { task } = await management('api/task'); if (['failed', 'interrupted'].includes(task.state)) throw Object.assign(new Error(JSON.stringify(task)), { fatal: true }); assert.equal(task.state, 'complete', JSON.stringify(task)); return task; }, 'paginated report completes', Number(options['task-timeout-ms'] || 600000), 1000);
  const completionMs = Date.now() - startedAt;
  assert.equal(task.keys_total, 105);
  assert.equal(task.keys_processed, 105);
  assert.equal(task.records_read, 112);
  assert.ok(task.report_id);
  const { report: saved } = await management(`api/reports/detail?id=${encodeURIComponent(task.report_id)}`);
  assert.equal(Date.parse(saved.bounds.start), dayStart.getTime());
  assert.equal(Date.parse(saved.bounds.end), dayEnd.getTime());
  assert.deepEqual(saved.removed, { user_agent: 2, model: 1 });
  assert.equal(saved.keys.length, 2);
  const first = saved.keys.find((key) => key.id === primary.id);
  const second = saved.keys.find((key) => key.id === secondary.id);
  assert.equal(first.name, 'Reports primary');
  assert.equal(second.name, 'Reports secondary');
  const groups = (key) => [...key.groups].sort((left, right) => left.model.localeCompare(right.model) || left.reasoning_effort.localeCompare(right.reasoning_effort) || Number(left.is_subagent) - Number(right.is_subagent));
  assert.deepEqual(groups(first), groups({ groups: [
    { model: 'gpt-5.4', reasoning_effort: 'low', is_subagent: false, requests: 102 },
    { model: 'gpt-5.4', reasoning_effort: 'high', is_subagent: true, requests: 2 },
    { model: 'gpt-5.4', reasoning_effort: 'unspecified', is_subagent: false, requests: 1 },
  ] }));
  assert.deepEqual(groups(second), groups({ groups: [
    { model: 'gpt-5.3', reasoning_effort: 'max', is_subagent: true, requests: 1 },
    { model: 'gpt-5.3', reasoning_effort: 'low', is_subagent: false, requests: 1 },
    { model: 'gpt-5.3', reasoning_effort: 'low', is_subagent: true, requests: 1 },
    { model: 'gpt-5.3', reasoning_effort: 'unspecified', is_subagent: false, requests: 1 },
  ] }));
  assert.ok(Buffer.byteLength(JSON.stringify(saved)) <= 48 * 1024);
  assert.equal((await management('api/reports')).reports.length, 1);
  pass(`105-key directory and >100-record paging, host success classification, half-open UTC bounds, exact exclusions and groups (${completionMs} ms)`);
  for (let offset = 0; offset < emptyKeys.length; offset += 10) await Promise.all(emptyKeys.slice(offset, offset + 10).map((key) => json('/api/admin/client-keys/delete', { id: key.id })));
  const empty = await completeTask({ ...configuration, exclusions: { user_agent_patterns: ['.*'], models: [] } });
  assert.equal(empty.task.report_id, null);
  assert.equal((await management('api/reports')).reports.length, 1);
  pass('empty successful task creates no report entry');
  sql('ALTER VIEW model_request_observations RENAME TO model_request_observations_integration_hidden');
  try {
    const failed = await management('api/tasks', configuration, 202);
    const task = await until(async () => {
      const { task } = await management('api/task');
      assert.equal(task.id, failed.task.id);
      assert.equal(task.state, 'failed', JSON.stringify(task));
      return task;
    }, 'history read failure fails task', 90000, 1000);
    assert.ok(task.error);
    assert.equal(task.report_id, null);
    assert.equal((await management('api/reports')).reports.length, 1);
    pass('host history read failure records a failed task and publishes no partial report');
  } finally {
    sql('ALTER VIEW model_request_observations_integration_hidden RENAME TO model_request_observations');
  }
  await stopHost(); await startHost(); await refreshView();
  assert.deepEqual((await management(`api/reports/detail?id=${encodeURIComponent(saved.id)}`)).report, saved);
  assert.equal((await management('api/reports')).reports.length, 1);
  pass('saved compact report and report index survive host/plugin restart');
  const unfinished = await management('api/tasks', configuration, 202);
  await stopHost(); await startHost(); await refreshView();
  const interrupted = (await management('api/task')).task;
  assert.equal(interrupted.id, unfinished.task.id);
  assert.equal(interrupted.state, 'interrupted');
  assert.equal(interrupted.report_id, null);
  assert.equal((await management('api/reports')).reports.length, 1);
  pass('restart marks unfinished task interrupted without publishing partial data');
  if (options.browser) await browserSmoke(saved);
  const evidence = { hostVersion, hostCommit: options['host-commit'] || '45954899e53081a2e775fb9351e22908e85221c7', hostBinarySha256: createHash('sha256').update(readFileSync(resolve(options['host-binary']))).digest('hex'), packageSha256, completionMs, checks, report: saved, fixture: { requests: 117, directoryKeys: 105, successfulRecordsRead: 112, retainedRequests: 109, nativeDatabaseOverrides: ['prewarm request kind', 'boundary start timestamps', 'one logical request with three attempts'] }, screenshot: options.browser ? join(temporary, 'real-host-report.png') : null, hostUrl: base, pageUrl: `${base}/plugins/${instanceId}/${view.pages[0].id}` };
  writeFileSync(join(temporary, 'result.json'), JSON.stringify(evidence, null, 2));
  console.log(`Evidence: ${temporary}`);
  if (options.keep) {
    console.log(`Test page: ${evidence.pageUrl}`);
    console.log(`Test administrator: admin@cpr.local / ${adminPassword}`);
    console.log('Ctrl+C stops this isolated host and removes owned test services/database.');
    await new Promise((done) => process.once('SIGINT', done));
  }
}
async function cleanup() {
  await browser?.close();
  await stopHost();
  await upstream?.close();
  if (databaseCreated) {
    try { docker(['exec', '-i', pgName, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', pgUser, '-d', 'postgres'], `DROP DATABASE "${database}" WITH (FORCE)`); } catch (error) { console.error(`Test database cleanup: ${error.message}`); }
  }
  for (const name of ownedContainers.reverse()) {
    try { docker(['rm', '-f', name]); } catch (error) { console.error(`Test container cleanup: ${error.message}`); }
  }
}
try { await run(); } catch (error) { console.error(error); console.error(`Host log and evidence: ${temporary}`); process.exitCode = 1; } finally { await cleanup(); }
