import { NextRequest, NextResponse } from 'next/server';

import { GET } from '@/app/v1/personas/[personaId]/work-items/[workItemId]/runtime/route';
import { getPersonaWorkItem } from '@/backend/services/enduringAgents/store';
import { readPersonaGoalRuntime } from '@/backend/services/enduringAgents/goalRuntimeRead';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { assertLocalRequest } from '@/utils/http/localRequest';

jest.mock('@/app/api/_workspace', () => ({ withWorkspaceRoute: (handler: unknown) => handler }));
jest.mock('@/backend/services/enduringAgents/store', () => ({ getPersonaWorkItem: jest.fn() }));
jest.mock('@/backend/services/enduringAgents/goalRuntimeRead', () => ({ readPersonaGoalRuntime: jest.fn() }));
jest.mock('@/utils/encryption/lockGate', () => ({ assertUnlocked: jest.fn() }));
jest.mock('@/utils/http/localRequest', () => ({ assertLocalRequest: jest.fn() }));
jest.mock('@/utils/logger', () => ({ createLogger: () => ({ error: jest.fn() }) }));
jest.mock('@/utils/workspace', () => ({ getCurrentWorkspace: () => 'runtime-owner' }));

const readItem = jest.mocked(getPersonaWorkItem);
const readRuntime = jest.mocked(readPersonaGoalRuntime);
const local = jest.mocked(assertLocalRequest);
const unlocked = jest.mocked(assertUnlocked);
const item = { id: 'goal_one', personaId: 'persona_owner', goal: { state: 'active' } };
const request = () => new NextRequest('http://localhost:4200/v1/personas/persona_owner/work-items/goal_one/runtime');
const context = (personaId = 'persona_owner', workItemId = 'goal_one') => ({ params: Promise.resolve({ personaId, workItemId }) });

beforeEach(() => {
  jest.resetAllMocks();
  local.mockReturnValue(null);
  unlocked.mockResolvedValue(null);
  readItem.mockResolvedValue(item as Awaited<ReturnType<typeof getPersonaWorkItem>>);
  readRuntime.mockResolvedValue({ goal: { id: 'goal_one' }, state: 'unverified', verified: false,
    reason: 'snapshot_changed' } as Awaited<ReturnType<typeof readPersonaGoalRuntime>>);
});

it('holds transport and lock failures before any native read', async () => {
  local.mockReturnValueOnce(NextResponse.json({ error: 'forbidden' }, { status: 403 }));
  expect((await GET(request(), context())).status).toBe(403);
  expect(local).toHaveBeenCalledWith(expect.anything(), { strictLoopback: true });
  expect(unlocked).not.toHaveBeenCalled();
  unlocked.mockResolvedValueOnce(NextResponse.json({ error: 'locked' }, { status: 423 }));
  expect((await GET(request(), context())).status).toBe(423);
  expect(readItem).not.toHaveBeenCalled();
  expect(readRuntime).not.toHaveBeenCalled();
});

it.each([null, { ...item, personaId: 'persona_other' }, { ...item, parentGoalId: 'goal_parent' },
  { ...item, goal: undefined }])('hides missing, foreign and non-root Goals: %p', async value => {
  readItem.mockResolvedValueOnce(value as Awaited<ReturnType<typeof getPersonaWorkItem>>);
  const response = await GET(request(), context());
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ error: 'Goal not found.' });
  expect(readRuntime).not.toHaveBeenCalled();
});

it('rejects invalid IDs without reading storage', async () => {
  expect((await GET(request(), context('../foreign'))).status).toBe(404);
  expect(readItem).not.toHaveBeenCalled();
});

it('returns the engine projection without promoting unverified evidence', async () => {
  const response = await GET(request(), context());
  expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  expect(readRuntime).toHaveBeenCalledWith('persona_owner', 'goal_one');
  expect(await response.json()).toEqual({ schema: 'flujo-goal-runtime/v1', workspaceId: 'runtime-owner',
    personaId: 'persona_owner', runtime: { goal: { id: 'goal_one' }, state: 'unverified',
      verified: false, reason: 'snapshot_changed' } });
});

it('holds an engine/read failure without returning raw storage or error text', async () => {
  readRuntime.mockRejectedValueOnce(new Error('private-runtime-context'));
  const response = await GET(request(), context());
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: 'Goal runtime is unavailable.' });
});
