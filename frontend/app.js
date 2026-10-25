import { renderChart, selectChoices } from './chart.js';
import './style.css';

const byId = id => document.getElementById(id);
const host = window.codexProxyPlugin;
const state = { view: 'home', task: null, taskId: null, report: null, connected: false, submitting: false, pendingConfiguration: null, reportRequest: 0, taskRequest: 0, reportsRequest: 0 };
const terminalStates = new Set(['complete', 'failed', 'interrupted']);
const count = value => value.toLocaleString();
let browserTimezone = 'UTC';
let pollTimer;

function element(name, className, text) {
  const node = document.createElement(name);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

async function request(method, path, values) {
  if (!host || host.version !== 2 || typeof host.request !== 'function') {
    throw new Error('Open Reports from the Codex Proxy plugin management page.');
  }
  const body = method === 'POST' ? new TextEncoder().encode(JSON.stringify(values)).buffer : null;
  const response = await host.request({
    method, path, query: method === 'GET' && values ? new URLSearchParams(values).toString() : '',
    ...(body ? { contentType: 'application/json', body } : {}),
  });
  if (!response || !(response.body instanceof ArrayBuffer)
    || typeof response.contentType !== 'string' || response.contentType.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new Error('The plugin returned an invalid response.');
  }
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(response.body)); }
  catch { throw new Error('The plugin returned invalid report data.'); }
  if (response.status < 200 || response.status >= 300) {
    const error = new Error(value?.error?.message || (typeof value?.error === 'string' ? value.error : 'The report request failed. Please try again.'));
    error.status = response.status;
    throw error;
  }
  return value;
}

function parseTask(task) {
  if (task === null) return null;
  if (!task || typeof task.id !== 'string' || !['queued', 'running', 'complete', 'failed', 'interrupted'].includes(task.state)
    || ![task.keys_processed, task.keys_total, task.records_read].every(value => Number.isSafeInteger(value) && value >= 0)
    || (task.report_id !== null && typeof task.report_id !== 'string')
    || (task.error !== null && typeof task.error !== 'string')) throw new Error('The plugin returned an invalid task status.');
  if (!Number.isFinite(Date.parse(task.submitted_at)) || !task.bounds || !Number.isFinite(Date.parse(task.bounds.start)) || !Number.isFinite(Date.parse(task.bounds.end))) throw new Error('The plugin returned invalid task dates.');
  parseConfiguration(task.configuration);
  return task;
}

function parseConfiguration(configuration) {
  if (!configuration || typeof configuration.timezone !== 'string'
    || !configuration.window || !['relative', 'custom'].includes(configuration.window.kind)
    || (configuration.window.kind === 'custom' && (!isDate(configuration.window.start_date) || !isDate(configuration.window.end_date)))
    || !configuration.exclusions || !Array.isArray(configuration.exclusions.user_agent_patterns)
    || !Array.isArray(configuration.exclusions.models)
    || ![...configuration.exclusions.user_agent_patterns, ...configuration.exclusions.models].every(value => typeof value === 'string')) {
    throw new Error('The report contains an invalid configuration.');
  }
  try { new Intl.DateTimeFormat('en', { timeZone: configuration.timezone }); }
  catch { throw new Error('The report contains an unsupported timezone.'); }
  return configuration;
}

function parseReport(report) {
  if (!report || report.format_version !== 1 || typeof report.id !== 'string' || !Array.isArray(report.keys)
    || !report.bounds || !Number.isFinite(Date.parse(report.bounds.start)) || !Number.isFinite(Date.parse(report.bounds.end))
    || !Number.isFinite(Date.parse(report.created_at)) || !report.removed
    || ![report.removed.user_agent, report.removed.model].every(value => Number.isSafeInteger(value) && value >= 0)) {
    throw new Error('The plugin returned an unsupported report.');
  }
  const configuration = parseConfiguration(report.configuration);
  const charts = [];
  let total = 0;
  for (const key of report.keys) {
    if (!key || typeof key.id !== 'string' || typeof key.name !== 'string' || !Array.isArray(key.groups)) {
      throw new Error('The report contains invalid Key data.');
    }
    const chart = selectChoices(key.groups);
    if (!chart.total || !key.name) continue;
    total += chart.total;
    if (!Number.isSafeInteger(total)) throw new Error('The report request count exceeds the supported range.');
    charts.push({ id: key.id, name: key.name, chart });
  }
  return { ...report, configuration, charts, total };
}

function formatTime(value, timezone) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone, year: 'numeric', month: 'short', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).format(new Date(value));
}

function metadataRow(label, value) {
  const row = element('p');
  row.append(element('strong', '', label + ' '), element('span', '', value));
  return row;
}

async function showDialog(dialog) {
  if (dialog.open) return;
  // An opaque iframe can be taller than the visible host page. A fresh observer
  // supplies the currently visible rectangle without reading the parent document.
  const visible = await new Promise(resolve => {
    const observer = new IntersectionObserver(([entry]) => {
      observer.disconnect();
      resolve(entry.intersectionRect);
    });
    observer.observe(document.body);
  });
  if (dialog.open) return;
  const hostHeight = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--cp-plugin-viewport-height'));
  const available = Math.min(visible.height, hostHeight > 0 ? hostHeight : visible.height);
  dialog.style.maxHeight = Math.max(0, available - 32) + 'px';
  dialog.style.top = visible.top + 16 + 'px';
  dialog.showModal();
  dialog.style.top = visible.top + Math.max(16, (visible.height - dialog.getBoundingClientRect().height) / 2) + 'px';
}

async function showChart(key) {
  byId('chart-dialog-title').textContent = key.name;
  byId('chart-dialog-count').textContent = count(key.chart.total) + ' retained requests';
  byId('chart-dialog-content').replaceChildren(renderChart(key.name, key.chart));
  await showDialog(byId('chart-dialog'));
}

function busy() { return state.task && !terminalStates.has(state.task.state); }
function notice(id, error) {
  byId(id).textContent = error?.message || String(error);
  byId(id).hidden = false;
}
function navigate(view) {
  state.view = view;
  state.reportRequest++;
  for (const name of ['home', 'wizard', 'task', 'report']) byId(name + '-view').hidden = name !== view;
  byId(view + '-view').querySelector('h1').focus();
}
function updateActions() {
  byId('confirm-generate').disabled = !state.connected || state.submitting || busy();
  byId('confirm-generate').textContent = state.submitting ? 'Submitting…' : 'Confirm and generate';
  byId('back-to-edit').disabled = state.submitting;
  byId('busy-notice').hidden = !busy();
  byId('reuse').disabled = !state.report;
}
function button(label, action, className = '') {
  const node = element('button', className, label);
  node.type = 'button';
  node.addEventListener('click', action);
  return node;
}
function windowLabel(configuration) {
  return configuration.window.kind === 'relative' ? 'Last 7 × 24 hours' : configuration.window.start_date + ' through ' + configuration.window.end_date + ' (inclusive)';
}
function taskLabel(task) {
  return { queued: 'Waiting to start', running: 'Generating report', complete: task.report_id ? 'Report ready' : 'Completed — no report to save', failed: 'Generation failed', interrupted: 'Generation interrupted' }[task.state];
}
function progressLabel(task) {
  return task.keys_total || task.records_read ? count(task.keys_total) + ' Keys found · ' + count(task.records_read) + ' records read' : 'Preparing…';
}
function openTask() {
  state.taskId = state.task?.id || null;
  navigate('task');
  renderTask();
}
function renderTask() {
  const task = state.task;
  const home = byId('home-task');
  home.hidden = !task;
  home.replaceChildren();
  if (task) {
    const copy = element('div', 'generation-copy');
    copy.append(element('p', 'overline', busy() ? 'Current generation' : 'Latest generation'), element('h3', '', taskLabel(task)), element('p', 'muted small', 'Submitted ' + formatTime(task.submitted_at, browserTimezone)));
    if (busy()) copy.append(element('p', 'progress-copy', progressLabel(task)));
    home.dataset.state = task.state;
    home.append(copy, button(busy() ? 'View progress →' : 'View generation →', openTask, 'text-button'));
  }
  const panel = byId('task-status');
  const configurationOpen = panel.querySelector('details')?.open || false;
  panel.replaceChildren();
  if (!task) { panel.append(element('p', 'muted', 'No generation is available.')); return; }
  if (state.taskId && task.id !== state.taskId) {
    panel.append(element('h2', '', 'A newer generation is now current'), element('p', 'muted', 'Only the latest task is available. Completed reports remain in Saved reports.'), button('View current generation', openTask, 'primary'));
    return;
  }
  panel.dataset.state = task.state;
  panel.append(element('p', 'overline', busy() ? 'In progress' : 'Generation result'), element('h2', '', taskLabel(task)));
  if (busy()) panel.append(element('div', 'activity', ''));
  panel.append(element('p', 'progress-copy', progressLabel(task)), element('p', 'muted small', 'Submitted ' + formatTime(task.submitted_at, browserTimezone)));
  if (task.bounds) panel.append(element('p', 'task-window', formatTime(task.bounds.start, task.configuration.timezone) + ' — ' + formatTime(task.bounds.end, task.configuration.timezone) + ' · ' + task.configuration.timezone));
  if (task.state === 'queued') panel.append(element('p', 'muted', 'Waiting for the host to begin processing.'));
  if (busy()) panel.append(element('p', 'muted', 'You can leave this page. Generation continues while the host and plugin remain running.'));
  if (task.error) panel.append(element('p', 'error-copy', task.error));
  if (task.state === 'failed' || task.state === 'interrupted') {
    panel.append(element('p', 'muted', task.state === 'interrupted' ? 'The plugin restarted. No partial report was saved. A new generation scans from the beginning.' : 'No partial report was saved. A new generation scans from the beginning.'), button('Review and retry', () => startWizard(task.configuration, 'Configuration copied from the latest generation.'), 'primary'));
  } else if (task.state === 'complete') {
    if (task.report_id) panel.append(button('View report', () => loadReport(task.report_id), 'primary'));
    else panel.append(element('p', 'muted', 'No retained requests produced charts. No report was saved.'), button('Review configuration', () => startWizard(task.configuration, 'Configuration copied from the latest generation.')));
  }
  const details = element('details');
  details.open = configurationOpen;
  details.append(element('summary', '', 'Submitted configuration'));
  const summary = element('dl', 'summary');
  fillSummary(summary, task.configuration);
  details.append(summary);
  panel.append(details);
}
function acceptTask(task) {
  const previous = state.task;
  state.task = task;
  state.connected = true;
  byId('connection-notice').hidden = true;
  if (JSON.stringify(previous) !== JSON.stringify(task)) renderTask();
  updateActions();
  return task?.state === 'complete' && (previous?.id !== task.id || previous?.state !== 'complete');
}
async function refreshTask() {
  const sequence = ++state.taskRequest;
  const result = await request('GET', 'api/task');
  if (sequence !== state.taskRequest) return;
  if (acceptTask(parseTask(result?.task))) refreshReports();
}
async function pollTask() {
  try { await refreshTask(); }
  catch (error) {
    state.connected = false;
    updateActions();
    notice('connection-notice', 'Unable to update generation status. ' + error.message);
  } finally { pollTimer = window.setTimeout(pollTask, 2000); }
}
function renderReport(report) {
  state.report = report;
  byId('charts').replaceChildren();
  byId('report').hidden = !report || !report.charts.length;
  updateActions();
  if (!report || !report.charts.length) return;
  const timezone = report.configuration.timezone;
  byId('report-window').textContent = formatTime(report.bounds.start, timezone) + ' — ' + formatTime(report.bounds.end, timezone) + ' · ' + timezone;
  byId('report-created').textContent = 'Created ' + formatTime(report.created_at, timezone);
  byId('report-total').textContent = count(report.total) + ' retained requests';
  byId('key-count').textContent = count(report.charts.length) + ' Keys with data';
  const exclusions = report.configuration.exclusions;
  byId('report-metadata').replaceChildren(
    metadataRow('User agents:', (exclusions.user_agent_patterns.join(' | ') || 'None') + ' · ' + count(report.removed.user_agent) + ' requests removed'),
    metadataRow('Models:', (exclusions.models.join(', ') || 'None') + ' · ' + count(report.removed.model) + ' additional requests removed'),
  );
  byId('report-details').replaceChildren(metadataRow('Submitted period:', windowLabel(report.configuration)), metadataRow('Scope:', 'All host Keys. Effective start is included; effective end is excluded.'));
  for (const key of report.charts) {
    const card = element('article', 'chart-card');
    const heading = element('div', 'card-heading');
    const title = element('div');
    title.append(element('h3', '', key.name), element('p', 'muted', count(key.chart.total) + ' retained requests'));
    const enlarge = element('button', 'text-button enlarge', 'Enlarge ↗');
    enlarge.type = 'button';
    enlarge.setAttribute('aria-label', 'Enlarge chart for ' + key.name);
    enlarge.addEventListener('click', () => showChart(key).catch(error => notice('report-error', error)));
    heading.append(title, enlarge);
    const chartButton = element('button', 'chart-button');
    chartButton.type = 'button';
    chartButton.setAttribute('aria-label', 'Enlarge model usage chart for ' + key.name);
    chartButton.append(renderChart(key.name, key.chart));
    chartButton.addEventListener('click', () => showChart(key).catch(error => notice('report-error', error)));
    card.append(heading, chartButton);
    byId('charts').append(card);
  }
}

async function loadReport(id) {
  navigate('report');
  const sequence = ++state.reportRequest;
  renderReport(null);
  byId('report-window').textContent = '';
  byId('report-created').textContent = '';
  byId('report-error').hidden = true;
  byId('report-loading').hidden = false;
  try {
    const result = await request('GET', 'api/reports/detail', { id });
    if (sequence !== state.reportRequest || state.view !== 'report') return;
    const report = parseReport(result?.report);
    if (report.id !== id) throw new Error('The plugin returned the wrong report.');
    renderReport(report);
  } catch (error) {
    if (sequence === state.reportRequest && state.view === 'report') notice('report-error', error);
  } finally {
    if (sequence === state.reportRequest) byId('report-loading').hidden = true;
  }
}
async function refreshReports() {
  const sequence = ++state.reportsRequest;
  try {
    const result = await request('GET', 'api/reports');
    if (sequence !== state.reportsRequest) return;
    if (!Array.isArray(result?.reports) || result.reports.length > 20 || result.reports.some(report => !report || typeof report.id !== 'string' || !Number.isFinite(Date.parse(report.created_at)) || !Number.isSafeInteger(report.total_requests) || report.total_requests <= 0 || !Number.isSafeInteger(report.keys_count) || report.keys_count <= 0)) throw new Error('The plugin returned an invalid report list.');
    byId('list-error').hidden = true;
    const list = byId('reports-list');
    list.replaceChildren();
    if (!result.reports.length) {
      const empty = element('div', 'empty-state');
      empty.append(element('h3', '', 'No saved reports yet'), element('p', 'muted', 'Generate a report to see how your Keys use models and reasoning effort.'), button('New report', () => startWizard(), 'primary'));
      list.append(empty);
      return;
    }
    const heading = element('div', 'report-row list-columns');
    for (const text of ['Created', 'Retained requests', 'Keys with data', '']) heading.append(element('span', '', text));
    list.append(heading);
    for (const report of result.reports) {
      const row = element('article', 'report-row');
      row.append(element('h3', 'report-date', formatTime(report.created_at, browserTimezone)));
      const requests = element('p', 'row-value', count(report.total_requests));
      requests.append(element('span', 'mobile-label', ' requests'));
      const keys = element('p', 'row-value', count(report.keys_count));
      keys.append(element('span', 'mobile-label', ' Keys with data'));
      row.append(requests, keys, button('Open report →', () => loadReport(report.id), 'text-button'));
      list.append(row);
    }
  } catch (error) {
    if (sequence === state.reportsRequest) { notice('list-error', error); if (byId('reports-list').textContent === 'Loading saved reports…') byId('reports-list').replaceChildren(); }
  }
}
function isDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(value + 'T00:00:00Z');
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function updateWindowFields() {
  const custom = byId('window-kind').value === 'custom';
  byId('custom-dates').hidden = !custom;
  byId('start-date').required = custom;
  byId('end-date').required = custom;
}

function formConfiguration() {
  const timezone = byId('timezone').value.trim();
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }); }
  catch { throw new Error('Enter a supported IANA timezone, such as America/New_York or UTC.'); }
  const window = byId('window-kind').value === 'custom'
    ? { kind: 'custom', start_date: byId('start-date').value, end_date: byId('end-date').value }
    : { kind: 'relative' };
  if (window.kind === 'custom' && (!isDate(window.start_date) || !isDate(window.end_date) || window.start_date > window.end_date)) {
    throw new Error('Choose valid calendar dates with the end on or after the start.');
  }
  const lines = value => value.split(/\r?\n/).filter(line => line !== '');
  return {
    window, timezone,
    exclusions: {
      user_agent_patterns: lines(byId('user-agent-patterns').value),
      models: lines(byId('excluded-models').value),
    },
  };
}

function fillSummary(target, configuration) {
  const rows = [
    ['Time range', configuration.window.kind === 'relative' ? 'Last 7 × 24 hours, ending when confirmed' : configuration.window.start_date + ' through ' + configuration.window.end_date + ' (inclusive calendar dates)'],
    ['Timezone', configuration.timezone],
    ['Keys', 'All host Keys'],
    ['UA exclusions', configuration.exclusions.user_agent_patterns.join('\n') || 'None'],
    ['Model exclusions', configuration.exclusions.models.join('\n') || 'None'],
  ];
  target.replaceChildren();
  for (const [label, value] of rows) {
    target.append(element('dt', '', label), element('dd', '', value));
  }
}

function startWizard(configuration, source) {
  if (configuration) {
    byId('window-kind').value = configuration.window.kind;
    byId('timezone').value = configuration.timezone;
    byId('start-date').value = configuration.window.start_date || '';
    byId('end-date').value = configuration.window.end_date || '';
    byId('user-agent-patterns').value = configuration.exclusions.user_agent_patterns.join('\n');
    byId('excluded-models').value = configuration.exclusions.models.join('\n');
    updateWindowFields();
  }
  byId('draft-source').hidden = !source;
  byId('draft-source').textContent = source || '';
  setStep('configure');
  navigate('wizard');
  if (configuration) byId('window-kind').focus();
}
function setStep(step) {
  byId('configure-step').hidden = step !== 'configure';
  byId('review-step').hidden = step !== 'review';
  for (const name of ['configure', 'review']) {
    if (step === name) byId(name + '-marker').setAttribute('aria-current', 'step');
    else byId(name + '-marker').removeAttribute('aria-current');
  }
}
function reviewConfiguration() {
  byId('configure-error').hidden = true;
  if (!byId('configuration').reportValidity()) return;
  try {
    state.pendingConfiguration = formConfiguration();
    fillSummary(byId('confirmation-summary'), state.pendingConfiguration);
    byId('confirmation-error').hidden = true;
    setStep('review');
    byId('review-step').querySelector('h2').focus();
    updateActions();
  } catch (error) { notice('configure-error', error); }
}
byId('new-report').addEventListener('click', () => startWizard());
document.querySelectorAll('[data-home]').forEach(node => node.addEventListener('click', () => navigate('home')));
byId('continue-review').addEventListener('click', reviewConfiguration);
byId('configuration').addEventListener('submit', event => event.preventDefault());
byId('configuration').addEventListener('keydown', event => {
  if (event.key === 'Enter' && event.target instanceof HTMLInputElement) { event.preventDefault(); reviewConfiguration(); }
});
byId('back-to-edit').addEventListener('click', () => { setStep('configure'); byId('window-kind').focus(); });
byId('view-current').addEventListener('click', openTask);
byId('confirm-generate').addEventListener('click', async () => {
  if (!state.pendingConfiguration || state.submitting || busy() || !state.connected) return;
  state.submitting = true;
  updateActions();
  byId('confirmation-error').hidden = true;
  try {
    const result = await request('POST', 'api/tasks', state.pendingConfiguration);
    state.taskRequest++;
    acceptTask(parseTask(result?.task));
    state.pendingConfiguration = null;
    if (state.view === 'wizard') openTask();
  } catch (error) {
    notice('confirmation-error', error.status === 409 ? 'Another generation is already in progress. Your configuration is unchanged; submit again when it finishes.' : error);
    try { await refreshTask(); } catch { state.connected = false; notice('connection-notice', 'Unable to update generation status. Your configuration is unchanged.'); }
  } finally { state.submitting = false; updateActions(); }
});
byId('window-kind').addEventListener('change', updateWindowFields);
byId('refresh').addEventListener('click', async () => {
  byId('refresh').disabled = true;
  await refreshReports();
  try { await refreshTask(); } catch (error) { state.connected = false; updateActions(); notice('connection-notice', 'Unable to update generation status. ' + error.message); }
  byId('refresh').disabled = false;
});
byId('reuse').addEventListener('click', () => {
  if (state.report) startWizard(state.report.configuration, 'Configuration copied from the report created ' + formatTime(state.report.created_at, state.report.configuration.timezone) + '. Review it before generating a new report.');
});
document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => byId(button.dataset.close).close()));
byId('chart-dialog').addEventListener('click', event => {
  const dialog = byId('chart-dialog');
  if (event.target !== dialog) return;
  const rect = dialog.getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
});
window.addEventListener('pagehide', () => window.clearTimeout(pollTimer));
window.addEventListener('pageshow', event => { if (event.persisted) pollTask(); });
try { browserTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; }
catch { /* UTC remains the browser-timezone fallback. */ }
byId('timezone').value = browserTimezone;
byId('list-note').textContent = 'Latest 20 saved reports · Times in ' + browserTimezone;
const dateParts = Object.fromEntries(new Intl.DateTimeFormat('en', { year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date()).map(part => [part.type, part.value]));
const today = dateParts.year + '-' + dateParts.month + '-' + dateParts.day;
byId('start-date').value = today;
byId('end-date').value = today;
updateWindowFields();
updateActions();
refreshReports();
pollTask();
