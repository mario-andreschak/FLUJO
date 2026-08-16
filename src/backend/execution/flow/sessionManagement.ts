/**
 * Issue #363: Session management utilities for resumable subflow child conversations.
 * Handles per-run and per-key session identity resolution, registry lookup, and updates.
 */

import { SharedState } from './types';

export const SESSION_KEY_MAX_LENGTH = 128;
const UNRESOLVED_SESSION_KEY = /\{\{[^{}]+\}\}|\$\{[^{}]+\}|@\{[^{}]+\}/;

/** Normalize a model/authored session handle. Keys are opaque: retain Unicode,
 *  delimiters, and interior whitespace so distinct caller values never collapse.
 *  Only insignificant outer whitespace is removed. Unresolved templates fall
 *  back to a fresh child rather than becoming a shared literal-key session. */
export function normalizeSessionKey(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const key = String(value).trim();
  if (!key || key.length > SESSION_KEY_MAX_LENGTH || UNRESOLVED_SESSION_KEY.test(key)) {
    return undefined;
  }
  return key;
}

/** Normalize optional transcript retention to a positive integer. Invalid values
 * are omitted so legacy nodes and malformed imported JSON remain unbounded. */
export function normalizeSessionTurnCap(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const cap = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(cap) && cap > 0 ? cap : undefined;
}

type SessionCoordinatorEntry = {
  tail: Promise<void>;
  claims: number;
};

const sessionCoordinators = new Map<string, SessionCoordinatorEntry>();

/** Claim one reusable child session in FIFO order. The release callback must be
 *  invoked from a finally block. Entries disappear after their final claimant. */
export async function acquireSessionExecution(sessionIdentity: string): Promise<() => void> {
  let entry = sessionCoordinators.get(sessionIdentity);
  if (!entry) {
    entry = { tail: Promise.resolve(), claims: 0 };
    sessionCoordinators.set(sessionIdentity, entry);
  }

  const predecessor = entry.tail;
  let resolveClaim!: () => void;
  entry.tail = new Promise<void>((resolve) => { resolveClaim = resolve; });
  entry.claims += 1;
  await predecessor;

  let released = false;
  return () => {
    if (released) return;
    released = true;
    entry!.claims -= 1;
    resolveClaim();
    if (entry!.claims === 0 && sessionCoordinators.get(sessionIdentity) === entry) {
      sessionCoordinators.delete(sessionIdentity);
    }
  };
}

/** Diagnostic used by focused coordinator tests. */
export function activeSessionCoordinatorCount(): number {
  return sessionCoordinators.size;
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
    // The key component is encoded so opaque values containing `::` cannot
    // collide with identity delimiters or with one another.
    return `${parentRunId}::${nodeId}::${encodeURIComponent(normalizedKey)}`;
  }

  return undefined;
}

/** Return the 1-based ordinal of the visit currently starting. The registry's
 * `visits` field counts terminal visits only, so the current visit is +1. */
export function currentSessionVisit(session: { visits: number }): number {
  const completedVisits = Number.isFinite(session.visits)
    ? Math.max(0, Math.floor(session.visits))
    : 0;
  return completedVisits + 1;
}

/** Look up or create a session in the registry. Returns the conversationId to use. */
export function resolveSessionConversationId(
  parentState: SharedState | undefined,
  sessionIdentity: string | undefined,
  nodeId: string,
  sessionKey: string | undefined,
): { conversationId: string; resumedVisit: boolean; sessionVisit?: number } {
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
      sessionVisit: currentSessionVisit(session),
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
    sessionVisit: currentSessionVisit(parentState.subflowSessions[sessionIdentity]),
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
