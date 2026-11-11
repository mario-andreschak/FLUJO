import { createHash } from 'node:crypto';
import type OpenAI from 'openai';
import { ConversationLogReadPressureError } from '@/backend/execution/flow/conversationLogReadAdmission';
import { loadConversationState } from '@/backend/execution/flow/loadConversationState';
import { isPersonaOwnedConversationState } from '@/backend/execution/flow/personaConversationOwnership';
import { isWorkerMode } from '@/backend/services/workspace/workerMode';
import { createLogger } from '@/utils/logger';
import { deleteCollectionItem, loadCollectionItem, saveCollectionItem } from '@/utils/storage/backend';
import { bindToCurrentWorkspace, workspaceCacheKey } from '@/utils/workspace';

/**
 * Chat apps that speak the OpenAI protocol (Open WebUI, Msty and similar) keep
 * the conversation themselves: every message arrives with the whole history
 * and no conversation id. Without help, each one becomes a new FLUJO
 * conversation.
 *
 * When a turn finishes we store a link from a fingerprint of the chat so far to
 * the FLUJO conversation. The next request whose history has that fingerprint
 * joins the conversation and contributes only its new messages.
 *
 * Links only ever hold hashes and ids. Each is used once, so a conversation has
 * at most one, and one whose conversation has gone is dropped when looked up.
 * Whenever a link cannot be used the request simply starts a new conversation
 * from the history it sent, so nothing can be blocked or overwritten.
 */
const log = createLogger('app/v1/chat/completions/externalChatContinuity');

const COLLECTION = 'external-chat-links';

type ChatMessage = OpenAI.ChatCompletionMessageParam;

interface ExternalChatLink {
  conversationId: string;
  /** The conversation must still end here, or it has moved on without this client. */
  lastMessageId: string;
}

export interface ExternalChatTurn {
  /** Set when this request continues a saved conversation. */
  conversationId?: string;
  /** What to run: only the new messages when continuing, otherwise the full request. */
  messages: ChatMessage[];
  /** Records a finished turn so the client's next message can find it. Never throws. */
  remember(reply: string, conversationId: string, lastMessageId: string | undefined): Promise<void>;
  /** Gives the link back when the turn was refused before it could change anything. Never throws. */
  release(): Promise<void>;
}

interface ExternalChatRequest {
  model: string;
  user?: unknown;
  messages: ChatMessage[];
}

// Requests that name their conversation, or belong to FLUJO's own surfaces,
// already say exactly where they go.
export function isExternalChatRequest(
  method: string,
  request: {
    model: string;
    flujo: boolean;
    flujodebug: boolean;
    conversation_id?: string;
    personaTarget?: unknown;
    processNodeId?: string;
    appendMessages?: boolean;
  },
): boolean {
  return method === 'POST'
    && !request.flujo
    && !request.flujodebug
    && !request.conversation_id
    && !request.personaTarget
    && !request.processNodeId
    && !request.appendMessages
    && !request.model.startsWith('model-')
    && !request.model.startsWith('policy/')
    && !isWorkerMode();
}

function withoutBlocks(text: string, open: string, close: string): string {
  let result = '';
  let position = 0;
  for (;;) {
    const start = text.indexOf(open, position);
    const end = start < 0 ? -1 : text.indexOf(close, start);
    if (end < 0) return result + text.slice(position);
    result += text.slice(position, start);
    position = end + close.length;
  }
}

/**
 * Clients may trim replies or fold reasoning blocks away before resending them,
 * so spacing and those blocks must not change the fingerprint.
 */
function comparableText(content: unknown): string {
  const text = typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map(part => (part?.type === 'text' ? String(part.text ?? '') : JSON.stringify(part))).join('\n')
      : '';
  return withoutBlocks(withoutBlocks(withoutBlocks(text, '<think>', '</think>'), '<thinking>', '</thinking>'),
    '<details', '</details>').replace(/\s+/g, '');
}

// System messages are left out: clients often rebuild them on every request.
function fingerprint(model: string, user: unknown, messages: Array<{ role: string; content?: unknown }>): string {
  const hash = createHash('sha256').update(JSON.stringify([model, typeof user === 'string' ? user : null]));
  for (const message of messages) {
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    const text = comparableText(message.content);
    if (text) hash.update(`\0${message.role}\0${text.length}\0`).update(text);
  }
  return hash.digest('hex');
}

// Claims and writes are per workspace: the same chat in two workspaces is two chats.
const claiming = new Set<string>();
const pendingWrites = new Map<string, Promise<void>>();
const scoped = (key: string) => workspaceCacheKey('external-chat-link', key);

function saveLink(key: string, link: ExternalChatLink): Promise<void> {
  const scopedKey = scoped(key);
  const write = saveCollectionItem(COLLECTION, key, link);
  // A streamed reply finishes before this write does; the lookup waits for it.
  const settled: Promise<void> = write.catch(() => undefined).finally(() => {
    if (pendingWrites.get(scopedKey) === settled) pendingWrites.delete(scopedKey);
  });
  pendingWrites.set(scopedKey, settled);
  return write;
}

/** Takes the link so two simultaneous requests cannot both continue one conversation. */
async function claimLink(key: string): Promise<ExternalChatLink | undefined> {
  const scopedKey = scoped(key);
  if (claiming.has(scopedKey)) return undefined;
  claiming.add(scopedKey);
  try {
    await pendingWrites.get(scopedKey);
    const link = await loadCollectionItem<ExternalChatLink | undefined>(COLLECTION, key, undefined);
    if (typeof link?.conversationId !== 'string' || typeof link.lastMessageId !== 'string') return undefined;
    await deleteCollectionItem(COLLECTION, key);
    return link;
  } catch (error) {
    log.warn('Could not read an external chat link; starting a new conversation', { error });
    return undefined;
  } finally {
    claiming.delete(scopedKey);
  }
}

async function canContinue(link: ExternalChatLink): Promise<boolean> {
  const state = await loadConversationState(link.conversationId);
  return Boolean(
    state
    && !isPersonaOwnedConversationState(state)
    && !state.meetingParticipant
    && state.status !== 'running'
    && state.status !== 'awaiting_tool_approval'
    && state.status !== 'paused_debug'
    && state.messages.at(-1)?.id === link.lastMessageId,
  );
}

export async function beginExternalChatTurn(request: ExternalChatRequest): Promise<ExternalChatTurn> {
  const { model, user, messages } = request;
  let claimed: { key: string; link: ExternalChatLink } | undefined;

  // The turn can finish outside the request's async scope (a streamed reply),
  // so both callbacks stay bound to the workspace it started in.
  const remember = bindToCurrentWorkspace(async (reply: string, conversationId: string, lastMessageId: string | undefined) => {
    try {
      if (!lastMessageId || !comparableText(reply)) return;
      const key = fingerprint(model, user, [...messages, { role: 'assistant', content: reply }]);
      await saveLink(key, { conversationId, lastMessageId });
    } catch (error) {
      log.warn('Could not save an external chat link', { error });
    }
  });
  const release = bindToCurrentWorkspace(async () => {
    const taken = claimed;
    claimed = undefined;
    if (!taken) return;
    try {
      if (await canContinue(taken.link)) await saveLink(taken.key, taken.link);
    } catch (error) {
      log.warn('Could not restore an external chat link', { error });
    }
  });
  const fresh: ExternalChatTurn = { messages, remember, release };

  let lastAssistant = messages.length - 1;
  while (lastAssistant >= 0 && messages[lastAssistant].role !== 'assistant') lastAssistant--;
  if (lastAssistant < 0) return fresh;
  const newMessages = messages.slice(lastAssistant + 1);
  if (!newMessages.some(message => message.role === 'user')) return fresh;

  const key = fingerprint(model, user, messages.slice(0, lastAssistant + 1));
  const link = await claimLink(key);
  if (!link) return fresh;

  try {
    if (!(await canContinue(link))) return fresh;
  } catch (error) {
    // Being busy says nothing about the link, so the client's retry can use it.
    if (error instanceof ConversationLogReadPressureError) {
      await saveLink(key, link).catch(() => undefined);
      throw error;
    }
    log.warn('Could not load the linked conversation; starting a new one', { error });
    return fresh;
  }

  claimed = { key, link };
  return { conversationId: link.conversationId, messages: newMessages, remember, release };
}
