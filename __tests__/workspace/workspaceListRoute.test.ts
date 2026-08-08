const mockEnsureWorkspaceLayoutReady = jest.fn(async () => undefined);
const mockListWorkspaces = jest.fn(async () => [
  { name: 'default-workspace', color: '#6656E8', isDefault: true },
]);

jest.mock('@/backend/services/workspace/layoutReadiness', () => ({
  getWorkspaceLayoutStatus: jest.fn(() => 'ready'),
  waitForWorkspaceLayoutReady: () => mockEnsureWorkspaceLayoutReady(),
}));

jest.mock('@/utils/workspace', () => ({
  DEFAULT_WORKSPACE: 'default-workspace',
  listWorkspaces: () => mockListWorkspaces(),
}));

import { GET } from '@/app/api/workspaces/route';
import { getWorkspaceLayoutStatus } from '@/backend/services/workspace/layoutReadiness';

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
});
