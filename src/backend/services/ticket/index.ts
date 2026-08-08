import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '@/utils/logger';
import { StorageKey } from '@/shared/types/storage';
import type { CreateTicketInput, Ticket, TicketPage, TicketPatch, TicketQuery } from '@/shared/types/ticket';
import { normalizeTicketLabels } from '@/shared/types/ticket';
import { assertSafeCollectionId, deleteCollectionItem, listCollectionItems, loadCollectionItem, saveCollectionItem } from '@/utils/storage/backend';
import { CreateTicketInputSchema, SAFE_TICKET_ID_RE, TicketPatchSchema } from './schema';

const log = createLogger('backend/services/ticket');
const TICKETS_COLLECTION = StorageKey.TICKETS;
const MAX_OPEN_TICKETS = 2000;

export interface TicketServiceResponse {
  success: boolean;
  error?: string;
  ticket?: Ticket;
}

export class TicketService {
  async listTickets(query: TicketQuery = {}): Promise<TicketPage> {
    const items = (await listCollectionItems<Ticket>(TICKETS_COLLECTION))
      .filter((ticket) => ticket && SAFE_TICKET_ID_RE.test(ticket.id) && typeof ticket.message === 'string')
      .filter((ticket) => !query.status || ticket.status === query.status)
      .filter((ticket) => !query.label || ticket.labels.some((label) => label.toLocaleLowerCase() === query.label!.toLocaleLowerCase()))
      .filter((ticket) => {
        if (!query.search?.trim()) return true;
        const search = query.search.trim().toLocaleLowerCase();
        return [ticket.title, ticket.message, ...ticket.labels].some((value) => value?.toLocaleLowerCase().includes(search));
      })
      .sort((a, b) => b.createdAt - a.createdAt);
    const offset = Math.max(0, query.offset ?? 0);
    const limit = Math.min(100, Math.max(1, query.limit ?? 20));
    return { items: items.slice(offset, offset + limit), total: items.length, hasMore: offset + limit < items.length };
  }

  async getTicket(id: string): Promise<Ticket | null> {
    try {
      assertSafeCollectionId(id);
      return await loadCollectionItem<Ticket | null>(TICKETS_COLLECTION, id, null);
    } catch {
      return null;
    }
  }

  async createTicket(input: CreateTicketInput): Promise<TicketServiceResponse> {
    const parsed = CreateTicketInputSchema.safeParse(input);
    if (!parsed.success) return { success: false, error: 'Ticket message or context is invalid.' };
    try {
      const openCount = (await this.listTickets({ status: 'open', limit: 1 })).total;
      if (openCount >= MAX_OPEN_TICKETS) return { success: false, error: 'Open ticket limit reached.' };
      const now = Date.now();
      const ticket: Ticket = {
        id: uuidv4(),
        message: parsed.data.message,
        labels: normalizeTicketLabels(parsed.data.labels),
        status: 'open',
        createdAt: now,
        updatedAt: now,
        ...(parsed.data.title ? { title: parsed.data.title } : {}),
        ...(parsed.data.conversationId ? { conversationId: parsed.data.conversationId } : {}),
        ...(parsed.data.messageId ? { messageId: parsed.data.messageId } : {}),
        ...(parsed.data.flowId ? { flowId: parsed.data.flowId } : {}),
        ...(parsed.data.nodeId ? { nodeId: parsed.data.nodeId } : {}),
        ...(parsed.data.source ? { source: parsed.data.source } : {}),
      };
      await saveCollectionItem(TICKETS_COLLECTION, ticket.id, ticket);
      return { success: true, ticket };
    } catch (error) {
      log.error('Failed to create ticket', error);
      return { success: false, error: 'Failed to create ticket.' };
    }
  }

  async updateTicket(id: string, patch: TicketPatch): Promise<TicketServiceResponse> {
    if (!SAFE_TICKET_ID_RE.test(id)) return { success: false, error: 'Ticket not found.' };
    const parsed = TicketPatchSchema.safeParse(patch);
    if (!parsed.success) return { success: false, error: 'Ticket update is invalid.' };
    const ticket = await this.getTicket(id);
    if (!ticket) return { success: false, error: 'Ticket not found.' };
    const { labels, ...patchFields } = parsed.data;
    const updated: Ticket = {
      ...ticket, ...patchFields,
      ...(labels !== undefined ? { labels: normalizeTicketLabels(labels) } : {}),
      updatedAt: Date.now(),
    };
    try {
      assertSafeCollectionId(id);
      await saveCollectionItem(TICKETS_COLLECTION, id, updated);
      return { success: true, ticket: updated };
    } catch (error) {
      log.error('Failed to update ticket', error);
      return { success: false, error: 'Failed to update ticket.' };
    }
  }

  async deleteTicket(id: string): Promise<{ success: boolean; error?: string }> {
    try {
      assertSafeCollectionId(id);
      if (!await this.getTicket(id)) return { success: false, error: 'Ticket not found.' };
      await deleteCollectionItem(TICKETS_COLLECTION, id);
      return { success: true };
    } catch {
      return { success: false, error: 'Ticket not found.' };
    }
  }

  async deleteTickets(ids: string[]): Promise<{ deleted: number; errors: number }> {
    const results = await Promise.all(ids.map((id) => this.deleteTicket(id)));
    return { deleted: results.filter((result) => result.success).length, errors: results.filter((result) => !result.success).length };
  }
}

export const ticketService = new TicketService();
