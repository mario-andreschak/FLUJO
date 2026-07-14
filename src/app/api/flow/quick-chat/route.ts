import { assertUnlocked } from '@/utils/encryption/lockGate';
import { NextRequest } from 'next/server';
import { createLogger } from '@/utils/logger';
import { buildQuickChatFlow } from '@/backend/services/flow/quickChat';
import { json } from '../_helpers';

const log = createLogger('app/api/flow/quick-chat/route');

/**
 * POST /api/flow/quick-chat  (issue #61)
 *
 * Synthesize (but do NOT run or save) an ephemeral quick-chat flow from
 * SELECTIONS: ONE model plus zero or more MCP servers / tool subsets. The
 * backend builds the graph itself — it never accepts a caller-supplied node
 * graph. Unknown model/server ids are rejected and requested tools are
 * intersected with what each server exposes.
 *
 * The returned flow carries the namespaced id `quickchat-<conversationId>`; the
 * caller then creates a conversation whose `flowSnapshot` is this flow (POST
 * /v1/chat/conversations with `flowSnapshot`), after which every turn — the
 * first included — runs through the unchanged streaming chat path, resolving
 * the flow from the snapshot on the conversation state.
 *
 * Body: {
 *   modelId: string,                                       // required
 *   servers?: { name: string, enabledTools?: string[] }[],
 *   systemPrompt?: string,
 *   conversationId?: string                                // namespaces the flow id
 * }
 * Response: { conversationId, flow } or { error }.
 */
export async function POST(request: NextRequest) {
  const _lock = await assertUnlocked();
  if (_lock) return _lock;

  try {
    const body = (await request.json().catch(() => null)) as {
      modelId?: string;
      servers?: Array<{ name?: string; enabledTools?: string[] }>;
      systemPrompt?: string;
      conversationId?: string;
    } | null;

    if (!body || typeof body !== 'object') {
      return json({ error: 'Request body must be a JSON object' }, 400);
    }
    if (!body.modelId || typeof body.modelId !== 'string') {
      return json({ error: 'A "modelId" is required' }, 400);
    }

    const conversationId = body.conversationId || crypto.randomUUID();

    const built = await buildQuickChatFlow({
      conversationId,
      modelId: body.modelId,
      servers: (body.servers ?? [])
        .filter((s): s is { name: string; enabledTools?: string[] } => typeof s?.name === 'string')
        .map((s) => ({ name: s.name, enabledTools: s.enabledTools })),
      systemPrompt: body.systemPrompt,
    });

    if (!built.success) {
      return json({ error: built.error }, built.statusCode);
    }

    log.info(`Synthesized quick-chat flow for conversation ${conversationId}`);
    return json({ conversationId, flow: built.flow });
  } catch (error) {
    log.error('Error handling POST /api/flow/quick-chat', error);
    return json({ error: 'Internal server error' }, 500);
  }
}
