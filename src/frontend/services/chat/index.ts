'use client';

import { createLogger } from '@/utils/logger';
import type { ExecutionEvent } from '@/shared/types/execution/events';
import type {
  Conversation,
  ConversationListItem,
} from '@/frontend/components/Chat';

// Create a logger instance for this file
const log = createLogger('frontend/services/chat/index');

/**
 * Error thrown by chatService when the backend responds with a non-2xx status.
 * Carries the HTTP status and parsed body so callers can branch on e.g. 404
 * or surface the server's `error` message (mirrors how the component used to
 * read `axios` error responses).
 */
export class ChatApiError extends Error {
  readonly status: number;
  readonly body: any;
  constructor(message: string, status: number, body: any) {
    super(message);
    this.name = 'ChatApiError';
    this.status = status;
    this.body = body;
  }
}

// Payload accepted by POST /v1/chat/conversations
export interface CreateConversationPayload {
  id: string;
  title: string;
  flowId: string;
  createdAt: number;
  updatedAt: number;
}

// Handlers for the live execution event stream (SSE).
export interface EventStreamHandlers {
  onEvent: (event: ExecutionEvent) => void;
  onOpen?: () => void;
  onError?: (err: Event) => void;
}

const BASE = '/v1/chat/conversations';

// Parse a fetch Response, throwing ChatApiError on non-2xx. For 204/empty
// bodies returns undefined.
async function parse<T>(response: Response): Promise<T> {
  if (response.status === 204) {
    return undefined as T;
  }
  let body: any = undefined;
  const text = await response.text();
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (!response.ok) {
    const message =
      (body && typeof body === 'object' && (body.error || body.message)) ||
      `Request failed with status ${response.status}`;
    throw new ChatApiError(message, response.status, body);
  }
  return body as T;
}

/**
 * ChatService provides a client-side API for the Chat UI, wrapping the RESTful
 * /v1/chat/conversations endpoints. Mirrors the flow/mcp/model service pattern
 * (fetch-based, single exported singleton) so the Chat component no longer
 * issues HTTP calls inline.
 */
class ChatService {
  /** GET /v1/chat/conversations — list summaries (unsorted; caller sorts). */
  async listConversations(): Promise<ConversationListItem[]> {
    log.debug('listConversations: Entering method');
    const response = await fetch(BASE);
    return parse<ConversationListItem[]>(response);
  }

  /** GET /v1/chat/conversations/{id} — full conversation (messages included). */
  async getConversation(id: string): Promise<Conversation> {
    log.debug('getConversation: Entering method', { conversationId: id });
    const response = await fetch(`${BASE}/${encodeURIComponent(id)}`);
    return parse<Conversation>(response);
  }

  /** POST /v1/chat/conversations — create and persist a new conversation. */
  async createConversation(
    payload: CreateConversationPayload
  ): Promise<ConversationListItem> {
    log.debug('createConversation: Entering method', { conversationId: payload.id });
    const response = await fetch(BASE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return parse<ConversationListItem>(response);
  }

  /** PATCH /v1/chat/conversations/{id} — update the conversation's flow. */
  async updateConversationFlow(
    id: string,
    flowId: string
  ): Promise<ConversationListItem> {
    log.debug('updateConversationFlow: Entering method', { conversationId: id, flowId });
    const response = await fetch(`${BASE}/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ flowId }),
    });
    return parse<ConversationListItem>(response);
  }

  /** PATCH /v1/chat/conversations/{id} — update the conversation's tool-approval setting. */
  async updateConversationApproval(
    id: string,
    requireApproval: boolean
  ): Promise<ConversationListItem> {
    log.debug('updateConversationApproval: Entering method', { conversationId: id, requireApproval });
    const response = await fetch(`${BASE}/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requireApproval }),
    });
    return parse<ConversationListItem>(response);
  }

  /** DELETE /v1/chat/conversations/{id}. Resolves on success (204). */
  async deleteConversation(id: string): Promise<void> {
    log.debug('deleteConversation: Entering method', { conversationId: id });
    const response = await fetch(`${BASE}/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    await parse<void>(response);
  }

  /**
   * POST /v1/chat/conversations/{id}/respond — approve/reject a pending tool
   * call; the backend resumes execution and returns the next stop point.
   */
  async respondToToolCall(
    id: string,
    action: 'approve' | 'reject',
    toolCallId: string
  ): Promise<any> {
    log.debug('respondToToolCall: Entering method', { conversationId: id, action, toolCallId });
    const response = await fetch(`${BASE}/${encodeURIComponent(id)}/respond`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, toolCallId }),
    });
    return parse<any>(response);
  }

  /** POST /v1/chat/conversations/{id}/debug/step — advance one debug step. */
  async debugStep(id: string): Promise<any> {
    log.debug('debugStep: Entering method', { conversationId: id });
    const response = await fetch(`${BASE}/${encodeURIComponent(id)}/debug/step`, {
      method: 'POST',
    });
    return parse<any>(response);
  }

  /** POST /v1/chat/conversations/{id}/debug/continue — resume from a pause. */
  async debugContinue(id: string): Promise<any> {
    log.debug('debugContinue: Entering method', { conversationId: id });
    const response = await fetch(`${BASE}/${encodeURIComponent(id)}/debug/continue`, {
      method: 'POST',
    });
    return parse<any>(response);
  }

  /** PUT /v1/chat/conversations/{id}/breakpoints — replace breakpoint set. */
  async setBreakpoints(id: string, breakpoints: string[]): Promise<void> {
    log.debug('setBreakpoints: Entering method', { conversationId: id, count: breakpoints.length });
    const response = await fetch(`${BASE}/${encodeURIComponent(id)}/breakpoints`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ breakpoints }),
    });
    await parse<void>(response);
  }

  /** POST /v1/chat/conversations/{id}/cancel — cancel an in-flight run. */
  async cancel(id: string): Promise<void> {
    log.debug('cancel: Entering method', { conversationId: id });
    const response = await fetch(`${BASE}/${encodeURIComponent(id)}/cancel`, {
      method: 'POST',
    });
    await parse<void>(response);
  }

  /**
   * Subscribe to the live execution event stream (SSE) for a conversation.
   * Returns the EventSource so the caller can close it. Pass `fromSeq` to
   * replay buffered events from a known position (used when re-attaching to a
   * run that is already in progress — e.g. after navigating back to Chat).
   */
  subscribeToEvents(
    id: string,
    handlers: EventStreamHandlers,
    fromSeq?: number
  ): EventSource {
    const url =
      fromSeq !== undefined
        ? `${BASE}/${encodeURIComponent(id)}/events?fromSeq=${fromSeq}`
        : `${BASE}/${encodeURIComponent(id)}/events`;
    const es = new EventSource(url);
    es.onopen = () => {
      log.debug('Execution event stream open', { conversationId: id });
      handlers.onOpen?.();
    };
    es.onmessage = (e) => {
      try {
        handlers.onEvent(JSON.parse(e.data) as ExecutionEvent);
      } catch (err) {
        log.warn('Failed to parse SSE event', { err });
      }
    };
    es.onerror = (err) => {
      // EventSource auto-reconnects; nothing to do unless the caller wants it.
      log.debug('SSE stream error (browser will retry if still open)');
      handlers.onError?.(err);
    };
    return es;
  }
}

export const chatService = new ChatService();
