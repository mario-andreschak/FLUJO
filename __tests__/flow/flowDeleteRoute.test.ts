/**
 * DELETE /api/flow/{id} with the person's choices (#1389): the same lock and
 * local-access checks as the pages whose records the delete changes.
 */
import { NextRequest } from 'next/server';
import type { FlowUsage } from '@/shared/types/flow/flowUsage';

jest.mock('@/app/api/_workspace', () => ({
  withWorkspaceRoute: <T>(handler: T) => handler,
}));
const mockUnlocked = jest.fn(async (): Promise<Response | null> => null);
jest.mock('@/utils/encryption/lockGate', () => ({ assertUnlocked: () => mockUnlocked() }));
jest.mock('@/backend/services/sharedItems/guard', () => ({
  ...jest.requireActual('@/backend/services/sharedItems/guard'),
  currentSharedEditor: jest.fn(async () => null),
}));
const mockFindUsage = jest.fn();
const mockDelete = jest.fn();
jest.mock('@/backend/services/flow/flowDeletion', () => ({
  ...jest.requireActual('@/backend/services/flow/flowDeletion'),
  findFlowUsage: (...args: unknown[]) => mockFindUsage(...args),
  deleteFlowAndMoveUses: (...args: unknown[]) => mockDelete(...args),
}));

import { DELETE } from '@/app/api/flow/[id]/route';

const ctx = { params: Promise.resolve({ id: 'f1' }) };
const fromOtherSite = { host: 'localhost:4200', origin: 'https://evil.example' };

function request(body?: unknown, headers: Record<string, string> = { host: 'localhost:4200' }): NextRequest {
  return new NextRequest('http://localhost:4200/api/flow/f1', {
    method: 'DELETE',
    headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const usedByPersona: FlowUsage = {
  flowId: 'f1',
  flowName: 'Research',
  uses: [{ key: 'persona:jim:core', place: { kind: 'persona-core', personaId: 'jim', personaName: 'Jim' }, canRemove: true, removePauses: true }],
  copySources: [],
};
const usedByPersonaAutomation: FlowUsage = {
  flowId: 'f1',
  flowName: 'Research',
  uses: [{
    key: 'automation:a1:checks',
    place: { kind: 'automation', executionId: 'a1', automationName: 'Inbox', role: 'checks', personaControlled: true },
    canRemove: true,
    removePauses: false,
  }],
  copySources: [],
};
const plan = { plan: { choices: { 'persona:jim:core': { replaceWith: 'f2' } } } };

beforeEach(() => {
  mockFindUsage.mockReset();
  mockDelete.mockReset();
  mockUnlocked.mockReset().mockResolvedValue(null);
});

it('answers 409 with every place when the flow is in use and no choices were sent', async () => {
  mockFindUsage.mockResolvedValue(usedByPersona);
  mockDelete.mockResolvedValue({ status: 'in-use', usage: usedByPersona, changed: false });

  const response = await DELETE(request(), ctx);

  expect(response.status).toBe(409);
  await expect(response.json()).resolves.toMatchObject({
    code: 'FLOW_IN_USE',
    usage: usedByPersona,
    error: expect.stringContaining('Persona "Jim"'),
  });
  expect(mockDelete).toHaveBeenCalledWith('f1', null, null);
});

it('carries out the choices and reports what changed', async () => {
  mockFindUsage.mockResolvedValue(usedByPersona);
  const summary = { personas: ['Jim'], pausedPersonas: [], automations: [], turnedOffAutomations: [], flows: [] };
  mockDelete.mockResolvedValue({ status: 'deleted', summary });

  const response = await DELETE(request(plan), ctx);

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({ deleted: true, summary });
  expect(mockDelete).toHaveBeenCalledWith('f1', plan.plan, null);
});

it('changes Personas only for a request from this computer, like the Persona pages', async () => {
  mockFindUsage.mockResolvedValue(usedByPersona);

  const response = await DELETE(request(plan, fromOtherSite), ctx);

  expect(response.status).toBe(403);
  expect(mockDelete).not.toHaveBeenCalled();
});

it('changes Persona automations only from this computer itself', async () => {
  mockFindUsage.mockResolvedValue(usedByPersonaAutomation);

  const response = await DELETE(request({ plan: { choices: { 'automation:a1:checks': { remove: true } } } }, { host: 'flujo.lan:4200' }), ctx);

  expect(response.status).toBe(403);
  expect(mockDelete).not.toHaveBeenCalled();
});

it('deletes an unused flow with the same checks as before (no extra local check)', async () => {
  mockFindUsage.mockResolvedValue({ flowId: 'f1', flowName: 'Research', uses: [], copySources: [] });
  mockDelete.mockResolvedValue({ status: 'deleted', summary: { personas: [], pausedPersonas: [], automations: [], turnedOffAutomations: [], flows: [] } });

  const response = await DELETE(request(undefined, fromOtherSite), ctx);

  expect(response.status).toBe(204);
});

it('refuses unreadable choices and keeps the encryption lock first', async () => {
  const bad = await DELETE(request({ plan: { choices: { 'persona:jim:core': { replaceWith: 42 } } } }), ctx);
  expect(bad.status).toBe(400);
  expect(mockDelete).not.toHaveBeenCalled();

  mockUnlocked.mockResolvedValue(new Response(null, { status: 423 }));
  expect((await DELETE(request(plan), ctx)).status).toBe(423);
  expect(mockFindUsage).not.toHaveBeenCalled();
});

it('says plainly when a busy Persona kept the flow', async () => {
  mockFindUsage.mockResolvedValue(usedByPersona);
  mockDelete.mockResolvedValue({ status: 'refused', busy: true, error: 'Persona "Jim" is working right now.' });

  const response = await DELETE(request(plan), ctx);

  expect(response.status).toBe(409);
  await expect(response.json()).resolves.toEqual({ error: 'Persona "Jim" is working right now.', code: 'PERSONA_BUSY' });
});
