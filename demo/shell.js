// This simulator stays outside dist/plugin and follows the host's bridge v2.
const frame = document.querySelector('iframe');
// getRandomValues also works on plain HTTP subnet addresses, unlike randomUUID.
const session = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
const envelope = { target: 'codex-proxy-plugin-management', version: 2, channel: 'usage-reports-demo', session };
const matches = message => message && Object.entries(envelope).every(([key, value]) => message[key] === value);

function installBridge(initial) {
  let sequence = 0, theme = initial.theme.name;
  const pending = new Map();
  const matches = message => message && ['target', 'version', 'channel', 'session'].every(key => message[key] === initial[key]);
  function applyTheme(value) {
    theme = value.name;
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    for (const [key, token] of Object.entries(value.tokens)) document.documentElement.style.setProperty(key, token);
    window.dispatchEvent(new CustomEvent('codex-proxy-themechange', { detail: { theme } }));
  }
  function layout(height) { document.documentElement.style.setProperty('--cp-plugin-viewport-height', `${height}px`); }
  window.addEventListener('message', event => {
    if (event.source !== parent || event.origin !== initial.parentOrigin || !matches(event.data)) return;
    const message = event.data;
    if (message.type === 'theme') { applyTheme(message.payload); return; }
    if (message.type === 'layout') { layout(message.payload.viewportHeight); return; }
    if (message.type !== 'result') return;
    const operation = pending.get(message.id);
    if (!operation) return;
    clearTimeout(operation.timer); pending.delete(message.id);
    if (message.ok) operation.resolve(message.payload);
    else operation.reject(new Error(message.error));
  });
  const api = Object.freeze({
    version: 2, plugin: Object.freeze(initial.plugin), page: Object.freeze(initial.page),
    get theme() { return theme; },
    async request(input) {
      if (pending.size >= 8) throw new Error('Too many management requests.');
      let body;
      if (input.body == null) body = new ArrayBuffer(0);
      else if (typeof input.body === 'string') body = new TextEncoder().encode(input.body).buffer;
      else if (input.body instanceof ArrayBuffer) body = input.body.slice(0);
      else if (ArrayBuffer.isView(input.body)) body = new Uint8Array(input.body.buffer, input.body.byteOffset, input.body.byteLength).slice().buffer;
      else throw new TypeError('Unsupported request body.');
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('Management request timed out.')); }, 30000);
        pending.set(id, { resolve, reject, timer });
        parent.postMessage({ target: initial.target, version: initial.version, channel: initial.channel, session: initial.session, type: 'request', id, payload: {
          method: String(input.method || '').toUpperCase(), path: String(input.path || ''),
          query: String(input.query || ''), contentType: input.contentType, body,
        } }, initial.parentOrigin, [body]);
      });
    },
    resourceUrl(path) {
      if (!Object.hasOwn(initial.resourceUrls, path)) throw new Error('Unregistered resource.');
      return initial.resourceUrls[path];
    },
  });
  Object.defineProperty(window, 'codexProxyPlugin', { value: api, configurable: false, writable: false });
  applyTheme(initial.theme); layout(initial.viewportHeight);
  window.addEventListener('load', async () => {
    await document.fonts.ready;
    let previousHeight = 0;
    const reportHeight = () => {
      const height = Math.max(1, Math.ceil(document.body.getBoundingClientRect().height));
      if (height === previousHeight) return;
      previousHeight = height;
      parent.postMessage({ target: initial.target, version: initial.version, channel: initial.channel, session: initial.session, type: 'resize', id: ++sequence, payload: { height } }, initial.parentOrigin);
    };
    reportHeight();
    new ResizeObserver(reportHeight).observe(document.body, { box: 'border-box' });
  }, { once: true });
}

async function start() {
  const response = await fetch('/plugin.json');
  if (!response.ok) throw new Error('Could not load the built plugin resources.');
  const { registration, resources } = await response.json();
  const resourceUrls = Object.fromEntries(Object.entries(resources).map(([path, value]) => [path, `data:${value.contentType};base64,${value.body}`]));
  const page = registration.pages[0];
  const send = (type, payload, transfer = []) => frame.contentWindow.postMessage({ ...envelope, type, payload }, '*', transfer);
  let contentHeight = 0;
  const viewportHeight = () => Math.max(0, innerHeight - 48);
  const resizeFrame = () => { frame.style.height = `${Math.max(viewportHeight(), contentHeight)}px`; };
  const themePreference = matchMedia('(prefers-color-scheme: dark)');
  let theme = themePreference.matches ? 'dark' : 'light';
  const applyTheme = () => {
    theme = themePreference.matches ? 'dark' : 'light';
    document.documentElement.dataset.theme = theme;
    send('theme', { name: theme, tokens: {} });
  };
  themePreference.addEventListener('change', applyTheme);
  applyTheme();
  window.addEventListener('message', async event => {
    if (event.source !== frame.contentWindow || event.origin !== 'null' || !matches(event.data)) return;
    if (event.data.type === 'resize') {
      const height = event.data.payload?.height;
      if (Number.isSafeInteger(height) && height > 0 && height <= 1_000_000) { contentHeight = height; resizeFrame(); }
      return;
    }
    if (event.data.type !== 'request') return;
    const { id, payload } = event.data;
    const result = (value, transfer = []) => frame.contentWindow.postMessage({ ...envelope, type: 'result', id, ...value }, '*', transfer);
    try {
      const route = registration.routes.find(route => route.method === payload.method && route.path === payload.path);
      if (!route || !(payload.body instanceof ArrayBuffer) || payload.body.byteLength > 1024 * 1024
        || typeof payload.query !== 'string' || payload.query.startsWith('?') || payload.query.includes('#')
        || new TextEncoder().encode(payload.query).byteLength > 8192
        || (payload.body.byteLength && !route.request_content_types.includes(payload.contentType))) throw new Error('Invalid management request.');
      const response = await fetch(`/__demo/${payload.path}?${payload.query}`, {
        method: payload.method,
        ...(payload.body.byteLength ? { headers: { 'Content-Type': payload.contentType }, body: payload.body } : {}),
      });
      const body = await response.arrayBuffer();
      if (body.byteLength > 1024 * 1024) throw new Error('Management response exceeds the host limit.');
      result({ ok: true, payload: { status: response.status, contentType: response.headers.get('content-type'), body } }, [body]);
    } catch (error) { result({ ok: false, error: error.message }); }
  });
  let html = new TextDecoder().decode(Uint8Array.from(atob(resources[page.entry].body), letter => letter.charCodeAt(0)));
  html = html.replace(/(src|href)="(?:\.\/)?([^"?#]+)"/g, (_, attribute, path) => {
    if (!resourceUrls[path]) throw new Error(`Unregistered page resource: ${path}`);
    return `${attribute}="${resourceUrls[path]}"`;
  });
  const initial = { ...envelope, parentOrigin: location.origin, plugin: { name: 'huwei.usage-reports' }, page: { id: page.id, title: page.title }, theme: { name: theme, tokens: {} }, viewportHeight: viewportHeight(), resourceUrls };
  const csp = "default-src 'none'; script-src 'unsafe-inline' data:; style-src 'unsafe-inline' data:; img-src data:; font-src data:; connect-src 'none'; worker-src 'none'; child-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
  html = html.replace('<head>', `<head><meta http-equiv="Content-Security-Policy" content="${csp}"><style>html{overflow:hidden}body{min-height:var(--cp-plugin-viewport-height,0px)}</style><script>(${installBridge.toString()})(${JSON.stringify(initial).replace(/</g, '\\u003c')})</script>`);
  frame.srcdoc = html;
  window.addEventListener('resize', () => { resizeFrame(); send('layout', { viewportHeight: viewportHeight() }); });
}
start().catch(error => { document.querySelector('#error').hidden = false; document.querySelector('#error').textContent = error.message; });
