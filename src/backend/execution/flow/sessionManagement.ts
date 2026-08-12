/**
 * Issue #363: Session management utilities for resumable subflow child conversations.
 * Handles per-run and per-key session identity resolution, registry lookup, and updates.
 */

import { SharedState } from './types';

export const SESSION_KEY_MAX_LENGTH = 128;
const SESSION_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

/** Normalize a model/authored session handle. Invalid values deliberately do
 *  not acquire a session, so malformed input falls back to a fresh child. */
export function normalizeSessionKey(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const key = value.trim();
  if (!key || key.length > SESSION_KEY_MAX_LENGTH || !SESSION_KEY_PATTERN.test(key)) {
    return undefined;
  }
  return key;
}

/** Resolve session identity for a lane based on session scope. */
export function resolveSessionIdentity(
  parentRunId: string | undefined,
  nodeId: string,
  sessionScope: 'per-visit' | 'per-run' | 'per-key' | undefined,
  sessionKey: string | undefined,
): string | undefined {
  if (!parentRunId || !nodeId || !sessionScope || sessionScope === 'per-visit') return undefined;

  if (sessionScope === 'per-run') {
    return `${parentRunId}::${nodeId}::`;
  }

  const normalizedKey = normalizeSessionKey(sessionKey);
  if (sessionScope === 'per-key' && normalizedKey) {
    return `${parentRunId}::${nodeId}::${normalizedKey}`;
  }

  return undefined;
}

/** Look up or create a session in the registry. Returns the conversationId to use. */
export function resolveSessionConversationId(
  parentState: SharedState | undefined,
  sessionIdentity: string | undefined,
  nodeId: string,
  sessionKey: string | undefined,
): { conversationId: string; resumedVisit: boolean } {
  if (!sessionIdentity || !parentState) {
    // No session, generate a new conversation ID
    return {
      conversationId: crypto.randomUUID ? crypto.randomUUID() : generateUUID(),
      resumedVisit: false,
    };
  }

  // Look up in registry
  const session = parentState.subflowSessions?.[sessionIdentity];
  if (session && session.conversationId) {
    session.lastUsedAt = Date.now();
    session.status = 'running';
    // Reuse existing session
    return {
      conversationId: session.conversationId,
      resumedVisit: true,
    };
  }

  // Session doesn't exist yet, create it
  const newConversationId = crypto.randomUUID ? crypto.randomUUID() : generateUUID();
  if (!parentState.subflowSessions) {
    parentState.subflowSessions = {};
  }

  parentState.subflowSessions[sessionIdentity] = {
    version: 1,
    conversationId: newConversationId,
    nodeId,
    sessionKey: normalizeSessionKey(sessionKey),
    visits: 0,
    lastUsedAt: Date.now(),
    status: 'running',
  };

  return {
    conversationId: newConversationId,
    resumedVisit: false,
  };
}

/** Update session registry after a lane completes. */
export function updateSessionRegistry(
  parentState: SharedState | undefined,
  sessionIdentity: string | undefined,
  laneStatus: 'completed' | 'error' | 'cancelled',
) {
  if (!sessionIdentity || !parentState) return;

  const session = parentState.subflowSessions?.[sessionIdentity];
  if (!session) return;

  session.visits += 1;
  session.lastUsedAt = Date.now();
  session.status = laneStatus === 'completed' ? 'idle' : laneStatus === 'error' ? 'failed' : 'idle';
}

/** Generate a UUID v4-like string (fallback if crypto.randomUUID is unavailable). */
function generateUUID(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
