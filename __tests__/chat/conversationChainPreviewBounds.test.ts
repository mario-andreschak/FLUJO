import type { BigIntStats } from 'node:fs';
import path from 'node:path';
import type { NextRequest } from 'next/server';
import type { ConversationSummary } from '@/backend/execution/flow/conversationSummaryStore';
import type { ConversationChainsResponse } from '@/shared/types/conversationChain';

// Keep the actual GET handler, preview projection and readPlainFile implementation.
// Only filesystem operations and the route's service/authorization seams are mocked.
const mockFilesystem = { lstat: jest.fn(), stat: jest.fn(), readFile: jest.fn(), open: jest.fn() };
const mockHandle = { stat: jest.fn(), read: jest.fn(), close: jest.fn() };
const mockStates = new Map<string, Record<string, unknown>>();
const mockSummaries = jest.fn<Promise<ConversationSummary[]>, []>();
const mockLock = jest.fn<Promise<Response | null>, [unknown]>();
const mockOrigin = jest.fn<Response | null, [unknown]>();
const mockWarn = jest.fn();
const mockDataRoot = path.resolve('synthetic-chain-workspace');

jest.mock('fs', () => ({ promises: mockFilesystem }));
jest.mock('node:fs', () => ({
  constants: jest.requireActual('node:fs').constants,
  promises: mockFilesystem,
}));
jest.mock('@/app/api/_workspace', () => ({ withWorkspaceRoute: (handler: unknown) => handler }));
jest.mock('@/utils/encryption/lockGate', () => ({ assertUnlocked: mockLock }));
jest.mock('@/utils/http/localRequest', () => ({ assertLocalRequest: mockOrigin }));
jest.mock('@/utils/workspace', () => ({ getWorkspaceDataDir: () => mockDataRoot }));
jest.mock('@/utils/logger', () => ({
  createLogger: () => ({ debug: jest.fn(), warn: mockWarn, error: jest.fn() }),
}));
jest.mock('@/backend/execution/flow/FlowExecutor', () => ({
  FlowExecutor: { conversationStates: mockStates },
}));
jest.mock('@/backend/execution/flow/personaConversationOwnership', () => ({
  isPersonaOwnedConversationState: () => false,
}));
jest.mock('@/backend/execution/flow/engine/ExecutionEventBus', () => ({
  executionEventBus: { currentSeq: () => 0 },
}));
jest.mock('@/backend/execution/flow/conversationSummaryStore', () => ({
  listConversationSummaries: mockSummaries,
}));

let GET: typeof import('@/app/v1/chat/conversation-chains/route').GET;
let mockBytes: Buffer;
let mockInspected: BigIntStats;
let mockReadRequests: Array<{ allocation: number; offset: number; length: number; position: number; bytesRead: number }>;
const id = 'saved-conversation';
const filename = path.join(mockDataRoot, 'db', 'conversations', `${id}.json`);
const byteLimit = 8 * 1024 * 1024;

function metadata(size: number): BigIntStats {
  return {
    dev: BigInt(1), ino: BigInt(2), size: BigInt(size), mode: BigInt(0o100600),
    uid: BigInt(3), gid: BigInt(4), nlink: BigInt(1),
    mtimeNs: BigInt('9007199254740992'), ctimeNs: BigInt('9007199254740992'),
    isFile: () => true, isSymbolicLink: () => false,
  } as BigIntStats;
}

async function get(query = '') {
  return GET({ url: `http://localhost/v1/chat/conversation-chains${query}` } as NextRequest);
}

async function projectedNode() {
  const response = await get();
  expect(response.status).toBe(200);
  const body = await response.json() as ConversationChainsResponse;
  expect(body.totalChains).toBe(1);
  expect(body.chains[0].rootId).toBe(id);
  expect(body.chains[0].nodes).toHaveLength(1);
  return { body, node: body.chains[0].nodes[0] };
}

function expectUnavailable(node: ConversationChainsResponse['chains'][number]['nodes'][number]) {
  expect(node.lastMessage).toBeNull();
  expect(node.previewUnavailable).toBe(true);
  expect(node.messageCount).toBeUndefined();
  expect(node.flowName).toBeUndefined();
}

beforeAll(async () => {
  ({ GET } = await import('@/app/v1/chat/conversation-chains/route'));
});

beforeEach(() => {
  jest.resetAllMocks();
  mockStates.clear();
  mockBytes = Buffer.from(JSON.stringify({
    conversationId: id, flowId: 'saved-flow', flowSnapshot: { name: ' Saved Flow ' },
    messages: [
      { role: 'system', content: 'PRIVATE_CONTEXT' },
      { role: 'user', content: '  café   preview  ', timestamp: 7 },
    ],
  }));
  mockInspected = metadata(mockBytes.length);
  mockReadRequests = [];
  mockLock.mockResolvedValue(null);
  mockOrigin.mockReturnValue(null);
  mockSummaries.mockResolvedValue([{
    id, title: 'Saved title', flowId: 'saved-flow', status: 'completed',
    createdAt: 1, updatedAt: 2, parentConversationId: null, rootConversationId: null,
  } as ConversationSummary]);
  mockFilesystem.lstat.mockResolvedValue(mockInspected);
  mockFilesystem.open.mockResolvedValue(mockHandle);
  mockHandle.stat.mockResolvedValue(mockInspected);
  mockHandle.close.mockResolvedValue(undefined);
  mockHandle.read.mockImplementation(async (buffer: Buffer, offset: number, length: number, position: number) => {
    const bytesRead = mockBytes.copy(buffer, offset, position, position + length);
    mockReadRequests.push({ allocation: buffer.length, offset, length, position, bytesRead });
    return { bytesRead, buffer };
  });
});

describe('conversation-chain snapshot preview admission', () => {
  it('preserves UTF-8 preview, saved flow identity, count and topology without exposing history', async () => {
    const { body, node } = await projectedNode();
    expect(node.lastMessage).toMatchObject({ text: 'café preview', timestamp: 7, role: 'user' });
    expect(node.flowName).toBe('Saved Flow');
    expect(node.messageCount).toBe(1);
    expect(node.active).toBe(false);
    expect(node.previewUnavailable).toBeUndefined();
    expect(body.activeStatuses).toEqual(['running', 'awaiting_tool_approval', 'paused_debug']);
    expect(JSON.stringify(body)).not.toContain('PRIVATE_CONTEXT');
    expect(node).not.toHaveProperty('messages');
    expect(mockFilesystem.lstat).toHaveBeenNthCalledWith(1, filename, { bigint: true });
    expect(mockFilesystem.stat).not.toHaveBeenCalled();
    expect(mockFilesystem.readFile).not.toHaveBeenCalled();
    expect(mockFilesystem.open).toHaveBeenCalledWith(filename, expect.any(Number));
    expect(mockReadRequests.every(request => request.allocation === mockBytes.length + 1)).toBe(true);
    expect(mockHandle.close).toHaveBeenCalledTimes(1);
  });

  it('assembles partial descriptor reads before parsing', async () => {
    mockHandle.read.mockImplementation(async (buffer: Buffer, offset: number, length: number, position: number) => {
      const bytesRead = mockBytes.copy(buffer, offset, position, position + Math.min(7, length));
      return { bytesRead, buffer };
    });
    const { node } = await projectedNode();
    expect(node.lastMessage?.text).toBe('café preview');
    expect(mockHandle.read.mock.calls.length).toBeGreaterThan(2);
    expect(mockHandle.close).toHaveBeenCalledTimes(1);
  });

  it('keeps live state ahead of all disk access', async () => {
    mockStates.set(id, {
      title: 'Live title', flowId: 'live-flow', flowSnapshot: { name: 'Live Flow' },
      status: 'running', updatedAt: 3, messages: [{ role: 'assistant', content: 'live answer', timestamp: 9 }],
    });
    const { node } = await projectedNode();
    expect(node.lastMessage?.text).toBe('live answer');
    expect(node.flowName).toBe('Live Flow');
    expect(node.active).toBe(true);
    expect(mockFilesystem.lstat).not.toHaveBeenCalled();
    expect(mockFilesystem.open).not.toHaveBeenCalled();
  });

  it('declines metadata above the existing 8 MiB cap without opening or allocating content', async () => {
    mockFilesystem.lstat.mockResolvedValue(metadata(byteLimit + 1));
    expectUnavailable((await projectedNode()).node);
    expect(mockFilesystem.open).not.toHaveBeenCalled();
    expect(mockHandle.read).not.toHaveBeenCalled();
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('accepts valid JSON at exactly the existing 8 MiB cap', async () => {
    mockBytes = Buffer.concat([mockBytes, Buffer.alloc(byteLimit - mockBytes.length, 0x20)]);
    mockInspected = metadata(byteLimit);
    mockFilesystem.lstat.mockResolvedValue(mockInspected);
    mockHandle.stat.mockResolvedValue(mockInspected);
    const { node } = await projectedNode();
    expect(node.lastMessage?.text).toBe('café preview');
    expect(node.previewUnavailable).toBeUndefined();
    expect(mockReadRequests.every(request => request.allocation === byteLimit + 1 && request.length <= 1024 * 1024)).toBe(true);
    expect(mockReadRequests.reduce((sum, request) => sum + request.bytesRead, 0)).toBe(byteLimit);
    expect(mockHandle.close).toHaveBeenCalledTimes(1);
  });

  it.each(['ino', 'size', 'mtimeNs', 'ctimeNs'] as const)('rejects caller-inspected %s replacement before content reads', async field => {
    const replacement = { ...mockInspected, [field]: mockInspected[field] + BigInt(1) };
    mockFilesystem.lstat.mockResolvedValueOnce(mockInspected).mockResolvedValue(replacement);
    mockHandle.stat.mockResolvedValue(replacement);
    expectUnavailable((await projectedNode()).node);
    expect(mockHandle.read).not.toHaveBeenCalled();
    expect(mockHandle.close).toHaveBeenCalledTimes(1);
  });

  it('rejects a descriptor/path mismatch before content reads', async () => {
    mockFilesystem.lstat.mockResolvedValueOnce(mockInspected).mockResolvedValue({ ...mockInspected, ino: BigInt(9) });
    expectUnavailable((await projectedNode()).node);
    expect(mockHandle.read).not.toHaveBeenCalled();
    expect(mockHandle.close).toHaveBeenCalledTimes(1);
  });

  it.each(['symlink', 'non-file', 'hard-link'])('declines an unsafe %s leaf without content reads', async kind => {
    const unsafe = { ...mockInspected,
      isFile: () => kind !== 'non-file', isSymbolicLink: () => kind === 'symlink',
      nlink: kind === 'hard-link' ? BigInt(2) : BigInt(1),
    };
    mockFilesystem.lstat.mockResolvedValue(unsafe);
    mockHandle.stat.mockResolvedValue(unsafe);
    expectUnavailable((await projectedNode()).node);
    expect(mockHandle.read).not.toHaveBeenCalled();
    expect(mockHandle.close).toHaveBeenCalledTimes(1);
  });

  it('rejects growth during the read after consuming at most the admitted size plus one', async () => {
    const inspectedLength = mockBytes.length;
    mockBytes = Buffer.concat([mockBytes, Buffer.from(' '.repeat(37))]);
    expectUnavailable((await projectedNode()).node);
    expect(mockReadRequests.every(request => request.allocation === inspectedLength + 1
      && request.position + request.length <= inspectedLength + 1)).toBe(true);
    expect(mockReadRequests.reduce((sum, request) => sum + request.bytesRead, 0)).toBe(inspectedLength + 1);
    expect(mockHandle.close).toHaveBeenCalledTimes(1);
  });

  it('rejects a short read and closes the descriptor', async () => {
    mockBytes = mockBytes.subarray(0, mockBytes.length - 1);
    expectUnavailable((await projectedNode()).node);
    expect(mockHandle.close).toHaveBeenCalledTimes(1);
  });

  it('rejects same-length descriptor timestamp drift after reading', async () => {
    mockHandle.stat.mockResolvedValueOnce(mockInspected).mockResolvedValue({
      ...mockInspected, ctimeNs: mockInspected.ctimeNs + BigInt(1),
    });
    expectUnavailable((await projectedNode()).node);
    expect(mockHandle.read).toHaveBeenCalled();
    expect(mockHandle.close).toHaveBeenCalledTimes(1);
  });

  it('rejects named-file replacement after the descriptor read', async () => {
    mockFilesystem.lstat.mockResolvedValueOnce(mockInspected).mockResolvedValueOnce(mockInspected)
      .mockResolvedValue({ ...mockInspected, ino: BigInt(9) });
    expectUnavailable((await projectedNode()).node);
    expect(mockHandle.read).toHaveBeenCalled();
    expect(mockHandle.close).toHaveBeenCalledTimes(1);
  });

  it.each(['stat', 'read', 'close'] as const)('keeps a neutral preview when descriptor %s fails', async operation => {
    mockHandle[operation].mockRejectedValue(new Error('synthetic descriptor failure'));
    expectUnavailable((await projectedNode()).node);
    expect(mockHandle.close).toHaveBeenCalledTimes(1);
  });

  it('keeps the neutral unreadable preview when opening fails', async () => {
    mockFilesystem.open.mockRejectedValue(new Error('synthetic open failure'));
    expectUnavailable((await projectedNode()).node);
    expect(mockHandle.read).not.toHaveBeenCalled();
    expect(mockHandle.close).not.toHaveBeenCalled();
  });

  it('closes before reporting an invalid JSON preview as unavailable', async () => {
    mockBytes.fill(0x78);
    expectUnavailable((await projectedNode()).node);
    expect(mockHandle.close).toHaveBeenCalledTimes(1);
  });

  it.each(['?root=../escape', '?limit=0', '?limit=26'])('rejects invalid query %s before summaries or snapshot operations', async query => {
    expect((await get(query)).status).toBe(400);
    expect(mockSummaries).not.toHaveBeenCalled();
    expect(mockFilesystem.lstat).not.toHaveBeenCalled();
    expect(mockFilesystem.open).not.toHaveBeenCalled();
  });

  it('returns the lock denial before origin checks or snapshot operations', async () => {
    const denial = new Response('locked', { status: 423 });
    mockLock.mockResolvedValue(denial);
    expect(await get()).toBe(denial);
    expect(mockOrigin).not.toHaveBeenCalled();
    expect(mockSummaries).not.toHaveBeenCalled();
    expect(mockFilesystem.open).not.toHaveBeenCalled();
  });

  it('returns the origin denial before summaries or snapshot operations', async () => {
    const denial = new Response('denied', { status: 403 });
    mockOrigin.mockReturnValue(denial);
    expect(await get()).toBe(denial);
    expect(mockLock).toHaveBeenCalledWith({ openai: true });
    expect(mockSummaries).not.toHaveBeenCalled();
    expect(mockFilesystem.open).not.toHaveBeenCalled();
  });
});
