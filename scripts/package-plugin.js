import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

// Let the matching host CLI normalize the manifest and calculate package digests.
const source = resolve('dist/package-source');
rmSync(source, { recursive: true, force: true });
mkdirSync(source, { recursive: true });
const registration = JSON.parse(readFileSync('dist/plugin/management.json', 'utf8'));
const manifest = JSON.parse(readFileSync('plugin.json', 'utf8'));
const contentTypes = { html: 'text/html; charset=utf-8', js: 'application/javascript', css: 'text/css' };
for (const { path } of registration.resources) {
  const contentType = contentTypes[path.split('.').at(-1)];
  if (!contentType) throw new Error(`Unknown resource content type: ${path}`);
  manifest.resources[path] = contentType;
  copyFileSync(resolve('dist/plugin', path), resolve(source, path));
}
writeFileSync(resolve(source, 'plugin.json'), JSON.stringify(manifest, null, 2) + '\n');
const binary = resolve(process.env.REPORTS_BINARY || 'backend/target/release/codex-proxy-reports');
const target = process.env.REPORTS_TARGET || 'x86_64-unknown-linux-gnu';
const result = spawnSync(process.env.CPR_PLUGIN || 'cpr-plugin', [
  'package', '--manifest', resolve(source, 'plugin.json'), '--binary', binary,
  '--target', target, '--output-dir', resolve('dist/packages'),
], { stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status || 1);
