/**
 * Tests for GET /api/runs/active (issue #113).
 *
 * FlowExecutor.conversationStates is mocked with a real in-memory Map (the
 * route reads from it); flowService.getFlow is stubbed for name resolution;
 * assertUnlocked is stubbed to the unlocked path. The route's own logic —
 * filter to non-terminal statuses, project metadata-only, never leak prompt /
 * messages / variables — runs for real.
 */
const assertUnlockedMock = jest.fn(async () => null);
jest.mock('@/utils/encryption/lockGate', () => ({
  assertUnlocked: (...a: unknown[]) => assertUnlockedMock(...(a as [])),
}));

const conversationStates = new Map<string, unknown>();
jest.mock('@/backend/execution/flow/FlowExecutor', () => ({
  FlowExecutor: {
    get conversationStates() {
      return conversationStates;
    },
  },
}));

const getFlowMock = jest.fn(async (id: string) => ({ id, name: `Flow ${id}` }));
jest.mock('@/backend/services/flow', () => ({
  flowService: { getFlow: (...a: unknown[]) => getFlowMock(...(a as [string])) },
}));

import { GET } from '@/app/api/runs/active/route';

const makeState = (overrides: Record<string, unknown> = {}) => ({
  conversationId: 'conv-1',
  flowId: 'flow-1',
  status: 'running',
  createdAt: 1_700_000_000_000,
  source: 'api',
  // Sensitive fields that must NEVER be projected into the response.
  messages: [{ role: 'user', content: 'secret prompt text' }],
  variables: { API_KEY: 'super-secret' },
  lastResponse: 'confidential output',
  ...overrides,
});

beforeEach(() => {
  assertUnlockedMock.mockReset().mockResolvedValue(null);
  getFlowMock.mockReset().mockImplementation(async (id: string) => ({ id, name: `Flow ${id}` }));
  conversationStates.clear();
});

describe('active runs route', () => {
  it('returns an empty list when nothing is running', async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ runs: [] });
  });

  it('lists an in-flight run with metadata only and no sensitive fields', async () => {
    conversationStates.set('conv-1', makeState());
    const response = await GET();
    const body = await response.json();

    expect(body.runs).toHaveLength(1);
    const run = body.runs[0];
    expect(run).toEqual({
      conversationId: 'conv-1',
      flowId: 'flow-1',
      flowName: 'Flow flow-1',
      status: 'running',
      startedAt: new Date(1_700_000_000_000).toISOString(),
      source: 'api',
    });

    // Hard guarantee: no prompt/messages/variables/output leaked.
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('secret prompt text');
    expect(serialized).not.toContain('super-secret');
    expect(serialized).not.toContain('confidential output');
    expect(run.messages).toBeUndefined();
    expect(run.variables).toBeUndefined();
  });

  it('excludes terminal runs (completed / error) and includes parked ones', async () => {
    conversationStates.set('running', makeState({ conversationId: 'running', status: 'running' }));
    conversationStates.set('approval', makeState({ conversationId: 'approval', status: 'awaiting_tool_approval' }));
    conversationStates.set('debug', makeState({ conversationId: 'debug', status: 'paused_debug' }));
    conversationStates.set('done', makeState({ conversationId: 'done', status: 'completed' }));
    conversationStates.set('err', makeState({ conversationId: 'err', status: 'error' }));

    const response = await GET();
    const body = await response.json();
    const ids = body.runs.map((r: { conversationId: string }) => r.conversationId).sort();
    expect(ids).toEqual(['approval', 'debug', 'running']);
  });

  it('reports source per run and surfaces plannedExecutionId for scheduled runs', async () => {
    conversationStates.set('sched', makeState({
      conversationId: 'sched',
      source: 'schedule',
      plannedExecutionId: 'pkg--demo',
    }));
    conversationStates.set('api', makeState({ conversationId: 'api', source: 'api' }));

    const response = await GET();
    const body = await response.json();
    const byId = Object.fromEntries(
      body.runs.map((r: { conversationId: string }) => [r.conversationId, r])
    );
    expect(byId.sched.source).toBe('schedule');
    expect(byId.sched.plannedExecutionId).toBe('pkg--demo');
    expect(byId.api.source).toBe('api');
    expect(byId.api.plannedExecutionId).toBeUndefined();
  });

  it('returns the 423 lock response when the store is locked', async () => {
    const locked = new Response(JSON.stringify({ error: 'encryption_locked' }), { status: 423 });
    assertUnlockedMock.mockResolvedValueOnce(locked as never);
    const response = await GET();
    expect(response.status).toBe(423);
  });
});
