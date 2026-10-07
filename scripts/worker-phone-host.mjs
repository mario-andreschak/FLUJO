import fs from 'node:fs';
import http from 'node:http';
import { timingSafeEqual, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream';

if (process.env.O_NATIVE_UI_OVERLAY_MANIFEST) {
  const { applyNativeUiOverlay } = await import('./native-ui-overlay.mjs');
  applyNativeUiOverlay(process.env.O_NATIVE_UI_OVERLAY_MANIFEST, process.env.O_NATIVE_UI_OVERLAY_SHA256);
}

// Operator-authenticated access to the unchanged native FLUJO server.
// Private configuration lives on the owned volume, never in source or URLs.
const config = JSON.parse(fs.readFileSync('/data/o-native-ui-proxy-v1/config.json', 'utf8'));
if (typeof config.password !== 'string' || config.password.length < 32 || typeof config.workerToken !== 'string'
  || config.workerToken.length < 32 || typeof config.workspace !== 'string' || !Array.isArray(config.originalCommand)
  || config.originalCommand.join('\0') !== ['node', '/app/scripts/launch-next.mjs', 'start', '-p', '4200', '-H', '::'].join('\0')) throw Error('Invalid native UI configuration');
const expected = Buffer.from('Basic ' + Buffer.from('operator:' + config.password).toString('base64'));
const authorized = req => {
  const actual = Buffer.from(req.headers.authorization ?? '');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
};
const sameOrigin = req => {
  const origin = req.headers.origin;
  if (origin !== undefined && origin !== 'https://' + req.headers.host) return false;
  return req.headers['sec-fetch-site'] !== 'cross-site' || ['GET', 'HEAD'].includes(req.method);
};
function refuse(res) {
  res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Private FLUJO worker", charset="UTF-8"', 'Cache-Control': 'no-store' });
  res.end('Use username operator and your existing private phone access token.');
}
const phoneSession = Object.freeze({ csrf: randomBytes(32).toString('hex'), voiceScopeKey: randomBytes(32).toString('hex'), nativeWorkspace: config.workspace });
const server = http.createServer((req, res) => {
  if (!authorized(req)) return refuse(res);
  if (!sameOrigin(req)) { res.writeHead(403, { 'Cache-Control': 'no-store' }); res.end('Same-origin access required.'); return; }
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname === '/phone/session') {
    if (req.method !== 'GET') { res.writeHead(405, { Allow: 'GET', 'Cache-Control': 'no-store' }); return res.end(); }
    if (req.headers['sec-fetch-site'] === 'cross-site') { res.writeHead(403, { 'Cache-Control': 'no-store' }); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    return res.end(JSON.stringify(phoneSession));
  }
  if (pathname.startsWith('/api/') && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    const actual = Buffer.from(req.headers['x-phone-csrf'] ?? '');
    const expectedCsrf = Buffer.from(phoneSession.csrf);
    if (actual.length !== expectedCsrf.length || !timingSafeEqual(actual, expectedCsrf) || req.headers['x-flujo-workspace'] !== config.workspace) {
      res.writeHead(403, { 'Cache-Control': 'no-store' }); return res.end('Phone session CSRF and workspace required.');
    }
  }
  const headers = { ...req.headers, host: 'localhost:4200', authorization: 'Bearer ' + config.workerToken,
    'x-flujo-workspace': config.workspace };
  if (headers.origin) headers.origin = 'http://localhost:4200';
  delete headers['proxy-authorization'];
  const upstream = http.request({ hostname: '127.0.0.1', port: 4200, path: req.url, method: req.method, headers }, reply => {
    const responseHeaders = { ...reply.headers, 'cache-control': 'no-store' };
    if (typeof responseHeaders.location === 'string' && responseHeaders.location.startsWith('http://localhost:4200/'))
      responseHeaders.location = 'https://' + req.headers.host + responseHeaders.location.slice('http://localhost:4200'.length);
    res.writeHead(reply.statusCode, responseHeaders);
    pipeline(reply, res, () => {});
  });
  upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end('Native FLUJO is starting. Reload shortly.'); });
  pipeline(req, upstream, () => {});
});
server.on('upgrade', (req, socket, head) => {
  if (!authorized(req)) { socket.end('HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm="Private FLUJO worker"\r\nConnection: close\r\n\r\n'); return; }
  if (!sameOrigin(req)) { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
  const headers = { ...req.headers, host: 'localhost:4200', authorization: 'Bearer ' + config.workerToken, 'x-flujo-workspace': config.workspace };
  if (headers.origin) headers.origin = 'http://localhost:4200';
  const upstream = http.request({ hostname: '127.0.0.1', port: 4200, path: req.url, method: req.method, headers });
  upstream.on('upgrade', (reply, peer, upstreamHead) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\n' + Object.entries(reply.headers).map(([k, v]) => k + ': ' + v).join('\r\n') + '\r\n\r\n');
    if (head.length) peer.write(head); if (upstreamHead.length) socket.write(upstreamHead);
    socket.pipe(peer); peer.pipe(socket);
  });
  upstream.on('response', reply => { socket.end('HTTP/1.1 ' + reply.statusCode + ' Refused\r\nConnection: close\r\n\r\n'); reply.resume(); });
  upstream.on('error', () => socket.destroy()); upstream.end();
});
const child = spawn(config.originalCommand[0], config.originalCommand.slice(1), { stdio: 'inherit', env: process.env });
child.on('error', () => process.exit(1));
child.on('exit', code => process.exit(code ?? 1));
server.on('error', () => { child.kill('SIGTERM'); process.exit(1); });
server.listen(4201, '::');
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { server.close(); child.kill(signal); });
