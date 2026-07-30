import crypto from 'crypto';
import path from 'path';
import { NextRequest, NextResponse } from 'next/server';
import { FEATURES } from '@/config/features';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { assertLocalRequest } from '@/utils/http/localRequest';
import { readConversationLog, projectMessages } from '@/backend/execution/flow/conversationLog';
import { loadConversationState } from '@/backend/execution/flow/loadConversationState';
import { persistConversationState } from '@/backend/execution/flow/persistConversationState';
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import { shadowRepoService } from '@/backend/services/snapshot/ShadowRepoService';
import { StorageKey } from '@/shared/types/storage';
import type { NodeChangedFilesEvent } from '@/shared/types/execution/events';

const MAX_DIFF_CHARS = 120_000;
const SAFE_PATH = /^(?![A-Za-z]:)(?![\\/])(?!.*(?:^|[\\/])\.\.(?:[\\/]|$)).+/;

type RevertTarget = NodeChangedFilesEvent & { messageId: string };

async function resolveTarget(conversationId: string, messageId: string): Promise<RevertTarget | null> {
  const events = await readConversationLog(conversationId);
  if (!events) return null;
  const messages = projectMessages(events);
  if (!messages.some(message => message.id === messageId)) return null;

  const latestMessageByNode = new Map<string, string>();
  let target: RevertTarget | null = null;
  for (const event of events) {
    if (event.type === 'message' && event.message.processNodeId) {
      latestMessageByNode.set(event.message.processNodeId, event.message.id);
    } else if (event.type === 'node:changed-files' && event.node?.nodeId) {
      const associatedMessageId = latestMessageByNode.get(event.node.nodeId);
      if (associatedMessageId === messageId) target = { ...event, messageId };
    }
  }
  if (!target || !path.isAbsolute(target.root)) return null;
  if (target.changedFiles.some(file => !SAFE_PATH.test(file.path))) return null;
  return target;
}

async function buildPreview(conversationId: string, target: RevertTarget) {
  const fullDiff = await shadowRepoService.diff(target.root, target.startSnapshot);
  const previewId = crypto
    .createHash('sha256')
    .update(JSON.stringify([conversationId, target.messageId, target.startSnapshot, target.endSnapshot, fullDiff]))
    .digest('hex');
  return {
    messageId: target.messageId,
    previewId,
    files: target.changedFiles.map(({ path, status }) => ({ path, status })),
    diff: fullDiff.slice(0, MAX_DIFF_CHARS),
    truncated: fullDiff.length > MAX_DIFF_CHARS,
  };
}

function unavailable() {
  return NextResponse.json({ error: 'Revert to here is not enabled' }, { status: 404 });
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ conversationId: string }> },
) {
  const locked = await assertUnlocked({ openai: true });
  if (locked) return locked;
  if (!FEATURES.ENABLE_REVERT_TO_HERE) return unavailable();
  const { conversationId } = await params;
  const messageId = request.nextUrl.searchParams.get('messageId');
  if (!messageId) return NextResponse.json({ error: 'messageId is required' }, { status: 400 });
  if (!(await loadConversationState(conversationId))) {
    return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
  }
  const target = await resolveTarget(conversationId, messageId);
  if (!target) return NextResponse.json({ error: 'No revertable changes for this message' }, { status: 404 });
  return NextResponse.json(await buildPreview(conversationId, target));
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ conversationId: string }> },
) {
  const locked = await assertUnlocked({ openai: true });
  if (locked) return locked;
  if (!FEATURES.ENABLE_REVERT_TO_HERE) return unavailable();
  const notLocal = assertLocalRequest(request);
  if (notLocal) return notLocal;

  const { conversationId } = await params;
  const state = await loadConversationState(conversationId);
  if (!state) return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
  const body = await request.json().catch(() => ({})) as {
    messageId?: string;
    previewId?: string;
    operationId?: string;
    action?: 'undo';
  };

  if (body.action === 'undo') {
    const operation = body.operationId ? state.revertOperations?.[body.operationId] : undefined;
    if (!operation || operation.undoneAt) {
      return NextResponse.json({ error: 'Undo operation not found or already used' }, { status: 404 });
    }
    const undoAnchor = await shadowRepoService.revert(operation.root, operation.snapshotId, operation.paths);
    if (!undoAnchor) return NextResponse.json({ error: 'Unable to undo revert' }, { status: 409 });
    operation.undoneAt = Date.now();
    FlowExecutor.conversationStates.set(conversationId, state);
    await persistConversationState(`conversations/${conversationId}` as StorageKey, state);
    return new NextResponse(null, { status: 204 });
  }

  if (!body.messageId || !body.previewId) {
    return NextResponse.json({ error: 'messageId and previewId are required' }, { status: 400 });
  }
  const target = await resolveTarget(conversationId, body.messageId);
  if (!target) return NextResponse.json({ error: 'No revertable changes for this message' }, { status: 404 });
  const preview = await buildPreview(conversationId, target);
  if (preview.previewId !== body.previewId) {
    return NextResponse.json({ error: 'The worktree changed after preview; refresh and review again' }, { status: 409 });
  }

  const paths = target.changedFiles.map(file => file.path);
  const preRevert = await shadowRepoService.revert(target.root, target.startSnapshot, paths);
  if (!preRevert) return NextResponse.json({ error: 'Unable to revert worktree' }, { status: 409 });
  const operationId = crypto.randomUUID();
  state.revertOperations = {
    ...(state.revertOperations ?? {}),
    [operationId]: {
      messageId: body.messageId,
      root: target.root,
      snapshotId: preRevert,
      paths,
      createdAt: Date.now(),
    },
  };
  FlowExecutor.conversationStates.set(conversationId, state);
  await persistConversationState(`conversations/${conversationId}` as StorageKey, state);
  return NextResponse.json({ operationId });
}
