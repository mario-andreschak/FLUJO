import { assertBundledFlujoWorkloadEffectCurrent, BundledFlujoWorkloadError } from '../security/bundledFlujoWorkload';
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createLogger } from "@/utils/logger";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { resolveGlobalVars } from "@/backend/utils/resolveGlobalVars";
import {
  MCPToolResponse as ToolResponse,
  MCPServiceResponse,
} from "@/shared/types/mcp";
import { classifyToolCallResult } from "@/shared/types/mcp/tasks";
import { isBetaClient } from "./betaClient";
import {
  buildTaskAugmentation,
  decideTaskAugmentation,
  mcpTasksClientEnabled,
  modernToolResultSchema,
} from "./tasksProtocol";
import { runRemoteTaskLifecycle } from "./clientTasks";
import { resolveServerIdentity } from "./remoteTaskStore";
import { getElicitationContext } from './elicitationContext';
import { dispatchTaskInputRequest } from './taskInputHandlers';
import {
  checkToolCallVisibility,
  filterToolsForAudience,
  ToolCallSource,
  ToolListAudience,
} from "./appsProtocol";
import {
  getExternalAuthorizationStatus,
  invalidateExternalAuthorizationStatus,
  serverSupportsExternalAuthorization,
} from "./externalAuthorization";
import { parseStdioOAuthRevocation } from "mcp-stdio-oauth/protocol";
import { stampMcpAppOwnerScope } from "@/shared/utils/mcpAppOwnerScope";
import { listCompleteTools } from './toolDiscovery';
import { assertMcpIsolationDispatch, getManagedMcpIsolation, assertIsolatedMcpArguments } from './isolation';
import { McpIsolationError } from '../security/isolatedMcp';
import { TrustedHostMcpError } from '../security/trustedHostMcp';
import { getManagedTrustedHost } from './trustedHost';
import {
  assertExecutionToolDispatch,
  assertExecutionExtensionCurrent,
  executionToolRequestMeta,
  normalizeExecutionToolArguments,
  validateExecutionToolResult,
  isProtectedExecutionServer,
  ExecutionExtensionError,
  type ExecutionExtensionContext,
} from '@/backend/execution/extensions';

const log = createLogger("backend/services/mcp/tools");

/** Progress update forwarded from an MCP server during a long-running tool call. */
export interface ToolCallProgress {
  progress: number;
  total?: number;
  message?: string;
}

// Node's setTimeout ceiling (2^31-1 ms ≈ 24.8 days); larger values overflow and fire
// immediately. The SDK arms a timer for EVERY request (60s when none is given), so
// "no timeout" has to be expressed as this ceiling rather than by omitting the option.
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

/**
 * Normalize tool arguments to ensure we don't pass undefined values to MCP servers
 * This function replaces undefined/null values with appropriate defaults based on expected types
 */
function normalizeToolArguments(
  args: Record<string, unknown>,
  toolName: string,
): Record<string, unknown> {
  if (!args) return {};

  // Only own parameters cross the tool boundary. fromEntries defines data
  // properties, including __proto__, without invoking prototype setters.
  const entries: Array<[string, unknown]> = [];
  for (const [key, value] of Object.entries(args)) {
    let normalized: unknown = value;

    // Handle undefined or null values
    if (value === undefined || value === null) {
      log.debug(
        `Normalizing undefined/null value for parameter '${key}' in tool '${toolName}'`,
      );

      // Try to infer the type from the key name
      if (
        key.includes("number") ||
        key.endsWith("Count") ||
        key.endsWith("Id") ||
        key.endsWith("Limit")
      ) {
        normalized = 0;
        log.debug(`Using default value 0 for likely number parameter: ${key}`);
      } else if (
        key.includes("bool") ||
        key.startsWith("is") ||
        key.startsWith("has") ||
        key.startsWith("should")
      ) {
        normalized = false;
        log.debug(
          `Using default value false for likely boolean parameter: ${key}`,
        );
      } else if (
        key.includes("array") ||
        key.endsWith("s") ||
        key.endsWith("List") ||
        key.endsWith("Items")
      ) {
        normalized = [];
        log.debug(`Using empty array for likely array parameter: ${key}`);
      } else if (
        key.includes("object") ||
        key.endsWith("Options") ||
        key.endsWith("Config") ||
        key.endsWith("Settings")
      ) {
        normalized = {};
        log.debug(`Using empty object for likely object parameter: ${key}`);
      } else {
        // Default to empty string for unknown types
        normalized = "";
        log.debug(`Using empty string for parameter with unknown type: ${key}`);
      }
    }
    entries.push([key, normalized]);
  }

  return Object.fromEntries(entries);
}

/**
 * List tools available from an MCP server
 */
export async function listServerTools(
  client: Client | undefined,
  serverName: string,
  audience: ToolListAudience = "model",
): Promise<{ tools: ToolResponse[]; error?: string }> {
  log.debug("Entering listServerTools method");
  if (!client) {
    log.warn(`Server ${serverName} not connected`);
    return { tools: [], error: "Server not connected" };
  }

  try {
    log.info(`Listing tools for server ${serverName}`);
    const response = await listCompleteTools(client, getManagedTrustedHost(client.transport) ? { timeout: 180_000 } : undefined);
    const tools = response.tools.map((tool) => ({
      // Preserve the complete SDK-validated definition so newer standard
      // display and execution metadata (title, icons, outputSchema, execution)
      // reaches host UIs without requiring another lossy mapping update. The
      // explicit fallbacks retain FLUJO's existing behavior for older servers.
      ...tool,
      description: tool.description || "",
      inputSchema: tool.inputSchema || { type: "object" },
    })) as ToolResponse[];

    const visibleTools = filterToolsForAudience(tools, audience);
    log.verbose(`Processed tools for ${audience} audience:`, visibleTools);
    return { tools: visibleTools };
  } catch (error) {
    if (error instanceof BundledFlujoWorkloadError) throw error;
    log.warn(`Failed to list tools for server ${serverName}:`, error);
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";

    return {
      tools: [],
      error: errorMessage.includes("Connection timeout")
        ? errorMessage
        : `Failed to list tools: ${errorMessage}`,
    };
  }
}

/**
 * Call a tool on an MCP server with support for progress tracking.
 *
 * Timeout semantics: `timeout` is in SECONDS; `-1` or `undefined` means no timeout.
 * The timeout is enforced by the SDK itself (via RequestOptions), NOT wrapped here:
 * the SDK arms a 60s timer for every request when none is given and rejects with
 * McpError -32001, so a local Promise.race could only ever *shorten* that window,
 * never extend it — which is exactly the bug this replaces. "No timeout" is passed
 * as the setTimeout ceiling because the SDK has no off switch for its timer.
 *
 * Progress: passing `onprogress` makes the SDK attach its own `_meta.progressToken`
 * (the JSON-RPC request id) and register a handler for it — which is also what makes
 * `resetTimeoutOnProgress` work, so a long-running-but-alive tool that reports
 * progress keeps its finite timeout from firing. Server progress notifications are
 * forwarded to `onProgress` (the flow engine turns them into live execution events).
 */
export async function callTool(
  client: Client | undefined,
  serverName: string,
  toolName: string,
  args: Record<string, unknown>,
  timeout?: number,
  onProgress?: (progress: ToolCallProgress) => void,
  signal?: AbortSignal,
  source: ToolCallSource = "host",
  callerNodeId?: string,
  ownerScope?: string,
  executionExtensionContext?: ExecutionExtensionContext,
): Promise<MCPServiceResponse> {
  log.debug("Entering callTool method");
  if (!client) {
    log.warn(`Server ${serverName} not found`);
    return {
      success: false,
      error: `Server ${serverName} not found`,
      statusCode: 404,
    };
  }

  const timeoutMs =
    timeout !== undefined && timeout > 0
      ? Math.min(timeout * 1000, MAX_TIMEOUT_MS)
      : MAX_TIMEOUT_MS;
  const isolated = Boolean(getManagedMcpIsolation(client.transport));
  const trustedHost = Boolean(getManagedTrustedHost(client.transport));

  try {
    const privateExecution = Boolean(executionExtensionContext) || isProtectedExecutionServer(serverName);
    if (privateExecution) await assertExecutionToolDispatch(executionExtensionContext, serverName, source);
    // Refuse revoked or untracked local clients before discovery or accessing
    // the shared interpolation store. Recheck again at actual tool dispatch.
    await assertMcpIsolationDispatch(client, serverName);
    // MCP Apps may call tools only on their own backing server, and only when
    // the server's definition grants the "app" audience. The service passes
    // the exact client belonging to the frame's server; listing and dispatch
    // both happen on that same client object, so authorization cannot be
    // borrowed from another server connection.
    if (source === "app" || source === "model") {
      const listed = await listServerTools(client, serverName, "all");
      if (listed.error) {
        return {
          success: false,
          error: `Could not verify MCP App access to tool '${toolName}' on '${serverName}': ${listed.error}`,
          errorType: "tool-authorization-list",
          statusCode: 502,
        };
      }

      const access = checkToolCallVisibility(
        listed.tools,
        serverName,
        toolName,
        source,
      );
      if (!access.allowed) {
        log.warn(`Rejected ${source} tool call: ${access.error}`);
        return {
          success: false,
          error: access.error,
          statusCode: access.statusCode,
        };
      }
    }

    // Resolve any global variable references in the arguments
    if (isolated) assertIsolatedMcpArguments(args);
    if (trustedHost) {
      try { assertIsolatedMcpArguments(args); }
      catch { throw new TrustedHostMcpError('HOST_POLICY_INVALID'); }
    }
    if (!privateExecution && !isolated && !trustedHost) log.debug(`Original args for tool ${toolName}:`, args);
    // Private execution arguments do not read the shared interpolation/secret store.
    const resolvedArgs = privateExecution || isolated || trustedHost ? args : await resolveGlobalVars(args);

    // Ensure resolvedArgs is a record before normalizing
    const argsRecord =
      typeof resolvedArgs === "object" && resolvedArgs !== null
        ? (resolvedArgs as Record<string, unknown>)
        : {};

    // Normalize undefined/null values based on parameter types
    // This ensures we don't pass undefined values to MCP servers
    const normalizedArgs = privateExecution ? normalizeExecutionToolArguments(executionExtensionContext!, toolName, argsRecord)
      : normalizeToolArguments(argsRecord, toolName);
    if (!privateExecution && !isolated && !trustedHost) log.debug(`Normalized args for tool ${toolName}:`, normalizedArgs);

    log.debug(`Calling tool ${toolName} with SDK timeout ${timeoutMs}ms`);
    const callOptions = {
      timeout: timeoutMs,
      resetTimeoutOnProgress: true,
      ...(signal ? { signal } : {}),
      onprogress: (progress: ToolCallProgress) => {
        if (!privateExecution) {
          if (!isolated && !trustedHost) log.debug(
            `Progress for tool ${toolName}: ${progress.progress}${progress.total !== undefined ? `/${progress.total}` : ""}${progress.message ? ` — ${progress.message}` : ""}`,
          );
          onProgress?.(progress);
        }
      },
    };
    // MCP Tasks negotiation (issue #404). Task-augmented execution is
    // requested only after the live connection advertises the corresponding
    // generation and the feature flag is on. Legacy requests use params.task
    // and per-tool taskSupport; modern requests carry extension capabilities.
    const taskDecision = privateExecution
      ? { request: false, reason: 'private synchronous profile' } as Awaited<ReturnType<typeof decideTaskAugmentation>>
      : await decideTaskAugmentation(client, toolName);
    if (taskDecision.request) {
      log.info(
        `Requesting task-augmented execution of ${toolName} on ${serverName} (${taskDecision.reason})`,
      );
    }

    // The ONE v1/v2 signature difference FLUJO hits (see betaClient.ts): v1 is
    // callTool(params, resultSchema?, options?), the v2-beta SDK dropped the
    // schema parameter — passing options in the v1 slot would silently discard
    // the timeout and progress forwarding.
    // This hook sees finalized business arguments. Authority never enters tool maps
    // or transcript payloads, and every actual dispatch receives fresh metadata.
    const privateMeta = privateExecution
      ? await executionToolRequestMeta(executionExtensionContext!, serverName, toolName, normalizedArgs) : undefined;
    const taskGeneration = taskDecision.negotiation?.generation;
    const augmentation = taskDecision.request ? buildTaskAugmentation(taskDecision.ttlMs, taskGeneration) : {};
    const callerMeta = privateMeta ?? (callerNodeId || ownerScope ? {
      flujo: { ...(callerNodeId ? { callerNodeId } : {}), ...(ownerScope ? { ownerScope } : {}) },
    } : undefined);
    const runContext = getElicitationContext(serverName);
    const dispatchIdentity = taskDecision.request ? await resolveServerIdentity(serverName) : undefined;
    const requestParams = {
      name: toolName,
      arguments: normalizedArgs,
      ...augmentation,
      ...(augmentation._meta || callerMeta ? { _meta: { ...augmentation._meta, ...callerMeta } } : {}),
    };
    await assertMcpIsolationDispatch(client, serverName);
    await assertBundledFlujoWorkloadEffectCurrent();
    const response = taskDecision.request && taskGeneration === '2026-07-28'
      ? await client.request({ method: 'tools/call', params: requestParams }, modernToolResultSchema, callOptions)
      : isBetaClient(client)
      ? await (
          client.callTool as unknown as (
            params: typeof requestParams,
            options?: typeof callOptions,
          ) => ReturnType<Client["callTool"]>
        ).call(client, requestParams, callOptions)
      : await client.callTool(requestParams, undefined, callOptions);

    if (privateExecution) {
      await assertExecutionExtensionCurrent(executionExtensionContext);
      return { success: true, data: validateExecutionToolResult(executionExtensionContext!, toolName, response) };
    }

    // -----------------------------------------------------------------------
    // MCP Tasks extension (io.modelcontextprotocol/tasks)
    // A task-augmented tools/call answers with a legacy { task } or a modern
    // resultType:task handle. The full lifecycle (durable record, polling,
    // input_required, cancellation, terminal mapping) lives in clientTasks.ts;
    // classification is strict, so a normal tool payload that merely contains a
    // `task` key is never reinterpreted as a task handle.
    // -----------------------------------------------------------------------
    const classified = classifyToolCallResult(response, {
      taskRequested: taskDecision.request,
      generation: taskGeneration,
    });

    if (classified.kind === "protocol-invalid") {
      log.warn(
        `Server ${serverName} returned an invalid task result for ${toolName}: ${classified.reason}`,
      );
      return {
        success: false,
        error: `Server '${serverName}' returned an invalid MCP task result: ${classified.reason}`,
        errorType: "task-protocol-invalid",
        statusCode: 502,
        toolName,
      };
    }

    if (classified.kind === "task") {
      // Durable records are part of the gated feature. Resolving the server
      // identity fingerprint is only meaningful (and only worth the config
      // read) when a record is actually going to be persisted.
      const persist = mcpTasksClientEnabled();
      const serverIdentity = persist
        ? dispatchIdentity ?? await resolveServerIdentity(serverName)
        : "unnegotiated";
      const assertCurrent = async () => {
        await assertMcpIsolationDispatch(client, serverName);
        await assertBundledFlujoWorkloadEffectCurrent();
        if (persist) {
          const { mcpService } = await import('@/backend/services/mcp');
          if (serverIdentity === 'unknown' || mcpService.getClient(serverName) !== client ||
              await resolveServerIdentity(serverName) !== serverIdentity) {
            throw new Error('MCP task server connection identity changed');
          }
        }
        if (runContext && getElicitationContext(serverName) !== runContext) {
          throw new Error('MCP task originating run is no longer current');
        }
      };
      const taskResult = await runRemoteTaskLifecycle({
        client,
        serverName,
        serverIdentity,
        toolName,
        args: normalizedArgs,
        task: classified.task,
        generation: taskGeneration,
        assertCurrent,
        handleInputRequest: (request, options) => dispatchTaskInputRequest(client, request, options),
        timeoutMs,
        ...(signal ? { signal } : {}),
        ...(onProgress ? { onProgress } : {}),
        ownership: {
          ...(runContext ? { conversationId: runContext.conversationId } : {}),
          ...(callerNodeId ? { nodeId: callerNodeId } : {}),
          ...(ownerScope ? { ownerScope } : {}),
          source,
        },
        // Without the flag the lifecycle still runs (a server may answer with
        // a task regardless) — it just does not claim durable compliance.
        persist,
        // With no negotiated capability information, cancellation stays
        // best-effort exactly as it was before this change.
        supportsCancel:
          taskDecision.negotiation.supportsCancel ||
          !taskDecision.negotiation.supported,
      });
      return taskResult.data === undefined ? taskResult : {
        ...taskResult,
        data: stampMcpAppOwnerScope(taskResult.data, ownerScope),
      };
    }

    return {
      success: true,
      data: stampMcpAppOwnerScope(response, ownerScope),
    };
  } catch (error) {
    if (error instanceof BundledFlujoWorkloadError) throw error;
    if (error instanceof TrustedHostMcpError) return { success: false, error: error.code,
      errorType: 'mcp-host-consent', statusCode: 403 };
    if (error instanceof McpIsolationError) return { success: false, error: error.code,
      errorType: 'mcp-isolation', statusCode: error.code === 'ISOLATION_UNAVAILABLE' ? 503 : 403 };
    if (trustedHost) return { success: false, error: 'TRUSTED_HOST_TOOL_FAILED', errorType: 'mcp-host-consent', statusCode: 502 };
    if (isolated) return { success: false, error: 'ISOLATED_TOOL_FAILED', errorType: 'mcp-isolation', statusCode: 502 };
    if (executionExtensionContext || isProtectedExecutionServer(serverName)) {
      // SDK exceptions can contain request metadata. Never log or serialize them.
      return { success: false, error: error instanceof ExecutionExtensionError ? error.code : 'execution_tool_unavailable',
        statusCode: error instanceof ExecutionExtensionError ? error.status : 503, errorType: 'execution-call' };
    }
    log.warn(`Failed to call tool ${toolName} on server ${serverName}:`, error);
    let errorMessage = error instanceof Error ? error.message : "Unknown error";
    let statusCode = 500;

    // A caller-driven AbortSignal is an intentional cancellation, not a server
    // or transport failure. Preserve that distinction for MCP App hosts so they
    // can emit ui/notifications/tool-cancelled.
    if (signal?.aborted) {
      return {
        success: false,
        error: `Tool '${toolName}' call was cancelled.`,
        errorType: "cancelled",
        toolName,
      };
    }

    // SDK request timer fired (-32001). The SDK has already sent a
    // notifications/cancelled for the in-flight request as part of its timeout
    // handling, so the server has been told to stop; just map it to the
    // standardized timeout response shape.
    if (error instanceof McpError && error.code === ErrorCode.RequestTimeout) {
      const timeoutSeconds = Math.round(timeoutMs / 1000);
      log.warn(
        `Tool ${toolName} execution timed out after ${timeoutSeconds} seconds`,
      );
      return {
        success: false,
        error: `Tool execution timed out after ${timeoutSeconds} seconds`,
        errorType: "timeout",
        toolName,
        timeout: timeoutSeconds,
        statusCode: 408,
      };
    }

    // A server can report revocation between FLUJO's readiness preflight and
    // actual dispatch. Preserve the namespaced extension error instead of
    // guessing from a tool name or parsing provider-specific text.
    const stdioOAuthRevocation = serverSupportsExternalAuthorization(client)
      ? parseStdioOAuthRevocation(error)
      : undefined;
    if (stdioOAuthRevocation) {
      invalidateExternalAuthorizationStatus(serverName);
      try {
        // The namespaced error invalidates any readiness snapshot. Refresh it
        // immediately as required by the extension, while preserving the
        // original authorization-required result if status itself now fails.
        await getExternalAuthorizationStatus(client, serverName, {
          force: true,
        });
      } catch (statusError) {
        log.warn(
          `Failed to refresh mcp-stdio-oauth status after revocation on ${serverName}:`,
          statusError,
        );
      }
      return {
        success: false,
        error: stdioOAuthRevocation.message
          ? stdioOAuthRevocation.message
          : "External account authorization is required. Open the MCP page to authenticate.",
        errorType: "stdio-oauth-required",
        statusCode: 428,
        requiresAuthentication: true,
      };
    }

    // Check for OAuth-related errors
    if (
      errorMessage.includes("401") ||
      errorMessage.includes("Unauthorized") ||
      errorMessage.includes("invalid_token") ||
      errorMessage.includes("token_expired")
    ) {
      log.info(
        `OAuth authentication error detected for tool ${toolName} on server ${serverName}`,
      );
      return {
        success: false,
        error:
          "OAuth authentication failed or tokens have expired. Please re-authenticate the server.",
        statusCode: 401,
        requiresAuthentication: true,
      };
    }

    // Check for 404 errors which might indicate OAuth issues
    if (errorMessage.includes("404") || errorMessage.includes("Not Found")) {
      log.info(
        `404 error detected for tool ${toolName} on server ${serverName} - may indicate OAuth issues`,
      );
      statusCode = 404;
      errorMessage = `Tool endpoint not found (404). This may indicate OAuth authentication issues or the server may not be properly configured.`;
    }

    if (error instanceof McpError) {
      errorMessage = `Failed to call tool: ${errorMessage} (Code: ${error.code})`;

      // Map MCP error codes to HTTP status codes
      if (error.code === -32601) {
        // Method not found
        statusCode = 404;
      } else if (error.code === -32602) {
        // Invalid params
        statusCode = 400;
      } else if (error.code === -32603) {
        // Internal error
        statusCode = 500;
      }
    } else {
      errorMessage = `Failed to call tool: ${errorMessage}`;
    }

    return {
      success: false,
      error: errorMessage,
      statusCode,
    };
  }
}
