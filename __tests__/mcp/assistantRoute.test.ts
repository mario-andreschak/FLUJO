const assertLocalRequestMock = jest.fn();
const assertUnlockedMock = jest.fn();
const installMock = jest.fn();
const researchMock = jest.fn();
const troubleshootMock = jest.fn();

// Exercise the route response boundary without starting workspace services.
jest.mock('@/app/api/_workspace', () => ({ withWorkspaceRoute: (handler: unknown) => handler }));
jest.mock('@/utils/http/localRequest', () => ({ assertLocalRequest: (...args: unknown[]) => assertLocalRequestMock(...args) }));
jest.mock('@/utils/encryption/lockGate', () => ({ assertUnlocked: (...args: unknown[]) => assertUnlockedMock(...args) }));
jest.mock('@/backend/services/mcp/assistedInstall', () => ({
  installAssistedMcpServer: (...args: unknown[]) => installMock(...args),
  researchMcpServers: (...args: unknown[]) => researchMock(...args),
  troubleshootMcpInstall: (...args: unknown[]) => troubleshootMock(...args),
}));

import { NextRequest } from 'next/server';
import { POST } from '@/app/api/mcp/assistant/route';

const request = (body: unknown) => new NextRequest('http://localhost/api/mcp/assistant', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
const install = { registryName: 'io.example/server', serverName: 'example', transport: 'stdio', approved: true, reviewedPlan: {} };
const context = { modelId: 'model-1', config: { name: 'example' } };
const privateFailure = () => Object.assign(new Error('Authorization: Bearer private-test-token'), {
  stack: 'Error at C:\\private\\credentials.json:12',
  cause: { apiKey: 'private-test-api-key' },
});

beforeEach(() => {
  jest.resetAllMocks();
  assertLocalRequestMock.mockReturnValue(null);
  assertUnlockedMock.mockResolvedValue(null);
});

describe('MCP assistant public failure boundary', () => {
  it.each(['install', 'troubleshoot'])('hides thrown %s message, stack and cause', async (action) => {
    (action === 'install' ? installMock : troubleshootMock).mockRejectedValueOnce(privateFailure());
    const response = await POST(request({ action, install, context }));
    expect(response.status).toBe(500);
    expect(response.headers.get('Content-Type')).toBe('application/json');
    expect(await response.json()).toEqual({ error: 'MCP assistant request failed. Please try again.' });
  });

  it.each(['install', 'troubleshoot'])('does not stringify a thrown %s object', async (action) => {
    const toString = jest.fn(() => { throw new Error('private coercion must not run'); });
    (action === 'install' ? installMock : troubleshootMock).mockRejectedValueOnce({ toString });
    const response = await POST(request({ action, install, context }));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'MCP assistant request failed. Please try again.' });
    expect(toString).not.toHaveBeenCalled();
  });

  it('ends failed research with a public NDJSON error after progress', async () => {
    researchMock.mockImplementationOnce(async ({ onProgress }) => {
      onProgress({ type: 'progress', stage: 'web', message: 'Searching sources' });
      throw privateFailure();
    });
    const response = await POST(request({ action: 'research', query: 'Find a server', modelId: 'model-1' }));
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/x-ndjson');
    expect(await response.text()).toBe(
      '{"type":"progress","stage":"web","message":"Searching sources"}\n'
      + '{"type":"error","error":"MCP server research failed. Please try again."}\n',
    );
  });

  it('preserves a successful research result', async () => {
    const result = { query: 'Find a server', summary: 'Found a candidate', candidates: [], sources: [], generatedAt: '2026-10-04T00:00:00Z' };
    researchMock.mockResolvedValueOnce(result);
    const response = await POST(request({ action: 'research', query: result.query, modelId: 'model-1' }));
    expect(await response.text()).toBe(`${JSON.stringify({ type: 'complete', result })}\n`);
  });

  it('passes the genuine request cancellation signal to research', async () => {
    researchMock.mockResolvedValueOnce({ candidates: [] });
    const req = request({ action: 'research', query: 'browse websites', modelId: 'model-1' });
    await (await POST(req)).text();
    expect(researchMock).toHaveBeenCalledWith(expect.objectContaining({ signal: req.signal }));
  });

  it('admits explicit model-free lookup of existing bundled options', async () => {
    researchMock.mockResolvedValueOnce({ candidates: [] });
    const response = await POST(request({ action: 'research', query: 'work with local files', modelId: '' }));
    expect(response.status).toBe(200); await response.text();
    expect(researchMock).toHaveBeenCalledWith(expect.objectContaining({ modelId: '' }));
  });

  it.each([
    { action: 'research', query: 'x'.repeat(401), modelId: 'model-1' },
    { action: 'research', query: 'files', modelId: 'x'.repeat(257) },
    { action: 'research', query: 'files', modelId: ' ' },
    { action: 'research', query: 'files', modelId: 'model-1', padding: 'x'.repeat(64 * 1024) },
    [],
  ])('bounds research/body admission before any model or install effect', async body => {
    expect((await POST(request(body))).status).toBe(400);
    expect(researchMock).not.toHaveBeenCalled();
    expect(installMock).not.toHaveBeenCalled();
    expect(troubleshootMock).not.toHaveBeenCalled();
  });

  it('preserves install results, including an explicit service validation error', async () => {
    const result = { installed: false, error: 'Approval is required before installation.' };
    installMock.mockResolvedValueOnce(result);
    const response = await POST(request({ action: 'install', install }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(result);
    expect(installMock).toHaveBeenCalledWith(install);
  });

  it('preserves a successful troubleshooting result', async () => {
    const result = { diagnosis: 'A package is missing', steps: ['Review the install command'] };
    troubleshootMock.mockResolvedValueOnce(result);
    const response = await POST(request({ action: 'troubleshoot', context }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(result);
    expect(troubleshootMock).toHaveBeenCalledWith(context);
  });

  it.each([
    [{ action: 'research', query: ' ', modelId: 'model-1' }, 'query and modelId are required.'],
    [{ action: 'install' }, 'install is required.'],
    [{ action: 'troubleshoot' }, 'context is required.'],
    [{ action: 'other' }, 'Unknown MCP assistant action.'],
  ])('preserves request validation for %j', async (body, error) => {
    const response = await POST(request(body));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error });
    expect(installMock).not.toHaveBeenCalled();
    expect(researchMock).not.toHaveBeenCalled();
    expect(troubleshootMock).not.toHaveBeenCalled();
  });

  it('returns the local request rejection before the lock gate or services', async () => {
    const rejection = new Response('Local request required', { status: 403 });
    assertLocalRequestMock.mockReturnValueOnce(rejection);
    expect(await POST(request({ action: 'install', install }))).toBe(rejection);
    expect(assertUnlockedMock).not.toHaveBeenCalled();
    expect(installMock).not.toHaveBeenCalled();
  });

  it('returns the lock gate rejection before services', async () => {
    const rejection = new Response('Workspace locked', { status: 423 });
    assertUnlockedMock.mockResolvedValueOnce(rejection);
    expect(await POST(request({ action: 'install', install }))).toBe(rejection);
    expect(assertUnlockedMock).toHaveBeenCalledWith({ openai: true });
    expect(installMock).not.toHaveBeenCalled();
  });
});
