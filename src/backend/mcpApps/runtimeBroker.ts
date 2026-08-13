/**
 * Capability-scoped sidecar runtime broker for local stdio MCP Apps.
 *
 * A stdio server may own a browser UI listener on loopback (for example the
 * mcp-vscode gateway). That listener is unreachable from a remote browser and
 * must never be widened to 0.0.0.0 merely to make an App iframe work. FLUJO
 * instead gives an opted-in stdio child one short-lived registration
 * capability. The child proves that it controls the proposed loopback target,
 * then registers the small set of HTTP/WebSocket paths its App needs.
 *
 * The browser-facing side is served by the existing per-App sandbox origin.
 * Requests are selected by the host-derived origin key and can reach only the
 * registered loopback origin + route manifest. This is deliberately not an
 * arbitrary localhost proxy.
 */
import http from 'node:http';
import type { Duplex } from 'node:stream';
import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { deriveVerifiedMcpAppOriginKey } from '@/backend/mcpApps/appOrigin';
import { createLogger } from '@/utils/logger';
import { getCurrentWorkspace } from '@/utils/workspace';

const log = createLogger('backend/mcpApps/runtimeBroker');

export const MCP_APP_RUNTIME_REGISTER_PATH = '/_flujo/runtime/register';
export const MCP_APP_RUNTIME_PROOF_PATH = '/.well-known/flujo/mcp-app-runtime';
export const MCP_APP_RUNTIME_REGISTER_URL_ENV = 'FLUJO_MCP_APP_RUNTIME_REGISTER_URL';
export const MCP_APP_RUNTIME_REGISTER_TOKEN_ENV = 'FLUJO_MCP_APP_RUNTIME_REGISTER_TOKEN';
export const MCP_APP_RUNTIME_PROOF_CHALLENGE_HEADER = 'x-flujo-runtime-challenge';
export const MCP_APP_RUNTIME_PROOF_HEADER = 'x-flujo-runtime-proof';

const DEFAULT_SANDBOX_PORT = 4201;
const CAPABILITY_TTL_MS = 5 * 60_000;
const PROOF_TIMEOUT_MS = 5_000;
const MAX_REGISTRATION_BODY_BYTES = 32 * 1024;
const MAX_ROUTES = 12;
const MAX_ROUTE_PATH_LENGTH = 1024;
const MAX_RESOURCE_URI_LENGTH = 4096;
const MAX_CAPABILITIES = 256;
const MAX_REGISTRATIONS = 256;
const PROOF_MESSAGE_PREFIX = 'flujo-mcp-app-runtime-proof-v1:';

const ALLOWED_HTTP_METHODS = new Set([
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS',
]);

export type RuntimeRouteMatch = 'exact' | 'prefix';

export interface McpAppRuntimeRouteInput {
  path: string;
  match: RuntimeRouteMatch;
  httpMethods?: string[];
  websocket?: boolean;
}

interface McpAppRuntimeRoute {
  path: string;
  match: RuntimeRouteMatch;
  httpMethods: Set<string>;
  websocket: boolean;
}

interface RuntimeCapability {
  leaseId: string;
  tokenHash: string;
  workspace: string;
  serverName: string;
  expiresAt: number;
}

interface RuntimeRegistration {
  leaseId: string;
  workspace: string;
  serverName: string;
  resourceUri: string;
  originKey: string;
  targetOrigin: string;
  routes: McpAppRuntimeRoute[];
  registeredAt: number;
}

interface RuntimeBrokerState {
  capabilities: Map<string, RuntimeCapability>;
  registrations: Map<string, RuntimeRegistration>;
}

interface RuntimeRegistrationBody {
  version?: unknown;
  resourceUri?: unknown;
  targetOrigin?: unknown;
  routes?: unknown;
}

export interface RuntimeBrokerEnvironment {
  leaseId: string;
  env: Record<string, string>;
}

export interface RuntimeBrokerHttpOptions {
  originKey?: string;
  publicUrlForOriginKey(originKey: string): string | undefined;
}

const RUNTIME_BROKER_STATE_KEY = Symbol.for('flujo.mcpApps.runtimeBrokerState.v1');
const globalRegistry = globalThis as typeof globalThis & { [key: symbol]: unknown };

function state(): RuntimeBrokerState {
  let shared = globalRegistry[RUNTIME_BROKER_STATE_KEY] as RuntimeBrokerState | undefined;
  if (!shared) {
    shared = { capabilities: new Map(), registrations: new Map() };
    globalRegistry[RUNTIME_BROKER_STATE_KEY] = shared;
  }
  return shared;
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function serverKey(workspace: string, serverName: string): string {
  return `${workspace}\u0000${serverName}`;
}

function registrationUrl(): string {
  const configured = Number.parseInt(process.env.FLUJO_MCP_APP_SANDBOX_PORT ?? '', 10);
  const port = Number.isInteger(configured) && configured > 0 && configured < 65_536
    ? configured
    : DEFAULT_SANDBOX_PORT;
  return `http://127.0.0.1:${port}${MCP_APP_RUNTIME_REGISTER_PATH}`;
}

function purgeExpiredCapabilities(now = Date.now()): void {
  const runtimeState = state();
  for (const [hash, capability] of runtimeState.capabilities) {
    if (capability.expiresAt <= now) runtimeState.capabilities.delete(hash);
  }
  while (runtimeState.capabilities.size > MAX_CAPABILITIES) {
    const oldest = runtimeState.capabilities.keys().next().value as string | undefined;
    if (!oldest) break;
    runtimeState.capabilities.delete(oldest);
  }
}

function revokeWhere(predicate: (capability: RuntimeCapability) => boolean): void {
  const runtimeState = state();
  const leaseIds = new Set<string>();
  for (const [hash, capability] of runtimeState.capabilities) {
    if (!predicate(capability)) continue;
    leaseIds.add(capability.leaseId);
    runtimeState.capabilities.delete(hash);
  }
  for (const [originKey, registration] of runtimeState.registrations) {
    if (leaseIds.has(registration.leaseId)) runtimeState.registrations.delete(originKey);
  }
}

/**
 * Mint the environment handed to one managed stdio child.
 *
 * Issuing a replacement first revokes an older runtime for the same
 * workspace/server. Callers should use this only for the managed connection,
 * never for the throwaway "Test connection" process.
 */
export function issueMcpAppRuntimeBrokerEnvironment(
  serverName: string,
): RuntimeBrokerEnvironment {
  const workspace = getCurrentWorkspace();
  purgeExpiredCapabilities();
  revokeMcpAppRuntimeBrokerForServer(serverName, workspace);

  const token = randomBytes(32).toString('base64url');
  const leaseId = randomUUID();
  state().capabilities.set(tokenHash(token), {
    leaseId,
    tokenHash: tokenHash(token),
    workspace,
    serverName,
    expiresAt: Date.now() + CAPABILITY_TTL_MS,
  });

  return {
    leaseId,
    env: {
      [MCP_APP_RUNTIME_REGISTER_URL_ENV]: registrationUrl(),
      [MCP_APP_RUNTIME_REGISTER_TOKEN_ENV]: token,
    },
  };
}

/** Revoke one connection generation and every route it registered. */
export function revokeMcpAppRuntimeBrokerLease(leaseId: string | undefined): void {
  if (!leaseId) return;
  revokeWhere(capability => capability.leaseId === leaseId);
  const runtimeState = state();
  for (const [originKey, registration] of runtimeState.registrations) {
    if (registration.leaseId === leaseId) runtimeState.registrations.delete(originKey);
  }
}

/** Revoke the managed runtime for one workspace-scoped server name. */
export function revokeMcpAppRuntimeBrokerForServer(
  serverName: string,
  workspace = getCurrentWorkspace(),
): void {
  const key = serverKey(workspace, serverName);
  revokeWhere(capability => serverKey(capability.workspace, capability.serverName) === key);
  const runtimeState = state();
  for (const [originKey, registration] of runtimeState.registrations) {
    if (serverKey(registration.workspace, registration.serverName) === key) {
      runtimeState.registrations.delete(originKey);
    }
  }
}

function bearerToken(req: http.IncomingMessage): string | undefined {
  const value = req.headers.authorization;
  if (typeof value !== 'string' || !value.startsWith('Bearer ')) return undefined;
  const token = value.slice('Bearer '.length).trim();
  return token || undefined;
}

function capabilityForToken(token: string | undefined): RuntimeCapability | undefined {
  if (!token) return undefined;
  purgeExpiredCapabilities();
  return state().capabilities.get(tokenHash(token));
}

function parseLoopbackTarget(value: unknown): URL | undefined {
  if (typeof value !== 'string' || value.length > 2048) return undefined;
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== 'http:'
      || (parsed.hostname !== '127.0.0.1' && parsed.hostname !== '[::1]')
      || !parsed.port
      || parsed.username
      || parsed.password
      || parsed.pathname !== '/'
      || parsed.search
      || parsed.hash
    ) {
      return undefined;
    }
    const port = Number.parseInt(parsed.port, 10);
    return Number.isInteger(port) && port > 0 && port < 65_536 ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function normalizeRoutePath(value: unknown): string | undefined {
  if (
    typeof value !== 'string'
    || value.length < 2
    || value.length > MAX_ROUTE_PATH_LENGTH
    || !value.startsWith('/')
    || value.startsWith('//')
    || value.includes('\\')
    || /[\u0000-\u001f\u007f?#]/.test(value)
    || /%(?:2f|5c|00)/i.test(value)
  ) {
    return undefined;
  }
  let normalized: string;
  try {
    normalized = new URL(value, 'http://runtime.invalid').pathname;
  } catch {
    return undefined;
  }
  if (normalized !== value && normalized !== value.replace(/\/$/, '')) return undefined;
  normalized = normalized.replace(/\/$/, '');
  if (
    normalized === ''
    || normalized === '/sandbox.html'
    || normalized.startsWith('/_flujo')
    || normalized.startsWith('/.well-known/flujo')
  ) {
    return undefined;
  }
  return normalized;
}

function parseRoutes(value: unknown): McpAppRuntimeRoute[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ROUTES) return undefined;
  const routes: McpAppRuntimeRoute[] = [];
  const identities = new Set<string>();
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return undefined;
    const raw = candidate as Partial<McpAppRuntimeRouteInput>;
    const routePath = normalizeRoutePath(raw.path);
    if (!routePath || (raw.match !== 'exact' && raw.match !== 'prefix')) return undefined;
    const httpMethods = new Set<string>();
    if (raw.httpMethods !== undefined) {
      if (!Array.isArray(raw.httpMethods) || raw.httpMethods.length > ALLOWED_HTTP_METHODS.size) {
        return undefined;
      }
      for (const method of raw.httpMethods) {
        const normalized = typeof method === 'string' ? method.toUpperCase() : '';
        if (!ALLOWED_HTTP_METHODS.has(normalized)) return undefined;
        httpMethods.add(normalized);
      }
    }
    const websocket = raw.websocket === true;
    if (httpMethods.size === 0 && !websocket) return undefined;
    const identity = `${raw.match}\u0000${routePath}`;
    if (identities.has(identity)) return undefined;
    identities.add(identity);
    routes.push({ path: routePath, match: raw.match, httpMethods, websocket });
  }
  return routes;
}

function safeEqualBase64Url(actual: unknown, expected: string): boolean {
  if (typeof actual !== 'string') return false;
  try {
    const left = Buffer.from(actual, 'base64url');
    const right = Buffer.from(expected, 'base64url');
    return left.length === right.length && timingSafeEqual(left, right);
  } catch {
    return false;
  }
}

async function proveTargetControl(target: URL, token: string): Promise<boolean> {
  const challenge = randomBytes(32).toString('base64url');
  const expected = createHmac('sha256', token)
    .update(`${PROOF_MESSAGE_PREFIX}${challenge}`, 'utf8')
    .digest('base64url');

  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const request = http.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      method: 'GET',
      path: MCP_APP_RUNTIME_PROOF_PATH,
      headers: {
        [MCP_APP_RUNTIME_PROOF_CHALLENGE_HEADER]: challenge,
        accept: 'application/json',
        connection: 'close',
      },
      timeout: PROOF_TIMEOUT_MS,
    }, (response) => {
      const proof = response.headers[MCP_APP_RUNTIME_PROOF_HEADER];
      response.resume();
      response.once('end', () => finish(
        response.statusCode === 204 && safeEqualBase64Url(proof, expected),
      ));
    });
    request.once('timeout', () => {
      request.destroy();
      finish(false);
    });
    request.once('error', () => finish(false));
    request.end();
  });
}

function readJsonBody(req: http.IncomingMessage): Promise<RuntimeRegistrationBody> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.length;
      if (total > MAX_REGISTRATION_BODY_BYTES) {
        reject(new Error('registration body is too large'));
        req.destroy();
        return;
      }
      chunks.push(buffer);
    });
    req.once('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as RuntimeRegistrationBody);
      } catch {
        reject(new Error('registration body is not valid JSON'));
      }
    });
    req.once('error', reject);
  });
}

function json(res: http.ServerResponse, status: number, body: Record<string, unknown>): void {
  if (res.headersSent || res.destroyed) return;
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(JSON.stringify(body));
}

async function registerRuntime(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  options: RuntimeBrokerHttpOptions,
): Promise<void> {
  const token = bearerToken(req);
  const capability = capabilityForToken(token);
  if (!token || !capability) {
    json(res, 401, { error: 'invalid_or_expired_runtime_capability' });
    return;
  }

  let body: RuntimeRegistrationBody;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    json(res, 400, { error: error instanceof Error ? error.message : 'invalid registration' });
    return;
  }
  const resourceUri = typeof body.resourceUri === 'string' ? body.resourceUri.trim() : '';
  const target = parseLoopbackTarget(body.targetOrigin);
  const routes = parseRoutes(body.routes);
  if (
    body.version !== 1
    || !resourceUri
    || resourceUri.length > MAX_RESOURCE_URI_LENGTH
    || !target
    || !routes
  ) {
    json(res, 400, { error: 'invalid_runtime_registration' });
    return;
  }

  if (!await proveTargetControl(target, token)) {
    json(res, 403, { error: 'runtime_target_proof_failed' });
    return;
  }

  const originKey = deriveVerifiedMcpAppOriginKey({
    workspace: capability.workspace,
    serverName: capability.serverName,
    uri: resourceUri,
  });
  const publicUrl = options.publicUrlForOriginKey(originKey);
  if (!publicUrl) {
    json(res, 503, { error: 'runtime_public_origin_unavailable' });
    return;
  }
  let publicOrigin: string;
  try {
    publicOrigin = new URL(publicUrl).origin;
  } catch {
    json(res, 503, { error: 'runtime_public_origin_invalid' });
    return;
  }

  const runtimeState = state();
  for (const [key, registration] of runtimeState.registrations) {
    if (registration.leaseId === capability.leaseId) runtimeState.registrations.delete(key);
  }
  runtimeState.registrations.set(originKey, {
    leaseId: capability.leaseId,
    workspace: capability.workspace,
    serverName: capability.serverName,
    resourceUri,
    originKey,
    targetOrigin: target.origin,
    routes,
    registeredAt: Date.now(),
  });
  // Registration is single-use. The child may spawn a much larger runtime
  // process tree after this point; none of those descendants should inherit a
  // bearer that can replace the already-approved route manifest.
  runtimeState.capabilities.delete(tokenHash(token));
  while (runtimeState.registrations.size > MAX_REGISTRATIONS) {
    const oldest = runtimeState.registrations.keys().next().value as string | undefined;
    if (!oldest) break;
    runtimeState.registrations.delete(oldest);
  }

  json(res, 201, {
    version: 1,
    originKey,
    publicOrigin,
    publicBaseUrl: `${publicOrigin}/`,
  });
}

function routeMatches(route: McpAppRuntimeRoute, pathname: string): boolean {
  if (pathname === route.path) return true;
  return route.match === 'prefix' && pathname.startsWith(`${route.path}/`);
}

function findRegistrationRoute(
  originKey: string | undefined,
  pathname: string,
  kind: 'http' | 'websocket',
  method?: string,
): { registration: RuntimeRegistration; route: McpAppRuntimeRoute } | undefined {
  if (!originKey) return undefined;
  const registration = state().registrations.get(originKey);
  if (!registration) return undefined;
  const normalizedMethod = method?.toUpperCase() ?? '';
  const route = registration.routes.find(candidate =>
    routeMatches(candidate, pathname)
    && (kind === 'websocket'
      ? candidate.websocket
      : candidate.httpMethods.has(normalizedMethod)),
  );
  return route ? { registration, route } : undefined;
}

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function forwardedHeaders(
  headers: http.IncomingHttpHeaders,
  target: URL,
  websocket = false,
): http.OutgoingHttpHeaders {
  const outgoing: http.OutgoingHttpHeaders = {};
  const connectionTokens = new Set(
    String(headers.connection ?? '')
      .split(',')
      .map(value => value.trim().toLowerCase())
      .filter(Boolean),
  );
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (lower === 'host' || HOP_BY_HOP_HEADERS.has(lower) || connectionTokens.has(lower)) continue;
    if (value !== undefined) outgoing[name] = value;
  }
  outgoing.host = target.host;
  if (websocket) {
    outgoing.connection = 'Upgrade';
    outgoing.upgrade = headers.upgrade ?? 'websocket';
  }
  return outgoing;
}

function forwardHttp(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  registration: RuntimeRegistration,
): void {
  const target = new URL(registration.targetOrigin);
  const upstream = http.request({
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port,
    method: req.method,
    path: req.url,
    headers: forwardedHeaders(req.headers, target),
  }, (upstreamResponse) => {
    res.writeHead(
      upstreamResponse.statusCode ?? 502,
      upstreamResponse.statusMessage,
      upstreamResponse.headers,
    );
    upstreamResponse.pipe(res);
  });
  upstream.once('error', (error) => {
    log.warn(`MCP App runtime HTTP proxy failed for ${registration.serverName}`, error);
    if (!res.headersSent) json(res, 502, { error: 'runtime_gateway_unavailable' });
    else res.destroy(error);
  });
  req.once('aborted', () => upstream.destroy());
  req.pipe(upstream);
}

/**
 * Handle registration and registered HTTP routes. Returns true when this module
 * owns the request; the caller must not send another response in that case.
 */
export function handleMcpAppRuntimeHttpRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  options: RuntimeBrokerHttpOptions,
): boolean {
  const requestUrl = new URL(req.url || '/', 'http://runtime.invalid');
  if (requestUrl.pathname === MCP_APP_RUNTIME_REGISTER_PATH) {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      json(res, 405, { error: 'method_not_allowed' });
      return true;
    }
    void registerRuntime(req, res, options).catch((error) => {
      log.error('MCP App runtime registration failed', error);
      json(res, 500, { error: 'runtime_registration_failed' });
    });
    return true;
  }

  const match = findRegistrationRoute(
    options.originKey,
    requestUrl.pathname,
    'http',
    req.method,
  );
  if (!match) return false;
  forwardHttp(req, res, match.registration);
  return true;
}

function writeUpgradeResponse(
  socket: Duplex,
  response: http.IncomingMessage,
): void {
  const statusLine = `HTTP/${response.httpVersion} ${response.statusCode ?? 101} ${response.statusMessage ?? 'Switching Protocols'}\r\n`;
  let headers = '';
  for (let index = 0; index < response.rawHeaders.length; index += 2) {
    headers += `${response.rawHeaders[index]}: ${response.rawHeaders[index + 1]}\r\n`;
  }
  socket.write(`${statusLine}${headers}\r\n`);
}

/**
 * Proxy one registered WebSocket upgrade. Returns false when no manifest entry
 * authorizes the path, allowing the sandbox listener to destroy it fail-closed.
 */
export function handleMcpAppRuntimeUpgrade(
  req: http.IncomingMessage,
  socket: Duplex,
  head: Buffer,
  originKey: string | undefined,
): boolean {
  const requestUrl = new URL(req.url || '/', 'http://runtime.invalid');
  const match = findRegistrationRoute(originKey, requestUrl.pathname, 'websocket');
  if (!match) return false;

  const target = new URL(match.registration.targetOrigin);
  const upstream = http.request({
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port,
    method: req.method ?? 'GET',
    path: req.url,
    headers: forwardedHeaders(req.headers, target, true),
  });
  upstream.once('upgrade', (response, upstreamSocket, upstreamHead) => {
    writeUpgradeResponse(socket, response);
    if (head.length > 0) upstreamSocket.write(head);
    if (upstreamHead.length > 0) socket.write(upstreamHead);
    upstreamSocket.pipe(socket).pipe(upstreamSocket);
  });
  upstream.once('response', (response) => {
    writeUpgradeResponse(socket, response);
    response.pipe(socket);
    response.once('end', () => socket.end());
  });
  upstream.once('error', (error) => {
    log.warn(`MCP App runtime WebSocket proxy failed for ${match.registration.serverName}`, error);
    socket.destroy();
  });
  socket.once('error', () => upstream.destroy());
  socket.once('close', () => upstream.destroy());
  upstream.end();
  return true;
}

/** Test/diagnostic accessor. Contains no registration bearer tokens. */
export function getMcpAppRuntimeBrokerSnapshot(): {
  capabilities: Array<Omit<RuntimeCapability, 'tokenHash'>>;
  registrations: Array<Omit<RuntimeRegistration, 'routes'> & {
    routes: Array<{ path: string; match: RuntimeRouteMatch; httpMethods: string[]; websocket: boolean }>;
  }>;
} {
  purgeExpiredCapabilities();
  const runtimeState = state();
  return {
    capabilities: Array.from(runtimeState.capabilities.values()).map(({ tokenHash: _tokenHash, ...entry }) => ({
      ...entry,
    })),
    registrations: Array.from(runtimeState.registrations.values()).map(entry => ({
      ...entry,
      routes: entry.routes.map(route => ({
        path: route.path,
        match: route.match,
        httpMethods: Array.from(route.httpMethods),
        websocket: route.websocket,
      })),
    })),
  };
}

/** Tests can remove global state without learning any bearer credential. */
export function resetMcpAppRuntimeBrokerForTests(): void {
  delete globalRegistry[RUNTIME_BROKER_STATE_KEY];
}
