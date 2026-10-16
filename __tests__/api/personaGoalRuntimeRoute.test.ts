import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { GET } from '@/app/v1/personas/[personaId]/work-items/[workItemId]/runtime/route';
import { getPersonaWorkItem } from '@/backend/services/enduringAgents/store';
import { readPersonaGoalRuntime } from '@/backend/services/enduringAgents/goalRuntimeRead';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { assertLocalRequest } from '@/utils/http/localRequest';
import { getLegacyCollectionItemPath, getShardedCollectionItemPath, loadShardedCollectionItem } from '@/utils/storage/backend';
import { PersonaShardIdentityError } from '@/utils/storage/personaShardIdentity';

jest.mock('@/app/api/_workspace', () => ({ withWorkspaceRoute: (handler: unknown) => handler }));
jest.mock('@/backend/services/enduringAgents/store', () => ({ getPersonaWorkItem: jest.fn() }));
jest.mock('@/backend/services/enduringAgents/goalRuntimeRead', () => ({ readPersonaGoalRuntime: jest.fn() }));
jest.mock('@/utils/encryption/lockGate', () => ({ assertUnlocked: jest.fn() }));
jest.mock('@/utils/http/localRequest', () => ({ assertLocalRequest: jest.fn() }));
jest.mock('@/utils/logger', () => ({ createLogger: () => ({ error: jest.fn() }) }));
jest.mock('@/utils/workspace', () => ({
  ...jest.requireActual('@/utils/workspace'),
  getCurrentWorkspace: () => 'runtime-owner',
  getWorkspaceDataDir: () => process.env.FLUJO_DATA_DIR,
}));

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

it.each(['legacy', 'sharded'] as const)('hides a foreign %s Goal rejected by the actual storage reader', async layout => {
  const foreign = { ...item, id: `${layout}_foreign`, personaId: 'persona_other' };
  const filename = layout === 'legacy'
    ? getLegacyCollectionItemPath('persona-work-items', foreign.id)
    : getShardedCollectionItemPath('persona-work-items', 'persona_owner', foreign.id);
  await fs.mkdir(path.dirname(filename), { recursive: true });
  await fs.writeFile(filename, JSON.stringify(foreign));
  readItem.mockImplementationOnce((personaId, id) => loadShardedCollectionItem(
    'persona-work-items', personaId, id, null,
  ));
  const response = await GET(request(), context('persona_owner', foreign.id));
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ error: 'Goal not found.' });
  expect(readRuntime).not.toHaveBeenCalled();
});

it('keeps malformed storage unavailable without returning its contents', async () => {
  const filename = getLegacyCollectionItemPath('persona-work-items', 'malformed_goal');
  await fs.mkdir(path.dirname(filename), { recursive: true });
  await fs.writeFile(filename, '{"private-context":');
  readItem.mockImplementationOnce((personaId, id) => loadShardedCollectionItem(
    'persona-work-items', personaId, id, null,
  ));
  const response = await GET(request(), context('persona_owner', 'malformed_goal'));
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: 'Goal runtime is unavailable.' });
  expect(readRuntime).not.toHaveBeenCalled();
});

it('returns the engine projection without promoting unverified evidence', async () => {
  const response = await GET(request(), context());
  expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  expect(readRuntime).toHaveBeenCalledWith('persona_owner', 'goal_one');
  expect(await response.json()).toEqual({ schema: 'flujo-goal-runtime/v1', workspaceId: 'runtime-owner',
    personaId: 'persona_owner', runtime: { goal: { id: 'goal_one' }, state: 'unverified',
      verified: false, reason: 'snapshot_changed' } });
});

it.each([new Error('private-runtime-context'), new PersonaShardIdentityError('private-child', 'private-persona')])(
  'holds an engine/read failure without returning raw storage or error text: %p', async error => {
  readRuntime.mockRejectedValueOnce(error);
  const response = await GET(request(), context());
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: 'Goal runtime is unavailable.' });
});
