import type { BigIntStats } from 'node:fs';
import path from 'node:path';
import type { NextRequest } from 'next/server';

// Exercise the actual GET and readPlainFile against synthetic files and service seams.
const mockFilesystem = { readdir: jest.fn(), lstat: jest.fn(), stat: jest.fn(), readFile: jest.fn(), open: jest.fn() };
const mockHandle = { stat: jest.fn(), read: jest.fn(), close: jest.fn() };
const mockStates = new Map<string, Record<string, unknown>>();
const mockLock = jest.fn();
const mockOrigin = jest.fn();
const mockSummaries = jest.fn();
const mockRecovery = jest.fn();
let mockWorkspace = '';
const mockDataRoot = path.resolve('synthetic-conversation-list-workspace');

jest.mock('fs', () => ({ promises: mockFilesystem }));
jest.mock('node:fs', () => ({ constants: jest.requireActual('node:fs').constants, promises: mockFilesystem }));
jest.mock('@/app/api/_workspace', () => ({ withWorkspaceRoute: (handler: unknown) => handler }));
jest.mock('@/utils/encryption/lockGate', () => ({ assertUnlocked: mockLock }));
jest.mock('@/utils/http/localRequest', () => ({ assertLocalRequest: mockOrigin }));
jest.mock('@/utils/workspace', () => ({
  getWorkspaceDataDir: () => mockDataRoot,
  workspaceCacheKey: (namespace: string, file?: string) => `${mockWorkspace}\0${namespace}${file === undefined ? '' : `\0${file}`}`,
}));
jest.mock('@/utils/logger', () => ({ createLogger: () => ({ info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() }) }));
jest.mock('@/backend/execution/extensions', () => ({
  exposeExecutionConversationInList: async () => true,
  isExecutionProtectedState: (state: { executionExtensionOwned?: boolean }) => !!state.executionExtensionOwned,
}));
jest.mock('@/utils/storage/backend', () => ({ assertSafeCollectionId: (id: string) => { if (!/^[a-z0-9-]+$/.test(id)) throw new Error('invalid id'); } }));
jest.mock('@/backend/execution/flow/FlowExecutor', () => ({ FlowExecutor: { conversationStates: mockStates } }));
jest.mock('@/backend/execution/flow/personaConversationOwnership', () => ({
  isPersonaOwnedConversationState: (state?: { personaTargetId?: string }) => !!state?.personaTargetId,
}));
jest.mock('@/backend/execution/flow/engine/ExecutionEventBus', () => ({ executionEventBus: { currentSeq: () => 1 } }));
jest.mock('@/backend/execution/flow/conversationExecutionLock', () => ({}));
jest.mock('@/backend/execution/flow/cancellation', () => ({}));
jest.mock('@/backend/services/runResources', () => ({}));
jest.mock('@/utils/shared/quickChat', () => ({ quickChatFlowId: 'quickchat-test' }));
jest.mock('@/utils/shared/conversationTitle', () => ({ DEFAULT_CONVERSATION_TITLE: 'New Conversation' }));
jest.mock('@/utils/shared/conversationPins', () => ({}));
jest.mock('@/backend/execution/flow/conversationLog', () => ({}));
jest.mock('@/backend/execution/flow/recoveryCheckpoint', () => ({ reconcileInterruptedRecovery: mockRecovery }));
jest.mock('@/backend/execution/flow/conversationSummaryStore', () => ({
  listConversationSummaries: mockSummaries,
  conversationSidebarTitle: (state: { title?: string }, fallback?: string) => state.title ?? fallback ?? 'New Conversation',
}));
jest.mock('@/backend/services/flow', () => ({ flowService: { loadFlows: async () => [] } }));
jest.mock('@/backend/services/enduringAgents', () => ({}));
jest.mock('@/shared/types/enduringAgent', () => ({}));
jest.mock('@/backend/execution/flow/conversationListPage', () => ({
  ConversationCursorError: class extends Error {},
  paginateConversationSummaries: (items: unknown[], limit: number) => ({ items: items.slice(0, limit), total: items.length, hasMore: items.length > limit }),
}));
jest.mock('@/backend/execution/flow/sessionManagement', () => ({ SESSION_KEY_MAX_LENGTH: 128 }));

let GET: typeof import('@/app/v1/chat/conversations/route').GET;
let mockBytes: Buffer;
let mockInspected: BigIntStats;
let mockReadRequests: Array<{ allocation: number; position: number; length: number; bytesRead: number }>;
let caseNumber = 0;
const id = 'saved-conversation';
const filename = path.join(mockDataRoot, 'db', 'conversations', `${id}.json`);
const byteLimit = 8 * 1024 * 1024;
const snapshot = (title = 'Alpha') => ({
  conversationId: id, title, flowId: 'saved-flow', createdAt: 1, updatedAt: 2, status: 'completed',
  source: 'subflow', parentConversationId: 'root', rootConversationId: 'root',
  subflowLane: { sessionKey: 'writer/main', sessionIdentity: 'root::node::writer%2Fmain' },
  messages: [{ role: 'user', content: 'PRIVATE café needle' }],
});

function metadata(size: number): BigIntStats {
  return {
    dev: BigInt(1), ino: BigInt('9007199254740992'), size: BigInt(size), mode: BigInt(0o100600),
    uid: BigInt(3), gid: BigInt(4), nlink: BigInt(1),
    mtimeNs: BigInt('9007199254740992'), ctimeNs: BigInt('9007199254740992'),
    isFile: () => true, isSymbolicLink: () => false,
  } as BigIntStats;
}

async function get(query = '?dimension=content&search=CAFÉ', signal = new AbortController().signal) {
  const response = await GET({ url: `http://localhost/v1/chat/conversations${query}`, signal } as NextRequest);
  return { status: response.status, body: await response.json() };
}

beforeAll(async () => { ({ GET } = await import('@/app/v1/chat/conversations/route')); });
beforeEach(() => {
  jest.resetAllMocks();
  mockWorkspace = `case-${++caseNumber}`;
  mockStates.clear();
  mockBytes = Buffer.from(JSON.stringify(snapshot()));
  mockInspected = metadata(mockBytes.length);
  mockReadRequests = [];
  mockLock.mockResolvedValue(null);
  mockOrigin.mockReturnValue(null);
  mockSummaries.mockResolvedValue([]);
  mockRecovery.mockResolvedValue(undefined);
  mockFilesystem.readdir.mockResolvedValue([`${id}.json`, 'ignored.txt']);
  mockFilesystem.lstat.mockImplementation(async () => mockInspected);
  mockFilesystem.stat.mockResolvedValue({ birthtimeMs: 1, mtimeMs: 2 });
  mockFilesystem.open.mockResolvedValue(mockHandle);
  mockHandle.stat.mockImplementation(async () => mockInspected);
  mockHandle.close.mockResolvedValue(undefined);
  mockHandle.read.mockImplementation(async (buffer: Buffer, offset: number, length: number, position: number) => {
    const bytesRead = mockBytes.copy(buffer, offset, position, position + length);
    mockReadRequests.push({ allocation: buffer.length, position, length, bytesRead });
    return { bytesRead, buffer };
  });
});

describe('conversation-list snapshot read admission', () => {
  it('preserves UTF-8 content matching and metadata without returning message bodies', async () => {
    const { status, body } = await get();
    expect(status).toBe(200);
    expect(body).toEqual([expect.objectContaining({ id, title: 'Alpha', flowId: 'saved-flow', source: 'subflow', parentConversationId: 'root', rootConversationId: 'root', sessionKey: 'writer/main' })]);
    expect(JSON.stringify(body)).not.toContain('PRIVATE');
    expect(body[0]).not.toHaveProperty('messages');
    expect(mockFilesystem.lstat).toHaveBeenNthCalledWith(1, filename, { bigint: true });
    expect(mockFilesystem.readFile).not.toHaveBeenCalled();
    expect(mockFilesystem.stat).not.toHaveBeenCalled();
    expect(mockReadRequests.every(read => read.allocation === mockBytes.length + 1)).toBe(true);
    expect(mockHandle.close).toHaveBeenCalledTimes(1);
  });

  it('assembles partial descriptor reads before matching', async () => {
    mockHandle.read.mockImplementation(async (buffer: Buffer, offset: number, length: number, position: number) => ({
      bytesRead: mockBytes.copy(buffer, offset, position, position + Math.min(length, 7)), buffer,
    }));
    expect((await get()).body).toHaveLength(1);
    expect(mockHandle.read.mock.calls.length).toBeGreaterThan(2);
    expect(mockHandle.close).toHaveBeenCalledTimes(1);
  });

  it('skips an inspected snapshot above the existing 8 MiB cap without opening', async () => {
    mockInspected = metadata(byteLimit + 1);
    expect(await get()).toEqual({ status: 200, body: [] });
    expect(mockFilesystem.open).not.toHaveBeenCalled();
  });

  it('accepts a stable snapshot at exactly the existing 8 MiB cap', async () => {
    mockBytes = Buffer.concat([mockBytes, Buffer.alloc(byteLimit - mockBytes.length, 0x20)]);
    mockInspected = metadata(byteLimit);
    expect((await get()).body).toHaveLength(1);
    expect(mockReadRequests.every(read => read.allocation === byteLimit + 1 && read.length <= 1024 * 1024)).toBe(true);
    expect(mockReadRequests.reduce((sum, read) => sum + read.bytesRead, 0)).toBe(byteLimit);
  });

  it('rejects an oversized bigint size without rounding it through Number', async () => {
    mockInspected = { ...mockInspected, size: BigInt('9007199254740993') };
    expect((await get()).body).toEqual([]);
    expect(mockFilesystem.open).not.toHaveBeenCalled();
  });

  it.each(['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'mode', 'uid', 'gid', 'nlink'] as const)('rejects replacement of inspected %s before reading', async field => {
    const replacement = { ...mockInspected, [field]: mockInspected[field] + BigInt(1) };
    mockFilesystem.lstat.mockResolvedValueOnce(mockInspected).mockResolvedValue(replacement);
    mockHandle.stat.mockResolvedValue(replacement);
    expect((await get()).body).toEqual([]);
    expect(mockHandle.read).not.toHaveBeenCalled();
    expect(mockHandle.close).toHaveBeenCalledTimes(1);
  });

  it.each(['symlink', 'non-file', 'hard-link'])('declines an unsafe %s leaf', async kind => {
    mockInspected = { ...mockInspected,
      isFile: () => kind !== 'non-file', isSymbolicLink: () => kind === 'symlink',
      nlink: kind === 'hard-link' ? BigInt(2) : BigInt(1),
    };
    expect((await get()).body).toEqual([]);
    expect(mockHandle.read).not.toHaveBeenCalled();
    expect(mockHandle.close).toHaveBeenCalledTimes(1);
  });

  it('rejects growth while consuming at most the inspected size plus one byte', async () => {
    const inspectedLength = mockBytes.length;
    mockBytes = Buffer.concat([mockBytes, Buffer.from(' '.repeat(37))]);
    expect((await get()).body).toEqual([]);
    expect(mockReadRequests.every(read => read.allocation === inspectedLength + 1 && read.position + read.length <= inspectedLength + 1)).toBe(true);
    expect(mockReadRequests.reduce((sum, read) => sum + read.bytesRead, 0)).toBe(inspectedLength + 1);
    expect(mockHandle.close).toHaveBeenCalledTimes(1);
  });

  it('rejects shrinkage and closes the descriptor', async () => {
    mockBytes = mockBytes.subarray(0, mockBytes.length - 1);
    expect((await get()).body).toEqual([]);
    expect(mockHandle.close).toHaveBeenCalledTimes(1);
  });

  it('rejects final pathname replacement after a successful descriptor read', async () => {
    mockFilesystem.lstat.mockResolvedValueOnce(mockInspected).mockResolvedValueOnce(mockInspected)
      .mockResolvedValue({ ...mockInspected, ino: mockInspected.ino + BigInt(1) });
    expect((await get()).body).toEqual([]);
    expect(mockHandle.close).toHaveBeenCalledTimes(1);
  });

  it('rejects descriptor metadata changed during the read', async () => {
    mockHandle.stat.mockResolvedValueOnce(mockInspected).mockResolvedValue({ ...mockInspected, mtimeNs: mockInspected.mtimeNs + BigInt(1) });
    expect((await get()).body).toEqual([]);
    expect(mockHandle.close).toHaveBeenCalledTimes(1);
  });

  it('honors an already-aborted request before opening a descriptor', async () => {
    const controller = new AbortController();
    controller.abort();
    expect((await get(undefined, controller.signal)).body).toEqual([]);
    expect(mockFilesystem.open).not.toHaveBeenCalled();
  });

  it('honors cancellation between descriptor chunks and closes the handle', async () => {
    const controller = new AbortController();
    mockHandle.read.mockImplementation(async (buffer: Buffer, offset: number, length: number, position: number) => {
      const bytesRead = mockBytes.copy(buffer, offset, position, position + Math.min(7, length));
      controller.abort();
      return { bytesRead, buffer };
    });
    expect((await get(undefined, controller.signal)).body).toEqual([]);
    expect(mockHandle.read).toHaveBeenCalledTimes(1);
    expect(mockHandle.close).toHaveBeenCalledTimes(1);
    expect(mockRecovery).not.toHaveBeenCalled();
  });

  it('closes after a descriptor read error without returning a match', async () => {
    mockHandle.read.mockRejectedValue(new Error('synthetic read failure'));
    expect((await get()).body).toEqual([]);
    expect(mockHandle.close).toHaveBeenCalledTimes(1);
  });

  it('preserves the default-list error placeholder for malformed JSON', async () => {
    mockBytes.fill(0x78);
    expect((await get('')).body).toEqual([expect.objectContaining({ id, title: `Error Loading (${id})`, status: 'error', createdAt: 1, updatedAt: 2 })]);
  });

  it('reuses a stable summary but invalidates equal-size, equal-mtime replacements', async () => {
    expect((await get('')).body[0].title).toBe('Alpha');
    expect((await get('')).body[0].title).toBe('Alpha');
    expect(mockFilesystem.open).toHaveBeenCalledTimes(1);
    const oldLength = mockBytes.length;
    mockBytes = Buffer.from(JSON.stringify(snapshot('Bravo')));
    expect(mockBytes.length).toBe(oldLength);
    mockInspected = { ...mockInspected, ino: mockInspected.ino + BigInt(1) };
    expect((await get('')).body[0].title).toBe('Bravo');
    expect(mockFilesystem.open).toHaveBeenCalledTimes(2);
  });

  it('invalidates a one-nanosecond timestamp change without rounding it', async () => {
    await get('');
    mockInspected = { ...mockInspected, mtimeNs: mockInspected.mtimeNs + BigInt(1) };
    await get('');
    expect(mockFilesystem.open).toHaveBeenCalledTimes(2);
  });

  it('keeps same-named and same-stat summaries separate across workspaces', async () => {
    expect((await get('')).body[0].title).toBe('Alpha');
    mockWorkspace += '-other';
    mockBytes = Buffer.from(JSON.stringify(snapshot('Bravo')));
    expect((await get('')).body[0].title).toBe('Bravo');
    expect(mockFilesystem.open).toHaveBeenCalledTimes(2);
  });

  it('bypasses the summary cache for every content search', async () => {
    await get('');
    expect((await get()).body).toHaveLength(1);
    expect((await get()).body).toHaveLength(1);
    expect(mockFilesystem.open).toHaveBeenCalledTimes(3);
  });

  it('keeps live list metadata ahead of the parsed snapshot', async () => {
    mockStates.set(id, { title: 'Live title', status: 'running', updatedAt: 9, source: 'schedule' });
    expect((await get()).body).toEqual([expect.objectContaining({ id, title: 'Live title', status: 'running', updatedAt: 9, source: 'schedule' })]);
  });

  it('preserves the exact session-key filter after content matching', async () => {
    expect((await get('?dimension=content&search=needle&sessionKey=writer%2Fmain')).body).toHaveLength(1);
    expect((await get('?dimension=content&search=needle&sessionKey=writer-main')).body).toEqual([]);
  });

  it('does not expose Persona-owned disk or live records in public mode', async () => {
    mockOrigin.mockImplementation((_request, options) => options?.strictLoopback ? new Response('denied', { status: 403 }) : null);
    mockStates.set(id, { personaTargetId: 'persona-private' });
    expect((await get()).body).toEqual([]);
    mockStates.clear();
    mockBytes = Buffer.from(JSON.stringify({ ...snapshot(), personaTargetId: 'persona-private' }));
    mockInspected = metadata(mockBytes.length);
    expect((await get()).body).toEqual([]);
  });

  it('omits execution-protected snapshots before recovery or projection', async () => {
    mockBytes = Buffer.from(JSON.stringify({ ...snapshot(), executionExtensionOwned: true }));
    mockInspected = metadata(mockBytes.length);
    expect((await get()).body).toEqual([]);
    expect(mockRecovery).not.toHaveBeenCalled();
  });

  it.each(['lock', 'origin'])('retains the %s guard before any filesystem access', async guard => {
    if (guard === 'lock') mockLock.mockResolvedValue(new Response('locked', { status: 423 }));
    else mockOrigin.mockReturnValue(new Response('denied', { status: 403 }));
    const response = await GET({ url: 'http://localhost/v1/chat/conversations', signal: new AbortController().signal } as NextRequest);
    expect(response.status).toBe(guard === 'lock' ? 423 : 403);
    expect(mockFilesystem.readdir).not.toHaveBeenCalled();
    expect(mockFilesystem.open).not.toHaveBeenCalled();
  });

  it('retains query validation before reading snapshots', async () => {
    expect((await get('?limit=0')).status).toBe(400);
    expect(mockFilesystem.readdir).not.toHaveBeenCalled();
  });

  it.each(['?presence=1', '?paged=1'])('keeps %s on the lightweight summary path', async query => {
    const result = await get(query);
    expect(result.status).toBe(200);
    expect(mockFilesystem.lstat).not.toHaveBeenCalled();
    expect(mockFilesystem.open).not.toHaveBeenCalled();
    expect(mockFilesystem.readFile).not.toHaveBeenCalled();
  });
});
