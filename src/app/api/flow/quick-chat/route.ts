import { assertUnlocked } from '@/utils/encryption/lockGate';
import { NextRequest } from 'next/server';
import { createLogger } from '@/utils/logger';
import { buildQuickChatFlow } from '@/backend/services/flow/quickChat';
import { runFlow } from '@/backend/execution/flow/runFlow';
import { json } from '../_helpers';

const log = createLogger('app/api/flow/quick-chat/route');

/**
 * POST /api/flow/quick-chat  (issue #61)
 *
 * Start a "quick chat": chat with ONE model plus zero or more MCP servers / tool
 * subsets, without building and saving a flow. The backend synthesizes an
 * ephemeral flow from the SELECTIONS (never a caller-supplied graph) and runs
 * the first turn; the synthesized flow travels with the conversation state
 * (`flowSnapshot`) and never enters the flows store, so follow-up turns go
 * through the completely unchanged /v1/chat/completions path with the returned
 * conversation id.
 *
 * Body: {
 *   modelId: string,                                  // required
 *   servers?: { name: string, enabledTools?: string[] }[],
 *   systemPrompt?: string,                            // Start-node prompt
 *   prompt?: string | messages?: OpenAI messages[],  // the first user turn
 *   conversationId?: string                           // optional, for resuming
 * }
 * Response: { conversation_id, status, outputText, messages } or { error }.
 */
export async function POST(request: NextRequest) {
  const _lock = await assertUnlocked();
  if (_lock) return _lock;

  try {
    const body = (await request.json().catch(() => null)) as {
      modelId?: string;
      servers?: Array<{ name?: string; enabledTools?: string[] }>;
      systemPrompt?: string;
      prompt?: string;
      messages?: any[];
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

    const messages =
      Array.isArray(body.messages) && body.messages.length > 0
        ? body.messages
        : body.prompt !== undefined
          ? [{ role: 'user', content: body.prompt }]
          : [];

    const result = await runFlow({
      flowDefinition: built.flow,
      messages,
      mode: 'conversation',
      conversationId,
      flujo: true,
      userTurn: true,
    });

    if (result.status === 'error') {
      const message = result.error?.message ?? 'Quick chat failed';
      log.warn(`Quick chat run errored for ${conversationId}: ${message}`);
      return json({ error: message, conversation_id: conversationId }, result.error?.statusCode ?? 500);
    }

    return json({
      conversation_id: result.conversationId,
      status: result.sharedState.status ?? 'completed',
      outputText: result.outputText,
      messages: result.messages,
    });
  } catch (error) {
    log.error('Error handling POST /api/flow/quick-chat', error);
    return json({ error: 'Internal server error' }, 500);
  }
}
