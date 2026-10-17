import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const fixture = JSON.parse(readFileSync(new URL('../reference/sample-data.json', import.meta.url), 'utf8'));

function midnight(date, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  const wanted = Date.parse(date + 'T00:00:00Z');
  let candidate = wanted;
  for (let i = 0; i < 4; i++) {
    const fields = Object.fromEntries(parts.formatToParts(candidate).map(({ type, value }) => [type, value]));
    const displayed = Date.parse(`${fields.year}-${fields.month}-${fields.day}T${fields.hour}:${fields.minute}:${fields.second}Z`);
    if (displayed === wanted) return new Date(candidate).toISOString();
    candidate += wanted - displayed;
  }
  throw new Error('This calendar midnight does not exist in the selected timezone.');
}

function resolveBounds(configuration, now) {
  new Intl.DateTimeFormat('en', { timeZone: configuration.timezone });
  if (configuration.window.kind === 'relative') return {
    start: new Date(now.getTime() - 7 * 24 * 3600 * 1000).toISOString(), end: now.toISOString(),
  };
  const { start_date: start, end_date: end } = configuration.window;
  const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(value).toISOString().slice(0, 10) === value;
  if (!validDate(start) || !validDate(end) || start > end) throw new Error('Choose valid start and end dates.');
  const following = new Date(Date.parse(end + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10);
  return { start: midnight(start, configuration.timezone), end: midnight(following, configuration.timezone) };
}

// Synthetic data is consumed only by this isolated demo server, never the plugin.
export function createDemoService({ now = () => new Date(), duration = 3200, seed = false } = {}) {
  let task = null, started = 0, pending = null, submissions = 0, emptyNext = false, outcomeNext = null;
  let reports = [];
  const details = new Map();
  const reply = (status, value) => ({ status, value });
  const fail = (status, message) => reply(status, { error: { message } });

  function finish(empty, createdAt) {
    const patterns = task.configuration.exclusions.user_agent_patterns.map(pattern => new RegExp(pattern));
    const removed = { user_agent: 0, model: 0 };
    const keys = fixture.client_keys.map(key => ({ ...key, groups: [] }));
    const grouped = new Map(keys.map(key => [key.id, new Map()]));
    for (const group of fixture.successful_usage_groups) {
      if (patterns.some(pattern => pattern.test(group.user_agent || ''))) { removed.user_agent += group.requests; continue; }
      if (task.configuration.exclusions.models.includes(group.model)) { removed.model += group.requests; continue; }
      if (empty) continue;
      const values = grouped.get(group.client_key_id);
      if (!values) continue;
      const value = { model: group.model || 'unknown', reasoning_effort: group.reasoning_effort?.trim() || 'unspecified', is_subagent: Boolean(group.subagent_kind?.trim()), requests: group.requests };
      const id = JSON.stringify([value.model, value.reasoning_effort, value.is_subagent]);
      if (values.has(id)) values.get(id).requests += value.requests;
      else values.set(id, value);
    }
    for (const key of keys) key.groups = [...grouped.get(key.id).values()];
    const retained = keys.filter(key => key.groups.length);
    task.state = 'complete';
    if (retained.length) {
      const report = { format_version: 1, id: task.id, created_at: createdAt, configuration: task.configuration, bounds: task.bounds, removed, keys: retained };
      const summary = { id: report.id, created_at: report.created_at, total_requests: retained.reduce((sum, key) => sum + key.groups.reduce((total, group) => total + group.requests, 0), 0), keys_count: retained.length };
      details.set(report.id, report);
      reports.unshift(summary);
      for (const old of reports.splice(20)) details.delete(old.id);
      task.report_id = report.id;
    }
  }

  function update() {
    if (!pending) return;
    const fraction = Math.min(1, (Date.now() - started) / duration);
    task.state = fraction < 0.1 ? 'queued' : 'running';
    task.keys_processed = Math.floor(fraction * task.keys_total);
    task.records_read = Math.floor(fraction * fixture.successful_usage_groups.reduce((sum, group) => sum + group.requests, 0));
    if (fraction < 1) return;
    if (pending.outcome) {
      task.state = pending.outcome;
      task.error = pending.outcome === 'interrupted'
        ? 'Report generation was interrupted by a plugin restart. Submit again to start a fresh scan.'
        : 'The host history query failed. No partial report was saved.';
    } else {
      finish(pending.empty, now().toISOString());
    }
    pending = null;
  }

  // A few completed examples make the review landing useful without submitting jobs.
  function seedReports() {
    for (const daysAgo of [2, 1, 0]) {
      const created = new Date(now().getTime() - daysAgo * 86400000);
      const submitted = new Date(created.getTime() - 60000);
      const configuration = {
        window: { kind: 'relative' }, timezone: daysAgo === 1 ? 'Asia/Shanghai' : 'UTC',
        exclusions: { user_agent_patterns: daysAgo === 2 ? [] : ['^prompt'], models: ['codex-auto-review', 'gpt-5.6-luna'] },
      };
      task = { id: randomUUID(), submitted_at: submitted.toISOString(),
        configuration, bounds: resolveBounds(configuration, submitted), state: 'complete',
        keys_processed: fixture.client_keys.length, keys_total: fixture.client_keys.length,
        records_read: fixture.successful_usage_groups.reduce((sum, group) => sum + group.requests, 0), report_id: null, error: null };
      finish(false, created.toISOString());
    }
  }

  if (seed) seedReports();

  return {
    reset({ empty = false, seed = false, outcome = null } = {}) {
      task = null; pending = null; reports = []; details.clear(); submissions = 0; emptyNext = empty; outcomeNext = outcome;
      if (seed) seedReports();
    },
    stats() { update(); return { submissions, reports: reports.length }; },
    handle(method, path, query, body) {
      update();
      if (method === 'GET' && path === 'api/task') return reply(200, { task });
      if (method === 'GET' && path === 'api/reports') return reply(200, { reports });
      if (method === 'GET' && path === 'api/reports/detail') {
        const report = details.get(query.get('id'));
        return report ? reply(200, { report }) : fail(404, 'The saved report was not found.');
      }
      if (method === 'POST' && path === 'api/tasks') {
        if (pending) return fail(409, 'A report task is already running.');
        try {
          const configuration = JSON.parse(body.toString('utf8'));
          const bounds = resolveBounds(configuration, now());
          configuration.exclusions.user_agent_patterns.forEach(pattern => new RegExp(pattern));
          if (!Array.isArray(configuration.exclusions.models)) throw new Error('Model exclusions must be a list.');
          submissions++;
          task = { id: randomUUID(), submitted_at: now().toISOString(), configuration, bounds, state: 'queued', keys_processed: 0, keys_total: fixture.client_keys.length, records_read: 0, report_id: null, error: null };
          started = Date.now(); pending = { empty: emptyNext, outcome: outcomeNext }; emptyNext = false; outcomeNext = null;
          return reply(202, { task });
        } catch (error) { return fail(400, error.message); }
      }
      return fail(404, 'Route not found.');
    },
  };
}
