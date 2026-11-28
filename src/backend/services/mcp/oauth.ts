import { auth, discoverAuthorizationServerMetadata, extractWWWAuthenticateParams, OAuthClientProvider, type AuthResult, type OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js';
import { OAuthClientMetadata, OAuthClientInformation, OAuthTokens, OAuthClientInformationMixed } from '@modelcontextprotocol/sdk/shared/auth.js';
import { createLogger } from '@/utils/logger';
import { MCPStreamableConfig } from '@/shared/types/mcp';
import { loadServerConfigs, saveConfig } from './config';
import { resolveAndDecryptApiKey } from '@/backend/utils/resolveGlobalVars';
import { getCurrentWorkspace, getWorkspaceDataDir, normalizeWorkspaceName } from '@/utils/workspace';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { assertOAuthCredentialsAvailable, readOAuthClientInformation, readOAuthCodeVerifier, readOAuthTokens, sealOAuthCredential } from './oauthCredentialStorage';
import { resolveOAuthClientMetadataUrl } from './oauthClientMetadata';
import { isValidOAuthIssuer, knownOAuthIssuer } from '@/utils/mcp/oauthIssuer';

const log = createLogger('backend/services/mcp/oauth');

/** Authorization callbacks older than this must start a fresh flow. */
export const MCP_OAUTH_STATE_TTL_MS = 20 * 60 * 1000;

/** Callback of a background connection, which cannot know the address the browser uses. */
const DEFAULT_OAUTH_REDIRECT_URL = 'http://localhost:4200/api/oauth/callback';

const OAUTH_NONCE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

// Next route bundles and background MCP connections share the same process.
// Serialize credential and authorization writes across those module instances.
// Servers share one workspace config file, so the lock covers the whole file.
const authorizationLocks = globalThis as typeof globalThis & { __flujo_oauth_authorization_locks?: Map<string, Promise<void>> };
async function withAuthorizationLock<T>(operation: () => Promise<T>): Promise<T> {
  const locks = authorizationLocks.__flujo_oauth_authorization_locks ??= new Map();
  const key = getWorkspaceDataDir();
  const previous = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>(resolve => { release = resolve; });
  const queued = previous.then(() => current);
  locks.set(key, queued);
  await previous;
  try { return await operation(); }
  finally {
    release();
    if (locks.get(key) === queued) locks.delete(key);
  }
}

/** Routing hint only: the complete state still needs its persisted nonce/TTL check. */
export function oauthStateWorkspace(state: string | null): string | undefined {
  if (typeof state !== 'string' || !state || state.length > 108) return undefined;
  const parts = state.split('.');
  if (parts.length !== 2 || !OAUTH_NONCE_PATTERN.test(parts[1])) return undefined;
  try {
    const workspace = normalizeWorkspaceName(parts[0]);
    return workspace === parts[0] ? workspace : undefined;
  }
  catch { return undefined; }
}

function validOAuthState(state: string): boolean {
  return OAUTH_NONCE_PATTERN.test(state) || oauthStateWorkspace(state) !== undefined;
}

/**
 * FLUJO stores exactly ['read'] when it switches OAuth on by itself. No server asked for
 * that scope, so it must never reach an authorization server (MCP scope selection order:
 * challenge scope, then `scopes_supported`, else no scope parameter at all).
 */
export function configuredOAuthScope(scopes: readonly string[] | undefined): string | undefined {
  const named = scopes?.map(scope => scope.trim()).filter(Boolean) ?? [];
  if (named.length === 0 || (named.length === 1 && named[0] === 'read')) return undefined;
  return named.join(' ');
}

/** Token responses list scopes with spaces; Slack uses commas. */
function splitScope(scope: string | undefined): string[] {
  return scope?.split(/[ ,]+/).filter(Boolean) ?? [];
}

/** MCP requires S256 PKCE and says to verify it from the authorization server metadata. */
function assertPkceSupported(discovery: OAuthDiscoveryState | undefined): void {
  const methods = discovery?.authorizationServerMetadata?.code_challenge_methods_supported;
  if (Array.isArray(methods) && methods.includes('S256')) return;
  const error = new Error('This server\'s sign-in service does not confirm the S256 code check (PKCE) that MCP requires, so FLUJO did not open its sign-in page. Ask the server\'s provider to support S256.');
  error.name = 'OAuthPkceUnsupported';
  throw error;
}

const OAUTH_CHALLENGE_TIMEOUT_MS = 10_000;

/** Answers that mean "not now" rather than "no": the request is worth repeating shortly. */
const TRANSIENT_STATUSES = new Set([429, 502, 503, 504]);
const AUTHORIZATION_RETRY_DELAYS_MS = [250, 1000];
const MAX_RETRY_AFTER_MS = 5000;

function grantType(init: RequestInit | undefined): string | null {
  const body = init?.body;
  if (typeof body === 'string') return body.includes('grant_type=') ? new URLSearchParams(body).get('grant_type') : null;
  return Object.prototype.toString.call(body) === '[object URLSearchParams]' ? (body as URLSearchParams).get('grant_type') : null;
}

function retryAfterMs(response: Response): number | undefined {
  const header = response.headers.get('retry-after');
  if (!header) return undefined;
  const seconds = Number(header);
  const wait = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now();
  return Number.isFinite(wait) ? Math.min(Math.max(wait, 0), MAX_RETRY_AFTER_MS) : undefined;
}

const pause = (ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms); });

export interface OAuthChallenge { resourceMetadataUrl?: URL; scope?: string }

/**
 * Read the server's own 401 challenge, which MCP clients must prefer over well-known
 * addresses for the metadata location and the scopes to request. It is sent without
 * credentials and never follows redirects. Any other answer or failure returns nothing,
 * and the SDK falls back to the well-known addresses.
 */
export async function readOAuthChallenge(serverUrl: string, fetchFn: typeof fetch = fetch): Promise<OAuthChallenge> {
  try {
    const response = await fetchFn(serverUrl, {
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(OAUTH_CHALLENGE_TIMEOUT_MS),
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'flujo-oauth-challenge', method: 'ping' }),
    });
    await response.body?.cancel().catch(() => undefined);
    if (response.status !== 401 && response.status !== 403) return {};
    const { resourceMetadataUrl, scope } = extractWWWAuthenticateParams(response);
    return { ...(resourceMetadataUrl ? { resourceMetadataUrl } : {}), ...(scope ? { scope } : {}) };
  } catch {
    return {};
  }
}

/**
 * Start or resume a person-initiated sign-in the way a connection's 401 would. A sign-in
 * a connection already prepared (one more scope for a tool, or a grant the provider
 * revoked) is opened as it is: starting over would refresh the old grant and lose it.
 */
export async function startOAuthAuthorization(
  provider: MCPOAuthClientProvider,
  serverUrl: string,
  fetchFn: typeof fetch = provider.oauthFetch,
): Promise<AuthResult> {
  if (await provider.resumePendingAuthorization()) return 'REDIRECT';
  const challenge = await readOAuthChallenge(serverUrl, fetchFn);
  return auth(provider, { serverUrl, fetchFn, ...challenge });
}

const OAUTH_REVOCATION_TIMEOUT_MS = 5000;

/**
 * RFC 7009: when a person resets a sign-in, end the grant at the provider too, so the
 * refresh token FLUJO forgets cannot be used by anyone. Best effort: a provider without
 * a revocation endpoint, or one that does not answer, never blocks the reset.
 */
export async function revokeOAuthGrant(config: MCPStreamableConfig, fetchFn: typeof fetch = fetch): Promise<boolean> {
  const bounded: typeof fetch = (input, init) => fetchFn(input, { ...init, redirect: 'manual', signal: AbortSignal.timeout(OAUTH_REVOCATION_TIMEOUT_MS) });
  try {
    const tokens = await readOAuthTokens(config) as (OAuthTokens & { issuer?: string }) | undefined;
    const token = tokens?.refresh_token ?? tokens?.access_token;
    if (!token || !tokens?.issuer) return false;
    const metadata = await discoverAuthorizationServerMetadata(tokens.issuer, { fetchFn: bounded });
    const endpoint = metadata && 'revocation_endpoint' in metadata ? metadata.revocation_endpoint : undefined;
    if (typeof endpoint !== 'string') return false;
    const client = await createOAuthClientProvider(config).clientInformation();
    if (!client) return false;
    const body = new URLSearchParams({ token, token_type_hint: tokens.refresh_token ? 'refresh_token' : 'access_token' });
    const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
    const method = (client as { token_endpoint_auth_method?: string }).token_endpoint_auth_method;
    if (client.client_secret && method === 'client_secret_basic') {
      headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(client.client_id)}:${encodeURIComponent(client.client_secret)}`).toString('base64')}`;
    } else {
      body.set('client_id', client.client_id);
      if (client.client_secret) body.set('client_secret', client.client_secret);
    }
    const response = await bounded(endpoint, { method: 'POST', headers, body });
    await response.body?.cancel().catch(() => undefined);
    if (!response.ok) log.warn(`The provider did not revoke the OAuth grant for ${config.name} (HTTP ${response.status})`);
    return response.ok;
  } catch {
    // Provider and storage errors can carry credentials; log only that it failed.
    log.warn(`Could not revoke the OAuth grant for ${config.name} at the provider`);
    return false;
  }
}

/** Legacy credentials must complete a fresh authorization before they can be reused. */
export function hasOAuthIssuer(credential: { issuer?: unknown } | undefined): boolean {
  return typeof credential?.issuer === 'string' && credential.issuer.trim().length > 0;
}

/** Constant-time validation of the persisted, workspace-bound OAuth nonce. */
export function matchesOAuthState(
  config: MCPStreamableConfig,
  candidate: string,
  workspace: string,
  now = Date.now(),
): boolean {
  if (
    !validOAuthState(candidate)
    || !validOAuthState(config.oauthState ?? '')
    || !config.oauthState
    || config.oauthStateWorkspace !== workspace
    || (oauthStateWorkspace(candidate) !== undefined && oauthStateWorkspace(candidate) !== workspace)
    || typeof config.oauthStateCreatedAt !== 'number'
    || now - config.oauthStateCreatedAt < 0
    || now - config.oauthStateCreatedAt > MCP_OAUTH_STATE_TTL_MS
  ) return false;

  const expected = Buffer.from(config.oauthState);
  const received = Buffer.from(candidate);
  return expected.length === received.length && timingSafeEqual(expected, received);
}

/**
 * OAuth client provider implementation for MCP servers
 */
export class MCPOAuthClientProvider implements OAuthClientProvider {
  private config: MCPStreamableConfig;
  private _redirectUrl: string;
  private _clientMetadata: OAuthClientMetadata & { application_type: 'native' | 'web' };
  private discovery?: OAuthDiscoveryState;
  private observedIssuer?: string;
  private issuerResponseSupported?: boolean;
  private usingCimd = false;
  private readonly cimdRedirectUrl: string;
  /** Background connections do not know the browser's address; see clientInformation(). */
  private readonly redirectIsDefault: boolean;
  /** A refresh just failed because the sign-in service did not answer. */
  private refreshUnavailable = false;
  /** Scopes a 403 insufficient_scope answer asked for, until a new sign-in starts. */
  private stepUpScope?: string;
  /** Scopes of the stored grant, as last read. */
  private grantedScope?: string;

  constructor(config: MCPStreamableConfig, redirectUrl?: string, authorizationDiscovery?: OAuthDiscoveryState) {
    this.config = config;
    this.discovery = authorizationDiscovery;
    this.redirectIsDefault = redirectUrl === undefined;
    this._redirectUrl = redirectUrl ?? DEFAULT_OAUTH_REDIRECT_URL;
    const stableCallback = new URL(this._redirectUrl);
    stableCallback.searchParams.delete('workspace');
    this.cimdRedirectUrl = stableCallback.toString();
    
    const scope = configuredOAuthScope(config.oauthScopes);
    this._clientMetadata = {
      redirect_uris: [this._redirectUrl],
      application_type: ['localhost', '127.0.0.1', '[::1]'].includes(stableCallback.hostname) ? 'native' : 'web',
      client_name: `FLUJO MCP Client - ${config.name}`,
      client_uri: 'https://github.com/mario-andreschak/FLUJO',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'client_secret_post',
      ...(scope ? { scope } : {}),
    };

    log.info(`Created OAuth client provider for ${config.name}`);
    log.verbose('OAuth client metadata', JSON.stringify(this._clientMetadata));
  }

  get redirectUrl(): string {
    return this.usingCimd ? this.cimdRedirectUrl : this._redirectUrl;
  }

  /** The SDK selects CIMD ahead of DCR when the authorization server supports it. */
  get clientMetadataUrl(): string | undefined {
    return resolveOAuthClientMetadataUrl(this.cimdRedirectUrl);
  }

  get clientMetadata(): OAuthClientMetadata {
    return this.usingCimd
      ? { ...this._clientMetadata, redirect_uris: [this.cimdRedirectUrl], token_endpoint_auth_method: 'none' }
      : this._clientMetadata;
  }

  /** CIMD keeps the callback stable; its state carries a workspace plus a random nonce. */
  state(): string {
    // The SDK asks for state only when it starts a new authorization, never for refresh.
    // After a refresh the provider could not answer, the grant is still good: a new
    // consent page would not help (it needs the same token endpoint) and would make the
    // person sign in again. Fail like any connection error, so the caller retries.
    if (this.refreshUnavailable) {
      const error = new Error(`The sign-in service for ${this.config.name} did not answer. FLUJO kept the existing sign-in and tries again shortly.`);
      error.name = 'OAuthRefreshUnavailable';
      throw error;
    }
    // A server that refuses a scope the grant already has would refuse it again after
    // another consent; asking the person to sign in once more would only loop.
    if (this.stepUpScope && this.grantedScope !== undefined) {
      const granted = splitScope(this.grantedScope);
      if (splitScope(this.stepUpScope).every(scope => granted.includes(scope))) {
        const error = new Error(`${this.config.name} refused the request although FLUJO's sign-in already includes the permission it asks for (${this.stepUpScope}). Signing in again would not change that; check the account's access with the server's provider.`);
        error.name = 'OAuthScopeRefused';
        throw error;
      }
    }
    assertPkceSupported(this.discovery);
    const nonce = randomBytes(32).toString('base64url');
    const workspace = getCurrentWorkspace();
    const state = this.usingCimd ? `${workspace}.${nonce}` : nonce;
    this.config.oauthState = state;
    this.config.oauthStateWorkspace = workspace;
    this.config.oauthStateCreatedAt = Date.now();
    this.config.oauthStateDiscovery = this.discovery;
    this.config.authorizationUrl = undefined;
    return state;
  }

  /**
   * Every request of this connection and its sign-in goes through here. Discovery and
   * token requests that meet a busy or briefly unavailable sign-in service are repeated
   * a few times; MCP requests never are. It also notes a refresh that failed for that
   * reason, a step-up challenge, and RFC 9207 metadata the SDK's OIDC schema strips.
   */
  readonly oauthFetch: typeof fetch = async (input, init) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const href = typeof input === 'string' ? input : 'href' in input ? input.href : input.url;
    const grant = method === 'POST' ? grantType(init) : null;
    const repeatable = grant !== null || (method === 'GET' && href.includes('/.well-known/'));
    let response: Response;
    for (let attempt = 0; ; attempt += 1) {
      try {
        response = await fetch(input, init);
      } catch (error) {
        if (grant === 'refresh_token') this.refreshUnavailable = true;
        if (!repeatable || grant !== null || attempt >= AUTHORIZATION_RETRY_DELAYS_MS.length) throw error;
        await pause(AUTHORIZATION_RETRY_DELAYS_MS[attempt]);
        continue;
      }
      if (!repeatable || !TRANSIENT_STATUSES.has(response.status) || attempt >= AUTHORIZATION_RETRY_DELAYS_MS.length) break;
      await response.body?.cancel().catch(() => undefined);
      await pause(retryAfterMs(response) ?? AUTHORIZATION_RETRY_DELAYS_MS[attempt]);
    }
    if (grant === 'refresh_token') this.refreshUnavailable = response.status >= 500 || TRANSIENT_STATUSES.has(response.status);
    if (response.status === 403) {
      const { error, scope } = extractWWWAuthenticateParams(response);
      if (error === 'insufficient_scope' && scope) this.stepUpScope = scope;
    }
    if (response.ok && response.headers.get('content-type')?.includes('json')) {
      try {
        const metadata = await response.clone().json() as Record<string, unknown>;
        if (typeof metadata.issuer === 'string' && typeof metadata.authorization_endpoint === 'string'
            && typeof metadata.token_endpoint === 'string') {
          this.observedIssuer = metadata.issuer;
          this.issuerResponseSupported = metadata.authorization_response_iss_parameter_supported === true;
        }
      } catch { /* SDK parsing remains authoritative for malformed responses. */ }
    }
    return response;
  };

  /** Keep discovery only for the current transaction, never as a cross-issuer cache. */
  saveDiscoveryState(state: OAuthDiscoveryState): void {
    const issuer = state.authorizationServerMetadata?.issuer;
    if (issuer !== undefined && !this.issuerMatchesDiscovery(issuer, String(state.authorizationServerUrl))) {
      throw new Error('OAuth authorization metadata issuer does not match discovery');
    }
    this.discovery = this.observedIssuer === state.authorizationServerMetadata?.issuer
      ? { ...state, authorizationServerMetadata: { ...state.authorizationServerMetadata, authorization_response_iss_parameter_supported: this.issuerResponseSupported } } as OAuthDiscoveryState
      : state;
  }

  /**
   * RFC 8414 §3.3: the issuer must equal the identifier the metadata address was built
   * from. Servers without protected resource metadata make the SDK build it from the
   * server origin as "https://host/"; the same address belongs to issuer "https://host".
   */
  private issuerMatchesDiscovery(issuer: string, discovered: string): boolean {
    if (issuer === discovered) return true;
    const server = new URL(this.config.serverUrl);
    return discovered === new URL('/', server).href && issuer === server.origin;
  }

  discoveryState(): OAuthDiscoveryState | undefined { return this.discovery; }

  /** Scopes this authorization server already granted, so a step-up keeps them. */
  private async grantedScopes(): Promise<string[]> {
    const issuer = this.discovery?.authorizationServerUrl;
    if (issuer === undefined) return [];
    try {
      const previous = await readOAuthTokens(this.config) as (OAuthTokens & { issuer?: string }) | undefined;
      return previous?.issuer === String(issuer) ? splitScope(previous.scope) : [];
    } catch {
      return [];
    }
  }

  async clientInformation(): Promise<OAuthClientInformation | undefined> {
    const storedClient = await readOAuthClientInformation(this.config);
    if (storedClient && hasOAuthIssuer(storedClient)) {
      this.usingCimd = storedClient.client_id === this.clientMetadataUrl;
      // A background connection that has to start a sign-in (one more scope, a revoked
      // grant) must use the callback this client registered; the authorization server
      // compares it exactly.
      const registered = 'redirect_uris' in storedClient && Array.isArray(storedClient.redirect_uris)
        ? storedClient.redirect_uris.filter((uri): uri is string => typeof uri === 'string') : [];
      if (this.redirectIsDefault && !this.usingCimd && registered.length > 0 && !registered.includes(this._redirectUrl)) {
        this._redirectUrl = registered[0];
      }
      log.debug(`Returning stored client information for ${this.config.name}`);
      return storedClient;
    }

    // Manually pre-registered client (e.g. Asana V2, which disables dynamic registration).
    // The stored secret may be encrypted ("encrypted:...") or a "${global:VAR}" binding, so
    // resolve+decrypt it here — the plaintext only ever exists in the backend, at use time.
    if (this.config.oauthClientId) {
      // Existing Slack clients predate issuer binding. Use its reviewed application
      // trust anchor when unset; never pin old credentials to arbitrary discovery.
      // An explicit nonempty issuer still takes precedence and is not normalized.
      const issuer = this.config.oauthIssuer || knownOAuthIssuer(this.config.serverUrl);
      if (!isValidOAuthIssuer(issuer)) {
        const error = new Error('OAuth authentication required. Open this connection\'s settings and enter the Authorization server URL supplied by your provider, then select Save & Authenticate.');
        error.name = 'OAuthIssuerRequired';
        throw error;
      }
      const clientSecret = this.config.oauthClientSecret
        ? await (async () => {
          await assertOAuthCredentialsAvailable();
          const value = await resolveAndDecryptApiKey(this.config.oauthClientSecret!);
          if (!value || value === '********' || value.startsWith('encrypted:') || value.includes('${global:')) {
            throw new Error('Stored OAuth credentials are unavailable. Unlock this workspace or restore matching credentials.');
          }
          return value;
        })()
        : undefined;
      log.debug(`Created client information from config for ${this.config.name}`);
      return {
        client_id: this.config.oauthClientId,
        client_secret: clientSecret,
        issuer,
      };
    }

    log.debug(`No client information available for ${this.config.name}`);
    return undefined;
  }

  /**
   * Write this.config's current OAuth fields back to the on-disk server list.
   *
   * The SDK's `auth()` flow calls `saveTokens`/`saveClientInformation`/`saveCodeVerifier`
   * as pure in-memory setters - it has no idea FLUJO's config needs to hit storage. Without
   * this, a token the SDK silently refreshes mid-connection (e.g. after a 401) lives only in
   * this transient config object and is discarded once the connection attempt's stack
   * unwinds. The next reconnect reloads the OLD refresh token from disk and presents it to
   * the authorization server - which has already rotated past it - producing a permanent
   * "invalid refresh_token" failure that no amount of retrying can fix.
   */
  private async persist(update: Partial<MCPStreamableConfig>): Promise<void> {
    await withAuthorizationLock(() => this.persistWithinLock(update));
  }

  private async persistWithinLock(update: Partial<MCPStreamableConfig>): Promise<void> {
    try {
      const configs = await loadServerConfigs();
      if (!Array.isArray(configs)) throw new Error('OAuth storage unavailable');
      const configMap = new Map(configs.map(c => [c.name, c]));
      // Stage replacements instead of mutating the active credentials before
      // storage acknowledges the save. A failed refresh is not durable success.
      // A reconnect may hold an older config object than the interactive route.
      // Merge only this write into the latest record so refresh/registration
      // cannot roll back another request's pending nonce, verifier or tokens.
      const current = configMap.get(this.config.name);
      if (current && current.transport !== 'streamable') throw new Error('OAuth server configuration changed');
      configMap.set(this.config.name, { ...(current ?? this.config), ...update });
      const result = await saveConfig(configMap);
      if (!result.success) throw new Error('OAuth storage unavailable');
      Object.assign(this.config, update);
    } catch {
      // Storage/provider errors can contain credentials. Do not log their text
      // or attach them as a cause that another logger might render.
      log.warn(`OAuth credential persistence failed for ${this.config.name}`);
      throw new Error('OAuth credential persistence failed. Authorization may need to be repeated after storage is available.');
    }
  }

  /**
   * Clear credentials the authorization server has rejected, so the next status check
   * correctly reports "requires authentication" instead of retrying dead tokens forever.
   */
  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): Promise<void> {
    log.info(`Invalidating OAuth credentials for ${this.config.name} (scope: ${scope})`);
    const update: Partial<MCPStreamableConfig> = {};

    if (scope === 'all' || scope === 'tokens') {
      update.oauthTokens = undefined;
    }
    if (scope === 'all' || scope === 'client') {
      update.oauthClientInformation = undefined;
      update.oauthClientMetadata = undefined;
    }
    if (scope === 'all' || scope === 'verifier') {
      update.oauthCodeVerifier = undefined;
      update.oauthState = undefined;
      update.oauthStateWorkspace = undefined;
      update.oauthStateCreatedAt = undefined;
      update.oauthStateDiscovery = undefined;
      update.authorizationUrl = undefined;
    }
    if (scope === 'all' || scope === 'discovery') this.discovery = undefined;

    await this.persist(update);
    if (scope === 'all' || scope === 'client') this.usingCimd = false;
  }

  async saveClientInformation(clientInformation: OAuthClientInformationMixed): Promise<void> {
    log.info(`Saving client information for ${this.config.name}`);
    log.verbose('Client information to save', { hasClientSecret: Boolean(clientInformation.client_secret) });
    
    // Merge a narrower SDK save without losing encrypted registration metadata.
    const previous = await readOAuthClientInformation(this.config);
    const sameClient = previous?.client_id === clientInformation.client_id && previous?.issuer === clientInformation.issuer;
    const registration = sameClient
      ? { ...this.config.oauthClientMetadata, ...previous, ...clientInformation }
      : { ...clientInformation };
    const oauthClientInformation = await sealOAuthCredential('client', registration);
    await this.persist({ oauthClientInformation, oauthClientMetadata: undefined });
    this.usingCimd = clientInformation.client_id === this.clientMetadataUrl;
    log.info(`Client information saved for ${this.config.name}`);
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    const tokens = await readOAuthTokens(this.config);
    if (tokens && hasOAuthIssuer(tokens)) {
      log.debug(`Returning stored tokens for ${this.config.name}`);

      // An expired access token must still be returned WITH its refresh_token intact:
      // the SDK's auth() only attempts the silent refresh_token grant when tokens()
      // yields one. Clearing the token set here (as this method once did) destroys the
      // refresh token and forces a full interactive re-auth after every access-token
      // lifetime (~1h for Asana), even though the grant is still perfectly valid.
      const issuedAt = (tokens as OAuthTokens & { issued_at?: number }).issued_at;
      if (tokens.expires_in && issuedAt) {
        const expiresIn = tokens.expires_in;
        const currentTime = Math.floor(Date.now() / 1000);
        const expirationTime = issuedAt + expiresIn;

        if (currentTime >= expirationTime) {
          log.info(`Access token for ${this.config.name} has expired (issued: ${issuedAt}, expires: ${expirationTime}, current: ${currentTime}); SDK will refresh via refresh_token`);
        } else {
          log.debug(`Tokens for ${this.config.name} are valid (expires in ${expirationTime - currentTime} seconds)`);
        }
      }

      this.grantedScope = tokens.scope;
      // Step-up: a refresh can never add a scope. Without its refresh token the v1 SDK
      // starts the new authorization the challenge asked for (v2 already does).
      if (this.stepUpScope) {
        const granted = splitScope(tokens.scope);
        if (splitScope(this.stepUpScope).some(scope => !granted.includes(scope))) return { ...tokens, refresh_token: undefined };
      }
      return tokens;
    }

    log.debug(`No tokens available for ${this.config.name}`);
    return undefined;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    log.info(`Saving OAuth tokens for ${this.config.name}`);
    // Unknown extension fields can also be secrets (for example id_token).
    // Log fixed presence flags, never a spread of the provider payload.
    log.verbose('Tokens to save', {
      hasAccessToken: Boolean(tokens.access_token), hasRefreshToken: Boolean(tokens.refresh_token),
    });
    
    // Add timestamp for token expiration tracking
    const tokensWithTimestamp = {
      ...tokens,
      issued_at: Math.floor(Date.now() / 1000), // Unix timestamp
    };
    
    await this.persist({ oauthTokens: await sealOAuthCredential('tokens', tokensWithTimestamp) });
    this.stepUpScope = undefined;
    log.info(`OAuth tokens saved for ${this.config.name}`);
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    log.info(`Authorization required for ${this.config.name}`);

    // Older Slack connections contain the generic "read" default. Reconnect with
    // their existing grant instead of expanding to every scope advertised today.
    // Only scope names are reused; unbound access/refresh tokens stay withheld.
    if (knownOAuthIssuer(this.config.serverUrl)) {
      const previous = await readOAuthTokens(this.config);
      const scope = configuredOAuthScope(this.config.oauthScopes) ?? splitScope(previous?.scope).join(' ');
      if (scope) authorizationUrl.searchParams.set('scope', scope);
    }

    // Step-up: request the challenged scopes together with those this authorization
    // server already granted, so one more permission does not drop the others.
    const requested = authorizationUrl.searchParams.get('scope')?.split(' ').filter(Boolean) ?? [];
    if (requested.length > 0) {
      const added = [...new Set(await this.grantedScopes())].filter(scope => !requested.includes(scope));
      if (added.length > 0) authorizationUrl.searchParams.set('scope', [...requested, ...added].join(' '));
    }
    this.stepUpScope = undefined;
    
    // Persist the URL with its nonce/verifier, so another reconnect can reuse the
    // pending sign-in instead of invalidating a consent page already open.
    await withAuthorizationLock(async () => {
      const configs = await loadServerConfigs();
      const current = Array.isArray(configs) ? configs.find(config => config.name === this.config.name) as MCPStreamableConfig | undefined : undefined;
      if (this.config.oauthState && current?.oauthState !== this.config.oauthState) {
        throw new Error('Sign-in was restarted or cancelled. Select Authenticate again.');
      }
      await this.persistWithinLock({ authorizationUrl: authorizationUrl.toString() });
    });
    
    // Throw a specific error that indicates OAuth authentication is required
    // This will be caught by the connection logic and handled appropriately
    const error = new Error(`OAuth authentication required for ${this.config.name}. Please complete the OAuth flow.`);
    error.name = 'OAuthAuthenticationRequired';
    throw error;
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    log.debug(`Saving code verifier for ${this.config.name}`);
    await withAuthorizationLock(async () => {
      const configs = await loadServerConfigs();
      const pending = Array.isArray(configs) ? configs.find(config => config.name === this.config.name) as MCPStreamableConfig | undefined : undefined;
      if (pending?.oauthState && pending.oauthState !== this.config.oauthState
          && pending.serverUrl === this.config.serverUrl
          && matchesOAuthState(pending, pending.oauthState, getCurrentWorkspace())
          && pending.oauthStateDiscovery?.authorizationServerUrl === this.discovery?.authorizationServerUrl) {
        if (this.adoptOpenAuthorization(pending, this.discovery)) {
          const error = new Error(`OAuth authentication required for ${this.config.name}. Complete the pending sign-in.`);
          error.name = 'OAuthAuthenticationRequired';
          throw error;
        }
        if (!pending.authorizationUrl && Date.now() - pending.oauthStateCreatedAt! < 10_000) {
          const error = new Error('OAuth authentication required. Sign-in is starting. Select Authenticate again in a moment.');
          error.name = 'OAuthAuthorizationInProgress';
          throw error;
        }
      }
      await this.persistWithinLock({
        oauthCodeVerifier: await sealOAuthCredential('verifier', codeVerifier),
        oauthState: this.config.oauthState,
        oauthStateWorkspace: this.config.oauthStateWorkspace,
        oauthStateCreatedAt: this.config.oauthStateCreatedAt,
        oauthStateDiscovery: this.config.oauthStateDiscovery,
        authorizationUrl: undefined,
      });
    });
    log.debug(`Code verifier saved for ${this.config.name}`);
  }

  /**
   * Take over a stored sign-in when it is one FLUJO started for this server and the
   * person can still finish it: same server, same authorization endpoint and callback,
   * its state still valid and its code verifier saved.
   */
  private adoptOpenAuthorization(pending: MCPStreamableConfig, discovery: OAuthDiscoveryState | undefined): boolean {
    if (!pending.oauthState || !pending.oauthCodeVerifier || !discovery || pending.serverUrl !== this.config.serverUrl
        || pending.oauthStateDiscovery?.authorizationServerUrl !== discovery.authorizationServerUrl
        || !matchesOAuthState(pending, pending.oauthState, getCurrentWorkspace())) return false;
    let url: URL;
    let endpoint: URL;
    try {
      url = new URL(pending.authorizationUrl ?? '');
      endpoint = new URL(discovery.authorizationServerMetadata?.authorization_endpoint
        ?? new URL('/authorize', discovery.authorizationServerUrl).href);
    } catch {
      return false; // The first request may still be saving its URL.
    }
    const clientId = url.searchParams.get('client_id');
    const callback = clientId !== null && clientId === this.clientMetadataUrl ? this.cimdRedirectUrl : this.redirectUrl;
    if (url.searchParams.get('state') !== pending.oauthState || url.origin !== endpoint.origin
        || url.pathname !== endpoint.pathname || url.searchParams.get('redirect_uri') !== callback
        || (this.config.oauthClientId && clientId !== this.config.oauthClientId)) return false;
    Object.assign(this.config, {
      authorizationUrl: url.toString(), oauthState: pending.oauthState,
      oauthStateWorkspace: pending.oauthStateWorkspace, oauthStateCreatedAt: pending.oauthStateCreatedAt,
      oauthStateDiscovery: pending.oauthStateDiscovery, oauthCodeVerifier: pending.oauthCodeVerifier,
    });
    return true;
  }

  /** Reuse a sign-in a connection already prepared for this server; see startOAuthAuthorization. */
  async resumePendingAuthorization(): Promise<boolean> {
    const configs = await loadServerConfigs();
    const pending = Array.isArray(configs)
      ? configs.find(config => config.name === this.config.name) as MCPStreamableConfig | undefined : undefined;
    return pending?.transport === 'streamable' && this.adoptOpenAuthorization(pending, pending.oauthStateDiscovery);
  }

  async codeVerifier(): Promise<string> {
    if (!this.config.oauthCodeVerifier) {
      const error = `No code verifier found for ${this.config.name}`;
      log.error(error);
      throw new Error(error);
    }
    
    log.debug(`Returning code verifier for ${this.config.name}`);
    return readOAuthCodeVerifier(this.config);
  }
}

/**
 * Create an OAuth client provider for a streamable MCP server config
 */
export function createOAuthClientProvider(
  config: MCPStreamableConfig,
  redirectUrl?: string,
  authorizationDiscovery?: OAuthDiscoveryState,
): MCPOAuthClientProvider {
  return new MCPOAuthClientProvider(config, redirectUrl, authorizationDiscovery);
}
