import { probeOAuthSupport } from '@/utils/mcp/oauthProbe';

/**
 * probeOAuthSupport is the signal that lets the Test Run distinguish an OAuth/DCR server
 * (offer "Save & Authenticate") from a static-bearer server (tell the user to add a
 * header). These tests pin the WWW-Authenticate + RFC 9728 metadata parsing and the
 * never-throws contract.
 */
describe('probeOAuthSupport', () => {
  const realFetch = global.fetch;

  afterEach(() => {
    global.fetch = realFetch;
    jest.restoreAllMocks();
  });

  /** Build a minimal Response-like object for the two request kinds the probe makes. */
  const mockFetch = (handler: (url: string, init?: RequestInit) => {
    status?: number;
    ok?: boolean;
    headers?: Record<string, string>;
    json?: unknown;
  }) => {
    global.fetch = jest.fn(async (input: any, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.url;
      const r = handler(url, init);
      const headers = new Headers(r.headers || {});
      return {
        ok: r.ok ?? (r.status ? r.status < 400 : true),
        status: r.status ?? 200,
        headers,
        json: async () => r.json,
      } as unknown as Response;
    }) as unknown as typeof fetch;
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
    global.fetch = jest.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;

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
});
