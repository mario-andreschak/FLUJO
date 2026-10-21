import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { createServer as createSecureServer, Server as SecureServer } from 'node:https';
import type { Duplex } from 'node:stream';
import { runtimeRevision, type ControllerConfig, type Runtime } from './config.js';
import { Ledger } from './ledger.js';
import { readPrivateFile } from './private-storage.js';
import { proxy } from './proxy.js';
import { ensureLocalTLS, LocalTLS } from './local-tls.js';
import { AppSandboxes } from './app-sandboxes.js';
import { accountPage, browserRequestAllowed, cookie, readPasswordForm, redirect, reply,
  securityHeaders, SESSION_COOKIE, sessionCookie } from './http.js';

export type ControllerServer = (Server | SecureServer) & { stopTLS: () => Promise<void> };

export async function createController(config: ControllerConfig, ledger: Ledger,
  connect?: (runtime: Runtime, channel?: 'application' | 'sandbox') => Duplex | undefined): Promise<ControllerServer> {
  // Identity and authority are local. Startup never discovers a remote issuer.
  ledger.reconcile(config);
  const runtimes = new Map(config.runtimes.map(runtime => [new URL(runtime.origin).host, runtime]));
  const authorities = new Map(config.runtimes.map(runtime => [runtime.id,
    runtime.caFile ? readPrivateFile(runtime.caFile) : undefined]));
  const inflight = new Map<string, number>();
  const loginRate = new Map<string, { count: number; reset: number }>();
  let pendingLogins = 0;
  let totalRequests = 0;
  const localTLS = config.tls ? new LocalTLS(config, await ensureLocalTLS(config)) : undefined;
  const sandboxes = new AppSandboxes();

  async function login(request: IncomingMessage, response: ServerResponse, runtime: Runtime): Promise<void> {
    const previous = loginRate.get(runtime.id);
    const rate = previous && previous.reset > Date.now() ? previous : { count: 0, reset: Date.now() + 60_000 };
    loginRate.set(runtime.id, rate);
    if (++rate.count > 20 || pendingLogins >= 2) { reply(response, 429, 'Please wait before signing in again.'); return; }
    pendingLogins++;
    try {
      let password = await readPasswordForm(request);
      if (password === null) { reply(response, 400, 'Invalid sign-in form.'); return; }
      const token = await ledger.authenticate(runtime, runtimeRevision(config, runtime), password, config.sessionSeconds);
      password = '';
      if (localTLS && !localTLS.valid()) {
        if (token) ledger.revokeSession(token);
        reply(response, 503, 'Local certificate renewal is required.'); return;
      }
      if (!token) {
        accountPage(response, false, 'Sign-in failed. Check your password and account access, then wait before retrying.', 401);
        return;
      }
      const previousToken = cookie(request, SESSION_COOKIE);
      if (previousToken) ledger.revokeSession(previousToken);
      response.setHeader('Set-Cookie', sessionCookie(SESSION_COOKIE, token, config.sessionSeconds));
      redirect(response, '/');
    } finally { pendingLogins--; }
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (localTLS && !localTLS.valid()) { reply(response, 503, 'Local certificate renewal is required.'); return; }
    if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(request.method ?? '')) {
      reply(response, 405, 'Method not allowed.'); return;
    }
    if (request.headers.host === undefined || Array.isArray(request.headers.host)) {
      reply(response, 400, 'Invalid host.'); return;
    }
    const target = request.url ?? '';
    // No absolute/network-path URLs or ambiguous backslash/encoded path separators.
    if (!target.startsWith('/') || target.startsWith('//') || /[\\\x00-\x20\x7f]/.test(target)
        || /%(?:2f|5c|00)/i.test(target.split('?')[0])) {
      reply(response, 400, 'Invalid request target.'); return;
    }
    const runtime = runtimes.get(request.headers.host);
    if (!runtime) {
      // Only an authenticated discovery response can create a one-use ticket.
      // An arbitrary wildcard hostname never selects an owner or API endpoint.
      const launch = localTLS && connect ? sandboxes.admit(request) : undefined;
      if (!launch) { reply(response, 421, 'Unknown or expired app launch. Reopen the app from FLUJO.'); return; }
      const count = inflight.get(launch.runtime.id) ?? 0;
      if (count >= 64 || totalRequests >= 512) { reply(response, 429, 'Too many active requests.'); return; }
      inflight.set(launch.runtime.id, count + 1); totalRequests++;
      proxy(request, response, { runtime: launch.runtime, connect: () => connect!(launch.runtime, 'sandbox'),
        sandbox: { origin: launch.origin, path: launch.path },
        current: launch.current,
        finished: () => { inflight.set(launch.runtime.id, (inflight.get(launch.runtime.id) ?? 1) - 1); totalRequests--; } });
      return;
    }
    const url = new URL(target, runtime.origin);
    if (url.origin !== runtime.origin || url.pathname !== target.split('?')[0]) {
      reply(response, 400, 'Invalid request path.'); return;
    }
    const revision = runtimeRevision(config, runtime);
    const sessionToken = cookie(request, SESSION_COOKIE);
    const session = ledger.session(sessionToken, runtime, revision);

    if (url.pathname === '/_account' && request.method === 'GET') { accountPage(response, !!session); return; }
    if (!browserRequestAllowed(request, runtime.origin)) {
      // An email/bookmark link can enter the sign-in page without admitting a
      // cross-site navigation to an arbitrary private API or effectful endpoint.
      if (request.method === 'GET' && request.headers['sec-fetch-mode'] === 'navigate') redirect(response, '/_account');
      else reply(response, 403, 'Use the exact FLUJO origin.');
      return;
    }
    if (url.pathname === '/_account/login' && request.method === 'POST') { await login(request, response, runtime); return; }
    if ((url.pathname === '/_account/logout' && request.method === 'POST')
        || (url.pathname === '/api/owner/session' && request.method === 'DELETE')) {
      if (session) ledger.revokeSession(sessionToken);
      response.setHeader('Set-Cookie', sessionCookie(SESSION_COOKIE, '', 0));
      response.setHeader('Clear-Site-Data', '"cache", "storage"');
      if (url.pathname.startsWith('/api/')) {
        securityHeaders(response);
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end('{"authenticated":false}');
      } else redirect(response, '/_account');
      return;
    }
    if (url.pathname.startsWith('/_account/')) { reply(response, 404, 'Not found.'); return; }
    if (url.pathname === '/owner/login') { redirect(response, '/_account'); return; }
    if (!session) {
      if (request.method === 'GET' && request.headers['sec-fetch-mode'] === 'navigate') redirect(response, '/_account');
      else reply(response, 401, 'Sign in at /_account.');
      return;
    }
    // The shared browser cannot mint or manipulate the runtime's separate owner cookies.
    if (url.pathname === '/api/owner/session' && request.method !== 'GET') {
      reply(response, 405, 'Manage this session at /_account.'); return;
    }
    if (runtime.localRuntime && url.pathname === '/api/mcp/app-sandbox' && (!localTLS || !connect)) {
      reply(response, 503, 'MCP Apps require local controller HTTPS and the private sandbox transport.'); return;
    }
    const count = inflight.get(runtime.id) ?? 0;
    if (count >= 64 || totalRequests >= 512) { reply(response, 429, 'Too many active requests.'); return; }
    inflight.set(runtime.id, count + 1);
    totalRequests++;
    try {
      const current = () => (!localTLS || localTLS.valid()) && !!ledger.session(sessionToken, runtime, revision);
      proxy(request, response, { runtime, ca: authorities.get(runtime.id), connect: connect ? () => connect(runtime) : undefined,
        current,
        ...(runtime.localRuntime && localTLS && url.pathname === '/api/mcp/app-sandbox' && request.method === 'GET'
          ? { rewriteJson: (value: unknown) => sandboxes.issue(runtime, value, current) } : {}),
        finished: () => { inflight.set(runtime.id, (inflight.get(runtime.id) ?? 1) - 1); totalRequests--; },
      });
    } catch (error) {
      inflight.set(runtime.id, (inflight.get(runtime.id) ?? 1) - 1); totalRequests--;
      throw error;
    }
  }

  const options = { maxHeaderSize: 16 * 1024, requestTimeout: 120_000, headersTimeout: 15_000 };
  const dispatch = (request: IncomingMessage, response: ServerResponse) => { void handle(request, response).catch(() => {
      // Never log URLs, passwords, cookies, configuration or upstream errors.
      reply(response, 503, 'Sign-in or private runtime is temporarily unavailable. Return to /_account to retry.');
    }); };
  const server = localTLS ? createSecureServer({ ...options, key: localTLS.material.key, cert: localTLS.material.cert,
    minVersion: 'TLSv1.2', handshakeTimeout: 10_000, sessionTimeout: 300 }, dispatch) : createServer(options, dispatch);
  if (localTLS && server instanceof SecureServer) {
    server.once('listening', () => localTLS.start(material => server.setSecureContext({ key: material.key, cert: material.cert, minVersion: 'TLSv1.2' })));
    server.once('close', () => { void localTLS.stop(); });
  }
  server.maxConnections = 1024;
  server.on('upgrade', (_request, socket) => { socket.end('HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\n\r\n'); });
  server.on('connect', (_request, socket) => { socket.destroy(); });
  server.on('clientError', (_error, socket) => { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); });
  return Object.assign(server, { stopTLS: () => localTLS?.stop() ?? Promise.resolve() });
}
