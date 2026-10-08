import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import type { NextRequest } from 'next/server';
import { getCurrentWorkspace, ensureWorkspaceDirs } from '@/utils/workspace';

const loadModelsMock = jest.fn();
jest.mock('@/app/api/model/frontend-model-adapter', () => ({
  loadModels: (...args: unknown[]) => loadModelsMock(...args),
  addModel: jest.fn(),
}));
jest.mock('@/utils/encryption/lockGate', () => ({ assertUnlocked: jest.fn(async () => null) }));
jest.mock('@/backend/init', () => ({ ensureWorkspaceInitialized: jest.fn(async () => undefined) }));

import { GET } from '@/app/api/model/route';

describe('model route workspace isolation', () => {
  let dataRoot: string;
  let previousDataDir: string | undefined;

  beforeAll(async () => {
    previousDataDir = process.env.FLUJO_DATA_DIR;
    dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-model-workspaces-'));
    process.env.FLUJO_DATA_DIR = dataRoot;
    await Promise.all([ensureWorkspaceDirs('team-a'), ensureWorkspaceDirs('team-b')]);
  });

  afterAll(async () => {
    if (previousDataDir === undefined) delete process.env.FLUJO_DATA_DIR;
    else process.env.FLUJO_DATA_DIR = previousDataDir;
    await fs.rm(dataRoot, { recursive: true, force: true });
  });

  it('keeps concurrent model reads in their requested workspaces', async () => {
    loadModelsMock.mockImplementation(async () => ({
      success: true,
      models: [{ id: getCurrentWorkspace(), name: getCurrentWorkspace() }],
    }));

    const request = (workspace: string) => new Request(
      `http://localhost/api/model?workspace=${workspace}`,
    ) as unknown as NextRequest;
    const [a, b] = await Promise.all([GET(request('team-a')), GET(request('team-b'))]);
    expect((await a.json())[0].id).toBe('team-a');
    expect((await b.json())[0].id).toBe('team-b');
  });
});
