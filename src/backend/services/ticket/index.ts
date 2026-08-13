import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '@/utils/logger';
import { StorageKey } from '@/shared/types/storage';
import type { CreateTicketInput, Ticket, TicketPage, TicketPatch, TicketQuery } from '@/shared/types/ticket';
import { normalizeTicketLabels } from '@/shared/types/ticket';
import { assertSafeCollectionId, deleteCollectionItem, listCollectionItems, loadCollectionItem, saveCollectionItem } from '@/utils/storage/backend';
import {
  type PersonaRuntimeLock,
  withPersonaRuntimeLock,
} from '@/backend/services/enduringAgents/runtimeLock';
import {
  CreateTicketInputSchema,
  SAFE_TICKET_ID_RE,
  TicketPatchSchema,
  TicketPersonaAttributionSchema,
} from './schema';

const log = createLogger('backend/services/ticket');
const TICKETS_COLLECTION = StorageKey.TICKETS;
const CONVERSATIONS_COLLECTION = 'conversations';
const MAX_OPEN_TICKETS = 2000;
const TICKET_MUTATION_LOCK_ID = 'ticket-mutations';

function withTicketMutationLock<T>(
  task: (lock: PersonaRuntimeLock) => Promise<T>,
): Promise<T> {
  return withPersonaRuntimeLock(TICKET_MUTATION_LOCK_ID, task);
}

async function trustedConversationAttribution(conversationId?: string) {
  if (!conversationId) return undefined;

  let state: unknown;
  try {
    const { FlowExecutor } = await import('@/backend/execution/flow/FlowExecutor');
    state = FlowExecutor.conversationStates.get(conversationId);
  } catch (error) {
    log.warn('Failed to inspect live conversation attribution; falling back to storage', error);
  }
  state ??= await loadCollectionItem<unknown>(CONVERSATIONS_COLLECTION, conversationId, null);
  if (!state || typeof state !== 'object') return undefined;

  const record = state as Record<string, unknown>;
  if (record.conversationId !== undefined && record.conversationId !== conversationId) return undefined;
  const parsed = TicketPersonaAttributionSchema.safeParse(record.personaAttribution);
  return parsed.success ? parsed.data : undefined;
}

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
      return await withTicketMutationLock(async (lock) => {
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
        await lock.assertOwned();
        await saveCollectionItem(TICKETS_COLLECTION, ticket.id, ticket);
        return { success: true, ticket };
      });
    } catch (error) {
      log.error('Failed to create ticket', error);
      return { success: false, error: 'Failed to create ticket.' };
    }
  }

  /**
   * Stamp Persona provenance only from execution-engine-owned conversation
   * context. This method is intentionally not exposed by the REST ticket API.
   */
  async stampPersonaAttributionFromTrustedConversation(
    ticketId: string,
    conversationId: string,
  ): Promise<boolean> {
    if (!SAFE_TICKET_ID_RE.test(ticketId) || !SAFE_TICKET_ID_RE.test(conversationId)) return false;
    return withTicketMutationLock(async (ticketLock) => {
      const personaAttribution = await trustedConversationAttribution(conversationId);
      if (!personaAttribution) return false;

      return withPersonaRuntimeLock(personaAttribution.personaId, async (personaLock) => {
        const { getPersonaDeletionTombstone } = await import('@/backend/services/enduringAgents/store');
        if (await getPersonaDeletionTombstone(personaAttribution.personaId)) return false;

        const ticket = await this.getTicket(ticketId);
        if (!ticket || ticket.conversationId !== conversationId) return false;
        const attributed: Ticket = { ...ticket, ...personaAttribution };
        await personaLock.assertOwned();
        await ticketLock.assertOwned();
        await saveCollectionItem(TICKETS_COLLECTION, ticketId, attributed);
        return true;
      });
    });
  }

  async updateTicket(id: string, patch: TicketPatch): Promise<TicketServiceResponse> {
    if (!SAFE_TICKET_ID_RE.test(id)) return { success: false, error: 'Ticket not found.' };
    const parsed = TicketPatchSchema.safeParse(patch);
    if (!parsed.success) return { success: false, error: 'Ticket update is invalid.' };
    try {
      return await withTicketMutationLock(async (lock) => {
        const ticket = await this.getTicket(id);
        if (!ticket) return { success: false, error: 'Ticket not found.' };
        const { labels, ...patchFields } = parsed.data;
        const updated: Ticket = {
          ...ticket, ...patchFields,
          ...(labels !== undefined ? { labels: normalizeTicketLabels(labels) } : {}),
          updatedAt: Date.now(),
        };
        assertSafeCollectionId(id);
        await lock.assertOwned();
        await saveCollectionItem(TICKETS_COLLECTION, id, updated);
        return { success: true, ticket: updated };
      });
    } catch (error) {
      log.error('Failed to update ticket', error);
      return { success: false, error: 'Failed to update ticket.' };
    }
  }

  async deleteTicket(id: string): Promise<{ success: boolean; error?: string }> {
    try {
      assertSafeCollectionId(id);
      return await withTicketMutationLock(async (lock) => {
        if (!await this.getTicket(id)) return { success: false, error: 'Ticket not found.' };
        await lock.assertOwned();
        await deleteCollectionItem(TICKETS_COLLECTION, id);
        return { success: true };
      });
    } catch {
      return { success: false, error: 'Ticket not found.' };
    }
  }

  async deleteTickets(ids: string[]): Promise<{ deleted: number; errors: number }> {
    return withTicketMutationLock(async (lock) => {
      let deleted = 0;
      let errors = 0;
      for (const id of ids) {
        if (!SAFE_TICKET_ID_RE.test(id) || !await this.getTicket(id)) {
          errors += 1;
          continue;
        }
        await lock.assertOwned();
        await deleteCollectionItem(TICKETS_COLLECTION, id);
        deleted += 1;
      }
      return { deleted, errors };
    });
  }

  /**
   * Removes only Persona attribution from matching tickets. Ticket content,
   * timestamps, and every other provenance field remain byte-for-byte stable.
   */
  async clearPersonaAttributionByPersonaId(personaId: string): Promise<number> {
    if (!TicketPersonaAttributionSchema.safeParse({ personaId }).success) {
      throw new TypeError('Invalid Persona id.');
    }
    return withTicketMutationLock(async (lock) => {
      const tickets = await listCollectionItems<Ticket>(TICKETS_COLLECTION);
      let cleared = 0;
      for (const ticket of tickets) {
        if (!ticket || ticket.personaId !== personaId || !SAFE_TICKET_ID_RE.test(ticket.id)) continue;
        const anonymized = { ...ticket };
        delete anonymized.personaId;
        delete anonymized.activityId;
        delete anonymized.behaviorRevisionId;
        assertSafeCollectionId(ticket.id);
        await lock.assertOwned();
        await saveCollectionItem(TICKETS_COLLECTION, ticket.id, anonymized);
        cleared += 1;
      }
      return cleared;
    });
  }
}

export const ticketService = new TicketService();
