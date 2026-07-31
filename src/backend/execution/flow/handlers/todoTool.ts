import { createLogger } from '@/utils/logger';
import { ToolDefinition, TodoItem, TodoStatus } from '../types';
import { EmitFn, NodeRef } from '@/shared/types/execution/events';

/**
 * The synthetic `todo` tool (issue #259).
 *
 * Lets a model maintain a RUN-SCOPED task list during long agentic runs, so
 * intent is externalized as structured state instead of re-derived from a
 * compacting history, and the live view can render a "3 of 7 done" checklist.
 * Same synthetic-tool mechanism as `write_resource` / `read_resource`
 * (runResourceTools.ts) and `question` (runQuestionTool.ts): a deterministic
 * ToolDefinition, offered only when a Process node opts in
 * (`node_params.properties.enableTodoTool`), dispatched by name in both tool
 * loops (ModelHandler.processToolCalls for the request/response path, and via
 * `localToolExecutors` for the self-orchestrating Claude-subscription/Codex
 * adapters).
 *
 * State lives on `SharedState.todos` (a plain JSON-serializable field), which
 * gives us for free: disk persistence (persistConversationState), survival
 * across wire-only compaction (compaction never touches SharedState), per-turn
 * re-injection into the system prompt by ProcessNode.prep, and NON-inheritance
 * by spawned workers (child runs start with fresh SharedState — `todos` stays
 * undefined). The executor reads/mutates the LIVE in-memory SharedState via
 * FlowExecutor.conversationStates (a lazy require, mirroring
 * ModelHandler.isConversationCancelled) so both tool loops — neither of which
 * holds a SharedState reference — can update the same list.
 *
 * Following opencode's `todowrite`, the tool REPLACES the whole list in one
 * call (simpler and more robust than incremental ops). `id`/`createdAt` are
 * preserved for items whose `content` matches an existing entry.
 */

const log = createLogger('backend/flow/execution/handlers/todoTool');

export const TODO_TOOL_NAME = 'todo';

const TODO_STATUSES: TodoStatus[] = ['pending', 'in_progress', 'done', 'cancelled'];

/** True for the synthetic `todo` tool (dispatched here, not via mcpService). */
export function isTodoToolName(name: string): boolean {
  return name === TODO_TOOL_NAME;
}

/**
 * The `todo` tool definition. Deterministic (fixed name / description / schema,
 * no per-run interpolation) so, once offered, the tool set stays byte-identical
 * turn to turn (preserving the #89 provider prefix-cache).
 */
export function buildTodoTool(): ToolDefinition {
  return {
    name: TODO_TOOL_NAME,
    description:
      'Create and maintain a structured task list for the current session/run. ' +
      'Call this to write the FULL, updated list of tasks — each call REPLACES the previous list, so ' +
      'always include every task (not just the changed one). ' +
      'Keep task statuses current as you work: mark a task "in_progress" when you start it and "done" the ' +
      'moment you finish it, so the user can see live progress. Use "cancelled" for tasks you decide to skip. ' +
      'Use this for multi-step work to externalize your plan; skip it for a single trivial step.',
    inputSchema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          description: 'The full, updated task list (replaces the previous list).',
          items: {
            type: 'object',
            properties: {
              content: {
                type: 'string',
                description: 'A short description of the task.',
              },
              status: {
                type: 'string',
                enum: TODO_STATUSES,
                description: 'The current status of the task.',
              },
            },
            required: ['content', 'status'],
          },
        },
      },
      required: ['items'],
    },
  };
}

/**
 * Normalize the raw tool args into a validated todo list, preserving `id` and
 * `createdAt` for items whose (trimmed) `content` matches an existing entry so
 * a status update doesn't churn ids the live view keys on.
 */
export function normalizeTodos(
  existing: TodoItem[] | undefined,
  rawItems: unknown,
  now: number = Date.now(),
): { todos: TodoItem[] } | { error: string } {
  if (!Array.isArray(rawItems)) {
    return { error: 'todo requires an "items" array.' };
  }
  const byContent = new Map<string, TodoItem>();
  for (const prev of existing ?? []) byContent.set(prev.content, prev);

  const todos: TodoItem[] = [];
  for (const item of rawItems) {
    const it = item as { content?: unknown; status?: unknown };
    const content = typeof it.content === 'string' ? it.content.trim() : '';
    if (!content) return { error: 'each todo item requires a non-empty "content".' };
    const status: TodoStatus = TODO_STATUSES.includes(it.status as TodoStatus)
      ? (it.status as TodoStatus)
      : 'pending';
    const prev = byContent.get(content);
    todos.push({
      id: prev?.id ?? crypto.randomUUID(),
      content,
      status,
      createdAt: prev?.createdAt ?? now,
      updatedAt: now,
    });
  }
  return { todos };
}

/**
 * Render a compact, stable checklist block for per-turn injection into the
 * system prompt. Small and deterministic; the list is expected to be short.
 */
export function formatTodoBlock(todos: TodoItem[] | undefined): string {
  if (!todos || todos.length === 0) return '';
  const mark = (s: TodoStatus): string =>
    s === 'done' ? '[x]' : s === 'in_progress' ? '[~]' : s === 'cancelled' ? '[-]' : '[ ]';
  const lines = todos.map((t) => `${mark(t.status)} ${t.content}`);
  const done = todos.filter((t) => t.status === 'done').length;
  return `## Current task list (${done} of ${todos.length} done)\n${lines.join('\n')}`;
}

export interface TodoToolContext {
  /** Owning conversation — the list is scoped to it. Absent ⇒ refused. */
  conversationId?: string;
  /** The updating process node (carried on the emitted event for the live view). */
  node?: NodeRef;
  emit?: EmitFn;
}

export interface TodoToolOutcome {
  success: boolean;
  data?: unknown;
  error?: string;
}

/**
 * Read the LIVE in-memory SharedState for a conversation. Lazy require to avoid
 * the static import cycle (FlowExecutor -> ProcessNode -> ModelHandler ->
 * todoTool), mirroring ModelHandler.isConversationCancelled.
 */
function getLiveSharedState(conversationId: string): { todos?: TodoItem[] } | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { FlowExecutor } = require('@/backend/execution/flow/FlowExecutor');
    return FlowExecutor.conversationStates.get(conversationId);
  } catch (err) {
    log.warn('Could not resolve live SharedState for todo update', { conversationId, err });
    return undefined;
  }
}

/**
 * Execute a `todo` tool call: replace the run-scoped list on the live
 * SharedState and emit a `todo:update` event carrying the FULL current list.
 * Never throws — always resolves to an outcome the caller turns into a
 * tool-result message.
 */
export async function executeTodoTool(
  args: Record<string, unknown>,
  ctx: TodoToolContext,
): Promise<TodoToolOutcome> {
  if (!ctx.conversationId) {
    return { success: false, error: 'The todo tool is not available in this run.' };
  }
  const state = getLiveSharedState(ctx.conversationId);
  if (!state) {
    return { success: false, error: 'The todo list is not available in this run.' };
  }
  const normalized = normalizeTodos(state.todos, args?.items);
  if ('error' in normalized) {
    return { success: false, error: normalized.error };
  }
  state.todos = normalized.todos;

  ctx.emit?.({
    type: 'todo:update',
    node: ctx.node,
    todos: normalized.todos,
  });

  const done = normalized.todos.filter((t) => t.status === 'done').length;
  log.info('todo list updated', {
    conversationId: ctx.conversationId,
    count: normalized.todos.length,
    done,
  });
  return {
    success: true,
    data: {
      updated: true,
      total: normalized.todos.length,
      done,
      todos: normalized.todos,
    },
  };
}
