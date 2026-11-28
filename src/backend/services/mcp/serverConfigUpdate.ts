// Saving, renaming and deleting an MCP server config, and bringing its live connection in line with the change.
import { resolveEnvForSave, resolveHeadersForSave, resolveOAuthSecretForSave } from './serverConfigSave';
import { assertBundledFlujoWorkloadEffectCurrent, BundledFlujoWorkloadError } from '../security/bundledFlujoWorkload';
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createLogger } from "@/utils/logger";
import { isMcpTransport, MCP_TRANSPORT_INVALID } from './transportAdmission';
import { MCPServerConfig, MCPStreamableConfig, MCPSSEConfig, MCPServiceResponse } from "@/shared/types/mcp";
import { saveConfig } from "./config";
import { pinServer, unpinServer } from "./mcpLeasePool";
import { removeMcpbServerFiles } from "./mcpb/files";
import {
  hasMaskedStoredHeaders,
  hasStoredSecretHeaders,
  isSameMcpHeaderDestination,
  MCP_HEADER_DESTINATION_CHANGED,
  usesMcpHttpHeaders,
} from "@/utils/mcp/headerDestination";
import { McpRuntimeAuthorityRetirementError } from "./connection";

const log = createLogger('backend/services/mcp/serverConfigUpdate');

/** What saving, renaming and deleting a config uses from the MCP service. Registries are read when used. */
export type ServerConfigUpdateHost = {
  clients(): Map<string, Client>;
  connectionRetryAttempts(): Map<string, number>;
  stderrLogs(): Map<string, string[]>;
  lastConnectionError(): Map<string, string>;
  approvalFailures(): Map<string, MCPServiceResponse>;
  loadServerConfigs(): Promise<MCPServerConfig[] | MCPServiceResponse>;
  getClient(serverName: string): Client | undefined;
  connectServer(configOrName: MCPServerConfig | string): Promise<MCPServiceResponse>;
  disconnectServer(serverName: string): Promise<MCPServiceResponse>;
  clearRetryTimer(serverName: string): void;
  notifyRootsChanged(serverName: string): void;
  /** Service methods so a test can replace them, as before the move. */
  ensureManagedServerRootDir(config: MCPServerConfig): Promise<void>;
  handleConnectionStateChange(serverName: string, config: MCPServerConfig): Promise<void>;
};

/**
 * Update an MCP server configuration
 */
export async function updateServerConfig(
  host: ServerConfigUpdateHost,
  serverName: string,
  updates: Partial<MCPServerConfig>,
): Promise<MCPServerConfig | MCPServiceResponse> {
  if (Object.prototype.hasOwnProperty.call(updates, 'transport') && !isMcpTransport(updates.transport)) {
    return { success: false, error: MCP_TRANSPORT_INVALID, statusCode: 400 };
  }
  log.debug(`updateServerConfig: Entering method for server ${serverName}`);

  // Load all configs from storage
  const configsResult = await host.loadServerConfigs();
  if (!Array.isArray(configsResult)) {
    log.warn(
      `updateServerConfig: Failed to load configs:`,
      configsResult.error,
    );
    return configsResult;
  }

  const configs = configsResult;
  let config = configs.find((c) => c.name === serverName);

  // A rename arrives as a PUT whose path is the CURRENT (old) name and whose body
  // carries a different `name`. Detect it up front: the storage swap below already
  // re-keys the entry, but the live connection and per-name state are still keyed by
  // the old name and must be migrated explicitly (see the connection handling at the
  // end of this method).
  const isRename =
    !!config &&
    typeof updates.name === "string" &&
    updates.name !== serverName;

  // Refuse to rename onto a name another server already uses: the configs are keyed by
  // name, so saving would silently drop one of the two. Surface it as an error instead.
  if (isRename && configs.some((c) => c.name === updates.name)) {
    log.warn(
      `updateServerConfig: Refusing to rename ${serverName} -> ${updates.name}: name already in use`,
    );
    return {
      success: false,
      error: `A server named "${updates.name}" already exists`,
    };
  }

  if (!config && updates.name) {
    // New HTTP servers must not inherit the stdio launch surface.
    log.info(
      `updateServerConfig: Creating new server config for ${updates.name}`,
    );
    const remote = updates.transport === 'streamable' || updates.transport === 'sse';
    const created: MCPServerConfig = {
      name: updates.name,
      ...(remote ? {
        transport: updates.transport as 'streamable' | 'sse',
        serverUrl: (updates as Partial<MCPStreamableConfig | MCPSSEConfig>).serverUrl ?? '',
      } : { transport: 'stdio' as const, command: '', args: [], _buildCommand: '', _installCommand: '' }),
      env: {},
      disabled: false,
      _buildCommand: '',
      _installCommand: '',
      rootPath: "",
    };
    configs.push(created);
    config = created;
  } else if (!config) {
    log.warn(`updateServerConfig: Server ${serverName} not found`);
    return { success: false, error: `Server ${serverName} not found` };
  }
  if (!config) return { success: false, error: `Server ${serverName} not found` };

  // Partial edits also inherit old headers when the field is omitted. Neither that
  // inheritance nor a masked-header restore may move saved secrets to a new endpoint.
  const incomingHeaders = (updates as Partial<MCPSSEConfig | MCPStreamableConfig>).headers;
  const existingHeaders = (config as MCPSSEConfig | MCPStreamableConfig).headers;
  const reusesSavedHeaders = incomingHeaders === undefined
    ? hasStoredSecretHeaders(existingHeaders)
    : hasMaskedStoredHeaders(incomingHeaders, existingHeaders);
  const nextDestination = { ...config, ...updates };
  if (
    reusesSavedHeaders &&
    (usesMcpHttpHeaders(config) || usesMcpHttpHeaders(nextDestination)) &&
    !isSameMcpHeaderDestination(nextDestination, config)
  ) {
    return { success: false, error: MCP_HEADER_DESTINATION_CHANGED, statusCode: 400 };
  }

  // Encrypt all credential updates before saving or changing a live connection.
  // Bindings remain references and are resolved/decrypted at connect time.
  updates = { ...updates };
  try {
    if (updates.env !== undefined) {
      updates.env = await resolveEnvForSave(updates.env, config.env);
    }
    const incomingSecret = (updates as Partial<MCPStreamableConfig>).oauthClientSecret;
    if (incomingSecret !== undefined) {
      const existingSecret = (config as MCPStreamableConfig).oauthClientSecret;
      (updates as Partial<MCPStreamableConfig>).oauthClientSecret =
        await resolveOAuthSecretForSave(incomingSecret, existingSecret);
    }

    if (incomingHeaders !== undefined) {
      (updates as Partial<MCPSSEConfig | MCPStreamableConfig>).headers =
        await resolveHeadersForSave(incomingHeaders, existingHeaders);
    }
  } catch {
    // Do not log the original error: encryption failures may contain credential input.
    return { success: false, error: "Failed to encrypt MCP credentials; configuration was not saved" };
  }

  // Update the config with the protected values.
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
    (config.rootPath ?? "") !== (updatedConfig.rootPath ?? "");

  // Find and update the config in the array
  const index = configs.findIndex((c) => c.name === serverName);
  if (index !== -1) {
    configs[index] = updatedConfig;
  } else if (updatedConfig.name) {
    // This is a new config
    configs.push(updatedConfig);
  }

  // Save all configs to storage
  await assertBundledFlujoWorkloadEffectCurrent();
  const saveResult = await saveConfig(
    new Map(configs.map((c) => [c.name, c])),
  );
  if (!saveResult.success) {
    log.warn(
      `updateServerConfig: Failed to save config for ${serverName}:`,
      saveResult.error,
    );
    return saveResult;
  }

  // Remote and Registry package servers have no clone step, so create their
  // managed root explicitly. A failure here must never block the config update.
  await host.ensureManagedServerRootDir(updatedConfig);

  if (isRename) {
    // Flow nodes persist MCP bindings by server name (`properties.boundServer`).
    // Once the config has been safely re-keyed, cascade the rename through every
    // saved flow so those references do not become dangling. Keep this import lazy:
    // the execution/flow layer already depends on MCPService, and a static import
    // here would introduce a module-initialization cycle.
    try {
      const { flowService } = await import("@/backend/services/flow");
      const migration = await flowService.migrateMcpServerReferences(
        serverName,
        updatedConfig.name,
      );
      if (!migration.success) {
        log.warn(
          `updateServerConfig: Server rename succeeded, but some flow references could not be migrated`,
          migration,
        );
      } else if (migration.migratedReferences > 0) {
        log.info(
          `updateServerConfig: Migrated ${migration.migratedReferences} MCP reference(s) across ${migration.migratedFlows} flow(s)`,
        );
      }
    } catch (error) {
    if (error instanceof BundledFlujoWorkloadError || error instanceof McpRuntimeAuthorityRetirementError) throw error;
      // The config rename is already durable at this point. Do not report the
      // entire rename as failed (which would make a retry address the vanished old
      // name), but retain a high-signal log if flow persistence was unavailable.
      log.warn(
        `updateServerConfig: Server rename succeeded, but flow-reference migration failed`,
        error,
      );
    }
  }

  // Handle connection state based on config changes.
  if (isRename) {
    // The server now lives under a new name. Tear down everything still keyed by the
    // OLD name — the live client (and its child process), retry timers, captured
    // stderr and the last connection error — so the rename doesn't leak a dangling
    // process or surface stale status under the old name. Then drive the connection
    // under the NEW name.
    if (host.clients().has(serverName)) {
      const disconnected = await host.disconnectServer(serverName);
      if (!disconnected.success && disconnected.errorType === 'mcp-authority-retirement') {
        throw new McpRuntimeAuthorityRetirementError([], 'MCP authority retirement remains uncertain.');
      }
    } else {
      host.clearRetryTimer(serverName);
      host.connectionRetryAttempts().delete(serverName);
    }
    host.stderrLogs().delete(serverName);
    host.lastConnectionError().delete(serverName);
    host.approvalFailures().delete(serverName);

    await host.handleConnectionStateChange(updatedConfig.name, updatedConfig);
  } else {
    await host.handleConnectionStateChange(serverName, updatedConfig);
  }

  if ((config.alwaysOn === true) !== (updatedConfig.alwaysOn === true)) {
    if (updatedConfig.alwaysOn === true) {
      pinServer(updatedConfig.name, "always-on");
      if (!updatedConfig.disabled) void host.connectServer(updatedConfig.name);
    } else {
      unpinServer(updatedConfig.name, "always-on");
    }
  }

  if (effectiveRootsChanged) {
    host.notifyRootsChanged(updatedConfig.name);
  }

  log.info(
    `updateServerConfig: Successfully updated config for ${serverName}${isRename ? ` (renamed to ${updatedConfig.name})` : ""}`,
  );
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
export async function handleConnectionStateChange(
  host: ServerConfigUpdateHost,
  serverName: string,
  config: MCPServerConfig,
): Promise<void> {
  log.debug(
    `handleConnectionStateChange: Entering method for server ${serverName}`,
  );

  // Global-aware: the live client may exist only in the shared recovery map
  // (owned by another module instance). A local clients.has() check would
  // miss it and skip the "re-apply config to connected server" path that a PAT/
  // header edit needs to rebuild the connection.
  const isCurrentlyConnected = !!host.getClient(serverName);
  const shouldBeConnected = !config.disabled;

  if (isCurrentlyConnected && !shouldBeConnected) {
    // If server should be disabled, disconnect it
    log.info(
      `handleConnectionStateChange: Disconnecting disabled server ${serverName}`,
    );
    try {
      const disconnected = await host.disconnectServer(serverName);
      if (!disconnected.success && disconnected.errorType === 'mcp-authority-retirement') {
        throw new McpRuntimeAuthorityRetirementError([], 'MCP authority retirement remains uncertain.');
      }
    } catch (error) {
    if (error instanceof BundledFlujoWorkloadError || error instanceof McpRuntimeAuthorityRetirementError) throw error;
      log.warn(
        `handleConnectionStateChange: Failed to disconnect server ${serverName} during update:`,
        error,
      );
    }
  } else if (!isCurrentlyConnected && shouldBeConnected) {
    // If the server should be enabled but isn't connected, connect it
    log.info(
      `handleConnectionStateChange: Connecting previously disabled server ${serverName}`,
    );
    await host.connectServer(config);
  } else if (isCurrentlyConnected && shouldBeConnected) {
    // Server stays enabled, but its config may have changed (command, args, env,
    // URL, auth material...). Re-run connectServer: shouldRecreateClient rebuilds the
    // connection only when something meaningful actually changed (otherwise it's a
    // cheap no-op). Roots changes alone never rebuild (issue 46) — they are announced
    // via notifications/roots/list_changed by updateServerConfig instead.
    log.info(
      `handleConnectionStateChange: Re-applying config to connected server ${serverName}`,
    );
    await host.connectServer(config);
  } else if (!shouldBeConnected) {
    // If server should be disabled, also clear any pending retry timers
    log.info(
      `handleConnectionStateChange: Clearing retry timers for disabled server ${serverName}`,
    );
    host.clearRetryTimer(serverName);
    host.connectionRetryAttempts().delete(serverName);
  }
}

/**
 * Remove a saved MCP server config and its live connection. The service's
 * deleteServerConfig is this raw removal; people delete through
 * deleteMcpServerAndMoveUses (serverDeletion.ts).
 */
export async function removeServerConfig(host: ServerConfigUpdateHost, serverName: string): Promise<MCPServiceResponse> {
  log.debug(`deleteServerConfig: Entering method for server ${serverName}`);

  // First disconnect if connected
  if (host.clients().has(serverName)) {
    log.info(
      `deleteServerConfig: Disconnecting server ${serverName} before deletion`,
    );
    const disconnected = await host.disconnectServer(serverName);
    if (!disconnected.success && disconnected.errorType === 'mcp-authority-retirement') return disconnected;
  }

  // Load all configs from storage
  const configsResult = await host.loadServerConfigs();
  if (!Array.isArray(configsResult)) {
    log.warn(
      `deleteServerConfig: Failed to load configs:`,
      configsResult.error,
    );
    return configsResult;
  }

  const configs = configsResult;

  // Find the config to delete
  const index = configs.findIndex((c) => c.name === serverName);
  if (index === -1) {
    log.warn(`deleteServerConfig: Server ${serverName} not found in configs`);
    return { success: false, error: `Server ${serverName} not found` };
  }

  // Remove the config from the array
  const [removed] = configs.splice(index, 1);

  // Save updated configs
  log.debug(
    `deleteServerConfig: Saving updated configs after deleting ${serverName}`,
  );
  await assertBundledFlujoWorkloadEffectCurrent();
  const saveResult = await saveConfig(
    new Map(configs.map((c) => [c.name, c])),
  );

  if (saveResult.success) {
    log.info(`deleteServerConfig: Successfully deleted server ${serverName}`);
    // An MCP bundle's unpacked files belong to its server (#1230).
    await removeMcpbServerFiles(removed);
  } else {
    log.warn(
      `deleteServerConfig: Error saving configs after deleting ${serverName}:`,
      saveResult.error,
    );
  }

  return saveResult;
}
