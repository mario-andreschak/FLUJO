import { OAuthClientProvider, type OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js';
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

  constructor(config: MCPStreamableConfig, redirectUrl: string, authorizationDiscovery?: OAuthDiscoveryState) {
    this.config = config;
    this.discovery = authorizationDiscovery;
    this._redirectUrl = redirectUrl;
    const stableCallback = new URL(redirectUrl);
    stableCallback.searchParams.delete('workspace');
    this.cimdRedirectUrl = stableCallback.toString();
    
    // Build client metadata from config
    this._clientMetadata = {
      redirect_uris: [redirectUrl],
      application_type: ['localhost', '127.0.0.1', '[::1]'].includes(new URL(redirectUrl).hostname) ? 'native' : 'web',
      client_name: `FLUJO MCP Client - ${config.name}`,
      client_uri: 'https://github.com/mario-andreschak/FLUJO',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'client_secret_post',
      scope: config.oauthScopes?.join(' ') || 'read',
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

  /** Preserve RFC9207 metadata also when the SDK's OIDC schema strips extra fields. */
  readonly oauthFetch: typeof fetch = async (input, init) => {
    const response = await fetch(input, init);
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
    if (state.authorizationServerMetadata?.issuer !== undefined
        && state.authorizationServerMetadata.issuer !== String(state.authorizationServerUrl)) {
      throw new Error('OAuth authorization metadata issuer does not match discovery');
    }
    this.discovery = this.observedIssuer === state.authorizationServerMetadata?.issuer
      ? { ...state, authorizationServerMetadata: { ...state.authorizationServerMetadata, authorization_response_iss_parameter_supported: this.issuerResponseSupported } } as OAuthDiscoveryState
      : state;
  }

  discoveryState(): OAuthDiscoveryState | undefined { return this.discovery; }

  async clientInformation(): Promise<OAuthClientInformation | undefined> {
    const storedClient = await readOAuthClientInformation(this.config);
    if (hasOAuthIssuer(storedClient)) {
      this.usingCimd = storedClient?.client_id === this.clientMetadataUrl;
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
    log.info(`OAuth tokens saved for ${this.config.name}`);
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    log.info(`Authorization required for ${this.config.name}`);

    // Older Slack connections contain the generic "read" default. Reconnect with
    // their existing grant instead of expanding to every scope advertised today.
    // Only scope names are reused; unbound access/refresh tokens stay withheld.
    if (knownOAuthIssuer(this.config.serverUrl)) {
      const configured = this.config.oauthScopes?.filter(Boolean);
      const previous = await readOAuthTokens(this.config);
      const scope = configured?.length && !(configured.length === 1 && configured[0] === 'read')
        ? configured.join(' ')
        : previous?.scope?.split(/[ ,]+/).filter(Boolean).join(' ');
      if (scope) authorizationUrl.searchParams.set('scope', scope);
    }
    
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
        let pendingUrl: URL | undefined;
        let expectedEndpoint: URL | undefined;
        try { pendingUrl = new URL(pending.authorizationUrl ?? ''); } catch { /* The first request may still be saving its URL. */ }
        try { expectedEndpoint = new URL(this.discovery?.authorizationServerMetadata?.authorization_endpoint
          ?? new URL('/authorize', this.discovery!.authorizationServerUrl).href); } catch { /* Unusable discovery cannot resume an authorization. */ }
        if (expectedEndpoint && pendingUrl?.searchParams.get('state') === pending.oauthState
            && pendingUrl.origin === expectedEndpoint.origin && pendingUrl.pathname === expectedEndpoint.pathname
            && pendingUrl.searchParams.get('redirect_uri') === this.redirectUrl
            && (!this.config.oauthClientId || pendingUrl.searchParams.get('client_id') === this.config.oauthClientId)) {
          Object.assign(this.config, {
            authorizationUrl: pendingUrl.toString(), oauthState: pending.oauthState,
            oauthStateWorkspace: pending.oauthStateWorkspace, oauthStateCreatedAt: pending.oauthStateCreatedAt,
            oauthStateDiscovery: pending.oauthStateDiscovery, oauthCodeVerifier: pending.oauthCodeVerifier,
          });
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
  redirectUrl: string = 'http://localhost:4200/api/oauth/callback',
  authorizationDiscovery?: OAuthDiscoveryState,
): MCPOAuthClientProvider {
  return new MCPOAuthClientProvider(config, redirectUrl, authorizationDiscovery);
}
