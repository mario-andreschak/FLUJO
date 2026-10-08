import { withWorkspaceRoute } from '@/app/api/_workspace';
import { NextRequest } from 'next/server';
import { createJsonEventStreamResponse } from '@/backend/utils/jsonEventStream';
import {
  installAssistedMcpServer,
  researchMcpServers,
  troubleshootMcpInstall,
} from '@/backend/services/mcp/assistedInstall';
import type {
  McpAssistantInstallInput,
  McpAssistantResearchEvent,
  McpTroubleshootContext,
} from '@/shared/types/mcp/assistant';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { assertLocalRequest } from '@/utils/http/localRequest';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

async function POST_handler(request: NextRequest) {
  const notLocal = assertLocalRequest(request);
  if (notLocal) return notLocal;
  const lock = await assertUnlocked({ openai: true });
  if (lock) return lock;
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return json({ error: 'Request body must be a JSON object.' }, 400);
  const action = typeof body.action === 'string' ? body.action : '';

  if (action === 'research') {
    if (typeof body.query !== 'string' || !body.query.trim() || typeof body.modelId !== 'string' || !body.modelId) {
      return json({ error: 'query and modelId are required.' }, 400);
    }
    return createJsonEventStreamResponse<McpAssistantResearchEvent>(
      async (emit) => {
        const result = await researchMcpServers({
          query: body.query as string,
          modelId: body.modelId as string,
          onProgress: emit,
        });
        await emit({ type: 'complete', result });
      },
      (error) => ({ type: 'error', error }),
      { signal: request.signal },
    );
  }

  try {
    if (action === 'install') {
      const install = body.install as McpAssistantInstallInput | undefined;
      if (!install || typeof install !== 'object') return json({ error: 'install is required.' }, 400);
      return json(await installAssistedMcpServer(install));
    }
    if (action === 'troubleshoot') {
      const context = body.context as McpTroubleshootContext | undefined;
      if (!context || typeof context !== 'object') return json({ error: 'context is required.' }, 400);
      return json(await troubleshootMcpInstall(context));
    }
    return json({ error: 'Unknown MCP assistant action.' }, 400);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
}

export const POST = withWorkspaceRoute(POST_handler);
