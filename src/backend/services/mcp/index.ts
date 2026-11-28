import { liveClient, scopedRegistry } from './serviceRegistries';
import { readServerStatus } from './serverStatus';
import * as serviceSkills from './serviceSkills';
import { isUnparsableStdioLine, transportForHostInspection } from './transportInspection';
import { clearLegacyInferredOAuthScopesForHeaderAuth, hasConfiguredAuthorizationHeader } from './headerAuthScopes';
import { testConnection } from './connectionTest';
import * as serviceEvents from './serviceEvents';
import * as connectionScheduling from './connectionScheduling';
import * as serverConfigUpdate from './serverConfigUpdate';
import { ensureManagedServerRootDir } from './serverConfigSave';
import { subscribeModernResource, retireModernSubscriptions } from './modernSubscriptions';
import { completeRequiredUrlElicitations, requiredUrlElicitationsOf } from './elicitation';
import { mcpAppsEnabled } from '@/shared/utils/mcpClientFeatures';
import { getHarnessExecution, replayHarnessTool, harnessResourceSnapshot } from '@/backend/services/harness/executionScope';
import { assertBundledFlujoWorkloadEffectCurrent, BundledFlujoWorkloadError } from '../security/bundledFlujoWorkload';
import { executionApprovalFailure } from './executionApproval';
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { v4 as uuidv4 } from "uuid";
import { createLogger } from "@/utils/logger";
import { bindToCurrentWorkspace, DEFAULT_WORKSPACE, getCurrentWorkspace } from "@/utils/workspace";
import { isProtectedExecutionServer } from '@/backend/execution/extensions';
import { assertExecutionExtensionCurrent, assertExecutionServerConfig, assertExecutionToolDispatch, executionExtensionProtectedServer, executionProtectedServerConfig, type ExecutionExtensionContext } from '@/backend/execution/extensions';
import { assertMcpIsolationDispatch } from './isolation';
import { McpIsolationError } from '../security/isolatedMcp';
import { ExecutionExtensionError } from '@/backend/execution/extensions';
import { projectDirForToolCall } from '@/backend/services/projects/projectStore';
import { isMcpTransport, MCP_TRANSPORT_INVALID } from './transportAdmission';

// Import from backend modules
import {
  MCPServerConfig,
  MCPStreamableConfig,
  MCPSSEConfig,
  MCPServiceResponse,
  MCPToolResponse as ToolResponse,
  MCPStdioOAuthStatus,
  type MCPShutdownReceipt,
  type McpGetSkillResult,
  type McpLoadedSkill,
  type McpReadSkillDirectoryResult,
  type McpServerSkillsResult,
  type McpSkillsExtensionCapability,
  type McpVerifiedSkillResource,
} from "@/shared/types/mcp";
import { TestConnectionEvent } from "@/shared/types/streaming";
import { loadServerConfigs, saveConfig } from "./config";
import {
  beginConnect,
  beginTeardown,
  getLifecycleDiagnostics,
  getShutdownReceipt,
  peekRuntime,
  markConnectFailed,
  markConnected,
} from "./lifecycleCoordinator";
import {
  acquireLease,
  enforceWarmCapacity,
  getPoolDiagnostics,
  pinServer,
  sweepIdleServers,
  unpinServer,
  type AcquireResult,
} from "./mcpLeasePool";
import {
  listServerTools as listTools,
  callTool as callToolFunction,
  ToolCallProgress,
} from "./tools";
import {
  listServerResources as listResources,
  listServerResourceTemplates as listResourceTemplates,
  readResource as readResourceFn,
} from "./resources";
import {
  listServerPrompts as listPrompts,
  getPrompt as getPromptFn,
} from "./prompts";
import { resolveRuntimeHomeIsolation } from "./runtimeHomeIsolation";
import { noteStdioConnectFailure, takeClassicHandshakeRetry } from "./stdioNegotiation";
import {
  MCPResource,
  MCPResourceTemplate,
  MCPReadResourceResult,
  MCPPrompt,
  MCPGetPromptResult,
} from "@/shared/types/mcp";
import {
  enhanceConnectionErrorMessage,
  formatErrorChain,
  isAuthRequiredError,
  isOAuthAuthenticationError,
  isTransientStreamError,
} from "@/utils/mcp/utils";
import { probeOAuthSupport } from "@/utils/mcp/oauthProbe";
import {
  createNewClient,
  createTransport,
  resolveConfigHeaders,
  shouldRecreateClient,
  safelyCloseClient,
  protectedConfigFingerprint,
  clientProtectedConfigFingerprint,
  McpRuntimeAuthorityRetirementError,
  assertMcpRuntimeAuthorityRetired,
} from "./connection";
import {
  type McpEventDescriptor,
  type McpEventPollRequest,
  type McpEventPollResult,
  type McpEventSubscribeRequest,
  type McpEventSubscribeResult,
  type McpEventUnsubscribeRequest,
} from "./serverEvents";
import {
  MCP_EVENT_NOTIFICATIONS,
  registerMcpEventStreamHandlers,
  routeMcpEventNotification,
  type McpEventStream,
  type McpEventStreamHandlers,
  type McpEventStreamRequest,
} from "./serverEventStream";
import type { ExtensionNotificationHandlers } from "./betaClient";
import { registerResourceNotificationHandlers, registerToolListChangedHandler } from "./resourceNotifications";
import { CLAUDE_CHANNEL_METHOD, receiveClaudeChannelNotification, registerClaudeChannelHandler } from "./inboundEvents";
import { cachedMcpList, invalidateMcpLists } from "./listCache";
import {
  usesNegotiatingClient,
  createNewBetaClient,
  createBetaTransport,
  activateStdioOAuthMrtrController,
  getStdioOAuthMrtrController,
  negotiatedProtocolVersion,
} from "./betaClient";
import { setNodeRoots as setNodeRootsOverlay } from "./roots";
import { ToolCallSource, ToolListAudience } from "./appsProtocol";
import {
  createdTicketIdFromMcpResult,
  injectTrustedFlujoToolContext,
  trustedFlujoTicketConversationId,
  type TrustedMcpToolInvocationContext,
} from "./trustedToolContext";
import {
  cancelExternalAuthorization,
  clearExternalAuthorizationState,
  confirmExternalAuthorization,
  declineExternalAuthorization,
  getExternalAuthorizationStatus,
  prepareExternalAuthorization,
  registerExternalAuthorizationClient,
  serverSupportsExternalAuthorization,
} from "./externalAuthorization";
import { revokeMcpAppRuntimeBrokerForServer } from '@/backend/mcpApps/runtimeBroker';

// Define a type for tool arguments
type ToolArgs = Record<string, unknown>;

// Create a logger instance for this file
const log = createLogger("backend/services/mcp/index");
/** A server may ask for links again after the first round; stop after this many. */
const MAX_URL_ELICITATION_ROUNDS = 2;

/**
 * Main service class for MCP server management
 *
 * This simplified version focuses on providing a clean interface for server management
 * while maintaining compatibility with the MCP SDK.
 */
export class MCPService {
  // --- Workspace-scoped registries (#406) -----------------------------------
  // Every registry below is keyed by SERVER NAME, and a server name is only
  // unique WITHIN a workspace: "github" in workspace A and "github" in workspace
  // B are two different servers with two different clone directories, configs
  // and processes. Sharing one registry would mean connecting one implicitly
  // "connects" the other, and stopping one would tear down the other's client.
  //
  // `scopedRegistry` therefore returns a per-workspace registry — EXCEPT for the
  // default workspace, which keeps using the exact same object as before. That
  // preserves the cross-module-instance sharing the global maps exist for, and
  // keeps every existing caller (and test that pokes global.__mcp_clients
  // directly) behaving byte-for-byte as it did before workspaces existed.
  private stderrLogsBase: Map<string, string[]> = new Map(); // Store stderr logs for each server
  private get stderrLogs(): Map<string, string[]> {
    return scopedRegistry("stderrLogs", this.stderrLogsBase);
  }
  // Last connection failure per server. Unlike stderrLogs (which is reset at the start of
  // every connection attempt to capture a fresh run), this persists until the server next
  // connects successfully, so getServerStatus() can always report why a server is down -
  // even during the brief window of an in-flight reconnect.
  private lastConnectionErrorBase: Map<string, string> = new Map();
  private get approvalFailures(): Map<string, MCPServiceResponse> {
    return scopedRegistry('approvalFailures', global.__mcp_approval_failures!);
  }
  private get lastConnectionError(): Map<string, string> {
    return scopedRegistry("lastConnectionError", this.lastConnectionErrorBase);
  }
  // De-dupes concurrent connectServer() calls for the same server (see connectServer below).
  private inFlightConnectsBase: Map<string, Promise<MCPServiceResponse>> =
    new Map();
  private get inFlightConnects(): Map<string, Promise<MCPServiceResponse>> {
    return scopedRegistry("inFlightConnects", this.inFlightConnectsBase);
  }
  private connectionRetryTimersBase: Map<string, NodeJS.Timeout> = new Map(); // Track retry timers for each server
  private get connectionRetryTimers(): Map<string, NodeJS.Timeout> {
    return scopedRegistry("connectionRetryTimers", this.connectionRetryTimersBase);
  }
  private connectionRetryAttemptsBase: Map<string, number> = new Map(); // Track retry attempts for each server
  private get connectionRetryAttempts(): Map<string, number> {
    return scopedRegistry("connectionRetryAttempts", this.connectionRetryAttemptsBase);
  }

  // Per-server resource list version counter (incremented on notifications/resources/list_changed).
  // Exposed via getResourceListVersion() so the server-status API can include it in its
  // response, and the frontend can detect a stale resource listing and auto-refresh.
  private resourceListVersionBase: Map<string, number> = new Map();
  private get resourceListVersion(): Map<string, number> {
    return scopedRegistry("resourceListVersion", this.resourceListVersionBase);
  }
  // Per-server set of URIs that have received a notifications/resources/updated notification
  // (sent by servers that support resources/subscribe, registered via subscribeToResource).
  // ResourceHandler checks this before re-reading a bound resource node.
  private pendingResourceUpdatesBase: Map<string, Set<string>> = new Map();
  private get pendingResourceUpdates(): Map<string, Set<string>> {
    return scopedRegistry("pendingResourceUpdates", this.pendingResourceUpdatesBase);
  }

  // Connected clients per server name. Global-backed (see __mcp_clients) so EVERY
  // MCPService instance shares the one map: a client registered or deregistered by any
  // instance is immediately visible to all others. There is deliberately no per-instance
  // copy — N caches with one invalidation path is what poisoned the scheduler with
  // closed clients ("This operation was aborted") after another instance rebuilt a
  // connection.
  private get clients(): Map<string, Client> {
    return scopedRegistry("clients", global.__mcp_clients!);
  }

  // Servers with an in-flight connection attempt. Global-backed (see __mcp_connecting)
  // so the set is shared across module instances / hot reloads.
  private get connectingServers(): Set<string> {
    return scopedRegistry("connectingServers", global.__mcp_connecting!);
  }

  // The currently-registered transport per server. Global-backed (see
  // __mcp_active_transports) so a deregistration in one module instance is visible to
  // the onclose/onerror handlers that were registered by another.
  private get activeTransports(): Map<string, Transport> {
    return scopedRegistry("activeTransports", global.__mcp_active_transports!);
  }

  // Issue #255: per-server client-(re)registration generation. Global-backed for
  // the same cross-module-instance reason as __mcp_clients.
  private get clientGenerations(): Map<string, number> {
    return scopedRegistry("clientGenerations", global.__mcp_client_generation!);
  }

  // Issue #255: current advertised input-schema hash per (server\0tool).
  private get toolSchemaHashes(): Map<string, string> {
    return scopedRegistry("toolSchemaHashes", global.__mcp_tool_schema_hash!);
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
    const retiredClient = this.clients.get(serverName);
    if (retiredClient) retireModernSubscriptions(retiredClient);
    this.clients.delete(serverName);
    this.activeTransports.delete(serverName);
    clearExternalAuthorizationState(serverName);
    revokeMcpAppRuntimeBrokerForServer(serverName);
  }

  // -------------------------------------------------------------------------
  // Resource notification callbacks (registered at connect time)
  // -------------------------------------------------------------------------

  private onResourceListChanged(serverName: string): void {
    invalidateMcpLists(this.clients.get(serverName), 'resources');
    const prev = this.resourceListVersion.get(serverName) ?? 0;
    this.resourceListVersion.set(serverName, prev + 1);
    log.debug(
      `onResourceListChanged: server=${serverName} version=${prev + 1}`,
    );
  }

  private onResourceUpdated(serverName: string, uri: string): void {
    const set =
      this.pendingResourceUpdates.get(serverName) ?? new Set<string>();
    set.add(uri);
    this.pendingResourceUpdates.set(serverName, set);
    log.debug(`onResourceUpdated: server=${serverName} uri=${uri}`);
  }

  /**
   * The current monotonically-increasing resource list version for a server.
   * Incremented every time the server sends a `notifications/resources/list_changed`
   * notification. Called by the server-status API to expose the version to the frontend,
   * which uses it to detect stale resource listings and auto-refresh.
   */
  getResourceListVersion(serverName: string): number {
    return this.resourceListVersion.get(serverName) ?? 0;
  }

  /**
   * Subscribe to change notifications for a specific resource URI on a server.
   * Best-effort: silently skipped if the server doesn't advertise `resources.subscribe`
   * capability, or if no live client exists.
   *
   * Called from ResourceHandler after successfully reading a bound resource node so that
   * subsequent `notifications/resources/updated` events for that URI are tracked in
   * `pendingResourceUpdates` — useful for long-running flows where the resource may
   * update between steps.
   */
  async subscribeToResource(serverName: string, uri: string): Promise<void> {
    if (getHarnessExecution()) return;
    try {
      const client = this.getClient(serverName);
      if (!client) return;
      if (await subscribeModernResource(client, uri)) return;
      const caps = client.getServerCapabilities?.();
      if (!caps?.resources?.subscribe) return;
      await client.subscribeResource({ uri });
      log.debug(`subscribeToResource: server=${serverName} uri=${uri}`);
    } catch (err) {
      if (err instanceof BundledFlujoWorkloadError) throw err;
      // Non-fatal — subscription is best-effort. The server may not support it, or the
      // resource URI may have no subscription handler. Swallow silently so a missing
      // capability never breaks a flow run.
      log.debug(
        `subscribeToResource: ignored error for ${serverName}/${uri}:`,
        err,
      );
    }
  }

  /** The service members connection scheduling uses. */
  private schedulingHost(): connectionScheduling.ConnectionSchedulingHost {
    return {
      connectionRetryTimers: () => this.connectionRetryTimers,
      connectionRetryAttempts: () => this.connectionRetryAttempts,
      connectingServers: () => this.connectingServers,
      getServerConfig: (name) => this.getServerConfig(name),
      getClient: (name) => this.getClient(name),
      forceReconnect: (name) => this.forceReconnect(name),
      connectServer: (config) => this.connectServer(config),
      loadServerConfigs: () => this.loadServerConfigs(),
      setStartingUp: (value) => this.setStartingUp(value),
    };
  }

  private clearRetryTimer(serverName: string): void {
    connectionScheduling.clearRetryTimer(this.schedulingHost(), serverName);
  }

  private scheduleConnectionRetry(serverName: string, config: MCPServerConfig): void {
    connectionScheduling.scheduleConnectionRetry(this.schedulingHost(), serverName, config);
  }

  /**
   * Check if the backend is currently starting up
   */
  isStartingUp(): boolean {
    const workspace = getCurrentWorkspace();
    return workspace === DEFAULT_WORKSPACE
      ? global.__mcp_starting_up === true
      : global.__mcp_starting_up_by_workspace?.get(workspace) === true;
  }

  /**
   * Set the backend startup state
   */
  private setStartingUp(value: boolean): void {
    const workspace = getCurrentWorkspace();
    if (workspace === DEFAULT_WORKSPACE) {
      global.__mcp_starting_up = value;
    } else {
      const states = global.__mcp_starting_up_by_workspace ??=
        new Map<string, boolean>();
      states.set(workspace, value);
    }
    log.info(
      `Backend startup state set to: ${value ? "starting" : "complete"}`,
    );
  }

  /**
   * Issue #255: current client-(re)registration generation for a server. Returns
   * 0 when the server has never registered a client. Advertise-time code records
   * this on each tool's identity token; the dispatch-time staleness guard
   * (assertToolIdentityFresh) compares against it.
   */
  getClientGeneration(serverName: string): number {
    return this.clientGenerations.get(serverName) ?? 0;
  }

  /**
   * Issue #255: record the input-schema hash currently advertised for a tool, so
   * a later dispatch can detect a schema change against the hash frozen in the
   * call's toolNameMap entry.
   */
  setToolSchemaHash(serverName: string, toolName: string, hash: string): void {
    this.toolSchemaHashes.set(`${serverName}\0${toolName}`, hash);
  }

  /** Issue #255: current advertised input-schema hash for (server, tool), if known. */
  getToolSchemaHash(serverName: string, toolName: string): string | undefined {
    return this.toolSchemaHashes.get(`${serverName}\0${toolName}`);
  }

  /** The live client of a server; a closed one is removed and reported as missing. */
  getClient(serverName: string): Client | undefined {
    return liveClient(serverName);
  }

  /**
   * Load MCP server configurations from storage
   */
  async loadServerConfigs(): Promise<MCPServerConfig[] | MCPServiceResponse> {
    log.debug("loadServerConfigs: Entering method");

    try {
      const serverConfigs = await loadServerConfigs();

      if (!Array.isArray(serverConfigs)) {
        log.warn(
          "loadServerConfigs: Received non-array response",
          serverConfigs,
        );
        return serverConfigs;
      }

      log.debug(
        `loadServerConfigs: Loaded ${serverConfigs.length} server configs`,
      );
      return serverConfigs;
    } catch (error) {
      if (error instanceof BundledFlujoWorkloadError || error instanceof McpRuntimeAuthorityRetirementError) throw error;
      log.warn("loadServerConfigs: Failed to load server configs:", error);
      return {
        success: false,
        error: `Failed to load server configs: ${error instanceof Error ? error.message : "Unknown error"}`,
      };
    }
  }

  /**
   * Get a server configuration by name
   */
  private async getServerConfig(
    serverName: string,
  ): Promise<MCPServerConfig | null> {
    const protectedConfig = executionProtectedServerConfig(serverName);
    if (protectedConfig) return protectedConfig;
    log.debug(`getServerConfig: Looking up config for server ${serverName}`);

    const configs = await this.loadServerConfigs();

    if (!Array.isArray(configs)) {
      log.warn(
        `getServerConfig: Failed to load configs for ${serverName}:`,
        configs.error,
      );
      return null;
    }

    const config = configs.find((c) => c.name === serverName);

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
   * Connect to an MCP server by name
   */
  async connectServer(serverName: string, executionExtensionContext?: ExecutionExtensionContext): Promise<MCPServiceResponse>;

  /**
   * Connect to an MCP server using a configuration object
   */
  async connectServer(config: MCPServerConfig, executionExtensionContext?: ExecutionExtensionContext): Promise<MCPServiceResponse>;

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
  async connectServer(
    configOrName: MCPServerConfig | string,
    executionExtensionContext?: ExecutionExtensionContext,
  ): Promise<MCPServiceResponse> {
    if (typeof configOrName !== 'string' && !isMcpTransport(configOrName.transport)) {
      return { success: false, error: MCP_TRANSPORT_INVALID, statusCode: 400 };
    }
    const serverName =
      typeof configOrName === "string" ? configOrName : configOrName.name;

    try {
      if (executionExtensionContext) {
        await assertExecutionExtensionCurrent(executionExtensionContext);
        if (serverName !== executionExtensionProtectedServer(executionExtensionContext)) {
          throw new ExecutionExtensionError('execution_mcp_server_forbidden');
        }
      } else if (isProtectedExecutionServer(serverName)) {
        throw new ExecutionExtensionError('trusted_execution_context_required');
      }
    } catch (error) {
      return { success: false, error: error instanceof ExecutionExtensionError ? error.code : 'execution_authorization_unavailable',
        statusCode: error instanceof ExecutionExtensionError ? error.status : 503, errorType: 'execution-authorization' };
    }
    await assertBundledFlujoWorkloadEffectCurrent();
    try { assertMcpRuntimeAuthorityRetired(serverName); }
    catch (error) {
      if (error instanceof McpRuntimeAuthorityRetirementError) return { success: false,
        error: 'MCP_AUTHORITY_RETIREMENT_UNCERTAIN', errorType: 'mcp-authority-retirement', statusCode: 503 };
      throw error;
    }

    // Issue #413: de-duplication and teardown ordering now live in the
    // process-wide lifecycle coordinator rather than in this instance's map.
    // `inFlightConnects` was INSTANCE-local, so two Next.js module instances each
    // believed they were the only connector and forked two child trees for one
    // config. beginConnect also awaits any pending teardown first, so a
    // replacement connection can never be built while its predecessor's child is
    // still exiting.
    return beginConnect(serverName, async () => {
      await assertBundledFlujoWorkloadEffectCurrent();
      assertMcpRuntimeAuthorityRetired(serverName);
      const previousClient = this.getClient(serverName);
      // Keep the legacy instance-local map populated: existing tests and
      // status/diagnostic call sites still read it.
      const runAttempt = () => {
        const attempt = this.connectServerInternal(configOrName, executionExtensionContext).finally(() => {
          this.inFlightConnects.delete(serverName);
        });
        this.inFlightConnects.set(serverName, attempt);
        return attempt;
      };
      let result = await runAttempt();
      if (!result.success && takeClassicHandshakeRetry(serverName)) result = await runAttempt();
      if (result.success) {
        // Revalidation still checks current authority/configuration, but a
        // healthy reused client must not invalidate another caller's lease.
        const reusedClient = previousClient !== undefined && this.getClient(serverName) === previousClient;
        markConnected(serverName, this.configFingerprint(configOrName), reusedClient);
      } else {
        // A transport that is still registered while no client landed means the
        // failure happened DURING the handshake (post-spawn), which is the case
        // that leaks a half-initialized child if teardown is skipped.
        const handshakeFailure =
          this.activeTransports.has(serverName) && !this.clients.has(serverName);
        markConnectFailed(
          serverName,
          result.error ?? "unknown connection failure",
          handshakeFailure,
        );
      }
      return result;
    });
  }

  /**
   * Cheap identity fingerprint of the configuration a runtime was built from.
   *
   * Used only to detect that a runtime belongs to a superseded configuration
   * generation, so it never needs to be stable across processes or reversible.
   * Never includes resolved secrets: only the shape that decides WHAT is spawned.
   */
  private configFingerprint(configOrName: MCPServerConfig | string): string | undefined {
    if (typeof configOrName === "string") return undefined;
    const config = configOrName as MCPServerConfig & {
      command?: string;
      args?: string[];
      url?: string;
      websocketUrl?: string;
      rootPath?: string;
    };
    return [
      config.transport,
      config.command ?? "",
      (config.args ?? []).join(" "),
      config.url ?? "",
      config.websocketUrl ?? "",
      config.rootPath ?? "",
      config.disabled ? "disabled" : "enabled",
    ].join("\0");
  }

  private async assertProtectedConnectionIntent(
    context: ExecutionExtensionContext,
    resolvedConfig: MCPServerConfig,
  ): Promise<void> {
    await assertExecutionExtensionCurrent(context);
    if (resolvedConfig.name !== executionExtensionProtectedServer(context)) {
      throw new ExecutionExtensionError('execution_mcp_server_forbidden');
    }
    const storedConfig = await this.getServerConfig(resolvedConfig.name);
    if (!storedConfig) throw new ExecutionExtensionError('execution_mcp_server_config_missing');
    assertExecutionServerConfig(storedConfig);
    const currentConfig = await resolveConfigHeaders(storedConfig);
    assertExecutionServerConfig(currentConfig);
    await assertExecutionExtensionCurrent(context);
    if (protectedConfigFingerprint(currentConfig) !== protectedConfigFingerprint(resolvedConfig)) {
      throw new ExecutionExtensionError('execution_mcp_server_config_changed');
    }
  }

  private async connectServerInternal(
    configOrName: MCPServerConfig | string,
    executionExtensionContext?: ExecutionExtensionContext,
  ): Promise<MCPServiceResponse> {
    // Determine if we're connecting by name or by config
    let config: MCPServerConfig;

    if (typeof configOrName === "string") {
      // We're connecting by server name
      const serverName = configOrName;
      log.info(`connectServer: Looking up config for server ${serverName}`);

      // Look up the configuration directly from storage
      const existingConfig = await this.getServerConfig(serverName);
      if (!existingConfig) {
        log.warn(`connectServer: Server ${serverName} not found in configs`);
        return {
          success: false,
          error: `Server configuration for "${serverName}" not found. The server may have been deleted or not properly configured.`,
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
      typeof configOrName === "string"
        ? config
        : await this.getServerConfig(config.name);
    // Keep the storage-shaped config separate from the resolved connection clone below.
    // Auth-mode decisions and cleanup must never operate on decrypted header material.
    const persistedConfig = storedConfig ?? config;
    if (!isMcpTransport(config.transport) || !isMcpTransport(persistedConfig.transport)) {
      return { success: false, error: MCP_TRANSPORT_INVALID, statusCode: 400 };
    }
    if ((storedConfig ?? config).disabled) {
      log.info(
        `connectServer: Server ${config.name} is disabled — refusing to create a client/transport`,
      );
      // Disabled servers must not keep retry machinery alive either.
      this.clearRetryTimer(config.name);
      this.connectionRetryAttempts.delete(config.name);
      return {
        success: false,
        error: `Server '${config.name}' is disabled. Enable it on the MCP page to use it.`,
      };
    }

    const requestId = uuidv4();
    log.info(
      `connectServer: Starting connection for server ${config.name} [RequestID: ${requestId}]`,
    );

    // Mark this server as having an in-flight connection attempt so getServerStatus()
    // reports "connecting" (spinner + auto-poll on the MCP page) instead of an error
    // while the attempt is running. Cleared in the finally below.
    this.connectingServers.add(config.name);
    let attemptClient: Client | undefined;
    let attemptTransport: Transport | undefined;

    let pendingProtectedClient: Client | undefined;
    try {
      // Clear any previous stderr logs for this server
      this.stderrLogs.set(config.name, []);

      // Resolve + decrypt any custom headers (#84) BEFORE anything reads them. The SAME
      // resolved config must drive both shouldRecreateClient() and createTransport(), so the
      // httpConfigKey they compute agrees (a bound-global header would otherwise force a
      // rebuild on every connect). A rotated bound-global still rebuilds, since the resolved
      // header material — and thus the key — changes.
      if (executionExtensionContext) await assertExecutionExtensionCurrent(executionExtensionContext);
      config = await resolveConfigHeaders(config);
      await assertBundledFlujoWorkloadEffectCurrent();
      assertMcpRuntimeAuthorityRetired(config.name);
      const protectedServer = isProtectedExecutionServer(config.name);
      if (protectedServer) assertExecutionServerConfig(config);
      if (executionExtensionContext) await this.assertProtectedConnectionIntent(executionExtensionContext, config);

      // Resolved once per attempt so shouldRecreateClient and the factories below agree.
      const useBeta = usesNegotiatingClient(config, protectedServer);
      const isolateRuntimeHome = await resolveRuntimeHomeIsolation(config);
      if (executionExtensionContext) await this.assertProtectedConnectionIntent(executionExtensionContext, config);
      const transportOptions = {
        enableRuntimeBroker: true,
        isolateRuntimeHome,
      };

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
        const { needsNewClient, reason } = shouldRecreateClient(
          client,
          config,
          useBeta,
          transportOptions,
        );
        const protectedIdentityChanged = protectedServer
          && clientProtectedConfigFingerprint(client) !== protectedConfigFingerprint(config);
        if (!needsNewClient && !protectedIdentityChanged) {
          if (executionExtensionContext) await this.assertProtectedConnectionIntent(executionExtensionContext, config);
          await assertMcpIsolationDispatch(client, config.name, config);
          log.info(`connectServer: Server ${config.name} is already connected`);
          this.lastConnectionError.delete(config.name);
          this.approvalFailures.delete(config.name);
          // The connection is established - a pending retry (e.g. scheduled by a
          // zombie's late close) must not fire against it later.
          this.clearRetryTimer(config.name);
          this.connectionRetryAttempts.delete(config.name);
          await clearLegacyInferredOAuthScopesForHeaderAuth(this, config.name);
          return { success: true };
        }

        log.info(
          `connectServer: Existing client for ${config.name} is stale (${protectedIdentityChanged ? 'protected config identity changed' : reason}), recreating`,
        );
        // Deregister BEFORE closing so the transport's own close event is recognized
        // as FLUJO-initiated and does not schedule a reconnect (see deregisterClient).
        this.deregisterClient(config.name);
        try {
          const closed = await safelyCloseClient(client, config.name, config);
          if (closed.isolation?.cleanupOutcome === 'unknown') throw new McpIsolationError('ISOLATION_UNAVAILABLE');
        } catch (closeError) {
          if (closeError instanceof McpRuntimeAuthorityRetirementError || closeError instanceof BundledFlujoWorkloadError) throw closeError;
          if (closeError instanceof McpIsolationError) throw closeError;
          log.debug(
            `connectServer: error closing stale client for ${config.name}: ${closeError instanceof Error ? closeError.message : String(closeError)}`,
          );
        }
        client = undefined;
      }

      if (executionExtensionContext) await this.assertProtectedConnectionIntent(executionExtensionContext, config);
      // Create a new client. The negotiating client falls back to the classic
      // handshake per server, so existing servers keep working.
      await assertBundledFlujoWorkloadEffectCurrent();
      assertMcpRuntimeAuthorityRetired(config.name);
      client = useBeta ? createNewBetaClient(config, bindToCurrentWorkspace(() => {
        if (this.getClient(config.name) === client) this.onResourceListChanged(config.name);
      }), () => {
        invalidateMcpLists(client, 'tools');
        invalidateMcpLists(this.clients.get(config.name), 'tools');
      }, this.extensionNotificationHandlers(config.name, () => client)) : createNewClient(config);
      if (executionExtensionContext) pendingProtectedClient = client;
      const transport = useBeta
        ? await createBetaTransport(config, transportOptions)
        : await createTransport(config, transportOptions);
      attemptClient = client;
      attemptTransport = transport;
      if (config.transport === "stdio") {
        registerExternalAuthorizationClient(
          client,
          config.name,
          useBeta ? getStdioOAuthMrtrController(transport) : undefined,
        );
      }

      // Register resource-change notification handlers so FLUJO can detect when a server's
      // resource listing changes (notifications/resources/list_changed) or a subscribed
      // resource updates (notifications/resources/updated). Both paths use a method-string
      // cast so they work without importing the v2 SDK types here.
      if (!useBeta) {
        // v1 SDK: use the Zod-schema-based setNotificationHandler from resourceNotifications.ts
        registerResourceNotificationHandlers(
          client,
          config.name,
          bindToCurrentWorkspace((name: string) => this.onResourceListChanged(name)),
          bindToCurrentWorkspace((name: string, uri: string) => this.onResourceUpdated(name, uri)),
        );
        const notifiedClient = client;
        registerToolListChangedHandler(client, config.name, bindToCurrentWorkspace(() => {
          invalidateMcpLists(notifiedClient, 'tools');
          invalidateMcpLists(this.clients.get(config.name), 'tools');
        }));
        // Claude channel messages (#1401): only automations that chose this
        // source listen. Late messages from a replaced client are ignored.
        registerClaudeChannelHandler(client, config.name, bindToCurrentWorkspace((notification: unknown) => {
          receiveClaudeChannelNotification(
            notifiedClient,
            config.name,
            notification,
            () => this.getClient(config.name) === notifiedClient,
          );
        }));
        // MCP events push streams (#1401): routed to the stream that asked.
        registerMcpEventStreamHandlers(client, config.name);
      }

      // Add stderr capture. Duck-typed on the stderr stream (present on both the v1
      // and v2-beta stdio transports when spawned with stderr: 'pipe') instead of a
      // v1 instanceof, so beta stdio servers get the same capture.
      const stdioStderr = (
        transportForHostInspection(transport) as {
          stderr?: NodeJS.ReadableStream | null;
        }
      ).stderr;
      if (stdioStderr && typeof stdioStderr.on === "function") {
        const serverName = config.name;
        stdioStderr.on("data", bindToCurrentWorkspace((data: Buffer) => {
          const stderrMessage = data.toString();
          log.warn(`stderr: [${serverName}]: ${stderrMessage}`);

          // Store stderr logs (capped, see appendStderrLog)
          this.appendStderrLog(serverName, stderrMessage);
        }));
      }

      // Register FLUJO's transport event handlers BEFORE client.connect(): the SDK's
      // Protocol.connect() wraps whatever handlers are already present and CHAINS them
      // ahead of its own (_onclose/_onerror). Assigning after connect() — as this code
      // once did — silently REPLACED the SDK's wrapper, so the Client never learned its
      // transport had closed: pending requests were never rejected with "Connection
      // closed", client.transport stayed attached, and later calls surfaced as the
      // cryptic AbortError "This operation was aborted" from the aborted fetch signal.
      transport.onclose = bindToCurrentWorkspace(() => {
        // Only act if THIS transport is still the registered one for the server.
        // Two cases must be ignored: (a) a zombie process from a replaced connection
        // finally exiting — its late close event used to delete the CURRENT healthy
        // client from the maps and schedule a retry against it; (b) closes FLUJO
        // itself initiated (disconnect/reconnect/config change), which deregister
        // before closing and must not schedule a self-defeating reconnect.
        if (this.activeTransports.get(config.name) !== transport) {
          log.debug(
            `connectServer: ignoring close event from a stale/deregistered transport for ${config.name}`,
          );
          return;
        }

        log.warn(`connectServer: Connection closed for server ${config.name}`);

        // Clean up client references for the transport that actually closed
        this.deregisterClient(config.name);

        // Check if server is still enabled before scheduling reconnection
        this.getServerConfig(config.name)
          .then((currentConfig) => {
            if (!currentConfig || currentConfig.disabled) {
              log.info(
                `Server ${config.name} is now disabled, skipping reconnection logic`,
              );
              return;
            }

            // Only schedule reconnection if server is still enabled
            log.info(
              `Connection closed for enabled server ${config.name}, scheduling reconnection`,
            );
            this.scheduleConnectionRetry(config.name, currentConfig);
          })
          .catch((error) => {
            log.warn(
              `Error checking server config for ${config.name} during onclose:`,
              error,
            );
          });
      });

      transport.onerror = bindToCurrentWorkspace((error: Error) => {
        // The Streamable HTTP transport keeps a long-lived SSE stream open for server->client
        // notifications; servers/proxies recycle that idle stream (e.g. Cloudflare in front of
        // Asana), which surfaces here as "SSE stream disconnected: TypeError: terminated". The
        // SDK reconnects the stream on its own and tool calls keep working, so this is noise —
        // NOT a fatal error. Log it quietly and leave the client in place. Tearing it down here
        // (as the fatal path below does) would fight the SDK's own reconnection and orphan the
        // transport, whose stale reconnection loop would then keep firing this handler.
        if (isTransientStreamError(error)) {
          log.debug(
            `connectServer: transient SSE stream disconnect for ${config.name} (self-healing, ignored): ${error instanceof Error ? error.message : String(error)}`,
          );
          return;
        }

        // Same stale/deregistered guard as onclose: errors surfacing from a replaced
        // or intentionally-closed transport must not tear down the CURRENT connection
        // or schedule a reconnect against it.
        if (this.activeTransports.get(config.name) !== transport) {
          log.debug(
            `connectServer: ignoring error event from a stale/deregistered transport for ${config.name}`,
          );
          return;
        }

        // A stdio server that prints an ordinary log line on stdout is still connected:
        // the transport drops that line and keeps reading. Reconnecting would only start
        // another process that prints the same line.
        if (config.transport === "stdio" && isUnparsableStdioLine(error)) {
          log.warn(`connectServer: ${config.name} wrote a line on stdout that is not an MCP message; ignoring it`);
          this.appendStderrLog(config.name, `Ignored a stdout line that is not an MCP message: ${error.message}`);
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
        } else if (error && typeof error === "object") {
          const errorRecord = error as Record<string, unknown>;
          const prototype = Object.getPrototypeOf(error) as {
            constructor?: { name?: unknown };
          } | null;
          const constructorName = typeof prototype?.constructor?.name === "string"
            ? prototype.constructor.name
            : "Unknown";
          // Try to log individual properties of the error object
          log.error(`Error type: ${typeof error}`);
          log.error(`Error constructor: ${constructorName}`);

          // Log all enumerable properties
          const errorProps = Object.getOwnPropertyNames(error);
          if (errorProps.length > 0) {
            log.error(`Error properties: ${errorProps.join(", ")}`);
            errorProps.forEach((prop) => {
              try {
                const value = errorRecord[prop];
                log.error(
                  `  ${prop}: ${typeof value === "function" ? "[Function]" : JSON.stringify(value)}`,
                );
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
        this.appendStderrLog(
          config.name,
          `Transport error: ${formatErrorChain(error)}`,
        );

        // Clean up client references for the transport that actually errored
        this.deregisterClient(config.name);
        // Stop what this transport started before a reconnect starts another one. A
        // deregistered transport's own close event is ignored by the guard above.
        void transport.close().catch((closeError: unknown) => {
          log.debug(`connectServer: closing the failed transport for ${config.name} failed`, closeError);
        });

        // Check if server is still enabled before scheduling reconnection
        this.getServerConfig(config.name)
          .then((currentConfig) => {
            if (!currentConfig || currentConfig.disabled) {
              log.info(
                `Server ${config.name} is now disabled, skipping reconnection after transport error`,
              );
              return;
            }

            // Only schedule reconnection if server is still enabled
            log.info(
              `Transport error for enabled server ${config.name}, scheduling reconnection`,
            );
            this.scheduleConnectionRetry(config.name, currentConfig);
          })
          .catch((error) => {
            log.warn(
              `Error checking server config for ${config.name} during onerror:`,
              error,
            );
          });
      });

      // Handshake. Both handlers above are inert until the transport is registered as
      // the CURRENT one below (their stale guard sees activeTransports unset), so a
      // failure during connect surfaces only through this call's catch.
      await assertBundledFlujoWorkloadEffectCurrent();
      if (executionExtensionContext) await this.assertProtectedConnectionIntent(executionExtensionContext, config);
      await client.connect(transport);
      if (executionExtensionContext) await this.assertProtectedConnectionIntent(executionExtensionContext, config);
      if (config.transport === "stdio" && useBeta) {
        activateStdioOAuthMrtrController(transport);
      }

      // Store the new client (in the shared cross-instance map) and register its
      // transport as the CURRENT one for this server — the reference the
      // onclose/onerror stale guards compare against.
      this.clients.set(config.name, client);
      this.activeTransports.set(config.name, transport);
      // Issue #255: advance the generation on every (re)registration. Tool calls
      // planned against the previous instance now read as stale at dispatch time.
      this.clientGenerations.set(
        config.name,
        this.getClientGeneration(config.name) + 1,
      );

      // A negotiated mcp-stdio-oauth extension is a control-plane readiness
      // contract, not a tool. Probe it immediately after the handshake so the MCP page
      // can show required account setup before any foreground or scheduled flow runs.
      // A malformed extension must not tear down an otherwise valid MCP connection;
      // point-of-use checks below still fail closed before dispatching a tool.
      if (executionExtensionContext) await this.assertProtectedConnectionIntent(executionExtensionContext, config);
      if (serverSupportsExternalAuthorization(client)) {
        try {
          await getExternalAuthorizationStatus(client, config.name, {
            force: true,
          });
        } catch (authorizationError) {
          if (authorizationError instanceof BundledFlujoWorkloadError) throw authorizationError;
          log.warn(
            `mcp-stdio-oauth readiness probe failed for ${config.name}:`,
            authorizationError,
          );
        }
      }

      if (executionExtensionContext) await this.assertProtectedConnectionIntent(executionExtensionContext, config);

      // Connected successfully - clear any persisted failure from previous attempts,
      // and cancel any pending retry so an old timer can't fire against the fresh
      // connection later (the retry state is orphaned once we're connected).
      this.lastConnectionError.delete(config.name);
      this.approvalFailures.delete(config.name);
      this.clearRetryTimer(config.name);
      this.connectionRetryAttempts.delete(config.name);
      await clearLegacyInferredOAuthScopesForHeaderAuth(this, config.name);
      if (executionExtensionContext) await this.assertProtectedConnectionIntent(executionExtensionContext, config);

      const negotiated = negotiatedProtocolVersion(client);
      log.info(
        `connectServer: Successfully connected to ${config.name}` +
          (negotiated
            ? ` (beta SDK, negotiated MCP protocol ${negotiated})`
            : ""),
      );
      return { success: true };
    } catch (error) {
      if (error instanceof BundledFlujoWorkloadError) {
        // Once this attempt owns a transport, denial cannot cancel its cleanup.
        const cleanupErrors: unknown[] = [];
        if (attemptClient && attemptTransport) {
          this.deregisterClient(config.name);
          try {
            if (attemptClient.transport === attemptTransport) {
              await safelyCloseClient(attemptClient, config.name, config);
            } else {
              await attemptTransport.close();
            }
          } catch (cleanupError) { cleanupErrors.push(cleanupError); }
          const retire = (attemptTransport as Transport & { __flujoRetireRuntimeAuthority?: () => void }).__flujoRetireRuntimeAuthority;
          try { retire?.(); } catch (cleanupError) { cleanupErrors.push(cleanupError); }
        }
        if (cleanupErrors.length) {
          throw new BundledFlujoWorkloadError(new AggregateError([error, ...cleanupErrors], 'MCP denied startup cleanup failed'));
        }
        throw error;
      }
      if (error instanceof McpRuntimeAuthorityRetirementError) return { success: false,
        error: 'MCP_AUTHORITY_RETIREMENT_UNCERTAIN', errorType: 'mcp-authority-retirement', statusCode: 503 };
      if (executionExtensionContext && pendingProtectedClient) {
        if (this.clients.get(config.name) === pendingProtectedClient) this.deregisterClient(config.name);
        try { await safelyCloseClient(pendingProtectedClient, config.name, config); } catch { /* best-effort cleanup */ }
      }
      if (error instanceof ExecutionExtensionError) {
        return { success: false, error: error.code, statusCode: error.status, errorType: 'execution-authorization' };
      }
      // Protected recipients cannot enter ordinary OAuth discovery or mutate
      // authentication configuration after any transport/provider failure.
      // This decision comes from the trusted adapter's recipient policy, never
      // from user headers or the presence of a caller-supplied context value.
      if (isProtectedExecutionServer(config.name)) {
        return { success: false, error: 'execution_mcp_connect_failed', statusCode: 503, errorType: 'execution-authorization' };
      }
      // A child may have registered its sidecar before the MCP handshake
      // failed. Never leave that browser route pointing at a dead/reused port.
      if (config.transport === 'stdio') {
        revokeMcpAppRuntimeBrokerForServer(config.name);
        noteStdioConnectFailure(config, error);
      }
      const approvalFailure = executionApprovalFailure(error);
      if (approvalFailure) {
        this.clearRetryTimer(config.name);
        this.connectionRetryAttempts.delete(config.name);
        const previous = this.approvalFailures.get(config.name);
        if (previous?.errorCode !== approvalFailure.errorCode) {
          log.warn(`MCP server ${config.name}: ${approvalFailure.error}`);
        }
        this.approvalFailures.set(config.name, approvalFailure);
        this.lastConnectionError.set(config.name, approvalFailure.error!);
        return approvalFailure;
      }
      this.approvalFailures.delete(config.name);
      log.error(
        `connectServer: Failed to connect to server ${config.name}:`,
        error,
      );

      const errorMessage =
        error instanceof Error ? error.message : String(error);
      const oauthProviderError = isOAuthAuthenticationError(error);
      const requiresAuthentication = isAuthRequiredError(error);
      const usesStaticAuthorization =
        hasConfiguredAuthorizationHeader(persistedConfig);
      let oauthCapable: boolean | undefined;

      // A transport-level 401/403 proves only that this request was rejected. It may be
      // a static bearer/custom-header failure, so enable and persist OAuth only after the
      // endpoint advertises OAuth capability. Provider-originated errors are already
      // conclusive because this server was connected with a configured OAuth provider.
      if (
        requiresAuthentication &&
        !usesStaticAuthorization &&
        (config.transport === "streamable" || config.transport === "sse")
      ) {
        const serverUrl = (config as MCPStreamableConfig | MCPSSEConfig)
          .serverUrl;
        if (serverUrl) {
          oauthCapable = (await probeOAuthSupport(serverUrl)).oauthCapable;
        }
      }

      if (oauthProviderError || oauthCapable) {
        log.info(
          `OAuth authentication error detected for server ${config.name}: ${errorMessage}`,
        );

        if (config.transport === "streamable" && oauthCapable) {
          const streamableConfig = config as MCPStreamableConfig;
          if (
            !streamableConfig.oauthScopes ||
            streamableConfig.oauthScopes.length === 0
          ) {
            log.info(
              `Dynamically enabling OAuth for server ${config.name} after capability confirmation`,
            );

            try {
              const updatedConfig = {
                ...streamableConfig,
                oauthScopes: ["read"],
              };
              const configs = await this.loadServerConfigs();
              if (Array.isArray(configs)) {
                const configIndex = configs.findIndex(
                  (c) => c.name === config.name,
                );
                if (configIndex !== -1) {
                  configs[configIndex] = updatedConfig;
                  await saveConfig(new Map(configs.map((c) => [c.name, c])));
                  log.info(`Updated config for ${config.name} to enable OAuth`);
                }
              }
            } catch (updateError) {
          if (updateError instanceof BundledFlujoWorkloadError) throw updateError;
              log.warn(
                `Failed to update config for ${config.name} to enable OAuth:`,
                updateError,
              );
            }
          }
        }

        return {
          success: false,
          error:
            "OAuth authentication failed or tokens have expired. Please re-authenticate.",
          requiresAuthentication: true,
          oauthCapable: true,
        };
      }

      if (requiresAuthentication) {
        return {
          success: false,
          error: errorMessage,
          requiresAuthentication: true,
          oauthCapable,
        };
      }

      const stderrLogs = this.stderrLogs.get(config.name) || [];
      const enhancedErrorMessage = await enhanceConnectionErrorMessage(
        error,
        config,
        stderrLogs,
      );

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
    options?: { storedName?: string },
  ): Promise<MCPServiceResponse> {
    return testConnection(this, config, onOutput, options);
  }

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
      log.debug(
        `notifyRootsChanged: ${serverName} not connected, skipping notification`,
      );
      return;
    }
    try {
      void client.sendRootsListChanged().catch((error: unknown) => {
        log.warn(`notifyRootsChanged: failed to notify ${serverName}:`, error);
      });
      log.debug(`notifyRootsChanged: sent roots/list_changed to ${serverName}`);
    } catch (error) {
      if (error instanceof BundledFlujoWorkloadError || error instanceof McpRuntimeAuthorityRetirementError) throw error;
      log.warn(`notifyRootsChanged: failed to notify ${serverName}:`, error);
    }
  }

  /** Announce a workspace-level folders edit to every connected server here. */
  notifyAllRootsChanged(): void {
    for (const serverName of this.clients.keys()) {
      this.notifyRootsChanged(serverName);
    }
  }

  /**
   * Disconnect from an MCP server
   */
  async disconnectServer(serverName: string): Promise<MCPServiceResponse> {
    log.debug(`disconnectServer: Entering method for server ${serverName}`);

    // Clear any retry timers for this server
    this.clearRetryTimer(serverName);
    this.connectionRetryAttempts.delete(serverName);

    try { assertMcpRuntimeAuthorityRetired(serverName); }
    catch (error) {
      if (error instanceof McpRuntimeAuthorityRetirementError) return { success: false,
        error: 'MCP_AUTHORITY_RETIREMENT_UNCERTAIN', errorType: 'mcp-authority-retirement', statusCode: 503 };
      throw error;
    }
    const runtime = peekRuntime(serverName);
    if (runtime?.teardownPromise) {
      const shutdownReceipt = await runtime.teardownPromise;
      try { assertMcpRuntimeAuthorityRetired(serverName); }
      catch (error) {
        if (error instanceof McpRuntimeAuthorityRetirementError) return { success: false, shutdownReceipt,
          error: 'MCP_AUTHORITY_RETIREMENT_UNCERTAIN', errorType: 'mcp-authority-retirement', statusCode: 503 };
        throw error;
      }
      await assertBundledFlujoWorkloadEffectCurrent();
      if (shutdownReceipt.errorClassification === 'close_failed') return { success: false, shutdownReceipt,
        error: 'MCP_SHUTDOWN_FAILED', statusCode: 503 };
      return { success: true, shutdownReceipt };
    }
    // A repeat request returns the same observation, without closing a new process.
    const client = this.getClient(serverName);
    if (!client && !runtime?.connectPromise) {
      const receipt = getShutdownReceipt(serverName);
      if (receipt) return { success: receipt.errorClassification !== 'close_failed', shutdownReceipt: receipt,
        ...(receipt.errorClassification === 'close_failed' ? { error: 'MCP_SHUTDOWN_FAILED', statusCode: 503 } : {}) };
      log.warn(
        `disconnectServer: Server ${serverName} not found in clients map`,
      );
      // Even without a live client, purge any lingering references so a stale entry
      // can never be observed by another instance after this call.
      this.deregisterClient(serverName);
      return { success: false, error: `Server ${serverName} not found` };
    }

    let retirementFailure: McpRuntimeAuthorityRetirementError | undefined;
    let teardownFailure: unknown;
    try {
      // Issue #413: run the close through the ONE idempotent, awaitable teardown
      // so overlapping shouts of "close it" (transport error + disable + shutdown
      // arriving together) fold onto a single close instead of racing each other
      // into a double-close that orphans grandchildren.
      await assertBundledFlujoWorkloadEffectCurrent();
      const shutdownReceipt = await beginTeardown(serverName, "disconnect", async () => {
        try { await assertBundledFlujoWorkloadEffectCurrent(); }
        catch (error) { teardownFailure = error; throw error; }
        // Resolve after the coordinator has awaited any pending connect. Publish
        // the shared teardown before asynchronous config reads or deregistration.
        const closingClient = this.getClient(serverName);
        this.deregisterClient(serverName);
        if (!closingClient) return;
        let config: MCPServerConfig | undefined;
        try { config = (await this.getServerConfig(serverName)) || undefined; }
        catch (error) { teardownFailure = error; }
        // Cleanup owns the client now and must finish even after request revocation.
        try {
          const observation = await safelyCloseClient(closingClient, serverName, config);
          if (teardownFailure) throw teardownFailure;
          return observation;
        }
        catch (error) {
          teardownFailure = teardownFailure && teardownFailure !== error
            ? new BundledFlujoWorkloadError(new AggregateError([teardownFailure, error], 'MCP teardown failed'))
            : error;
          if (error instanceof McpRuntimeAuthorityRetirementError) retirementFailure = error;
          throw error;
        }
      });

      if (retirementFailure) return { success: false, shutdownReceipt,
        error: 'MCP_AUTHORITY_RETIREMENT_UNCERTAIN', errorType: 'mcp-authority-retirement', statusCode: 503 };
      if (teardownFailure) throw teardownFailure;
      await assertBundledFlujoWorkloadEffectCurrent();
      if (shutdownReceipt.errorClassification === 'close_failed') return { success: false, shutdownReceipt,
        error: 'MCP_SHUTDOWN_FAILED', statusCode: 503 };
      log.info(`disconnectServer: Disconnected server ${serverName}`);
      return { success: true, shutdownReceipt };
    } catch (error) {
      if (error instanceof BundledFlujoWorkloadError || error instanceof McpRuntimeAuthorityRetirementError) throw error;
      log.warn(
        `disconnectServer: Failed to disconnect server ${serverName}:`,
        error,
      );
      return {
        success: false,
        error: `Failed to disconnect server: ${error instanceof Error ? error.message : "Unknown error"}`,
      };
    }
  }

  getServerShutdownReceipt(serverName: string) {
    return getShutdownReceipt(serverName);
  }

  /**
   * Tear down EVERY live MCP connection, awaiting each child's exit (issue #413).
   *
   * FLUJO had no process-wide MCP shutdown at all: the only teardown was
   * per-server and user-initiated, so on SIGTERM/SIGINT (or a container stop) the
   * whole fleet of stdio servers — and everything they had spawned — was left to
   * the OS, which reparents rather than kills. Repeated start/stop cycles
   * therefore accumulated server trees until the machine was rebooted.
   *
   * Idempotent: each per-server teardown folds onto its coordinator promise, so
   * calling this from several signal handlers at once is safe. Never rejects — a
   * shutdown path must not be derailed by one uncooperative server.
   */
  async disconnectAll(reason: string): Promise<{
    /** Legacy connection-disconnect outcomes; these names do not certify exit. */
    closed: string[];
    failed: string[];
    shutdownReceipts: MCPShutdownReceipt[];
  }> {
    const closed: string[] = [];
    const failed: string[] = [];
    const shutdownReceipts: MCPShutdownReceipt[] = [];
    // Snapshot the names first: closing mutates the shared registry.
    const serverNames = Array.from(new Set(Array.from(this.clients.keys())));
    log.info(`disconnectAll: tearing down ${serverNames.length} MCP server(s) (${reason})`);

    for (const serverName of serverNames) {
      // Retry timers must die first, or a pending retry fires mid-shutdown and
      // re-forks the very server we just closed.
      this.clearRetryTimer(serverName);
      this.connectionRetryAttempts.delete(serverName);
      try {
        const result = await this.disconnectServer(serverName);
        if (result.shutdownReceipt) shutdownReceipts.push(result.shutdownReceipt);
        if (result.success) closed.push(serverName);
        else failed.push(serverName);
      } catch (error) {
      if (error instanceof BundledFlujoWorkloadError || error instanceof McpRuntimeAuthorityRetirementError) throw error;
        log.warn(
          `disconnectAll: teardown of ${serverName} threw: ${error instanceof Error ? error.message : String(error)}`,
        );
        failed.push(serverName);
      }
    }

    // Any record still holding a retry timer (a server that was cold but
    // scheduled to retry) must be silenced too, or the process cannot exit.
    for (const [serverName] of Array.from(this.connectionRetryTimers)) {
      this.clearRetryTimer(serverName);
      this.connectionRetryAttempts.delete(serverName);
    }

    log.info(
      `disconnectAll: closed=${closed.length} failed=${failed.length} (${reason})`,
    );
    return { closed, failed, shutdownReceipts };
  }

  /**
   * Bounded lifecycle/pool diagnostics (issue #413).
   *
   * Counters, states and sizes only: never stderr, command lines or provider
   * payloads, so the report is safe to log and cheap to keep.
   */
  getLifecycleReport(): {
    runtimes: ReturnType<typeof getLifecycleDiagnostics>;
    pool: ReturnType<typeof getPoolDiagnostics>;
    liveClients: number;
  } {
    return {
      runtimes: getLifecycleDiagnostics(),
      pool: getPoolDiagnostics(),
      liveClients: this.clients.size,
    };
  }

  /**
   * Close warm servers nothing is using, honouring leases and pins.
   *
   * Exposed so a caller (an idle sweep cron, a suspend hook) can reclaim memory
   * without knowing about the pool module. Never warms a cold server.
   */
  async sweepIdleMcpServers(): Promise<string[]> {
    const closed = await sweepIdleServers(this);
    const evicted = await enforceWarmCapacity(this);
    return [...closed, ...evicted];
  }

  async listServerEvents(serverName: string): Promise<{
    supported: boolean;
    channel: boolean;
    events: McpEventDescriptor[];
    error?: string;
  }> {
    return serviceEvents.listServerEvents(this, serverName);
  }

  async unsubscribeServerEvent(serverName: string, request: McpEventUnsubscribeRequest): Promise<void> {
    return serviceEvents.unsubscribeServerEvent(this, serverName, request);
  }

  async connectClaudeChannel(serverName: string): Promise<boolean> {
    return serviceEvents.connectClaudeChannel(this, serverName);
  }

  async subscribeServerEvent(serverName: string, request: McpEventSubscribeRequest): Promise<McpEventSubscribeResult> {
    return serviceEvents.subscribeServerEvent(this, serverName, request);
  }

  async openServerEventStream(
    serverName: string,
    request: McpEventStreamRequest,
    handlers: McpEventStreamHandlers,
  ): Promise<McpEventStream> {
    return serviceEvents.openServerEventStream(this, serverName, request, handlers);
  }

  async pollServerEvent(serverName: string, request: McpEventPollRequest): Promise<McpEventPollResult> {
    return serviceEvents.pollServerEvent(this, serverName, request);
  }

  /**
   * Notification handlers for the newer client, registered with a schema while
   * it is built: resource changes, Claude channel messages and MCP events push
   * streams (#1401). `currentClient` returns the client being built, so a
   * replaced client's late messages are ignored.
   */
  private extensionNotificationHandlers(serverName: string, currentClient: () => Client | undefined): ExtensionNotificationHandlers {
    const isCurrent = (client: Client | undefined): client is Client => Boolean(client) && this.getClient(serverName) === client;
    const handlers: ExtensionNotificationHandlers = {
      "notifications/resources/list_changed": bindToCurrentWorkspace(() => {
        if (isCurrent(currentClient())) this.onResourceListChanged(serverName);
      }),
      "notifications/resources/updated": bindToCurrentWorkspace((params: unknown) => {
        const uri = (params as { uri?: unknown } | undefined)?.uri;
        if (typeof uri === "string" && isCurrent(currentClient())) this.onResourceUpdated(serverName, uri);
      }),
      [CLAUDE_CHANNEL_METHOD]: bindToCurrentWorkspace((params: unknown) => {
        const client = currentClient();
        if (!client) return;
        receiveClaudeChannelNotification(client, serverName, { params }, () => this.getClient(serverName) === client);
      }),
    };
    for (const method of MCP_EVENT_NOTIFICATIONS) {
      handlers[method] = (params: unknown) => {
        const client = currentClient();
        if (client) routeMcpEventNotification(client, method, params);
      };
    }
    return handlers;
  }

  /**
   * Acquire a lease on a server, connecting it lazily if it is cold.
   *
   * Consumers should prefer this over `connectServer` + `getClient`: while the
   * lease is held the idle sweep and LRU eviction cannot close the server, and
   * `lease.isStale()` reports a config-generation replacement so a caller can
   * never keep using a client that is being torn down.
   */
  acquireServerLease(serverName: string, executionExtensionContext?: ExecutionExtensionContext): Promise<AcquireResult> {
    return acquireLease(this, serverName, executionExtensionContext
      ? (name) => this.connectServer(name, executionExtensionContext)
      : undefined);
  }

  /** Pin a server against idle/LRU closure (subscriptions, MCP App sessions, tasks). */
  pinServer(serverName: string, pin: string): void {
    pinServer(serverName, pin);
  }

  /** Release a named pin. */
  unpinServer(serverName: string, pin: string): void {
    unpinServer(serverName, pin);
  }

  /**
   * Tear down any existing client for a server and establish a fresh connection.
   *
   * Used to self-heal a dead/stale connection: the cached client is closed and removed
   * before reconnecting, so connectServer() is guaranteed to build a brand-new client and
   * transport rather than short-circuiting on the stale one still sitting in the map.
   */
  async forceReconnect(serverName: string, expectedClient?: Client): Promise<MCPServiceResponse> {
    await assertBundledFlujoWorkloadEffectCurrent();
    assertMcpRuntimeAuthorityRetired(serverName);
    if (expectedClient) {
      const current = this.getClient(serverName);
      // Read-only recovery must not retire a replacement published while its
      // failed request was finishing, or interrupt another active borrower.
      if (current !== expectedClient) return current ? { success: true } : this.connectServer(serverName);
      const runtime = peekRuntime(serverName);
      if (runtime && (runtime.leases > 0 || runtime.pins.size > 0)) {
        return { success: false, error: `Server '${serverName}' is in use. Retry discovery when its current work finishes.` };
      }
    }
    log.info(
      `forceReconnect: Forcing fresh connection for server ${serverName}`,
    );

    const existing = this.clients.get(serverName);
    if (existing) {
      // Deregister BEFORE closing so the close event is recognized as FLUJO-initiated
      // (see deregisterClient) and does not schedule a competing reconnect.
      this.deregisterClient(serverName);
      const config = await this.getServerConfig(serverName);
      try {
        await safelyCloseClient(existing, serverName, config || undefined);
      } catch (closeError) {
          if (closeError instanceof McpRuntimeAuthorityRetirementError || closeError instanceof BundledFlujoWorkloadError) throw closeError;
        log.debug(
          `forceReconnect: error closing stale client for ${serverName}: ${closeError instanceof Error ? closeError.message : String(closeError)}`,
        );
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
  async listServerTools(
    serverName: string,
    audience: ToolListAudience = "model",
    cursorOrExecutionContext?: string | ExecutionExtensionContext,
    cursor?: string,
  ): Promise<{ tools: ToolResponse[]; nextCursor?: string; error?: string }> {
    const executionExtensionContext = typeof cursorOrExecutionContext === 'string' ? undefined : cursorOrExecutionContext;
    const pageCursor = typeof cursorOrExecutionContext === 'string' ? cursorOrExecutionContext : cursor;
    log.debug(
      `listServerTools: Entering method for server ${serverName}, audience ${audience}`,
    );

    if (!executionExtensionContext && isProtectedExecutionServer(serverName)) {
      throw new ExecutionExtensionError('trusted_execution_context_required');
    }

    // A protected discovery must use the client built from the currently
    // owner-approved effective config. A name match alone can select a stale
    // transport, including a websocket whose URL changed after connection.
    let protectedClient: Client | undefined;
    let protectedDisabled = false;
    if (executionExtensionContext) {
      await assertExecutionExtensionCurrent(executionExtensionContext);
      if (serverName !== executionExtensionProtectedServer(executionExtensionContext)) {
        throw new ExecutionExtensionError('execution_mcp_server_forbidden');
      }
      const storedConfig = await this.getServerConfig(serverName);
      if (!storedConfig) throw new ExecutionExtensionError('execution_mcp_server_config_missing');
      protectedDisabled = storedConfig.disabled === true;
      const effectiveConfig = await resolveConfigHeaders(storedConfig);
      assertExecutionServerConfig(effectiveConfig);
      await assertExecutionExtensionCurrent(executionExtensionContext);
      protectedClient = this.getClient(serverName);
      if (!protectedClient || clientProtectedConfigFingerprint(protectedClient) !== protectedConfigFingerprint(effectiveConfig)) {
        throw new ExecutionExtensionError('execution_mcp_client_identity_changed');
      }
    }

    // Point-of-use guard on top of the connect-time hard gate (issue #54): fail
    // loudly instead of attempting a pointless reconnect against a disabled server.
    if (executionExtensionContext ? protectedDisabled : await this.isServerDisabled(serverName)) {
      const error = `Server '${serverName}' is disabled. Enable it on the MCP page to use it.`;
      log.warn(`listServerTools: ${error}`);
      return { tools: [], error };
    }

    if (executionExtensionContext && this.getClient(serverName) !== protectedClient) {
      throw new ExecutionExtensionError('execution_mcp_client_identity_changed');
    }

    let client = protectedClient ?? this.getClient(serverName);
    if (!client) {
      log.warn(`listServerTools: Client not found for ${serverName}`);
    }

    // #1408: an opt-in reuse of complete lists for servers that announce
    // changes. Protected execution contexts and paged requests always list.
    let result = executionExtensionContext || pageCursor !== undefined
      ? await listTools(client, serverName, audience, pageCursor)
      : await cachedMcpList(client, 'tools', audience, () => listTools(client, serverName, audience, pageCursor));
    if (executionExtensionContext) {
      await assertExecutionExtensionCurrent(executionExtensionContext);
      if (this.getClient(serverName) !== protectedClient) {
        throw new ExecutionExtensionError('execution_mcp_client_identity_changed');
      }
    }

    if (result.error) {
      if (executionExtensionContext) return result;
      // The connection is likely stale/dead - reconnect from scratch and try once more
      // before giving up, so a recoverable blip does not silently strip a node's tools.
      log.warn(
        `listServerTools: Listing tools for ${serverName} failed (${result.error}); forcing reconnect and retrying once`,
      );

      const reconnect = await this.forceReconnect(serverName);
      if (!reconnect.success) {
        log.warn(
          `listServerTools: Reconnect for ${serverName} failed: ${reconnect.error}`,
        );
        return { tools: [], error: reconnect.error || result.error };
      }

      client = this.clients.get(serverName);
      result = await listTools(client, serverName, audience, pageCursor);

      if (result.error) {
        log.warn(
          `listServerTools: Retry after reconnect still failed for ${serverName}:`,
          result.error,
        );
      } else {
        log.info(
          `listServerTools: Recovered after reconnect for ${serverName}; listed ${result.tools.length} tools`,
        );
      }
    } else {
      log.info(
        `listServerTools: Listed ${result.tools.length} tools for ${serverName}`,
      );
    }

    return result;
  }

  /**
   * Read the negotiated third-party-account readiness contract. This never
   * guesses tool names and never starts an authorization flow.
   */
  async getExternalAuthorizationStatus(
    serverName: string,
    force = false,
  ): Promise<MCPStdioOAuthStatus> {
    return getExternalAuthorizationStatus(
      this.getClient(serverName),
      serverName,
      { force },
    );
  }

  /** Start a user-initiated extension request and capture its browser URL. */
  async prepareExternalAuthorization(
    serverName: string,
    authorizationId: string,
    options: { signal?: AbortSignal } = {},
  ) {
    let client = this.getClient(serverName);
    if (!client) {
      const reconnect = await this.forceReconnect(serverName);
      if (!reconnect.success) {
        throw new Error(
          reconnect.error || `Could not connect to ${serverName}.`,
        );
      }
      client = this.getClient(serverName);
    }
    if (!client)
      throw new Error(`MCP server '${serverName}' is not connected.`);
    return prepareExternalAuthorization(
      client,
      serverName,
      authorizationId,
      options,
    );
  }

  confirmExternalAuthorization(serverName: string, sessionId: string) {
    return confirmExternalAuthorization(serverName, sessionId);
  }

  declineExternalAuthorization(serverName: string, sessionId: string): boolean {
    return declineExternalAuthorization(serverName, sessionId);
  }

  cancelExternalAuthorization(serverName: string, sessionId?: string): boolean {
    return cancelExternalAuthorization(serverName, sessionId);
  }

  /**
   * Call a tool on an MCP server
   */
  async callTool(
    serverName: string,
    toolName: string,
    args: ToolArgs,
    timeout?: number,
    onProgress?: (progress: ToolCallProgress) => void,
    callerNodeId?: string,
    signal?: AbortSignal,
    source: ToolCallSource = "host",
    ownerScope?: string,
    trustedContext?: TrustedMcpToolInvocationContext,
    executionExtensionContext?: ExecutionExtensionContext,
  ): Promise<MCPServiceResponse> {
    const protectedDispatch = Boolean(executionExtensionContext) || isProtectedExecutionServer(serverName);
    if (getHarnessExecution()) {
      const output = replayHarnessTool(`${serverName}::${toolName}`, args);
      try { return { success: true, data: JSON.parse(output) }; }
      catch { return { success: true, data: { content: [{ type: 'text', text: output }] } }; }
    }
    // The calling chat's project folder (shipped bash/filesystem only). Resolved
    // up front because it reads — and on a chat's first call writes — workspace
    // metadata, which must not sit between the dispatch checks and the dispatch.
    const projectDir = protectedDispatch || !trustedContext?.conversationId
      ? undefined
      : await projectDirForToolCall(
          await this.getServerConfig(serverName).catch(() => null),
          trustedContext.conversationId,
        );
    // Customer authority is checked before config side effects, connections or leases.
    // Testers, Apps, proxy, scheduler and missing-context resumes cannot mint assertions.
    try {
      if (protectedDispatch) {
        await assertExecutionToolDispatch(executionExtensionContext, serverName, source);
        const config = await this.getServerConfig(serverName);
        if (!config) throw new ExecutionExtensionError('execution_server_policy_mismatch');
        // Compare the actual connection headers, never encrypted storage bytes.
        // Keep the resolved copy private and leave the saved config unchanged.
        assertExecutionServerConfig(await resolveConfigHeaders(config));
      }
    } catch (error) {
      if (error instanceof BundledFlujoWorkloadError || error instanceof McpRuntimeAuthorityRetirementError) throw error;
      return { success: false, error: error instanceof ExecutionExtensionError ? error.code : 'execution_authorization_unavailable',
        statusCode: error instanceof ExecutionExtensionError ? error.status : 503, errorType: 'execution-authorization' };
    }
    log.debug(
      `callTool: Entering method for server ${serverName}, tool ${toolName}, source ${source}`,
    );

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
    // Issue #413: hold a LEASE for the duration of the call. An in-flight tool
    // call is demand, so while it runs neither the idle sweep nor LRU eviction may
    // close the server underneath it. Acquiring also connects a cold server on
    // demand, which is what makes lazy pooling transparent here.
    const acquired = await this.acquireServerLease(serverName, executionExtensionContext);
    const lease = acquired.lease;
    if (lease) {
      client = lease.client;
    } else if (!client) {
      log.warn(
        `callTool: Lease acquisition for ${serverName} failed: ${acquired.error}`,
      );
    }

    // Everything below runs while the lease is held, and the lease is released in
    // ONE `finally` covering every exit path (including the authorization gate's
    // early returns). An early return that skipped the release would leave a
    // phantom lease pinning the server warm for the process lifetime.
    const verifyProtectedRecipient = async (): Promise<void> => {
      if (!protectedDispatch) return;
      await assertExecutionToolDispatch(executionExtensionContext, serverName, source);
      const storedConfig = await this.getServerConfig(serverName);
      if (!storedConfig) throw new ExecutionExtensionError('execution_mcp_server_config_missing');
      assertExecutionServerConfig(storedConfig);
      const effectiveConfig = await resolveConfigHeaders(storedConfig);
      assertExecutionServerConfig(effectiveConfig);
      await assertExecutionToolDispatch(executionExtensionContext, serverName, source);
      if (!lease || !client || lease.isStale() || this.getClient(serverName) !== client
        || clientProtectedConfigFingerprint(client) !== protectedConfigFingerprint(effectiveConfig)) {
        throw new ExecutionExtensionError('execution_mcp_client_identity_changed');
      }
    };
    try {
      await verifyProtectedRecipient();
      // Fail closed before invoking a side-effecting tool. This gate is shared by
      // chat, normal flows, scheduled runs, polls, and MCP Apps, so a background
      // execution can never discover account setup by opening UI after the fact.
      if (client && serverSupportsExternalAuthorization(client)) {
        try {
          const authorization = await getExternalAuthorizationStatus(
            client,
            serverName,
            { force: true },
          );
          if (authorization.blockingAuthorization) {
            const requiredAuthorization = authorization.blockingAuthorization;
            const error =
              requiredAuthorization.message ||
              `${requiredAuthorization.label} authorization is required. Open the MCP page to authenticate before running this flow.`;
            log.warn(`callTool: blocked ${serverName}/${toolName}: ${error}`);
            return {
              success: false,
              error,
              errorType: "stdio-oauth-required",
              statusCode: 428,
              requiresAuthentication: true,
            };
          }
        } catch (authorizationError) {
          if (authorizationError instanceof BundledFlujoWorkloadError) throw authorizationError;
          const detail =
            authorizationError instanceof Error
              ? authorizationError.message
              : String(authorizationError);
          log.warn(
            `callTool: mcp-stdio-oauth readiness check failed for ${serverName}: ${detail}`,
          );
          return {
            success: false,
            error: `Could not verify account readiness for '${serverName}': ${detail}`,
            errorType: "stdio-oauth-status",
            statusCode: 503,
          };
        }
      }

      const trustedToolConfig = source === "model"
        && toolName === "create_ticket_for_human"
        && trustedContext?.conversationId
        ? await this.getServerConfig(serverName)
        : null;
      const trustedTicketConversationId = trustedFlujoTicketConversationId(
        trustedToolConfig,
        toolName,
        source,
        trustedContext,
      );
      const effectiveArgs = trustedTicketConversationId
        ? injectTrustedFlujoToolContext(
            trustedToolConfig,
            toolName,
            args,
            source,
            trustedContext,
          )
        : args;
      await verifyProtectedRecipient();
      try { if (client) await assertMcpIsolationDispatch(client, serverName, await this.getServerConfig(serverName)); }
      catch (error) {
      if (error instanceof BundledFlujoWorkloadError || error instanceof McpRuntimeAuthorityRetirementError) throw error;
        return { success: false, error: error instanceof McpIsolationError ? error.code : 'ISOLATION_UNAVAILABLE',
          errorType: 'mcp-isolation', statusCode: error instanceof McpIsolationError && error.code !== 'ISOLATION_UNAVAILABLE' ? 403 : 503 };
      }
      await assertBundledFlujoWorkloadEffectCurrent();
      const dispatch = () => callToolFunction(
        client,
        serverName,
        toolName,
        effectiveArgs,
        timeout,
        onProgress,
        signal,
        source,
        callerNodeId,
        ownerScope,
        executionExtensionContext,
        protectedDispatch ? verifyProtectedRecipient : undefined,
        trustedContext?.conversationId,
        projectDir,
      );
      let result = await dispatch();
      // URLElicitationRequiredError (-32042): the server needs the person to
      // open a link first. Ask in the calling run, then try the call again.
      for (let round = 0; round < MAX_URL_ELICITATION_ROUNDS && !protectedDispatch; round += 1) {
        const links = requiredUrlElicitationsOf(result.protocolError);
        const config = links ? await this.getServerConfig(serverName) : undefined;
        if (!links || !config || !await completeRequiredUrlElicitations(config, links, signal)) break;
        await assertBundledFlujoWorkloadEffectCurrent();
        result = await dispatch();
      }
      if (result.success && trustedTicketConversationId) {
        const ticketId = createdTicketIdFromMcpResult(result.data);
        if (ticketId) {
          try {
            const { ticketService } = await import('@/backend/services/ticket');
            await ticketService.stampPersonaAttributionFromTrustedConversation(
              ticketId,
              trustedTicketConversationId,
            );
          } catch (error) {
      if (error instanceof BundledFlujoWorkloadError || error instanceof McpRuntimeAuthorityRetirementError) throw error;
            // The ticket already exists; keep the tool result truthful while
            // surfacing a storage failure for operators instead of trusting an
            // unverified payload at the HTTP boundary.
            log.error(`callTool: Failed to stamp trusted ticket attribution for ${ticketId}`, error);
          }
        }
      }
      log.info(`callTool: Called tool ${toolName} on ${serverName}`);
      return result;
    } catch (error) {
      if (protectedDispatch) {
        return { success: false, error: error instanceof ExecutionExtensionError ? error.code : 'execution_tool_unavailable',
          statusCode: error instanceof ExecutionExtensionError ? error.status : 503, errorType: 'execution-call' };
      }
      throw error;
    } finally {
      // Idempotent release: safe even when acquisition failed and this is undefined.
      lease?.release();
    }
  }

  /**
   * Call a tool on behalf of an MCP App frame.
   *
   * The app supplies only a tool name and arguments; `serverName` comes from
   * the host frame that instantiated it. The low-level call verifies
   * `_meta.ui.visibility` against definitions listed from that exact client
   * immediately before dispatch. A failed authorization listing is safe to
   * reconnect and retry once because the tool has not executed yet.
   */
  async callToolFromApp(
    serverName: string,
    toolName: string,
    args: ToolArgs,
    timeout?: number,
    signal?: AbortSignal,
    ownerScope?: string,
    onProgress?: (progress: ToolCallProgress) => void,
  ): Promise<MCPServiceResponse> {
    const appAccess = await this.checkMcpAppAccess(serverName);
    if (appAccess) return appAccess;

    let result = await this.callTool(
      serverName,
      toolName,
      args,
      timeout,
      onProgress,
      undefined,
      signal,
      "app",
      ownerScope,
    );

    if (result.errorType !== "tool-authorization-list") {
      return result;
    }

    log.warn(
      `callToolFromApp: visibility lookup failed for ${serverName}/${toolName}; reconnecting and retrying once before dispatch`,
    );
    const reconnect = await this.forceReconnect(serverName);
    if (!reconnect.success) {
      return {
        success: false,
        error: reconnect.error || result.error,
        statusCode: result.statusCode,
      };
    }

    result = await this.callTool(
      serverName,
      toolName,
      args,
      timeout,
      onProgress,
      undefined,
      signal,
      "app",
      ownerScope,
    );
    return result;
  }

  /**
   * Treat the per-server MCP Apps switch as a live authorization predicate.
   * Historical chat messages can outlive a config change, so a persisted
   * `ui://` marker must not keep app-originated access after the user turns
   * Apps off. An unset switch means on (mcpClientFeatures.ts); shipped package
   * records store their own explicit value.
   */
  async isMcpAppAccessEnabled(serverName: string): Promise<boolean> {
    const config = await this.getServerConfig(serverName);
    if (config?.disabled === true) return false;
    return !!config && mcpAppsEnabled(config);
  }

  private async checkMcpAppAccess(
    serverName: string,
  ): Promise<MCPServiceResponse | null> {
    if (await this.isMcpAppAccessEnabled(serverName)) return null;

    const error = `MCP Apps are not enabled for server '${serverName}'. Enable them on the MCP page before opening or using this app.`;
    log.warn(`MCP App access denied: ${error}`);
    return { success: false, error, statusCode: 403 };
  }

  /**
   * Read a resource on behalf of an MCP App View. Unlike host/control-plane
   * resource reads, this re-checks the server's current opt-in on every request
   * so disabling MCP Apps revokes already-persisted or already-open Views.
   */
  async readResourceFromApp(
    serverName: string,
    uri: string,
  ): Promise<MCPServiceResponse<MCPReadResourceResult>> {
    const appAccess = await this.checkMcpAppAccess(serverName);
    if (appAccess)
      return appAccess as MCPServiceResponse<MCPReadResourceResult>;
    return this.readResource(serverName, uri);
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
    emptyResult: T,
  ): Promise<T> {
    // Point-of-use guard on top of the connect-time hard gate (issue #54).
    if (await this.isServerDisabled(serverName)) {
      const error = `Server '${serverName}' is disabled. Enable it on the MCP page to use it.`;
      log.warn(`listWithReconnect: ${error}`);
      return { ...emptyResult, error };
    }

    const listLeased = async (): Promise<{ client?: Client; result: T }> => {
      const acquired = await this.acquireServerLease(serverName);
      if (!acquired.lease) return { result: { ...emptyResult, error: acquired.error || 'Server not connected' } };
      const lease = acquired.lease;
      try {
        const result = await lister(lease.client, serverName);
        if (lease.isStale() || this.getClient(serverName) !== lease.client) {
          return { client: lease.client, result: { ...emptyResult, error: 'MCP connection changed during discovery. Try again.' } };
        }
        return { client: lease.client, result };
      } finally {
        lease.release();
      }
    };
    let { client, result } = await listLeased();
    if (!result.error || !client) {
      return result;
    }

    log.warn(
      `listWithReconnect: Listing for ${serverName} failed (${result.error}); forcing reconnect and retrying once`,
    );
    const reconnect = await this.forceReconnect(serverName, client);
    if (!reconnect.success) {
      log.warn(
        `listWithReconnect: Reconnect for ${serverName} failed: ${reconnect.error}`,
      );
      return { ...emptyResult, error: reconnect.error || result.error };
    }

    ({ client, result } = await listLeased());
    if (result.error) {
      log.warn(
        `listWithReconnect: Retry after reconnect still failed for ${serverName}:`,
        result.error,
      );
    } else {
      log.info(
        `listWithReconnect: Recovered after reconnect for ${serverName}`,
      );
    }
    return result;
  }

  /**
   * List the resources a server publishes (#15). Reconnect-and-retry like listServerTools.
   */
  async listServerResources(
    serverName: string,
    cursor?: string,
  ): Promise<{ resources: MCPResource[]; nextCursor?: string; error?: string }> {
    if (isProtectedExecutionServer(serverName)) return { resources: [], error: 'execution_protocol_surface_forbidden' };
    log.debug(`listServerResources: Entering method for server ${serverName}`);
    return this.listWithReconnect<{ resources: MCPResource[]; nextCursor?: string; error?: string }>(serverName, (client, name) => cursor === undefined
      ? cachedMcpList(client, 'resources', 'resources', () => listResources(client, name, cursor))
      : listResources(client, name, cursor), { resources: [] });
  }

  /**
   * List the resource templates a server publishes (#15).
   */
  async listServerResourceTemplates(
    serverName: string,
    cursor?: string,
  ): Promise<{ resourceTemplates: MCPResourceTemplate[]; nextCursor?: string; error?: string }> {
    if (isProtectedExecutionServer(serverName)) return { resourceTemplates: [], error: 'execution_protocol_surface_forbidden' };
    log.debug(
      `listServerResourceTemplates: Entering method for server ${serverName}`,
    );
    return this.listWithReconnect<{ resourceTemplates: MCPResourceTemplate[]; nextCursor?: string; error?: string }>(serverName, (client, name) => cursor === undefined
      ? cachedMcpList(client, 'resources', 'templates', () => listResourceTemplates(client, name, cursor))
      : listResourceTemplates(client, name, cursor), {
      resourceTemplates: [],
    });
  }

  /**
   * Read a resource's contents from a server (#15).
   */
  async readResource(
    serverName: string,
    uri: string,
  ): Promise<MCPServiceResponse<MCPReadResourceResult>> {
    return harnessResourceSnapshot(JSON.stringify([serverName, uri]), () => this.readResourceUncached(serverName, uri));
  }

  private async readResourceUncached(serverName: string, uri: string): Promise<MCPServiceResponse<MCPReadResourceResult>> {
    if (isProtectedExecutionServer(serverName)) return { success: false, error: 'execution_protocol_surface_forbidden' };
    log.debug(
      `readResource: Entering method for server ${serverName}, uri ${uri}`,
    );
    const acquired = await this.acquireServerLease(serverName);
    if (!acquired.lease) return { success: false, error: acquired.error || 'Server not connected' };
    try {
      const result = await readResourceFn(acquired.lease.client, serverName, uri);
      log.info(`readResource: Read resource ${uri} on ${serverName}`);
      return result;
    } finally {
      acquired.lease.release();
    }
  }

  /** The service members the skills functions use. */
  private skillsHost(): serviceSkills.McpSkillsHost {
    return {
      getServerConfig: (name) => this.getServerConfig(name),
      connectServer: (name) => this.connectServer(name),
      getClient: (name) => this.getClient(name),
      forceReconnect: (name) => this.forceReconnect(name),
      getServerSkill: (name, uri) => this.getServerSkill(name, uri),
    };
  }

  async getServerProxyCapabilities(serverName: string): Promise<{
    skillsCapability?: McpSkillsExtensionCapability;
    appsCapability?: Record<string, unknown>;
  }> {
    return serviceSkills.getServerProxyCapabilities(this.skillsHost(), serverName);
  }

  async getServerSkillsCapability(
    serverName: string,
  ): Promise<McpSkillsExtensionCapability | undefined> {
    return serviceSkills.getServerSkillsCapability(this.skillsHost(), serverName);
  }

  async listServerSkills(
    serverName: string,
    cursor?: string,
  ): Promise<McpServerSkillsResult> {
    return serviceSkills.listServerSkills(this.skillsHost(), serverName, cursor);
  }

  async getServerSkill(
    serverName: string,
    uri: string,
  ): Promise<MCPServiceResponse<McpGetSkillResult>> {
    return serviceSkills.getServerSkill(this.skillsHost(), serverName, uri);
  }

  async readServerSkillDirectory(
    serverName: string,
    uri: string,
    cursor?: string,
  ): Promise<MCPServiceResponse<McpReadSkillDirectoryResult>> {
    return serviceSkills.readServerSkillDirectory(this.skillsHost(), serverName, uri, cursor);
  }

  async readVerifiedSkillResource(
    serverName: string,
    skillUri: string,
    resourceUri: string,
  ): Promise<MCPServiceResponse<McpVerifiedSkillResource>> {
    return serviceSkills.readVerifiedSkillResource(this.skillsHost(), serverName, skillUri, resourceUri);
  }

  async loadVerifiedSkill(
    serverName: string,
    skillUri: string,
    conversationId: string,
  ): Promise<MCPServiceResponse<McpLoadedSkill>> {
    return serviceSkills.loadVerifiedSkill(this.skillsHost(), serverName, skillUri, conversationId);
  }

  /**
   * List the prompt templates a server publishes (#15).
   */
  async listServerPrompts(
    serverName: string,
  ): Promise<{ prompts: MCPPrompt[]; error?: string }> {
    if (isProtectedExecutionServer(serverName)) return { prompts: [], error: 'execution_protocol_surface_forbidden' };
    log.debug(`listServerPrompts: Entering method for server ${serverName}`);
    return this.listWithReconnect(serverName, listPrompts, { prompts: [] });
  }

  /**
   * Fetch a prompt template, expanded with arguments, from a server (#15).
   */
  async getPrompt(
    serverName: string,
    promptName: string,
    args?: Record<string, string>,
  ): Promise<MCPServiceResponse<MCPGetPromptResult>> {
    if (isProtectedExecutionServer(serverName)) return { success: false, error: 'execution_protocol_surface_forbidden' };
    log.debug(
      `getPrompt: Entering method for server ${serverName}, prompt ${promptName}`,
    );
    const acquired = await this.acquireServerLease(serverName);
    if (!acquired.lease) return { success: false, error: acquired.error || 'Server not connected' };
    try {
      const result = await getPromptFn(acquired.lease.client, serverName, promptName, args);
      log.info(`getPrompt: Got prompt ${promptName} on ${serverName}`);
      return result;
    } finally {
      acquired.lease.release();
    }
  }

  /** The service members config updates use. */
  private configUpdateHost(): serverConfigUpdate.ServerConfigUpdateHost {
    return {
      clients: () => this.clients,
      connectionRetryAttempts: () => this.connectionRetryAttempts,
      stderrLogs: () => this.stderrLogs,
      lastConnectionError: () => this.lastConnectionError,
      approvalFailures: () => this.approvalFailures,
      loadServerConfigs: () => this.loadServerConfigs(),
      getClient: (name) => this.getClient(name),
      connectServer: (configOrName) => typeof configOrName === 'string'
        ? this.connectServer(configOrName) : this.connectServer(configOrName),
      disconnectServer: (name) => this.disconnectServer(name),
      clearRetryTimer: (name) => this.clearRetryTimer(name),
      notifyRootsChanged: (name) => this.notifyRootsChanged(name),
      ensureManagedServerRootDir: (config) => this.ensureManagedServerRootDir(config),
      handleConnectionStateChange: (name, config) => this.handleConnectionStateChange(name, config),
    };
  }

  /** Creates the managed root of a server without a clone step. See serverConfigSave.ts. */
  private ensureManagedServerRootDir(config: MCPServerConfig): Promise<void> {
    return ensureManagedServerRootDir(config);
  }

  /** Connects, reconnects or disconnects a server after its config changed. See serverConfigUpdate.ts. */
  private handleConnectionStateChange(serverName: string, config: MCPServerConfig): Promise<void> {
    return serverConfigUpdate.handleConnectionStateChange(this.configUpdateHost(), serverName, config);
  }

  async updateServerConfig(
    serverName: string,
    updates: Partial<MCPServerConfig>,
  ): Promise<MCPServerConfig | MCPServiceResponse> {
    return serverConfigUpdate.updateServerConfig(this.configUpdateHost(), serverName, updates);
  }

  async deleteServerConfig(serverName: string): Promise<MCPServiceResponse> {
    return serverConfigUpdate.deleteServerConfig(this.configUpdateHost(), serverName);
  }

  /**
   * Get the connection status of an MCP server
   */
  async getServerStatus(serverName: string): ReturnType<typeof readServerStatus> {
    return readServerStatus({
      getServerConfig: (name) => this.getServerConfig(name),
      getClient: (name) => this.getClient(name),
      isStartingUp: () => this.isStartingUp(),
      approvalFailures: () => this.approvalFailures,
      stderrLogs: () => this.stderrLogs,
      lastConnectionError: () => this.lastConnectionError,
      connectingServers: () => this.connectingServers,
    }, serverName);
  }

  /** Connects every enabled server (only always-on ones with lazy start). See connectionScheduling.ts. */
  async startEnabledServers(): Promise<void> {
    return connectionScheduling.startEnabledServers(this.schedulingHost());
  }

  /**
   * Get a list of all available clients for debugging purposes
   */
  async getAvailableClients(): Promise<string[]> {
    try {
      // Get all server configs directly from storage
      const configs = await this.loadServerConfigs();

      if (!configs || "error" in configs) {
        log.warn(
          "getAvailableClients: Failed to load server configs:",
          configs?.error,
        );
        return [];
      }

      // Get the status of each server
      const serverStatuses = await Promise.all(
        (configs as MCPServerConfig[]).map(async (config: MCPServerConfig) => {
          try {
            const status = await this.getServerStatus(config.name);
            return {
              name: config.name,
              status: typeof status === "string" ? status : status.status,
              connected:
                typeof status === "string"
                  ? status === "connected"
                  : status.status === "connected",
            };
          } catch (error) {
      if (error instanceof BundledFlujoWorkloadError || error instanceof McpRuntimeAuthorityRetirementError) throw error;
            log.warn(
              `getAvailableClients: Error getting status for ${config.name}:`,
              error,
            );
            return { name: config.name, status: "error", connected: false };
          }
        }),
      );

      // Return a formatted list of clients with their status
      return serverStatuses.map(
        (s: { name: string; status: string }) => `${s.name} (${s.status})`,
      );
    } catch (error) {
      if (error instanceof BundledFlujoWorkloadError || error instanceof McpRuntimeAuthorityRetirementError) throw error;
      log.error("getAvailableClients: Error getting available clients:", error);
      return [];
    }
  }
}

// Create and export the singleton instance for use in other server components
export const mcpService = new MCPService();
