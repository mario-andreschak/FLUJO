// Retained release-preflight HTTP boundary regression source.
import { NextRequest, NextResponse } from 'next/server';
import { GET, PUT } from '@/app/v1/personas/[personaId]/goal-admissions/[admissionKey]/route';
import { admitPausedPersonaGoal, readPersonaGoalAdmission } from '@/backend/services/enduringAgents/goalAdmission';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { assertLocalRequest } from '@/utils/http/localRequest';

jest.mock('@/app/api/_workspace', () => ({ withWorkspaceRoute: (handler: unknown) => handler }));
jest.mock('@/backend/services/enduringAgents/goalAdmission', () => ({
  ...jest.requireActual('@/backend/services/enduringAgents/goalAdmission'),
  admitPausedPersonaGoal: jest.fn(), readPersonaGoalAdmission: jest.fn(),
}));
jest.mock('@/utils/encryption/lockGate', () => ({ assertUnlocked: jest.fn() }));
jest.mock('@/utils/http/localRequest', () => ({ assertLocalRequest: jest.fn() }));

const local = jest.mocked(assertLocalRequest);
const unlocked = jest.mocked(assertUnlocked);
const admit = jest.mocked(admitPausedPersonaGoal);
const read = jest.mocked(readPersonaGoalAdmission);
const context = () => ({ params: Promise.resolve({ personaId: 'persona_owner', admissionKey: 'a'.repeat(64) }) });
const input = { title: 'Original case', description: 'Original context', successCriteria: 'Reviewed handoff evidence' };
const request = (body = JSON.stringify(input)) => new NextRequest('http://127.0.0.1:4200/v1/personas/persona_owner/goal-admissions/key', {
  method: 'PUT', body,
});
beforeEach(() => { jest.resetAllMocks(); local.mockReturnValue(null); unlocked.mockResolvedValue(null); });

it('enforces local and unlock gates before native admission', async () => {
  local.mockReturnValueOnce(NextResponse.json({ error: 'forbidden' }, { status: 403 }));
  expect((await PUT(request(), context())).status).toBe(403);
  expect(local).toHaveBeenCalledWith(expect.anything(), { strictLoopback: true });
  expect(admit).not.toHaveBeenCalled();
  unlocked.mockResolvedValueOnce(NextResponse.json({ error: 'locked' }, { status: 423 }));
  expect((await PUT(request(), context())).status).toBe(423);
  expect(admit).not.toHaveBeenCalled();
});

it('rejects forged authority, activation fields and oversized bodies', async () => {
  expect((await PUT(request(JSON.stringify({ ...input, state: 'active', personaId: 'other' })), context())).status).toBe(400);
  expect((await PUT(request(' '.repeat(131_073)), context())).status).toBe(413);
  expect(admit).not.toHaveBeenCalled();
});

it('makes GET read-only and holds unknown effects without disclosing private errors', async () => {
  read.mockResolvedValueOnce(null);
  expect((await GET(request(), context())).status).toBe(404);
  expect(admit).not.toHaveBeenCalled();
  admit.mockRejectedValueOnce(new Error('private-customer-context'));
  const response = await PUT(request(), context());
  expect(response.status).toBe(503);
  expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  expect(JSON.stringify(await response.json())).not.toContain('private-customer-context');
});
