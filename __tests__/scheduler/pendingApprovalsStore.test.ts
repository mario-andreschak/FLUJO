/**
 * The approval inbox store (db/pending_approvals.json).
 *
 * The file and the lock are replaced so a read can fail on purpose. The store's
 * own read-change-write logic runs for real: a failed read must never turn into
 * a write of an empty inbox (#1284), and every batch of waiting tool calls gets
 * its own receipt.
 */
let stored: Record<string, unknown> | undefined;
const loadItemMock = jest.fn();
const saveItemMock = jest.fn();
jest.mock('@/utils/storage/backend', () => ({
  loadItem: (...args: unknown[]) => loadItemMock(...args),
  saveItem: (...args: unknown[]) => saveItemMock(...args),
}));
jest.mock('@/backend/services/enduringAgents/runtimeLock', () => ({
  withPersonaRuntimeLock: async (_id: string, task: (lock: { assertOwned: () => Promise<void> }) => Promise<unknown>) =>
    task({ assertOwned: async () => {} }),
}));

import {
  approvalReceiptOf,
  findPendingApprovalByReceipt,
  listPendingApprovals,
  putPendingApproval,
  removePendingApproval,
  removePendingApprovalsForPersonaId,
  type PendingApprovalEntry,
} from '@/backend/services/scheduler/pendingApprovals';

const entry = (conversationId: string, callIds: string[], extra: Partial<PendingApprovalEntry> = {}): PendingApprovalEntry => ({
  approvalId: conversationId,
  conversationId,
  plannedExecutionId: `pe-${conversationId}`,
  flowId: 'flow-1',
  runId: `run-${conversationId}`,
  triggerSummary: 'Schedule',
  pendingToolCalls: callIds.map((id) => ({ id, name: 'send_email' })),
  createdAt: '2026-11-25T00:00:00.000Z',
  ...extra,
});

const fileError = (code: string) => Object.assign(new Error(code), { code });

beforeEach(() => {
  stored = {
    'conv-a': entry('conv-a', ['a1'], { receipt: 'apr_a' }),
    'conv-b': entry('conv-b', ['b1'], { receipt: 'apr_b' }),
  };
  loadItemMock.mockReset().mockImplementation(async (_key: string, fallback: unknown) =>
    (stored === undefined ? fallback : structuredClone(stored)));
  saveItemMock.mockReset().mockImplementation(async (_key: string, value: Record<string, unknown>) => {
    stored = structuredClone(value);
  });
});

describe('a failed read never empties the inbox', () => {
  it('retries a read that fails for a moment and keeps every other entry', async () => {
    loadItemMock.mockRejectedValueOnce(fileError('EBUSY'));

    await putPendingApproval(entry('conv-c', ['c1']));

    expect(Object.keys(stored!).sort()).toEqual(['conv-a', 'conv-b', 'conv-c']);
  });

  it('does not write at all when the inbox cannot be read', async () => {
    loadItemMock.mockRejectedValue(new Error('Failed to parse JSON from pending_approvals.json'));

    await expect(putPendingApproval(entry('conv-c', ['c1']))).rejects.toThrow('Failed to parse JSON');
    await expect(removePendingApproval('conv-a')).rejects.toThrow('Failed to parse JSON');
    await expect(removePendingApprovalsForPersonaId('persona_test')).rejects.toThrow('Failed to parse JSON');

    expect(saveItemMock).not.toHaveBeenCalled();
    expect(Object.keys(stored!).sort()).toEqual(['conv-a', 'conv-b']);
  });

  it('lists an unreadable inbox as empty without touching it', async () => {
    loadItemMock.mockRejectedValue(fileError('EIO'));

    await expect(listPendingApprovals()).resolves.toEqual([]);
    expect(saveItemMock).not.toHaveBeenCalled();
  });

  it('works again on the next write once the file can be read', async () => {
    loadItemMock.mockRejectedValueOnce(fileError('EIO'));
    await expect(removePendingApproval('conv-a')).rejects.toThrow('EIO');

    await removePendingApproval('conv-a');

    expect(Object.keys(stored!)).toEqual(['conv-b']);
  });

  it('retries a save that fails for a moment', async () => {
    saveItemMock.mockRejectedValueOnce(fileError('EPERM'));

    await putPendingApproval(entry('conv-c', ['c1']));

    expect(Object.keys(stored!).sort()).toEqual(['conv-a', 'conv-b', 'conv-c']);
  });
});

describe('one receipt per batch of waiting calls (#1284)', () => {
  it('gives a new batch an opaque receipt that is not the conversation id', async () => {
    const saved = await putPendingApproval(entry('conv-c', ['c1', 'c2']));

    expect(saved.receipt).toMatch(/^apr_[0-9a-f-]{36}$/);
    expect(approvalReceiptOf(saved)).toBe(saved.receipt);
    await expect(findPendingApprovalByReceipt(saved.receipt!)).resolves.toMatchObject({ conversationId: 'conv-c' });
    await expect(findPendingApprovalByReceipt('conv-c')).resolves.toBeNull();
  });

  it('keeps the receipt while the same batch is decided call by call', async () => {
    const first = await putPendingApproval(entry('conv-c', ['c1', 'c2']));
    const rest = await putPendingApproval({ ...first, pendingToolCalls: [{ id: 'c2', name: 'send_email' }] });

    expect(rest.receipt).toBe(first.receipt);
  });

  it('retires a receipt when a later batch waits, so replaying it finds nothing', async () => {
    const first = await putPendingApproval(entry('conv-c', ['c1']));
    const later = await putPendingApproval({ ...first, pendingToolCalls: [{ id: 'c9', name: 'delete_all' }] });

    expect(later.receipt).not.toBe(first.receipt);
    await expect(findPendingApprovalByReceipt(first.receipt!)).resolves.toBeNull();
    await expect(findPendingApprovalByReceipt(later.receipt!)).resolves.toMatchObject({ conversationId: 'conv-c' });
  });

  it('ignores a receipt a caller tries to choose', async () => {
    const saved = await putPendingApproval(entry('conv-c', ['c1'], { receipt: 'apr_a' }));

    expect(saved.receipt).not.toBe('apr_a');
    await expect(findPendingApprovalByReceipt('apr_a')).resolves.toMatchObject({ conversationId: 'conv-a' });
  });

  it('lets an entry saved before receipts answer to its conversation id for its own batch only', async () => {
    stored = { 'conv-old': entry('conv-old', ['o1', 'o2']) };

    await expect(findPendingApprovalByReceipt('conv-old')).resolves.toMatchObject({ conversationId: 'conv-old' });
    // One call decided: still the same batch, the old id still works.
    const partial = await putPendingApproval({ ...entry('conv-old', ['o2']) });
    expect(partial.receipt).toBeUndefined();
    expect(approvalReceiptOf(partial)).toBe('conv-old');
    await expect(findPendingApprovalByReceipt('conv-old')).resolves.toMatchObject({ pendingToolCalls: [{ id: 'o2', name: 'send_email' }] });

    // The run went on and waits for a later batch: the old id is retired for good.
    const later = await putPendingApproval({ ...entry('conv-old', ['o9']) });
    expect(later.receipt).toMatch(/^apr_/);
    await expect(findPendingApprovalByReceipt('conv-old')).resolves.toBeNull();
  });

  it('still refuses an entry from a different run for the same conversation', async () => {
    await expect(putPendingApproval(entry('conv-a', ['x'], { runId: 'another-run' }))).rejects.toThrow('conflicts with another run');
    expect(saveItemMock).not.toHaveBeenCalled();
  });
});
