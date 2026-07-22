import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { WebSocketClientTransport } from '@modelcontextprotocol/sdk/client/websocket.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
// eslint-disable-next-line import/named
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs/promises';
import path from 'path';
import { createLogger } from '@/utils/logger';
import { getDataDir } from '@/utils/paths';
import { runWithConcurrency } from './utils/boundedConcurrency';

// MCP connection state must be PROCESS-global, never per module instance: Next.js
// evaluates this module once per module graph (route bundles, the instrumentation/
// scheduler graph, every dev hot reload), so `export const mcpService = new MCPService()`
// yields several coexisting instances. A live client wraps process-wide state (an OS
// child process or an HTTP session), so all instances must share ONE map of them.
declare global {
  // THE client map, keyed by server name — the single source of truth every MCPService
  // instance reads and writes through its `clients` getter. Historically each instance
  // had a private map seeded once from a global "recovery" map; that private copy is
  // exactly what caused the poisoned-client bug: one instance tearing down a client
  // (e.g. after an OAuth token refresh changed the transport's config key) left every
  // other instance holding the closed client, whose aborted transport made each tool
  // call fail instantly with "This operation was aborted" until FLUJO was restarted.
  // eslint-disable-next-line no-var
  var __mcp_clients: Map<string, Client> | undefined;
  // Names of servers whose connection attempt is currently in flight (initial
  // startup sweep or a reconnect). Global-backed for the same reason as
  // __mcp_clients: the module instance that starts the servers may not be the
  // one that later serves getServerStatus(), and the status route must still be
  // able to see that a startup is in progress so it can report "connecting"
  // instead of a misleading "configured but not connected" error.
  // eslint-disable-next-line no-var
  var __mcp_connecting: Set<string> | undefined;
  // True from process boot until startEnabledServers() finishes its first sweep.
  // eslint-disable-next-line no-var
  var __mcp_starting_up: boolean | undefined;
  // The CURRENT transport per server name. onclose/onerror handlers close over the
  // transport they were registered on and fire for ANY instance — including a zombie
  // process exiting minutes after it was replaced, and closes FLUJO itself initiated.
  // A handler may only clean up / schedule reconnection when its transport IS the one
  // registered here; FLUJO-initiated closes deregister BEFORE closing, so their close
  // events are ignored. Global-backed for the same cross-module-instance reason as
  // __mcp_clients.
  // eslint-disable-next-line no-var
  var __mcp_active_transports: Map<string, Transport> | undefined;
}

// Initialize the global client map if it doesn't exist
if (typeof global.__mcp_clients === 'undefined') {
  global.__mcp_clients = new Map<string, Client>();
}
if (typeof global.__mcp_connecting === 'undefined') {
  global.__mcp_connecting = new Set<string>();
}
if (typeof global.__mcp_starting_up === 'undefined') {
  global.__mcp_starting_up = true;
}
if (typeof global.__mcp_active_transports === 'undefined') {
  global.__mcp_active_transports = new Map<string, Transport>();
}

// Import from backend modules
import { MCPServerConfig, MCPStreamableConfig, MCPSSEConfig, MCPHeaderValue, MCPServiceResponse, MCPToolResponse as ToolResponse } from '@/shared/types/mcp';
import { TestConnectionEvent } from '@/shared/types/streaming';
import { loadServerConfigs, saveConfig } from './config';
import { listServerTools as listTools, callTool as callToolFunction, ToolCallProgress } from './tools';
import {
  listServerResources as listResources,
  listServerResourceTemplates as listResourceTemplates,
  readResource as readResourceFn,
} from './resources';
import { listServerPrompts as listPrompts, getPrompt as getPromptFn } from './prompts';
import {
  MCPResource,
  MCPResourceTemplate,
  MCPReadResourceResult,
  MCPPrompt,
  MCPGetPromptResult,
} from '@/shared/types/mcp';
import {
  enhanceConnectionErrorMessage,
  formatErrorChain,
  formatErrorResponse,
  isAuthRequiredError,
  isClientConnectionClosed,
  isTransientStreamError
} from '@/utils/mcp/utils';
import { encryptApiKey } from '@/backend/services/model/encryption';
import { MASKED_API_KEY } from '@/shared/types/constants';
import { normalizeHeaderValue, isMaskedHeaderValue, isGlobalBinding, hydrateMaskedHeaders } from '@/utils/mcp/headers';
import { resolveGlobalVars } from '@/backend/utils/resolveGlobalVars';
import { getTestConnectionTimeoutMs, isRunnerStdioConfig } from '@/utils/mcp/testConnectionTimeout';
import {
  createNewClient,
  createTransport,
  resolveConfigHeaders,
  shouldRecreateClient,
  safelyCloseClient
} from './connection';
import { setNodeRoots as setNodeRootsOverlay } from './roots';
import { INTERNAL_SERVER_NAME } from './internalServerConfig';
import {
  isBuiltInServerName,
  builtInServerConfigsWithOverrides,
  setInternalServerDisabled,
  setInternalServerRoots,
  FILESYSTEM_SERVER_NAME,
  BASH_SERVER_NAME,
} from './internal/registry';

// Define a type for tool arguments
type ToolArgs = Record<string, unknown>;

// Create a logger instance for this file
const log = createLogger('backend/services/mcp/index');

/**
 * Main service class for MCP server management
 * 
 * This simplified version focuses on providing a clean interface for server management
 * while maintaining compatibility with the MCP SDK.
 */
export class MCPService {
  private stderrLogs: Map<string, string[]> = new Map(); // Store stderr logs for each server
  // Last connection failure per server. Unlike stderrLogs (which is reset at the start of
  // every connection attempt to capture a fresh run), this persists until the server next
  // connects successfully, so getServerStatus() can always report why a server is down -
  // even during the brief window of an in-flight reconnect.
  private lastConnectionError: Map<string, string> = new Map();
  // De-dupes concurrent connectServer() calls for the same server (see connectServer below).
  private inFlightConnects: Map<string, Promise<MCPServiceResponse>> = new Map();
  private connectionRetryTimers: Map<string, NodeJS.Timeout> = new Map(); // Track retry timers for each server
  private connectionRetryAttempts: Map<string, number> = new Map(); // Track retry attempts for each server

  // Connected clients per server name. Global-backed (see __mcp_clients) so EVERY
  // MCPService instance shares the one map: a client registered or deregistered by any
  // instance is immediately visible to all others. There is deliberately no per-instance
  // copy — N caches with one invalidation path is what poisoned the scheduler with
  // closed clients ("This operation was aborted") after another instance rebuilt a
  // connection.
  private get clients(): Map<string, Client> {
    return global.__mcp_clients!;
  }

  // Servers with an in-flight connection attempt. Global-backed (see __mcp_connecting)
  // so the set is shared across module instances / hot reloads.
  private get connectingServers(): Set<string> {
    return global.__mcp_connecting!;
  }

  // The currently-registered transport per server. Global-backed (see
  // __mcp_active_transports) so a deregistration in one module instance is visible to
  // the onclose/onerror handlers that were registered by another.
  private get activeTransports(): Map<string, Transport> {
    return global.__mcp_active_transports!;
  }

  // Cap per-server stderr retention: a chatty or crash-looping server would otherwise
  // grow the array without bound for the lifetime of the process.
  private static readonly MAX_STDERR_LOG_ENTRIES = 200;

  /** Append a stderr/transport-error line for a server, keeping only the newest entries. */
  private appendStderrLog(serverName: string, message: string): void {
    const logs = this.stderrLogs.get(serverName) || [];
    logs.push(message);
    if (logs.length > MCPService.MAX_STDERR_LOG_ENTRIES) {
      logs.splice(0, logs.length - MCPService.MAX_STDERR_LOG_ENTRIES);
    }
    this.stderrLogs.set(serverName, logs);
  }

  /**
   * Remove every live reference to a server's client BEFORE an intentional close.
   *
   * Deregistering first is what marks the close as FLUJO-initiated: the transport's
   * onclose/onerror handlers only act when their transport is still the registered one
   * (see connectServer), so a close that follows a deregistration never schedules a
   * reconnect against ourselves.
   */
  private deregisterClient(serverName: string): void {
    this.clients.delete(serverName);
    this.activeTransports.delete(serverName);
  }

  /**
   * Clear retry timer for a server
   */
  private clearRetryTimer(serverName: string): void {
    const timer = this.connectionRetryTimers.get(serverName);
    if (timer) {
      clearTimeout(timer);
      this.connectionRetryTimers.delete(serverName);
      log.debug(`Cleared retry timer for server ${serverName}`);
    }
  }

  /**
   * Schedule connection retry with exponential backoff
   */
  private scheduleConnectionRetry(serverName: string, config: MCPServerConfig): void {
    // Clear any existing timer
    this.clearRetryTimer(serverName);
    
    // Get current retry attempt count
    const currentAttempts = this.connectionRetryAttempts.get(serverName) || 0;
    const maxAttempts = 5; // Maximum retry attempts
    
    if (currentAttempts >= maxAttempts) {
      log.warn(`Maximum retry attempts (${maxAttempts}) reached for server ${serverName}, stopping retries`);
      this.connectionRetryAttempts.delete(serverName);
      return;
    }
    
    // Calculate delay with exponential backoff: 2^attempt * 5000ms, max 5 minutes
    const baseDelay = 5000; // 5 seconds
    const maxDelay = 300000; // 5 minutes
    const delay = Math.min(Math.pow(2, currentAttempts) * baseDelay, maxDelay);
    
    log.info(`Scheduling connection retry for server ${serverName} in ${delay}ms (attempt ${currentAttempts + 1}/${maxAttempts})`);
    
    const timer = setTimeout(async () => {
      log.info(`Attempting to reconnect server ${serverName} (attempt ${currentAttempts + 1}/${maxAttempts})`);
      
      // Check current server configuration before attempting retry
      const currentConfig = await this.getServerConfig(serverName);
      if (!currentConfig) {
        log.info(`Server ${serverName} configuration not found, stopping retry attempts`);
        this.connectionRetryAttempts.delete(serverName);
        return;
      }
      
      // Check if server is now disabled
      if (currentConfig.disabled) {
        log.info(`Server ${serverName} is now disabled, stopping retry attempts`);
        this.connectionRetryAttempts.delete(serverName);
        return;
      }

      // If the server meanwhile has a live, RESPONSIVE connection (e.g. this timer was
      // scheduled by a zombie's late close event, or another path already reconnected),
      // reconnecting here would tear the healthy server down — the exact mechanism of
      // the restart death-spiral. Verify with a real ping, not just map presence.
      const existingClient = this.getClient(serverName);
      if (existingClient) {
        try {
          await existingClient.ping({ timeout: 5000 });
          log.info(`Server ${serverName} is already connected and responsive, cancelling retry`);
          this.connectionRetryAttempts.delete(serverName);
          return;
        } catch (pingError) {
          log.warn(`Server ${serverName} has a registered client but ping failed (${pingError instanceof Error ? pingError.message : String(pingError)}); reconnecting from scratch`);
        }
      }

      // Increment retry count
      this.connectionRetryAttempts.set(serverName, currentAttempts + 1);

      try {
        // A dead-but-present client must be torn down first (connectServer would
        // short-circuit on it); with no client a plain connect is enough.
        const result = existingClient
          ? await this.forceReconnect(serverName)
          : await this.connectServer(currentConfig);
        if (result.success) {
          log.info(`Successfully reconnected server ${serverName} after ${currentAttempts + 1} attempts`);
          // Reset retry count on successful connection
          this.connectionRetryAttempts.delete(serverName);
        } else {
          log.warn(`Failed to reconnect server ${serverName}: ${result.error}`);
          // Don't retry if authentication is required
          if (result.requiresAuthentication) {
            log.info(`Server ${serverName} requires authentication, stopping retry attempts`);
            this.connectionRetryAttempts.delete(serverName);
            return;
          }
          // Schedule another retry if we haven't reached max attempts
          this.scheduleConnectionRetry(serverName, currentConfig);
        }
      } catch (error) {
        log.error(`Error during retry connection for server ${serverName}:`, error);
        // Schedule another retry if we haven't reached max attempts
        this.scheduleConnectionRetry(serverName, currentConfig);
      }
    }, delay);
    
    this.connectionRetryTimers.set(serverName, timer);
  }
  
  /**
   * Check if the backend is currently starting up
   */
  isStartingUp(): boolean {
    return global.__mcp_starting_up === true;
  }

  /**
   * Set the backend startup state
   */
  private setStartingUp(value: boolean): void {
    global.__mcp_starting_up = value;
    log.info(`Backend startup state set to: ${value ? 'starting' : 'complete'}`);
  }

  /**
   * Get a client by server name
   */
  getClient(serverName: string): Client | undefined {
    const client = this.clients.get(serverName);

    // A client whose connection is already closed (transport detached, or its abort
    // signal fired — e.g. torn down elsewhere between polls) can never serve another
    // request: HTTP transports would reject every call instantly with AbortError
    // "This operation was aborted". Evict it and report "no client" so every caller's
    // existing missing-client path (callTool's pre-call reconnect, listWithReconnect,
    // scheduleConnectionRetry) rebuilds a fresh connection instead of reusing a corpse.
    // The map is shared across instances, so if another instance already replaced the
    // entry with a fresh client, we naturally see the fresh one here — never evict it.
    if (client && isClientConnectionClosed(client)) {
      log.warn(`getClient: client for ${serverName} has a closed/aborted connection — evicting it`);
      this.clients.delete(serverName);
      return undefined;
    }

    log.debug(`getClient: Looking for client: ${serverName}`, client ? 'Found' : 'Not found');
    return client;
  }

  /**
   * Load MCP server configurations from storage
   */
  async loadServerConfigs(): Promise<MCPServerConfig[] | MCPServiceResponse> {
    log.debug('loadServerConfigs: Entering method');

    try {
      const serverConfigs = await loadServerConfigs();

      if (!Array.isArray(serverConfigs)) {
        log.warn('loadServerConfigs: Received non-array response', serverConfigs);
        return serverConfigs;
      }

      // The built-in internal servers (FLUJO's backend API, filesystem, bash) are
      // synthesized here rather than stored, so they are always present and always
      // up to date. A stored config that claims one of the reserved names wins
      // (legacy user server) and simply shadows the built-in one. Never persisted:
      // saveConfig() drops builtIn entries. The per-server enable/disable override
      // (issue #170) is applied here (only the tiny { disabled } flag is stored).
      const builtIns = await builtInServerConfigsWithOverrides();
      for (const builtIn of builtIns) {
        if (serverConfigs.some(c => c.name === builtIn.name)) {
          log.warn(`loadServerConfigs: A stored server is named "${builtIn.name}" — it shadows FLUJO's built-in server`);
          continue;
        }
        serverConfigs.push(builtIn);
      }

      log.debug(`loadServerConfigs: Loaded ${serverConfigs.length} server configs`);
      return serverConfigs;
    } catch (error) {
      log.warn('loadServerConfigs: Failed to load server configs:', error);
      return {
        success: false,
        error: `Failed to load server configs: ${error instanceof Error ? error.message : 'Unknown error'}`
      };
    }
  }

  /**
   * Get a server configuration by name
   */
  private async getServerConfig(serverName: string): Promise<MCPServerConfig | null> {
    log.debug(`getServerConfig: Looking up config for server ${serverName}`);
    
    const configs = await this.loadServerConfigs();
    
    if (!Array.isArray(configs)) {
      log.warn(`getServerConfig: Failed to load configs for ${serverName}:`, configs.error);
      return null;
    }
    
    const config = configs.find(c => c.name === serverName);
    
    if (!config) {
      log.warn(`getServerConfig: Server ${serverName} not found in configs`);
      return null;
    }
    
    return config;
  }

  /**
   * Whether a server's stored config marks it disabled (issue #54).
   *
   * Unknown servers return false — a missing config is a different failure that is
   * surfaced elsewhere with its own message.
   */
  async isServerDisabled(serverName: string): Promise<boolean> {
    const config = await this.getServerConfig(serverName);
    return config?.disabled === true;
  }

  /**
   * Is this name the built-in internal server (and not shadowed by a stored
   * config)? The storage check keeps a pre-existing user server that happens to
   * be named like the built-in one fully functional: for such a name every
   * short-circuit below steps aside and the normal client/transport path runs.
   * Names other than the reserved one return false at a string compare — the
   * storage read only ever happens for the reserved name itself.
   */
  private async isInternalServer(serverName: string): Promise<boolean> {
    if (!isBuiltInServerName(serverName)) return false;
    const stored = await loadServerConfigs();
    return !Array.isArray(stored) || !stored.some(c => c.name === serverName);
  }

  /**
   * Connect to an MCP server by name
   */
  async connectServer(serverName: string): Promise<MCPServiceResponse>;
  
  /**
   * Connect to an MCP server using a configuration object
   */
  async connectServer(config: MCPServerConfig): Promise<MCPServiceResponse>;
  
  /**
   * Implementation of connectServer that handles both parameter types.
   *
   * De-dupes concurrent calls for the same server name. Without this, two overlapping
   * callers (e.g. a UI-triggered reconnect racing the transport's on-close reconnect
   * handler) each build their own OAuthClientProvider from an independently-loaded config
   * snapshot and can both attempt to redeem the same single-use OAuth refresh token - the
   * second redemption is rejected by the authorization server as invalid_grant, which
   * previously left the stored refresh token permanently poisoned (see isAuthRequiredError
   * and MCPOAuthClientProvider.invalidateCredentials for the recovery half of this fix).
   */
  async connectServer(configOrName: MCPServerConfig | string): Promise<MCPServiceResponse> {
    const serverName = typeof configOrName === 'string' ? configOrName : configOrName.name;

    // The built-in internal server has no client or transport to establish — it is
    // "connected" by definition. Short-circuit BEFORE the in-flight machinery so the
    // startup sweep (which includes the synthetic config) and flow handlers get an
    // instant success, and clear any "connecting" marker the sweep set for it.
    if (isBuiltInServerName(serverName)) {
      const isBuiltIn =
        typeof configOrName !== 'string'
          ? configOrName.builtIn === true
          : await this.isInternalServer(serverName);
      if (isBuiltIn) {
        this.connectingServers.delete(serverName);
        return { success: true };
      }
    }

    const inFlight = this.inFlightConnects.get(serverName);
    if (inFlight) {
      log.debug(`connectServer: reusing in-flight connection attempt for ${serverName}`);
      return inFlight;
    }

    const attempt = this.connectServerInternal(configOrName).finally(() => {
      this.inFlightConnects.delete(serverName);
    });
    this.inFlightConnects.set(serverName, attempt);
    return attempt;
  }

  private async connectServerInternal(configOrName: MCPServerConfig | string): Promise<MCPServiceResponse> {
    // Determine if we're connecting by name or by config
    let config: MCPServerConfig;
    
    if (typeof configOrName === 'string') {
      // We're connecting by server name
      const serverName = configOrName;
      log.info(`connectServer: Looking up config for server ${serverName}`);
      
      // Look up the configuration directly from storage
      const existingConfig = await this.getServerConfig(serverName);
      if (!existingConfig) {
        log.warn(`connectServer: Server ${serverName} not found in configs`);
        return {
          success: false,
          error: `Server configuration for "${serverName}" not found. The server may have been deleted or not properly configured.`
        };
      }
      
      config = existingConfig;
    } else {
      // We're connecting with a config object
      config = configOrName;
    }

    // HARD GATE (issue #54): a disabled server must never spawn. This is the single
    // choke point where clients + transports are born — createTransport() is only
    // reachable through this method — so gating here covers every caller (scheduler
    // polls, flow handlers, API routes, self-heal reconnects) and every transport
    // type. Re-resolve the STORED config by name even when the caller passed a
    // config object: flow nodes pass node-bound snapshots that may be stale, and
    // the stored config is the source of truth for `disabled`.
    const storedConfig =
      typeof configOrName === 'string' ? config : await this.getServerConfig(config.name);
    if ((storedConfig ?? config).disabled) {
      log.info(`connectServer: Server ${config.name} is disabled — refusing to create a client/transport`);
      // Disabled servers must not keep retry machinery alive either.
      this.clearRetryTimer(config.name);
      this.connectionRetryAttempts.delete(config.name);
      return {
        success: false,
        error: `Server '${config.name}' is disabled. Enable it on the MCP page to use it.`,
      };
    }

    const requestId = uuidv4();
    log.info(`connectServer: Starting connection for server ${config.name} [RequestID: ${requestId}]`);

    // Mark this server as having an in-flight connection attempt so getServerStatus()
    // reports "connecting" (spinner + auto-poll on the MCP page) instead of an error
    // while the attempt is running. Cleared in the finally below.
    this.connectingServers.add(config.name);

    try {
      // Clear any previous stderr logs for this server
      this.stderrLogs.set(config.name, []);

      // Resolve + decrypt any custom headers (#84) BEFORE anything reads them. The SAME
      // resolved config must drive both shouldRecreateClient() and createTransport(), so the
      // httpConfigKey they compute agrees (a bound-global header would otherwise force a
      // rebuild on every connect). A rotated bound-global still rebuilds, since the resolved
      // header material — and thus the key — changes.
      config = await resolveConfigHeaders(config);

      // Check if we already have a client for this server
      let client = this.clients.get(config.name);

      // If we already have a client, reuse it - but only if it is still valid for the
      // current config. shouldRecreateClient catches a locally-CLOSED connection (whose
      // aborted transport would fail every call instantly) plus transport-type / URL /
      // command / auth-material changes that would otherwise leave us talking to a
      // client built for a stale config.
      //
      // Note: this still cannot detect a REMOTELY-dead connection (e.g. an expired
      // streamable-HTTP session the server dropped) - that is only observable by using
      // it, so it is healed at the point of use in listServerTools()/callTool(). All
      // checks here are cheap and local (no network round-trip), preserving the fast
      // path for the common case.
      if (client) {
        const { needsNewClient, reason } = shouldRecreateClient(client, config);
        if (!needsNewClient) {
          log.info(`connectServer: Server ${config.name} is already connected`);
          this.lastConnectionError.delete(config.name);
          // The connection is established - a pending retry (e.g. scheduled by a
          // zombie's late close) must not fire against it later.
          this.clearRetryTimer(config.name);
          this.connectionRetryAttempts.delete(config.name);
          return { success: true };
        }

        log.info(`connectServer: Existing client for ${config.name} is stale (${reason}), recreating`);
        // Deregister BEFORE closing so the transport's own close event is recognized
        // as FLUJO-initiated and does not schedule a reconnect (see deregisterClient).
        this.deregisterClient(config.name);
        try {
          await safelyCloseClient(client, config.name, config);
        } catch (closeError) {
          log.debug(`connectServer: error closing stale client for ${config.name}: ${closeError instanceof Error ? closeError.message : String(closeError)}`);
        }
        client = undefined;
      }

      // Create a new client
      client = createNewClient(config);
      const transport = createTransport(config);

      // Add stderr capture
      if (transport instanceof StdioClientTransport && transport.stderr) {
        const serverName = config.name;
        transport.stderr.on('data', (data: Buffer) => {
          const stderrMessage = data.toString();
          log.warn(`stderr: [${serverName}]: ${stderrMessage}`);

          // Store stderr logs (capped, see appendStderrLog)
          this.appendStderrLog(serverName, stderrMessage);
        });
      }

      // Register FLUJO's transport event handlers BEFORE client.connect(): the SDK's
      // Protocol.connect() wraps whatever handlers are already present and CHAINS them
      // ahead of its own (_onclose/_onerror). Assigning after connect() — as this code
      // once did — silently REPLACED the SDK's wrapper, so the Client never learned its
      // transport had closed: pending requests were never rejected with "Connection
      // closed", client.transport stayed attached, and later calls surfaced as the
      // cryptic AbortError "This operation was aborted" from the aborted fetch signal.
      transport.onclose = () => {
        // Only act if THIS transport is still the registered one for the server.
        // Two cases must be ignored: (a) a zombie process from a replaced connection
        // finally exiting — its late close event used to delete the CURRENT healthy
        // client from the maps and schedule a retry against it; (b) closes FLUJO
        // itself initiated (disconnect/reconnect/config change), which deregister
        // before closing and must not schedule a self-defeating reconnect.
        if (this.activeTransports.get(config.name) !== transport) {
          log.debug(`connectServer: ignoring close event from a stale/deregistered transport for ${config.name}`);
          return;
        }

        log.warn(`connectServer: Connection closed for server ${config.name}`);

        // Clean up client references for the transport that actually closed
        this.deregisterClient(config.name);

        // Check if server is still enabled before scheduling reconnection
        this.getServerConfig(config.name).then(currentConfig => {
          if (!currentConfig || currentConfig.disabled) {
            log.info(`Server ${config.name} is now disabled, skipping reconnection logic`);
            return;
          }

          // Only schedule reconnection if server is still enabled
          log.info(`Connection closed for enabled server ${config.name}, scheduling reconnection`);
          this.scheduleConnectionRetry(config.name, currentConfig);
        }).catch(error => {
          log.warn(`Error checking server config for ${config.name} during onclose:`, error);
        });
      };

      transport.onerror = (error) => {
        // The Streamable HTTP transport keeps a long-lived SSE stream open for server->client
        // notifications; servers/proxies recycle that idle stream (e.g. Cloudflare in front of
        // Asana), which surfaces here as "SSE stream disconnected: TypeError: terminated". The
        // SDK reconnects the stream on its own and tool calls keep working, so this is noise —
        // NOT a fatal error. Log it quietly and leave the client in place. Tearing it down here
        // (as the fatal path below does) would fight the SDK's own reconnection and orphan the
        // transport, whose stale reconnection loop would then keep firing this handler.
        if (isTransientStreamError(error)) {
          log.debug(
            `connectServer: transient SSE stream disconnect for ${config.name} (self-healing, ignored): ${error instanceof Error ? error.message : String(error)}`
          );
          return;
        }

        // Same stale/deregistered guard as onclose: errors surfacing from a replaced
        // or intentionally-closed transport must not tear down the CURRENT connection
        // or schedule a reconnect against it.
        if (this.activeTransports.get(config.name) !== transport) {
          log.debug(`connectServer: ignoring error event from a stale/deregistered transport for ${config.name}`);
          return;
        }

        // Enhanced error logging to capture more details about transport errors
        log.error(`connectServer: Transport error for server ${config.name}:`);
        
        // Log error details in multiple ways to capture as much information as possible
        if (error instanceof Error) {
          log.error(`Error name: ${error.name}`);
          log.error(`Error message: ${error.message}`);
          log.error(`Error stack: ${error.stack}`);
          // The MCP SDK folds the underlying error into the message string and never sets
          // `error.cause` (see StreamableHTTPClientTransport), so logging it is always
          // "undefined". Log the resolved cause chain instead, plus any HTTP status code
          // carried by StreamableHTTPError (e.g. 502 for a Bad Gateway from the proxy).
          const httpCode = (error as { code?: unknown }).code;
          if (httpCode !== undefined) {
            log.error(`Error code: ${httpCode}`);
          }
          log.error(`Error chain: ${formatErrorChain(error)}`);
        } else if (error && typeof error === 'object') {
          // Try to log individual properties of the error object
          log.error(`Error type: ${typeof error}`);
          log.error(`Error constructor: ${(error as any).constructor?.name || 'Unknown'}`);
          
          // Log all enumerable properties
          const errorProps = Object.getOwnPropertyNames(error);
          if (errorProps.length > 0) {
            log.error(`Error properties: ${errorProps.join(', ')}`);
            errorProps.forEach(prop => {
              try {
                const value = (error as any)[prop];
                log.error(`  ${prop}: ${typeof value === 'function' ? '[Function]' : JSON.stringify(value)}`);
              } catch (propError) {
                log.error(`  ${prop}: [Unable to serialize: ${propError}]`);
              }
            });
          } else {
            log.error(`Error object has no enumerable properties`);
          }
          
          // Try JSON.stringify as fallback
          try {
            const jsonError = JSON.stringify(error);
            log.error(`JSON stringified error: ${jsonError}`);
          } catch (jsonError) {
            log.error(`Cannot JSON stringify error: ${jsonError}`);
          }
        } else {
          log.error(`Error value: ${String(error)} (type: ${typeof error})`);
        }
        
        // Store more detailed error information. Walk the full cause chain so a generic
        // "fetch failed" becomes the real underlying error (e.g. TLS verification failure).
        this.appendStderrLog(config.name, `Transport error: ${formatErrorChain(error)}`);

        // Clean up client references for the transport that actually errored
        this.deregisterClient(config.name);


        // Check if server is still enabled before scheduling reconnection
        this.getServerConfig(config.name).then(currentConfig => {
          if (!currentConfig || currentConfig.disabled) {
            log.info(`Server ${config.name} is now disabled, skipping reconnection after transport error`);
            return;
          }
          
          // Only schedule reconnection if server is still enabled
          log.info(`Transport error for enabled server ${config.name}, scheduling reconnection`);
          this.scheduleConnectionRetry(config.name, currentConfig);
        }).catch(error => {
          log.warn(`Error checking server config for ${config.name} during onerror:`, error);
        });
      };

      // Handshake. Both handlers above are inert until the transport is registered as
      // the CURRENT one below (their stale guard sees activeTransports unset), so a
      // failure during connect surfaces only through this call's catch.
      await client.connect(transport);

      // Store the new client (in the shared cross-instance map) and register its
      // transport as the CURRENT one for this server — the reference the
      // onclose/onerror stale guards compare against.
      this.clients.set(config.name, client);
      this.activeTransports.set(config.name, transport);

      // Connected successfully - clear any persisted failure from previous attempts,
      // and cancel any pending retry so an old timer can't fire against the fresh
      // connection later (the retry state is orphaned once we're connected).
      this.lastConnectionError.delete(config.name);
      this.clearRetryTimer(config.name);
      this.connectionRetryAttempts.delete(config.name);

      log.info(`connectServer: Successfully connected to ${config.name}`);
      return { success: true };
    } catch (error) {
      log.error(`connectServer: Failed to connect to server ${config.name}:`, error);
      
      // Check if this is an OAuth authentication error
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorName = error instanceof Error ? error.name : '';
      
      if (errorMessage.includes('OAuth authentication required') || errorName === 'OAuthAuthenticationRequired') {
        log.info(`OAuth authentication required for server ${config.name}`);
        
        // Store the authorization URL if available
        if (config.transport === 'streamable') {
          const streamableConfig = config as MCPStreamableConfig;
          if (streamableConfig.authorizationUrl) {
            log.info(`Authorization URL available for ${config.name}: ${streamableConfig.authorizationUrl}`);
          }
        }
        
        return { 
          success: false, 
          error: errorMessage,
          requiresAuthentication: true 
        };
      }
      
      // Check for other OAuth-related errors (401/403 indicating missing auth) - this also
      // covers a freshly-added streamable server that has no OAuth config at all yet, where
      // createTransport() never attached an auth provider and the server just rejected the
      // unauthenticated request outright (e.g. Asana's MCP V2 API).
      if (isAuthRequiredError(error)) {
        log.info(`OAuth authentication error detected for server ${config.name}: ${errorMessage}`);
        
        // For streamable servers, dynamically enable OAuth if not already configured
        if (config.transport === 'streamable') {
          const streamableConfig = config as MCPStreamableConfig;
          
          // If OAuth scopes are not set, this server needs OAuth but wasn't configured for it
          if (!streamableConfig.oauthScopes || streamableConfig.oauthScopes.length === 0) {
            log.info(`Dynamically enabling OAuth for server ${config.name} due to authentication error`);
            
            try {
              // Update the config to include OAuth scopes
              const updatedConfig = {
                ...streamableConfig,
                oauthScopes: ['read'] // Set default OAuth scope
              };
              
              // Save the updated config to storage
              const configs = await this.loadServerConfigs();
              if (Array.isArray(configs)) {
                const configIndex = configs.findIndex(c => c.name === config.name);
                if (configIndex !== -1) {
                  configs[configIndex] = updatedConfig;
                  await saveConfig(new Map(configs.map(c => [c.name, c])));
                  log.info(`Updated config for ${config.name} to enable OAuth`);
                }
              }
            } catch (updateError) {
              log.warn(`Failed to update config for ${config.name} to enable OAuth:`, updateError);
            }
          }
        }
        
        return { 
          success: false, 
          error: 'OAuth authentication failed or tokens have expired. Please re-authenticate.',
          requiresAuthentication: true 
        };
      }
      
      const stderrLogs = this.stderrLogs.get(config.name) || [];
      const enhancedErrorMessage = enhanceConnectionErrorMessage(error, config, stderrLogs);

      // Persist the failure so getServerStatus() can report a meaningful message instead of
      // the generic "configured but not connected" fallback. HTTP transports (streamable/sse)
      // fail inside client.connect(), which is caught here and does NOT necessarily fire
      // transport.onerror, so without this nothing would be recorded for the status poll.
      this.lastConnectionError.set(config.name, enhancedErrorMessage);

      return { success: false, error: enhancedErrorMessage };
    } finally {
      // The attempt has settled (connected, failed, or threw) - it is no longer
      // "connecting". A successful connection now shows as connected; a failure
      // falls through to its real error message.
      this.connectingServers.delete(config.name);
    }
  }

  /**
   * Test a connection to an MCP server WITHOUT registering it as a managed client.
   *
   * This performs a real MCP handshake (and tool listing) using the same transport,
   * TLS trust and custom headers the running server would use. It is the backend
   * counterpart of the modal's "Test Run" button: because it runs in the Next.js
   * server process (not the browser), it can reach servers behind custom CAs and send
   * the configured Authorization/X-SAP-* headers, which a browser fetch cannot.
   */
  async testConnection(
    config: MCPServerConfig,
    onOutput?: (event: TestConnectionEvent) => void,
    options?: { storedName?: string }
  ): Promise<MCPServiceResponse> {
    log.info(`testConnection: Testing connection to ${config.name || '(unnamed)'} via ${config.transport} transport`);

    // Optional live-output sink (issue #64). When omitted, behaviour is byte-for-byte
    // identical to the original one-shot request/response probe.
    const emit = (event: TestConnectionEvent): void => {
      try {
        onOutput?.(event);
      } catch {
        // A misbehaving sink must never break the probe itself.
      }
    };

    const stderrLogs: string[] = [];
    let client: Client | null = null;
    let transport: ReturnType<typeof createTransport> | null = null;

    try {
      // For remote (streamable/sse) servers the browser may send back a MASKED secret header
      // (e.g. Authorization: "********") when the user did not re-type the token — i.e. when
      // editing or re-testing a server whose secret was saved earlier (#137). Hydrate those
      // masked SECRET headers from the stored, saved config (looked up by the pre-edit name so
      // rename + Test Connection also works) before resolving, mirroring resolveHeadersForSave's
      // masked->keep contract. This happens entirely server-side — the real secret is read from
      // disk here and never sent to the browser. resolveConfigHeaders then decrypts/resolves it
      // exactly as the live connection does.
      let toTest = config;
      const lookupName = options?.storedName || config.name;
      if ((config.transport === 'streamable' || config.transport === 'sse') && lookupName) {
        const stored = await this.loadServerConfigs();
        const savedCfg = Array.isArray(stored) ? stored.find(c => c.name === lookupName) : undefined;
        const savedHeaders = (savedCfg as MCPSSEConfig | MCPStreamableConfig | undefined)?.headers;
        const incomingHeaders = (config as MCPSSEConfig | MCPStreamableConfig).headers;
        toTest = { ...config, headers: hydrateMaskedHeaders(incomingHeaders, savedHeaders) } as MCPServerConfig;
      }

      // Resolve + decrypt custom headers (#84) so the probe uses the same real header values
      // the live connection would (shares createTransport). Global bindings / encrypted
      // secrets are resolved here; plain values pass through unchanged.
      const connectConfig = await resolveConfigHeaders(toTest);
      client = createNewClient(connectConfig);
      transport = createTransport(connectConfig);

      // Capture stdio stderr (for stdio servers) and transport errors so we can build a
      // meaningful message if the handshake fails. When a live-output sink is attached
      // (issue #64), also forward each chunk AS IT ARRIVES so a slow cold `npx`/`uvx`
      // start fills the console instead of looking frozen. (The child's stdout is the
      // MCP JSON-RPC channel owned by the SDK transport, so only stderr + lifecycle
      // markers are reliably streamable for stdio.)
      if (transport instanceof StdioClientTransport && transport.stderr) {
        transport.stderr.on('data', (data: Buffer) => {
          const chunk = data.toString();
          stderrLogs.push(chunk);
          emit({ type: 'stderr', data: chunk });
        });
      }
      transport.onerror = (err: Error) => {
        const line = `Transport error: ${formatErrorChain(err)}`;
        stderrLogs.push(line);
        emit({ type: 'stderr', data: line + '\n' });
      };

      emit({ type: 'status', phase: 'spawning', message: 'Starting server / opening transport...' });

      // Runner-aware timeout: a cold `npx`/`uvx`/`bunx`/`pnpm dlx` may need to DOWNLOAD
      // the package before the MCP handshake even starts, which routinely exceeds the 15s
      // default (issue #43). Local commands and HTTP transports keep the 15s default.
      const timeoutMs = getTestConnectionTimeoutMs(config);
      const isRunner = isRunnerStdioConfig(config);
      let timeoutHandle: NodeJS.Timeout | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(
          () => reject(new Error(
            `Connection timeout after ${timeoutMs / 1000}s`
            + (isRunner
              ? ' — the package may still be downloading via npx/uvx. Try running the Test again (the package is cached after the first download), or verify the command and network access.'
              : '')
          )),
          timeoutMs
        );
      });

      emit({ type: 'status', phase: 'handshaking', message: 'Performing MCP handshake...' });
      try {
        await Promise.race([client.connect(transport), timeoutPromise]);
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
      }

      // Handshake succeeded — try to list tools to confirm full protocol compatibility.
      emit({ type: 'status', phase: 'listing-tools', message: 'Handshake OK — listing tools...' });
      let toolCount = 0;
      try {
        const result = await client.listTools();
        toolCount = Array.isArray(result?.tools) ? result.tools.length : 0;
      } catch (listError) {
        log.debug(`testConnection: connected to ${config.name} but listTools failed: ${listError instanceof Error ? listError.message : String(listError)}`);
      }

      log.info(`testConnection: Successfully connected to ${config.name} (${toolCount} tools)`);
      emit({ type: 'result', success: true, data: { toolCount } });
      return { success: true, data: { toolCount } };
    } catch (error) {
      log.warn(`testConnection: Failed to connect to ${config.name}:`, error);

      const requiresAuthentication = isAuthRequiredError(error);

      const enhancedErrorMessage = enhanceConnectionErrorMessage(error, config, stderrLogs);
      emit({ type: 'result', success: false, error: enhancedErrorMessage, requiresAuthentication });
      return { success: false, error: enhancedErrorMessage, requiresAuthentication };
    } finally {
      if (client) {
        try {
          // Short grace: this is a throwaway probe and the Test Run response is
          // waiting on this close - don't hold it for the full production window.
          await safelyCloseClient(client, config.name, config, { gracePeriodMs: 3000, killEscalationMs: 2000 });
        } catch (closeError) {
          log.debug(`testConnection: error closing test client for ${config.name}: ${closeError instanceof Error ? closeError.message : String(closeError)}`);
        }
      }
    }
  }

  /**
   * Register (or clear, when `roots` is empty) the workspace-folder overlay a FlowBuilder
   * MCP node contributes to its bound server (issue 46). Connections are singletons keyed
   * by server name, so node roots are additive: roots/list answers with the union of the
   * server-level roots and all currently-registered node roots (falling back to the
   * server's rootPath when there are none at all). The roots capability is always
   * declared, so this NEVER rebuilds a connection — servers whose effective roots
   * changed are told via notifications/roots/list_changed instead.
   */
  setNodeRoots(serverName: string, nodeId: string, roots?: string[]): void {
    const changedServers = setNodeRootsOverlay(serverName, nodeId, roots);
    for (const changed of changedServers) {
      this.notifyRootsChanged(changed);
    }
  }

  /**
   * Announce a roots change to a CONNECTED server via notifications/roots/list_changed
   * (the client always declares roots.listChanged). Fire-and-forget: when the server is
   * not connected this is a no-op — the next connect serves fresh roots anyway — and
   * failures are logged, never thrown (roots are advisory).
   */
  notifyRootsChanged(serverName: string): void {
    const client = this.getClient(serverName);
    if (!client) {
      log.debug(`notifyRootsChanged: ${serverName} not connected, skipping notification`);
      return;
    }
    try {
      void client.sendRootsListChanged().catch((error: unknown) => {
        log.warn(`notifyRootsChanged: failed to notify ${serverName}:`, error);
      });
      log.debug(`notifyRootsChanged: sent roots/list_changed to ${serverName}`);
    } catch (error) {
      log.warn(`notifyRootsChanged: failed to notify ${serverName}:`, error);
    }
  }

  /**
   * Disconnect from an MCP server
   */
  async disconnectServer(serverName: string): Promise<MCPServiceResponse> {
    log.debug(`disconnectServer: Entering method for server ${serverName}`);

    // The built-in internal server has no connection to tear down.
    if (await this.isInternalServer(serverName)) {
      return { success: true };
    }

    // Clear any retry timers for this server
    this.clearRetryTimer(serverName);
    this.connectionRetryAttempts.delete(serverName);
    
    // Resolve via getClient: the shared map is cross-instance, and getClient also
    // evicts a client whose connection is already closed — there is nothing left to
    // "disconnect" for one of those, only references to purge.
    const client = this.getClient(serverName);
    if (!client) {
      log.warn(`disconnectServer: Server ${serverName} not found in clients map`);
      // Even without a live client, purge any lingering references so a stale entry
      // can never be observed by another instance after this call.
      this.deregisterClient(serverName);
      return { success: false, error: `Server ${serverName} not found` };
    }

    // Deregister BEFORE closing: this marks the close as FLUJO-initiated, so the
    // transport's close event is ignored by the stale guard instead of scheduling a
    // reconnect that would immediately undo this disconnect.
    this.deregisterClient(serverName);

    try {
      // Get the server config to pass to safelyCloseClient
      const config = await this.getServerConfig(serverName);

      // Close the client following the MCP shutdown sequence
      await safelyCloseClient(client, serverName, config || undefined);

      log.info(`disconnectServer: Disconnected server ${serverName}`);
      return { success: true };
    } catch (error) {
      log.warn(`disconnectServer: Failed to disconnect server ${serverName}:`, error);
      return {
        success: false,
        error: `Failed to disconnect server: ${error instanceof Error ? error.message : 'Unknown error'}`
      };
    }
  }

  /**
   * Tear down any existing client for a server and establish a fresh connection.
   *
   * Used to self-heal a dead/stale connection: the cached client is closed and removed
   * before reconnecting, so connectServer() is guaranteed to build a brand-new client and
   * transport rather than short-circuiting on the stale one still sitting in the map.
   */
  async forceReconnect(serverName: string): Promise<MCPServiceResponse> {
    log.info(`forceReconnect: Forcing fresh connection for server ${serverName}`);

    // Nothing to rebuild for the built-in internal server.
    if (await this.isInternalServer(serverName)) {
      return { success: true };
    }

    const existing = this.clients.get(serverName);
    if (existing) {
      // Deregister BEFORE closing so the close event is recognized as FLUJO-initiated
      // (see deregisterClient) and does not schedule a competing reconnect.
      this.deregisterClient(serverName);
      const config = await this.getServerConfig(serverName);
      try {
        await safelyCloseClient(existing, serverName, config || undefined);
      } catch (closeError) {
        log.debug(`forceReconnect: error closing stale client for ${serverName}: ${closeError instanceof Error ? closeError.message : String(closeError)}`);
      }
    }

    return this.connectServer(serverName);
  }

  /**
   * List tools available from an MCP server.
   *
   * A client object in the map does NOT guarantee a live connection: streamable-HTTP /
   * SSE sessions expire server-side, processes die, networks blip - and the SDK only fires
   * transport.onclose/onerror for *some* of those cases, so a dead client can linger in the
   * map indefinitely. When that happens client.listTools() fails. Rather than surface an
   * empty/failed list (which upstream silently turned into "this node has no MCP tools"),
   * we force a single reconnect-and-retry. Listing tools is idempotent, so retrying is safe.
   */
  async listServerTools(serverName: string): Promise<{ tools: ToolResponse[], error?: string }> {
    log.debug(`listServerTools: Entering method for server ${serverName}`);

    // The built-in internal server answers in-process — no client, no reconnect
    // machinery. Dynamic import on purpose: internalTools transitively imports
    // modules that import mcpService back (see internalServerConfig.ts).
    if (await this.isInternalServer(serverName)) {
      // A disabled built-in server behaves like any disabled server (issue #170).
      if (await this.isServerDisabled(serverName)) {
        const error = `Server '${serverName}' is disabled. Enable it on the MCP page to use it.`;
        log.warn(`listServerTools: ${error}`);
        return { tools: [], error };
      }
      const { internalToolDefinitionsFor } = await import('./internal/dispatch');
      return { tools: await internalToolDefinitionsFor(serverName) };
    }

    // Point-of-use guard on top of the connect-time hard gate (issue #54): fail
    // loudly instead of attempting a pointless reconnect against a disabled server.
    if (await this.isServerDisabled(serverName)) {
      const error = `Server '${serverName}' is disabled. Enable it on the MCP page to use it.`;
      log.warn(`listServerTools: ${error}`);
      return { tools: [], error };
    }

    let client = this.getClient(serverName);
    if (!client) {
      log.warn(`listServerTools: Client not found for ${serverName}`);
    }

    let result = await listTools(client, serverName);

    if (result.error) {
      // The connection is likely stale/dead - reconnect from scratch and try once more
      // before giving up, so a recoverable blip does not silently strip a node's tools.
      log.warn(`listServerTools: Listing tools for ${serverName} failed (${result.error}); forcing reconnect and retrying once`);

      const reconnect = await this.forceReconnect(serverName);
      if (!reconnect.success) {
        log.warn(`listServerTools: Reconnect for ${serverName} failed: ${reconnect.error}`);
        return { tools: [], error: reconnect.error || result.error };
      }

      client = this.clients.get(serverName);
      result = await listTools(client, serverName);

      if (result.error) {
        log.warn(`listServerTools: Retry after reconnect still failed for ${serverName}:`, result.error);
      } else {
        log.info(`listServerTools: Recovered after reconnect for ${serverName}; listed ${result.tools.length} tools`);
      }
    } else {
      log.info(`listServerTools: Listed ${result.tools.length} tools for ${serverName}`);
    }

    return result;
  }

  /**
   * Call a tool on an MCP server
   */
  async callTool(serverName: string, toolName: string, args: ToolArgs, timeout?: number, onProgress?: (progress: ToolCallProgress) => void): Promise<MCPServiceResponse> {
    log.debug(`callTool: Entering method for server ${serverName}, tool ${toolName}`);

    // The built-in internal server dispatches in-process. The dispatcher always
    // resolves to a CallToolResult (tool-level failures come back as isError
    // results), matching how a real server's tool errors flow through `data`.
    if (await this.isInternalServer(serverName)) {
      // A disabled built-in server must not be invoked (issue #170).
      if (await this.isServerDisabled(serverName)) {
        const error = `Server '${serverName}' is disabled. Enable it on the MCP page to use it.`;
        log.warn(`callTool: ${error}`);
        return { success: false, error };
      }
      const { internalCallToolFor } = await import('./internal/dispatch');
      const result = await internalCallToolFor(this, serverName, toolName, args);
      log.info(`callTool: Dispatched internal tool ${toolName} on ${serverName}`);
      return { success: true, data: result };
    }

    // Disabled servers must never be invoked — even if a live client somehow
    // lingers after disabling (issue #54). This point-of-use guard sits on top of
    // the connect-time hard gate so callers (scheduler polls, chat tool calls) get
    // a precise error instead of a pointless reconnect attempt.
    if (await this.isServerDisabled(serverName)) {
      const error = `Server '${serverName}' is disabled. Enable it on the MCP page to use it.`;
      log.warn(`callTool: ${error}`);
      return { success: false, error };
    }

    let client = this.getClient(serverName);

    // Self-heal BEFORE invoking the tool, and only when there is NO client in the map
    // (e.g. right after a FLUJO restart, or a dropped connection that cleared the map).
    // This is the case that matters for "a flow runs right after a restart". Crucially,
    // we reconnect *before* the call, never retry *after* a failure: the tool has not run
    // yet, so this can never double-execute a side-effecting tool. We deliberately do NOT
    // try to interpret a failed result as "disconnected" — tools.ts maps MCP -32601
    // (method-not-found) and any tool whose own error text contains "not found"/"404" to
    // statusCode 404, none of which mean the connection is dead. A dead-but-present client
    // (e.g. expired HTTP session) is healed by the listServerTools reconnect that the flow
    // path runs before calling tools.
    if (!client) {
      log.warn(`callTool: No client for ${serverName}; forcing reconnect before calling ${toolName}`);
      const reconnect = await this.forceReconnect(serverName);
      if (reconnect.success) {
        client = this.clients.get(serverName);
      } else {
        log.warn(`callTool: Reconnect for ${serverName} failed: ${reconnect.error}`);
      }
    }

    const result = await callToolFunction(client, serverName, toolName, args, timeout, onProgress);
    log.info(`callTool: Called tool ${toolName} on ${serverName}`);
    return result;
  }

  /**
   * Run a list-capability call, reconnecting once if the cached client is stale/dead.
   *
   * Same rationale as listServerTools: a client object in the map does not guarantee a
   * live connection, so a recoverable blip should not silently strip a node's bound
   * resources/prompts. `lister` returns its own typed shape carrying an optional `error`;
   * a present `error` triggers a single force-reconnect-and-retry. Capability-absent
   * servers return an empty list with NO error (see resources.ts/prompts.ts), so they do
   * not trigger a pointless reconnect.
   */
  private async listWithReconnect<T extends { error?: string }>(
    serverName: string,
    lister: (client: Client | undefined, serverName: string) => Promise<T>,
    emptyResult: T
  ): Promise<T> {
    // The built-in internal server never goes through client machinery. Its
    // resources are short-circuited in listServerResources/-Templates BEFORE
    // this method; anything else that reaches here (prompts) is empty.
    if (await this.isInternalServer(serverName)) {
      return emptyResult;
    }

    // Point-of-use guard on top of the connect-time hard gate (issue #54).
    if (await this.isServerDisabled(serverName)) {
      const error = `Server '${serverName}' is disabled. Enable it on the MCP page to use it.`;
      log.warn(`listWithReconnect: ${error}`);
      return { ...emptyResult, error };
    }

    let client = this.getClient(serverName);
    if (!client) {
      log.warn(`listWithReconnect: Client not found for ${serverName}`);
    }

    let result = await lister(client, serverName);
    if (!result.error) {
      return result;
    }

    log.warn(`listWithReconnect: Listing for ${serverName} failed (${result.error}); forcing reconnect and retrying once`);
    const reconnect = await this.forceReconnect(serverName);
    if (!reconnect.success) {
      log.warn(`listWithReconnect: Reconnect for ${serverName} failed: ${reconnect.error}`);
      return { ...emptyResult, error: reconnect.error || result.error };
    }

    client = this.clients.get(serverName);
    result = await lister(client, serverName);
    if (result.error) {
      log.warn(`listWithReconnect: Retry after reconnect still failed for ${serverName}:`, result.error);
    } else {
      log.info(`listWithReconnect: Recovered after reconnect for ${serverName}`);
    }
    return result;
  }

  /**
   * List the resources a server publishes (#15). Reconnect-and-retry like listServerTools.
   */
  async listServerResources(serverName: string): Promise<{ resources: MCPResource[]; error?: string }> {
    log.debug(`listServerResources: Entering method for server ${serverName}`);
    // The built-in `flujo` server publishes RUN-SCOPED resources in-process
    // (Tier 3 data flow). Dynamic import mirrors the internalTools pattern. Other
    // built-ins (filesystem/bash) publish no resources.
    if (serverName === INTERNAL_SERVER_NAME && await this.isInternalServer(serverName)) {
      const { internalListResources } = await import('./internalResources');
      return internalListResources();
    }
    // The built-in `filesystem` server publishes its MCP App UI (#97).
    if (serverName === FILESYSTEM_SERVER_NAME) {
      const { filesystemListResources } = await import('./internal/filesystemResources');
      return filesystemListResources();
    }
    return this.listWithReconnect(serverName, listResources, { resources: [] });
  }

  /**
   * List the resource templates a server publishes (#15).
   */
  async listServerResourceTemplates(serverName: string): Promise<{ resourceTemplates: MCPResourceTemplate[]; error?: string }> {
    log.debug(`listServerResourceTemplates: Entering method for server ${serverName}`);
    if (serverName === INTERNAL_SERVER_NAME && await this.isInternalServer(serverName)) {
      const { internalListResourceTemplates } = await import('./internalResources');
      return internalListResourceTemplates();
    }
    return this.listWithReconnect(serverName, listResourceTemplates, { resourceTemplates: [] });
  }

  /**
   * Read a resource's contents from a server (#15).
   */
  async readResource(serverName: string, uri: string): Promise<MCPServiceResponse<MCPReadResourceResult>> {
    log.debug(`readResource: Entering method for server ${serverName}, uri ${uri}`);
    // Run-scoped resources are served in-process by the `flujo` server —
    // this also makes `${resource:flujo__flujo://run/...}` pills work.
    if (serverName === INTERNAL_SERVER_NAME && await this.isInternalServer(serverName)) {
      const { internalReadResource } = await import('./internalResources');
      return internalReadResource(uri);
    }
    // The built-in `filesystem` server serves its MCP App UI HTML in-process (#97).
    if (serverName === FILESYSTEM_SERVER_NAME) {
      const { filesystemReadResource, isFilesystemAppUri } = await import('./internal/filesystemResources');
      if (isFilesystemAppUri(uri)) return filesystemReadResource(uri);
    }
    const client = this.getClient(serverName);
    if (!client) {
      log.warn(`readResource: Client not found for ${serverName}`);
    }
    const result = await readResourceFn(client, serverName, uri);
    log.info(`readResource: Read resource ${uri} on ${serverName}`);
    return result;
  }

  /**
   * List the prompt templates a server publishes (#15).
   */
  async listServerPrompts(serverName: string): Promise<{ prompts: MCPPrompt[]; error?: string }> {
    log.debug(`listServerPrompts: Entering method for server ${serverName}`);
    return this.listWithReconnect(serverName, listPrompts, { prompts: [] });
  }

  /**
   * Fetch a prompt template, expanded with arguments, from a server (#15).
   */
  async getPrompt(serverName: string, promptName: string, args?: Record<string, string>): Promise<MCPServiceResponse<MCPGetPromptResult>> {
    log.debug(`getPrompt: Entering method for server ${serverName}, prompt ${promptName}`);
    const client = this.getClient(serverName);
    if (!client) {
      log.warn(`getPrompt: Client not found for ${serverName}`);
    }
    const result = await getPromptFn(client, serverName, promptName, args);
    log.info(`getPrompt: Got prompt ${promptName} on ${serverName}`);
    return result;
  }

  /**
   * Decide what to persist for a streamable server's OAuth client secret, given the value the
   * browser sent and the currently-stored value. Same contract as the model service's
   * API-key handling so the two behave identically:
   *   - MASKED_API_KEY        -> keep the existing stored secret (the UI never saw the real one)
   *   - "${global:VAR}"       -> a global-variable binding; store the reference verbatim
   *   - "encrypted[_failed]:"  -> already encrypted; store as-is (idempotent, no double-encrypt)
   *   - "" (empty)            -> cleared/unbound; store empty
   *   - anything else         -> a freshly typed plaintext secret; encrypt it at rest
   */
  private async resolveOAuthSecretForSave(incoming: string, existing: string | undefined): Promise<string> {
    if (incoming === MASKED_API_KEY) return existing ?? '';
    if (!incoming) return '';
    if (incoming.startsWith('${global:')) return incoming;
    if (incoming.startsWith('encrypted:') || incoming.startsWith('encrypted_failed:')) return incoming;
    return await encryptApiKey(incoming);
  }

  /**
   * Decide what to persist for a remote server's custom HTTP headers (#84), given the header
   * map the browser sent and the currently-stored map. Non-secret headers are stored verbatim.
   * Secret headers follow the same contract as the OAuth client secret / model API keys so
   * they behave identically:
   *   - MASKED_API_KEY / MASKED_STRING -> keep the existing stored value (UI never saw the real one)
   *   - "${global:VAR}"                -> a global-variable binding; store the reference verbatim
   *   - "encrypted[_failed]:"           -> already encrypted; store as-is (no double-encrypt)
   *   - "" (empty)                     -> cleared; drop the header
   *   - anything else                  -> a freshly typed plaintext secret; encrypt it at rest
   */
  private async resolveHeadersForSave(
    incoming: Record<string, MCPHeaderValue>,
    existing: Record<string, MCPHeaderValue> | undefined,
  ): Promise<Record<string, MCPHeaderValue>> {
    const result: Record<string, MCPHeaderValue> = {};
    for (const [key, raw] of Object.entries(incoming || {})) {
      if (!key) continue;
      const { value, isSecret } = normalizeHeaderValue(raw, key);

      if (!isSecret) {
        // Non-secret header: store verbatim (drop empties). Keep the object shape so the
        // per-header secret flag round-trips.
        if (value !== '') {
          result[key] = { value, metadata: { isSecret: false } };
        }
        continue;
      }

      // Secret header handling, mirroring resolveOAuthSecretForSave.
      if (isMaskedHeaderValue(value)) {
        const prev = existing?.[key];
        if (prev !== undefined) result[key] = prev; // keep the stored (encrypted/bound) value
        continue;
      }
      if (!value) continue; // cleared
      if (isGlobalBinding(value) || value.startsWith('encrypted:') || value.startsWith('encrypted_failed:')) {
        result[key] = { value, metadata: { isSecret: true } };
        continue;
      }
      result[key] = { value: await encryptApiKey(value), metadata: { isSecret: true } };
    }
    return result;
  }

  /**
   * Update an MCP server configuration
   */
  /**
   * Eagerly create the root dir of a remote (streamable/SSE/websocket) server (issue 52).
   * Remote servers default to mcp-servers/<name> like stdio servers, but nothing else
   * ever creates that folder for them (no clone/install step). Only safe, scoped paths
   * are created: filesystem roots are skipped, and relative paths resolve against the
   * data dir (where mcp-servers/ lives). Best-effort — failures are logged, never thrown.
   */
  private async ensureRemoteServerRootDir(config: MCPServerConfig): Promise<void> {
    try {
      if (!['streamable', 'sse', 'websocket'].includes(config.transport)) return;
      const rootPath = (config.rootPath || '').trim();
      if (!rootPath) return;
      const resolved = path.resolve(getDataDir(), rootPath);
      // Never create (or touch) a filesystem root — a root is its own parent.
      if (path.dirname(resolved) === resolved) return;
      await fs.mkdir(resolved, { recursive: true });
      log.debug(`ensureRemoteServerRootDir: ensured ${resolved} for ${config.name}`);
    } catch (error) {
      log.warn(`ensureRemoteServerRootDir: could not create root dir for ${config.name}:`, error);
    }
  }

  async updateServerConfig(serverName: string, updates: Partial<MCPServerConfig>): Promise<MCPServerConfig | MCPServiceResponse> {
    log.debug(`updateServerConfig: Entering method for server ${serverName}`);

    // The built-in internal servers are synthesized, not stored — their command/
    // env/name cannot be edited, and this also blocks CREATING a server under a
    // reserved name (the POST route funnels through here). Renaming another server
    // onto a reserved name is caught by the duplicate check below, since
    // loadServerConfigs() always contains the synthetic entries. The ONE mutation
    // that IS allowed is toggling `disabled` on/off (issue #170): it is persisted
    // as a tiny override, never as the synthetic config itself.
    if (await this.isInternalServer(serverName)) {
      const keys = Object.keys(updates).filter(k => k !== 'name');
      const nameOk = updates.name === undefined || updates.name === serverName;
      const onlyDisabledChange =
        keys.length > 0 && keys.every(k => k === 'disabled') && typeof updates.disabled === 'boolean' && nameOk;
      // The `filesystem` and `bash` built-ins additionally allow configuring their
      // confinement roots (issues #170 + #175): persisted as a tiny override, never
      // as the synthetic config.
      const onlyRootsChange =
        (serverName === FILESYSTEM_SERVER_NAME || serverName === BASH_SERVER_NAME) &&
        keys.length > 0 &&
        keys.every(k => k === 'roots') &&
        Array.isArray(updates.roots) &&
        nameOk;
      if (onlyDisabledChange) {
        await setInternalServerDisabled(serverName, updates.disabled as boolean);
        log.info(`updateServerConfig: Toggled built-in server ${serverName} disabled=${updates.disabled}`);
        const refreshed = await this.loadServerConfigs();
        const cfg = Array.isArray(refreshed) ? refreshed.find(c => c.name === serverName) : undefined;
        return cfg ?? { success: true };
      }
      if (onlyRootsChange) {
        await setInternalServerRoots(serverName, updates.roots as string[]);
        log.info(`updateServerConfig: Set built-in ${serverName} roots (${(updates.roots as string[]).length})`);
        const refreshed = await this.loadServerConfigs();
        const cfg = Array.isArray(refreshed) ? refreshed.find(c => c.name === serverName) : undefined;
        return cfg ?? { success: true };
      }
      return {
        success: false,
        error: `"${serverName}" is a FLUJO built-in server: only enabling/disabling it is allowed, not editing.`,
      };
    }

    // Load all configs from storage
    const configsResult = await this.loadServerConfigs();
    if (!Array.isArray(configsResult)) {
      log.warn(`updateServerConfig: Failed to load configs:`, configsResult.error);
      return configsResult;
    }
    
    const configs = configsResult;
    let config = configs.find(c => c.name === serverName);

    // A rename arrives as a PUT whose path is the CURRENT (old) name and whose body
    // carries a different `name`. Detect it up front: the storage swap below already
    // re-keys the entry, but the live connection and per-name state are still keyed by
    // the old name and must be migrated explicitly (see the connection handling at the
    // end of this method).
    const isRename =
      !!config && typeof updates.name === 'string' && updates.name !== serverName;

    // Refuse to rename onto a name another server already uses: the configs are keyed by
    // name, so saving would silently drop one of the two. Surface it as an error instead.
    if (isRename && configs.some(c => c.name === updates.name)) {
      log.warn(`updateServerConfig: Refusing to rename ${serverName} -> ${updates.name}: name already in use`);
      return { success: false, error: `A server named "${updates.name}" already exists` };
    }

    if (!config && updates.name) {
      // New server being added - default to stdio transport
      log.info(`updateServerConfig: Creating new server config for ${updates.name}`);
      config = {
        name: updates.name,
        transport: 'stdio',
        command: '',
        args: [],
        env: {},
        disabled: false,
        autoApprove: [],
        _buildCommand: '',
        _installCommand: '',
        rootPath: '',
      };
      configs.push(config);
    } else if (!config) {
      log.warn(`updateServerConfig: Server ${serverName} not found`);
      return { success: false, error: `Server ${serverName} not found` };
    }

    // If env variables are being updated, resolve any global variable references
    if (updates.env) {
      log.debug(`updateServerConfig: Resolving global variables in env for ${serverName}`);
      try {
        // Log the original env variables for debugging
        log.debug(`Original env variables for ${serverName}:`, JSON.stringify(updates.env, null, 2));
        
        // Resolve global variables in the environment variables and update directly
        updates.env = await resolveGlobalVars(updates.env) as Record<string, string>;
        
        // Log the resolved env variables for debugging
        log.debug(`Resolved env variables for ${serverName}:`, JSON.stringify(updates.env, null, 2));
        
        log.debug(`updateServerConfig: Successfully resolved global variables for ${serverName}`);
      } catch (error) {
        log.warn(`updateServerConfig: Error resolving global variables for ${serverName}:`, error);
        // Continue with the update even if global variable resolution fails
      }
    }

    // OAuth client secret handling, mirroring model API-key semantics. The browser only ever
    // sends MASKED_API_KEY (meaning "keep the stored secret"), a "${global:VAR}" binding, or a
    // freshly typed plaintext secret — never the real stored value. Encrypt plaintext at rest;
    // keep bindings and already-encrypted values as-is; an empty value clears it.
    const incomingSecret = (updates as Partial<MCPStreamableConfig>).oauthClientSecret;
    if (incomingSecret !== undefined) {
      const existingSecret = (config as MCPStreamableConfig).oauthClientSecret;
      (updates as Partial<MCPStreamableConfig>).oauthClientSecret =
        await this.resolveOAuthSecretForSave(incomingSecret, existingSecret);
    }

    // Custom-header secret handling (#84), mirroring the OAuth secret contract above. Unlike
    // env vars (resolved/baked in at save above), header ${global:} bindings are stored
    // verbatim and resolved fresh at connect time (resolveConfigHeaders) so rotating the bound
    // global takes effect without re-saving the server.
    const incomingHeaders = (updates as Partial<MCPSSEConfig | MCPStreamableConfig>).headers;
    if (incomingHeaders !== undefined) {
      const existingHeaders = (config as MCPSSEConfig | MCPStreamableConfig).headers;
      (updates as Partial<MCPSSEConfig | MCPStreamableConfig>).headers =
        await this.resolveHeadersForSave(incomingHeaders, existingHeaders);
    }

    // Update the config with the new values (including resolved env variables)
    let updatedConfig: MCPServerConfig = { ...config };
    updatedConfig = {
      ...config,
      ...updates,
    } as MCPServerConfig;

    // Did this update change the server's effective roots (configured roots list or the
    // rootPath default that roots/list falls back to)? Roots never trigger a client
    // rebuild (issue 46), so a connected server is told about the change via
    // notifications/roots/list_changed after the update is applied below.
    const effectiveRootsChanged =
      JSON.stringify((config as { roots?: string[] }).roots ?? []) !==
        JSON.stringify((updatedConfig as { roots?: string[] }).roots ?? []) ||
      (config.rootPath ?? '') !== (updatedConfig.rootPath ?? '');

    // Find and update the config in the array
    const index = configs.findIndex(c => c.name === serverName);
    if (index !== -1) {
      configs[index] = updatedConfig;
    } else if (updatedConfig.name) {
      // This is a new config
      configs.push(updatedConfig);
    }
    
    // Save all configs to storage
    const saveResult = await saveConfig(new Map(configs.map(c => [c.name, c])));
    if (!saveResult.success) {
      log.warn(`updateServerConfig: Failed to save config for ${serverName}:`, saveResult.error);
      return saveResult;
    }

    // Remote servers spawn no process, but their root dir (default mcp-servers/<name>,
    // issue 52) is where folder pickers, per-node roots and future file work point.
    // Eagerly create it so the server always has a folder to work in. Best-effort:
    // a failure here must never block the config update.
    await this.ensureRemoteServerRootDir(updatedConfig);

    // Handle connection state based on config changes.
    if (isRename) {
      // The server now lives under a new name. Tear down everything still keyed by the
      // OLD name — the live client (and its child process), retry timers, captured
      // stderr and the last connection error — so the rename doesn't leak a dangling
      // process or surface stale status under the old name. Then drive the connection
      // under the NEW name.
      if (this.clients.has(serverName)) {
        await this.disconnectServer(serverName);
      } else {
        this.clearRetryTimer(serverName);
        this.connectionRetryAttempts.delete(serverName);
      }
      this.stderrLogs.delete(serverName);
      this.lastConnectionError.delete(serverName);

      await this.handleConnectionStateChange(updatedConfig.name, updatedConfig);
    } else {
      await this.handleConnectionStateChange(serverName, updatedConfig);
    }

    if (effectiveRootsChanged) {
      this.notifyRootsChanged(updatedConfig.name);
    }

    log.info(`updateServerConfig: Successfully updated config for ${serverName}${isRename ? ` (renamed to ${updatedConfig.name})` : ''}`);
    return updatedConfig;
  }

  /**
   * Handle connection state changes when a server config is updated
   * 
   * This function is called after a server config is updated in storage.
   * It manages the connection state based on the updated config:
   * - If the server is enabled (disabled=false), it attempts to connect it
   * - If the server is disabled (disabled=true), it disconnects it if currently connected
   * 
   * Note: This function does not affect whether the config update itself was successful.
   * The config update can succeed even if the server fails to connect with the new config.
   * This separation allows users to fix configuration issues without being blocked by
   * connection failures.
   */
  private async handleConnectionStateChange(serverName: string, config: MCPServerConfig): Promise<void> {
    log.debug(`handleConnectionStateChange: Entering method for server ${serverName}`);
    
    // Global-aware: the live client may exist only in the shared recovery map
    // (owned by another module instance). A local this.clients.has() check would
    // miss it and skip the "re-apply config to connected server" path that a PAT/
    // header edit needs to rebuild the connection.
    const isCurrentlyConnected = !!this.getClient(serverName);
    const shouldBeConnected = !config.disabled;

    if (isCurrentlyConnected && !shouldBeConnected) {
      // If server should be disabled, disconnect it
      log.info(`handleConnectionStateChange: Disconnecting disabled server ${serverName}`);
      try {
        await this.disconnectServer(serverName);
      } catch (error) {
        log.warn(`handleConnectionStateChange: Failed to disconnect server ${serverName} during update:`, error);
      }
    } else if (!isCurrentlyConnected && shouldBeConnected) {
      // If the server should be enabled but isn't connected, connect it
      log.info(`handleConnectionStateChange: Connecting previously disabled server ${serverName}`);
      await this.connectServer(config);
    } else if (isCurrentlyConnected && shouldBeConnected) {
      // Server stays enabled, but its config may have changed (command, args, env,
      // URL, auth material...). Re-run connectServer: shouldRecreateClient rebuilds the
      // connection only when something meaningful actually changed (otherwise it's a
      // cheap no-op). Roots changes alone never rebuild (issue 46) — they are announced
      // via notifications/roots/list_changed by updateServerConfig instead.
      log.info(`handleConnectionStateChange: Re-applying config to connected server ${serverName}`);
      await this.connectServer(config);
    } else if (!shouldBeConnected) {
      // If server should be disabled, also clear any pending retry timers
      log.info(`handleConnectionStateChange: Clearing retry timers for disabled server ${serverName}`);
      this.clearRetryTimer(serverName);
      this.connectionRetryAttempts.delete(serverName);
    }
  }

  /**
   * Clear all retry timers for disabled servers
   */
  private async clearRetryTimersForDisabledServers(): Promise<void> {
    log.debug('clearRetryTimersForDisabledServers: Checking for disabled servers with active retry timers');
    
    try {
      // Load current configs from storage
      const configs = await this.loadServerConfigs();
      
      if (!Array.isArray(configs)) {
        log.warn('clearRetryTimersForDisabledServers: Failed to load server configs');
        return;
      }
      
      // Find all disabled servers
      const disabledServers = configs.filter(config => config.disabled);
      
      // Clear retry timers for disabled servers
      for (const config of disabledServers) {
        if (this.connectionRetryTimers.has(config.name)) {
          log.info(`clearRetryTimersForDisabledServers: Clearing retry timer for disabled server ${config.name}`);
          this.clearRetryTimer(config.name);
          this.connectionRetryAttempts.delete(config.name);
        }
      }
    } catch (error) {
      log.error('clearRetryTimersForDisabledServers: Error clearing retry timers:', error);
    }
  }

  /**
   * Delete an MCP server configuration
   */
  async deleteServerConfig(serverName: string): Promise<MCPServiceResponse> {
    log.debug(`deleteServerConfig: Entering method for server ${serverName}`);

    // The built-in internal server is synthesized, not stored — it cannot be deleted.
    if (await this.isInternalServer(serverName)) {
      return {
        success: false,
        error: `"${INTERNAL_SERVER_NAME}" is FLUJO's built-in server and cannot be deleted.`,
      };
    }

    // First disconnect if connected
    if (this.clients.has(serverName)) {
      log.info(`deleteServerConfig: Disconnecting server ${serverName} before deletion`);
      await this.disconnectServer(serverName);
    }

    // Load all configs from storage
    const configsResult = await this.loadServerConfigs();
    if (!Array.isArray(configsResult)) {
      log.warn(`deleteServerConfig: Failed to load configs:`, configsResult.error);
      return configsResult;
    }
    
    const configs = configsResult;
    
    // Find the config to delete
    const index = configs.findIndex(c => c.name === serverName);
    if (index === -1) {
      log.warn(`deleteServerConfig: Server ${serverName} not found in configs`);
      return { success: false, error: `Server ${serverName} not found` };
    }
    
    // Remove the config from the array
    configs.splice(index, 1);
    
    // Save updated configs
    log.debug(`deleteServerConfig: Saving updated configs after deleting ${serverName}`);
    const saveResult = await saveConfig(new Map(configs.map(c => [c.name, c])));
    
    if (saveResult.success) {
      log.info(`deleteServerConfig: Successfully deleted server ${serverName}`);
    } else {
      log.warn(`deleteServerConfig: Error saving configs after deleting ${serverName}:`, saveResult.error);
    }
    
    return saveResult;
  }

  /**
   * Get the connection status of an MCP server
   */
  async getServerStatus(serverName: string): Promise<{ status: string; message?: string; stderrOutput?: string }> {
    // The built-in internal server runs in-process: it is connected by definition,
    // unless it has been toggled off (issue #170).
    if (await this.isInternalServer(serverName)) {
      if (await this.isServerDisabled(serverName)) {
        return { status: 'disconnected' };
      }
      return { status: 'connected' };
    }

    // Get the config directly from storage
    const config = await this.getServerConfig(serverName);
    if (!config) {
      log.warn(`getServerStatus: Server ${serverName} not found`);
      return { 
        status: 'error', 
        message: `Server ${serverName} configuration not found. The server may have been deleted or not properly configured.` 
      };
    }

    if (config.disabled) {
      log.debug(`getServerStatus: Server ${serverName} is disabled`);
      return { status: 'disconnected' };
    }

    // Check if this is a streamable server that requires OAuth but has no tokens
    if (config.transport === 'streamable') {
      const streamableConfig = config as MCPStreamableConfig;
      if (streamableConfig.oauthScopes && streamableConfig.oauthScopes.length > 0) {
        // This server requires OAuth authentication
        if (!streamableConfig.oauthTokens || !streamableConfig.oauthTokens.access_token) {
          log.info(`getServerStatus: Server ${serverName} requires OAuth authentication but has no valid tokens`);
          return {
            status: 'requires_authentication',
            message: 'OAuth authentication required. Click the authenticate button to complete the OAuth flow.'
          };
        }
        
        // An expired access token only means "re-authenticate" when there is no refresh
        // token to renew it with. With a refresh_token stored, the next connection attempt
        // refreshes silently (see MCPOAuthClientProvider.tokens), so fall through to the
        // real connection state instead of flashing the auth badge after every restart.
        if (
          !streamableConfig.oauthTokens.refresh_token &&
          streamableConfig.oauthTokens.expires_in &&
          (streamableConfig.oauthTokens as any).issued_at
        ) {
          const issuedAt = (streamableConfig.oauthTokens as any).issued_at;
          const expiresIn = streamableConfig.oauthTokens.expires_in;
          const currentTime = Math.floor(Date.now() / 1000);
          const expirationTime = issuedAt + expiresIn;

          if (currentTime >= expirationTime) {
            log.info(`getServerStatus: OAuth tokens for ${serverName} have expired and no refresh token is available`);
            return {
              status: 'requires_authentication',
              message: 'OAuth tokens have expired. Please re-authenticate.'
            };
          }
        }
      }
    }

    // Get any stderr logs for this server
    const stderrLogs = this.stderrLogs.get(serverName) || [];
    const stderrOutput = stderrLogs.join('\n').trim();
    // The last persisted connection failure (survives the per-attempt stderr buffer reset).
    const persistedError = this.lastConnectionError.get(serverName);

    // Check if the client exists — via getClient so a closed/aborted connection reads
    // as "not connected" instead of lying "connected" until something trips over it.
    // The map itself is shared across module instances, so a client connected by the
    // startup instance is visible here without any adoption step.
    const clientExists = !!this.getClient(serverName);

    if (clientExists) {
      log.info(`getServerStatus: Server ${serverName} is connected`);
      return {
        status: 'connected',
        stderrOutput: stderrOutput || undefined
      };
    } else {
      // The backend may still be bringing this server up - either an attempt is
      // in flight right now, or the initial startup sweep hasn't reached it yet
      // (it's still queued). Report a transient "connecting" state so the MCP page
      // shows a spinner and keeps polling, instead of the misleading
      // "configured but not connected" error the user would otherwise see for the
      // first few seconds after launch. A server that has already recorded a real
      // connection failure falls through to that error even during startup.
      const startupPending = this.isStartingUp() && !this.lastConnectionError.has(serverName);
      if (this.connectingServers.has(serverName) || startupPending) {
        log.info(`getServerStatus: Server ${serverName} is still connecting`);
        return {
          status: 'connecting',
          message: 'Server is starting up. This may take a few moments.'
        };
      }

      // Check if stderr contains OAuth authentication errors
      if (stderrOutput && (stderrOutput.includes('OAuth authentication required') || stderrOutput.includes('invalid_token'))) {
        log.info(`getServerStatus: OAuth authentication error detected for ${serverName}`);
        return {
          status: 'requires_authentication',
          message: 'OAuth authentication required. Please complete the OAuth flow.',
          stderrOutput: stderrOutput
        };
      }
      
      // Use the live stderr output if present, otherwise the last persisted connection
      // error. HTTP transports fail inside connect() and produce no live stderr, so the
      // persisted error is what makes the real reason visible here.
      const effectiveError = stderrOutput || persistedError;
      if (effectiveError) {
        log.info(`getServerStatus: Using ${stderrOutput ? 'stderr output' : 'persisted connection error'} as error message for ${serverName}`);
        return {
          status: 'error',
          message: effectiveError,
          stderrOutput: stderrOutput || undefined
        };
      }

      // No stderr and no persisted error. We deliberately do NOT spawn the server process
      // here to "capture an error" — that direct-execution probe ran with a 5s timeout PER
      // disconnected stdio server and was the dominant cost of loading the /mcp page (N
      // servers x up to 5s). The connection itself (and its real error) is established by
      // connectServer / the on-demand reconnect in listServerTools & callTool, which is
      // where errors get persisted. Just report the generic state instantly.
      log.info(`getServerStatus: No specific error details available for ${serverName}`);
      return {
        status: 'error',
        message: `Server ${serverName} is configured but not connected. The server process may have crashed or been terminated.`,
        stderrOutput: undefined
      };
    }
  }

  /**
   * Start all enabled servers
   */
  async startEnabledServers(): Promise<void> {
    log.info('Starting all enabled servers');
    this.setStartingUp(true);

    try {
      // First, clear any retry timers for disabled servers
      await this.clearRetryTimersForDisabledServers();

      // Load configs directly from storage
      const configs = await this.loadServerConfigs();

      // Skip if there was an error loading configs
      if (!Array.isArray(configs)) {
        log.warn('Failed to load server configs, cannot start servers');
        return;
      }

      // Find all enabled servers
      const enabledServers = configs.filter(config => !config.disabled);
      log.info(`Found ${enabledServers.length} enabled servers to start`);
      log.debug(`${enabledServers}`);

      // Mark every enabled server as "connecting" up front so the MCP page shows a
      // spinner for all of them while the sweep runs. connectServer() clears each
      // entry as its attempt settles.
      enabledServers.forEach(config => this.connectingServers.add(config.name));

      // Connect enabled servers with BOUNDED concurrency. Connecting sequentially made
      // startup scale with the SUM of every server's connect time (one slow/hanging
      // server delayed all the others, and the page sat in "connecting"/error far too
      // long). But the opposite extreme — an unbounded Promise.all — forks EVERY enabled
      // stdio server at once, a thundering-herd fork storm that spikes CPU/RAM and OOMs
      // small (e.g. 1-vCPU suspend/resume) hosts on every wake. A small pool keeps
      // startup off the sequential worst case while capping the simultaneous fork load.
      // Tunable via FLUJO_MCP_BOOT_CONCURRENCY (default 2). Each connectServer() already
      // catches its own failures and never rejects.
      const bootConcurrency = Math.max(1, Number(process.env.FLUJO_MCP_BOOT_CONCURRENCY) || 2);
      log.info(`Connecting ${enabledServers.length} enabled servers with boot concurrency ${bootConcurrency}`);
      await runWithConcurrency(enabledServers, bootConcurrency, async (config) => {
        log.info(`Starting server: ${config.name}`);
        await this.connectServer(config).catch(error => {
          log.error(`Failed to start server ${config.name}:`, error);
          // Swallow so one failure doesn't abort the others.
        });
      });
    } finally {
      // Always reset the flag when done, even if there were errors
      this.setStartingUp(false);
    }
  }

  /**
   * Get a list of all available clients for debugging purposes
   */
  async getAvailableClients(): Promise<string[]> {
    try {
      // Get all server configs directly from storage
      const configs = await this.loadServerConfigs();
      
      if (!configs || 'error' in configs) {
        log.warn('getAvailableClients: Failed to load server configs:', configs?.error);
        return [];
      }
      
      // Get the status of each server
      const serverStatuses = await Promise.all(
        (configs as MCPServerConfig[]).map(async (config: MCPServerConfig) => {
          try {
            const status = await this.getServerStatus(config.name);
            return {
              name: config.name,
              status: typeof status === 'string' ? status : status.status,
              connected: typeof status === 'string' ? 
                status === 'connected' : 
                status.status === 'connected'
            };
          } catch (error) {
            log.warn(`getAvailableClients: Error getting status for ${config.name}:`, error);
            return { name: config.name, status: 'error', connected: false };
          }
        })
      );
      
      // Return a formatted list of clients with their status
      return serverStatuses.map((s: { name: string, status: string }) => `${s.name} (${s.status})`);
    } catch (error) {
      log.error('getAvailableClients: Error getting available clients:', error);
      return [];
    }
  }
}

// Create and export the singleton instance for use in other server components
export const mcpService = new MCPService();
