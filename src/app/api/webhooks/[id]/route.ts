import { assertUnlocked } from '@/utils/encryption/lockGate';
import { NextRequest } from 'next/server';
import { createHash, timingSafeEqual } from 'crypto';
// eslint-disable-next-line import/named
import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '@/utils/logger';
import { getSchedulerService } from '@/backend/services/scheduler';
import { ensureBackendInitialized } from '@/backend/init';
import { isLocalRequest } from '@/backend/services/mcp/proxyForward';

const log = createLogger('app/api/webhooks/[id]/route');

/** Reject bodies larger than this (webhook payloads should be small events). */
const MAX_BODY_BYTES = 256 * 1024;

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

/** Constant-time token comparison (hash both sides to equalize length). */
function tokenMatches(provided: string, expected: string): boolean {
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(provided), digest(expected));
}

/**
 * POST /api/webhooks/{id}
 * Inbound webhook trigger for a planned execution. Auth: per-execution secret
 * token via the `X-Flujo-Token` header or `?token=`. Localhost-only unless
 * the trigger opts into external callers.
 *
 * Responds `202 { runId }` immediately and runs the flow in the background —
 * callers that need the flow's answer synchronously should use the
 * OpenAI-compatible endpoint (/v1/chat/completions) instead.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const _lock = await assertUnlocked();
  if (_lock) return _lock;

  try {
    const { id } = await params;
    await ensureBackendInitialized().catch(() => { /* surfaced at startup */ });
    const scheduler = getSchedulerService();

    const execution = await scheduler.get(id);
    // Unknown id and non-webhook executions are indistinguishable (404), so
    // the endpoint doesn't leak which ids exist.
    if (!execution || execution.trigger.type !== 'webhook') {
      return json({ error: 'Not found' }, 404);
    }
    const trigger = execution.trigger;

    if (!trigger.allowExternal) {
      const local = isLocalRequest(
        request.headers.get('host'),
        request.headers.get('origin')
      );
      if (!local) {
        return json({ error: 'External callers are not allowed for this webhook' }, 403);
      }
    }

    const provided =
      request.headers.get('x-flujo-token') ??
      new URL(request.url).searchParams.get('token') ??
      '';
    if (!provided || !tokenMatches(provided, trigger.token)) {
      return json({ error: 'Invalid or missing token' }, 401);
    }

    if (!execution.enabled) {
      return json({ error: 'This planned execution is turned off' }, 409);
    }
    if (await scheduler.isPaused()) {
      return json({ error: 'Planned executions are paused' }, 409);
    }

    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) {
      return json({ error: 'Payload too large' }, 413);
    }
    let body: unknown = raw;
    const contentType = request.headers.get('content-type') ?? '';
    if (raw && contentType.includes('application/json')) {
      try {
        body = JSON.parse(raw);
      } catch {
        return json({ error: 'Body is not valid JSON' }, 400);
      }
    }

    const runId = uuidv4();
    // Overlap policy (issue #121): with overlapStrategy 'error', a fire that
    // arrives while a previous run is still in flight is rejected. Surface that
    // to the caller as 409 Conflict (best-effort: the in-flight check races the
    // background fire, but fire() records the authoritative 'error' run either
    // way). Every other strategy resolves inside fire() and returns 202.
    const overlapRejected =
      (execution.overlapStrategy ?? 'skip') === 'error' &&
      scheduler.isRunning(execution.id);
    // Exclusive mode (issue #171): if an exclusive execution holds the
    // scheduler-global lock and its nonExclusiveBehavior is 'error', this
    // non-exclusive webhook fire is rejected. Surface it as 423 Locked — the
    // scheduler is locked by an exclusive execution — distinct from the 409 used
    // for the same-execution overlap 'error' case above.
    const exclusiveGate = scheduler.exclusiveGateFor(execution);
    // Fire-and-forget: the record lands in run history; fire() never throws.
    void scheduler.fire(
      execution,
      {
        kind: 'webhook',
        summary: 'Webhook',
        context: { body, contentType: contentType || undefined, receivedAt: new Date().toISOString() },
      },
      runId
    );
    if (exclusiveGate === 'error') {
      return json({ error: 'The scheduler is locked by an exclusive execution', runId }, 423);
    }
    if (overlapRejected) {
      return json({ error: 'A previous run is still in progress', runId }, 409);
    }
    return json({ accepted: true, runId }, 202);
  } catch (error) {
    log.error('Error handling webhook request', error);
    return json({ error: 'Internal server error' }, 500);
  }
}
