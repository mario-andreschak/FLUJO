#!/usr/bin/env node
// A local OAuth 2.1 authorization server plus an MCP server protected by it, built
// from the official MCP SDK's own server-side sign-in handlers (authorize, token,
// register, revoke and the bearer check). It follows the MCP 2026-07-28
// authorization rules: protected resource metadata, S256 PKCE, resource
// indicators, dynamic client registration, client ID metadata documents, issuer
// in the redirect, rotating refresh tokens, revocation and step-up scopes.
//
// Jest and the packaged checks start it as a child process:
//   node scripts/mcp-oauth-reference-server.mjs [--module-root DIR]... [--host H] [--public-host H]
//        [--client-metadata FILE]
// It prints one JSON line with its addresses. The control routes on the
// authorization server let a test expire tokens, revoke grants, make the token
// endpoint fail for a while and read a log that never contains token values.
// It stops when its standard input closes, so it never outlives its parent.
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const READ_SCOPE = 'notes:read';
export const WRITE_SCOPE = 'notes:write';

/** Load the MCP SDK (and its express) from the first folder that has it installed. */
export function loadSdk(moduleRoots) {
  for (const root of moduleRoots) {
    let load;
    try {
      load = createRequire(path.join(root, 'package.json'));
      load.resolve('@modelcontextprotocol/sdk/server/mcp.js');
    } catch { continue; }
    const sdk = (subpath) => load(`@modelcontextprotocol/sdk/${subpath}`);
    const sdkLoad = createRequire(load.resolve('@modelcontextprotocol/sdk/server/mcp.js'));
    return {
      express: sdkLoad('express'),
      authorizationHandler: sdk('server/auth/handlers/authorize.js').authorizationHandler,
      tokenHandler: sdk('server/auth/handlers/token.js').tokenHandler,
      clientRegistrationHandler: sdk('server/auth/handlers/register.js').clientRegistrationHandler,
      revocationHandler: sdk('server/auth/handlers/revoke.js').revocationHandler,
      requireBearerAuth: sdk('server/auth/middleware/bearerAuth.js').requireBearerAuth,
      errors: sdk('server/auth/errors.js'),
      McpServer: sdk('server/mcp.js').McpServer,
      StreamableHTTPServerTransport: sdk('server/streamableHttp.js').StreamableHTTPServerTransport,
    };
  }
  throw new Error(`The MCP SDK was not found in: ${moduleRoots.join(', ')}. Run "npm ci" or point --module-root at an installed FLUJO.`);
}

const token = (prefix) => `${prefix}-${randomBytes(24).toString('base64url')}`;

function readClientMetadataDocument(file) {
  const document = JSON.parse(readFileSync(file, 'utf8'));
  if (typeof document.client_id !== 'string' || !Array.isArray(document.redirect_uris)) {
    throw new Error(`${file} is not a client ID metadata document.`);
  }
  return document;
}

/**
 * Start both servers. Returns their addresses and a close function. `publicHost`
 * is the host name written into every address (for a container it is the host
 * the container can reach); `host` is the interface both servers listen on.
 */
export async function startReferenceServers({
  moduleRoots = [repositoryRoot], host = '127.0.0.1', publicHost = host,
  clientMetadataFile = path.join(repositoryRoot, 'githubpages', 'oauth', 'client-metadata.json'),
} = {}) {
  const sdk = loadSdk(moduleRoots);
  const { express, errors } = sdk;
  const cimd = readClientMetadataDocument(clientMetadataFile);

  const listen = (app) => new Promise((resolve, reject) => {
    const server = app.listen(0, host);
    server.once('listening', () => resolve(server));
    server.once('error', reject);
  });
  const authorizationApp = express();
  const resourceApp = express();
  const authorizationServer = await listen(authorizationApp);
  const resourceServer = await listen(resourceApp);
  const issuer = `http://${publicHost}:${authorizationServer.address().port}`;
  const resourceOrigin = `http://${publicHost}:${resourceServer.address().port}`;
  const resource = `${resourceOrigin}/mcp`;
  const resourceMetadataUrl = `${resourceOrigin}/.well-known/oauth-protected-resource/mcp`;

  const settings = { accessTokenSeconds: 3600 };
  let failures = { count: 0, status: 503 };
  const clients = new Map();
  const codes = new Map();
  const grants = new Map();
  const accessTokens = new Map();
  const refreshTokens = new Map();
  const log = [];
  const record = (entry) => log.push({ at: new Date().toISOString(), ...entry });

  const clientsStore = {
    async getClient(clientId) {
      if (clients.has(clientId)) return clients.get(clientId);
      if (clientId !== cimd.client_id) return undefined;
      record({ kind: 'client-metadata-document', clientId });
      return {
        client_id: cimd.client_id, client_name: cimd.client_name, redirect_uris: cimd.redirect_uris,
        grant_types: cimd.grant_types, response_types: cimd.response_types, token_endpoint_auth_method: 'none',
      };
    },
    async registerClient(client) {
      clients.set(client.client_id, client);
      return client;
    },
  };

  const grantFor = (grantId) => grants.get(grantId);
  const issueTokens = (grant, scopes = grant.scopes) => {
    const access = token('access');
    const refresh = token('refresh');
    accessTokens.set(access, { grantId: grant.id, scopes, expiresAt: Date.now() + settings.accessTokenSeconds * 1000 });
    refreshTokens.set(refresh, { grantId: grant.id, used: false });
    return { access_token: access, token_type: 'bearer', expires_in: settings.accessTokenSeconds, refresh_token: refresh, scope: scopes.join(' ') };
  };
  const requireResource = (value) => {
    if (value?.href !== resource) {
      throw new errors.InvalidTargetError(`The resource must be ${resource}.`);
    }
  };

  const provider = {
    clientsStore,
    async authorize(client, params, res) {
      record({
        kind: 'authorize', clientId: client.client_id, scope: params.scopes?.join(' ') ?? null,
        resource: params.resource?.href ?? null, redirectUri: params.redirectUri, hasState: Boolean(params.state),
      });
      const target = new URL(params.redirectUri);
      if (params.resource?.href !== resource) {
        target.searchParams.set('error', 'invalid_target');
        target.searchParams.set('error_description', `The resource must be ${resource}.`);
      } else {
        const code = token('code');
        codes.set(code, {
          clientId: client.client_id, challenge: params.codeChallenge, redirectUri: params.redirectUri,
          scopes: params.scopes ?? [], resource: params.resource.href, expiresAt: Date.now() + 60_000,
        });
        target.searchParams.set('code', code);
      }
      if (params.state) target.searchParams.set('state', params.state);
      target.searchParams.set('iss', issuer);
      res.redirect(302, target.href);
    },
    async challengeForAuthorizationCode(client, code) {
      const entry = codes.get(code);
      if (!entry || entry.clientId !== client.client_id) throw new errors.InvalidGrantError('Unknown authorization code.');
      return entry.challenge;
    },
    async exchangeAuthorizationCode(client, code, _verifier, redirectUri, requestedResource) {
      const entry = codes.get(code);
      codes.delete(code);
      if (!entry || entry.clientId !== client.client_id || entry.expiresAt < Date.now()) {
        throw new errors.InvalidGrantError('Unknown, used or expired authorization code.');
      }
      if (redirectUri !== entry.redirectUri) throw new errors.InvalidGrantError('redirect_uri does not match the authorization request.');
      requireResource(requestedResource);
      const grant = { id: token('grant'), clientId: client.client_id, scopes: entry.scopes, resource: entry.resource, revoked: false, refreshes: 0 };
      grants.set(grant.id, grant);
      record({ kind: 'token', grantType: 'authorization_code', clientId: client.client_id, resource: requestedResource.href, scope: grant.scopes.join(' ') });
      return issueTokens(grant);
    },
    async exchangeRefreshToken(client, refreshToken, scopes, requestedResource) {
      const entry = refreshTokens.get(refreshToken);
      const grant = entry && grantFor(entry.grantId);
      if (!grant || grant.clientId !== client.client_id) {
        record({ kind: 'token', grantType: 'refresh_token', clientId: client.client_id, outcome: 'unknown' });
        throw new errors.InvalidGrantError('Unknown refresh token.');
      }
      if (grant.revoked) {
        record({ kind: 'token', grantType: 'refresh_token', clientId: client.client_id, outcome: 'revoked' });
        throw new errors.InvalidGrantError('This grant was revoked.');
      }
      if (entry.used) {
        // OAuth 2.1 refresh token rotation: a reused refresh token ends the whole grant.
        grant.revoked = true;
        record({ kind: 'token', grantType: 'refresh_token', clientId: client.client_id, outcome: 'reused' });
        throw new errors.InvalidGrantError('This refresh token was already used.');
      }
      requireResource(requestedResource);
      if (scopes?.some((scope) => !grant.scopes.includes(scope))) throw new errors.InvalidScopeError('A refresh cannot add scopes.');
      entry.used = true;
      grant.refreshes += 1;
      record({ kind: 'token', grantType: 'refresh_token', clientId: client.client_id, resource: requestedResource.href, outcome: 'issued' });
      return issueTokens(grant, scopes?.length ? scopes : grant.scopes);
    },
    async verifyAccessToken(value) {
      const entry = accessTokens.get(value);
      const grant = entry && grantFor(entry.grantId);
      if (!grant) throw new errors.InvalidTokenError('Unknown access token.');
      if (grant.revoked) throw new errors.InvalidTokenError('This grant was revoked.');
      return { token: value, clientId: grant.clientId, scopes: entry.scopes, expiresAt: Math.floor(entry.expiresAt / 1000), resource: new URL(grant.resource) };
    },
    async revokeToken(client, request) {
      const entry = refreshTokens.get(request.token) ?? accessTokens.get(request.token);
      const grant = entry && grantFor(entry.grantId);
      if (grant && grant.clientId === client.client_id) grant.revoked = true;
      record({ kind: 'revoke', clientId: client.client_id, tokenTypeHint: request.token_type_hint ?? null, known: Boolean(grant) });
    },
  };

  authorizationApp.get('/.well-known/oauth-authorization-server', (_req, res) => res.json({
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    registration_endpoint: `${issuer}/register`,
    revocation_endpoint: `${issuer}/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['client_secret_post', 'none'],
    revocation_endpoint_auth_methods_supported: ['client_secret_post', 'none'],
    scopes_supported: [READ_SCOPE, WRITE_SCOPE],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
  }));
  authorizationApp.use('/authorize', sdk.authorizationHandler({ provider, rateLimit: false }));
  authorizationApp.use('/token', (req, res, next) => {
    if (failures.count <= 0) return next();
    failures.count -= 1;
    record({ kind: 'token', outcome: `failed-${failures.status}` });
    req.resume();
    return res.status(failures.status).type('text/plain').send('Service Unavailable');
  });
  authorizationApp.use('/token', sdk.tokenHandler({ provider, rateLimit: false }));
  // The SDK's registration schema drops fields it does not know (application_type), so
  // record what the client sent before the handler parses it.
  authorizationApp.use('/register', express.json(), (req, _res, next) => {
    const body = req.body ?? {};
    record({
      kind: 'register', applicationType: body.application_type, grantTypes: body.grant_types,
      redirectUris: body.redirect_uris, tokenEndpointAuthMethod: body.token_endpoint_auth_method, scope: body.scope,
    });
    next();
  });
  authorizationApp.use('/register', sdk.clientRegistrationHandler({ clientsStore, rateLimit: false }));
  authorizationApp.use('/revoke', sdk.revocationHandler({ provider, rateLimit: false }));

  const control = express.Router();
  control.use(express.json());
  control.post('/expire-access-tokens', (_req, res) => {
    for (const entry of accessTokens.values()) entry.expiresAt = Date.now() - 1000;
    res.json({ expired: accessTokens.size });
  });
  control.post('/revoke-grants', (_req, res) => {
    for (const grant of grants.values()) grant.revoked = true;
    res.json({ revoked: grants.size });
  });
  control.post('/fail-token-requests', (req, res) => {
    failures = { count: Number(req.body?.count ?? 1), status: Number(req.body?.status ?? 503) };
    res.json(failures);
  });
  control.get('/log', (_req, res) => res.json(log));
  control.get('/state', (_req, res) => res.json({
    clients: [...clients.keys()].length,
    grants: [...grants.values()].map(({ clientId, scopes, revoked, refreshes }) => ({ clientId, scopes, revoked, refreshes })),
  }));
  authorizationApp.use('/control', control);

  resourceApp.get('/.well-known/oauth-protected-resource/mcp', (_req, res) => res.json({
    resource, authorization_servers: [issuer], scopes_supported: [READ_SCOPE, WRITE_SCOPE], bearer_methods_supported: ['header'],
  }));
  const readAccess = sdk.requireBearerAuth({ verifier: provider, requiredScopes: [READ_SCOPE], resourceMetadataUrl, expectedResource: new URL(resource) });
  const writeAccess = sdk.requireBearerAuth({ verifier: provider, requiredScopes: [WRITE_SCOPE], resourceMetadataUrl, expectedResource: new URL(resource) });
  const notes = [];
  const mcpServer = () => {
    const server = new sdk.McpServer({ name: 'oauth-reference-notes', version: '1.0.0' });
    server.registerTool('read_note', { description: `Reads the notes. Needs ${READ_SCOPE}.` },
      async () => ({ content: [{ type: 'text', text: notes.length ? notes.join('\n') : 'no notes yet' }] }));
    server.registerTool('write_note', { description: `Adds a note. Needs ${WRITE_SCOPE}.` },
      async () => { notes.push(`note ${notes.length + 1}`); return { content: [{ type: 'text', text: 'saved' }] }; });
    return server;
  };
  resourceApp.post('/mcp', express.json(), readAccess, (req, res, next) => {
    const calls = Array.isArray(req.body) ? req.body : [req.body];
    const writes = calls.some((call) => call?.method === 'tools/call' && call.params?.name === 'write_note');
    if (!writes) return next();
    // Step-up: the challenge names only the missing scope; the client keeps the others.
    const { scopes } = req.auth;
    if (scopes.includes(WRITE_SCOPE)) return next();
    record({ kind: 'step-up-challenge', scope: WRITE_SCOPE });
    return writeAccess(req, res, next);
  }, async (req, res) => {
    record({ kind: 'mcp', method: Array.isArray(req.body) ? 'batch' : req.body?.method ?? null, scopes: req.auth.scopes });
    const server = mcpServer();
    const transport = new sdk.StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => { transport.close(); server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
  resourceApp.all('/mcp', (_req, res) => res.status(405).set('allow', 'POST').end());

  const close = () => Promise.all([authorizationServer, resourceServer].map((server) => new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  })));
  return { issuer, resource, resourceMetadataUrl, control: `${issuer}/control`, clientMetadataUrl: cimd.client_id, close };
}

async function main() {
  const { values } = parseArgs({ options: {
    'module-root': { type: 'string', multiple: true }, host: { type: 'string' }, 'public-host': { type: 'string' },
    'client-metadata': { type: 'string' },
  } });
  const servers = await startReferenceServers({
    moduleRoots: [...(values['module-root'] ?? []), repositoryRoot],
    host: values.host ?? '127.0.0.1',
    publicHost: values['public-host'] ?? values.host ?? '127.0.0.1',
    ...(values['client-metadata'] ? { clientMetadataFile: path.resolve(values['client-metadata']) } : {}),
  });
  const { close, ...addresses } = servers;
  process.stdout.write(`${JSON.stringify({ ready: true, ...addresses })}\n`);
  const stop = () => close().finally(() => process.exit(0));
  process.stdin.on('end', stop);
  process.stdin.on('close', stop);
  process.stdin.resume();
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exit(1); });
}
