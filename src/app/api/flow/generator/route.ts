import { withWorkspaceRoute } from '@/app/api/_workspace';
import { NextRequest } from 'next/server';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { json } from '../_helpers';
import { FlowAuthoringValidationError } from '@/backend/services/flow/authoringErrors';
import {
  buildFlowGeneratorSnapshot,
  restoreVendoredFlowGenerator,
} from '@/backend/services/flow/systemFlows';
import { gatherGenerationContext } from '@/backend/services/flow/generationContext';
import { isQuickChatEnabled, QUICK_CHAT_DISABLED_CODE, QUICK_CHAT_DISABLED_MESSAGE } from '@/backend/services/workspace/modelAccess';

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
    if (!(await isQuickChatEnabled())) {
      return json({ error: QUICK_CHAT_DISABLED_MESSAGE, code: QUICK_CHAT_DISABLED_CODE }, 403);
    }
    const context = await gatherGenerationContext();
    if (!(context.compile.models ?? []).some((model) => model.id === modelId)) {
      return json({ error: `Unknown generator model "${modelId}"` }, 400);
    }
    const flow = await buildFlowGeneratorSnapshot(conversationId, modelId, {
      allowInstall: body?.allowInstall === true,
    });
    return json({ conversationId, flow });
  } catch (error) {
    if (error instanceof FlowAuthoringValidationError) return json({ error: error.message }, 422);
    return json({ error: 'Failed to prepare flow generator.' }, 500);
  }
}

/** Explicit restore action; startup never overwrites user edits. */
async function PUT_handler(_request: Request) {
  const locked = await assertUnlocked({ openai: true });
  if (locked) return locked;
  try {
    return json({ flow: await restoreVendoredFlowGenerator() });
  } catch (error) {
    return json({ error: 'Failed to restore flow generator.' }, 500);
  }
}

export const POST = withWorkspaceRoute(POST_handler);
const PUT_workspaceRoute = withWorkspaceRoute(PUT_handler);
export function PUT(): ReturnType<typeof PUT_workspaceRoute>;
export function PUT(request: Request): ReturnType<typeof PUT_workspaceRoute>;
export function PUT(request: Request = new Request('http://localhost/')) {
  return PUT_workspaceRoute(request);
}
