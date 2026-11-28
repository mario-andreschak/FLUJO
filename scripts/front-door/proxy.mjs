// A small signed-in front door for a FLUJO that runs in Localhost mode, built the way
// docs/start-here/network.md ("Localhost behind your own signed-in front door") describes:
// HTTPS, a sign-in that sets an HttpOnly cookie, the dashboard on one port and the app view
// sandbox on another port of the same host name. Every request needs the sign-in. FLUJO gets
// its own loopback Host and Origin, never the front door's cookie, and learns the browser's
// address (X-Forwarded-Host/-Proto) only on the request that hands out the sandbox address.
import http from 'node:http';
import https from 'node:https';
import { randomBytes, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE = 'front_door_session';
export const SIGN_IN_PATH = '/front-door/sign-in';
export const SANDBOX_ADDRESS_PATH = '/api/mcp/app-sandbox';
const MAX_SIGN_IN_BODY = 4096;
// Never pass on a client's own claims about where it came from, or connection-level headers.
const DROPPED_REQUEST_HEADERS = new Set(['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto',
  'x-forwarded-port', 'x-real-ip', 'connection', 'keep-alive', 'proxy-connection', 'te', 'trailer', 'upgrade']);
const DROPPED_RESPONSE_HEADERS = new Set(['connection', 'keep-alive', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

export function parseCookies(header = '') {
  const cookies = new Map();
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index > 0) cookies.set(part.slice(0, index).trim(), part.slice(index + 1).trim());
  }
  return cookies;
}

/** The Cookie header without the front door's own session cookie, or undefined when nothing is left. */
export function withoutSessionCookie(header) {
  if (!header) return undefined;
  const kept = header.split(';').map(part => part.trim()).filter(part => part && !part.startsWith(`${SESSION_COOKIE}=`));
  return kept.length ? kept.join('; ') : undefined;
}

/** Only a path on this front door, never another site (`//host`, `/\host`) or a full address. */
export function safeNext(value) {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') && !value.startsWith('/\\')
    && !/[\r\n]/.test(value) ? value : '/';
}

const escapeHtml = value => value.replace(/[&<>"']/g, character => `&#${character.charCodeAt(0)};`);

function signInPage(next, failed) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in</title><style>body{font:16px system-ui;margin:0;padding:24px 16px}main{max-width:420px;margin:auto}
label,input,button{display:block;width:100%;box-sizing:border-box;margin:8px 0}input,button{min-height:44px;font:inherit}</style></head>
<body><main><h1>Sign in to FLUJO</h1>${failed ? '<p role="alert">That password is wrong. Try again.</p>' : ''}
<form method="post" action="${SIGN_IN_PATH}"><input type="hidden" name="next" value="${escapeHtml(next)}">
<label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required>
<button type="submit">Sign in</button></form></main></body></html>`;
}

function send(response, status, headers, body = '') {
  response.writeHead(status, { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers });
  response.end(body);
}

async function readBody(request, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error('The sign-in form is too large.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** The headers FLUJO receives for one browser request through the front door. */
export function upstreamRequestHeaders(headers, { upstream, publicOrigin, pathname, rewriteOrigin = true }) {
  const target = new URL(upstream);
  const result = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || DROPPED_REQUEST_HEADERS.has(name)) continue;
    result[name] = value;
  }
  result.host = target.host;
  if (rewriteOrigin && result.origin !== undefined) result.origin = target.origin;
  const cookie = withoutSessionCookie(headers.cookie);
  if (cookie) result.cookie = cookie; else delete result.cookie;
  if (pathname === SANDBOX_ADDRESS_PATH && publicOrigin) {
    const visible = new URL(publicOrigin);
    result['x-forwarded-host'] = visible.host;
    result['x-forwarded-proto'] = visible.protocol.slice(0, -1);
  }
  return result;
}

/** Response headers for the browser; FLUJO's own absolute redirects point back at the front door. */
export function browserResponseHeaders(headers, { upstream }) {
  const target = new URL(upstream);
  const result = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || DROPPED_RESPONSE_HEADERS.has(name)) continue;
    result[name] = value;
  }
  if (typeof result.location === 'string') {
    try {
      const location = new URL(result.location, target);
      if (location.origin === target.origin) result.location = location.pathname + location.search + location.hash;
    } catch { /* leave an unparsable location as FLUJO sent it */ }
  }
  return result;
}

function sameSecret(given, expected) {
  const left = Buffer.from(String(given ?? ''));
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Start the front door on 127.0.0.1; browsers reach both ports as `hostname`. It answers
 * "FLUJO did not answer" until `connect()` names FLUJO's own address (`upstream`) and its app
 * view sandbox listener (`sandboxUpstream`), so FLUJO can be started with the front door's
 * addresses already known.
 */
export async function startFrontDoor({ hostname, password, certificate, dashboardPort = 0, sandboxPort = 0, bindHost = '127.0.0.1' }) {
  const sessions = new Set();
  const stats = { signIns: 0, failedSignIns: 0, refused: 0, forwarded: 0, sandboxForwarded: 0, sandboxAddressRequests: 0 };
  const targets = { upstream: undefined, sandboxUpstream: undefined };
  const listeners = [];
  const expectedHost = (port) => `${hostname}:${port}`;
  const admit = (request, server) => request.headers.host === expectedHost(server.address().port);
  const signedIn = (request) => sessions.has(parseCookies(request.headers.cookie).get(SESSION_COOKIE));

  const forward = (request, response, url, { target, publicOrigin, rewriteOrigin }) => {
    if (!target) { send(response, 502, { 'content-type': 'text/plain; charset=utf-8' }, 'FLUJO did not answer.'); return; }
    const outgoing = http.request(new URL(url.pathname + url.search, target), {
      method: request.method,
      headers: upstreamRequestHeaders(request.headers, { upstream: target, publicOrigin, pathname: url.pathname, rewriteOrigin }),
    }, (answer) => {
      response.writeHead(answer.statusCode ?? 502, browserResponseHeaders(answer.headers, { upstream: target }));
      answer.pipe(response);
      response.once('close', () => answer.destroy());
    });
    outgoing.on('error', () => {
      if (!response.headersSent) send(response, 502, { 'content-type': 'text/plain; charset=utf-8' }, 'FLUJO did not answer.');
      else response.destroy();
    });
    request.once('aborted', () => outgoing.destroy());
    request.pipe(outgoing);
  };

  const forwardUpgrade = (request, socket, head, url, { target, rewriteOrigin }) => {
    if (!target) { socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); return; }
    const outgoing = http.request(new URL(url.pathname + url.search, target), {
      method: request.method,
      headers: { ...upstreamRequestHeaders(request.headers, { upstream: target, pathname: url.pathname, rewriteOrigin }),
        connection: 'Upgrade', upgrade: request.headers.upgrade ?? 'websocket' },
    });
    outgoing.on('upgrade', (answer, upstreamSocket, upstreamHead) => {
      const lines = [`HTTP/1.1 ${answer.statusCode} ${answer.statusMessage}`];
      for (let index = 0; index < answer.rawHeaders.length; index += 2) lines.push(`${answer.rawHeaders[index]}: ${answer.rawHeaders[index + 1]}`);
      socket.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (upstreamHead.length) socket.write(upstreamHead);
      if (head.length) upstreamSocket.write(head);
      upstreamSocket.pipe(socket).pipe(upstreamSocket);
      upstreamSocket.on('error', () => socket.destroy());
      socket.on('error', () => upstreamSocket.destroy());
    });
    outgoing.on('response', (answer) => { socket.end(`HTTP/1.1 ${answer.statusCode} ${answer.statusMessage}\r\n\r\n`); });
    outgoing.on('error', () => socket.destroy());
    outgoing.end();
  };

  const signIn = async (request, response, url) => {
    if (request.method === 'GET') {
      send(response, 200, { 'content-type': 'text/html; charset=utf-8' }, signInPage(safeNext(url.searchParams.get('next')), false));
      return;
    }
    if (request.method !== 'POST') { send(response, 405, { allow: 'GET, POST' }); return; }
    const form = new URLSearchParams(await readBody(request, MAX_SIGN_IN_BODY));
    const next = safeNext(form.get('next'));
    if (!sameSecret(form.get('password'), password)) {
      stats.failedSignIns += 1;
      send(response, 401, { 'content-type': 'text/html; charset=utf-8' }, signInPage(next, true));
      return;
    }
    const token = randomBytes(32).toString('base64url');
    sessions.add(token);
    stats.signIns += 1;
    send(response, 303, { location: next, 'set-cookie': `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/` });
  };

  const dashboard = https.createServer({ ...certificate }, async (request, response) => {
    try {
      if (!admit(request, dashboard)) { stats.refused += 1; send(response, 421, {}); return; }
      const url = new URL(request.url ?? '/', `https://${request.headers.host}`);
      if (url.pathname === SIGN_IN_PATH) { await signIn(request, response, url); return; }
      if (!signedIn(request)) {
        stats.refused += 1;
        const page = request.method === 'GET' && String(request.headers.accept ?? '').includes('text/html');
        if (page) send(response, 303, { location: `${SIGN_IN_PATH}?next=${encodeURIComponent(url.pathname + url.search)}` });
        else send(response, 401, { 'content-type': 'application/json' }, JSON.stringify({ error: 'Sign in first.' }));
        return;
      }
      stats.forwarded += 1;
      if (url.pathname === SANDBOX_ADDRESS_PATH) stats.sandboxAddressRequests += 1;
      forward(request, response, url, { target: targets.upstream, publicOrigin: url.origin, rewriteOrigin: true });
    } catch {
      if (!response.headersSent) send(response, 400, {});
      else response.destroy();
    }
  });

  // The sandbox listener checks its own per-app tokens; the browser's Origin and Referer pass unchanged.
  const sandbox = https.createServer({ ...certificate }, (request, response) => {
    if (!admit(request, sandbox) || !signedIn(request)) { stats.refused += 1; send(response, 403, {}); return; }
    stats.sandboxForwarded += 1;
    forward(request, response, new URL(request.url ?? '/', `https://${request.headers.host}`),
      { target: targets.sandboxUpstream, rewriteOrigin: false });
  });

  for (const [server, port, target, rewriteOrigin] of [[dashboard, dashboardPort, 'upstream', true], [sandbox, sandboxPort, 'sandboxUpstream', false]]) {
    server.on('upgrade', (request, socket, head) => {
      if (!admit(request, server) || !signedIn(request)) { stats.refused += 1; socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
      forwardUpgrade(request, socket, head, new URL(request.url ?? '/', `https://${request.headers.host}`), { target: targets[target], rewriteOrigin });
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, bindHost, resolve);
    });
    listeners.push(server);
  }
  return {
    dashboardOrigin: `https://${expectedHost(dashboard.address().port)}`,
    sandboxOrigin: `https://${expectedHost(sandbox.address().port)}`,
    stats,
    connect({ upstream, sandboxUpstream }) {
      targets.upstream = new URL(upstream).origin;
      targets.sandboxUpstream = new URL(sandboxUpstream).origin;
    },
    async close() {
      for (const server of listeners) {
        server.closeAllConnections();
        await new Promise((resolve) => { server.close(() => resolve()); });
      }
    },
  };
}

