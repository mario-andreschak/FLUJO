import { withWorkspaceRoute } from '@/app/api/_workspace';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { NextRequest } from 'next/server';
import { createLogger } from '@/utils/logger';
import { getSchedulerService } from '@/backend/services/scheduler';
import { receiveMcpEvent } from '@/backend/services/scheduler/mcpEventDelivery';
import { loadExecutionState, updateExecutionState } from '@/backend/services/scheduler/state';
import { ensureBackendInitialized } from '@/backend/init';
import { isLocalRequest } from '@/backend/services/mcp/proxyForward';

const log = createLogger('app/api/webhooks/mcp/[id]/route');

/**
 * POST /api/webhooks/mcp/{id}
 * Signed event from an MCP server, for an automation with the `mcp-event` trigger.
 * The URL is handed to the server by FLUJO itself. This computer only.
 */
async function POST_handler(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const locked = await assertUnlocked();
  if (locked) return locked;
  if (!isLocalRequest(request.headers.get('host'), request.headers.get('origin'))) {
    return Response.json({ error: 'This endpoint only accepts calls from this computer' }, { status: 403 });
  }
  try {
    const { id } = await params;
    await ensureBackendInitialized().catch(() => { /* surfaced at startup */ });
    const result = await receiveMcpEvent({
      scheduler: getSchedulerService(),
      loadState: loadExecutionState,
      updateState: (executionId, update) => updateExecutionState(executionId, update),
      onBackgroundError: (message, error) => log.warn(`${message} for ${id}:`, error),
    }, {
      id,
      fingerprint: new URL(request.url).searchParams.get('v'),
      webhookId: request.headers.get('webhook-id'),
      webhookTimestamp: request.headers.get('webhook-timestamp'),
      webhookSignature: request.headers.get('webhook-signature'),
      body: await request.text(),
    });
    return Response.json(result.body, {
      status: result.status,
      ...(result.retryAfterSeconds ? { headers: { 'Retry-After': String(result.retryAfterSeconds) } } : {}),
    });
  } catch (error) {
    log.error('Error handling MCP event', error);
    return Response.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export const POST = withWorkspaceRoute(POST_handler);
