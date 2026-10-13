import fs from 'node:fs';
import http from 'node:http';
import { timingSafeEqual, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream';
import { pathToFileURL } from 'node:url';

const ACTIONS = new Set([
  'native-turn', 'native-input', 'native-observe', 'native-played',
  'native-reset', 'native-result', 'native-result-receipt',
]);
const VOICE_AUTHORIZATION = 'x-flujo-avatar-authorization';
const header = value => typeof value === 'string' ? value : '';
function matches(actual, expected) {
  const left = Buffer.from(header(actual)), right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function validateConfig(config) {
  const secret = value => typeof value === 'string' && /^[\x21-\x7e]{32,8192}$/.test(value);
  if (!config || !secret(config.password) || !secret(config.workerToken)
      || typeof config.workspace !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(config.workspace)
      || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(config.workspace)
      || (config.voiceGrant !== undefined && !secret(config.voiceGrant))) {
    throw Error('Invalid native UI configuration');
  }
}

/** Only public session facts leave this server. Private worker capabilities stay here. */
export function createWorkerPhoneHost(config, { upstreamPort = 4200, workerOrigin = 'http://localhost:4200', publicOrigin } = {}) {
  validateConfig(config);
  const canonical = new URL(workerOrigin);
  if (canonical.origin !== workerOrigin || canonical.protocol !== 'http:' || canonical.hostname !== 'localhost'
      || !Number.isInteger(upstreamPort) || upstreamPort < 1 || upstreamPort > 65535) throw Error('Invalid native worker address');
  if (publicOrigin) {
    const origin = new URL(publicOrigin);
    if (origin.origin !== publicOrigin || (origin.protocol !== 'https:'
        && !(origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)))) {
      throw Error('Invalid phone origin');
    }
  }
  const expected = 'Basic ' + Buffer.from('operator:' + config.password).toString('base64');
  const authorized = req => matches(req.headers.authorization, expected);
  const sameOrigin = req => {
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== (publicOrigin ?? 'https://' + req.headers.host)) return false;
    return req.headers['sec-fetch-site'] !== 'cross-site' || ['GET', 'HEAD'].includes(req.method);
  };
  const session = Object.freeze({
    csrf: randomBytes(32).toString('hex'),
    voiceScopeKey: randomBytes(32).toString('hex'),
    nativeWorkspace: config.workspace,
  });
  const json = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff', ...headers });
    res.end(JSON.stringify(body));
  };
  const refuse = res => json(res, 401, { error: 'Use your private phone access token.' }, {
    'WWW-Authenticate': 'Basic realm="Private FLUJO worker", charset="UTF-8"',
  });
  const workspaceAllowed = (req, url) => {
    const selected = url.searchParams.getAll('workspace');
    const workspace = req.headers['x-flujo-workspace'];
    return selected.length <= 1 && selected.every(value => value === config.workspace)
      && (workspace === undefined || workspace === config.workspace);
  };
  const upstreamHeaders = (req, voice) => {
    const headers = { ...req.headers, host: canonical.host,
      authorization: 'Bearer ' + config.workerToken, 'x-flujo-workspace': config.workspace };
    delete headers['proxy-authorization'];
    delete headers[VOICE_AUTHORIZATION];
    delete headers['x-phone-csrf'];
    if (voice) {
      headers.origin = workerOrigin;
      headers[VOICE_AUTHORIZATION] = 'Bearer ' + config.voiceGrant;
    } else if (headers.origin) headers.origin = workerOrigin;
    return headers;
  };
  const server = http.createServer((req, res) => {
    if (!authorized(req)) return refuse(res);
    if (!sameOrigin(req)) return json(res, 403, { error: 'Same-origin access required.' });
    let url;
    try { url = new URL(req.url, workerOrigin); }
    catch { return json(res, 400, { error: 'Invalid phone request.' }); }
    const pathname = url.pathname;
    // The public phone edge must not turn loopback-only voice into an
    // alternative to the independently authorized remote voice handler.
    let canonicalPath;
    try { canonicalPath = new URL(decodeURIComponent(pathname), workerOrigin).pathname; }
    catch { return json(res, 400, { error: 'Invalid phone request.' }); }
    if (canonicalPath.startsWith('/api/avatar/')
        && !['/api/avatar/world', '/api/avatar/connections', '/api/avatar/work-model'].includes(canonicalPath)) {
      return json(res, 403, { error: 'Voice access is unavailable here. Reconnect to continue.' });
    }
    if (pathname === '/phone/session') {
      if (req.method !== 'GET') return json(res, 405, { error: 'Use GET.' }, { Allow: 'GET' });
      if (req.headers['sec-fetch-site'] === 'cross-site') return json(res, 403, { error: 'Same-origin access required.' });
      return json(res, 200, session);
    }
    const voice = pathname.startsWith('/phone/voice/');
    let path = pathname + url.search;
    if (voice) {
      const action = pathname.slice('/phone/voice/'.length);
      if (action !== 'availability' && !ACTIONS.has(action)) return json(res, 404, { error: 'Voice action unavailable.' });
      const method = action === 'availability' ? 'GET' : 'POST';
      if (req.method !== method) return json(res, 405, { error: 'Voice method unavailable.' }, { Allow: method });
      if (req.headers['sec-fetch-site'] === 'cross-site' || !workspaceAllowed(req, url)
          || !matches(req.headers['x-phone-csrf'], session.csrf)) {
        return json(res, 403, { error: 'Phone session access required.' });
      }
      if (!config.voiceGrant) return json(res, 503, { available: false, error: 'Voice is unavailable. You can still type.' });
      path = '/api/avatar/remote/' + action;
    } else if (pathname.startsWith('/api/') || pathname.startsWith('/v1/')) {
      if (!workspaceAllowed(req, url)) return json(res, 403, { error: 'Phone workspace access required.' });
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)
          && (!matches(req.headers['x-phone-csrf'], session.csrf) || req.headers['x-flujo-workspace'] !== config.workspace)) {
        return json(res, 403, { error: 'Phone session CSRF and workspace required.' });
      }
    } else if (pathname.startsWith('/phone/')) {
      return json(res, 404, { error: 'Phone route unavailable.' });
    }
    const upstream = http.request({ hostname: '127.0.0.1', port: upstreamPort,
      path, method: req.method, headers: upstreamHeaders(req, voice) }, reply => {
      const responseHeaders = { ...reply.headers, 'cache-control': 'no-store' };
      if (typeof responseHeaders.location === 'string' && responseHeaders.location.startsWith(workerOrigin + '/')) {
        responseHeaders.location = (publicOrigin ?? 'https://' + req.headers.host) + responseHeaders.location.slice(workerOrigin.length);
      }
      res.writeHead(reply.statusCode ?? 502, responseHeaders);
      pipeline(reply, res, () => {});
    });
    res.on('close', () => upstream.destroy());
    upstream.on('error', () => {
      if (!res.headersSent) return json(res, 502, { error: 'FLUJO is starting. Try again shortly.' });
      res.destroy();
    });
    pipeline(req, upstream, error => { if (error) upstream.destroy(); });
  });
  server.on('upgrade', (req, socket, head) => {
    const deny = status => socket.end('HTTP/1.1 ' + status + '\r\nConnection: close\r\n\r\n');
    if (!authorized(req)) return deny('401 Unauthorized');
    if (!sameOrigin(req)) return deny('403 Forbidden');
    if (req.method !== 'GET') return deny('405 Method Not Allowed');
    let url;
    try { url = new URL(req.url, workerOrigin); } catch { return deny('400 Bad Request'); }
    let canonicalPath;
    try { canonicalPath = new URL(decodeURIComponent(url.pathname), workerOrigin).pathname; }
    catch { return deny('400 Bad Request'); }
    if (!workspaceAllowed(req, url) || canonicalPath.startsWith('/phone/') || canonicalPath.startsWith('/api/avatar/')) return deny('403 Forbidden');
    const upstream = http.request({ hostname: '127.0.0.1', port: upstreamPort,
      path: url.pathname + url.search, method: req.method, headers: upstreamHeaders(req, false) });
    upstream.on('upgrade', (reply, peer, upstreamHead) => {
      socket.write('HTTP/1.1 101 Switching Protocols\r\n' + Object.entries(reply.headers).map(([key, value]) => key + ': ' + value).join('\r\n') + '\r\n\r\n');
      if (head.length) peer.write(head);
      if (upstreamHead.length) socket.write(upstreamHead);
      socket.pipe(peer); peer.pipe(socket);
      socket.on('close', () => peer.destroy()); peer.on('close', () => socket.destroy());
    });
    upstream.on('response', reply => { deny((reply.statusCode ?? 502) + ' Refused'); reply.resume(); });
    upstream.on('error', () => socket.destroy()); socket.on('close', () => upstream.destroy()); upstream.end();
  });
  return server;
}

async function start() {
  if (process.env.O_NATIVE_UI_OVERLAY_MANIFEST) {
    const { applyNativeUiOverlay } = await import('./native-ui-overlay.mjs');
    applyNativeUiOverlay(process.env.O_NATIVE_UI_OVERLAY_MANIFEST, process.env.O_NATIVE_UI_OVERLAY_SHA256);
  }
  // Preserve the mounted 3.46.2 worker's native launcher and private volume.
  const config = JSON.parse(fs.readFileSync('/data/o-native-ui-proxy-v1/config.json', 'utf8'));
  if (!Array.isArray(config.originalCommand)
      || config.originalCommand.join('\0') !== ['node', '/app/scripts/launch-next.mjs', 'start', '-p', '4200', '-H', '::'].join('\0')) {
    throw Error('Invalid native UI command');
  }
  const server = createWorkerPhoneHost(config);
  const child = spawn(config.originalCommand[0], config.originalCommand.slice(1), { stdio: 'inherit', env: process.env });
  child.on('error', () => process.exit(1));
  child.on('exit', code => process.exit(code ?? 1));
  server.on('error', () => { child.kill('SIGTERM'); process.exit(1); });
  server.listen(4201, '::');
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { server.close(); child.kill(signal); });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await start();
