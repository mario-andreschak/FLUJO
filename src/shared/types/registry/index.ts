/**
 * Shared types for the FLUJO-side package-registry account handling (issue #197).
 *
 * The registry is a hosted service (issue #196, separate Supabase project) that
 * FLUJO talks to over HTTPS for sign-up/login, email-confirmation, and package
 * publishing. Browsing/installing stays anonymous; only publishing requires a
 * confirmed account.
 *
 * SECURITY: no type that crosses the network boundary to the browser may ever
 * carry a plaintext (or even encrypted) token. `RegistryAccountStatus` — the
 * only account shape returned to the frontend — exposes a boolean `hasToken`
 * plus a masked `token` field, never the value itself.
 */

/** Hardcoded production default; overridable via env or Settings (#196 not yet deployed). */
export const DEFAULT_REGISTRY_URL = 'https://registry.flujo.app';

/**
 * OAuth providers the hosted registry can broker sign-in through (issue #207).
 * The registry (#196) is the OAuth client that holds the provider secrets; FLUJO
 * only initiates against the registry and stores the registry token it returns,
 * so this list is display/scoping metadata rather than a provider integration.
 */
export type RegistryOAuthProvider = 'github' | 'google';

/** The OAuth providers FLUJO currently offers a sign-in button for (#207). */
export const REGISTRY_OAUTH_PROVIDERS: readonly RegistryOAuthProvider[] = ['github', 'google'];

/** Whether an arbitrary value is a supported registry OAuth provider (#207). */
export function isRegistryOAuthProvider(value: unknown): value is RegistryOAuthProvider {
  return typeof value === 'string' && (REGISTRY_OAUTH_PROVIDERS as readonly string[]).includes(value);
}

/**
 * The at-rest account record persisted under `StorageKey.REGISTRY_ACCOUNT`.
 * `accessToken`/`refreshToken` are ENCRYPTED strings (the `encrypted:` envelope
 * produced by the model-API-key encryption path); they are decrypted only
 * server-side at the moment of an authenticated call. Never returned to the UI.
 */
export interface StoredRegistryAccount {
  email: string;
  publisherHandle: string | null;
  isConfirmed: boolean;
  /** Unix ms when the access token expires, if the registry reported it. */
  expiresAt: number | null;
  /** Encrypted access token (`encrypted:...`) or empty when only pending confirmation. */
  accessToken: string;
  /** Encrypted refresh token (`encrypted:...`) or empty. */
  refreshToken: string;
  /** How the session was established (#207). Absent on legacy password records. */
  authMethod?: 'password' | 'oauth';
  /** OAuth providers linked to this account, for display/telemetry only (#207). */
  linkedProviders?: RegistryOAuthProvider[];
}

/** Non-secret registry settings persisted under `StorageKey.REGISTRY_SETTINGS`. */
export interface RegistrySettings {
  /** User-configured base URL; blank/absent means "use DEFAULT_REGISTRY_URL". */
  baseUrl?: string;
}

/** Masked account metadata safe to return to the browser. */
export interface RegistryAccountStatus {
  signedIn: boolean;
  email: string | null;
  publisherHandle: string | null;
  isConfirmed: boolean;
  /** True when an encrypted access token is stored. */
  hasToken: boolean;
  /** Always the mask (`********`) when a token exists, otherwise empty. */
  token: string;
  /** Providers linked to this account (display only; never a token) (#207). */
  linkedProviders?: RegistryOAuthProvider[];
}

export type RegistryAuthAction = 'signup' | 'login';

/** Result of a signup/login attempt (as surfaced to the frontend service). */
export interface RegistryAuthResult {
  status: 'authenticated' | 'confirmation_required' | 'error';
  account?: RegistryAccountStatus;
  /** Friendly, non-sensitive message for the UI. */
  message?: string;
}

/** Machine-readable publish failure reasons (mapped to friendly UI copy). */
export type RegistryPublishErrorCode =
  | 'unconfirmed'
  | 'name_collision'
  | 'validation'
  | 'unauthorized'
  | 'not_authenticated'
  | 'error';

/** Result of a publish attempt. */
export interface RegistryPublishResult {
  ok: boolean;
  id?: string;
  name?: string;
  version?: string;
  /** Public URL/id of the published package on success. */
  url?: string;
  error?: string;
  code?: RegistryPublishErrorCode;
}
