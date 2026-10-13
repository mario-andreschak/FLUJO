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
import { readBoundedBody } from '@/utils/http/boundedBody';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

async function POST_handler(request: NextRequest) {
  const notLocal = assertLocalRequest(request);
  if (notLocal) return notLocal;
  const lock = await assertUnlocked({ openai: true });
  if (lock) return lock;
  const parsed: unknown = await readBoundedBody(request, 64 * 1024)
    .then(bytes => JSON.parse(bytes.toString('utf8'))).catch(() => null);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return json({ error: 'Request body must be a JSON object.' }, 400);
  const body = parsed as Record<string, unknown>;
  const action = typeof body.action === 'string' ? body.action : '';

  if (action === 'research') {
    if (typeof body.query !== 'string' || !body.query.trim() || body.query.length > 400
      || typeof body.modelId !== 'string' || (body.modelId.length > 0 && !body.modelId.trim()) || body.modelId.length > 256) {
      return json({ error: 'query and modelId are required.' }, 400);
    }
    return createJsonEventStreamResponse<McpAssistantResearchEvent>(
      async (emit, signal) => {
        const result = await researchMcpServers({
          query: body.query as string,
          modelId: body.modelId as string,
          signal,
          onProgress: emit,
        });
        await emit({ type: 'complete', result });
      },
      () => ({ type: 'error', error: 'MCP server research failed. Please try again.' }),
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
  } catch {
    return json({ error: 'MCP assistant request failed. Please try again.' }, 500);
  }
}

export const POST = withWorkspaceRoute(POST_handler);
