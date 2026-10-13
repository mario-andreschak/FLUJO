import { probeOAuthSupport } from '@/utils/mcp/oauthProbe';
import * as publicRequests from '@/utils/mcp/publicOAuthRequest';

jest.mock('node:dns/promises', () => ({ lookup: jest.fn(async () => [{ address: '1.1.1.1', family: 4 }]) }));
jest.mock('@/utils/mcp/publicOAuthRequest', () => ({
  ...jest.requireActual('@/utils/mcp/publicOAuthRequest'), requestPublicOAuth: jest.fn(),
}));

/**
 * probeOAuthSupport is the signal that lets the Test Run distinguish an OAuth/DCR server
 * (offer "Save & Authenticate") from a static-bearer server (tell the user to add a
 * header). These tests pin the WWW-Authenticate + RFC 9728 metadata parsing and the
 * never-throws contract.
 */
describe('probeOAuthSupport', () => {
  let requestMock: jest.SpyInstance;
  beforeEach(() => jest.mocked(publicRequests.requestPublicOAuth).mockReset());

  afterEach(() => {
    jest.restoreAllMocks();
  });

  /** Build a minimal Response-like object for the two request kinds the probe makes. */
  const mockFetch = (handler: (url: string, init?: RequestInit) => {
    status?: number;
    ok?: boolean;
    headers?: Record<string, string>;
    json?: unknown;
  }) => {
    requestMock = jest.spyOn(publicRequests, 'requestPublicOAuth').mockImplementation(async (url, kind) => {
      const r = handler(url, { method: kind === 'challenge' ? 'POST' : 'GET' });
      const headers = new Headers(r.headers || {});
      return {
        ok: r.ok ?? (r.status ? r.status < 400 : true),
        status: r.status ?? 200,
        headers,
        json: async () => r.json,
      };
    });
  };

  it('detects OAuth from the WWW-Authenticate resource_metadata pointer', async () => {
    const metaUrl = 'https://mcp.example.com/.well-known/oauth-protected-resource';
    mockFetch((url) => {
      if (url === 'https://mcp.example.com/mcp') {
        return {
          status: 401,
          headers: { 'www-authenticate': `Bearer resource_metadata="${metaUrl}"` },
        };
      }
      if (url === metaUrl) {
        return { status: 200, json: { resource: 'https://mcp.example.com', authorization_servers: ['https://auth.example.com'] } };
      }
      return { status: 404 };
    });

    const result = await probeOAuthSupport('https://mcp.example.com/mcp');
    expect(result.oauthCapable).toBe(true);
    expect(result.resourceMetadataUrl).toBe(metaUrl);
    expect(result.authorizationServers).toEqual(['https://auth.example.com']);
  });

  it('detects OAuth 2.1 dynamic client registration from authorization-server metadata', async () => {
    const metaUrl = 'https://mcp.example.com/.well-known/oauth-protected-resource';
    mockFetch((url) => {
      if (url === 'https://mcp.example.com/mcp') {
        return { status: 401, headers: { 'www-authenticate': `Bearer resource_metadata="${metaUrl}"` } };
      }
      if (url === metaUrl) {
        return { status: 200, json: { resource: 'https://mcp.example.com', authorization_servers: ['https://auth.example.com'] } };
      }
      if (url === 'https://auth.example.com/.well-known/oauth-authorization-server') {
        return { status: 200, json: { registration_endpoint: 'https://auth.example.com/register' } };
      }
      return { status: 404 };
    });

    await expect(probeOAuthSupport('https://mcp.example.com/mcp')).resolves.toEqual(
      expect.objectContaining({
        oauthCapable: true,
        dynamicClientRegistration: true,
        registrationEndpoint: 'https://auth.example.com/register',
      }),
    );
  });

  it('falls back to the RFC 9728 default well-known path when the challenge has no pointer', async () => {
    const wellKnown = 'https://mcp.example.com/.well-known/oauth-protected-resource';
    mockFetch((url) => {
      if (url === 'https://mcp.example.com/mcp') {
        return { status: 401, headers: { 'www-authenticate': 'Bearer' } };
      }
      if (url === wellKnown) {
        return { status: 200, json: { resource: 'https://mcp.example.com', authorization_servers: ['https://auth.example.com'] } };
      }
      return { status: 404 };
    });

    const result = await probeOAuthSupport('https://mcp.example.com/mcp');
    expect(result.oauthCapable).toBe(true);
    expect(result.resourceMetadataUrl).toBe(wellKnown);
  });

  it('infers OAuth from a bare Bearer challenge even without fetchable metadata', async () => {
    mockFetch((url) => {
      if (url === 'https://mcp.example.com/mcp') {
        return { status: 401, headers: { 'www-authenticate': 'Bearer error="invalid_token"' } };
      }
      return { status: 404 }; // no well-known doc
    });

    const result = await probeOAuthSupport('https://mcp.example.com/mcp');
    expect(result.oauthCapable).toBe(true);
  });

  it('does not follow Registry-research metadata into local networks', async () => {
    const localMetadata = 'http://127.0.0.1:9999/private-metadata';
    mockFetch((url) => {
      if (url === 'https://mcp.example.com/mcp') {
        return { status: 401, headers: { 'www-authenticate': `Bearer resource_metadata="${localMetadata}"` } };
      }
      return { status: 404 };
    });

    const result = await probeOAuthSupport('https://mcp.example.com/mcp', { publicOnly: true });

    expect(result.oauthCapable).toBe(true); // Bearer remains a valid OAuth signal.
    expect(requestMock.mock.calls.some(([url]) => String(url).includes('127.0.0.1'))).toBe(false);
  });

  it('reports NOT capable for a static-bearer server (401, no Bearer challenge, no metadata)', async () => {
    mockFetch((url) => {
      if (url === 'https://api.example.com/mcp') {
        return { status: 401, headers: { 'www-authenticate': 'Basic realm="api"' } };
      }
      return { status: 404 };
    });

    const result = await probeOAuthSupport('https://api.example.com/mcp');
    expect(result.oauthCapable).toBe(false);
  });

  it('never throws — a network failure resolves to not-capable', async () => {
    jest.spyOn(publicRequests, 'requestPublicOAuth').mockImplementation(async () => {
      throw new Error('ECONNREFUSED');
    });

    await expect(probeOAuthSupport('https://down.example.com/mcp')).resolves.toEqual({ oauthCapable: false });
  });

  it('ignores a non-metadata JSON body at the well-known path', async () => {
    mockFetch((url) => {
      if (url === 'https://mcp.example.com/mcp') {
        return { status: 401, headers: {} };
      }
      if (url === 'https://mcp.example.com/.well-known/oauth-protected-resource') {
        return { status: 200, json: { hello: 'world' } };
      }
      return { status: 404 };
    });

    const result = await probeOAuthSupport('https://mcp.example.com/mcp');
    expect(result.oauthCapable).toBe(false);
  });

  it('never allows the compatibility publicOnly flag to disable private-network denial', async () => {
    mockFetch(() => ({ status: 200 }));
    await expect(probeOAuthSupport('https://127.0.0.1/mcp', { publicOnly: false })).resolves.toEqual({ oauthCapable: false });
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('filters private issuers and registration links without exposing them to the caller', async () => {
    mockFetch(url => {
      if (url.endsWith('/mcp')) return { status: 401, headers: { 'www-authenticate': 'Bearer' } };
      if (url.endsWith('/oauth-protected-resource')) return { json: {
        resource: 'https://mcp.example.com', authorization_servers: ['https://127.0.0.1', 'https://auth.example.com'] } };
      return { json: { registration_endpoint: 'https://169.254.169.254/private' } };
    });
    const result = await probeOAuthSupport('https://mcp.example.com/mcp');
    expect(result.authorizationServers).toEqual(['https://auth.example.com']);
    expect(result.dynamicClientRegistration).toBe(false);
    expect(result.registrationEndpoint).toBeUndefined();
    expect(requestMock.mock.calls.some(([url]) => String(url).includes('127.0.0.1') || String(url).includes('169.254.169.254'))).toBe(false);
    expect(new Set(requestMock.mock.calls.map(([, , signal]) => signal)).size).toBe(1);
  });
});
