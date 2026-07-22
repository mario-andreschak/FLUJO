/**
 * HTTP client for the hosted FLUJO package registry (issue #197, consuming the
 * #196 API contract). Mirrors the `registryClient.ts` seam (thin transport,
 * mockable network boundary) but talks to OUR service, so it uses plain `fetch`
 * with JSON bodies + bearer auth rather than the MCP-registry's HTTP/2 quirk.
 *
 * API surface consumed (from #196):
 *   POST /v1/auth/signup              { email, password }
 *   POST /v1/auth/login               { email, password }
 *   POST /v1/auth/refresh             { refresh_token }
 *   POST /v1/auth/resend-confirmation { email }
 *   POST /v1/auth/forgot-password     { email }         (TBD per #196 contract)
 *   POST /v1/packages                 <manifest JSON>   (Authorization: Bearer)
 *
 * Node-only: never import from client code. Never logs passwords, tokens, or
 * full response bodies that may contain secrets.
 */
import { createLogger } from '@/utils/logger';
import { loadItem } from '@/utils/storage/backend';
import { StorageKey } from '@/shared/types/storage';
import { DEFAULT_REGISTRY_URL, type RegistrySettings } from '@/shared/types/registry';

const log = createLogger('backend/utils/packageRegistryClient');

const REQUEST_TIMEOUT_MS = 20_000;

/** Strip a trailing slash so path joins stay clean. */
function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

/**
 * Resolve the registry base URL. Precedence (highest first):
 *   1. `FLUJO_REGISTRY_BASE_URL` env var
 *   2. stored `REGISTRY_SETTINGS.baseUrl`
 *   3. hardcoded `DEFAULT_REGISTRY_URL`
 */
export async function resolveRegistryBaseUrl(): Promise<string> {
  const fromEnv = process.env.FLUJO_REGISTRY_BASE_URL?.trim();
  if (fromEnv) return normalizeBaseUrl(fromEnv);

  const settings = await loadItem<RegistrySettings>(StorageKey.REGISTRY_SETTINGS, {});
  if (settings?.baseUrl && settings.baseUrl.trim()) {
    return normalizeBaseUrl(settings.baseUrl);
  }
  return normalizeBaseUrl(DEFAULT_REGISTRY_URL);
}

export interface RegistryHttpResponse<T = unknown> {
  status: number;
  body: T;
}

/** POST a JSON payload; parses the JSON response defensively (never throws on non-2xx). */
async function postJson<T = unknown>(
  pathname: string,
  payload: unknown,
  accessToken?: string,
): Promise<RegistryHttpResponse<T>> {
  const baseUrl = await resolveRegistryBaseUrl();
  const url = `${baseUrl}${pathname}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    if (accessToken) headers.Authorization = `Bearer ${accessToken}`;

    log.info(`POST ${pathname}`);
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload ?? {}),
      signal: controller.signal,
      cache: 'no-store',
    });
    const text = await response.text();
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = { message: text };
      }
    }
    return { status: response.status, body: body as T };
  } catch (err) {
    // Transport-level failure (DNS, TLS, timeout). Surface as a 0-status so the
    // service layer can map it to a friendly error without leaking internals.
    log.warn(`POST ${pathname} failed at transport level`, err instanceof Error ? err.message : err);
    return { status: 0, body: { message: 'Could not reach the package registry.' } as T };
  } finally {
    clearTimeout(timeout);
  }
}

export interface RegistryAuthPayload {
  access_token?: string;
  refresh_token?: string;
  expires_at?: number;
  expires_in?: number;
  needs_confirmation?: boolean;
  email?: string;
  publisher_handle?: string;
  is_confirmed?: boolean;
  message?: string;
  error?: string;
}

export interface RegistryPublishPayload {
  id?: string;
  name?: string;
  version?: string;
  url?: string;
  message?: string;
  error?: string;
}

export function signup(email: string, password: string) {
  return postJson<RegistryAuthPayload>('/v1/auth/signup', { email, password });
}

export function login(email: string, password: string) {
  return postJson<RegistryAuthPayload>('/v1/auth/login', { email, password });
}

export function refresh(refreshToken: string) {
  return postJson<RegistryAuthPayload>('/v1/auth/refresh', { refresh_token: refreshToken });
}

export function resendConfirmation(email: string) {
  return postJson<RegistryAuthPayload>('/v1/auth/resend-confirmation', { email });
}

/**
 * Request a password-reset email (pre-auth; issue #206). Proxies the hosted
 * registry's Supabase-backed reset flow — the actual password change happens on
 * the registry's own hosted page reached via the emailed link, so no reset token
 * or new-password form is ever handled inside FLUJO. No auth header is sent.
 *
 * NOTE: the exact pathname is owned by the hosted registry (#196) and is
 * currently "TBD per #196 contract"; it is isolated here so only this one line
 * needs updating once the contract is finalized.
 */
export function requestPasswordReset(email: string) {
  return postJson<RegistryAuthPayload>('/v1/auth/forgot-password', { email });
}

/** Publish a package manifest. `manifest` is the canonical JSON object (#192). */
export function publishPackage(manifest: unknown, accessToken: string) {
  return postJson<RegistryPublishPayload>('/v1/packages', manifest, accessToken);
}
