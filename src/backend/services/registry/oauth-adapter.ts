/**
 * Registry OAuth wire-format adapter (issue #207).
 *
 * Isolates the ONE part of the OAuth flow that is owned by the hosted registry's
 * #196 contract: how to build the provider-authorize URL and how to exchange the
 * returned code for tokens. Everything provider/contract-specific lives here so a
 * change to the #196 wire format never leaks into the service or route layers.
 *
 * Security posture (see the #207 plan): the registry is the OAuth *client* that
 * holds the GitHub/Google secrets — FLUJO is a public initiator that only ever
 * receives (and stores, encrypted) the registry's own token. No provider secret
 * is ever handled here.
 *
 * NOTE: the exact authorize path/params and token-exchange endpoint are "TBD per
 * #196 contract" (mirrors the password-reset seam in packageRegistryClient). The
 * best-guess shapes below follow the existing `/v1/auth/*` conventions and are
 * the only lines that must change once #196 is deployed.
 */
import { resolveRegistryBaseUrl, oauthExchange } from '@/backend/utils/packageRegistryClient';
import type { RegistryOAuthProvider } from '@/shared/types/registry';

/**
 * Build the registry's OAuth authorize URL to redirect the browser to. Carries
 * the opaque, single-use `state` and the PKCE `code_challenge` (S256). The
 * registry then bounces the user to the actual provider and back to our callback.
 */
export async function buildAuthorizeUrl(params: {
  provider: RegistryOAuthProvider;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}): Promise<string> {
  const base = await resolveRegistryBaseUrl();
  const url = new URL(`${base}/v1/auth/oauth/${params.provider}/authorize`);
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('state', params.state);
  url.searchParams.set('code_challenge', params.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

/**
 * Exchange the authorization code (with the stored PKCE verifier) for registry
 * tokens. Thin passthrough to the transport client so the wire format stays in
 * one place.
 */
export function exchangeAuthorizationCode(params: {
  code: string;
  codeVerifier: string;
  redirectUri: string;
  provider: RegistryOAuthProvider;
}) {
  return oauthExchange(params);
}
