import { withWorkspaceRoute } from '@/app/api/_workspace';
import crypto from 'crypto';
import path from 'path';
import { NextRequest, NextResponse } from 'next/server';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { assertLocalRequest } from '@/utils/http/localRequest';
import {
  appendRawForState,
  projectMessages,
  readConversationLog,
} from '@/backend/execution/flow/conversationLog';
import { loadConversationState } from '@/backend/execution/flow/loadConversationState';
import { persistConversationState } from '@/backend/execution/flow/persistConversationState';
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import type { SharedState } from '@/backend/execution/flow/types';
import {
  shadowRepoService,
  snapshotsEnabled,
} from '@/backend/services/snapshot/ShadowRepoService';
import { StorageKey } from '@/shared/types/storage';
import type { FlujoChatMessage } from '@/shared/types/chat';
import type {
  ExecutionEvent,
  NodeChangedFilesEvent,
  RawExecutionEvent,
} from '@/shared/types/execution/events';

const MAX_DIFF_CHARS = 120_000;
const SAFE_PATH = /^(?![A-Za-z]:)(?![\\/])(?!.*(?:^|[\\/])\.\.(?:[\\/]|$)).+/;
const ACTIVE_STATUSES = new Set(['running', 'awaiting_tool_approval', 'paused_debug']);

type RestoreMode = 'chat-and-files' | 'files-only' | 'chat-only';
type FileRestoreUnavailableReason =
  | 'no-snapshotted-file-changes'
  | 'multiple-roots'
  | 'unsafe-path';
type FileRestoreTarget = NodeChangedFilesEvent & { messageId: string };

interface RestoreContext {
  events: ExecutionEvent[];
  messages: FlujoChatMessage[];
  selectedIndex: number;
  fileTarget: FileRestoreTarget | null;
  fileUnavailableReason?: FileRestoreUnavailableReason;
}

interface RestorePlan {
  preview: {
    messageId: string;
    previewId: string;
    files: Array<{ path: string; status: string }>;
    diff: string;
    truncated: boolean;
    fileRestoreAvailable: boolean;
    fileRestoreUnavailableReason?: FileRestoreUnavailableReason;
    chatMessageCount: number;
  };
  chatHeadMessageIds: string[];
  chatTailMessageIds: string[];
}

function restoresFiles(mode: RestoreMode): boolean {
  return mode === 'chat-and-files' || mode === 'files-only';
}

function restoresChat(mode: RestoreMode): boolean {
  return mode === 'chat-and-files' || mode === 'chat-only';
}

function isRestoreMode(value: unknown): value is RestoreMode {
  return value === 'chat-and-files' || value === 'files-only' || value === 'chat-only';
}

/** Resolve the selected chat suffix and, when unambiguous, its file snapshot. */
async function resolveContext(conversationId: string, messageId: string): Promise<RestoreContext | null> {
  const events = await readConversationLog(conversationId);
  if (!events) return null;
  const messages = projectMessages(events);
  const selectedIndex = messages.findIndex(message => message.id === messageId);
  if (selectedIndex < 0) return null;

  let boundaryReached = false;
  let target: FileRestoreTarget | null = null;
  let fileUnavailableReason: FileRestoreUnavailableReason | undefined = 'no-snapshotted-file-changes';
  const changedFiles = new Map<string, NodeChangedFilesEvent['changedFiles'][number]>();

  for (const event of events) {
    if (event.type === 'message' && event.message.id === messageId) {
      boundaryReached = true;
      continue;
    }
    if (!boundaryReached || event.type !== 'node:changed-files') continue;
    if (!path.isAbsolute(event.root) || event.changedFiles.some(file => !SAFE_PATH.test(file.path))) {
      target = null;
      fileUnavailableReason = 'unsafe-path';
      break;
    }
    if (target && target.root !== event.root) {
      target = null;
      fileUnavailableReason = 'multiple-roots';
      break;
    }

    target ??= { ...event, messageId, changedFiles: [] };
    target.endSnapshot = event.endSnapshot;
    for (const file of event.changedFiles) changedFiles.set(file.path, file);
    fileUnavailableReason = undefined;
  }

  if (target && changedFiles.size > 0) {
    target.changedFiles = [...changedFiles.values()];
  } else {
    target = null;
    fileUnavailableReason ??= 'no-snapshotted-file-changes';
  }

  return { events, messages, selectedIndex, fileTarget: target, fileUnavailableReason };
}

async function buildPlan(conversationId: string, context: RestoreContext): Promise<RestorePlan> {
  const target = context.fileTarget;
  const fullDiff = target
    ? await shadowRepoService.diff(target.root, target.startSnapshot)
    : '';
  const chatHeadMessageIds = context.messages.slice(0, context.selectedIndex).map(message => message.id);
  const chatTailMessageIds = context.messages.slice(context.selectedIndex).map(message => message.id);
  const previewId = crypto
    .createHash('sha256')
    .update(JSON.stringify([
      conversationId,
      context.messages[context.selectedIndex].id,
      chatHeadMessageIds,
      chatTailMessageIds,
      target?.root,
      target?.startSnapshot,
      target?.endSnapshot,
      context.fileUnavailableReason,
      fullDiff,
    ]))
    .digest('hex');

  return {
    preview: {
      messageId: context.messages[context.selectedIndex].id,
      previewId,
      files: target?.changedFiles.map(({ path: filePath, status }) => ({ path: filePath, status })) ?? [],
      diff: fullDiff.slice(0, MAX_DIFF_CHARS),
      truncated: fullDiff.length > MAX_DIFF_CHARS,
      fileRestoreAvailable: Boolean(target),
      ...(context.fileUnavailableReason
        ? { fileRestoreUnavailableReason: context.fileUnavailableReason }
        : {}),
      chatMessageCount: chatTailMessageIds.length,
    },
    chatHeadMessageIds,
    chatTailMessageIds,
  };
}

function restoreChatSuffix(
  state: SharedState,
  context: RestoreContext,
  plan: RestorePlan,
): RawExecutionEvent[] {
  const removedIds = new Set(plan.chatTailMessageIds);
  state.messages = (state.messages ?? []).filter(message => !removedIds.has(message.id));

  // Native provider sessions contain the removed turns and cannot be rewound.
  // Clearing them makes the next turn rebuild from the restored transcript.
  state.codexSessions = undefined;
  state.lastResponse = undefined;
  state.lastError = undefined;
  state.errorEventEmitted = undefined;
  state.pendingToolCalls = undefined;
  state.handoffRequested = undefined;
  state.pendingSubflowReturn = undefined;
  state.handoffInput = undefined;
  state.forceSummaryTurn = undefined;
  state.capped = undefined;
  state.cappedReason = undefined;
  state.isCancelled = false;
  state.recovery = undefined;
  state.status = 'completed';

  const remaining = context.messages.slice(0, context.selectedIndex);
  const lastNodeMessage = [...remaining].reverse().find(message => message.processNodeId);
  state.currentNodeId = lastNodeMessage?.processNodeId;
  const lastUser = [...state.messages].reverse().find(message => message.role === 'user');
  state.lastUserMessageAt = lastUser?.timestamp;

  return plan.chatTailMessageIds.map(messageId => ({ type: 'message:removed', messageId }));
}

function latestMessageEvents(
  events: ExecutionEvent[],
  orderedIds: string[],
): Array<{ message: FlujoChatMessage; depth?: number }> | null {
  const wanted = new Set(orderedIds);
  const latest = new Map<string, { message: FlujoChatMessage; depth?: number }>();
  for (const event of events) {
    if (event.type !== 'message' || !wanted.has(event.message.id)) continue;
    latest.set(event.message.id, {
      message: event.message,
      ...(event.depth ? { depth: event.depth } : {}),
    });
  }
  const restored = orderedIds.map(id => latest.get(id));
  return restored.every(Boolean)
    ? restored as Array<{ message: FlujoChatMessage; depth?: number }>
    : null;
}

function unavailable() {
  return NextResponse.json({ error: 'Filesystem snapshots and restore are not enabled' }, { status: 404 });
}

function runningConflict() {
  return NextResponse.json(
    { error: 'Wait for the conversation to stop before restoring it' },
    { status: 409 },
  );
}

async function GET_handler(
  request: NextRequest,
  { params }: { params: Promise<{ conversationId: string }> },
) {
  const locked = await assertUnlocked({ openai: true });
  if (locked) return locked;
  if (!(await snapshotsEnabled())) return unavailable();
  const { conversationId } = await params;
  const messageId = request.nextUrl.searchParams.get('messageId');
  if (!messageId) return NextResponse.json({ error: 'messageId is required' }, { status: 400 });
  const state = await loadConversationState(conversationId);
  if (!state) return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
  if (state.status && ACTIVE_STATUSES.has(state.status)) return runningConflict();
  const context = await resolveContext(conversationId, messageId);
  if (!context) return NextResponse.json({ error: 'Message not found in conversation' }, { status: 404 });
  return NextResponse.json((await buildPlan(conversationId, context)).preview);
}

async function POST_handler(
  request: NextRequest,
  { params }: { params: Promise<{ conversationId: string }> },
) {
  const locked = await assertUnlocked({ openai: true });
  if (locked) return locked;
  if (!(await snapshotsEnabled())) return unavailable();
  const notLocal = assertLocalRequest(request);
  if (notLocal) return notLocal;

  const { conversationId } = await params;
  const state = await loadConversationState(conversationId);
  if (!state) return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
  if (state.status && ACTIVE_STATUSES.has(state.status)) return runningConflict();
  const body = await request.json().catch(() => ({})) as {
    messageId?: string;
    previewId?: string;
    operationId?: string;
    action?: 'undo';
    mode?: RestoreMode;
  };

  if (body.action === 'undo') {
    const operation = body.operationId ? state.revertOperations?.[body.operationId] : undefined;
    if (!operation || operation.undoneAt) {
      return NextResponse.json({ error: 'Undo operation not found or already used' }, { status: 404 });
    }
    const mode = operation.mode ?? 'files-only';
    let restoredMessages: Array<{ message: FlujoChatMessage; depth?: number }> | null = null;
    if (restoresChat(mode)) {
      const events = await readConversationLog(conversationId);
      if (!events || !operation.chatHeadMessageIds || !operation.chatTailMessageIds) {
        return NextResponse.json({ error: 'Chat undo data is unavailable' }, { status: 409 });
      }
      const currentIds = projectMessages(events).map(message => message.id);
      if (JSON.stringify(currentIds) !== JSON.stringify(operation.chatHeadMessageIds)) {
        return NextResponse.json(
          { error: 'The chat changed after the restore and can no longer be undone safely' },
          { status: 409 },
        );
      }
      restoredMessages = latestMessageEvents(events, operation.chatTailMessageIds);
      if (!restoredMessages) {
        return NextResponse.json({ error: 'Original chat messages are unavailable' }, { status: 409 });
      }
    }

    if (restoresFiles(mode)) {
      if (!operation.root || !operation.snapshotId || !operation.paths) {
        return NextResponse.json({ error: 'File undo data is unavailable' }, { status: 409 });
      }
      const undoAnchor = await shadowRepoService.revert(
        operation.root,
        operation.snapshotId,
        operation.paths,
      );
      if (!undoAnchor) return NextResponse.json({ error: 'Unable to undo file restore' }, { status: 409 });
    }

    if (restoredMessages) {
      const rawMessages: RawExecutionEvent[] = restoredMessages.map(({ message, depth }) => ({
        type: 'message',
        message,
        ...(depth ? { depth } : {}),
      }));
      await appendRawForState(state, rawMessages);
      const existingIds = new Set(state.messages.map(message => message.id));
      state.messages.push(...restoredMessages
        .filter(({ message, depth }) => !depth && !existingIds.has(message.id))
        .map(({ message }) => message));
      state.currentNodeId = [...restoredMessages]
        .reverse()
        .find(({ message, depth }) => !depth && message.processNodeId)
        ?.message.processNodeId ?? state.currentNodeId;
      const lastUser = [...state.messages].reverse().find(message => message.role === 'user');
      state.lastUserMessageAt = lastUser?.timestamp;
    }

    operation.undoneAt = Date.now();
    state.updatedAt = Date.now();
    FlowExecutor.conversationStates.set(conversationId, state);
    await persistConversationState(`conversations/${conversationId}` as StorageKey, state);
    return new NextResponse(null, { status: 204 });
  }

  if (!body.messageId || !body.previewId || !isRestoreMode(body.mode)) {
    return NextResponse.json(
      { error: 'messageId, previewId, and a valid restore mode are required' },
      { status: 400 },
    );
  }
  const context = await resolveContext(conversationId, body.messageId);
  if (!context) return NextResponse.json({ error: 'Message not found in conversation' }, { status: 404 });
  const plan = await buildPlan(conversationId, context);
  if (plan.preview.previewId !== body.previewId) {
    return NextResponse.json(
      { error: 'The chat or worktree changed after preview; refresh and review again' },
      { status: 409 },
    );
  }
  if (restoresFiles(body.mode) && !context.fileTarget) {
    return NextResponse.json(
      { error: 'No unambiguous snapshotted file changes are available for this restore point' },
      { status: 409 },
    );
  }

  let preRestoreSnapshot: string | undefined;
  if (restoresFiles(body.mode) && context.fileTarget) {
    const paths = context.fileTarget.changedFiles.map(file => file.path);
    preRestoreSnapshot = await shadowRepoService.revert(
      context.fileTarget.root,
      context.fileTarget.startSnapshot,
      paths,
    ) ?? undefined;
    if (!preRestoreSnapshot) {
      return NextResponse.json({ error: 'Unable to restore worktree files' }, { status: 409 });
    }
  }

  if (restoresChat(body.mode)) {
    const removals = restoreChatSuffix(state, context, plan);
    await appendRawForState(state, removals);
  }

  const operationId = crypto.randomUUID();
  state.revertOperations = {
    ...(state.revertOperations ?? {}),
    [operationId]: {
      messageId: body.messageId,
      mode: body.mode,
      ...(context.fileTarget && preRestoreSnapshot
        ? {
            root: context.fileTarget.root,
            snapshotId: preRestoreSnapshot,
            paths: context.fileTarget.changedFiles.map(file => file.path),
          }
        : {}),
      ...(restoresChat(body.mode)
        ? {
            chatHeadMessageIds: plan.chatHeadMessageIds,
            chatTailMessageIds: plan.chatTailMessageIds,
          }
        : {}),
      createdAt: Date.now(),
    },
  };
  state.updatedAt = Date.now();
  FlowExecutor.conversationStates.set(conversationId, state);
  await persistConversationState(`conversations/${conversationId}` as StorageKey, state);
  return NextResponse.json({
    operationId,
    restoredChat: restoresChat(body.mode),
    restoredFiles: restoresFiles(body.mode),
  });
}

export const GET = withWorkspaceRoute(GET_handler);
export const POST = withWorkspaceRoute(POST_handler);
