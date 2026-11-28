// When MCP servers are (re)connected: the startup sweep and backoff retries after an unexpected close.
import os from 'node:os';
import { BundledFlujoWorkloadError } from '../security/bundledFlujoWorkload';
import { executionApprovalFailure } from './executionApproval';
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createLogger } from "@/utils/logger";
import { bindToCurrentWorkspace } from "@/utils/workspace";
import { runWithConcurrency } from "./utils/boundedConcurrency";
import { MCPServerConfig, MCPServiceResponse } from "@/shared/types/mcp";
import { pinServer } from "./mcpLeasePool";
import { McpRuntimeAuthorityRetirementError } from "./connection";
import { resolveLazyStart } from "./lazyStart";

const log = createLogger('backend/services/mcp/connectionScheduling');

/**
 * Servers the startup sweep connects at once: one per two processors and one
 * per 2 GiB of memory, whichever is smaller, at least two and at most eight.
 * The others wait for a free place, so none is refused.
 */
export function bootConcurrency(
  processors = os.availableParallelism?.() ?? os.cpus().length,
  totalMemory = os.totalmem(),
): number {
  return Math.max(2, Math.min(8, Math.floor(processors / 2), Math.floor(totalMemory / (2 * 1024 ** 3))));
}

/**
 * What connection scheduling uses from the MCP service. Registries are read
 * when used, so a retry that fires later sees the registry of its workspace.
 */
export type ConnectionSchedulingHost = {
  connectionRetryTimers(): Map<string, NodeJS.Timeout>;
  connectionRetryAttempts(): Map<string, number>;
  connectingServers(): Set<string>;
  getServerConfig(serverName: string): Promise<MCPServerConfig | null>;
  getClient(serverName: string): Client | undefined;
  forceReconnect(serverName: string): Promise<MCPServiceResponse>;
  connectServer(config: MCPServerConfig): Promise<MCPServiceResponse>;
  loadServerConfigs(): Promise<MCPServerConfig[] | MCPServiceResponse>;
  setStartingUp(value: boolean): void;
};

/**
 * Clear retry timer for a server
 */
export function clearRetryTimer(host: ConnectionSchedulingHost, serverName: string): void {
  const timer = host.connectionRetryTimers().get(serverName);
  if (timer) {
    clearTimeout(timer);
    host.connectionRetryTimers().delete(serverName);
    log.debug(`Cleared retry timer for server ${serverName}`);
  }
}

/**
 * Schedule connection retry with exponential backoff
 */
export function scheduleConnectionRetry(
  host: ConnectionSchedulingHost,
  serverName: string,
  config: MCPServerConfig,
): void {
  // Clear any existing timer
  clearRetryTimer(host, serverName);

  // Get current retry attempt count
  const currentAttempts = host.connectionRetryAttempts().get(serverName) || 0;
  const maxAttempts = 5; // Maximum retry attempts

  if (currentAttempts >= maxAttempts) {
    log.warn(
      `Maximum retry attempts (${maxAttempts}) reached for server ${serverName}, stopping retries`,
    );
    host.connectionRetryAttempts().delete(serverName);
    return;
  }

  // Calculate delay with exponential backoff: 2^attempt * 5000ms, max 5 minutes
  const baseDelay = 5000; // 5 seconds
  const maxDelay = 300000; // 5 minutes
  const delay = Math.min(Math.pow(2, currentAttempts) * baseDelay, maxDelay);

  log.info(
    `Scheduling connection retry for server ${serverName} in ${delay}ms (attempt ${currentAttempts + 1}/${maxAttempts})`,
  );

  const timer = setTimeout(bindToCurrentWorkspace(async () => {
    log.info(
      `Attempting to reconnect server ${serverName} (attempt ${currentAttempts + 1}/${maxAttempts})`,
    );

    // Check current server configuration before attempting retry
    const currentConfig = await host.getServerConfig(serverName);
    if (!currentConfig) {
      log.info(
        `Server ${serverName} configuration not found, stopping retry attempts`,
      );
      host.connectionRetryAttempts().delete(serverName);
      return;
    }

    // Check if server is now disabled
    if (currentConfig.disabled) {
      log.info(
        `Server ${serverName} is now disabled, stopping retry attempts`,
      );
      host.connectionRetryAttempts().delete(serverName);
      return;
    }

    // If the server meanwhile has a live, RESPONSIVE connection (e.g. this timer was
    // scheduled by a zombie's late close event, or another path already reconnected),
    // reconnecting here would tear the healthy server down — the exact mechanism of
    // the restart death-spiral. Verify with a real ping, not just map presence.
    const existingClient = host.getClient(serverName);
    if (existingClient) {
      try {
        await existingClient.ping({ timeout: 5000 });
        log.info(
          `Server ${serverName} is already connected and responsive, cancelling retry`,
        );
        host.connectionRetryAttempts().delete(serverName);
        return;
      } catch (pingError) {
        log.warn(
          `Server ${serverName} has a registered client but ping failed (${pingError instanceof Error ? pingError.message : String(pingError)}); reconnecting from scratch`,
        );
      }
    }

    // Increment retry count
    host.connectionRetryAttempts().set(serverName, currentAttempts + 1);

    try {
      // A dead-but-present client must be torn down first (connectServer would
      // short-circuit on it); with no client a plain connect is enough.
      const result = existingClient
        ? await host.forceReconnect(serverName)
        : await host.connectServer(currentConfig);
      if (result.success) {
        log.info(
          `Successfully reconnected server ${serverName} after ${currentAttempts + 1} attempts`,
        );
        // Reset retry count on successful connection
        host.connectionRetryAttempts().delete(serverName);
      } else {
        log.warn(`Failed to reconnect server ${serverName}: ${result.error}`);
        // Don't retry if authentication is required
        if (result.requiresAuthentication || result.requiresApproval) {
          log.info(
            `Server ${serverName} needs user action, stopping retry attempts`,
          );
          host.connectionRetryAttempts().delete(serverName);
          return;
        }
        // Schedule another retry if we haven't reached max attempts
        scheduleConnectionRetry(host, serverName, currentConfig);
      }
    } catch (error) {
    if (error instanceof BundledFlujoWorkloadError || error instanceof McpRuntimeAuthorityRetirementError) throw error;
      if (executionApprovalFailure(error)) {
        host.connectionRetryAttempts().delete(serverName);
        return;
      }
      log.error(
        `Error during retry connection for server ${serverName}:`,
        error,
      );
      // Schedule another retry if we haven't reached max attempts
      scheduleConnectionRetry(host, serverName, currentConfig);
    }
  }), delay);

  host.connectionRetryTimers().set(serverName, timer);
}


/**
 * Clear all retry timers for disabled servers
 */
export async function clearRetryTimersForDisabledServers(host: ConnectionSchedulingHost): Promise<void> {
  log.debug(
    "clearRetryTimersForDisabledServers: Checking for disabled servers with active retry timers",
  );

  try {
    // Load current configs from storage
    const configs = await host.loadServerConfigs();

    if (!Array.isArray(configs)) {
      log.warn(
        "clearRetryTimersForDisabledServers: Failed to load server configs",
      );
      return;
    }

    // Find all disabled servers
    const disabledServers = configs.filter((config) => config.disabled);

    // Clear retry timers for disabled servers
    for (const config of disabledServers) {
      if (host.connectionRetryTimers().has(config.name)) {
        log.info(
          `clearRetryTimersForDisabledServers: Clearing retry timer for disabled server ${config.name}`,
        );
        clearRetryTimer(host, config.name);
        host.connectionRetryAttempts().delete(config.name);
      }
    }
  } catch (error) {
    if (error instanceof BundledFlujoWorkloadError || error instanceof McpRuntimeAuthorityRetirementError) throw error;
    log.error(
      "clearRetryTimersForDisabledServers: Error clearing retry timers:",
      error,
    );
  }
}


/**
 * Start all enabled servers.
 *
 * Issue #413: with lazy start (setting or `FLUJO_MCP_LAZY_START`) the sweep only DISCOVERS
 * configuration (so the MCP page and every tool/resource manifest consumer
 * still sees every enabled server) and warms nothing. Servers are then
 * connected on first use through `acquireServerLease`, which is the point of
 * the lazy pool: a dozen configured-but-unused servers cost nothing.
 *
 * The flag defaults OFF because eager startup may only be retired once every
 * consumer acquires a lease before use — the migration gate in the plan. Servers
 * marked always-on are warmed and pinned in either mode.
 */
export async function startEnabledServers(host: ConnectionSchedulingHost): Promise<void> {
  log.info("Starting all enabled servers");
  host.setStartingUp(true);

  try {
    // First, clear any retry timers for disabled servers
    await clearRetryTimersForDisabledServers(host);

    // Load configs directly from storage
    const configs = await host.loadServerConfigs();

    // Skip if there was an error loading configs
    if (!Array.isArray(configs)) {
      log.warn("Failed to load server configs, cannot start servers");
      return;
    }

    // Find all enabled servers
    const allEnabledServers = configs.filter((config) => !config.disabled);
    const lazyStart = await resolveLazyStart();
    // An always-on server is pinned: it is exempt from idle/LRU closure and is
    // warmed even in lazy mode (long-lived subscriptions/triggers need it live).
    const alwaysOn = allEnabledServers.filter(
      (config) => config.alwaysOn === true,
    );
    for (const config of alwaysOn) {
      pinServer(config.name, "always-on");
    }
    const enabledServers = lazyStart ? alwaysOn : allEnabledServers;
    if (lazyStart) {
      log.info(
        `Lazy MCP start: ${allEnabledServers.length} enabled server(s) discovered, ` +
          `warming only ${alwaysOn.length} always-on server(s)`,
      );
    } else {
      log.info(`Found ${enabledServers.length} enabled servers to start`);
      log.debug(`${enabledServers}`);
    }

    // Mark every enabled server as "connecting" up front so the MCP page shows a
    // spinner for all of them while the sweep runs. connectServer() clears each
    // entry as its attempt settles.
    enabledServers.forEach((config) =>
      host.connectingServers().add(config.name),
    );

    // Connect enabled servers with BOUNDED concurrency. Connecting sequentially made
    // startup scale with the SUM of every server's connect time (one slow/hanging
    // server delayed all the others, and the page sat in "connecting"/error far too
    // long). But the opposite extreme — an unbounded Promise.all — forks EVERY enabled
    // stdio server at once, a thundering-herd fork storm that spikes CPU/RAM and OOMs
    // small (e.g. 1-vCPU suspend/resume) hosts on every wake. A pool sized to the
    // machine keeps startup off the sequential worst case while capping the
    // simultaneous fork load. Each connectServer() already catches its own
    // failures and never rejects.
    const concurrency = bootConcurrency();
    log.info(
      `Connecting ${enabledServers.length} enabled servers with boot concurrency ${concurrency}`,
    );
    await runWithConcurrency(
      enabledServers,
      concurrency,
      async (config) => {
        log.info(`Starting server: ${config.name}`);
        await host.connectServer(config).catch((error) => {
          log.error(`Failed to start server ${config.name}:`, error);
          // Swallow so one failure doesn't abort the others.
        });
      },
    );
  } finally {
    // Always reset the flag when done, even if there were errors
    host.setStartingUp(false);
  }
}
