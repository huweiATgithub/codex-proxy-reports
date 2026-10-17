import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const screenshotDirectory = '.local/demo';
mkdirSync(screenshotDirectory, { recursive: true });
const plugin = page => page.frameLocator('iframe');
const stats = async request => (await request.get('/__demo/stats')).json();
const views = ['home-view', 'wizard-view', 'task-view', 'report-view'];

async function expectView(ui, active) {
  for (const id of views) {
    if (id === active) await expect(ui.locator(`#${id}`)).toBeVisible();
    else await expect(ui.locator(`#${id}`)).toBeHidden();
  }
}

async function screenshot(page, ui, name) {
  await expect.poll(async () => {
    const height = await ui.locator('body').evaluate(element => element.getBoundingClientRect().height);
    return (await page.locator('iframe').boundingBox()).height >= Math.floor(height);
  }).toBe(true);
  await page.screenshot({ path: `${screenshotDirectory}/redesign-${name}.png`, fullPage: true });
}

async function open(page) {
  await page.goto('/');
  const ui = plugin(page);
  await expect(ui.locator('#new-report')).toBeEnabled();
  await expect(ui.locator('#reports-list')).not.toContainText('Loading saved reports');
  await expectView(ui, 'home-view');
  return ui;
}

async function configure(ui) {
  await ui.locator('#new-report').click();
  await expectView(ui, 'wizard-view');
  await expect(ui.locator('#configure-step')).toBeVisible();
  await expect(ui.locator('#review-step')).toBeHidden();
}

async function review(ui) {
  await ui.locator('#continue-review').click();
  await expectView(ui, 'wizard-view');
  await expect(ui.locator('#configure-step')).toBeHidden();
  await expect(ui.locator('#review-step')).toBeVisible();
}

async function submit(ui) {
  await ui.locator('#confirm-generate').click();
  await expectView(ui, 'task-view');
  await expect(ui.locator('#task-status')).toHaveAttribute('data-state', /queued|running/);
}

async function complete(ui, state = 'complete') {
  await expect(ui.locator('#task-status')).toHaveAttribute('data-state', state, { timeout: 12000 });
  await expectView(ui, 'task-view');
}

async function home(ui) {
  await ui.getByRole('button', { name: /Back to Reports/ }).click();
  await expectView(ui, 'home-view');
}

async function openResult(ui) {
  await ui.locator('#task-status').getByRole('button', { name: 'View report', exact: true }).click();
  await expectView(ui, 'report-view');
  await expect(ui.locator('#charts .chart-card')).toHaveCount(6);
}

async function enlarge(page, ui, name) {
  await ui.getByRole('button', { name: `Enlarge chart for ${name}`, exact: true }).click();
  await expect(ui.locator('#chart-dialog')).toBeVisible();
  const box = await ui.locator('#chart-dialog').boundingBox();
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(page.viewportSize().height + 1);
  await expect(ui.locator('#chart-dialog-title')).toHaveText(name);
  await expect(ui.locator('#chart-dialog svg')).toHaveCount(1);
  await ui.getByRole('button', { name: 'Close enlarged chart', exact: true }).click();
}

test.beforeEach(async ({ request }) => {
  await request.post('/__demo/reset', { data: {} });
});

test('landing shows the report library and current job without configuring or opening a report', async ({ page, request }) => {
  const reportReads = [];
  page.on('request', value => { if (new URL(value.url()).pathname === '/__demo/api/reports/detail') reportReads.push(value.url()); });
  const ui = await open(page);
  await expect(ui.locator('#configuration')).toBeHidden();
  await expect(ui.locator('#home-task')).toBeHidden();
  await expect(ui.locator('#charts svg:visible')).toHaveCount(0);
  await expect(ui.locator('#reports-list').getByRole('button', { name: /^Open report/ })).toHaveCount(0);
  expect(await stats(request)).toEqual({ submissions: 0, reports: 0 });
  await request.post('/__demo/reset', { data: { seed: true } });
  await page.reload();
  await expectView(ui, 'home-view');
  await expect(ui.locator('#reports-list').getByRole('button', { name: /^Open report/ })).toHaveCount(3);
  await expect(ui.locator('#home-task')).toBeVisible();
  await expect(ui.locator('#configuration')).toBeHidden();
  await expect(ui.locator('#charts svg:visible')).toHaveCount(0);
  expect(await stats(request)).toEqual({ submissions: 0, reports: 3 });
  expect(reportReads).toEqual([]);
  for (const width of [701, 720]) {
    await page.setViewportSize({ width, height: 1000 });
    const clipped = await ui.locator('#reports-list').evaluate(list => {
      const right = list.getBoundingClientRect().right;
      return [...list.querySelectorAll('article button')].some(button => button.getBoundingClientRect().right > right);
    });
    expect(clipped).toBe(false);
  }
});

test('configure, review, task and report views preserve drafts and render the accepted charts', async ({ page, request }) => {
  await request.post('/__demo/reset', { data: { seed: true } });
  const errors = [];
  const reportReads = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', value => { if (new URL(value.url()).pathname === '/__demo/api/reports/detail') reportReads.push(value.url()); });
  const ui = await open(page);
  await screenshot(page, ui, 'home');
  await configure(ui);
  await ui.locator('#window-kind').selectOption('custom');
  await ui.locator('#timezone').fill('UTC');
  await ui.locator('#start-date').fill('2026-10-10');
  await ui.locator('#end-date').fill('2026-10-16');
  await screenshot(page, ui, 'configure');
  expect((await stats(request)).submissions).toBe(0);
  await review(ui);
  await expect(ui.locator('#confirmation-summary')).toContainText('All host Keys');
  await expect(ui.locator('#confirmation-summary')).toContainText('UTC');
  await expect(ui.locator('#confirmation-summary')).toContainText('^prompt');
  await expect(ui.locator('#confirmation-summary')).toContainText('codex-auto-review');
  expect((await stats(request)).submissions).toBe(0);
  await ui.locator('#back-to-edit').click();
  await expect(ui.locator('#configure-step')).toBeVisible();
  await expect(ui.locator('#window-kind')).toHaveValue('custom');
  await expect(ui.locator('#start-date')).toHaveValue('2026-10-10');
  await expect(ui.locator('#timezone')).toHaveValue('UTC');
  await review(ui);
  await screenshot(page, ui, 'review');
  await submit(ui);
  await ui.locator('#task-status details > summary').click();
  await expect(ui.locator('#task-status')).toHaveAttribute('data-state', 'running', { timeout: 6000 });
  await expect(ui.locator('#task-status details')).toHaveAttribute('open', '');
  await ui.locator('#task-status details > summary').click();
  await screenshot(page, ui, 'progress');
  await home(ui);
  await ui.locator('#home-task').getByRole('button', { name: /View progress|View generation/ }).click();
  await expectView(ui, 'task-view');
  await complete(ui);
  await expect(ui.locator('#charts svg:visible')).toHaveCount(0);
  expect(reportReads).toEqual([]);
  await openResult(ui);
  await expect(ui.locator('#report-view input, #report-view textarea, #report-view select, #report-view form')).toHaveCount(0);
  await expect(ui.locator('#configuration')).toBeHidden();
  await expect(ui.locator('#report-window')).toContainText('UTC');
  await expect(ui.locator('#report-metadata')).toContainText('^prompt');
  await expect(ui.locator('#report-total')).toContainText('6,000');
  const charts = ui.locator('#charts');
  for (const name of ['Client A', 'Client B', 'Client C', 'Client D', 'Client E', 'Client F']) {
    await expect(charts.getByRole('heading', { name, exact: true })).toBeVisible();
  }
  expect(await charts.evaluate(element => getComputedStyle(element).gridTemplateColumns.split(' ').length)).toBe(3);
  await screenshot(page, ui, 'report');
  await enlarge(page, ui, 'Client A');
  await enlarge(page, ui, 'Client F');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(ui.locator('html')).toHaveAttribute('data-theme', 'dark');
  await screenshot(page, ui, 'dark');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await charts.evaluate(element => getComputedStyle(element).gridTemplateColumns.split(' ').length)).toBe(1);
  expect(await ui.locator('html').evaluate(element => element.scrollWidth <= innerWidth)).toBe(true);
  await enlarge(page, ui, 'Client F');
  await screenshot(page, ui, 'mobile');
  await page.setViewportSize({ width: 1560, height: 1080 });
  await home(ui);
  await ui.locator('#reports-list').getByRole('button', { name: /^Open report/ }).first().click();
  await expectView(ui, 'report-view');
  await expect(ui.locator('#charts .chart-card')).toHaveCount(6);
  await ui.locator('#reuse').click();
  await expectView(ui, 'wizard-view');
  await expect(ui.locator('#configure-step')).toBeVisible();
  await expect(ui.locator('#window-kind')).toHaveValue('custom');
  await expect(ui.locator('#timezone')).toHaveValue('UTC');
  await expect(ui.locator('#start-date')).toHaveValue('2026-10-10');
  expect(await stats(request)).toEqual({ submissions: 1, reports: 4 });
  await page.reload();
  await expectView(ui, 'home-view');
  await configure(ui);
  await expect(ui.locator('#window-kind')).toHaveValue('relative');
  await expect(ui.locator('#user-agent-patterns')).toHaveValue('^prompt');
  await expect(ui.locator('#excluded-models')).toHaveValue('codex-auto-review\ngpt-5.6-luna');
  expect((await stats(request)).submissions).toBe(1);
  expect(errors).toEqual([]);
});

test('another running task disables final submission while preserving the next report draft', async ({ page, request }) => {
  const task = {
    id: 'running-task', state: 'running', submitted_at: '2026-10-17T12:34:56Z',
    configuration: { window: { kind: 'relative' }, timezone: 'UTC', exclusions: { user_agent_patterns: ['^prompt'], models: ['codex-auto-review', 'gpt-5.6-luna'] } },
    bounds: { start: '2026-10-10T12:34:56Z', end: '2026-10-17T12:34:56Z' },
    keys_processed: 1, keys_total: 6, records_read: 100, report_id: null, error: null,
  };
  await page.route(/\/__demo\/api\/task(?:\?|$)/, route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ task }) }));
  const ui = await open(page);
  await expect(ui.locator('#home-task')).toBeVisible();
  await configure(ui);
  await ui.locator('#timezone').fill('Asia/Tokyo');
  await ui.locator('#user-agent-patterns').fill('^next-report');
  await review(ui);
  await expect(ui.locator('#confirm-generate')).toBeDisabled();
  await expect(ui.locator('#busy-notice')).toBeVisible();
  await ui.locator('#view-current').click();
  await expectView(ui, 'task-view');
  await home(ui);
  await configure(ui);
  await expect(ui.locator('#timezone')).toHaveValue('Asia/Tokyo');
  await expect(ui.locator('#user-agent-patterns')).toHaveValue('^next-report');
  await review(ui);
  task.state = 'complete';
  task.keys_processed = 6;
  task.records_read = 7050;
  await expect(ui.locator('#confirm-generate')).toBeEnabled({ timeout: 6000 });
  await expectView(ui, 'wizard-view');
  await expect(ui.locator('#confirmation-summary')).toContainText('Asia/Tokyo');
  await expect(ui.locator('#confirmation-summary')).toContainText('^next-report');
  expect((await stats(request)).submissions).toBe(0);
});

test('an empty result creates no report and keeps previous saved reports available through the library', async ({ page, request }) => {
  await request.post('/__demo/reset', { data: { seed: true, empty: true } });
  const ui = await open(page);
  await configure(ui);
  await review(ui);
  await submit(ui);
  await complete(ui);
  await expect(ui.locator('#task-status')).toContainText(/no retained requests/i);
  await expect(ui.locator('#task-status').getByRole('button', { name: 'View report', exact: true })).toHaveCount(0);
  await expect(ui.locator('#charts svg:visible')).toHaveCount(0);
  expect(await stats(request)).toEqual({ submissions: 1, reports: 3 });
  await home(ui);
  await expect(ui.locator('#reports-list').getByRole('button', { name: /^Open report/ })).toHaveCount(3);
  await ui.locator('#reports-list').getByRole('button', { name: /^Open report/ }).first().click();
  await expectView(ui, 'report-view');
  await expect(ui.locator('#charts .chart-card')).toHaveCount(6);
});

test('a failed generation exposes its error and returns to the submitted configuration without retrying automatically', async ({ page, request }) => {
  await request.post('/__demo/reset', { data: { outcome: 'failed' } });
  const ui = await open(page);
  await configure(ui);
  await ui.locator('#timezone').fill('Asia/Tokyo');
  await ui.locator('#user-agent-patterns').fill('^retry-config');
  await review(ui);
  await submit(ui);
  await complete(ui, 'failed');
  await expect(ui.locator('#task-status')).toContainText('The host history query failed');
  await expect(ui.locator('#charts svg:visible')).toHaveCount(0);
  await ui.locator('#task-status').getByRole('button', { name: /Review and retry|Review configuration/ }).click();
  await expectView(ui, 'wizard-view');
  await expect(ui.locator('#configure-step')).toBeVisible();
  await expect(ui.locator('#timezone')).toHaveValue('Asia/Tokyo');
  await expect(ui.locator('#user-agent-patterns')).toHaveValue('^retry-config');
  expect(await stats(request)).toEqual({ submissions: 1, reports: 0 });
});
