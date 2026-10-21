import { request as httpRequest, type IncomingMessage, type OutgoingHttpHeaders, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Transform, pipeline } from 'node:stream';
import type { Runtime } from './config.js';
import { reply, securityHeaders } from './http.js';

const hopByHop = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade']);

function headersWithoutHopByHop(headers: IncomingMessage['headers']): OutgoingHttpHeaders {
  const excluded = new Set([...hopByHop, ...(headers.connection ?? '').toLowerCase().split(',').map(value => value.trim())]);
  return Object.fromEntries(Object.entries(headers).filter(([key]) => !excluded.has(key)));
}

export interface ProxyOptions {
  runtime: Runtime;
  ca?: Buffer;
  current: () => boolean;
  finished: () => void;
}

/** One owner per origin and runtime. Client identity/workspace headers never select an upstream. */
export function proxy(request: IncomingMessage, response: ServerResponse, options: ProxyOptions): void {
  const { runtime, current, finished } = options;
  const headers = headersWithoutHopByHop(request.headers);
  for (const name of Object.keys(headers)) {
    if (['authorization', 'cookie', 'host', 'forwarded', 'x-real-ip', 'proxy', 'expect'].includes(name)
        || name.startsWith('x-forwarded-') || name.startsWith('x-flujo-')
        || name.startsWith('x-user') || name.startsWith('x-tenant') || name.startsWith('x-owner')) delete headers[name];
  }
  headers.host = new URL(runtime.origin).host;
  headers.authorization = `Bearer ${runtime.credential}`;
  // Presentation only. The runtime never uses this hint for authentication.
  headers['x-flujo-controller-account'] = '1';
  // The browser origin is preserved for the runtime's existing same-origin gate.
  const upstreamUrl = new URL(runtime.upstream);
  const send = upstreamUrl.protocol === 'https:' ? httpsRequest : httpRequest;
  let complete = false;
  let upstreamResponse: IncomingMessage | undefined;
  let uploaded = 0;
  const maxBody = 64 * 1024 * 1024;
  const declaredLength = request.headers['content-length'];
  if (declaredLength && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > maxBody)) {
    response.setHeader('Connection', 'close');
    reply(response, 413, 'Request exceeds the 64 MiB upload limit.');
    finished();
    return;
  }
  if (!current()) { response.setHeader('Connection', 'close'); reply(response, 401, 'Sign in again.'); finished(); return; }

  const upstream = send({
    protocol: upstreamUrl.protocol, hostname: upstreamUrl.hostname.replace(/^\[|\]$/g, ''),
    port: upstreamUrl.port, path: request.url, method: request.method, headers,
    // No shared connection pool, redirects, ambient proxy or disabled TLS checks.
    agent: false, ...(options.ca ? { ca: options.ca } : {}),
  });
  const finish = () => {
    if (complete) return;
    complete = true;
    clearInterval(recheck);
    clearTimeout(deadline);
    request.unpipe(limit);
    limit.destroy();
    upstream.destroy();
    upstreamResponse?.destroy();
    finished();
  };
  const fail = (status: number, message: string) => {
    if (!response.headersSent) response.setHeader('Connection', 'close');
    reply(response, status, message); finish();
  };
  const isCurrent = () => { try { return current(); } catch { return false; } };
  const recheck = setInterval(() => {
    if (!isCurrent()) fail(401, 'Sign in again.');
  }, 1000);
  recheck.unref();
  // Streams reconnect through the current session; abandoned connections cannot live indefinitely.
  const deadline = setTimeout(() => fail(504, 'Connection expired. Reconnect to continue.'), 60 * 60 * 1000);
  deadline.unref();
  upstream.setTimeout(120_000, () => fail(504, 'Private runtime did not respond.'));
  upstream.on('error', () => { if (!complete) fail(502, 'Private runtime is unavailable.'); });
  upstream.on('response', incoming => {
    upstreamResponse = incoming;
    if (!isCurrent()) { fail(401, 'Sign in again.'); return; }
    const outgoing = headersWithoutHopByHop(incoming.headers);
    for (const name of Object.keys(outgoing)) {
      if (name === 'set-cookie' || name === 'clear-site-data' || name.startsWith('access-control-')) delete outgoing[name];
    }
    if (typeof outgoing.location === 'string') {
      try {
        const location = new URL(outgoing.location, runtime.origin);
        if (location.origin === runtime.upstream) {
          const target = new URL(runtime.origin);
          target.pathname = location.pathname; target.search = location.search; target.hash = location.hash;
          outgoing.location = target.href;
        } else if (location.protocol !== 'https:') { fail(502, 'Invalid runtime redirect.'); return; }
      } catch { fail(502, 'Invalid runtime redirect.'); return; }
    }
    for (const [key, value] of Object.entries(outgoing)) if (value !== undefined) response.setHeader(key, value);
    securityHeaders(response);
    response.writeHead(incoming.statusCode ?? 502);
    pipeline(incoming, response, () => finish());
  });
  const limit = new Transform({ transform(chunk: Buffer, _encoding, callback) {
    uploaded += chunk.length;
    if (uploaded > maxBody || !isCurrent()) {
      fail(uploaded > maxBody ? 413 : 401, uploaded > maxBody ? 'Upload limit exceeded.' : 'Sign in again.');
      callback(new Error('Request admission ended.'));
    } else callback(null, chunk);
  } });
  response.once('close', finish);
  request.once('aborted', finish);
  request.once('error', finish);
  limit.on('error', () => { if (!complete) fail(502, 'Request could not be forwarded.'); });
  // Do not pipeline the incoming request: its automatic destruction would reset
  // the browser socket before an upstream failure's 502/413 response is flushed.
  request.pipe(limit).pipe(upstream);
}
