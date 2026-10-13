import { ElicitRequestSchema, ElicitResultSchema, type ElicitResult } from '@modelcontextprotocol/sdk/types.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import type { JsonSchemaType, JsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/types';
import { createLogger } from '@/utils/logger';
import { getCurrentWorkspace, workspaceCacheKey } from '@/utils/workspace';
import { executionEventBus } from '@/backend/execution/flow/engine/ExecutionEventBus';
import type { EmitFn, NodeRef } from '@/shared/types/execution/events';

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
const MAX_PENDING_PER_CONVERSATION = 8;
const MAX_PENDING_PROCESS = 128;
const MAX_PROMPT_BYTES = 32 * 1024;

export interface PendingElicitationMetadata {
  conversationId: string;
  message: string;
  requestedSchema: Record<string, unknown>;
  node?: NodeRef;
}

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
  let snapshot: PendingElicitationMetadata | undefined;
  let validate: JsonSchemaValidator<unknown> | undefined;
  let emit: EmitFn | undefined;
  if (metadata) {
    if (!metadata.conversationId || Buffer.byteLength(JSON.stringify(metadata)) > MAX_PROMPT_BYTES) {
      throw new Error('Elicitation prompt exceeds the supported input limits.');
    }
    // Form elicitation permits a flat, primitive JSON Schema. Reject unsupported
    // schemas before presenting a form that cannot safely be answered.
    ElicitRequestSchema.parse({ method: 'elicitation/create', params: {
      mode: 'form', message: metadata.message, requestedSchema: metadata.requestedSchema,
    } });
    snapshot = JSON.parse(JSON.stringify(metadata)) as PendingElicitationMetadata;
    validate = new AjvJsonSchemaValidator().getValidator(snapshot.requestedSchema as JsonSchemaType);
    emit = executionEventBus.emitterFor(metadata.conversationId);
  }
  return new Promise<ElicitResult>((resolve) => {
    const timer = setTimeout(() => {
      if (registry.get(key) === pending) {
        log.warn(`Elicitation ${elicitationId} timed out after ${timeoutMs}ms; auto-cancelling`);
        settle(key, pending, { action: 'cancel' });
      }
    }, timeoutMs);

    const pending: PendingElicitation = { workspace, elicitationId, metadata: snapshot, createdAt: Date.now(), emit, validate, resolve, timer };
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
  if (!parsed.success || (result.action === 'accept'
    && (Buffer.byteLength(JSON.stringify(result.content ?? {})) > MAX_PROMPT_BYTES
      || !pending.validate?.(result.content ?? {}).valid))) throw new InvalidElicitationResponseError();
  return settle(key, pending, parsed.data);
}

export function cancelConversationElicitation(conversationId: string, elicitationId: string): boolean {
  return resolveConversationElicitation(conversationId, elicitationId, { action: 'cancel' });
}

export function hasPendingElicitation(conversationId: string, elicitationId: string): boolean {
  return registry.get(keyOf(elicitationId, conversationId))?.metadata?.conversationId === conversationId;
}

/** Cloned, bounded prompt metadata, never callbacks or external authorization. */
export function listPendingElicitations(conversationId: string): Array<{
  elicitationId: string; message: string; requestedSchema: Record<string, unknown>; createdAt: number; node?: NodeRef;
}> {
  const workspace = getCurrentWorkspace();
  return Array.from(registry.values()).filter(pending => pending.workspace === workspace
    && pending.metadata?.conversationId === conversationId).map(pending => ({
    elicitationId: pending.elicitationId,
    message: pending.metadata!.message,
    requestedSchema: JSON.parse(JSON.stringify(pending.metadata!.requestedSchema)) as Record<string, unknown>,
    createdAt: pending.createdAt,
    ...(pending.metadata!.node ? { node: { ...pending.metadata!.node } } : {}),
  }));
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
