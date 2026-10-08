import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { NextRequest } from 'next/server';
import { ensureWorkspaceDirs, getWorkspaceDataDir } from '@/utils/workspace';

jest.mock('@/utils/encryption/lockGate', () => ({
  assertUnlocked: jest.fn(async () => undefined),
}));
jest.mock('@/frontend/components/Chat', () => ({}));
jest.mock('@/backend/init', () => ({
  ensureWorkspaceInitialized: jest.fn(async () => undefined),
}));

type Route = typeof import('@/app/v1/chat/conversations/route');

describe('conversation list summary-cache workspace isolation', () => {
  const workspaceA = 'conversation-cache-a';
  const workspaceB = 'conversation-cache-b';
  let root: string;
  let previousDataDir: string | undefined;
  let GET: Route['GET'];

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'flujo-conversation-cache-'));
    previousDataDir = process.env.FLUJO_DATA_DIR;
    process.env.FLUJO_DATA_DIR = root;
    await Promise.all([
      ensureWorkspaceDirs(workspaceA),
      ensureWorkspaceDirs(workspaceB),
    ]);
    ({ GET } = await import('@/app/v1/chat/conversations/route'));
  });

  afterAll(async () => {
    if (previousDataDir === undefined) delete process.env.FLUJO_DATA_DIR;
    else process.env.FLUJO_DATA_DIR = previousDataDir;
    await fs.rm(root, { recursive: true, force: true });
  });

  it('does not reuse same-named, same-stat conversation metadata across workspaces', async () => {
    const fileName = 'same-conversation.json';
    const snapshot = (title: string, flowId: string) => JSON.stringify({
      conversationId: 'same-conversation',
      title,
      flowId,
      status: 'completed',
      createdAt: 1,
      updatedAt: 1,
      messages: [],
    });
    const contentA = snapshot('Alpha', 'flow-a');
    const contentB = snapshot('Bravo', 'flow-b');
    expect(Buffer.byteLength(contentA)).toBe(Buffer.byteLength(contentB));

    const pathA = path.join(getWorkspaceDataDir(workspaceA), 'db', 'conversations', fileName);
    const pathB = path.join(getWorkspaceDataDir(workspaceB), 'db', 'conversations', fileName);
    await Promise.all([
      fs.mkdir(path.dirname(pathA), { recursive: true }),
      fs.mkdir(path.dirname(pathB), { recursive: true }),
    ]);
    await Promise.all([
      fs.writeFile(pathA, contentA),
      fs.writeFile(pathB, contentB),
    ]);
    const fixedTime = new Date('2026-01-02T03:04:05.000Z');
    await Promise.all([
      fs.utimes(pathA, fixedTime, fixedTime),
      fs.utimes(pathB, fixedTime, fixedTime),
    ]);

    const request = (workspace: string) => new Request(
      `http://localhost:4200/v1/chat/conversations?workspace=${workspace}`,
      { headers: { host: 'localhost:4200' } },
    ) as unknown as NextRequest;

    const responseA = await GET(request(workspaceA));
    const responseB = await GET(request(workspaceB));
    expect(responseA.status).toBe(200);
    expect(responseB.status).toBe(200);
    expect(await responseA.json()).toEqual([
      expect.objectContaining({ id: 'same-conversation', title: 'Alpha', flowId: 'flow-a' }),
    ]);
    expect(await responseB.json()).toEqual([
      expect.objectContaining({ id: 'same-conversation', title: 'Bravo', flowId: 'flow-b' }),
    ]);
  });
});
