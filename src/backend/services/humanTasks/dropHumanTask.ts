/**
 * Ends the Human steps of sub-flow children when the run that waited for them is
 * stopped or replaced by a new message (#1095), so a late answer or a deadline can
 * never bring that child back, and the step leaves the list of waiting steps.
 */
import { createLogger } from '@/utils/logger';
import { StorageKey } from '@/shared/types/storage';
import { bindToCurrentWorkspace } from '@/utils/workspace';
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import { withConversationExecutionLock } from '@/backend/execution/flow/conversationExecutionLock';
import { loadConversationState } from '@/backend/execution/flow/loadConversationState';
import { persistConversationState } from '@/backend/execution/flow/persistConversationState';
import { appendRawForState, repairDanglingToolCalls } from '@/backend/execution/flow/conversationLog';
import { delegatedHumanTasks, type DelegatedHumanTask } from '@/backend/execution/flow/humanTask';
import { isPersonaOwnedConversationState } from '@/backend/execution/flow/personaConversationOwnership';
import { syncHumanTaskEntry, updateHumanTaskEntry } from './humanTaskIndex';

const log = createLogger('backend/services/humanTasks/dropHumanTask');

/** Sub-flows nest at most this deep. */
const MAX_CHAIN = 16;

async function dropChild(conversationId: string, message: string, depth: number): Promise<void> {
  const nested = await withConversationExecutionLock(conversationId, async (): Promise<DelegatedHumanTask[]> => {
    const state = await loadConversationState(conversationId);
    if (!state || state.status !== 'awaiting_tool_approval') return [];
    const own = state.humanTask;
    const children = delegatedHumanTasks(state);
    const finishedAt = new Date().toISOString();
    if (own) await syncHumanTaskEntry(() => updateHumanTaskEntry(own.requestId, { status: 'cancelled', finishedAt }), message);
    for (const child of children) {
      await syncHumanTaskEntry(() => updateHumanTaskEntry(child.requestId, { status: 'cancelled', finishedAt }), message);
    }
    // A Persona's conversation only changes with its dispatcher's authority. Its step is
    // off the list now, and an answer to it finds no Activity to continue.
    if (isPersonaOwnedConversationState(state)) return children;
    state.humanTask = undefined;
    state.pendingToolCalls = undefined;
    state.status = 'error';
    state.isCancelled = true;
    state.lastResponse = { success: false, error: message };
    const repaired = repairDanglingToolCalls(state, message);
    FlowExecutor.conversationStates.set(conversationId, state);
    await persistConversationState(`conversations/${conversationId}` as StorageKey, state);
    if (repaired.length) await appendRawForState(state, repaired.map((entry) => ({ type: 'message', message: entry })));
    return children;
  });
  if (depth >= MAX_CHAIN) return;
  for (const id of new Set(nested.map((task) => task.conversationId))) await dropChild(id, message, depth + 1);
}

/** Stop a run that waits for a person, with its sub-flows' steps (an MCP task was cancelled). */
export async function endWaitingRun(conversationId: string, message: string): Promise<void> {
  await dropChild(conversationId, message, 0);
}

/**
 * End every child step in `waits`. Runs in the background, after the caller's own
 * lock is released, so a parent never waits on a child's lock while holding its own.
 */
export function dropWaitingChildSteps(waits: ReadonlyArray<Pick<DelegatedHumanTask, 'conversationId'>>, message: string): void {
  const ids = [...new Set(waits.map((task) => task.conversationId))];
  if (ids.length === 0) return;
  const run = bindToCurrentWorkspace(async () => {
    for (const id of ids) {
      try {
        await dropChild(id, message, 0);
      } catch (error) {
        log.warn('Could not end a sub-flow step; its deadline ends it', { conversationId: id, error });
      }
    }
  });
  queueMicrotask(() => { void run(); });
}
