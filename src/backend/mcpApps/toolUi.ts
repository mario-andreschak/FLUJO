import { mcpService } from '@/backend/services/mcp';
import {
  extractUiResourceUri,
  isUiResourceUri,
} from '@/shared/utils/mcpApps';
import { createLogger } from '@/utils/logger';

const log = createLogger('backend/mcpApps/toolUi');

export interface McpAppToolUiLink {
  uri: string;
  serverName: string;
  toolName: string;
  /**
   * JSON arguments delivered to the View when they differ from the visible
   * outer tool call (for example FLUJO's call_mcp_tool forwarding envelope).
   */
  toolArgs?: string;
}

const FLUJO_CONTROL_PACKAGE_ID = '@mario.andreschak/mcp-flujo';
const CALL_MCP_TOOL = 'call_mcp_tool';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function forwardedMcpCall(args: unknown): {
  serverName: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
} | undefined {
  if (!isRecord(args)) return undefined;
  const serverName = typeof args.server === 'string' ? args.server.trim() : '';
  const toolName = typeof args.tool === 'string' ? args.tool.trim() : '';
  if (!serverName || !toolName) return undefined;
  return {
    serverName,
    toolName,
    toolArgs: isRecord(args.args) ? args.args : {},
  };
}

/**
 * Identify the shipped FLUJO control-plane package by install provenance, not
 * by its user-editable server name. An arbitrary MCP server named "flujo" (or
 * exposing a tool named call_mcp_tool) must not be allowed to select another
 * server's App resource.
 */
async function isFlujoControlServer(serverName: string): Promise<boolean> {
  try {
    const configs = await mcpService.loadServerConfigs();
    if (!Array.isArray(configs)) return false;
    const config = configs.find((candidate) => candidate.name === serverName);
    return config?.source?.type === 'marketplace'
      && config.source.id === FLUJO_CONTROL_PACKAGE_ID;
  } catch (error) {
    log.warn(`Failed to verify FLUJO control server provenance for ${serverName}`, error);
    return false;
  }
}

/**
 * Resolve the UI linked by the tool definition advertised to the model.
 *
 * A call result may repeat that URI in `_meta`, but it is never an authority:
 * result-only links are ignored and a different result URI cannot redirect the
 * host to a resource that was not declared before execution.
 */
export async function resolveAdvertisedToolUiLink(
  serverName: string,
  toolName: string,
  advertisedUri: string | undefined,
  resultData?: unknown,
): Promise<McpAppToolUiLink | undefined> {
  if (!isUiResourceUri(advertisedUri)) return undefined;

  const resultUri = extractUiResourceUri(
    (resultData as { _meta?: unknown } | null | undefined)?._meta,
  );
  if (resultUri && resultUri !== advertisedUri) {
    log.warn(
      `Ignoring MCP App result URI redirect for ${serverName}/${toolName}: ${resultUri}`,
    );
  }

  const link = { uri: advertisedUri, serverName, toolName };

  try {
    return await mcpService.isMcpAppAccessEnabled(serverName)
      ? link
      : undefined;
  } catch (error) {
    log.warn(
      `resolveAdvertisedToolUiLink: failed to check MCP Apps opt-in for ${serverName}`,
      error,
    );
    return undefined;
  }
}

/**
 * Resolve the App owned by the tool that actually ran.
 *
 * Most invocations are direct and use the definition URI already carried in
 * the tool identity map. FLUJO's trusted `call_mcp_tool` control-plane tool is
 * a forwarding envelope, though: its result is the downstream CallToolResult,
 * while the visible invocation identity still points at the wrapper. For that
 * one provenance-verified wrapper, re-read the downstream model-visible tool
 * definition and attach its App identity to the transcript.
 *
 * Result metadata remains non-authoritative. A downstream result cannot create
 * or redirect an App link; the URI must still come from tools/list and the
 * downstream server's `enableMcpApps` opt-in is still checked by
 * `resolveAdvertisedToolUiLink`.
 */
export async function resolveInvokedToolUiLink(
  serverName: string,
  toolName: string,
  advertisedUri: string | undefined,
  resultData?: unknown,
  invocationArgs?: Record<string, unknown>,
): Promise<McpAppToolUiLink | undefined> {
  if (isUiResourceUri(advertisedUri)) {
    return resolveAdvertisedToolUiLink(serverName, toolName, advertisedUri, resultData);
  }

  const forwarded = toolName === CALL_MCP_TOOL
    ? forwardedMcpCall(invocationArgs)
    : undefined;
  if (!forwarded || !(await isFlujoControlServer(serverName))) return undefined;

  try {
    // Match the audience used by call_mcp_tool itself. This prevents an
    // app-only or otherwise hidden definition from becoming model-authorized
    // merely because the wrapper knew its name.
    const { tools } = await mcpService.listServerTools(forwarded.serverName, 'model');
    const definition = Array.isArray(tools)
      ? tools.find((candidate) => candidate.name === forwarded.toolName)
      : undefined;
    const uri = extractUiResourceUri(
      (definition as { _meta?: unknown } | undefined)?._meta,
    );
    const link = await resolveAdvertisedToolUiLink(
      forwarded.serverName,
      forwarded.toolName,
      uri,
      resultData,
    );
    return link
      ? { ...link, toolArgs: JSON.stringify(forwarded.toolArgs) }
      : undefined;
  } catch (error) {
    log.warn(
      `Failed to resolve forwarded MCP App for ${forwarded.serverName}/${forwarded.toolName}`,
      error,
    );
    return undefined;
  }
}

/** Cancellation metadata required by the MCP Apps lifecycle. */
export function toolCancellationReason(
  result: { success: boolean; error?: string; errorType?: string },
): string | undefined {
  if (
    result.success
    || (result.errorType !== 'cancelled' && result.errorType !== 'timeout')
  ) {
    return undefined;
  }
  return result.error
    ?? (result.errorType === 'timeout'
      ? 'Tool execution timed out.'
      : 'Tool call was cancelled.');
}
