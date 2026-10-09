/**
 * MCP Tasks extension — wire-contract guards (issue #404).
 *
 * These cover the strict classification rules that keep classic synchronous
 * tool calls working: only a schema-valid task object starts a task lifecycle,
 * and a normal tool payload that merely contains a `task` key never does.
 */

import {
  classifyToolCallResult,
  clampPollIntervalMs,
  computeTaskExpiresAt,
  isTerminalMcpTaskStatus,
  parseCreateTaskResult,
  parseMcpTask,
  parseTaskStatusResult,
  parseModernTask,
  relatedTaskIdOf,
  MCP_RELATED_TASK_META_KEY,
} from '@/shared/types/mcp/tasks';
import {
  isLegalRemoteTaskTransition,
  DEFAULT_MCP_REMOTE_TASK_SETTINGS,
} from '@/shared/types/mcp/taskRecords';

const validTask = {
  taskId: 'task-1',
  status: 'working',
  ttl: 60_000,
  createdAt: '2026-01-01T00:00:00.000Z',
  lastUpdatedAt: '2026-01-01T00:00:00.000Z',
  pollInterval: 2_000,
};

describe('pinned modern Tasks wire contract', () => {
  const modern = { taskId: 'modern-1', status: 'working', ttlMs: 60_000, pollIntervalMs: 2000,
    createdAt: '2026-10-09T10:00:00.000Z', lastUpdatedAt: '2026-10-09T10:00:00.000Z' };
  it('accepts flat creation only under explicit negotiation', () => {
    const wire = { ...modern, resultType: 'task' };
    expect(classifyToolCallResult(wire, { taskRequested: true })).toMatchObject({
      kind: 'task', task: { taskId: modern.taskId, protocolVersion: '2026-07-28', ttl: 60000, pollInterval: 2000 },
    });
    expect(classifyToolCallResult(wire, { taskRequested: false }).kind).toBe('protocol-invalid');
    expect(parseModernTask({ resultType: 'task', task: modern }, true).ok).toBe(false);
  });
  it('validates terminal results, errors and input before lifecycle dispatch', () => {
    expect(parseModernTask({ ...modern, resultType: 'complete', status: 'completed' }).ok).toBe(false);
    expect(parseModernTask({ ...modern, resultType: 'complete', status: 'completed', result: { content: [] } })).toMatchObject({
      ok: true, task: { result: { content: [] } },
    });
    expect(parseModernTask({ ...modern, resultType: 'complete', status: 'failed', error: { code: -32000, message: 'Failure', data: { retryable: true } } })).toMatchObject({
      ok: true, task: { error: { code: -32000, message: 'Failure', data: { retryable: true } } },
    });
    expect(parseModernTask({ ...modern, resultType: 'complete', status: 'input_required', inputRequests: {
      bad: { method: 'elicitation/create', params: { message: 'Input', requestedSchema: true } },
    } }).ok).toBe(false);
  });
  it('honors creation-based expiry and rejects invalid dates', () => {
    const parsed = parseModernTask({ ...modern, resultType: 'task' }, true);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(computeTaskExpiresAt(parsed.task, Date.parse(modern.createdAt) + 40000, 3600000))
      .toBe(Date.parse(modern.createdAt) + 60000);
    expect(parseModernTask({ ...modern, resultType: 'task', createdAt: 'invalid' }, true).ok).toBe(false);
  });
});

describe('parseMcpTask', () => {
  it('accepts a spec-shaped task', () => {
    const parsed = parseMcpTask(validTask);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.task.taskId).toBe('task-1');
      expect(parsed.task.pollInterval).toBe(2_000);
    }
  });

  it('accepts a minimal task (only taskId + status)', () => {
    expect(parseMcpTask({ taskId: 't', status: 'completed' }).ok).toBe(true);
  });

  it('rejects an unknown status', () => {
    expect(parseMcpTask({ taskId: 't', status: 'running' }).ok).toBe(false);
  });

  it('rejects wrongly-typed known fields', () => {
    expect(parseMcpTask({ taskId: 't', status: 'working', pollInterval: 'soon' }).ok).toBe(false);
    expect(parseMcpTask({ taskId: 't', status: 'working', ttl: -1 }).ok).toBe(false);
    expect(parseMcpTask({ taskId: 1, status: 'working' }).ok).toBe(false);
  });

  it('bounds untrusted status text', () => {
    const parsed = parseMcpTask({
      taskId: 't',
      status: 'failed',
      statusMessage: 'x'.repeat(5_000),
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect((parsed.task.statusMessage ?? '').length).toBeLessThanOrEqual(501);
  });
});

describe('parseCreateTaskResult / parseTaskStatusResult', () => {
  it('parses a nested CreateTaskResult', () => {
    expect(parseCreateTaskResult({ task: validTask }).ok).toBe(true);
  });

  it('rejects a result without a task field', () => {
    expect(parseCreateTaskResult({ content: [] }).ok).toBe(false);
  });

  it('accepts both the top-level (tasks/get) and nested task shapes', () => {
    expect(parseTaskStatusResult(validTask).ok).toBe(true);
    expect(parseTaskStatusResult({ task: validTask }).ok).toBe(true);
  });
});

describe('classifyToolCallResult', () => {
  it('treats a classic CallToolResult as classic', () => {
    expect(
      classifyToolCallResult({ content: [{ type: 'text', text: 'hi' }] }, { taskRequested: false }),
    ).toEqual({ kind: 'classic' });
  });

  it('never reinterprets a tool payload that merely contains a task key', () => {
    const result = classifyToolCallResult(
      { content: [{ type: 'text', text: 'hi' }], task: validTask },
      { taskRequested: true },
    );
    expect(result).toEqual({ kind: 'classic' });
  });

  it('enters the lifecycle for a schema-valid task result', () => {
    const result = classifyToolCallResult({ task: validTask }, { taskRequested: true });
    expect(result.kind).toBe('task');
  });

  it('reports a malformed task as a protocol violation', () => {
    const result = classifyToolCallResult(
      { task: { taskId: 'x', status: 'nope' } },
      { taskRequested: true },
    );
    expect(result.kind).toBe('protocol-invalid');
  });

  it('flags an empty answer to a task-augmented request', () => {
    expect(classifyToolCallResult({}, { taskRequested: true }).kind).toBe('protocol-invalid');
    expect(classifyToolCallResult({}, { taskRequested: false }).kind).toBe('classic');
  });
});

describe('protective bounds', () => {
  it('clamps untrusted poll intervals', () => {
    const bounds = {
      minMs: DEFAULT_MCP_REMOTE_TASK_SETTINGS.minPollIntervalMs,
      maxMs: DEFAULT_MCP_REMOTE_TASK_SETTINGS.maxPollIntervalMs,
      defaultMs: DEFAULT_MCP_REMOTE_TASK_SETTINGS.defaultPollIntervalMs,
    };
    expect(clampPollIntervalMs(1, bounds)).toBe(bounds.minMs);
    expect(clampPollIntervalMs(10_000_000, bounds)).toBe(bounds.maxMs);
    expect(clampPollIntervalMs(undefined, bounds)).toBe(bounds.defaultMs);
  });

  it('honours ttl: null as "no expiry" and falls back when ttl is absent', () => {
    expect(computeTaskExpiresAt({ taskId: 't', status: 'working', ttl: null }, 1_000, 5_000)).toBeUndefined();
    expect(computeTaskExpiresAt({ taskId: 't', status: 'working' }, 1_000, 5_000)).toBe(6_000);
    expect(computeTaskExpiresAt({ taskId: 't', status: 'working', ttl: 2_000 }, 1_000, 5_000)).toBe(3_000);
  });
});

describe('record transitions', () => {
  it('keeps terminal states immutable', () => {
    expect(isLegalRemoteTaskTransition('working', 'completed')).toBe(true);
    expect(isLegalRemoteTaskTransition('input_required', 'working')).toBe(true);
    expect(isLegalRemoteTaskTransition('completed', 'cancelled')).toBe(false);
    expect(isLegalRemoteTaskTransition('cancelled', 'completed')).toBe(false);
  });

  it('agrees with the terminal-status helper', () => {
    expect(isTerminalMcpTaskStatus('working')).toBe(false);
    expect(isTerminalMcpTaskStatus('input_required')).toBe(false);
    expect(isTerminalMcpTaskStatus('failed')).toBe(true);
  });
});

describe('related-task metadata', () => {
  it('extracts the related task id used by input_required elicitations', () => {
    expect(relatedTaskIdOf({ [MCP_RELATED_TASK_META_KEY]: { taskId: 'abc' } })).toBe('abc');
    expect(relatedTaskIdOf({ [MCP_RELATED_TASK_META_KEY]: {} })).toBeUndefined();
    expect(relatedTaskIdOf(undefined)).toBeUndefined();
  });
});
