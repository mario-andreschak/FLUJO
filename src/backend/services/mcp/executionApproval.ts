import type { MCPServiceResponse } from '@/shared/types/mcp';
import { McpIsolationError } from '../security/isolatedMcp';
import { TrustedHostMcpError } from '../security/trustedHostMcp';

/** Expected setup failures need an actionable state, not crash logs or retries. */
export function executionApprovalFailure(error: unknown): MCPServiceResponse | undefined {
  if (!(error instanceof TrustedHostMcpError) && !(error instanceof McpIsolationError)) return;
  const message = error instanceof McpIsolationError
    ? error.code === 'ISOLATION_UNAVAILABLE'
      ? 'Isolation is unavailable. Restore the configured Docker runtime and image, then retry.'
      : 'Owner approval required. Review this server’s isolation settings and renew its approval, then retry.'
    : error.code === 'HOST_POLICY_INVALID'
      ? 'Owner approval required. Review this server’s command and execution settings, then retry.'
      : 'Owner approval required. This protected server has no valid approval for its current configuration. Renew its approval, then retry.';
  return { success: false, error: message, errorCode: error.code,
    errorType: 'execution-approval', requiresApproval: true, statusCode: 409 };
}
