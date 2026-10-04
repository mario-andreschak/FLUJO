import { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { OAuthClientMetadata, OAuthClientInformation, OAuthTokens, OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import { createLogger } from '@/utils/logger';
import { MCPStreamableConfig } from '@/shared/types/mcp';
import { loadServerConfigs, saveConfig } from './config';
import { resolveAndDecryptApiKey } from '@/backend/utils/resolveGlobalVars';
import { getCurrentWorkspace } from '@/utils/workspace';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { assertOAuthCredentialsAvailable, readOAuthClientInformation, readOAuthCodeVerifier, readOAuthTokens, sealOAuthCredential } from './oauthCredentialStorage';

const log = createLogger('backend/services/mcp/oauth');

/** Authorization callbacks older than this must start a fresh flow. */
export const MCP_OAUTH_STATE_TTL_MS = 20 * 60 * 1000;

/** Constant-time validation of the persisted, workspace-bound OAuth nonce. */
export function matchesOAuthState(
  config: MCPStreamableConfig,
  candidate: string,
  workspace: string,
  now = Date.now(),
): boolean {
  if (
    !/^[A-Za-z0-9_-]{43}$/.test(candidate)
    || !/^[A-Za-z0-9_-]{43}$/.test(config.oauthState ?? '')
    || !config.oauthState
    || config.oauthStateWorkspace !== workspace
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
  private _clientMetadata: OAuthClientMetadata;

  constructor(config: MCPStreamableConfig, redirectUrl: string) {
    this.config = config;
    this._redirectUrl = redirectUrl;
    
    // Build client metadata from config
    this._clientMetadata = {
      redirect_uris: [redirectUrl],
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
    return this._redirectUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return this._clientMetadata;
  }

  /** Create an opaque callback nonce. saveCodeVerifier() persists it before redirect. */
  state(): string {
    const state = randomBytes(32).toString('base64url');
    this.config.oauthState = state;
    this.config.oauthStateWorkspace = getCurrentWorkspace();
    this.config.oauthStateCreatedAt = Date.now();
    return state;
  }

  async clientInformation(): Promise<OAuthClientInformation | undefined> {
    if (this.config.oauthClientInformation) {
      log.debug(`Returning stored client information for ${this.config.name}`);
      return readOAuthClientInformation(this.config);
    }

    // Manually pre-registered client (e.g. Asana V2, which disables dynamic registration).
    // The stored secret may be encrypted ("encrypted:...") or a "${global:VAR}" binding, so
    // resolve+decrypt it here — the plaintext only ever exists in the backend, at use time.
    if (this.config.oauthClientId) {
      if (this.config.oauthClientSecret) await assertOAuthCredentialsAvailable();
      const clientSecret = this.config.oauthClientSecret
        ? (await resolveAndDecryptApiKey(this.config.oauthClientSecret)) ?? undefined
        : undefined;
      log.debug(`Created client information from config for ${this.config.name}`);
      return {
        client_id: this.config.oauthClientId,
        client_secret: clientSecret,
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
    try {
      const configs = await loadServerConfigs();
      if (!Array.isArray(configs)) throw new Error('OAuth storage unavailable');
      const configMap = new Map(configs.map(c => [c.name, c]));
      // Stage replacements instead of mutating the active credentials before
      // storage acknowledges the save. A failed refresh is not durable success.
      configMap.set(this.config.name, { ...this.config, ...update });
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
    }
    // Note: scope 'discovery' is a no-op — FLUJO does not cache OAuth discovery state;
    // the SDK's auth() re-discovers (RFC 9728) on each call, so there is nothing to clear.

    await this.persist(update);
  }

  async saveClientInformation(clientInformation: OAuthClientInformationFull): Promise<void> {
    log.info(`Saving client information for ${this.config.name}`);
    log.verbose('Client information to save', { hasClientSecret: Boolean(clientInformation.client_secret) });
    
    // Full registration metadata may contain private JWKS or provider extensions.
    // Retain it inside the encrypted value instead of copying it to public fields.
    const oauthClientInformation = await sealOAuthCredential('client', clientInformation);
    await this.persist({ oauthClientInformation, oauthClientMetadata: undefined });
    log.info(`Client information saved for ${this.config.name}`);
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    if (this.config.oauthTokens) {
      log.debug(`Returning stored tokens for ${this.config.name}`);
      const tokens = await readOAuthTokens(this.config);
      if (!tokens) return undefined;

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
    
    // Store the authorization URL in the config for the frontend to use
    this.config.authorizationUrl = authorizationUrl.toString();
    
    // Throw a specific error that indicates OAuth authentication is required
    // This will be caught by the connection logic and handled appropriately
    const error = new Error(`OAuth authentication required for ${this.config.name}. Please complete the OAuth flow.`);
    error.name = 'OAuthAuthenticationRequired';
    throw error;
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    log.debug(`Saving code verifier for ${this.config.name}`);
    await this.persist({ oauthCodeVerifier: await sealOAuthCredential('verifier', codeVerifier) });
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
  redirectUrl: string = 'http://localhost:4200/api/oauth/callback'
): MCPOAuthClientProvider {
  return new MCPOAuthClientProvider(config, redirectUrl);
}
