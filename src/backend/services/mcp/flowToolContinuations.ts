/**
 * MCP Tasks for flow runs that wait for a person (#1095).
 *
 * A flow tool whose run stops at a Human step hands its task over to the saved run.
 * From then on the task is read from that run: while a step waits, the task is
 * `input_required` with one form per step (built from the frozen step, so an answer
 * always fits exactly what was shown); `tasks/update` answers the step through the
 * same path as every other answer; while the run goes on the task is `working`; and
 * its final answer becomes the task's result. Nothing lives in memory, so all of
 * this works after a restart. The same step can also be answered in FLUJO; the task
 * just follows the run.
 */
import { ElicitResultV2Schema, type InputRequestsV2 } from '@modelcontextprotocol/ext-tasks/core/v2';
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import { loadConversationState } from '@/backend/execution/flow/loadConversationState';
import { delegatedHumanTasks } from '@/backend/execution/flow/humanTask';
import { completedOutputFromState } from '@/backend/execution/flow/subflowRecovery';
import type { HumanTaskState, SharedState } from '@/backend/execution/flow/types';
import { answerHumanTask, continueAnsweredHumanTask } from '@/backend/services/humanTasks/answerHumanTask';
import { endWaitingRun } from '@/backend/services/humanTasks/dropHumanTask';
import { humanAnswerFromForm, humanElicitationForm, humanInputKey } from '@/utils/shared/humanStep';
import { ServerTaskError, type ServerTaskContinuations, type ServerTaskContinuationView } from './serverTasks';

/** Sub-flows nest at most this deep. */
const MAX_CHAIN = 16;

interface WaitingStep {
  /** The conversation that asked; it may be a sub-flow of the run the task follows. */
  conversationId: string;
  task: HumanTaskState;
}

/** The Human steps a saved run waits for, its own and those of its sub-flows. */
async function waitingSteps(conversationId: string, state?: SharedState, depth = 0): Promise<WaitingStep[]> {
  const current = state ?? await loadConversationState(conversationId).catch(() => undefined);
  if (!current || current.status !== 'awaiting_tool_approval') return [];
  const own = current.humanTask && !current.humanTask.decision ? [{ conversationId, task: current.humanTask }] : [];
  if (depth >= MAX_CHAIN) return own;
  const nested: WaitingStep[] = [];
  for (const child of new Set(delegatedHumanTasks(current).map((task) => task.conversationId))) {
    nested.push(...await waitingSteps(child, undefined, depth + 1));
  }
  return [...own, ...nested];
}

/** The text and structured content a plain (non-task) tool call returns while its run waits. */
export function waitingHandoffText(conversationId: string, state: SharedState | undefined): {
  text: string;
  structured: Record<string, unknown>;
} {
  const own = state?.humanTask && !state.humanTask.decision ? [state.humanTask] : [];
  const steps = [
    ...own.map((task) => ({ requestId: task.requestId, title: task.title, expiresAt: task.expiresAt })),
    ...delegatedHumanTasks(state).map((task) => ({ requestId: task.requestId })),
  ];
  const named = steps.map((step) => ('title' in step ? `"${step.title}"` : '')).filter(Boolean);
  const text = steps.length > 0
    ? `The flow is waiting for a person${named.length ? ` (${named.join(', ')})` : ''}. It goes on by itself once the step is `
      + `answered in FLUJO: in the chat of conversation ${conversationId}, in the list at GET /api/human-tasks, `
      + `or with POST /api/human-tasks/${steps[0].requestId}.`
    : `The flow is waiting for an approval in FLUJO, in the chat of conversation ${conversationId}. It goes on by itself once it is answered.`;
  return { text, structured: { status: 'waiting_for_person', conversationId, steps } };
}

function finalResult(state: SharedState): Record<string, unknown> {
  return { content: [{ type: 'text', text: completedOutputFromState(state).outputText }], resultType: 'complete' };
}

async function view(conversationId: string): Promise<ServerTaskContinuationView> {
  const state = await loadConversationState(conversationId).catch(() => undefined);
  if (!state) return { status: 'failed', message: 'The flow run is gone.' };
  if (state.status === 'completed' || state.status === 'capped') return { status: 'completed', result: finalResult(state) };
  if (state.status === 'error') {
    const response = state.lastResponse;
    const message = typeof response === 'object' && response && 'error' in response && typeof response.error === 'string'
      ? response.error : 'The flow run ended with an error.';
    return { status: 'failed', message };
  }
  const steps = await waitingSteps(conversationId, state);
  if (steps.length === 0) return { status: 'working' };
  const inputRequests: InputRequestsV2 = {};
  for (const { task } of steps) {
    const form = humanElicitationForm(task);
    inputRequests[humanInputKey(task.requestId)] = {
      method: 'elicitation/create',
      params: { mode: 'form', message: form.message, requestedSchema: form.requestedSchema },
    } as InputRequestsV2[string];
  }
  return { status: 'input_required', inputRequests };
}

async function answer(conversationId: string, key: string, response: unknown): Promise<void> {
  const step = (await waitingSteps(conversationId)).find(({ task }) => humanInputKey(task.requestId) === key);
  if (!step) return;
  const parsed = ElicitResultV2Schema.safeParse(response);
  if (!parsed.success) throw new ServerTaskError('TASK_INPUT_INVALID');
  const { accept, value } = humanAnswerFromForm(step.task, parsed.data);
  const result = await answerHumanTask({
    requestId: step.task.requestId,
    accept,
    // The form showed exactly this frozen step, so the answer is for its digest.
    answer: { digest: step.task.digest, ...(value !== undefined ? { value } : {}), idempotencyKey: key },
    channel: 'mcp',
    conversationId: step.conversationId,
    fromThisComputer: true,
  });
  if (result.kind === 'refused') {
    if (result.status === 404) return;
    throw new ServerTaskError('TASK_INPUT_INVALID');
  }
  continueAnsweredHumanTask(result);
}

async function cancel(conversationId: string): Promise<void> {
  const live = FlowExecutor.conversationStates.get(conversationId);
  if (live?.status === 'running') live.isCancelled = true;
  await endWaitingRun(conversationId, 'The MCP task was cancelled.');
}

export const flowToolContinuations: ServerTaskContinuations = { view, answer, cancel };
