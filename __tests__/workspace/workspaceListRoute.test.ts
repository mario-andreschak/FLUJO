const mockEnsureWorkspaceLayoutReady = jest.fn(async () => undefined);
const mockListWorkspaces = jest.fn(async () => [
  { name: 'default-workspace', color: '#6656E8', isDefault: true },
]);
const mockCreateWorkspace = jest.fn(async (name: string) => ({
  name,
  color: '#10A8C3',
  isDefault: false,
}));
const mockRenameWorkspace = jest.fn(async (_name: string, newName: string) => ({
  name: newName,
  color: '#2E9E5B',
  isDefault: false,
}));
const mockDeleteWorkspace = jest.fn(async (_name: string) => undefined);

jest.mock('@/backend/services/workspace/layoutReadiness', () => ({
  getWorkspaceLayoutStatus: jest.fn(() => 'ready'),
  waitForWorkspaceLayoutReady: () => mockEnsureWorkspaceLayoutReady(),
}));

jest.mock('@/utils/workspace', () => ({
  ...jest.requireActual('@/utils/workspace'),
  DEFAULT_WORKSPACE: 'default-workspace',
  listWorkspaces: () => mockListWorkspaces(),
  createWorkspace: (name: string) => mockCreateWorkspace(name),
  renameWorkspace: (name: string, newName: string) => mockRenameWorkspace(name, newName),
  deleteWorkspace: (name: string) => mockDeleteWorkspace(name),
}));

import { DELETE, GET, PATCH, POST } from '@/app/api/workspaces/route';
import { getWorkspaceLayoutStatus } from '@/backend/services/workspace/layoutReadiness';
import { WorkspaceMutationError } from '@/utils/workspace';

const mockGetWorkspaceLayoutStatus = getWorkspaceLayoutStatus as jest.MockedFunction<
  typeof getWorkspaceLayoutStatus
>;

describe('installation-wide workspace discovery route', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetWorkspaceLayoutStatus.mockReturnValue('ready');
    mockEnsureWorkspaceLayoutReady.mockResolvedValue(undefined);
  });

  it('waits for the layout before enumerating workspaces', async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    expect(mockEnsureWorkspaceLayoutReady).toHaveBeenCalledTimes(1);
    expect(mockListWorkspaces).toHaveBeenCalledTimes(1);
  });

  it('returns 503 instead of fabricating a default workspace on migration failure', async () => {
    mockEnsureWorkspaceLayoutReady.mockRejectedValueOnce(new Error('unsafe marker'));

    const response = await GET();

    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('5');
    expect(mockListWorkspaces).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({
      error: 'Workspace storage is temporarily unavailable.',
    });
  });

  it('reports an active migration immediately instead of holding the shell request open', async () => {
    mockGetWorkspaceLayoutStatus.mockReturnValueOnce('preparing');

    const response = await GET();

    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('2');
    expect(mockEnsureWorkspaceLayoutReady).not.toHaveBeenCalled();
    expect(mockListWorkspaces).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({
      error: 'Workspace data is being verified and migrated.',
      code: 'WORKSPACE_LAYOUT_PREPARING',
    });
  });

  it('creates a workspace and returns the authoritative list', async () => {
    const response = await POST(new Request('http://localhost/api/workspaces', {
      method: 'POST',
      body: JSON.stringify({ name: 'research' }),
    }));

    expect(response.status).toBe(201);
    expect(mockCreateWorkspace).toHaveBeenCalledWith('research');
    expect(mockListWorkspaces).toHaveBeenCalledTimes(1);
    await expect(response.json()).resolves.toMatchObject({
      workspace: { name: 'research' },
      workspaces: [{ name: 'default-workspace' }],
    });
  });

  it('renames and deletes non-default workspaces', async () => {
    const renameResponse = await PATCH(new Request('http://localhost/api/workspaces', {
      method: 'PATCH',
      body: JSON.stringify({ name: 'research', newName: 'planning' }),
    }));
    const deleteResponse = await DELETE(new Request('http://localhost/api/workspaces', {
      method: 'DELETE',
      body: JSON.stringify({ name: 'planning' }),
    }));

    expect(renameResponse.status).toBe(200);
    expect(deleteResponse.status).toBe(200);
    expect(mockRenameWorkspace).toHaveBeenCalledWith('research', 'planning');
    expect(mockDeleteWorkspace).toHaveBeenCalledWith('planning');
  });

  it('reports the protected default workspace as forbidden', async () => {
    mockDeleteWorkspace.mockRejectedValueOnce(new WorkspaceMutationError(
      'DEFAULT_WORKSPACE_PROTECTED',
      'default-workspace cannot be deleted.',
    ));

    const response = await DELETE(new Request('http://localhost/api/workspaces', {
      method: 'DELETE',
      body: JSON.stringify({ name: 'default-workspace' }),
    }));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      code: 'DEFAULT_WORKSPACE_PROTECTED',
    });
  });
});
