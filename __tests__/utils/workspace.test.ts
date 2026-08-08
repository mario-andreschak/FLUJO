import path from 'path';

let dataDir = '/tmp/flujo-workspace-tests';

jest.mock('@/utils/paths', () => ({
  getDataDir: () => dataDir,
}));

import {
  DEFAULT_WORKSPACE,
  InvalidWorkspaceNameError,
  getCurrentWorkspace,
  getWorkspaceDbDir,
  getWorkspaceDir,
  normalizeWorkspaceName,
  runWithWorkspace,
  workspaceCacheKey,
} from '@/utils/workspace';

describe('workspace primitives (#406)', () => {
  beforeEach(() => {
    dataDir = '/tmp/flujo-workspace-tests';
  });

  it('uses the default workspace when selection is omitted or blank', () => {
    expect(normalizeWorkspaceName(undefined)).toBe(DEFAULT_WORKSPACE);
    expect(normalizeWorkspaceName(null)).toBe(DEFAULT_WORKSPACE);
    expect(normalizeWorkspaceName('   ')).toBe(DEFAULT_WORKSPACE);
    expect(getWorkspaceDbDir()).toBe(
      path.join(dataDir, 'workspaces', DEFAULT_WORKSPACE, 'db'),
    );
  });

  it('rejects traversal, separators, whitespace, and overlong names', () => {
    for (const value of ['../other', 'a/b', 'a\\b', '.', '..', 'has space', '%2e%2e', 'a'.repeat(65)]) {
      expect(() => getWorkspaceDir(value)).toThrow(InvalidWorkspaceNameError);
    }
  });

  it('keeps paths below the workspace root for valid names', () => {
    expect(getWorkspaceDir('team_1')).toBe(
      path.join(dataDir, 'workspaces', 'team_1'),
    );
  });

  it('isolates cache keys across concurrent workspace contexts', async () => {
    const [first, second] = await Promise.all([
      runWithWorkspace('alpha', async () => {
        await Promise.resolve();
        return workspaceCacheKey('same-id');
      }),
      runWithWorkspace('beta', async () => {
        await Promise.resolve();
        return workspaceCacheKey('same-id');
      }),
    ]);

    expect(first).not.toBe(second);
    expect(getCurrentWorkspace()).toBe(DEFAULT_WORKSPACE);
  });
});
