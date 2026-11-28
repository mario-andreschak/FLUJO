/**
 * DELETE /api/mcp/servers/{name} with the person's choices (#1389): 409 with
 * every place while the app is still used, the delete once each place has an
 * answer, and the same local-only check as the Persona pages for automations
 * that run a Persona.
 */
import { NextRequest } from 'next/server';
import type { McpServerUsage } from '@/shared/types/mcp/serverUsage';

jest.mock('@/app/api/_workspace', () => ({
  withWorkspaceRoute: <T>(handler: T) => handler,
}));
const mockUnlocked = jest.fn(async (): Promise<Response | null> => null);
jest.mock('@/utils/encryption/lockGate', () => ({ assertUnlocked: () => mockUnlocked() }));
jest.mock('@/backend/services/mcp', () => ({ mcpService: {} }));
jest.mock('@/backend/services/sharedItems/guard', () => ({
  ...jest.requireActual('@/backend/services/sharedItems/guard'),
  currentSharedEditor: jest.fn(async () => null),
}));
const mockFindUsage = jest.fn();
const mockDelete = jest.fn();
jest.mock('@/backend/services/mcp/serverDeletion', () => ({
  findMcpServerUsage: (...args: unknown[]) => mockFindUsage(...args),
  deleteMcpServerAndMoveUses: (...args: unknown[]) => mockDelete(...args),
  mcpServerDeleteTouchesPersonas: (usage: McpServerUsage) => ({
    personas: usage.uses.some((use) => use.place.kind === 'persona-app'),
    personaAutomations: usage.uses.some((use) => use.place.kind === 'automation' && use.place.personaControlled),
  }),
  mcpServerInUseBody: (usage: McpServerUsage, changed = false) => ({
    error: 'still used',
    code: 'MCP_SERVER_IN_USE',
    usage,
    ...(changed ? { changed: true } : {}),
  }),
}));

import { DELETE } from '@/app/api/mcp/servers/[name]/route';

const ctx = { params: Promise.resolve({ name: 'github' }) };

function request(body?: unknown, headers: Record<string, string> = { host: 'localhost:4200' }): NextRequest {
  return new NextRequest('http://localhost:4200/api/mcp/servers/github', {
    method: 'DELETE',
    headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const usedByFlow: McpServerUsage = {
  serverName: 'github',
  uses: [{ key: 'flow:triage', place: { kind: 'flow', flowId: 'triage', flowName: 'Triage', steps: 2 }, canRemove: true }],
};
const usedByPersonaAutomation: McpServerUsage = {
  serverName: 'github',
  uses: [{
    key: 'automation:a1:polls',
    place: { kind: 'automation', executionId: 'a1', automationName: 'Inbox', role: 'polls', personaControlled: true },
    canRemove: true,
  }],
};

beforeEach(() => {
  mockFindUsage.mockReset();
  mockDelete.mockReset();
  mockUnlocked.mockReset().mockResolvedValue(null);
});

describe('DELETE /api/mcp/servers/{name} (#1389)', () => {
  it('answers 409 with every place while the app is still used', async () => {
    mockFindUsage.mockResolvedValue(usedByFlow);
    mockDelete.mockResolvedValue({ status: 'in-use', usage: usedByFlow, changed: false });

    const response = await DELETE(request(), ctx);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ success: false, code: 'MCP_SERVER_IN_USE', usage: usedByFlow });
    expect(mockDelete).toHaveBeenCalledWith('github', null, null);
  });

  it('carries out the choices and reports what changed', async () => {
    const summary = { flows: ['Triage'], personas: [], automations: [], turnedOffAutomations: [] };
    mockFindUsage.mockResolvedValue(usedByFlow);
    mockDelete.mockResolvedValue({ status: 'deleted', summary });
    const plan = { choices: { 'flow:triage': { replaceWith: 'github-new' } } };

    const response = await DELETE(request({ plan }), ctx);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ success: true, summary });
    expect(mockDelete).toHaveBeenCalledWith('github', plan, null);
  });

  it('keeps the plain answer for an app nobody uses', async () => {
    mockFindUsage.mockResolvedValue({ serverName: 'github', uses: [] });
    mockDelete.mockResolvedValue({ status: 'deleted', summary: { flows: [], personas: [], automations: [], turnedOffAutomations: [] } });

    const response = await DELETE(request(), ctx);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ success: true });
  });

  it('answers 404 for an unknown app and 400 for choices it cannot read', async () => {
    mockFindUsage.mockResolvedValue(null);
    expect((await DELETE(request(), ctx)).status).toBe(404);
    expect((await DELETE(request({ plan: { choices: { x: { replaceWith: '' } } } }), ctx)).status).toBe(400);
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('says why a delete stopped, with the app kept', async () => {
    mockFindUsage.mockResolvedValue(usedByFlow);
    mockDelete.mockResolvedValue({ status: 'refused', error: 'Could not change flow "Triage". The app was not deleted.' });

    const response = await DELETE(request({ plan: { choices: { 'flow:triage': { remove: true } } } }), ctx);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: 'MCP_SERVER_DELETE_REFUSED', error: expect.stringContaining('not deleted') });
  });

  it('changes an automation that runs a Persona only from this computer', async () => {
    mockFindUsage.mockResolvedValue(usedByPersonaAutomation);
    const plan = { choices: { 'automation:a1:polls': { remove: true } } };

    const viaProxy = await DELETE(request({ plan }, { host: 'localhost:4200', 'x-forwarded-for': '203.0.113.9' }), ctx);

    expect(viaProxy.status).toBe(403);
    expect(mockFindUsage).toHaveBeenCalled();
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('refuses callers from another site before reading anything', async () => {
    const response = await DELETE(request(undefined, { host: 'localhost:4200', origin: 'https://evil.example' }), ctx);

    expect(response.status).toBe(403);
    expect(mockFindUsage).not.toHaveBeenCalled();
  });
});
