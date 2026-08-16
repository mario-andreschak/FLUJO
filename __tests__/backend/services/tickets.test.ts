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
const mockDeletionTombstones = new Set<string>();
const mockLockTails = new Map<string, Promise<void>>();
let mockBeforeSave: ((id: string, value: unknown) => Promise<void>) | undefined;

jest.mock('@/backend/services/enduringAgents/runtimeLock', () => ({
  withPersonaRuntimeLock: async (id: string, task: (lock: { assertOwned(): Promise<void> }) => Promise<unknown>) => {
    const previous = mockLockTails.get(id) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    mockLockTails.set(id, previous.then(() => current));
    await previous;
    try {
      return await task({ assertOwned: async () => undefined });
    } finally {
      release();
      if (mockLockTails.get(id) === current) mockLockTails.delete(id);
    }
  },
}));

jest.mock('@/backend/services/enduringAgents/store', () => ({
  getPersonaDeletionTombstone: jest.fn(async (personaId: string) =>
    mockDeletionTombstones.has(personaId) ? { personaId } : null),
}));

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
    await mockBeforeSave?.(id, value);
    store.set(id, value);
  }),
  deleteCollectionItem: jest.fn(async (_collection: string, id: string) => {
    store.delete(id);
  }),
}));

jest.mock('@/utils/logger', () => ({
  createLogger: () => ({ debug: jest.fn(), verbose: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

jest.mock('@/backend/execution/flow/FlowExecutor', () => ({
  FlowExecutor: { conversationStates: new Map<string, unknown>() },
}));

import { ticketService } from '@/backend/services/ticket';
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';

const conversationStates = FlowExecutor.conversationStates as Map<string, unknown>;

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
  conversationStates.clear();
  mockDeletionTombstones.clear();
  mockLockTails.clear();
  mockBeforeSave = undefined;
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

  it('never derives attribution from an arbitrary caller-supplied conversation link', async () => {
    store.set('conv-persona', {
      conversationId: 'conv-persona',
      personaAttribution: {
        personaId: 'persona-on-disk',
        activityId: 'activity-on-disk',
        behaviorRevisionId: 'revision-on-disk',
      },
    });
    conversationStates.set('conv-persona', {
      conversationId: 'conv-persona',
      personaAttribution: {
        personaId: 'persona-live',
        activityId: 'activity-live',
        behaviorRevisionId: 'revision-live',
      },
    });

    const result = await ticketService.createTicket({
      message: 'attributed',
      conversationId: 'conv-persona',
      personaId: 'persona-caller',
      activityId: 'activity-caller',
      behaviorRevisionId: 'revision-caller',
    } as unknown as Parameters<typeof ticketService.createTicket>[0]);

    expect(result.ticket).not.toHaveProperty('personaId');
    expect(result.ticket).not.toHaveProperty('activityId');
    expect(result.ticket).not.toHaveProperty('behaviorRevisionId');
  });

  it('stamps only through trusted execution context, preferring live attribution', async () => {
    conversationStates.set('conv-persona', {
      conversationId: 'conv-persona',
      personaAttribution: {
        personaId: 'persona-live',
        activityId: 'activity-live',
        behaviorRevisionId: 'revision-live',
      },
    });
    const created = await ticketService.createTicket({ message: 'trusted', conversationId: 'conv-persona' });

    await expect(ticketService.stampPersonaAttributionFromTrustedConversation(
      created.ticket!.id,
      'conv-persona',
    )).resolves.toBe(true);
    expect(store.get(created.ticket!.id)).toMatchObject({
      personaId: 'persona-live',
      activityId: 'activity-live',
      behaviorRevisionId: 'revision-live',
    });
  });

  it('falls back to persisted trusted attribution, drops invalid provenance, and refuses deletion tombstones', async () => {
    store.set('conv-persisted', {
      conversationId: 'conv-persisted',
      personaAttribution: { personaId: 'persona-persisted', activityId: 'activity-persisted' },
    });
    store.set('conv-invalid', {
      conversationId: 'conv-invalid',
      personaAttribution: { personaId: '../unsafe' },
    });

    const persisted = await ticketService.createTicket({ message: 'persisted', conversationId: 'conv-persisted' });
    const invalid = await ticketService.createTicket({ message: 'invalid', conversationId: 'conv-invalid' });

    await expect(ticketService.stampPersonaAttributionFromTrustedConversation(
      persisted.ticket!.id,
      'conv-persisted',
    )).resolves.toBe(true);
    expect(store.get(persisted.ticket!.id)).toMatchObject({
      personaId: 'persona-persisted',
      activityId: 'activity-persisted',
    });
    await expect(ticketService.stampPersonaAttributionFromTrustedConversation(
      invalid.ticket!.id,
      'conv-invalid',
    )).resolves.toBe(false);

    const blocked = await ticketService.createTicket({ message: 'blocked', conversationId: 'conv-persisted' });
    mockDeletionTombstones.add('persona-persisted');
    await expect(ticketService.stampPersonaAttributionFromTrustedConversation(
      blocked.ticket!.id,
      'conv-persisted',
    )).resolves.toBe(false);
    expect(store.get(blocked.ticket!.id)).not.toHaveProperty('personaId');
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

describe('ticketService.clearPersonaAttributionByPersonaId', () => {
  it('is idempotent and leaves ticket content, timestamps, and other provenance intact', async () => {
    const attributed = seed({
      id: 'attributed',
      message: 'keep this content',
      conversationId: 'conv-1',
      flowId: 'flow-1',
      source: 'agent',
      personaId: 'persona-1',
      activityId: 'activity-1',
      behaviorRevisionId: 'revision-1',
      updatedAt: 42,
    });
    const other = seed({
      id: 'other',
      personaId: 'persona-2',
      activityId: 'activity-2',
      behaviorRevisionId: 'revision-2',
    });
    const expected = { ...attributed };
    delete expected.personaId;
    delete expected.activityId;
    delete expected.behaviorRevisionId;

    await expect(ticketService.clearPersonaAttributionByPersonaId('persona-1')).resolves.toBe(1);
    expect(store.get('attributed')).toEqual(expected);
    expect(store.get('other')).toEqual(other);
    await expect(ticketService.clearPersonaAttributionByPersonaId('persona-1')).resolves.toBe(0);
    expect(store.get('attributed')).toEqual(expected);
  });

  it('serializes a stale update ahead of anonymization so attribution cannot reappear', async () => {
    seed({
      id: 'racy',
      personaId: 'persona-1',
      activityId: 'activity-1',
      behaviorRevisionId: 'revision-1',
    });
    let releaseSave!: () => void;
    const saveReleased = new Promise<void>((resolve) => { releaseSave = resolve; });
    let updateSaveReached!: () => void;
    const updateSaving = new Promise<void>((resolve) => { updateSaveReached = resolve; });
    mockBeforeSave = async (id, value) => {
      if (id === 'racy' && (value as Ticket).status === 'done') {
        updateSaveReached();
        await saveReleased;
      }
    };

    const update = ticketService.updateTicket('racy', { status: 'done' });
    await updateSaving;
    const anonymize = ticketService.clearPersonaAttributionByPersonaId('persona-1');
    releaseSave();
    await Promise.all([update, anonymize]);

    expect(store.get('racy')).toMatchObject({ status: 'done' });
    expect(store.get('racy')).not.toHaveProperty('personaId');
    expect(store.get('racy')).not.toHaveProperty('activityId');
    expect(store.get('racy')).not.toHaveProperty('behaviorRevisionId');
  });
});
