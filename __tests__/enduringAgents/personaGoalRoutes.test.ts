const createWorkItemMock = jest.fn();
const updateWorkItemMock = jest.fn();
const getWorkItemMock = jest.fn();
const assertLocalRequestMock = jest.fn();
const assertUnlockedMock = jest.fn();

jest.mock('@/app/api/_workspace', () => ({ withWorkspaceRoute: (handler: unknown) => handler }));
jest.mock('@/utils/http/localRequest', () => ({ assertLocalRequest: (...args: unknown[]) => assertLocalRequestMock(...args) }));
jest.mock('@/utils/encryption/lockGate', () => ({ assertUnlocked: (...args: unknown[]) => assertUnlockedMock(...args) }));
jest.mock('@/utils/logger', () => ({ createLogger: () => ({ error: jest.fn() }) }));
jest.mock('@/backend/services/enduringAgents', () => ({
  ...jest.requireActual('@/backend/services/enduringAgents'),
  createPersonaWorkItem: (...args: unknown[]) => createWorkItemMock(...args),
  updatePersonaWorkItem: (...args: unknown[]) => updateWorkItemMock(...args),
  getPersonaWorkItem: (...args: unknown[]) => getWorkItemMock(...args),
}));

import { NextRequest, NextResponse } from 'next/server';
import { POST } from '@/app/v1/personas/[personaId]/work-items/route';
import { GET, PATCH } from '@/app/v1/personas/[personaId]/work-items/[workItemId]/route';

function request(method: string, body?: unknown) {
  return new NextRequest('http://localhost:4200/v1/personas/persona_frederik/work-items/work_marketing', {
    method,
    headers: { host: 'localhost:4200', 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
const context = { params: Promise.resolve({ personaId: 'persona_frederik', workItemId: 'work_marketing' }) };

beforeEach(() => {
  jest.clearAllMocks();
  assertLocalRequestMock.mockReturnValue(null);
  assertUnlockedMock.mockResolvedValue(null);
  createWorkItemMock.mockImplementation(async (input: unknown) => input);
  updateWorkItemMock.mockImplementation(async (_personaId: string, _workId: string, input: unknown) => input);
});

it('accepts ongoing ownership configuration with a client recovery id in the URL persona scope', async () => {
  const response = await POST(request('POST', {
    id: 'work_marketing', personaId: 'persona_foreign', title: 'Make FLUJO known',
    goal: { successCriteria: 'An ongoing audience with measurable growth', continuationIntervalMs: 60_000, maxRounds: 12 },
  }), context);
  expect(response.status).toBe(201);
  expect(createWorkItemMock).toHaveBeenCalledWith({
    id: 'work_marketing', personaId: 'persona_frederik', title: 'Make FLUJO known',
    goal: { successCriteria: 'An ongoing audience with measurable growth', continuationIntervalMs: 60_000, maxRounds: 12 },
  });
});

it.each([
  { successCriteria: 'Grow awareness', continuationIntervalMs: 1 },
  { successCriteria: 'Grow awareness', maxRounds: 0 },
  { successCriteria: 'Grow awareness', state: 'completed' },
  { successCriteria: 'Grow awareness', pendingAttemptKey: 'forged' },
])('rejects invalid configuration or forged controller state before starting work: %j', async (goal) => {
  expect((await POST(request('POST', { title: 'Make FLUJO known', goal }), context)).status).toBe(400);
  expect(createWorkItemMock).not.toHaveBeenCalled();
});

it('allows changing a goal budget with a revision check but rejects controller-state edits', async () => {
  const response = await PATCH(request('PATCH', { expectedUpdatedAt: 42, goal: { maxRounds: null, continuationIntervalMs: 120_000 } }), context);
  expect(response.status).toBe(200);
  expect(updateWorkItemMock).toHaveBeenCalledWith('persona_frederik', 'work_marketing', {
    expectedUpdatedAt: 42, goal: { maxRounds: null, continuationIntervalMs: 120_000 },
  });
  updateWorkItemMock.mockClear();
  expect((await PATCH(request('PATCH', { goal: { rounds: 0, state: 'active' } }), context)).status).toBe(400);
  expect(updateWorkItemMock).not.toHaveBeenCalled();
});

it('allows recovering a committed client id without exposing another persona work item', async () => {
  getWorkItemMock.mockResolvedValueOnce({ id: 'work_marketing', personaId: 'persona_frederik' });
  expect((await GET(request('GET'), context)).status).toBe(200);
  getWorkItemMock.mockResolvedValueOnce({ id: 'work_marketing', personaId: 'persona_foreign' });
  expect((await GET(request('GET'), context)).status).toBe(404);
});

it('keeps local access and unlock checks ahead of autonomous creation', async () => {
  assertLocalRequestMock.mockReturnValueOnce(NextResponse.json({ error: 'Local only' }, { status: 403 }));
  expect((await POST(request('POST', { title: 'Make FLUJO known' }), context)).status).toBe(403);
  expect(assertUnlockedMock).not.toHaveBeenCalled();
  assertUnlockedMock.mockResolvedValueOnce(NextResponse.json({ error: 'Locked' }, { status: 423 }));
  expect((await POST(request('POST', { title: 'Make FLUJO known' }), context)).status).toBe(423);
  expect(createWorkItemMock).not.toHaveBeenCalled();
});
