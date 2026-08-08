const mockEnsureWorkspaceLayoutReady = jest.fn(async () => undefined);
const mockEnsureWorkspaceDirs = jest.fn(async (_workspace?: string) => undefined);

jest.mock('@/backend/services/workspace/layoutReadiness', () => ({
  waitForWorkspaceLayoutReady: () => mockEnsureWorkspaceLayoutReady(),
}));

jest.mock('@/utils/workspace', () => {
  const actual = jest.requireActual('@/utils/workspace');
  return {
    ...actual,
    ensureWorkspaceDirs: (workspace?: string) => mockEnsureWorkspaceDirs(workspace),
    workspaceExists: jest.fn(async () => true),
  };
});

import { withWorkspaceRoute } from '@/app/api/_workspace';
import { getCurrentWorkspace } from '@/utils/workspace';

describe('withWorkspaceRoute compatibility', () => {
  beforeEach(() => {
    mockEnsureWorkspaceLayoutReady.mockReset().mockResolvedValue(undefined);
    mockEnsureWorkspaceDirs.mockReset().mockResolvedValue(undefined);
  });

  it('normalizes a missing request before parsing and invoking the handler', async () => {
    const handler = jest.fn(async (request: Request) => new Response(JSON.stringify({
      url: request.url,
      workspace: getCurrentWorkspace(),
    })));
    const wrapped = withWorkspaceRoute(handler as never) as unknown as () => Promise<Response>;

    const response = await wrapped();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      url: 'http://localhost/',
      workspace: 'default-workspace',
    });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('preserves a lightweight request stub for the route handler', async () => {
    const stub = { json: async () => ({ value: 7 }) };
    const handler = jest.fn(async (request: typeof stub) =>
      new Response(JSON.stringify(await request.json())));
    const wrapped = withWorkspaceRoute(handler as never) as unknown as
      (request: typeof stub) => Promise<Response>;

    const response = await wrapped(stub);

    expect(await response.json()).toEqual({ value: 7 });
    expect(handler).toHaveBeenCalledWith(stub);
  });

  it('fails closed with a retryable 503 while layout readiness is unavailable', async () => {
    mockEnsureWorkspaceLayoutReady.mockRejectedValueOnce(new Error('migration conflict'));
    const handler = jest.fn(async () => new Response('should not run'));
    const wrapped = withWorkspaceRoute(handler as never) as unknown as
      (request: Request) => Promise<Response>;

    const response = await wrapped(new Request('http://localhost/api/model'));

    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('5');
    expect(handler).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({
      error: 'Workspace storage is temporarily unavailable while its layout is being prepared.',
    });
  });

  it('fails closed before the handler when a selected workspace subtree is unsafe', async () => {
    mockEnsureWorkspaceDirs.mockRejectedValueOnce(new Error('db must be a real directory, not a junction'));
    const handler = jest.fn(async () => new Response('should not run'));
    const wrapped = withWorkspaceRoute(handler as never) as unknown as
      (request: Request) => Promise<Response>;

    const response = await wrapped(new Request('http://localhost/api/model?workspace=research'));

    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('5');
    expect(handler).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({
      error: 'Workspace storage is unavailable: research',
    });
  });

  it('revalidates and fails closed for an unsafe default-workspace subtree', async () => {
    mockEnsureWorkspaceDirs.mockRejectedValueOnce(new Error('default db became a junction'));
    const handler = jest.fn(async () => new Response('should not run'));
    const wrapped = withWorkspaceRoute(handler as never) as unknown as
      (request: Request) => Promise<Response>;

    const response = await wrapped(new Request('http://localhost/api/model'));

    expect(response.status).toBe(503);
    expect(handler).not.toHaveBeenCalled();
    expect(mockEnsureWorkspaceDirs).toHaveBeenCalledWith('default-workspace');
  });

  it('runs a non-default handler only after storage validation', async () => {
    const handler = jest.fn(async () => new Response('workspace data'));
    const wrapped = withWorkspaceRoute(handler as never) as unknown as
      (request: Request) => Promise<Response>;

    const response = await wrapped(new Request('http://localhost/api/model?workspace=research'));

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe('workspace data');
    expect(mockEnsureWorkspaceDirs).toHaveBeenCalledWith('research');
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
