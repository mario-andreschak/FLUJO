/**
 * Package-registry account service (issue #197).
 *
 * Owns the FLUJO-side account lifecycle for the hosted package registry:
 * sign-up/login, email-confirmation state, encrypted JWT/refresh-token storage,
 * silent refresh-on-401, and gated publishing. Tokens are encrypted at rest with
 * the SAME path as model API keys and are NEVER returned to the browser in full
 * (`getAccountStatus` returns masked metadata only).
 *
 * Node-only. All persistence goes through `saveItem`/`loadItem`; all network
 * traffic through `packageRegistryClient` (mockable network boundary).
 */
import { createLogger } from '@/utils/logger';
import { saveItem, loadItem } from '@/utils/storage/backend';
import { StorageKey } from '@/shared/types/storage';
import { encryptApiKey, decryptApiKey } from '@/backend/services/model/encryption';
import { MASKED_API_KEY } from '@/shared/types/constants';
import {
  DEFAULT_REGISTRY_URL,
  type StoredRegistryAccount,
  type RegistrySettings,
  type RegistryAccountStatus,
  type RegistryAuthAction,
  type RegistryAuthResult,
  type RegistryPublishResult,
} from '@/shared/types/registry';
import * as client from '@/backend/utils/packageRegistryClient';
import type { RegistryAuthPayload } from '@/backend/utils/packageRegistryClient';

const log = createLogger('backend/services/registry');

const EMPTY_ACCOUNT: StoredRegistryAccount = {
  email: '',
  publisherHandle: null,
  isConfirmed: false,
  expiresAt: null,
  accessToken: '',
  refreshToken: '',
};

async function loadStored(): Promise<StoredRegistryAccount> {
  return loadItem<StoredRegistryAccount>(StorageKey.REGISTRY_ACCOUNT, EMPTY_ACCOUNT);
}

async function persist(account: StoredRegistryAccount): Promise<void> {
  await saveItem(StorageKey.REGISTRY_ACCOUNT, account);
}

/** Compute the Unix-ms expiry from either an absolute `expires_at` or relative `expires_in`. */
function computeExpiry(payload: RegistryAuthPayload): number | null {
  if (typeof payload.expires_at === 'number') {
    // Treat < 1e12 as seconds (Supabase convention) and normalize to ms.
    return payload.expires_at < 1e12 ? payload.expires_at * 1000 : payload.expires_at;
  }
  if (typeof payload.expires_in === 'number') {
    return Date.now() + payload.expires_in * 1000;
  }
  return null;
}

/** Encrypt + store the tokens/metadata returned by an auth call. */
async function storeTokens(
  email: string,
  payload: RegistryAuthPayload,
): Promise<StoredRegistryAccount> {
  const account: StoredRegistryAccount = {
    email: payload.email || email,
    publisherHandle: payload.publisher_handle ?? null,
    isConfirmed: payload.is_confirmed ?? true,
    expiresAt: computeExpiry(payload),
    accessToken: payload.access_token ? await encryptApiKey(payload.access_token) : '',
    refreshToken: payload.refresh_token ? await encryptApiKey(payload.refresh_token) : '',
  };
  await persist(account);
  return account;
}

/** Masked, browser-safe view of the stored account. */
function toStatus(account: StoredRegistryAccount): RegistryAccountStatus {
  const hasToken = Boolean(account.accessToken);
  return {
    signedIn: hasToken,
    email: account.email || null,
    publisherHandle: account.publisherHandle,
    isConfirmed: account.isConfirmed,
    hasToken,
    token: hasToken ? MASKED_API_KEY : '',
  };
}

export async function getAccountStatus(): Promise<RegistryAccountStatus> {
  return toStatus(await loadStored());
}

/**
 * Sign up or log in. On success stores encrypted tokens; when the registry
 * reports the email is not yet confirmed, records a pending (token-less) account
 * and returns `confirmation_required` so the UI can prompt to confirm/resend.
 */
export async function authenticate(
  email: string,
  password: string,
  mode: RegistryAuthAction,
): Promise<RegistryAuthResult> {
  const call = mode === 'signup' ? client.signup : client.login;
  const { status, body } = await call(email, password);

  if (status === 0) {
    return { status: 'error', message: 'Could not reach the package registry.' };
  }

  // Signup with email confirmation (or a login before confirmation) returns no
  // session and asks the user to confirm their email first.
  const confirmationRequired =
    body?.needs_confirmation === true ||
    body?.is_confirmed === false ||
    (status === 403 && /confirm/i.test(body?.error || body?.message || '')) ||
    (mode === 'signup' && !body?.access_token && status >= 200 && status < 300);

  if (status >= 200 && status < 300 && body?.access_token) {
    const account = await storeTokens(email, body);
    return { status: 'authenticated', account: toStatus(account) };
  }

  if (confirmationRequired) {
    // Persist a pending account so the UI can show the "confirm your email"
    // banner and resend without re-typing the address. No tokens are stored.
    await persist({
      ...EMPTY_ACCOUNT,
      email: body?.email || email,
      isConfirmed: false,
    });
    return {
      status: 'confirmation_required',
      account: toStatus(await loadStored()),
      message: 'Check your inbox to confirm your email before publishing.',
    };
  }

  return {
    status: 'error',
    message: body?.error || body?.message || `Registry responded with status ${status}.`,
  };
}

/** Clear the stored account/tokens (log out). */
export async function logout(): Promise<void> {
  await persist({ ...EMPTY_ACCOUNT });
}

/** Resend the confirmation email for the stored (or provided) address. */
export async function resendConfirmation(email?: string): Promise<{ success: boolean; message?: string }> {
  const address = (email || (await loadStored()).email || '').trim();
  if (!address) {
    return { success: false, message: 'No email address on file to resend confirmation to.' };
  }
  const { status, body } = await client.resendConfirmation(address);
  if (status >= 200 && status < 300) return { success: true };
  return { success: false, message: body?.error || body?.message || `Registry responded with status ${status}.` };
}

/**
 * Run an authenticated registry call, decrypting the stored access token. On a
 * 401 it attempts one silent refresh (re-storing the rotated tokens) and
 * retries; if refresh fails it clears the tokens so the UI forces re-auth.
 * Throws `NotAuthenticatedError` when no token is stored.
 */
export class NotAuthenticatedError extends Error {
  constructor() {
    super('Not signed in to the package registry.');
    this.name = 'NotAuthenticatedError';
  }
}

async function withAccessToken<T>(
  call: (token: string) => Promise<client.RegistryHttpResponse<T>>,
): Promise<client.RegistryHttpResponse<T>> {
  const account = await loadStored();
  if (!account.accessToken) throw new NotAuthenticatedError();

  const accessToken = await decryptApiKey(account.accessToken);
  if (!accessToken) throw new NotAuthenticatedError();

  let result = await call(accessToken);
  if (result.status !== 401) return result;

  // Access token rejected — try a single silent refresh.
  if (account.refreshToken) {
    const refreshToken = await decryptApiKey(account.refreshToken);
    if (refreshToken) {
      const refreshed = await client.refresh(refreshToken);
      if (refreshed.status >= 200 && refreshed.status < 300 && refreshed.body?.access_token) {
        const updated = await storeTokens(account.email, {
          ...refreshed.body,
          // Preserve metadata the refresh response may omit.
          email: refreshed.body.email || account.email,
          publisher_handle: refreshed.body.publisher_handle ?? account.publisherHandle ?? undefined,
          is_confirmed: refreshed.body.is_confirmed ?? account.isConfirmed,
        });
        const freshToken = await decryptApiKey(updated.accessToken);
        if (freshToken) {
          result = await call(freshToken);
          return result;
        }
      }
    }
  }

  // Refresh unavailable or failed — force re-auth by clearing tokens.
  log.warn('Registry access token rejected and refresh failed; clearing stored session.');
  await logout();
  return result;
}

/** Map a registry publish HTTP status to a friendly result code. */
function mapPublishError(status: number, message: string): RegistryPublishResult {
  if (status === 401) return { ok: false, code: 'unauthorized', error: 'Your registry session expired. Please log in again.' };
  if (status === 403) return { ok: false, code: 'unconfirmed', error: 'Confirm your email address before publishing.' };
  if (status === 409) return { ok: false, code: 'name_collision', error: message || 'A package with this name/version already exists.' };
  if (status === 400 || status === 422) return { ok: false, code: 'validation', error: message || 'The package manifest was rejected by the registry.' };
  if (status === 0) return { ok: false, code: 'error', error: 'Could not reach the package registry.' };
  return { ok: false, code: 'error', error: message || `Registry responded with status ${status}.` };
}

/** Publish a manifest; requires a confirmed, signed-in account. */
export async function publish(manifest: unknown): Promise<RegistryPublishResult> {
  try {
    const { status, body } = await withAccessToken((token) => client.publishPackage(manifest, token));
    if (status >= 200 && status < 300) {
      return {
        ok: true,
        id: body?.id,
        name: body?.name,
        version: body?.version,
        url: body?.url,
      };
    }
    return mapPublishError(status, body?.error || body?.message || '');
  } catch (err) {
    if (err instanceof NotAuthenticatedError) {
      return { ok: false, code: 'not_authenticated', error: 'Sign in to the package registry before publishing.' };
    }
    log.error('Unexpected error publishing package', err instanceof Error ? err.message : err);
    return { ok: false, code: 'error', error: 'Unexpected error publishing package.' };
  }
}

/** Read the (non-secret) registry settings, filling the effective default. */
export async function getSettings(): Promise<{ baseUrl: string; usingDefault: boolean; defaultUrl: string }> {
  const settings = await loadItem<RegistrySettings>(StorageKey.REGISTRY_SETTINGS, {});
  const configured = settings?.baseUrl?.trim() || '';
  return {
    baseUrl: configured || DEFAULT_REGISTRY_URL,
    usingDefault: configured.length === 0,
    defaultUrl: DEFAULT_REGISTRY_URL,
  };
}

/** Validate + persist the registry base URL. Blank clears the override. */
export async function saveSettings(baseUrl: string): Promise<{ success: boolean; message?: string }> {
  const trimmed = (baseUrl || '').trim();
  if (trimmed) {
    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return { success: false, message: 'Registry URL must use http(s).' };
      }
    } catch {
      return { success: false, message: 'Registry URL is not a valid URL.' };
    }
  }
  await saveItem<RegistrySettings>(StorageKey.REGISTRY_SETTINGS, { baseUrl: trimmed });
  return { success: true };
}
