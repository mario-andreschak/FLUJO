import { withWorkspaceRoute } from '@/app/api/_workspace';
import { NextRequest } from 'next/server';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { json } from '../_helpers';
import {
  buildFlowGeneratorSnapshot,
  restoreVendoredFlowGenerator,
} from '@/backend/services/flow/systemFlows';
import { gatherGenerationContext } from '@/backend/services/flow/generationContext';

/** Create a conversation-scoped snapshot of the latest editable generator. */
async function POST_handler(request: NextRequest) {
  const locked = await assertUnlocked({ openai: true });
  if (locked) return locked;
  const body = await request.json().catch(() => null) as {
    conversationId?: unknown;
    modelId?: unknown;
    allowInstall?: unknown;
  } | null;
  const conversationId =
    typeof body?.conversationId === 'string' ? body.conversationId.trim() : '';
  const modelId = typeof body?.modelId === 'string' ? body.modelId.trim() : '';
  if (!conversationId || !modelId) {
    return json({ error: 'conversationId and modelId are required' }, 400);
  }
  try {
    const context = await gatherGenerationContext();
    if (!(context.compile.models ?? []).some((model) => model.id === modelId)) {
      return json({ error: `Unknown generator model "${modelId}"` }, 400);
    }
    const flow = await buildFlowGeneratorSnapshot(conversationId, modelId, {
      allowInstall: body?.allowInstall === true,
    });
    return json({ conversationId, flow });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, 422);
  }
}

/** Explicit restore action; startup never overwrites user edits. */
async function PUT_handler(_request: Request) {
  const locked = await assertUnlocked({ openai: true });
  if (locked) return locked;
  try {
    return json({ flow: await restoreVendoredFlowGenerator() });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
}

export const POST = withWorkspaceRoute(POST_handler);
const PUT_workspaceRoute = withWorkspaceRoute(PUT_handler);
export function PUT(): ReturnType<typeof PUT_workspaceRoute>;
export function PUT(request: Request): ReturnType<typeof PUT_workspaceRoute>;
export function PUT(request: Request = new Request('http://localhost/')) {
  return PUT_workspaceRoute(request);
}
