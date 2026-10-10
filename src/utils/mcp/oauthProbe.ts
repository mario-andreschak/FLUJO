import { createLogger } from '@/utils/logger';
import { publicOAuthEndpoint, publicOAuthUrl, requestPublicOAuth } from './publicOAuthRequest';

const log = createLogger('utils/mcp/oauthProbe');

export interface OAuthCapabilityProbeResult {
  oauthCapable: boolean;
  resourceMetadataUrl?: string;
  authorizationServers?: string[];
  dynamicClientRegistration?: boolean;
  registrationEndpoint?: string;
  reachable?: boolean;
  unauthenticated?: boolean;
}

const PROBE_TIMEOUT_MS = 5000;
export interface OAuthProbeOptions {
  /** Compatibility input. Every probe now enforces public-only egress. */
  publicOnly?: boolean;
  /** Cancels the optional research probe without changing its public egress policy. */
  signal?: AbortSignal;
}

async function readAuthChallenge(serverUrl: string, signal: AbortSignal): Promise<{
  bearer: boolean; reachable: true; unauthenticated: boolean; resourceMetadataUrl?: string;
}> {
  const res = await requestPublicOAuth(serverUrl, 'challenge', signal);
  const header = res.headers.get('www-authenticate') || '';
  const bearer = /\bbearer\b/i.test(header);
  const match = header.match(/resource_metadata\s*=\s*"([^"]+)"/i);
  let resourceMetadataUrl: string | undefined;
  if (match) {
    try { resourceMetadataUrl = await publicOAuthEndpoint(match[1], signal); }
    catch { /* An untrusted pointer cannot widen the probe's egress. */ }
  }
  return { bearer, reachable: true, unauthenticated: res.ok && !bearer, resourceMetadataUrl };
}

async function fetchResourceMetadata(metadataUrl: string, signal: AbortSignal): Promise<{ authorizationServers?: string[] } | undefined> {
  const res = await requestPublicOAuth(metadataUrl, 'metadata', signal);
  if (!res.ok) return undefined;
  const value: unknown = await res.json();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const data = value as Record<string, unknown>;
  const hasAuthServers = Array.isArray(data.authorization_servers);
  if (!hasAuthServers && typeof data.resource !== 'string') return undefined;
  if (!hasAuthServers) return {};
  const issuers = data.authorization_servers as unknown[];
  if (issuers.length > 8) return undefined;
  const authorizationServers: string[] = [];
  for (const issuer of issuers) {
    if (typeof issuer !== 'string') continue;
    try {
      const accepted = await publicOAuthEndpoint(issuer, signal);
      if (!authorizationServers.includes(accepted)) authorizationServers.push(accepted);
    } catch { /* Ignore denied issuers; never request their metadata. */ }
  }
  return { authorizationServers };
}

function authorizationMetadataUrls(issuer: string): string[] {
  const url = publicOAuthUrl(issuer);
  const issuerPath = url.pathname.replace(/\/$/, '');
  return Array.from(new Set([
    new URL(`/.well-known/oauth-authorization-server${issuerPath}`, url.origin).toString(),
    new URL(`${issuerPath}/.well-known/oauth-authorization-server`, url.origin).toString(),
    new URL(`${issuerPath}/.well-known/openid-configuration`, url.origin).toString(),
  ]));
}

async function findRegistrationEndpoint(issuers: string[], signal: AbortSignal): Promise<string | undefined> {
  for (const issuer of issuers) {
    for (const metadataUrl of authorizationMetadataUrls(issuer)) {
      try {
        const res = await requestPublicOAuth(metadataUrl, 'metadata', signal);
        if (!res.ok) continue;
        const data: unknown = await res.json();
        if (!data || typeof data !== 'object' || !('registration_endpoint' in data)
            || typeof data.registration_endpoint !== 'string') continue;
        return await publicOAuthEndpoint(data.registration_endpoint, signal);
      } catch { /* Best effort within the one shared deadline. */ }
    }
  }
  return undefined;
}

/**
 * Public HTTPS/443 discovery only: address-bound requests, no redirects, caller
 * credentials, query secrets, private-network discovery or automatic registration.
 * Local/custom-port OAuth servers retain manual configuration but this optional
 * preview does not request them. Failures return a fixed not-capable result.
 */
export async function probeOAuthSupport(serverUrl: string, _options: OAuthProbeOptions = {}): Promise<OAuthCapabilityProbeResult> {
  _options.signal?.throwIfAborted();
  try {
    const server = publicOAuthUrl(serverUrl);
    const signal = _options.signal ? AbortSignal.any([_options.signal, AbortSignal.timeout(PROBE_TIMEOUT_MS)]) : AbortSignal.timeout(PROBE_TIMEOUT_MS);
    const challenge = await readAuthChallenge(server.href, signal).catch(() => {
      log.debug('OAuth challenge probe unavailable');
      return { bearer: false, reachable: undefined as true | undefined, unauthenticated: false,
        resourceMetadataUrl: undefined as string | undefined };
    });
    const candidates = new Set<string>();
    if (challenge.resourceMetadataUrl) candidates.add(challenge.resourceMetadataUrl);
    candidates.add(new URL('/.well-known/oauth-protected-resource', server.origin).toString());
    for (const metadataUrl of candidates) {
      const meta = await fetchResourceMetadata(metadataUrl, signal).catch(() => undefined);
      if (!meta) continue;
      const registrationEndpoint = await findRegistrationEndpoint(meta.authorizationServers ?? [server.origin], signal);
      _options.signal?.throwIfAborted();
      log.info('OAuth capability confirmed from public metadata');
      return { oauthCapable: true, resourceMetadataUrl: metadataUrl,
        authorizationServers: meta.authorizationServers, reachable: challenge.reachable,
        dynamicClientRegistration: !!registrationEndpoint, ...(registrationEndpoint ? { registrationEndpoint } : {}) };
    }
    _options.signal?.throwIfAborted();
    if (challenge.bearer) {
      // Do not return an unverified/unfetchable metadata pointer to another caller.
      log.info('OAuth capability inferred from a Bearer challenge');
      return { oauthCapable: true, reachable: true };
    }
    return { oauthCapable: false, ...(challenge.reachable ? { reachable: true } : {}),
      ...(challenge.unauthenticated ? { unauthenticated: true } : {}) };
  } catch {
    _options.signal?.throwIfAborted();
    log.debug('OAuth capability probe unavailable');
    return { oauthCapable: false };
  }
}
