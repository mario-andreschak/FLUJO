import { createLogger } from '@/utils/logger';

const log = createLogger('utils/mcp/oauthProbe');

export interface OAuthCapabilityProbeResult {
  /** True when the remote server advertises OAuth (RFC 9728 / a Bearer challenge). */
  oauthCapable: boolean;
  /** The protected-resource-metadata URL, when one was discovered. */
  resourceMetadataUrl?: string;
  /** Authorization server issuer URLs from the resource metadata, when present. */
  authorizationServers?: string[];
  /** True only when RFC 8414/OIDC metadata advertises a registration endpoint. */
  dynamicClientRegistration?: boolean;
  /** The advertised RFC 7591 registration endpoint, when present. */
  registrationEndpoint?: string;
  /** Whether the initialize probe reached an HTTP endpoint at all. */
  reachable?: boolean;
  /** True when the endpoint accepted initialize without an authentication challenge. */
  unauthenticated?: boolean;
}

const PROBE_TIMEOUT_MS = 5000;

export interface OAuthProbeOptions {
  /** Registry research uses this to avoid following untrusted metadata into local networks. */
  publicOnly?: boolean;
}

function isPublicHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return false;
    const host = url.hostname.toLocaleLowerCase().replace(/^\[|\]$/g, '');
    if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return false;
    if (host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80:')) return false;
    const parts = host.split('.').map(Number);
    if (parts.length === 4 && parts.every(Number.isInteger)) {
      if (parts[0] === 10 || parts[0] === 127 || parts[0] === 0) return false;
      if (parts[0] === 169 && parts[1] === 254) return false;
      if (parts[0] === 192 && parts[1] === 168) return false;
      if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * A 401 from a spec-compliant MCP server carries a `WWW-Authenticate: Bearer ...`
 * challenge, optionally pointing at its RFC 9728 protected-resource-metadata document
 * via `resource_metadata="..."`. This reads that challenge WITHOUT completing any
 * handshake or triggering client registration.
 *
 * A minimal `initialize` JSON-RPC POST is the request an MCP client makes first, so it
 * reliably elicits the same auth challenge the real transport would hit - unlike a bare
 * GET, which many streamable endpoints answer with 405/406 and no challenge.
 */
async function readAuthChallenge(serverUrl: string): Promise<{
  bearer: boolean;
  reachable: true;
  unauthenticated: boolean;
  resourceMetadataUrl?: string;
}> {
  const res = await fetch(serverUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: {} }),
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });

  const header = res.headers.get('www-authenticate') || '';
  const bearer = /\bbearer\b/i.test(header);
  const match = header.match(/resource_metadata\s*=\s*"([^"]+)"/i);
  return { bearer, reachable: true, unauthenticated: res.ok && !bearer, resourceMetadataUrl: match?.[1] };
}

/**
 * Fetch and validate an RFC 9728 protected-resource-metadata document. Returns the parsed
 * `authorization_servers` when the URL yields a metadata document that looks like one.
 */
async function fetchResourceMetadata(
  metadataUrl: string,
  publicOnly = false,
): Promise<{ authorizationServers?: string[] } | undefined> {
  if (publicOnly && !isPublicHttpsUrl(metadataUrl)) return undefined;
  const res = await fetch(metadataUrl, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });
  if (!res.ok) return undefined;

  const data = (await res.json()) as { authorization_servers?: unknown; resource?: unknown };
  // A protected-resource-metadata doc is identified by either `authorization_servers`
  // (the field that names the OAuth issuers) or, minimally, a `resource` identifier.
  const hasAuthServers = Array.isArray(data.authorization_servers);
  if (!hasAuthServers && typeof data.resource !== 'string') return undefined;

  return {
    authorizationServers: hasAuthServers
      ? (data.authorization_servers as unknown[]).filter((s): s is string => typeof s === 'string')
      : undefined,
  };
}

function authorizationMetadataUrls(issuer: string): string[] {
  try {
    const url = new URL(issuer);
    const issuerPath = url.pathname.replace(/\/$/, '');
    return Array.from(new Set([
      new URL(`/.well-known/oauth-authorization-server${issuerPath}`, url.origin).toString(),
      new URL(`${issuerPath}/.well-known/oauth-authorization-server`, url.origin).toString(),
      new URL(`${issuerPath}/.well-known/openid-configuration`, url.origin).toString(),
    ]));
  } catch {
    return [];
  }
}

async function findRegistrationEndpoint(issuers: string[], publicOnly = false): Promise<string | undefined> {
  for (const issuer of issuers) {
    if (publicOnly && !isPublicHttpsUrl(issuer)) continue;
    for (const metadataUrl of authorizationMetadataUrls(issuer)) {
      try {
        const res = await fetch(metadataUrl, {
          headers: { accept: 'application/json' },
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        if (!res.ok) continue;
        const data = await res.json() as { registration_endpoint?: unknown };
        if (typeof data.registration_endpoint === 'string') return data.registration_endpoint;
      } catch {
        // Discovery is best effort; continue through the issuer's other standard URLs.
      }
    }
  }
  return undefined;
}

/**
 * Best-effort probe: does this remote MCP endpoint use OAuth?
 *
 * This exists because FLUJO's Test Run only learned "auth required" from the numeric
 * 401/403 status, never from the `WWW-Authenticate` challenge - so it could not tell an
 * OAuth/DCR server (offer to authenticate) apart from one wanting a static bearer header
 * (tell the user to add an Authorization header). This reads the challenge and the RFC
 * 9728 metadata to make that distinction.
 *
 * NEVER throws: any network/parse failure resolves to `{ oauthCapable: false }` so the
 * caller falls back to the generic "requires authentication" hint.
 */
export async function probeOAuthSupport(
  serverUrl: string,
  options: OAuthProbeOptions = {},
): Promise<OAuthCapabilityProbeResult> {
  try {
    if (options.publicOnly && !isPublicHttpsUrl(serverUrl)) return { oauthCapable: false };
    const origin = new URL(serverUrl).origin;

    const challenge = await readAuthChallenge(serverUrl).catch((err) => {
      log.debug(`readAuthChallenge failed for ${serverUrl}: ${err instanceof Error ? err.message : String(err)}`);
      return {
        bearer: false,
        reachable: undefined as true | undefined,
        unauthenticated: false,
        resourceMetadataUrl: undefined as string | undefined,
      };
    });

    // Try the metadata URL the challenge advertised first, then the RFC 9728 default
    // location at the server's origin.
    const candidates: string[] = [];
    if (challenge.resourceMetadataUrl) candidates.push(challenge.resourceMetadataUrl);
    candidates.push(new URL('/.well-known/oauth-protected-resource', origin).toString());

    for (const metadataUrl of candidates) {
      const meta = await fetchResourceMetadata(metadataUrl, options.publicOnly).catch(() => undefined);
      if (meta) {
        const authorizationServers = meta.authorizationServers ?? [origin];
        const registrationEndpoint = await findRegistrationEndpoint(authorizationServers, options.publicOnly);
        log.info(`OAuth capability confirmed for ${serverUrl} via ${metadataUrl}`);
        return {
          oauthCapable: true,
          resourceMetadataUrl: metadataUrl,
          authorizationServers: meta.authorizationServers,
          reachable: challenge.reachable,
          ...(registrationEndpoint
            ? { dynamicClientRegistration: true, registrationEndpoint }
            : { dynamicClientRegistration: false }),
        };
      }
    }

    // A Bearer challenge without a fetchable metadata doc is still a strong OAuth signal
    // (the SDK's auth() can still discover via RFC 8414 from the origin).
    if (challenge.bearer) {
      log.info(`OAuth capability inferred for ${serverUrl} from a Bearer challenge (no resource metadata)`);
      return { oauthCapable: true, resourceMetadataUrl: challenge.resourceMetadataUrl, reachable: true };
    }

    log.debug(`No OAuth capability detected for ${serverUrl}`);
    return {
      oauthCapable: false,
      ...(challenge.reachable ? { reachable: true } : {}),
      ...(challenge.unauthenticated ? { unauthenticated: true } : {}),
    };
  } catch (err) {
    log.debug(`probeOAuthSupport failed for ${serverUrl}: ${err instanceof Error ? err.message : String(err)}`);
    return { oauthCapable: false };
  }
}
