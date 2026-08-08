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
import { captureExternalAuthorizationElicitation } from './externalAuthorization';
import { relatedTaskIdOf } from '@/shared/types/mcp/tasks';
import {
  noteTaskInputRequested,
  noteTaskInputResolved,
} from './taskInputRegistry';

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
 * The URL handler is always registered for the negotiated mcp-stdio-oauth
 * extension. Form requests remain guarded by the server's explicit policy.
 */
export function registerElicitationHandler(client: Client, config: MCPServerConfig): void {
  client.setRequestHandler(ElicitRequestSchema, createElicitationHandler(config));
}

/**
 * The `elicitation/create` handler body, shared by the v1 registration above
 * and the v2-beta client (betaClient.ts uses string method name).
 *
 * Flow:
 * URL mode is accepted only while an explicit mcp-stdio-oauth start
 * request is pending; otherwise it is cancelled. Form mode follows the
 * existing per-server trust policy and active-run context.
 */
export function createElicitationHandler(
  config: MCPServerConfig
): (request: { params?: unknown }) => Promise<ElicitResult> {
  return async (request): Promise<ElicitResult> => {
    const params = request.params as {
      mode?: string;
      message?: string;
      requestedSchema?: Record<string, unknown>;
      elicitationId?: string;
      url?: string;
      _meta?: Record<string, unknown>;
    } | undefined;

    // MCP Tasks (#404): a server asks for the input a task is waiting on by
    // relating an ordinary elicitation to the task via
    // `_meta["io.modelcontextprotocol/related-task"]`. Answering it IS the task
    // update (the resolved spec/SDK has no `tasks/update`), so the two channels
    // are correlated here for the client task poll loop. Only ids are recorded —
    // never the prompt, schema or the user's answer.
    const relatedTaskId = relatedTaskIdOf(params?._meta);

    const externalAuthorizationResult =
      await captureExternalAuthorizationElicitation(config.name, params ?? {});
    if (externalAuthorizationResult) return externalAuthorizationResult;

    if (!elicitationEnabled(config)) {
      throw new McpError(ErrorCode.MethodNotFound, 'Elicitation is not enabled for this server');
    }

    const ctx = getElicitationContext(config.name);
    if (!ctx && relatedTaskId) {
      log.warn(
        `Task ${relatedTaskId} on ${config.name} requested input outside an attended run; auto-cancelling`
      );
    }
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

    const message = params?.message ?? 'Additional information required';
    const requestedSchema = (params?.requestedSchema ?? { type: 'object', properties: {} }) as Record<string, unknown>;

    const elicitationId = crypto.randomUUID();
    log.info(`Suspending for elicitation ${elicitationId} from ${config.name} in conv ${ctx.conversationId}`);
    if (relatedTaskId) {
      noteTaskInputRequested(config.name, relatedTaskId, elicitationId);
    }

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
    if (relatedTaskId) {
      // Idempotent: a duplicate submission for the same id is ignored.
      noteTaskInputResolved(config.name, relatedTaskId, elicitationId, result.action);
    }
    return result;
  };
}
