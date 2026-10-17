import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { createDemoService } from './service.js';

const { values } = parseArgs({ options: {
  host: { type: 'string', default: '127.0.0.1' }, port: { type: 'string', default: '4173' },
} });
const port = Number(values.port);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port.');
const service = createDemoService({ seed: true, now: process.env.REPORTS_DEMO_NOW ? () => new Date(process.env.REPORTS_DEMO_NOW) : undefined });
const directory = new URL('../dist/plugin/', import.meta.url);
const registration = JSON.parse(readFileSync(new URL('management.json', directory), 'utf8'));
const types = { html: 'text/html', js: 'application/javascript', css: 'text/css' };
const resources = Object.fromEntries(registration.resources.map(({ path }) => {
  if (!/^[\w.-]+$/.test(path)) throw new Error('Unexpected resource path.');
  return [path, { contentType: types[path.split('.').at(-1)], body: readFileSync(new URL(path, directory)).toString('base64') }];
}));
const assets = new Map([
  ['/', ['text/html', readFileSync(new URL('index.html', import.meta.url))]],
  ['/shell.js', ['application/javascript', readFileSync(new URL('shell.js', import.meta.url))]],
]);
const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://demo.invalid');
  const send = (status, type, body) => {
    response.writeHead(status, { 'Content-Type': type + '; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(body);
  };
  if (url.pathname.startsWith('/__demo/')) {
    const chunks = []; let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 1024 * 1024) return send(413, 'application/json', JSON.stringify({ error: { message: 'Request body too large.' } }));
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks);
    if (url.pathname === '/__demo/reset' && request.method === 'POST') {
      service.reset(body.length ? JSON.parse(body) : {});
      return send(200, 'application/json', '{}');
    }
    if (url.pathname === '/__demo/stats') return send(200, 'application/json', JSON.stringify(service.stats()));
    const result = service.handle(request.method, url.pathname.slice('/__demo/'.length), url.searchParams, body);
    return send(result.status, 'application/json', JSON.stringify(result.value));
  }
  if (request.method !== 'GET') return send(405, 'text/plain', 'GET required.');
  if (url.pathname === '/plugin.json') return send(200, 'application/json', JSON.stringify({ registration, resources }));
  const asset = assets.get(url.pathname);
  if (asset) return send(200, ...asset);
  send(404, 'text/plain', 'Not found.');
});
server.listen(port, values.host, () => console.log(`Usage reports synthetic demo: http://${values.host}:${port}/`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
