export type TicketStatus = 'open' | 'done';

/**
 * sessionStorage key used to hand a one-shot composer draft from a ticket card
 * ("Ask FLUJO") to the chat composer. Lives here so both sides agree on it.
 */
export const TICKET_DRAFT_STORAGE_KEY = 'flujo.ticketDraft';

export interface Ticket {
  id: string;
  message: string;
  labels: string[];
  status: TicketStatus;
  createdAt: number;
  updatedAt: number;
  conversationId?: string;
  messageId?: string;
  flowId?: string;
  nodeId?: string;
  title?: string;
  source?: 'agent' | 'host';
}

export interface CreateTicketInput {
  message: string;
  labels?: string | string[];
  title?: string;
  conversationId?: string;
  messageId?: string;
  flowId?: string;
  nodeId?: string;
  source?: 'agent' | 'host';
}

export interface TicketQuery {
  status?: TicketStatus;
  limit?: number;
  offset?: number;
  search?: string;
  label?: string;
}

export interface TicketPage {
  items: Ticket[];
  total: number;
  hasMore: boolean;
}

export type TicketPatch = Omit<Partial<Pick<Ticket, 'status' | 'labels' | 'message' | 'title'>>, 'labels'> & { labels?: string | string[] };

const LABEL_ALLOWED = /[^\p{L}\p{N} _\-\.\/:+#]/gu;

/** Normalise agent-provided labels into safe, displayable pills. */
export function normalizeTicketLabels(input: unknown): string[] {
  const entries = typeof input === 'string'
    ? input.split(',')
    : Array.isArray(input) ? input.flatMap((value) => typeof value === 'string' ? value.split(',') : []) : [];
  const seen = new Set<string>();
  const labels: string[] = [];
  for (const entry of entries) {
    const label = entry.replace(LABEL_ALLOWED, '').replace(/\s+/g, ' ').trim().slice(0, 40);
    if (!label || seen.has(label.toLocaleLowerCase())) continue;
    seen.add(label.toLocaleLowerCase());
    labels.push(label);
    if (labels.length === 12) break;
  }
  return labels;
}
