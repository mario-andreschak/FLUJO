import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  ElicitRequestSchema,
  ElicitResult,
  McpError,
  ErrorCode,
} from '@modelcontextprotocol/sdk/types.js';
import { createLogger } from '@/utils/logger';
import { MCPServerConfig, MCPElicitationPolicy } from '@/shared/types/mcp';
import { executionEventBus } from '@/backend/execution/flow/engine/ExecutionEventBus';
import { getElicitationContext } from './elicitationContext';
import { registerPendingElicitation } from './elicitationRegistry';

const log = createLogger('backend/services/mcp/elicitation');

function policyOf(config: MCPServerConfig): MCPElicitationPolicy | undefined {
  return (config as { elicitation?: MCPElicitationPolicy }).elicitation;
}

/** Elicitation is active only when the server has explicitly opted in. */
export function elicitationEnabled(config: MCPServerConfig): boolean {
  const p = policyOf(config);
  return !!(p?.enabled);
}

/**
 * Stable key of the elicitation policy, concatenated with the sampling key in
 * capabilityKey() so toggling elicitation forces a client rebuild.
 */
export function elicitationConfigKey(config: MCPServerConfig): string {
  const p = policyOf(config);
  return p?.enabled ? 'e:1' : '';
}

/**
 * Register the `elicitation/create` handler on a v1 SDK client.
 * Only call this when elicitationEnabled(config) is true — the handler
 * requires the client to have declared the elicitation capability.
 */
export function registerElicitationHandler(client: Client, config: MCPServerConfig): void {
  client.setRequestHandler(ElicitRequestSchema, createElicitationHandler(config));
}

/**
 * The `elicitation/create` handler body, shared by the v1 registration above
 * and the v2-beta client (betaClient.ts uses string method name).
 *
 * Flow:
 * 1. Check elicitation is enabled (guard against stale handlers).
 * 2. Look up the active run context for this server (conversationId + unattended flag).
 * 3. If unattended → immediately return { action: 'cancel' }.
 * 4. For URL-mode requests → also cancel (V1 only supports form mode).
 * 5. Emit `run:awaiting_elicitation` SSE event to the frontend.
 * 6. Await a promise registered in elicitationRegistry (with 5-min timeout).
 * 7. Return the user's ElicitResult to the server.
 */
export function createElicitationHandler(
  config: MCPServerConfig
): (request: { params?: unknown }) => Promise<ElicitResult> {
  return async (request): Promise<ElicitResult> => {
    if (!elicitationEnabled(config)) {
      throw new McpError(ErrorCode.MethodNotFound, 'Elicitation is not enabled for this server');
    }

    const ctx = getElicitationContext(config.name);
    if (!ctx) {
      // No active run context means we're outside a flow run (e.g. a test
      // call from the server settings). Auto-cancel to avoid hanging.
      log.warn(`Elicitation request from ${config.name} outside an active run; auto-cancelling`);
      return { action: 'cancel' };
    }

    if (ctx.getUnattended()) {
      log.warn(`Elicitation request from ${config.name} in unattended run ${ctx.conversationId}; auto-cancelling`);
      return { action: 'cancel' };
    }

    const params = request.params as {
      mode?: string;
      message?: string;
      requestedSchema?: Record<string, unknown>;
      elicitationId?: string;
      url?: string;
    } | undefined;

    // V1: URL mode is not supported — cancel cleanly so the server can handle it.
    if (params?.mode === 'url') {
      log.warn(`Elicitation URL mode is not supported in V1 (server: ${config.name}); auto-cancelling`);
      return { action: 'cancel' };
    }

    const message = params?.message ?? 'Additional information required';
    const requestedSchema = (params?.requestedSchema ?? { type: 'object', properties: {} }) as Record<string, unknown>;

    const elicitationId = crypto.randomUUID();
    log.info(`Suspending for elicitation ${elicitationId} from ${config.name} in conv ${ctx.conversationId}`);

    // Emit SSE event to the frontend.
    const emit = executionEventBus.emitterFor(ctx.conversationId);
    emit({
      type: 'run:awaiting_elicitation',
      elicitationId,
      message,
      requestedSchema,
    });

    // Await the user's response (or a 5-minute timeout).
    const result = await registerPendingElicitation(elicitationId);
    log.info(`Elicitation ${elicitationId} resolved with action=${result.action}`);
    return result;
  };
}
