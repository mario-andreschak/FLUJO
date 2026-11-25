import { NextRequest, NextResponse } from 'next/server';

import { withWorkspaceRoute } from '@/app/api/_workspace';
import { previewManualCompaction } from '@/backend/execution/flow/compaction/manualRequest';
import { buildContextInfo } from '@/backend/execution/flow/conversationContextInfo';
import { isConversationExecutionLocked, withConversationExecutionLock } from '@/backend/execution/flow/conversationExecutionLock';
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import { resolveEffectiveCompaction } from '@/backend/execution/flow/handlers/resolveEffectiveCompaction';
import { isPersonaOwnedConversationState } from '@/backend/execution/flow/personaConversationOwnership';
import type { SharedState } from '@/backend/execution/flow/types';
import { isExecutionProtectedState } from '@/backend/execution/extensions';
import type { ManualCompactionResponse } from '@/shared/types/contextCompaction';
import { StorageKey, type Settings } from '@/shared/types/storage/storage';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { assertLocalRequest } from '@/utils/http/localRequest';
import { createLogger } from '@/utils/logger';
import { loadItem, saveItem } from '@/utils/storage/backend';

const log = createLogger('app/v1/chat/conversations/[conversationId]/compact/route');

type Refusal = { error: string; reason: 'persona_owned' | 'read_only' | 'protected' };

function refusal(state: SharedState): Refusal | null {
  if (state.personaArchived) return { error: 'This conversation is read-only.', reason: 'read_only' };
  if (isPersonaOwnedConversationState(state)) {
    return { error: 'A Persona manages the memory of its own conversations.', reason: 'persona_owned' };
  }
  if (isExecutionProtectedState(state)) {
    return { error: 'This conversation is managed by its owner.', reason: 'protected' };
  }
  return null;
}

async function effectiveCompaction(state: SharedState) {
  const [settings, contextInfo] = await Promise.all([
    loadItem<Settings | undefined>(StorageKey.SPEECH_SETTINGS, undefined).catch(() => undefined),
    buildContextInfo(state).catch(() => undefined),
  ]);
  const contextWindow = contextInfo?.contextWindow;
  return {
    ...resolveEffectiveCompaction(undefined, { contextWindow }, settings?.experimental),
    contextWindow,
  };
}

/**
 * "/compact" from the chat composer (#1225). FLUJO never rewrites the saved
 * chat: this records the person's request, which the next model call honours
 * by sending a summary of older messages instead of the full history. The
 * answer previews what will be summarized and what stays word for word.
 */
async function POST_handler(
  request: NextRequest,
  { params }: { params: Promise<{ conversationId: string }> },
) {
  const locked = await assertUnlocked({ openai: true });
  if (locked) return locked;
  const notLocal = assertLocalRequest(request);
  if (notLocal) return notLocal;

  const { conversationId } = await params;
  if (!conversationId || !/^[A-Za-z0-9_-]{1,64}$/.test(conversationId)) {
    return NextResponse.json({ error: 'Invalid conversationId' }, { status: 400 });
  }

  const requestedAt = Date.now();
  const respond = async (state: SharedState, running: boolean, apply: () => Promise<void>) => {
    const denied = refusal(state);
    if (denied) return NextResponse.json(denied, { status: 409 });
    const eff = await effectiveCompaction(state);
    const preview = previewManualCompaction(state.messages ?? [], eff.keepTokens, eff.contextWindow);
    if (!eff.enabled) {
      return NextResponse.json({ status: 'disabled', preview } satisfies ManualCompactionResponse);
    }
    await apply();
    log.info('Recorded a manual compaction request', { conversationId, running });
    return NextResponse.json({ status: 'requested', running, preview } satisfies ManualCompactionResponse);
  };

  // A run holds the conversation lease until it ends. Its next model call
  // reads the live state, which the run itself saves at its next boundary.
  const live = FlowExecutor.conversationStates.get(conversationId);
  if (live && isConversationExecutionLocked(conversationId)) {
    return respond(live, true, async () => {
      live.compactionRequest = { requestedAt };
    });
  }

  return withConversationExecutionLock(conversationId, async () => {
    const storageKey = `conversations/${conversationId}` as StorageKey;
    const saved = await loadItem<SharedState | undefined>(storageKey, undefined);
    if (!saved) return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
    const cached = FlowExecutor.conversationStates.get(conversationId);
    return respond(cached ?? saved, false, async () => {
      await saveItem(storageKey, { ...saved, compactionRequest: { requestedAt } });
      if (cached) cached.compactionRequest = { requestedAt };
    });
  });
}

export const POST = withWorkspaceRoute(POST_handler);
