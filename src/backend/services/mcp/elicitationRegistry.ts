import { ElicitRequestSchema, ElicitResultSchema, type ElicitResult } from '@modelcontextprotocol/sdk/types.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import type { JsonSchemaType, JsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/types';
import { createLogger } from '@/utils/logger';
import { getCurrentWorkspace, workspaceCacheKey } from '@/utils/workspace';
import { executionEventBus } from '@/backend/execution/flow/engine/ExecutionEventBus';
import type { EmitFn, NodeRef, PendingElicitationPrompt } from '@/shared/types/execution/events';
import { vetElicitationUrl } from '@/shared/utils/elicitationUrl';

const log = createLogger('backend/services/mcp/elicitationRegistry');

/**
 * In-memory registry of elicitation requests awaiting user responses.
 *
 * When an MCP server sends `elicitation/create` during a tool call, the handler
 * suspends execution by registering a promise here, fires an SSE event to the
 * frontend, and waits. The `/respond` route resolves (or cancels) the promise
 * when the user submits or dismisses the form.
 *
 * Module-level singleton, mirroring toolApprovalRegistry.ts and the
 * ExecutionEventBus (survives Next.js dev hot-reloads via globalThis).
 */
const ELICITATION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
/** Signing in or paying on another site takes longer than filling in a form. */
export const URL_ELICITATION_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_PENDING_PER_CONVERSATION = 8;
const MAX_PENDING_PROCESS = 128;
const MAX_PROMPT_BYTES = 32 * 1024;

interface PendingElicitationBase {
  conversationId: string;
  message: string;
  /** Configured name of the MCP server that asks, shown on the card. */
  serverName?: string;
  node?: NodeRef;
}

export interface PendingFormElicitation extends PendingElicitationBase {
  mode?: 'form';
  requestedSchema: Record<string, unknown>;
}

export interface PendingUrlElicitation extends PendingElicitationBase {
  mode: 'url';
  url: string;
  /** The server's own id; `notifications/elicitation/complete` names it. */
  serverElicitationId?: string;
}

export type PendingElicitationMetadata = PendingFormElicitation | PendingUrlElicitation;

/** What a conversation snapshot shows: the prompt, never callbacks or answers. */
export type PendingElicitationSnapshot = PendingElicitationPrompt;

export class InvalidElicitationResponseError extends Error {
  constructor() { super('The response does not match the pending elicitation schema.'); }
}

interface PendingElicitation {
  workspace: string;
  elicitationId: string;
  metadata?: PendingElicitationMetadata;
  createdAt: number;
  emit?: EmitFn;
  validate?: JsonSchemaValidator<unknown>;
  resolve: (result: ElicitResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

const globalForRegistry = globalThis as unknown as {
  __flujoElicitationRegistry?: Map<string, PendingElicitation>;
};
const registry: Map<string, PendingElicitation> =
  globalForRegistry.__flujoElicitationRegistry ??
  (globalForRegistry.__flujoElicitationRegistry = new Map());

function keyOf(elicitationId: string, conversationId?: string): string {
  return conversationId === undefined ? workspaceCacheKey(elicitationId)
    : workspaceCacheKey('conversation-elicitation', conversationId, elicitationId);
}

function settle(key: string, pending: PendingElicitation, result: ElicitResult): boolean {
  if (registry.get(key) !== pending) return false;
  clearTimeout(pending.timer);
  registry.delete(key);
  pending.emit?.({ type: 'run:elicitation_resolved', elicitationId: pending.elicitationId, action: result.action });
  pending.resolve(result);
  return true;
}

function checkedMetadata(metadata: PendingElicitationMetadata): {
  snapshot: PendingElicitationMetadata; validate?: JsonSchemaValidator<unknown>;
} {
  if (!metadata.conversationId || Buffer.byteLength(JSON.stringify(metadata)) > MAX_PROMPT_BYTES) {
    throw new Error('Elicitation prompt exceeds the supported input limits.');
  }
  if (metadata.mode === 'url') {
    const vetted = vetElicitationUrl(metadata.url);
    if (!vetted) throw new Error('The MCP server asked to open a link FLUJO cannot offer safely.');
    return { snapshot: { ...JSON.parse(JSON.stringify(metadata)) as PendingUrlElicitation, url: vetted.href } };
  }
  // Form elicitation permits a flat, primitive JSON Schema. Reject unsupported
  // schemas before presenting a form that cannot safely be answered.
  ElicitRequestSchema.parse({ method: 'elicitation/create', params: {
    mode: 'form', message: metadata.message, requestedSchema: metadata.requestedSchema,
  } });
  const form = JSON.parse(JSON.stringify(metadata)) as PendingFormElicitation;
  return { snapshot: form, validate: new AjvJsonSchemaValidator().getValidator(form.requestedSchema as JsonSchemaType) };
}

/**
 * Register a pending elicitation and return a promise that resolves when the
 * user submits or cancels the form. Auto-cancels after `timeoutMs` ms
 * (default 5 minutes) to prevent promise leaks.
 */
export function registerPendingElicitation(
  elicitationId: string,
  timeoutMs: number = ELICITATION_TIMEOUT_MS,
  metadata?: PendingElicitationMetadata,
): Promise<ElicitResult> {
  const workspace = getCurrentWorkspace();
  const key = keyOf(elicitationId, metadata?.conversationId);
  if (registry.has(key) || registry.size >= MAX_PENDING_PROCESS
    || (metadata && listPendingElicitations(metadata.conversationId).length >= MAX_PENDING_PER_CONVERSATION)) {
    throw new Error('Too many pending elicitations or duplicate elicitation ID.');
  }
  const checked = metadata ? checkedMetadata(metadata) : undefined;
  const emit = metadata ? executionEventBus.emitterFor(metadata.conversationId) : undefined;
  return new Promise<ElicitResult>((resolve) => {
    const timer = setTimeout(() => {
      if (registry.get(key) === pending) {
        log.warn(`Elicitation ${elicitationId} timed out after ${timeoutMs}ms; auto-cancelling`);
        settle(key, pending, { action: 'cancel' });
      }
    }, timeoutMs);

    const pending: PendingElicitation = {
      workspace, elicitationId, metadata: checked?.snapshot, createdAt: Date.now(), emit, validate: checked?.validate, resolve, timer,
    };
    registry.set(key, pending);
  });
}

/**
 * Resolve a pending elicitation (user submitted or cancelled). Returns true if
 * a matching pending elicitation existed — the `/respond` route uses this to
 * distinguish an elicitation response from other action types.
 */
export function resolveElicitation(
  elicitationId: string,
  result: ElicitResult
): boolean {
  const key = keyOf(elicitationId);
  const pending = registry.get(key);
  if (!pending || pending.metadata) return false;
  return settle(key, pending, result);
}

/** Conversation routes may resolve only the mailbox owned by that conversation. */
export function resolveConversationElicitation(
  conversationId: string,
  elicitationId: string,
  result: ElicitResult,
): boolean {
  const key = keyOf(elicitationId, conversationId);
  const pending = registry.get(key);
  if (!pending || pending.metadata?.conversationId !== conversationId) return false;
  const parsed = ElicitResultSchema.safeParse(result);
  if (!parsed.success) throw new InvalidElicitationResponseError();
  if (pending.metadata.mode === 'url') {
    // Accepting a link request means the person opened it and finished there.
    // Only the decision goes back to the server.
    if (result.action === 'accept' && result.content !== undefined) throw new InvalidElicitationResponseError();
    return settle(key, pending, { action: result.action });
  }
  if (result.action === 'accept'
    && (Buffer.byteLength(JSON.stringify(result.content ?? {})) > MAX_PROMPT_BYTES
      || !pending.validate?.(result.content ?? {}).valid)) throw new InvalidElicitationResponseError();
  return settle(key, pending, parsed.data);
}

export function cancelConversationElicitation(conversationId: string, elicitationId: string): boolean {
  return resolveConversationElicitation(conversationId, elicitationId, { action: 'cancel' });
}

/**
 * The server says the person finished a link request
 * (`notifications/elicitation/complete`). Unknown or already finished ids are
 * ignored, as the specification requires.
 */
export function completeServerUrlElicitation(serverName: string, serverElicitationId: string): boolean {
  const workspace = getCurrentWorkspace();
  for (const [key, pending] of registry) {
    const metadata = pending.metadata;
    if (pending.workspace === workspace && metadata?.mode === 'url'
      && metadata.serverName === serverName && metadata.serverElicitationId === serverElicitationId) {
      return settle(key, pending, { action: 'accept' });
    }
  }
  return false;
}

export function hasPendingElicitation(conversationId: string, elicitationId: string): boolean {
  return registry.get(keyOf(elicitationId, conversationId))?.metadata?.conversationId === conversationId;
}

function snapshotOf(pending: PendingElicitation, metadata: PendingElicitationMetadata): PendingElicitationSnapshot {
  const base = {
    elicitationId: pending.elicitationId,
    message: metadata.message,
    createdAt: pending.createdAt,
    ...(metadata.serverName ? { serverName: metadata.serverName } : {}),
    ...(metadata.node ? { node: { ...metadata.node } } : {}),
  };
  return metadata.mode === 'url'
    ? { ...base, mode: 'url', url: metadata.url }
    : { ...base, mode: 'form', requestedSchema: JSON.parse(JSON.stringify(metadata.requestedSchema)) as Record<string, unknown> };
}

/** Cloned, bounded prompt metadata, never callbacks or external authorization. */
export function listPendingElicitations(conversationId: string): PendingElicitationSnapshot[] {
  const workspace = getCurrentWorkspace();
  return Array.from(registry.values()).flatMap(pending => pending.workspace === workspace
    && pending.metadata?.conversationId === conversationId ? [snapshotOf(pending, pending.metadata)] : []);
}

/**
 * Every prompt waiting in this workspace, for the approvals inbox. Ids, server
 * and kind only: the question text and the link stay in the conversation.
 */
export function listAllPendingElicitations(): Array<{
  conversationId: string; elicitationId: string; mode: 'form' | 'url'; serverName?: string; createdAt: number;
}> {
  const workspace = getCurrentWorkspace();
  return Array.from(registry.values()).flatMap(pending => pending.workspace === workspace && pending.metadata ? [{
    conversationId: pending.metadata.conversationId,
    elicitationId: pending.elicitationId,
    mode: pending.metadata.mode === 'url' ? 'url' as const : 'form' as const,
    ...(pending.metadata.serverName ? { serverName: pending.metadata.serverName } : {}),
    createdAt: pending.createdAt,
  }] : []);
}

/** Stop this conversation without cancelling other conversations or authorization. */
export function clearPendingElicitations(conversationId: string): void {
  const workspace = getCurrentWorkspace();
  for (const [key, pending] of registry) {
    if (pending.workspace === workspace && pending.metadata?.conversationId === conversationId) {
      settle(key, pending, { action: 'cancel' });
    }
  }
}

/** Cancel a pending elicitation (server-side or timeout path). */
export function cancelElicitation(elicitationId: string): boolean {
  return resolveElicitation(elicitationId, { action: 'cancel' });
}

/** Cancel all pending elicitations for clean shutdown (e.g. server disconnect). */
export function clearAllElicitations(): void {
  const workspace = getCurrentWorkspace();
  for (const [id, pending] of registry.entries()) {
    if (pending.workspace !== workspace) continue;
    settle(id, pending, { action: 'cancel' });
  }
}
