// Keeps an agent chat working toward its goal: after each reply it starts the next turn.
import { randomUUID } from 'node:crypto';
import type { FlujoChatMessage } from '@/shared/types/chat';
import type { ChatGoal, ChatGoalRefusal } from '@/shared/types/chatGoal';
import { createLogger } from '@/utils/logger';
import { isEncryptionLocked } from '@/utils/encryption/secure';
import { chatAdmissionWaitMs } from '@/utils/http/chatIngress';
import { getCollectionItemStats } from '@/utils/storage/backend';
import { bindToCurrentWorkspace, getCurrentWorkspace, workspaceCacheKey } from '@/utils/workspace';
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import { withConversationExecutionLock } from '@/backend/execution/flow/conversationExecutionLock';
import { loadConversationState, loadConversationStateReadOnly } from '@/backend/execution/flow/loadConversationState';
import { isPersonaOwnedConversationState } from '@/backend/execution/flow/personaConversationOwnership';
import { acquireFlowRunAdmissionWhenAvailable, isFlowRunPressureError, withFlowRunAdmission } from '@/backend/execution/flow/runAdmission';
import { runFlow, type FlowRunMessageInput } from '@/backend/execution/flow/runFlow';
import { requireApprovalOf } from '@/backend/execution/flow/toolApprovalGate';
import type { SharedState } from '@/backend/execution/flow/types';
import { isExecutionProtectedState } from '@/backend/execution/extensions';
import { getFlowRunEventBus, isFlowSignalEvent } from '@/backend/services/scheduler/flowRunEventBus';
import { isWorkerMode } from '@/backend/services/workspace/workerMode';
import { listChatGoals, loadChatGoal, mutateChatGoal } from './chatGoalStore';

export { clearChatGoal, loadChatGoal as getChatGoal, pauseChatGoal } from './chatGoalStore';
import {
  GOAL_BUSY_RETRY_MS,
  beginChatGoalTurn,
  canStartChatGoalTurn,
  chatGoalTurnText,
  chatTurnOutcome,
  reviewChatTurn,
  settleChatGoal,
} from './chatGoalPolicy';

const log = createLogger('backend/services/chatGoals/chatGoalRuntime');

/** A short pause after a reply, so a message the person sends right then goes first. */
export const CHAT_GOAL_CHECK_DELAY_MS = 1_000;

type CheckEntry = { running: boolean; again: boolean };
const runtime = globalThis as typeof globalThis & {
  __flujoChatGoalChecks?: Map<string, CheckEntry>;
  __flujoChatGoalListeners?: Set<string>;
};
const checks = () => (runtime.__flujoChatGoalChecks ??= new Map());
const listeners = () => (runtime.__flujoChatGoalListeners ??= new Set());

export type ChatGoalCheck = 'none' | 'waiting' | 'paused' | 'achieved' | 'later' | 'busy' | 'started';

type GoalTurnMessage = FlowRunMessageInput & Pick<FlujoChatMessage, 'id' | 'timestamp' | 'goalTurn'>;

function isLive(state: Readonly<SharedState>): boolean {
  return state.status === 'running' || state.status === 'awaiting_tool_approval' || state.status === 'paused_debug';
}

/** The chat a goal may belong to, or why it may not have one. */
export async function readChatGoalTarget(conversationId: string): Promise<
  { state: Readonly<SharedState> } | { refusal: ChatGoalRefusal; message: string }
> {
  const state = await loadConversationStateReadOnly(conversationId);
  if (!state) return { refusal: 'not_found', message: 'Conversation not found.' };
  if (state.personaArchived) return { refusal: 'read_only', message: 'This conversation is read-only.' };
  if (isPersonaOwnedConversationState(state)) {
    return { refusal: 'persona_owned', message: 'Persona chats use Persona goals.' };
  }
  if (isExecutionProtectedState(state)) return { refusal: 'protected', message: 'This conversation is managed by its owner.' };
  return { state };
}

/**
 * Look at the chat again after FLUJO waited a moment. Checks for one chat never
 * overlap: a request while one runs makes it look once more when it is done.
 */
export function scheduleChatGoalCheck(conversationId: string, delayMs = CHAT_GOAL_CHECK_DELAY_MS): void {
  const key = workspaceCacheKey('chat-goal-check', conversationId);
  const existing = checks().get(key);
  if (existing) {
    if (existing.running) existing.again = true;
    return;
  }
  const entry: CheckEntry = { running: false, again: false };
  checks().set(key, entry);
  const fire = bindToCurrentWorkspace(async () => {
    entry.running = true;
    try {
      // A finished goal turn is looked at next, even if its end was not announced.
      if (await checkChatGoal(conversationId) === 'started') entry.again = true;
    } catch (error) {
      log.warn('Could not check the chat goal; the next sweep looks again', { conversationId, error });
    } finally {
      checks().delete(key);
      if (entry.again) scheduleChatGoalCheck(conversationId);
    }
  });
  const timer = setTimeout(() => { void fire(); }, delayMs);
  timer.unref?.();
}

/** Start listening for finished chat runs in this workspace (once per process). */
export function ensureChatGoalListener(): void {
  const workspace = getCurrentWorkspace();
  if (listeners().has(workspace)) return;
  listeners().add(workspace);
  getFlowRunEventBus().subscribe((event) => {
    if (isFlowSignalEvent(event) || (event.firedBy !== 'chat' && event.firedBy !== 'api') || !event.conversationId) return;
    scheduleChatGoalCheck(event.conversationId);
  });
}

async function conversationIsGone(conversationId: string): Promise<boolean> {
  try {
    return (await getCollectionItemStats('conversations', conversationId)) === null;
  } catch {
    return false;
  }
}

async function startGoalTurn(conversationId: string, state: SharedState, message: GoalTurnMessage): Promise<ChatGoalCheck> {
  let permit;
  try {
    permit = await acquireFlowRunAdmissionWhenAvailable(
      { conversationId, messages: state.messages },
      { deadline: Date.now() + chatAdmissionWaitMs() },
    );
  } catch (error) {
    if (!isFlowRunPressureError(error)) throw error;
    log.info('FLUJO is busy; the goal goes on shortly', { conversationId });
    await mutateChatGoal(conversationId, (goal) => (goal?.turn?.messageId === message.id
      ? { goal: { ...goal, turn: undefined, rounds: goal.rounds - 1, retryAt: Date.now() + GOAL_BUSY_RETRY_MS }, result: undefined }
      : { result: undefined }));
    return 'busy';
  }
  try {
    await withFlowRunAdmission(permit, () => runFlow({
      conversationId,
      mode: 'conversation',
      flujo: true,
      messages: [message],
      resumeAsNewTurn: true,
      requireApproval: requireApprovalOf(state.requireApproval),
      userTurn: false,
      source: isWorkerMode() ? 'internal' : 'chat',
    }));
  } catch (error) {
    // The next check sees that the turn did not land and counts a failed round.
    log.warn('A goal turn could not run', { conversationId, error });
  }
  return 'started';
}

/**
 * Bring a chat's goal up to date and, when it may go on, start the next turn.
 * Runs under the chat's lock, so it never overlaps a reply. Safe to call any
 * number of times: every turn is looked at once, and a turn starts only when
 * the chat is idle and the last one has been looked at.
 */
export async function checkChatGoal(conversationId: string): Promise<ChatGoalCheck> {
  // Most chats have no goal: answer those without waiting for the chat's lock.
  const peek = await loadChatGoal(conversationId);
  if (!peek) return 'none';
  if (peek.state === 'achieved') return 'achieved';
  return withConversationExecutionLock(conversationId, async () => {
    const saved = await loadChatGoal(conversationId);
    if (!saved) return 'none';
    if (saved.state === 'achieved') return 'achieved';
    const state = await loadConversationState(conversationId);
    if (!state) {
      if (await conversationIsGone(conversationId)) {
        await mutateChatGoal(conversationId, () => ({ goal: null, result: undefined }));
      }
      return 'none';
    }
    if (isPersonaOwnedConversationState(state) || state.personaArchived || isExecutionProtectedState(state)) return 'none';
    const outcome = chatTurnOutcome(state);
    if (outcome.kind === 'waiting') return 'waiting';

    const now = Date.now();
    const messageId = randomUUID();
    const decision = await mutateChatGoal<{ status: ChatGoalCheck; message?: GoalTurnMessage }>(conversationId, (goal) => {
      if (!goal) return { result: { status: 'none' } };
      if (goal.state === 'achieved') return { result: { status: 'achieved' } };
      const lastId = state.messages.at(-1)?.id;
      const settled = goal.turn || lastId !== goal.reviewedMessageId
        ? settleChatGoal(goal, reviewChatTurn(state.messages, goal), outcome, now)
        : goal;
      if (!canStartChatGoalTurn(settled, now)) {
        return {
          goal: settled === goal ? undefined : settled,
          result: { status: settled.state === 'active' ? 'later' : settled.state },
        };
      }
      const next = beginChatGoalTurn(settled, messageId, now);
      return {
        goal: next,
        result: {
          status: 'started',
          message: {
            id: messageId,
            role: 'user',
            content: chatGoalTurnText(settled, next.rounds),
            timestamp: now,
            goalTurn: { goalId: next.id, round: next.rounds },
          },
        },
      };
    });
    if (!decision.message) return decision.status;
    return startGoalTurn(conversationId, state, decision.message);
  });
}

function newGoal(conversationId: string, text: string, state: Readonly<SharedState>, now: number): ChatGoal {
  return {
    id: `goal_${randomUUID().replaceAll('-', '')}`,
    conversationId,
    text,
    state: 'active',
    createdAt: now,
    updatedAt: now,
    rounds: 0,
    quietRounds: 0,
    failedRounds: 0,
    ...(state.messages.at(-1)?.id ? { reviewedMessageId: state.messages.at(-1)!.id } : {}),
  };
}

export type ChatGoalChange =
  | { goal: ChatGoal | null; running: boolean }
  | { refusal: ChatGoalRefusal; message: string };

/** Give the chat a new goal (replacing any old one). An idle chat starts on it right away. */
export async function setChatGoal(conversationId: string, text: string): Promise<ChatGoalChange> {
  const target = await readChatGoalTarget(conversationId);
  if ('refusal' in target) return target;
  ensureChatGoalListener();
  const goal = await mutateChatGoal(conversationId, () => {
    const created = newGoal(conversationId, text, target.state, Date.now());
    return { goal: created, result: created };
  });
  scheduleChatGoalCheck(conversationId, 0);
  return { goal, running: isLive(target.state) };
}

/** Let a paused goal go on now. */
export async function resumeChatGoal(conversationId: string): Promise<ChatGoalChange> {
  const target = await readChatGoalTarget(conversationId);
  if ('refusal' in target) return target;
  ensureChatGoalListener();
  const goal = await mutateChatGoal(conversationId, (current) => {
    if (!current || current.state !== 'paused') return { result: current };
    const next: ChatGoal = {
      ...current, state: 'active', pause: undefined, quietRounds: 0, failedRounds: 0, retryAt: undefined, updatedAt: Date.now(),
    };
    return { goal: next, result: next };
  });
  if (goal?.state === 'active') scheduleChatGoalCheck(conversationId, 0);
  return { goal, running: isLive(target.state) };
}

/**
 * Pick up goals nobody looked at: after a restart, after a failed turn's wait,
 * or when FLUJO was too busy. Runs once at start-up and then every minute.
 */
export async function sweepChatGoals(now = Date.now()): Promise<number> {
  ensureChatGoalListener();
  if (await isEncryptionLocked()) return 0;
  let due = 0;
  for (const goal of await listChatGoals()) {
    if (goal.state !== 'active' || (goal.retryAt !== undefined && goal.retryAt > now)) continue;
    const live = FlowExecutor.conversationStates.get(goal.conversationId);
    if (live && isLive(live)) continue;
    scheduleChatGoalCheck(goal.conversationId, 0);
    due += 1;
  }
  return due;
}
