/** Retained release preflight; no native execution or provider call. */
import { NextRequest, NextResponse } from 'next/server';
import { GET } from '@/app/v1/personas/[personaId]/work-items/[workItemId]/source/route';
import { GoalSourceUnavailableError, readPersonaGoalSource } from '@/backend/services/enduringAgents/goalSourceRead';
import { getPersonaWorkItem } from '@/backend/services/enduringAgents/store';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { assertLocalRequest } from '@/utils/http/localRequest';

jest.mock('@/app/api/_workspace', () => ({ withWorkspaceRoute: (handler: unknown) => handler }));
jest.mock('@/backend/services/enduringAgents/store', () => ({ getPersonaWorkItem: jest.fn() }));
jest.mock('@/backend/services/enduringAgents/goalSourceRead', () => ({
  ...jest.requireActual('@/backend/services/enduringAgents/goalSourceRead'), readPersonaGoalSource: jest.fn(),
}));
jest.mock('@/utils/encryption/lockGate', () => ({ assertUnlocked: jest.fn() }));
jest.mock('@/utils/http/localRequest', () => ({ assertLocalRequest: jest.fn() }));
jest.mock('@/utils/logger', () => ({ createLogger: () => ({ error: jest.fn() }) }));
jest.mock('@/utils/workspace', () => ({ getCurrentWorkspace: () => 'workspace_one' }));
const request = () => new NextRequest('http://127.0.0.1:4200/v1/personas/persona_one/work-items/goal_one/source');
const context = (personaId = 'persona_one') => ({ params: Promise.resolve({ personaId, workItemId: 'goal_one' }) });
const source = () => ({ goalId: 'goal_one', goalVersion: 7, round: 1, activity: { id: 'activity_one' }, behaviorRevision: { id: 'revision_one' } });

beforeEach(() => {
  jest.resetAllMocks();
  jest.mocked(assertLocalRequest).mockReturnValue(null);
  jest.mocked(assertUnlocked).mockResolvedValue(null);
  (getPersonaWorkItem as jest.Mock).mockResolvedValue({ id: 'goal_one', personaId: 'persona_one', goal: {} });
  (readPersonaGoalSource as jest.Mock).mockResolvedValue(source());
});

it('requires strict local transport and unlock before source reads', async () => {
  jest.mocked(assertLocalRequest).mockReturnValueOnce(NextResponse.json({}, { status: 403 }));
  expect((await GET(request(), context())).status).toBe(403);
  expect(assertLocalRequest).toHaveBeenCalledWith(expect.anything(), { strictLoopback: true });
  expect(assertUnlocked).not.toHaveBeenCalled();
  jest.mocked(assertUnlocked).mockResolvedValueOnce(NextResponse.json({}, { status: 423 }));
  expect((await GET(request(), context())).status).toBe(423);
  expect(readPersonaGoalSource).not.toHaveBeenCalled();
});

it.each([null, { personaId: 'foreign', goal: {} }, { personaId: 'persona_one', parentGoalId: 'parent', goal: {} },
  { personaId: 'persona_one' }])('hides absent, foreign and child roots %p', async value => {
  (getPersonaWorkItem as jest.Mock).mockResolvedValue(value);
  expect((await GET(request(), context())).status).toBe(404);
  expect(readPersonaGoalSource).not.toHaveBeenCalled();
});

it('rejects path-invalid identity before storage', async () => {
  expect((await GET(request(), context('../foreign'))).status).toBe(404);
  expect(getPersonaWorkItem).not.toHaveBeenCalled();
});

it('returns a versioned no-store envelope and holds excessive frozen source size', async () => {
  const response = await GET(request(), context());
  expect(response.status).toBe(200);
  expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  expect(await response.json()).toEqual({ schema: 'flujo-goal-source/v1', workspaceId: 'workspace_one', personaId: 'persona_one', ...source() });
  (readPersonaGoalSource as jest.Mock).mockResolvedValue({ ...source(), activity: { instructionContext: 'é'.repeat(600_000) } });
  const held = await GET(request(), context());
  expect(held.status).toBe(413);
  expect((await held.text()).length).toBeLessThan(200);
});

it.each([[new GoalSourceUnavailableError('private source'), 409], [new Error('private failure'), 503]])(
  'holds unavailable source without disclosing private errors', async (error, status) => {
    (readPersonaGoalSource as jest.Mock).mockRejectedValue(error);
    const response = await GET(request(), context());
    expect(response.status).toBe(status);
    expect(await response.text()).not.toMatch(/private source|private failure/);
  },
);
