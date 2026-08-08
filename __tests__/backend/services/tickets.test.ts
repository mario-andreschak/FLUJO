/**
 * Ticket service tests (issue #379 — "dashboard Agent Messages").
 *
 * The tickets collection is written by agents through the internal MCP tool, so
 * the service is the trust boundary: it validates input, normalises/caps
 * agent-authored labels, refuses unsafe ids, and must return a well-formed page
 * (`items` is ALWAYS an array) even when the persisted collection contains
 * junk. The storage layer is replaced with an in-memory map so the suite never
 * touches the real data directory.
 */
import { normalizeTicketLabels } from '@/shared/types/ticket';
import type { Ticket } from '@/shared/types/ticket';

const store = new Map<string, unknown>();

jest.mock('@/utils/storage/backend', () => ({
  assertSafeCollectionId: (id: string) => {
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(id)) {
      throw new Error(`Unsafe collection item id: ${JSON.stringify(id)}`);
    }
  },
  listCollectionItems: jest.fn(async () => Array.from(store.values())),
  loadCollectionItem: jest.fn(async (_collection: string, id: string, fallback: unknown) =>
    store.has(id) ? store.get(id) : fallback),
  saveCollectionItem: jest.fn(async (_collection: string, id: string, value: unknown) => {
    store.set(id, value);
  }),
  deleteCollectionItem: jest.fn(async (_collection: string, id: string) => {
    store.delete(id);
  }),
}));

jest.mock('@/utils/logger', () => ({
  createLogger: () => ({ debug: jest.fn(), verbose: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

import { ticketService } from '@/backend/services/ticket';

const seed = (ticket: Partial<Ticket> & { id: string }) => {
  const full: Ticket = {
    message: 'seeded',
    labels: [],
    status: 'open',
    createdAt: 1,
    updatedAt: 1,
    ...ticket,
  } as Ticket;
  store.set(full.id, full);
  return full;
};

beforeEach(() => {
  store.clear();
  jest.clearAllMocks();
});

describe('ticketService.createTicket', () => {
  it('persists a normalised open ticket', async () => {
    const result = await ticketService.createTicket({ message: '  Please review the deploy  ', labels: 'ops, review' });

    expect(result.success).toBe(true);
    expect(result.ticket).toMatchObject({
      message: 'Please review the deploy',
      labels: ['ops', 'review'],
      status: 'open',
    });
    expect(store.size).toBe(1);
    expect(result.ticket!.createdAt).toBe(result.ticket!.updatedAt);
  });

  it('rejects an empty or oversized message without writing anything', async () => {
    for (const message of ['', '   ', 'x'.repeat(4001)]) {
      const result = await ticketService.createTicket({ message });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/invalid/i);
    }
    expect(store.size).toBe(0);
  });

  it('rejects unsafe provenance ids rather than persisting them', async () => {
    const result = await ticketService.createTicket({
      message: 'hi',
      conversationId: '../../etc/passwd',
    });
    expect(result.success).toBe(false);
    expect(store.size).toBe(0);
  });

  it('keeps optional context only when provided', async () => {
    const bare = await ticketService.createTicket({ message: 'bare' });
    expect(bare.ticket).not.toHaveProperty('conversationId');
    expect(bare.ticket).not.toHaveProperty('flowId');

    const linked = await ticketService.createTicket({
      message: 'linked',
      conversationId: 'conv-1',
      flowId: 'flow-1',
      source: 'agent',
    });
    expect(linked.ticket).toMatchObject({ conversationId: 'conv-1', flowId: 'flow-1', source: 'agent' });
  });
});

describe('normalizeTicketLabels', () => {
  it('splits, trims, de-duplicates and caps agent-authored labels', () => {
    expect(normalizeTicketLabels('ops, ops , OPS,  review ')).toEqual(['ops', 'review']);
    expect(normalizeTicketLabels(['a,b', 'c'])).toEqual(['a', 'b', 'c']);
    expect(normalizeTicketLabels(Array.from({ length: 30 }, (_, i) => `l${i}`))).toHaveLength(12);
    expect(normalizeTicketLabels(undefined)).toEqual([]);
    expect(normalizeTicketLabels(42)).toEqual([]);
  });

  it('strips markup so a label can never smuggle HTML into a pill', () => {
    const [label] = normalizeTicketLabels('<script>alert(1)</script>');
    expect(label).not.toMatch(/[<>()]/);
    expect(label).toContain('script');
  });

  it('truncates a very long single label', () => {
    expect(normalizeTicketLabels('x'.repeat(200))[0]).toHaveLength(40);
  });
});

describe('ticketService.listTickets', () => {
  it('returns newest first with total and hasMore', async () => {
    seed({ id: 'a', createdAt: 1, message: 'first' });
    seed({ id: 'b', createdAt: 3, message: 'third' });
    seed({ id: 'c', createdAt: 2, message: 'second' });

    const page = await ticketService.listTickets({ limit: 2 });
    expect(page.items.map((t) => t.id)).toEqual(['b', 'c']);
    expect(page).toMatchObject({ total: 3, hasMore: true });

    const rest = await ticketService.listTickets({ limit: 2, offset: 2 });
    expect(rest.items.map((t) => t.id)).toEqual(['a']);
    expect(rest.hasMore).toBe(false);
  });

  it('filters by status, label and free-text search', async () => {
    seed({ id: 'open1', status: 'open', labels: ['ops'], message: 'restart the worker' });
    seed({ id: 'done1', status: 'done', labels: ['ux'], message: 'polish the header', title: 'Header' });

    expect((await ticketService.listTickets({ status: 'open' })).items.map((t) => t.id)).toEqual(['open1']);
    expect((await ticketService.listTickets({ label: 'OPS' })).items.map((t) => t.id)).toEqual(['open1']);
    expect((await ticketService.listTickets({ search: 'header' })).items.map((t) => t.id)).toEqual(['done1']);
    expect((await ticketService.listTickets({ search: 'nothing-here' })).items).toEqual([]);
  });

  it('drops corrupt records instead of returning them', async () => {
    seed({ id: 'good', message: 'fine' });
    store.set('bad-id', { id: '../escape', message: 'nope', labels: [], status: 'open', createdAt: 1, updatedAt: 1 });
    store.set('no-message', { id: 'no-message', labels: [], status: 'open', createdAt: 1, updatedAt: 1 });

    const page = await ticketService.listTickets();
    expect(page.items.map((t) => t.id)).toEqual(['good']);
    expect(page.total).toBe(1);
  });

  it('always answers with an array, even for an empty collection', async () => {
    await expect(ticketService.listTickets()).resolves.toEqual({ items: [], total: 0, hasMore: false });
  });
});

describe('ticketService.updateTicket / deleteTicket', () => {
  it('toggles status and re-normalises patched labels', async () => {
    seed({ id: 'ticket1', message: 'work', labels: ['ops'] });

    const done = await ticketService.updateTicket('ticket1', { status: 'done', labels: 'a, a, b' });
    expect(done.success).toBe(true);
    expect(done.ticket).toMatchObject({ status: 'done', labels: ['a', 'b'] });
    expect(done.ticket!.updatedAt).toBeGreaterThanOrEqual(done.ticket!.createdAt);
  });

  it('reports a missing ticket and refuses unsafe ids', async () => {
    await expect(ticketService.updateTicket('nope', { status: 'done' })).resolves.toMatchObject({
      success: false,
      error: 'Ticket not found.',
    });
    await expect(ticketService.updateTicket('../escape', { status: 'done' })).resolves.toMatchObject({
      success: false,
    });
    await expect(ticketService.deleteTicket('nope')).resolves.toMatchObject({ success: false });
  });

  it('rejects an empty patch', async () => {
    seed({ id: 'ticket1', message: 'work' });
    await expect(ticketService.updateTicket('ticket1', {})).resolves.toMatchObject({ success: false });
  });

  it('deletes one ticket and reports bulk results', async () => {
    seed({ id: 'one', message: '1' });
    seed({ id: 'two', message: '2' });

    await expect(ticketService.deleteTicket('one')).resolves.toEqual({ success: true });
    expect(store.has('one')).toBe(false);

    await expect(ticketService.deleteTickets(['two', 'missing'])).resolves.toEqual({ deleted: 1, errors: 1 });
    expect(store.size).toBe(0);
  });
});
