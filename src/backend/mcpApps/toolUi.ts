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
