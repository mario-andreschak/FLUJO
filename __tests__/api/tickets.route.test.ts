/**
 * REST contract for the agent tickets routes (issue #379).
 *
 * These routes are local-only control-plane endpoints: every handler must run
 * the localhost origin guard and the encryption lock gate BEFORE touching the
 * service, validate agent/browser-supplied bodies, and return the page shape
 * the dashboard relies on (`{ items, total, hasMore }`).
 */
import { NextResponse } from 'next/server';

const listTickets = jest.fn();
const getTicket = jest.fn();
const createTicket = jest.fn();
const updateTicket = jest.fn();
const deleteTicket = jest.fn();
const deleteTickets = jest.fn();
const assertLocalRequestMock = jest.fn();
const assertUnlockedMock = jest.fn();

jest.mock('@/backend/services/ticket', () => ({
  ticketService: {
    listTickets: (...args: unknown[]) => listTickets(...args),
    getTicket: (...args: unknown[]) => getTicket(...args),
    createTicket: (...args: unknown[]) => createTicket(...args),
    updateTicket: (...args: unknown[]) => updateTicket(...args),
    deleteTicket: (...args: unknown[]) => deleteTicket(...args),
    deleteTickets: (...args: unknown[]) => deleteTickets(...args),
  },
}));

jest.mock('@/utils/http/localRequest', () => ({
  assertLocalRequest: (...args: unknown[]) => assertLocalRequestMock(...args),
}));

jest.mock('@/utils/encryption/lockGate', () => ({
  assertUnlocked: (...args: unknown[]) => assertUnlockedMock(...args),
}));

import { DELETE as DELETE_LIST, GET as GET_LIST, POST } from '@/app/api/tickets/route';
import {
  DELETE as DELETE_ONE,
  GET as GET_ONE,
  PATCH,
} from '@/app/api/tickets/[id]/route';

/** Minimal NextRequest stand-in: the handlers only use `nextUrl` and `json()`. */
function request(url = 'http://localhost:4200/api/tickets', body?: unknown) {
  const parsed = new URL(url);
  return {
    url,
    nextUrl: parsed,
    headers: { get: (name: string) => (name.toLowerCase() === 'host' ? 'localhost:4200' : null) },
    json: async () => {
      if (body === undefined) throw new Error('no body');
      return body;
    },
  } as never;
}

const context = (id: string) => ({ params: Promise.resolve({ id }) });

const ticket = {
  id: 'ticket-1',
  message: 'Please review',
  labels: ['ops'],
  status: 'open' as const,
  createdAt: 1,
  updatedAt: 1,
};

beforeEach(() => {
  jest.clearAllMocks();
  assertLocalRequestMock.mockReturnValue(null);
  assertUnlockedMock.mockResolvedValue(null);
  listTickets.mockResolvedValue({ items: [ticket], total: 1, hasMore: false });
});

describe('GET /api/tickets', () => {
  it('returns the page shape the dashboard consumes', async () => {
    const response = await GET_LIST(request('http://localhost:4200/api/tickets?status=open&limit=4'));

    expect(listTickets).toHaveBeenCalledWith(expect.objectContaining({ status: 'open', limit: 4, offset: 0 }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ items: [ticket], total: 1, hasMore: false });
  });

  it('answers the presence probe with just a count', async () => {
    listTickets.mockResolvedValue({ items: [], total: 7, hasMore: true });

    const response = await GET_LIST(request('http://localhost:4200/api/tickets?presence=1'));

    expect(listTickets).toHaveBeenCalledWith({ status: 'open', limit: 1 });
    await expect(response.json()).resolves.toEqual({ count: 7 });
  });

  it('ignores unknown status values and malformed paging numbers', async () => {
    await GET_LIST(request('http://localhost:4200/api/tickets?status=bogus&limit=abc&offset=xyz'));

    const query = listTickets.mock.calls[0][0];
    expect(query.status).toBeUndefined();
    expect(query.limit).toBe(20);
    expect(query.offset).toBe(0);
  });

  it('passes search and label filters through', async () => {
    await GET_LIST(request('http://localhost:4200/api/tickets?search=deploy&label=ops'));
    expect(listTickets).toHaveBeenCalledWith(expect.objectContaining({ search: 'deploy', label: 'ops' }));
  });

  it('runs the local and lock guards before the service', async () => {
    assertLocalRequestMock.mockReturnValue(NextResponse.json({ error: 'forbidden' }, { status: 403 }));

    const response = await GET_LIST(request());

    expect(response.status).toBe(403);
    expect(listTickets).not.toHaveBeenCalled();
  });

  it('propagates the lock gate response', async () => {
    assertUnlockedMock.mockResolvedValue(NextResponse.json({ error: 'locked' }, { status: 423 }));

    const response = await GET_LIST(request());

    expect(response.status).toBe(423);
    expect(listTickets).not.toHaveBeenCalled();
  });
});

describe('POST /api/tickets', () => {
  it('creates a ticket and answers 201', async () => {
    createTicket.mockResolvedValue({ success: true, ticket });

    const response = await POST(request('http://localhost:4200/api/tickets', { message: 'Please review', labels: 'ops' }));

    expect(createTicket).toHaveBeenCalledWith(expect.objectContaining({ message: 'Please review', labels: 'ops' }));
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual(ticket);
  });

  it('rejects an empty message with 400 and never calls the service', async () => {
    const response = await POST(request('http://localhost:4200/api/tickets', { message: '   ' }));

    expect(response.status).toBe(400);
    expect(createTicket).not.toHaveBeenCalled();
  });

  it('rejects a non-JSON body', async () => {
    const response = await POST(request('http://localhost:4200/api/tickets'));

    expect(response.status).toBe(400);
    expect(createTicket).not.toHaveBeenCalled();
  });

  it('surfaces a service-level failure as 400', async () => {
    createTicket.mockResolvedValue({ success: false, error: 'Open ticket limit reached.' });

    const response = await POST(request('http://localhost:4200/api/tickets', { message: 'hi' }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'Open ticket limit reached.' });
  });
});

describe('DELETE /api/tickets (bulk)', () => {
  it('returns the deleted/errors summary', async () => {
    deleteTickets.mockResolvedValue({ deleted: 2, errors: 1 });

    const response = await DELETE_LIST(request('http://localhost:4200/api/tickets', { ids: ['a', 'b', 'c'] }));

    expect(deleteTickets).toHaveBeenCalledWith(['a', 'b', 'c']);
    await expect(response.json()).resolves.toEqual({ deleted: 2, errors: 1 });
  });

  it('rejects a malformed or oversized id list', async () => {
    for (const body of [{}, { ids: 'a' }, { ids: [1, 2] }, { ids: Array.from({ length: 501 }, (_, i) => `id${i}`) }]) {
      const response = await DELETE_LIST(request('http://localhost:4200/api/tickets', body));
      expect(response.status).toBe(400);
    }
    expect(deleteTickets).not.toHaveBeenCalled();
  });
});

describe('/api/tickets/[id]', () => {
  it('gets one ticket or 404s', async () => {
    getTicket.mockResolvedValueOnce(ticket);
    await expect((await GET_ONE(request(), context('ticket-1'))).json()).resolves.toEqual(ticket);

    getTicket.mockResolvedValueOnce(null);
    expect((await GET_ONE(request(), context('missing'))).status).toBe(404);
  });

  it('patches status and maps a missing ticket to 404', async () => {
    updateTicket.mockResolvedValueOnce({ success: true, ticket: { ...ticket, status: 'done' } });
    const ok = await PATCH(request('http://localhost:4200/api/tickets/ticket-1', { status: 'done' }), context('ticket-1'));
    expect(updateTicket).toHaveBeenCalledWith('ticket-1', { status: 'done' });
    expect(ok.status).toBe(200);

    updateTicket.mockResolvedValueOnce({ success: false, error: 'Ticket not found.' });
    const missing = await PATCH(request('http://localhost:4200/api/tickets/x', { status: 'done' }), context('x'));
    expect(missing.status).toBe(404);
  });

  it('rejects an invalid patch body without calling the service', async () => {
    const response = await PATCH(request('http://localhost:4200/api/tickets/ticket-1', { status: 'archived' }), context('ticket-1'));

    expect(response.status).toBe(400);
    expect(updateTicket).not.toHaveBeenCalled();
  });

  it('deletes with 204 and 404s for an unknown id', async () => {
    deleteTicket.mockResolvedValueOnce({ success: true });
    expect((await DELETE_ONE(request(), context('ticket-1'))).status).toBe(204);

    deleteTicket.mockResolvedValueOnce({ success: false, error: 'Ticket not found.' });
    expect((await DELETE_ONE(request(), context('missing'))).status).toBe(404);
  });
});
