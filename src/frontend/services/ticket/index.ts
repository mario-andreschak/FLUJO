import type { CreateTicketInput, Ticket, TicketPage, TicketPatch, TicketQuery } from '@/shared/types/ticket';

async function parse<T>(response: Response): Promise<T> { const body = await response.json().catch(() => undefined); if (!response.ok) throw new Error(body?.error ?? 'Ticket request failed.'); return body as T; }

const str = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);
const optional = (key: string, value: unknown) => (str(value) === undefined ? {} : { [key]: value as string });

/**
 * Coerce one API entry into a renderable ticket (#379).
 *
 * The route contract is validated server-side, but the response body is still
 * untrusted at runtime: a stubbed/aborted/older backend (or a test double) can
 * hand back `undefined`, `{}` or partial records. Rendering code indexes
 * `labels` and `status` unconditionally, so normalise here — once — instead of
 * sprinkling optional chaining across every call site. Unusable records (no id)
 * are dropped rather than rendered as blank cards.
 */
export function normalizeTicket(value: unknown): Ticket | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (!str(raw.id)) return null;
  return {
    id: raw.id as string,
    message: typeof raw.message === 'string' ? raw.message : '',
    labels: Array.isArray(raw.labels) ? raw.labels.filter((label): label is string => typeof label === 'string') : [],
    status: raw.status === 'done' ? 'done' : 'open',
    createdAt: typeof raw.createdAt === 'number' && Number.isFinite(raw.createdAt) ? raw.createdAt : 0,
    updatedAt: typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt) ? raw.updatedAt : 0,
    ...optional('title', raw.title),
    ...optional('conversationId', raw.conversationId),
    ...optional('messageId', raw.messageId),
    ...optional('flowId', raw.flowId),
    ...optional('nodeId', raw.nodeId),
    ...(raw.source === 'agent' || raw.source === 'host' ? { source: raw.source } : {}),
  };
}

/** Coerce a list response into a always-iterable page; `items` defaults to `[]`. */
export function normalizeTicketPage(value: unknown): TicketPage {
  const raw = (value && typeof value === 'object' ? value : {}) as Partial<TicketPage>;
  const items = Array.isArray(raw.items)
    ? raw.items.map(normalizeTicket).filter((ticket): ticket is Ticket => ticket !== null)
    : [];
  return {
    items,
    total: typeof raw.total === 'number' && Number.isFinite(raw.total) ? raw.total : items.length,
    hasMore: raw.hasMore === true,
  };
}

class TicketService {
  async countTickets(): Promise<number> { const body = await parse<{ count?: unknown }>(await fetch('/api/tickets?presence=1')); return typeof body?.count === 'number' && Number.isFinite(body.count) ? body.count : 0; }
  async listTickets(query: TicketQuery = {}): Promise<TicketPage> { const params = new URLSearchParams(); for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== '') params.set(key, String(value)); return normalizeTicketPage(await parse<unknown>(await fetch('/api/tickets?' + params.toString()))); }
  async getTicket(id: string): Promise<Ticket> { return parse<Ticket>(await fetch('/api/tickets/' + encodeURIComponent(id))); }
  async createTicket(input: CreateTicketInput): Promise<Ticket> { return parse<Ticket>(await fetch('/api/tickets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) })); }
  async updateTicket(id: string, patch: TicketPatch): Promise<Ticket> { return parse<Ticket>(await fetch('/api/tickets/' + encodeURIComponent(id), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) })); }
  async deleteTicket(id: string): Promise<void> { await parse<void>(await fetch('/api/tickets/' + encodeURIComponent(id), { method: 'DELETE' })); }
  async deleteTickets(ids: string[]): Promise<{ deleted: number; errors: number }> { const body = await parse<{ deleted?: unknown; errors?: unknown }>(await fetch('/api/tickets', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }) })); return { deleted: typeof body?.deleted === 'number' ? body.deleted : 0, errors: typeof body?.errors === 'number' ? body.errors : 0 }; }
}

export const ticketService = new TicketService();
