/**
 * Issue #259 — the synthetic `todo` tool: a run-scoped task list a model can
 * create/maintain across a multi-turn node visit.
 *
 * Pins:
 *  - buildTodoTool exposes a deterministic definition (fixed name/description/
 *    schema) so the #89 prefix-cache stays stable;
 *  - normalizeTodos validates items, defaults bad statuses to 'pending', and
 *    preserves id/createdAt for items whose content matches an existing entry
 *    (so a status flip doesn't churn ids the live view keys on);
 *  - executeTodoTool replaces the list on the LIVE SharedState, emits a
 *    `todo:update` event carrying the FULL list, and reports done/total;
 *  - a missing conversation / missing live state degrades to a tool-error;
 *  - formatTodoBlock renders a compact, stable checklist.
 */

import type { SharedState } from '@/backend/execution/flow/types';

// The executor reads the LIVE SharedState via FlowExecutor.conversationStates
// (a lazy require inside todoTool). Mock it with a Map we control.
const mockStates = new Map<string, Partial<SharedState>>();
jest.mock('@/backend/execution/flow/FlowExecutor', () => ({
  FlowExecutor: {
    get conversationStates() {
      return mockStates;
    },
  },
}));

import {
  buildTodoTool,
  executeTodoTool,
  isTodoToolName,
  normalizeTodos,
  formatTodoBlock,
  TODO_TOOL_NAME,
} from '@/backend/execution/flow/handlers/todoTool';
import type { RawExecutionEvent } from '@/shared/types/execution/events';

beforeEach(() => {
  mockStates.clear();
});

describe('buildTodoTool / isTodoToolName', () => {
  it('exposes a deterministic `todo` tool with an items array schema', () => {
    const tool = buildTodoTool();
    expect(tool.name).toBe(TODO_TOOL_NAME);
    expect(tool.name).toBe('todo');
    expect(tool.inputSchema.required).toEqual(['items']);
    const items = (tool.inputSchema.properties as any).items;
    expect(items.type).toBe('array');
    expect(items.items.properties.status.enum).toEqual([
      'pending',
      'in_progress',
      'done',
      'cancelled',
    ]);
    // Deterministic: two builds are byte-identical (prefix-cache stability).
    expect(JSON.stringify(buildTodoTool())).toBe(JSON.stringify(buildTodoTool()));
  });

  it('recognises only the todo tool name', () => {
    expect(isTodoToolName('todo')).toBe(true);
    expect(isTodoToolName('write_resource')).toBe(false);
  });
});

describe('normalizeTodos', () => {
  it('normalizes items and defaults invalid status to pending', () => {
    const res = normalizeTodos(undefined, [
      { content: 'a', status: 'in_progress' },
      { content: 'b', status: 'bogus' },
    ], 1000);
    if ('error' in res) throw new Error(res.error);
    expect(res.todos).toHaveLength(2);
    expect(res.todos[0]).toMatchObject({ content: 'a', status: 'in_progress', createdAt: 1000, updatedAt: 1000 });
    expect(res.todos[1].status).toBe('pending');
    expect(res.todos[0].id).toBeTruthy();
  });

  it('preserves id/createdAt for items whose content matches an existing entry', () => {
    const first = normalizeTodos(undefined, [{ content: 'task one', status: 'pending' }], 1000);
    if ('error' in first) throw new Error(first.error);
    const prev = first.todos;
    const second = normalizeTodos(prev, [{ content: 'task one', status: 'done' }], 2000);
    if ('error' in second) throw new Error(second.error);
    expect(second.todos[0].id).toBe(prev[0].id);
    expect(second.todos[0].createdAt).toBe(1000);
    expect(second.todos[0].updatedAt).toBe(2000);
    expect(second.todos[0].status).toBe('done');
  });

  it('rejects a non-array items and empty content', () => {
    expect('error' in normalizeTodos(undefined, 'nope' as unknown)).toBe(true);
    expect('error' in normalizeTodos(undefined, [{ content: '  ', status: 'pending' }])).toBe(true);
  });
});

describe('formatTodoBlock', () => {
  it('renders a compact checklist with a done/total header', () => {
    const block = formatTodoBlock([
      { id: '1', content: 'done one', status: 'done', createdAt: 0, updatedAt: 0 },
      { id: '2', content: 'todo two', status: 'pending', createdAt: 0, updatedAt: 0 },
    ]);
    expect(block).toContain('1 of 2 done');
    expect(block).toContain('[x] done one');
    expect(block).toContain('[ ] todo two');
  });

  it('is empty for an empty/undefined list', () => {
    expect(formatTodoBlock(undefined)).toBe('');
    expect(formatTodoBlock([])).toBe('');
  });
});

describe('executeTodoTool', () => {
  it('replaces the list on the live SharedState and emits todo:update with the full list', async () => {
    mockStates.set('conv1', { todos: undefined });
    const emit = jest.fn();
    const outcome = await executeTodoTool(
      { items: [{ content: 'a', status: 'done' }, { content: 'b', status: 'pending' }] },
      { conversationId: 'conv1', emit },
    );
    expect(outcome.success).toBe(true);
    expect(outcome.data).toMatchObject({ updated: true, total: 2, done: 1 });

    // Mutated the live state.
    expect(mockStates.get('conv1')!.todos).toHaveLength(2);

    // Emitted the FULL current list (not a delta).
    const evt = emit.mock.calls
      .map((c) => c[0] as RawExecutionEvent)
      .find((e) => e.type === 'todo:update') as any;
    expect(evt).toBeTruthy();
    expect(evt.todos).toHaveLength(2);
    expect(evt.todos[0].content).toBe('a');
  });

  it('degrades to a tool-error when no conversation / no live state', async () => {
    const noConv = await executeTodoTool({ items: [] }, {});
    expect(noConv.success).toBe(false);

    const noState = await executeTodoTool({ items: [] }, { conversationId: 'missing' });
    expect(noState.success).toBe(false);
  });
});
