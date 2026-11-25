/**
 * MCP 2026-07-28 authorization rules for FLUJO's OAuth client, checked against both
 * official SDK generations with a scripted authorization server:
 * https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization
 */
import { auth as authV1 } from '@modelcontextprotocol/sdk/client/auth.js';
import { auth as authV2 } from '@modelcontextprotocol/client';
import type { MCPStreamableConfig } from '@/shared/types/mcp';
import { installPrivateProfileFixture } from '../utils/privateProfileFixture';

const mockLoad = jest.fn();
const mockSave = jest.fn();
jest.mock('@/backend/services/mcp/config', () => ({
  loadServerConfigs: () => mockLoad(), saveConfig: (value: unknown) => mockSave(value),
}));
jest.mock('@/utils/logger', () => ({ createLogger: () => ({
  info: jest.fn(), debug: jest.fn(), verbose: jest.fn(), warn: jest.fn(), error: jest.fn(),
}) }));
import { MCPOAuthClientProvider, readOAuthChallenge, startOAuthAuthorization } from '@/backend/services/mcp/oauth';

const serverUrl = 'https://mcp.example.test/tenant/mcp';
const issuer = 'https://auth.example.test';
const callback = 'http://localhost:4200/api/oauth/callback?workspace=default-workspace';
const wellKnownResource = 'https://mcp.example.test/.well-known/oauth-protected-resource/tenant/mcp';

interface Recorded { url: string; method: string; body: string; headers: Headers }
interface ServerScript {
  challenge?: { status: number; header?: string } | 'network-error';
  /** Metadata documents by exact URL; anything else is 404. */
  documents: Record<string, unknown>;
}

function scriptedServers(script: ServerScript) {
  const requests: Recorded[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = init?.method ?? 'GET';
    requests.push({ url, method, body: String(init?.body ?? ''), headers: new Headers(init?.headers) });
    if (url === serverUrl && method === 'POST') {
      if (script.challenge === 'network-error') throw new TypeError('fetch failed');
      const challenge = script.challenge ?? { status: 401, header: 'Bearer' };
      return new Response('{"error":"unauthorized"}', { status: challenge.status,
        headers: challenge.header ? { 'www-authenticate': challenge.header } : {} });
    }
    if (url === `${issuer}/token`) {
      return Response.json({ access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', token_type: 'bearer', expires_in: 3600 });
    }
    if (url === `${issuer}/register`) {
      return Response.json({ client_id: 'synthetic-dcr-client', redirect_uris: [callback] }, { status: 201 });
    }
    const document = script.documents[url];
    return document === undefined ? new Response('not found', { status: 404 }) : Response.json(document);
  };
  return { fetchFn, requests };
}

const authorizationServerMetadata = (extra: Record<string, unknown> = {}) => ({
  issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`,
  registration_endpoint: `${issuer}/register`, response_types_supported: ['code'],
  code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
  ...extra,
});

let fixture: Awaited<ReturnType<typeof installPrivateProfileFixture>>;
let config: MCPStreamableConfig;
beforeEach(async () => {
  fixture = await installPrivateProfileFixture();
  // ['read'] is the marker FLUJO stores when it switches OAuth on by itself.
  config = { name: 'conformance', transport: 'streamable', serverUrl, rootPath: '', env: {}, disabled: true,
    _buildCommand: '', _installCommand: '', oauthScopes: ['read'] };
  mockLoad.mockReset().mockImplementation(async () => [config]);
  mockSave.mockReset().mockImplementation(async (configs: Map<string, MCPStreamableConfig>) => {
    config = configs.get(config.name) ?? config;
    return { success: true };
  });
});
afterEach(async () => { await fixture?.restore(); });

const authorizationUrl = () => new URL(config.authorizationUrl!);

describe('challenge-first discovery', () => {
  it('reads resource_metadata and scope from the server challenge without sending credentials', async () => {
    const { fetchFn, requests } = scriptedServers({
      challenge: { status: 401, header: 'Bearer resource_metadata="https://mcp.example.test/meta/custom", scope="files:read files:write"' },
      documents: {},
    });
    const challenge = await readOAuthChallenge(serverUrl, fetchFn);
    expect(challenge.resourceMetadataUrl?.href).toBe('https://mcp.example.test/meta/custom');
    expect(challenge.scope).toBe('files:read files:write');
    expect(requests).toHaveLength(1);
    expect(requests[0].headers.has('authorization')).toBe(false);
    expect(JSON.parse(requests[0].body)).toMatchObject({ jsonrpc: '2.0', method: 'ping' });
  });

  it.each([
    ['a server that needs no sign-in', { status: 200 }],
    ['a redirect', { status: 302, header: 'Bearer resource_metadata="https://elsewhere.test/meta"' }],
    ['a network failure', 'network-error'],
  ] as const)('falls back to well-known discovery after %s', async (_label, challenge) => {
    const { fetchFn } = scriptedServers({ challenge, documents: {} });
    await expect(readOAuthChallenge(serverUrl, fetchFn)).resolves.toEqual({});
  });

  it('uses a metadata address published only in the challenge, plus its scope', async () => {
    const custom = 'https://mcp.example.test/meta/custom';
    const { fetchFn, requests } = scriptedServers({
      challenge: { status: 401, header: `Bearer resource_metadata="${custom}", scope="files:read"` },
      documents: {
        [custom]: { resource: serverUrl, authorization_servers: [issuer], scopes_supported: ['files:read', 'files:write', 'admin'] },
        [`${issuer}/.well-known/oauth-authorization-server`]: authorizationServerMetadata(),
      },
    });
    const provider = new MCPOAuthClientProvider(config, callback);
    await expect(startOAuthAuthorization(provider, serverUrl, fetchFn))
      .rejects.toMatchObject({ name: 'OAuthAuthenticationRequired' });
    const url = authorizationUrl();
    expect(url.origin + url.pathname).toBe(`${issuer}/authorize`);
    expect(url.searchParams.get('scope')).toBe('files:read');
    expect(url.searchParams.get('resource')).toBe(serverUrl);
    expect(requests.some(request => request.url === wellKnownResource)).toBe(false);
    expect(config.oauthStateDiscovery?.resourceMetadataUrl).toBe(custom);
  });
});

describe.each([['v1', authV1], ['v2', authV2]] as const)('%s scope selection', (_generation, auth) => {
  it('omits scope when neither the challenge nor the metadata names one', async () => {
    const { fetchFn, requests } = scriptedServers({ documents: {
      [wellKnownResource]: { resource: serverUrl, authorization_servers: [issuer] },
      [`${issuer}/.well-known/oauth-authorization-server`]: authorizationServerMetadata(),
    } });
    await expect(auth(new MCPOAuthClientProvider(config, callback), { serverUrl, fetchFn }))
      .rejects.toMatchObject({ name: 'OAuthAuthenticationRequired' });
    expect(authorizationUrl().searchParams.has('scope')).toBe(false);
    const registration = requests.find(request => request.url === `${issuer}/register`);
    expect(JSON.parse(registration!.body).scope).toBeUndefined();
  });

  it('keeps scopes a person configured when the server names none', async () => {
    config.oauthScopes = ['files:read', 'files:write'];
    const { fetchFn } = scriptedServers({ documents: {
      [wellKnownResource]: { resource: serverUrl, authorization_servers: [issuer] },
      [`${issuer}/.well-known/oauth-authorization-server`]: authorizationServerMetadata(),
    } });
    await expect(auth(new MCPOAuthClientProvider(config, callback), { serverUrl, fetchFn }))
      .rejects.toMatchObject({ name: 'OAuthAuthenticationRequired' });
    expect(authorizationUrl().searchParams.get('scope')).toBe('files:read files:write');
  });

  it('asks again for earlier granted scopes when a challenge needs one more', async () => {
    const { fetchFn } = scriptedServers({ documents: {
      [wellKnownResource]: { resource: serverUrl, authorization_servers: [issuer] },
      [`${issuer}/.well-known/oauth-authorization-server`]: authorizationServerMetadata(),
    } });
    const provider = new MCPOAuthClientProvider(config, callback);
    await provider.saveClientInformation({ client_id: 'synthetic-dcr-client', issuer } as never);
    // No refresh token: the SDK has to start a new authorization for the step-up.
    await provider.saveTokens({ access_token: 'synthetic-old', token_type: 'bearer', scope: 'files:read', issuer } as never);
    await expect(auth(provider, { serverUrl, fetchFn, scope: 'files:write' }))
      .rejects.toMatchObject({ name: 'OAuthAuthenticationRequired' });
    expect(authorizationUrl().searchParams.get('scope')?.split(' ').sort()).toEqual(['files:read', 'files:write']);
  });

  it('reads comma-separated granted scopes and leaves the request alone when nothing is missing', async () => {
    const { fetchFn } = scriptedServers({ documents: {
      [wellKnownResource]: { resource: serverUrl, authorization_servers: [issuer] },
      [`${issuer}/.well-known/oauth-authorization-server`]: authorizationServerMetadata(),
    } });
    const provider = new MCPOAuthClientProvider(config, callback);
    await provider.saveClientInformation({ client_id: 'synthetic-dcr-client', issuer } as never);
    await provider.saveTokens({ access_token: 'synthetic-old', token_type: 'bearer', scope: 'files:read,files:write', issuer } as never);
    await expect(auth(provider, { serverUrl, fetchFn, scope: 'files:write files:read' }))
      .rejects.toMatchObject({ name: 'OAuthAuthenticationRequired' });
    expect(authorizationUrl().searchParams.get('scope')).toBe('files:write files:read');
  });

  it('never merges scopes granted by a different authorization server', async () => {
    const { fetchFn } = scriptedServers({ documents: {
      [wellKnownResource]: { resource: serverUrl, authorization_servers: [issuer] },
      [`${issuer}/.well-known/oauth-authorization-server`]: authorizationServerMetadata(),
    } });
    const provider = new MCPOAuthClientProvider(config, callback);
    await provider.saveTokens({ access_token: 'synthetic-old', token_type: 'bearer', scope: 'other:admin', issuer: 'https://other.example.test' } as never);
    await expect(auth(provider, { serverUrl, fetchFn, scope: 'files:write' }))
      .rejects.toMatchObject({ name: 'OAuthAuthenticationRequired' });
    expect(authorizationUrl().searchParams.get('scope')).toBe('files:write');
  });
});

describe.each([['v1', authV1], ['v2', authV2]] as const)('%s PKCE verification', (_generation, auth) => {
  it.each([
    ['does not list code_challenge_methods_supported', authorizationServerMetadata({ code_challenge_methods_supported: undefined })],
    ['lists only plain', authorizationServerMetadata({ code_challenge_methods_supported: ['plain'] })],
  ])('refuses to open sign-in when the server %s', async (_label, metadata) => {
    const { fetchFn, requests } = scriptedServers({ documents: {
      [wellKnownResource]: { resource: serverUrl, authorization_servers: [issuer] },
      [`${issuer}/.well-known/oauth-authorization-server`]: metadata,
    } });
    const error = await auth(new MCPOAuthClientProvider(config, callback), { serverUrl, fetchFn }).catch(caught => caught);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).not.toBe('OAuthAuthenticationRequired');
    expect(String(error.message)).toMatch(/S256/);
    expect(config.authorizationUrl).toBeUndefined();
    expect(config.oauthCodeVerifier).toBeUndefined();
    expect(requests.some(request => request.url === `${issuer}/token`)).toBe(false);
  });

  it('still refreshes an existing grant; PKCE guards only new sign-ins', async () => {
    const { fetchFn, requests } = scriptedServers({ documents: {
      [wellKnownResource]: { resource: serverUrl, authorization_servers: [issuer] },
      [`${issuer}/.well-known/oauth-authorization-server`]: authorizationServerMetadata({ code_challenge_methods_supported: undefined }),
    } });
    const provider = new MCPOAuthClientProvider(config, callback);
    await provider.saveClientInformation({ client_id: 'synthetic-dcr-client', issuer } as never);
    await provider.saveTokens({ access_token: 'synthetic-old', refresh_token: 'synthetic-old-refresh', token_type: 'bearer', issuer } as never);
    await expect(auth(provider, { serverUrl, fetchFn })).resolves.toBe('AUTHORIZED');
    expect(requests.filter(request => request.url === `${issuer}/token`)).toHaveLength(1);
  });
});

describe.each([['v1', authV1], ['v2', authV2]] as const)('%s resource indicators', (_generation, auth) => {
  it('sends the protected resource in the authorization, code and refresh requests', async () => {
    const { fetchFn, requests } = scriptedServers({ documents: {
      [wellKnownResource]: { resource: serverUrl, authorization_servers: [issuer] },
      [`${issuer}/.well-known/oauth-authorization-server`]: authorizationServerMetadata(),
    } });
    await expect(auth(new MCPOAuthClientProvider(config, callback), { serverUrl, fetchFn }))
      .rejects.toMatchObject({ name: 'OAuthAuthenticationRequired' });
    const url = authorizationUrl();
    expect(url.searchParams.get('resource')).toBe(serverUrl);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');

    const resumed = new MCPOAuthClientProvider(config, callback, config.oauthStateDiscovery);
    await expect(auth(resumed, { serverUrl, fetchFn, authorizationCode: 'synthetic-code' })).resolves.toBe('AUTHORIZED');
    await expect(auth(new MCPOAuthClientProvider(config, callback), { serverUrl, fetchFn })).resolves.toBe('AUTHORIZED');
    const tokenBodies = requests.filter(request => request.url === `${issuer}/token`).map(request => new URLSearchParams(request.body));
    expect(tokenBodies.map(body => body.get('grant_type'))).toEqual(['authorization_code', 'refresh_token']);
    expect(tokenBodies.every(body => body.get('resource') === serverUrl)).toBe(true);
    expect(tokenBodies[0].get('code_verifier')).toMatch(/^[A-Za-z0-9._~-]{43,128}$/);
  });
});

describe.each([['v1', authV1], ['v2', authV2]] as const)('%s servers without protected resource metadata', (_generation, auth) => {
  it('accepts an authorization server at the server origin whose issuer has no trailing slash', async () => {
    const origin = 'https://mcp.example.test';
    const { fetchFn } = scriptedServers({ documents: {
      [`${origin}/.well-known/oauth-authorization-server`]: {
        ...authorizationServerMetadata(), issuer: origin, authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`, registration_endpoint: `${origin}/register`,
      },
    } });
    const wrapped: typeof fetch = async (input, init) => String(input) === `${origin}/register`
      ? Response.json({ client_id: 'synthetic-legacy-client', redirect_uris: [callback] }, { status: 201 })
      : fetchFn(input, init);
    await expect(auth(new MCPOAuthClientProvider(config, callback), { serverUrl, fetchFn: wrapped }))
      .rejects.toMatchObject({ name: 'OAuthAuthenticationRequired' });
    expect(authorizationUrl().origin).toBe(origin);
    expect(config.oauthStateDiscovery?.authorizationServerMetadata?.issuer).toBe(origin);
  });

  it('still rejects metadata that names a different issuer', async () => {
    const origin = 'https://mcp.example.test';
    const { fetchFn } = scriptedServers({ documents: {
      [`${origin}/.well-known/oauth-authorization-server`]: { ...authorizationServerMetadata(), issuer: 'https://honest.example.test' },
    } });
    await expect(auth(new MCPOAuthClientProvider(config, callback), { serverUrl, fetchFn }))
      .rejects.toThrow(/issuer/i);
    expect(config.authorizationUrl).toBeUndefined();
  });
});
