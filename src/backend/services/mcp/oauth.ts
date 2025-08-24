import { OAuthClientProvider, discoverOAuthMetadata, registerClient } from '@modelcontextprotocol/sdk/client/auth.js';
import { OAuthClientMetadata, OAuthClientInformation, OAuthTokens, OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import { createLogger } from '@/utils/logger';
import { MCPStreamableConfig } from '@/shared/types/mcp';

const log = createLogger('backend/services/mcp/oauth');

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

  clientInformation(): OAuthClientInformation | undefined {
    if (this.config.oauthClientInformation) {
      log.debug(`Returning stored client information for ${this.config.name}`);
      return this.config.oauthClientInformation;
    }
    
    // If we have client ID and secret from config, create client information
    if (this.config.oauthClientId) {
      const clientInfo: OAuthClientInformation = {
        client_id: this.config.oauthClientId,
        client_secret: this.config.oauthClientSecret,
      };
      log.debug(`Created client information from config for ${this.config.name}`);
      return clientInfo;
    }

    log.debug(`No client information available for ${this.config.name}`);
    return undefined;
  }

  async saveClientInformation(clientInformation: OAuthClientInformationFull): Promise<void> {
    log.info(`Saving client information for ${this.config.name}`);
    log.verbose('Client information to save', JSON.stringify(clientInformation));
    
    // Store in config (this will need to be persisted to storage)
    this.config.oauthClientInformation = {
      client_id: clientInformation.client_id,
      client_secret: clientInformation.client_secret,
      client_id_issued_at: clientInformation.client_id_issued_at,
      client_secret_expires_at: clientInformation.client_secret_expires_at,
    };
    
    // Also store the full metadata
    this.config.oauthClientMetadata = {
      redirect_uris: clientInformation.redirect_uris,
      client_name: clientInformation.client_name,
      client_uri: clientInformation.client_uri,
      grant_types: clientInformation.grant_types,
      response_types: clientInformation.response_types,
      token_endpoint_auth_method: clientInformation.token_endpoint_auth_method,
      scope: clientInformation.scope,
      contacts: clientInformation.contacts,
      tos_uri: clientInformation.tos_uri,
      policy_uri: clientInformation.policy_uri,
      jwks_uri: clientInformation.jwks_uri,
      jwks: clientInformation.jwks,
      software_id: clientInformation.software_id,
      software_version: clientInformation.software_version,
    };

    log.info(`Client information saved for ${this.config.name}`);
  }

  tokens(): OAuthTokens | undefined {
    if (this.config.oauthTokens) {
      log.debug(`Returning stored tokens for ${this.config.name}`);
      
      // Check if tokens are expired
      if (this.config.oauthTokens.expires_in && (this.config.oauthTokens as any).issued_at) {
        const issuedAt = (this.config.oauthTokens as any).issued_at;
        const expiresIn = this.config.oauthTokens.expires_in;
        const currentTime = Math.floor(Date.now() / 1000);
        const expirationTime = issuedAt + expiresIn;
        
        if (currentTime >= expirationTime) {
          log.warn(`Tokens for ${this.config.name} have expired (issued: ${issuedAt}, expires: ${expirationTime}, current: ${currentTime})`);
          // Clear expired tokens
          this.config.oauthTokens = undefined;
          return undefined;
        }
        
        log.debug(`Tokens for ${this.config.name} are valid (expires in ${expirationTime - currentTime} seconds)`);
      }
      
      return this.config.oauthTokens;
    }
    
    log.debug(`No tokens available for ${this.config.name}`);
    return undefined;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    log.info(`Saving OAuth tokens for ${this.config.name}`);
    log.verbose('Tokens to save', JSON.stringify({
      ...tokens,
      access_token: tokens.access_token ? '[REDACTED]' : undefined,
      refresh_token: tokens.refresh_token ? '[REDACTED]' : undefined,
    }));
    
    // Add timestamp for token expiration tracking
    const tokensWithTimestamp = {
      ...tokens,
      issued_at: Math.floor(Date.now() / 1000), // Unix timestamp
    };
    
    this.config.oauthTokens = tokensWithTimestamp;
    log.info(`OAuth tokens saved for ${this.config.name}`);
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    log.info(`Authorization required for ${this.config.name}`);
    log.info(`Authorization URL: ${authorizationUrl.toString()}`);
    
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
    this.config.oauthCodeVerifier = codeVerifier;
    log.debug(`Code verifier saved for ${this.config.name}`);
  }

  async codeVerifier(): Promise<string> {
    if (!this.config.oauthCodeVerifier) {
      const error = `No code verifier found for ${this.config.name}`;
      log.error(error);
      throw new Error(error);
    }
    
    log.debug(`Returning code verifier for ${this.config.name}`);
    return this.config.oauthCodeVerifier;
  }
}

/**
 * Create an OAuth client provider for a streamable MCP server config
 */
export function createOAuthClientProvider(
  config: MCPStreamableConfig,
  redirectUrl: string = 'http://localhost:4200/oauth/callback'
): MCPOAuthClientProvider {
  return new MCPOAuthClientProvider(config, redirectUrl);
}
