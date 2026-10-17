import { build } from 'esbuild';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const directory = resolve('dist/plugin');
rmSync(directory, { recursive: true, force: true });
mkdirSync(directory, { recursive: true });
await build({
  entryPoints: ['frontend/app.js'],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['es2022'],
  minify: true,
  outfile: resolve(directory, 'app.js'),
  legalComments: 'none',
});
copyFileSync('frontend/index.html', resolve(directory, 'index.html'));
const files = readdirSync(directory);
const html = readFileSync(resolve(directory, 'index.html'), 'utf8');
if (/type\s*=\s*["']module|modulepreload/i.test(html)) throw new Error('The host requires classic scripts.');
if (files.some((file) => !/^[\w.-]+$/.test(file) || !statSync(resolve(directory, file)).isFile())) {
  throw new Error('Unexpected plugin resource path.');
}
const total = files.reduce((size, file) => size + statSync(resolve(directory, file)).size, 0);
if (files.length > 128 || files.some((file) => statSync(resolve(directory, file)).size > 1024 * 1024) || total > 8 * 1024 * 1024) {
  throw new Error('The host permits at most 1 MiB per resource and 8 MiB in total.');
}
const script = readFileSync(resolve(directory, 'app.js'), 'utf8');
if (script.includes('/__demo/') || script.includes('successful_usage_groups') || script.includes('codex/visual-reference')) {
  throw new Error('Demo transport or synthetic fixtures leaked into the production bundle.');
}
const registration = {
  routes: [
    ['GET', 'api/task'], ['POST', 'api/tasks'], ['GET', 'api/reports'], ['GET', 'api/reports/detail'],
  ].map(([method, path]) => ({
    method, path,
    request_content_types: method === 'POST' ? ['application/json'] : [],
    response_content_types: ['application/json'],
  })),
  resources: files.map((path) => ({ path, public: false })),
  pages: [{ id: 'usage-reports', title: 'Usage reports', description: 'Request-count distribution by Client Key.', entry: 'index.html', icon: null }],
  callbacks: [],
};
writeFileSync(resolve(directory, 'management.json'), JSON.stringify(registration, null, 2) + '\n');
console.log(`Built ${files.length} private resources (${total.toLocaleString()} bytes); generated management.json.`);
