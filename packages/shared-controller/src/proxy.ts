import { request as httpRequest, type ClientRequest, type IncomingMessage, type OutgoingHttpHeaders, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Transform, pipeline, type Duplex } from 'node:stream';
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
  connect?: () => Duplex | undefined;
  current: () => boolean;
  finished: () => void;
  rewriteJson?: (value: unknown) => unknown;
  sandbox?: { origin: string; path: string };
}

/** One owner per origin and runtime. Client identity/workspace headers never select an upstream. */
export function proxy(request: IncomingMessage, response: ServerResponse, options: ProxyOptions): void {
  const { runtime, current, finished } = options;
  if (runtime.localRuntime && !options.connect) {
    reply(response, 503, 'Local runtime transport is unavailable.'); finished(); return;
  }
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
  if (options.rewriteJson) headers['accept-encoding'] = 'identity';
  if (options.sandbox) {
    // The sandbox channel is never the owner's application API. Forward only
    // presentation headers; no owner bearer, browser cookies or caller hints.
    for (const name of Object.keys(headers)) delete headers[name];
    headers.host = new URL(options.sandbox.origin).host;
    headers.referer = `${runtime.origin}/`;
    headers['accept-encoding'] = 'identity';
  }
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

  let upstream: ClientRequest;
  let connection: Duplex | undefined;
  try {
    if (runtime.localRuntime) {
      connection = options.connect?.();
      if (!connection) throw new Error('Managed transport unavailable.');
    }
    upstream = send({
      protocol: upstreamUrl.protocol,
      hostname: upstreamUrl.hostname.replace(/^\[|\]$/g, ''), port: upstreamUrl.port,
      path: options.sandbox?.path ?? request.url, method: request.method, headers,
      // Supplying createConnection without agent bypasses the default Agent.
      // Never fall back to a host network request when a managed pipe fails.
      ...(connection ? { createConnection: () => connection } : { agent: false }),
      ...(options.ca ? { ca: options.ca } : {}),
    });
  } catch {
    connection?.destroy(); reply(response, 503, 'Local runtime transport is unavailable.'); finished(); return;
  }
  const finish = () => {
    if (complete) return;
    complete = true;
    clearInterval(recheck);
    clearTimeout(deadline);
    clearTimeout(idle);
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
  // A stdio duplex is not a net.Socket. Bound HTTP inactivity directly rather
  // than invoking socket-only timeout methods on the managed transport.
  const idle = setTimeout(() => fail(504, 'Private runtime did not respond.'), 120_000); idle.unref();
  upstream.on('error', () => { if (!complete) fail(502, 'Private runtime is unavailable.'); });
  upstream.on('response', incoming => {
    if (complete) { incoming.destroy(); return; }
    upstreamResponse = incoming;
    if (!isCurrent()) { fail(401, 'Sign in again.'); return; }
    idle.refresh(); incoming.on('data', () => { if (!complete) idle.refresh(); });
    const outgoing = headersWithoutHopByHop(incoming.headers);
    for (const name of Object.keys(outgoing)) {
      if (name === 'set-cookie' || name === 'clear-site-data' || name.startsWith('access-control-')) delete outgoing[name];
    }
    if (options.sandbox && (incoming.statusCode !== 200
        || !incoming.headers['content-type']?.startsWith('text/html')
        || typeof incoming.headers['content-security-policy'] !== 'string'
        || incoming.headers['content-encoding'] !== undefined || outgoing.location !== undefined)) {
      fail(502, 'Private app sandbox is unavailable.'); return;
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
    if (options.rewriteJson && incoming.statusCode === 200) {
      if (!incoming.headers['content-type']?.startsWith('application/json') || incoming.headers['content-encoding'] !== undefined) {
        fail(502, 'Invalid private sandbox discovery.'); return;
      }
      let size = 0; const chunks: Buffer[] = [];
      incoming.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 64 * 1024) fail(502, 'Invalid private sandbox discovery.');
        else chunks.push(chunk);
      });
      incoming.on('error', () => { if (!complete) fail(502, 'Private sandbox discovery failed.'); });
      incoming.on('end', () => {
        if (complete) return;
        try {
          if (!isCurrent()) { fail(401, 'Sign in again.'); return; }
          const body = JSON.stringify(options.rewriteJson!(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
          securityHeaders(response);
          response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
          response.end(body); finish();
        } catch { fail(502, 'Private sandbox discovery is unavailable.'); }
      });
      return;
    }
    for (const [key, value] of Object.entries(outgoing)) if (value !== undefined) response.setHeader(key, value);
    securityHeaders(response);
    if (options.sandbox) {
      response.removeHeader('X-Frame-Options');
      // Preserve the runtime's content policy and narrow embedding to this one
      // owner. Local app hosts never admit the owner's session cookie/API.
      const policy = String(incoming.headers['content-security-policy']).split(';')
        .filter(directive => !/^\s*frame-ancestors(?:\s|$)/i.test(directive)).join(';');
      response.setHeader('Content-Security-Policy', `${policy}; frame-ancestors ${runtime.origin}`);
      response.setHeader('Origin-Agent-Cluster', '?1');
      let size = 0;
      incoming.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) fail(502, 'Private sandbox document is too large.');
      });
    }
    response.writeHead(incoming.statusCode ?? 502);
    pipeline(incoming, response, () => finish());
  });
  const limit = new Transform({ transform(chunk: Buffer, _encoding, callback) {
    if (complete) { callback(new Error('Request admission ended.')); return; }
    idle.refresh();
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
