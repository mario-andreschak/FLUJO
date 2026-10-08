import { createHash, randomUUID } from 'crypto';
import type { FlujoChatMessage } from '@/shared/types/chat';
import type { SubflowTaskRecord } from '@/shared/types/subflowTasks';
import { getTask, listTasks } from '@/backend/services/subflowTasks';
import { flowService } from '@/backend/services/flow';
import { bindToCurrentWorkspace } from '@/utils/workspace';
import { FlowExecutor } from './FlowExecutor';
import { isCancelledByAncestry } from './cancellation';
import { commitFlowDurableMutation, assertFlowExecutionCurrent, rethrowFlowExecutionAuthorityError } from './executionAuthority';
import { enqueueSteeringMessage, peekSteeringMessages } from './steeringInbox';
import type { SharedState, ToolDefinition } from './types';

const TOOL_NAMES = ['subflow_list', 'subflow_send_message', 'subflow_wait'] as const;
const ACTIVE = new Set(['running', 'awaiting_tool_approval', 'paused_debug']);
const TERMINAL_TASKS = new Set(['completed', 'failed', 'cancelled']);

export function isSubflowCommunicationTool(name: string): boolean {
  return (TOOL_NAMES as readonly string[]).includes(name);
}

export function buildSubflowCommunicationTools(): ToolDefinition[] {
  return [
    {
      name: 'subflow_list',
      description: 'Discover your parent and child agents, their conversation IDs, task IDs and current status. Use these IDs with subflow_send_message. Available automatically inside subflows and to their orchestrators.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'subflow_send_message',
      description: 'Send a progress update, question, or steering instruction to your parent (target: "parent") or one of your children (conversation ID or task ID from subflow_list/start_subflow). Delivery is queued for the recipient\'s next safe model boundary; a receipt does not mean it has read or answered. Children can reply without ending their work. Terminal recipients return an error. Synchronous handoffs/calls hold the parent until the child returns: use start_subflow_* for an ongoing exchange.',
      inputSchema: {
        type: 'object', properties: {
          target: { type: 'string', minLength: 1 },
          message: { type: 'string', minLength: 1, maxLength: 32000 },
        }, required: ['target', 'message'], additionalProperties: false,
      },
    },
    {
      name: 'subflow_wait',
      description: 'Wait for an incoming agent message or for a selected child to finish (up to 60 seconds). The tool returns before the message is folded into your context. Omit target to watch all children and incoming messages; use "parent" to wait for a parent reply. Use while background children work instead of ending your turn or repeatedly polling; on timeout continue independent work or wait again.',
      inputSchema: {
        type: 'object', properties: {
          target: { type: 'string', description: 'Optional parent, child conversation ID, or task ID.' },
          timeoutMs: { type: 'number', minimum: 0, maximum: 60000, description: 'Defaults to 30000.' },
        }, additionalProperties: false,
      },
    },
  ];
}

interface AgentRef {
  conversationId: string;
  relation: 'parent' | 'child';
  name?: string;
  status: string;
  taskId?: string;
  replyAvailability?: 'while_running' | 'after_child_returns';
}

function parentId(state: SharedState): string | undefined {
  return state.parentRunId ?? state.parentConversationId;
}

function nameOf(state: SharedState | undefined): string | undefined {
  return state?.flowSnapshot?.name ?? state?.title ?? state?.flowId;
}

async function familyOf(conversationId: string, state: SharedState): Promise<AgentRef[]> {
  const family = new Map<string, AgentRef>();
  const states = FlowExecutor.conversationStates;
  const parent = parentId(state);
  if (parent && (!state.parentLogicalRunId || states.get(parent)?.logicalRunId === state.parentLogicalRunId)) {
    const live = states.get(parent);
    const background = (await listTasks({ conversationId: parent, limit: 500 }))
      .some(task => task.childConversationId === conversationId && task.status === 'working'
        && (!task.originLogicalRunId || task.originLogicalRunId === live?.logicalRunId));
    family.set(parent, { conversationId: parent, relation: 'parent', name: nameOf(live), status: live?.status ?? 'unavailable',
      replyAvailability: background ? 'while_running' : 'after_child_returns' });
  }
  for (const [id, child] of states) {
    if (parentId(child) !== conversationId || (child.parentLogicalRunId && child.parentLogicalRunId !== state.logicalRunId)) continue;
    family.set(id, { conversationId: id, relation: 'child', name: nameOf(child), status: child.status ?? 'unavailable' });
  }
  for (const task of await listTasks({ conversationId, limit: 500 })) {
    // Do not adopt an earlier logical run's background work into a fresh run.
    if (task.originLogicalRunId && task.originLogicalRunId !== state.logicalRunId) continue;
    const live = states.get(task.childConversationId);
    family.set(task.childConversationId, {
      conversationId: task.childConversationId, relation: 'child', taskId: task.taskId,
      name: task.flowName ?? nameOf(live) ?? task.flowId,
      status: TERMINAL_TASKS.has(task.status) ? task.status : live?.status ?? task.status,
    });
  }
  return [...family.values()];
}

async function resolveRecipient(conversationId: string, state: SharedState, target: string): Promise<AgentRef | undefined> {
  const family = await familyOf(conversationId, state);
  return family.find(agent => target === 'parent'
    ? agent.relation === 'parent'
    : agent.conversationId === target || agent.taskId === target);
}

function makeMessage(senderId: string, recipientId: string, sender: SharedState | undefined, content: string, kind: 'message' | 'completion', id: string = randomUUID()): FlujoChatMessage {
  const senderName = nameOf(sender);
  return {
    id, role: 'user', timestamp: Date.now(), injected: true,
    content: `[Agent ${kind === 'completion' ? 'result' : 'message'} from ${senderName ?? senderId} (${senderId})]\n${content}`,
    agentMessage: { senderConversationId: senderId, senderName, recipientConversationId: recipientId, kind },
  };
}

/** Terminal notifications use the same safe-boundary delivery as progress updates. */
export async function publishSubflowCompletion(task: SubflowTaskRecord): Promise<void> {
  const parent = FlowExecutor.conversationStates.get(task.originConversationId);
  if (!parent || !ACTIVE.has(parent.status ?? '') || parent.isCancelled) return;
  if (task.originLogicalRunId && task.originLogicalRunId !== parent.logicalRunId) return;
  await commitFlowDurableMutation(parent, async () => {
    if (parent.messages.some(message => message.id === `subflow-result-${task.taskId}`)) return;
    const content = `Task ${task.taskId} ${task.status}.\n${task.error ?? task.outputText ?? ''}`.slice(0, 12000);
    const child = FlowExecutor.conversationStates.get(task.childConversationId);
    enqueueSteeringMessage(task.originConversationId, makeMessage(task.childConversationId, task.originConversationId, child, content, 'completion', `subflow-result-${task.taskId}`));
  });
}

/** Keep a finishing orchestrator available for its background workers' replies. */
export async function waitForActiveSubflows(state: SharedState, signal?: AbortSignal): Promise<boolean> {
  if (!state.conversationId || !state.launchedTaskIds?.length) return false;
  const logicalRunId = state.logicalRunId;
  while (!signal?.aborted && !isCancelledByAncestry(state.conversationId, FlowExecutor.conversationStates)) {
    await assertFlowExecutionCurrent(state);
    await state.executionAuthority?.pollRelatedInputs?.();
    if (peekSteeringMessages(state.conversationId).length) return true;
    const tasks = await Promise.all(state.launchedTaskIds.map(getTask));
    if (!tasks.some(task => task?.status === 'working' && task.originLogicalRunId === logicalRunId)) {
      // Catch completion notification queued as the terminal task was saved.
      for (const task of tasks) {
        if (task && TERMINAL_TASKS.has(task.status) && task.originLogicalRunId === logicalRunId
          && !state.messages.some(message => message.id === `subflow-result-${task.taskId}`)) {
          await publishSubflowCompletion(task);
        }
      }
      return peekSteeringMessages(state.conversationId).length > 0;
    }
    await new Promise<void>(resolve => setTimeout(resolve, 250));
  }
  return false;
}

/** A Finish node cannot answer a late worker question. Return to its launcher. */
export async function resumeSubflowOrchestrator(state: SharedState): Promise<void> {
  if (!state.subflowOrchestratorNodeId || state.currentNodeId === state.subflowOrchestratorNodeId) return;
  const flow = state.flowSnapshot ?? await flowService.getFlow(state.flowId);
  if (flow?.nodes.find(node => node.id === state.currentNodeId)?.type === 'finish'
    && flow.nodes.some(node => node.id === state.subflowOrchestratorNodeId && node.type === 'process')) {
    state.currentNodeId = state.subflowOrchestratorNodeId;
  }
}

export async function executeSubflowCommunicationTool(
  name: string,
  args: Record<string, unknown>,
  ctx: { conversationId?: string; toolCallId?: string; signal?: AbortSignal },
): Promise<{ success: boolean; data?: unknown; error?: string }> {
  const conversationId = ctx.conversationId;
  const state = conversationId ? FlowExecutor.conversationStates.get(conversationId) : undefined;
  if (!conversationId || !state || state.isCancelled || !ACTIVE.has(state.status ?? '')) {
    return { success: false, error: 'No active agent conversation.' };
  }
  try {
    await assertFlowExecutionCurrent(state);
    if (name === 'subflow_list') {
      return { success: true, data: { conversationId, agents: await familyOf(conversationId, state) } };
    }
    if (name === 'subflow_send_message') {
      const target = typeof args.target === 'string' ? args.target.trim() : '';
      const content = typeof args.message === 'string' ? args.message.trim() : '';
      if (!target || !content || content.length > 32000) return { success: false, error: 'Provide target and a non-empty message of at most 32000 characters.' };
      const recipient = await resolveRecipient(conversationId, state, target);
      if (!recipient) return { success: false, error: 'Recipient is not your parent or child in this workspace. Use subflow_list to discover recipients.' };
      const live = FlowExecutor.conversationStates.get(recipient.conversationId);
      // A durable task can be queued while its runFlow initializes. Its exact
      // preallocated conversation ID is already authorized by the task owner.
      const startingTask = !live && recipient.taskId ? await getTask(recipient.taskId) : undefined;
      if (live?.isCancelled || (!live && startingTask?.status !== 'working') || (live && !ACTIVE.has(live.status ?? ''))) {
        return { success: false, error: `Recipient is not running (status: ${recipient.status}). No message was queued.` };
      }
      const id = ctx.toolCallId
        ? `agent-${createHash('sha256').update(`${conversationId}:${ctx.toolCallId}`).digest('hex')}`
        : randomUUID();
      // Parent and child can share a Persona authority. Check the recipient
      // before taking the sender's commit lock to avoid recursively taking it.
      if (live) await assertFlowExecutionCurrent(live);
      await commitFlowDurableMutation(state, async () => {
        if (live?.isCancelled || (live && !ACTIVE.has(live.status ?? ''))) throw new Error('Recipient stopped before delivery.');
        const alreadyFolded = live?.messages.some(message => message.id === id);
        if (!alreadyFolded) enqueueSteeringMessage(recipient.conversationId, makeMessage(conversationId, recipient.conversationId, state, content, 'message', id));
      });
      return { success: true, data: { status: 'queued', messageId: id, recipientConversationId: recipient.conversationId, delivery: 'next_safe_boundary',
        ...(recipient.replyAvailability ? { replyAvailability: recipient.replyAvailability } : {}) } };
    }
    if (name === 'subflow_wait') {
      const target = typeof args.target === 'string' ? args.target.trim() : undefined;
      const recipient = target ? await resolveRecipient(conversationId, state, target) : undefined;
      if (target && !recipient) return { success: false, error: 'Recipient is not your parent or child in this workspace.' };
      if (recipient?.replyAvailability === 'after_child_returns') {
        return { success: false, error: 'Your parent is waiting for this synchronous subflow to return. Send your update and continue or return your result; waiting here cannot get a reply. Use background subflows for an ongoing exchange.' };
      }
      const timeoutMs = typeof args.timeoutMs === 'number' && Number.isFinite(args.timeoutMs)
        ? Math.max(0, Math.min(60000, args.timeoutMs)) : 30000;
      const deadline = Date.now() + timeoutMs;
      const initialAgents = await familyOf(conversationId, state);
      const watching = initialAgents.filter(agent => recipient
        ? agent.conversationId === recipient.conversationId
        : agent.relation === 'child' && (ACTIVE.has(agent.status) || agent.status === 'working'));
      // Poll only status; do not consume the inbox while the owning assistant
      // still has an unanswered tool call. runFlow/adapters own that boundary.
      while (true) {
        await assertFlowExecutionCurrent(state);
        if (ctx.signal?.aborted || state.executionAuthority?.signal.aborted || isCancelledByAncestry(conversationId, FlowExecutor.conversationStates)) return { success: false, error: 'Agent cancelled while waiting.' };
        const pending = peekSteeringMessages(conversationId);
        if (pending.length > 0) return { success: true, data: { reason: 'message', messageIds: pending.map(message => message.id) } };
        // Refresh only the selected records; scanning the workspace's complete
        // task history every 250 ms gets expensive for long-running installs.
        const agents = await Promise.all(watching.map(async agent => {
          const live = FlowExecutor.conversationStates.get(agent.conversationId);
          const task = agent.taskId ? await getTask(agent.taskId) : undefined;
          return { ...agent, status: task && TERMINAL_TASKS.has(task.status) ? task.status : live?.status ?? task?.status ?? 'unavailable' };
        }));
        if (agents.length === 0) return { success: true, data: { reason: 'no_children', agents } };
        if (agents.some(agent => !ACTIVE.has(agent.status) && agent.status !== 'working')) return { success: true, data: { reason: 'completed', agents } };
        if (Date.now() >= deadline) return { success: true, data: { reason: 'timeout', agents } };
        await new Promise<void>(resolve => setTimeout(bindToCurrentWorkspace(resolve), Math.min(250, deadline - Date.now())));
      }
    }
    return { success: false, error: `Unknown subflow communication tool: ${name}` };
  } catch (error) {
    rethrowFlowExecutionAuthorityError(error);
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}
