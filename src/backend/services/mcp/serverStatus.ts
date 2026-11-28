// The status the MCP page shows for one server: connected, connecting, needs approval or sign-in, or why it failed.
import { BundledFlujoWorkloadError } from '../security/bundledFlujoWorkload';
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createLogger } from "@/utils/logger";
import { MCPServerConfig, MCPStreamableConfig, MCPServiceResponse, MCPStdioOAuthStatus } from "@/shared/types/mcp";
import { hasOAuthIssuer } from "./oauth";
import { readOAuthTokens } from './oauthCredentialStorage';
import { getExternalAuthorizationStatus, serverSupportsExternalAuthorization } from "./externalAuthorization";

const log = createLogger('backend/services/mcp/serverStatus');

/** What the status report reads from the MCP service. Registries are read when used. */
export type ServerStatusHost = {
  getServerConfig(serverName: string): Promise<MCPServerConfig | null>;
  getClient(serverName: string): Client | undefined;
  isStartingUp(): boolean;
  approvalFailures(): Map<string, MCPServiceResponse>;
  stderrLogs(): Map<string, string[]>;
  lastConnectionError(): Map<string, string>;
  connectingServers(): Set<string>;
};

/**
 * Get the connection status of an MCP server
 */
export async function readServerStatus(host: ServerStatusHost, serverName: string): Promise<{
  status: string;
  message?: string;
  errorCode?: string;
  requiresApproval?: boolean;
  stderrOutput?: string;
  stdioOAuth?: MCPStdioOAuthStatus;
}> {
  // Get the config directly from storage
  const config = await host.getServerConfig(serverName);
  if (!config) {
    log.warn(`getServerStatus: Server ${serverName} not found`);
    return {
      status: "error",
      message: `Server ${serverName} configuration not found. The server may have been deleted or not properly configured.`,
    };
  }

  if (config.disabled) {
    log.debug(`getServerStatus: Server ${serverName} is disabled`);
    return { status: "disconnected" };
  }

  // A live client is authoritative: a server may be connected with a static
  // Authorization header even when an earlier OAuth-capability probe persisted
  // oauthScopes. In that mixed state, missing FLUJO-managed OAuth tokens must not
  // override the proven working connection with a stale auth-required badge.
  const hasLiveClient = !!host.getClient(serverName);
  const approvalFailure = host.approvalFailures().get(serverName);
  if (!hasLiveClient && approvalFailure) {
    return { status: 'requires_approval', message: approvalFailure.error,
      errorCode: approvalFailure.errorCode, requiresApproval: true };
  }

  // Check if this is a disconnected streamable server that requires OAuth but has no tokens
  if (config.transport === "streamable") {
    const streamableConfig = config as MCPStreamableConfig;
    if (
      !hasLiveClient &&
      streamableConfig.oauthScopes &&
      streamableConfig.oauthScopes.length > 0
    ) {
      // This server requires OAuth authentication
      const tokens = await readOAuthTokens(streamableConfig);
      if (
        !tokens ||
        !hasOAuthIssuer(tokens) ||
        !tokens.access_token
      ) {
        log.info(
          `getServerStatus: Server ${serverName} requires OAuth authentication but has no valid tokens`,
        );
        return {
          status: "requires_authentication",
          message:
            "OAuth authentication required. Click the authenticate button to complete the OAuth flow.",
        };
      }

      // An expired access token only means "re-authenticate" when there is no refresh
      // token to renew it with. With a refresh_token stored, the next connection attempt
      // refreshes silently (see MCPOAuthClientProvider.tokens), so fall through to the
      // real connection state instead of flashing the auth badge after every restart.
      const issuedAt = (tokens as typeof tokens & { issued_at?: number }).issued_at;
      if (
        !tokens.refresh_token &&
        tokens.expires_in &&
        issuedAt
      ) {
        const expiresIn = tokens.expires_in;
        const currentTime = Math.floor(Date.now() / 1000);
        const expirationTime = issuedAt + expiresIn;

        if (currentTime >= expirationTime) {
          log.info(
            `getServerStatus: OAuth tokens for ${serverName} have expired and no refresh token is available`,
          );
          return {
            status: "requires_authentication",
            message: "OAuth tokens have expired. Please re-authenticate.",
          };
        }
      }
    }
  }

  // Get any stderr logs for this server
  const stderrLogs = host.stderrLogs().get(serverName) || [];
  const stderrOutput = stderrLogs.join("\n").trim();
  // The last persisted connection failure (survives the per-attempt stderr buffer reset).
  const persistedError = host.lastConnectionError().get(serverName);
  let stdioOAuth: MCPStdioOAuthStatus | undefined;

  if (hasLiveClient) {
    const client = host.getClient(serverName);
    if (serverSupportsExternalAuthorization(client)) {
      try {
        stdioOAuth = await getExternalAuthorizationStatus(client, serverName);
        if (stdioOAuth.blockingAuthorization) {
          const requiredAuthorization = stdioOAuth.blockingAuthorization;
          return {
            status: "requires_authentication",
            message:
              requiredAuthorization.message ||
              `${requiredAuthorization.label} authorization is required before this server can be used by unattended flows.`,
            stderrOutput: stderrOutput || undefined,
            stdioOAuth,
          };
        }
      } catch (authorizationError) {
        if (authorizationError instanceof BundledFlujoWorkloadError) throw authorizationError;
        const detail =
          authorizationError instanceof Error
            ? authorizationError.message
            : String(authorizationError);
        return {
          status: "error",
          message: `Connected, but the mcp-stdio-oauth readiness check failed: ${detail}`,
          stderrOutput: stderrOutput || undefined,
        };
      }
    }
  }

  // Check if the client exists — via getClient so a closed/aborted connection reads
  // as "not connected" instead of lying "connected" until something trips over it.
  // The map itself is shared across module instances, so a client connected by the
  // startup instance is visible here without any adoption step.
  const clientExists = hasLiveClient || !!host.getClient(serverName);

  if (clientExists) {
    log.info(`getServerStatus: Server ${serverName} is connected`);
    return {
      status: "connected",
      stderrOutput: stderrOutput || undefined,
      ...(stdioOAuth ? { stdioOAuth } : {}),
    };
  } else {
    // The backend may still be bringing this server up - either an attempt is
    // in flight right now, or the initial startup sweep hasn't reached it yet
    // (it's still queued). Report a transient "connecting" state so the MCP page
    // shows a spinner and keeps polling, instead of the misleading
    // "configured but not connected" error the user would otherwise see for the
    // first few seconds after launch. A server that has already recorded a real
    // connection failure falls through to that error even during startup.
    const startupPending =
      host.isStartingUp() && !host.lastConnectionError().has(serverName);
    if (host.connectingServers().has(serverName) || startupPending) {
      log.info(`getServerStatus: Server ${serverName} is still connecting`);
      return {
        status: "connecting",
        message: "Server is starting up. This may take a few moments.",
      };
    }

    // Check if stderr contains OAuth authentication errors
    if (
      stderrOutput &&
      (stderrOutput.includes("OAuth authentication required") ||
        stderrOutput.includes("invalid_token"))
    ) {
      log.info(
        `getServerStatus: OAuth authentication error detected for ${serverName}`,
      );
      return {
        status: "requires_authentication",
        message:
          "OAuth authentication required. Please complete the OAuth flow.",
        stderrOutput: stderrOutput,
      };
    }

    // Use the live stderr output if present, otherwise the last persisted connection
    // error. HTTP transports fail inside connect() and produce no live stderr, so the
    // persisted error is what makes the real reason visible here.
    const effectiveError = stderrOutput || persistedError;
    if (effectiveError) {
      log.info(
        `getServerStatus: Using ${stderrOutput ? "stderr output" : "persisted connection error"} as error message for ${serverName}`,
      );
      return {
        status: "error",
        message: effectiveError,
        stderrOutput: stderrOutput || undefined,
      };
    }

    // No stderr and no persisted error. We deliberately do NOT spawn the server process
    // here to "capture an error" — that direct-execution probe ran with a 5s timeout PER
    // disconnected stdio server and was the dominant cost of loading the /mcp page (N
    // servers x up to 5s). The connection itself (and its real error) is established by
    // connectServer / the on-demand reconnect in listServerTools & callTool, which is
    // where errors get persisted. Just report the generic state instantly.
    log.info(
      `getServerStatus: No specific error details available for ${serverName}`,
    );
    return {
      status: "error",
      message: `Server ${serverName} is configured but not connected. The server process may have crashed or been terminated.`,
      stderrOutput: undefined,
    };
  }
}
