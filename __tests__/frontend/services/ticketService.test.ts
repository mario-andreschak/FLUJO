/**
 * Frontend ticket service (issue #379).
 *
 * The dashboard renders straight from this service's return values, so it is
 * the single place that turns an untrusted HTTP body into something safe to
 * render: `items` is always an array, every entry always has `labels`/`status`,
 * and unusable records are dropped instead of crashing the home page.
 */
import { normalizeTicket, normalizeTicketPage, ticketService } from '@/frontend/services/ticket';

const jsonResponse = (body: unknown, ok = true, status = 200) => ({
  ok,
  status,
  json: async () => body,
}) as unknown as Response;

const fetchMock = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  (globalThis as { fetch?: unknown }).fetch = fetchMock;
});

afterEach(() => {
  Reflect.deleteProperty(globalThis as object, 'fetch');
});

describe('normalizeTicketPage', () => {
  it.each([
    ['undefined', undefined],
    ['null', null],
    ['an empty object', {}],
    ['a string', 'nope'],
    ['a null items field', { items: null }],
    ['a non-array items field', { items: { 0: 'x' } }],
  ])('defaults items to an empty array for %s', (_label, payload) => {
    expect(normalizeTicketPage(payload)).toEqual({ items: [], total: 0, hasMore: false });
  });

  it('keeps a well-formed page verbatim', () => {
    const page = {
      items: [{ id: 'a', message: 'hi', labels: ['ops'], status: 'done', createdAt: 2, updatedAt: 3 }],
      total: 9,
      hasMore: true,
    };
    expect(normalizeTicketPage(page)).toEqual(page);
  });

  it('drops unusable entries and falls back to the item count for a bad total', () => {
    const page = normalizeTicketPage({
      items: [null, 'x', {}, { id: 'good', message: 'hi' }],
      total: 'many',
    });

    expect(page.items).toHaveLength(1);
    expect(page.total).toBe(1);
  });
});

describe('normalizeTicket', () => {
  it('fills in the fields the card indexes unconditionally', () => {
    expect(normalizeTicket({ id: 'a' })).toEqual({
      id: 'a',
      message: '',
      labels: [],
      status: 'open',
      createdAt: 0,
      updatedAt: 0,
    });
  });

  it('discards junk labels, unknown statuses and non-numeric timestamps', () => {
    expect(normalizeTicket({
      id: 'a',
      message: 'hi',
      labels: ['ops', 42, null],
      status: 'archived',
      createdAt: 'yesterday',
    })).toMatchObject({ labels: ['ops'], status: 'open', createdAt: 0 });
  });

  it('keeps optional provenance only when it is a non-empty string', () => {
    expect(normalizeTicket({ id: 'a', conversationId: '', flowId: 'flow-1', source: 'bogus' })).toEqual(
      expect.objectContaining({ flowId: 'flow-1' }),
    );
    expect(normalizeTicket({ id: 'a', conversationId: '' })).not.toHaveProperty('conversationId');
    expect(normalizeTicket({ id: 'a', source: 'bogus' })).not.toHaveProperty('source');
    expect(normalizeTicket({ id: 'a', source: 'agent' })).toMatchObject({ source: 'agent' });
  });

  it('rejects records without a usable id', () => {
    for (const value of [undefined, null, 'x', 42, {}, { id: 42 }, { id: '' }]) {
      expect(normalizeTicket(value)).toBeNull();
    }
  });
});

describe('ticketService', () => {
  it('normalizes a malformed list response instead of propagating it', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));

    await expect(ticketService.listTickets({ status: 'open', limit: 4 })).resolves.toEqual({
      items: [],
      total: 0,
      hasMore: false,
    });
    expect(fetchMock).toHaveBeenCalledWith('/api/tickets?status=open&limit=4');
  });

  it('omits empty query values from the request', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ items: [], total: 0, hasMore: false }));

    await ticketService.listTickets({ search: '', label: 'ops' });

    expect(fetchMock).toHaveBeenCalledWith('/api/tickets?label=ops');
  });

  it('reports zero rather than NaN for a malformed presence probe', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));
    await expect(ticketService.countTickets()).resolves.toBe(0);

    fetchMock.mockResolvedValue(jsonResponse({ count: 3 }));
    await expect(ticketService.countTickets()).resolves.toBe(3);
  });

  it('throws the server-provided error for a failed request', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'Ticket not found.' }, false, 404));

    await expect(ticketService.getTicket('missing')).rejects.toThrow('Ticket not found.');
  });

  it('sends a bulk delete and normalizes its summary', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));

    await expect(ticketService.deleteTickets(['a', 'b'])).resolves.toEqual({ deleted: 0, errors: 0 });
    expect(fetchMock).toHaveBeenCalledWith('/api/tickets', expect.objectContaining({
      method: 'DELETE',
      body: JSON.stringify({ ids: ['a', 'b'] }),
    }));
  });

  it('encodes ids in single-ticket routes', async () => {
    fetchMock.mockResolvedValue(jsonResponse(undefined));

    await ticketService.deleteTicket('a/b');

    expect(fetchMock).toHaveBeenCalledWith('/api/tickets/a%2Fb', { method: 'DELETE' });
  });
});
