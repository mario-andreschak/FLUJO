import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createLogger } from '@/utils/logger';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { resolveGlobalVars } from '@/backend/utils/resolveGlobalVars';
import { MCPToolResponse as ToolResponse, MCPServiceResponse, isTaskCallResponse, MCPTaskHandle } from '@/shared/types/mcp';
import { isBetaClient } from './betaClient';
import { sleep } from '@/backend/utils/sleep';
import {
  checkToolCallVisibility,
  filterToolsForAudience,
  ToolCallSource,
  ToolListAudience,
} from './appsProtocol';

const log = createLogger('backend/services/mcp/tools');

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
function normalizeToolArguments(args: Record<string, unknown>, toolName: string): Record<string, unknown> {
  if (!args) return {};
  
  const normalizedArgs: Record<string, unknown> = {};
  
  // Process each argument
  for (const key in args) {
    const value = args[key];
    
    // Handle undefined or null values
    if (value === undefined || value === null) {
      log.debug(`Normalizing undefined/null value for parameter '${key}' in tool '${toolName}'`);
      
      // Try to infer the type from the key name
      if (key.includes('number') || key.endsWith('Count') || key.endsWith('Id') || key.endsWith('Limit')) {
        normalizedArgs[key] = 0;
        log.debug(`Using default value 0 for likely number parameter: ${key}`);
      } else if (key.includes('bool') || key.startsWith('is') || key.startsWith('has') || key.startsWith('should')) {
        normalizedArgs[key] = false;
        log.debug(`Using default value false for likely boolean parameter: ${key}`);
      } else if (key.includes('array') || key.endsWith('s') || key.endsWith('List') || key.endsWith('Items')) {
        normalizedArgs[key] = [];
        log.debug(`Using empty array for likely array parameter: ${key}`);
      } else if (key.includes('object') || key.endsWith('Options') || key.endsWith('Config') || key.endsWith('Settings')) {
        normalizedArgs[key] = {};
        log.debug(`Using empty object for likely object parameter: ${key}`);
      } else {
        // Default to empty string for unknown types
        normalizedArgs[key] = '';
        log.debug(`Using empty string for parameter with unknown type: ${key}`);
      }
    } else {
      // For non-undefined/null values, keep the original value
      normalizedArgs[key] = value;
    }
  }
  
  return normalizedArgs;
}

/**
 * List tools available from an MCP server
 */
export async function listServerTools(
  client: Client | undefined,
  serverName: string,
  audience: ToolListAudience = 'model'
): Promise<{ tools: ToolResponse[], error?: string }> {
  log.debug('Entering listServerTools method');
  if (!client) {
    log.warn(`Server ${serverName} not connected`);
    return { tools: [], error: 'Server not connected' };
  }

  try {
    log.info(`Listing tools for server ${serverName}`);
    const response = await client.listTools();
    log.verbose('Raw response from MCP server:', response);

    const tools = (response.tools || []).map(tool => ({
      name: tool.name,
      description: tool.description || '',
      inputSchema: tool.inputSchema || {},
      // Preserve server-declared annotations and `_meta`. MCP Apps (#97) link a
      // tool to its `ui://` UI resource via `_meta.ui.resourceUri` on the tool
      // DEFINITION (per SEP-1865 / ext-apps), so this must survive listing or
      // the app link is lost before detection can ever see it.
      ...(tool.annotations ? { annotations: tool.annotations } : {}),
      ...(tool._meta ? { _meta: tool._meta } : {}),
    })) as ToolResponse[];

    const visibleTools = filterToolsForAudience(tools, audience);
    log.verbose(`Processed tools for ${audience} audience:`, visibleTools);
    return { tools: visibleTools };
  } catch (error) {
    log.warn(`Failed to list tools for server ${serverName}:`, error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    return {
      tools: [],
      error: errorMessage.includes('Connection timeout')
        ? errorMessage
        : `Failed to list tools: ${errorMessage}`
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
  source: ToolCallSource = 'host'
): Promise<MCPServiceResponse> {
  log.debug('Entering callTool method');
  if (!client) {
    log.warn(`Server ${serverName} not found`);
    return {
      success: false,
      error: `Server ${serverName} not found`,
      statusCode: 404
    };
  }

  const timeoutMs = timeout !== undefined && timeout > 0
    ? Math.min(timeout * 1000, MAX_TIMEOUT_MS)
    : MAX_TIMEOUT_MS;

  try {
    // MCP Apps may call tools only on their own backing server, and only when
    // the server's definition grants the "app" audience. The service passes
    // the exact client belonging to the frame's server; listing and dispatch
    // both happen on that same client object, so authorization cannot be
    // borrowed from another server connection.
    if (source === 'app' || source === 'model') {
      const listed = await listServerTools(client, serverName, 'all');
      if (listed.error) {
        return {
          success: false,
          error: `Could not verify MCP App access to tool '${toolName}' on '${serverName}': ${listed.error}`,
          errorType: 'tool-authorization-list',
          statusCode: 502,
        };
      }

      const access = checkToolCallVisibility(listed.tools, serverName, toolName, source);
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
    log.debug(`Original args for tool ${toolName}:`, args);
    const resolvedArgs = await resolveGlobalVars(args);

    // Ensure resolvedArgs is a record before normalizing
    const argsRecord = (typeof resolvedArgs === 'object' && resolvedArgs !== null)
      ? resolvedArgs as Record<string, unknown>
      : {};

    // Normalize undefined/null values based on parameter types
    // This ensures we don't pass undefined values to MCP servers
    const normalizedArgs = normalizeToolArguments(argsRecord, toolName);
    log.debug(`Normalized args for tool ${toolName}:`, normalizedArgs);

    log.debug(`Calling tool ${toolName} with SDK timeout ${timeoutMs}ms`);
    const callOptions = {
      timeout: timeoutMs,
      resetTimeoutOnProgress: true,
      ...(signal ? { signal } : {}),
      onprogress: (progress: ToolCallProgress) => {
        log.debug(`Progress for tool ${toolName}: ${progress.progress}${progress.total !== undefined ? `/${progress.total}` : ''}${progress.message ? ` — ${progress.message}` : ''}`);
        onProgress?.(progress);
      },
    };
    // The ONE v1/v2 signature difference FLUJO hits (see betaClient.ts): v1 is
    // callTool(params, resultSchema?, options?), the v2-beta SDK dropped the
    // schema parameter — passing options in the v1 slot would silently discard
    // the timeout and progress forwarding.
    const response = isBetaClient(client)
      ? await (client.callTool as unknown as (
          params: { name: string; arguments: Record<string, unknown> },
          options?: typeof callOptions
        ) => ReturnType<Client['callTool']>).call(client, { name: toolName, arguments: normalizedArgs }, callOptions)
      : await client.callTool({ name: toolName, arguments: normalizedArgs }, undefined, callOptions);

    // -----------------------------------------------------------------------
    // MCP Tasks extension (SEP-2663 / spec 2026-07-28)
    // If the server returned a task handle instead of a CallToolResult, enter
    // a poll loop: poll tasks/get until a terminal status, forwarding status
    // updates through the existing onProgress seam. If the caller aborts
    // (user Stop), send tasks/cancel (best-effort) and throw.
    // Only engaged on the v2 beta client path because Tasks require 2026-07-28
    // protocol support; on v1 clients the response will never match the guard.
    // -----------------------------------------------------------------------
    if (isTaskCallResponse(response)) {
      const taskHandle = response.task as MCPTaskHandle;
      log.info(`Tool ${toolName} on ${serverName} returned task handle ${taskHandle.taskId} (status: ${taskHandle.status})`);
      onProgress?.({ progress: 0, message: `Task ${taskHandle.taskId} created (${taskHandle.status})` });

      const POLL_MIN_MS = 1_000;
      const POLL_MAX_MS = 30_000;
      const pollMs = Math.min(
        Math.max(taskHandle.pollInterval ?? 5_000, POLL_MIN_MS),
        POLL_MAX_MS
      );

      const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
      let currentStatus = taskHandle.status;
      let elapsed = 0;
      let terminal = TERMINAL.has(currentStatus);

      // A server may return an already-terminal task. Preserve its actual
      // outcome instead of treating every terminal handle as cancellation.
      if (currentStatus === 'completed') {
        return {
          success: true,
          data: taskHandle.result,
          progressToken: taskHandle.taskId,
        };
      }
      if (currentStatus === 'failed') {
        return {
          success: false,
          error: taskHandle.error ?? `Task ${taskHandle.taskId} failed`,
          progressToken: taskHandle.taskId,
        };
      }

      let cancelTaskPromise: Promise<void> | undefined;
      const cancelTask = (): Promise<void> => {
        if (!cancelTaskPromise) {
          // Never reuse the caller's already-aborted signal: doing so prevents
          // tasks/cancel from reaching the server. This request gets its own
          // short SDK timeout and is deliberately best-effort.
          cancelTaskPromise = (async () => {
            try {
              await (client as unknown as {
                request: (req: unknown, schema: unknown, opts?: unknown) => Promise<unknown>;
              }).request(
                { method: 'tasks/cancel', params: { taskId: taskHandle.taskId } },
                undefined,
                { timeout: 10_000 }
              );
            } catch (cancelError) {
              log.warn(
                `Best-effort cancellation failed for task ${taskHandle.taskId}:`,
                cancelError
              );
            }
          })();
        }
        return cancelTaskPromise;
      };
      const onTaskAbort = () => {
        void cancelTask();
      };
      signal?.addEventListener('abort', onTaskAbort, { once: true });

      try {
        while (!TERMINAL.has(currentStatus)) {
          if (signal?.aborted) {
            await cancelTask();
            throw new Error(`Tool call cancelled (task ${taskHandle.taskId})`);
          }

          await sleep(pollMs);
          elapsed += pollMs;

          if (signal?.aborted) {
            await cancelTask();
            throw new Error(`Tool call cancelled (task ${taskHandle.taskId})`);
          }

          const pollResponse = await (client as unknown as {
            request: (req: unknown, schema: unknown, opts?: unknown) => Promise<unknown>;
          }).request(
            { method: 'tasks/get', params: { taskId: taskHandle.taskId } },
            undefined,
            { signal, timeout: timeoutMs }
          ) as { task: MCPTaskHandle };

          if (signal?.aborted) {
            await cancelTask();
            throw new Error(`Tool call cancelled (task ${taskHandle.taskId})`);
          }

          const task = pollResponse.task;
          currentStatus = task.status;
          terminal = TERMINAL.has(currentStatus);
          log.debug(`Task ${taskHandle.taskId} poll: status=${task.status}, elapsed=${elapsed}ms`);

          onProgress?.({
            progress: task.status === 'completed' ? 100 : Math.min(99, Math.round(elapsed / 1000)),
            message: `Task ${taskHandle.taskId}: ${task.status}`,
          });

          if (task.status === 'completed') {
            return {
              success: true,
              data: task.result,
              progressToken: taskHandle.taskId,
            };
          }
          if (task.status === 'failed') {
            return {
              success: false,
              error: task.error ?? `Task ${taskHandle.taskId} failed`,
              progressToken: taskHandle.taskId,
            };
          }
          // 'input_required': continue polling (tasks/update deferred to Phase 3)
          // 'cancelled': loop will exit on next TERMINAL check
        }

        // Reached terminal 'cancelled' from the server side.
        return {
          success: false,
          error: `Tool '${toolName}' task ${taskHandle.taskId} was cancelled by the server.`,
          errorType: 'cancelled',
          progressToken: taskHandle.taskId,
        };
      } catch (taskError) {
        // An aborted tasks/get and a polling timeout both leave the remote task
        // alive unless we explicitly cancel it with a fresh request.
        if (!terminal) await cancelTask();
        throw taskError;
      } finally {
        signal?.removeEventListener('abort', onTaskAbort);
      }
    }

    return {
      success: true,
      data: response
    };
  } catch (error) {
    log.warn(`Failed to call tool ${toolName} on server ${serverName}:`, error);
    let errorMessage = error instanceof Error ? error.message : 'Unknown error';
    let statusCode = 500;

    // A caller-driven AbortSignal is an intentional cancellation, not a server
    // or transport failure. Preserve that distinction for MCP App hosts so they
    // can emit ui/notifications/tool-cancelled.
    if (signal?.aborted) {
      return {
        success: false,
        error: `Tool '${toolName}' call was cancelled.`,
        errorType: 'cancelled',
        toolName,
      };
    }

    // SDK request timer fired (-32001). The SDK has already sent a
    // notifications/cancelled for the in-flight request as part of its timeout
    // handling, so the server has been told to stop; just map it to the
    // standardized timeout response shape.
    if (error instanceof McpError && error.code === ErrorCode.RequestTimeout) {
      const timeoutSeconds = Math.round(timeoutMs / 1000);
      log.warn(`Tool ${toolName} execution timed out after ${timeoutSeconds} seconds`);
      return {
        success: false,
        error: `Tool execution timed out after ${timeoutSeconds} seconds`,
        errorType: 'timeout',
        toolName,
        timeout: timeoutSeconds,
        statusCode: 408
      };
    }

    // Check for OAuth-related errors
    if (errorMessage.includes('401') || errorMessage.includes('Unauthorized') || 
        errorMessage.includes('invalid_token') || errorMessage.includes('token_expired')) {
      log.info(`OAuth authentication error detected for tool ${toolName} on server ${serverName}`);
      return {
        success: false,
        error: 'OAuth authentication failed or tokens have expired. Please re-authenticate the server.',
        statusCode: 401,
        requiresAuthentication: true
      };
    }

    // Check for 404 errors which might indicate OAuth issues
    if (errorMessage.includes('404') || errorMessage.includes('Not Found')) {
      log.info(`404 error detected for tool ${toolName} on server ${serverName} - may indicate OAuth issues`);
      statusCode = 404;
      errorMessage = `Tool endpoint not found (404). This may indicate OAuth authentication issues or the server may not be properly configured.`;
    }

    if (error instanceof McpError) {
      errorMessage = `Failed to call tool: ${errorMessage} (Code: ${error.code})`;
      
      // Map MCP error codes to HTTP status codes
      if (error.code === -32601) { // Method not found
        statusCode = 404;
      } else if (error.code === -32602) { // Invalid params
        statusCode = 400;
      } else if (error.code === -32603) { // Internal error
        statusCode = 500;
      }
    } else {
      errorMessage = `Failed to call tool: ${errorMessage}`;
    }

    return { 
      success: false, 
      error: errorMessage,
      statusCode
    };
  }
}
