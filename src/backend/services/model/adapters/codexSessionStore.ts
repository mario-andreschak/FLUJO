import { createHash } from 'crypto';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';

interface ToolFingerprint {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  annotations?: ToolAnnotations;
}

export interface StoredCodexSession {
  threadId: string;
  prefixHash: string;
  seenMessageCount: number;
  historyHash: string;
  updatedAt: number;
}

interface CodexSessionObservation {
  threadId: string;
  prefixHash: string;
  seenMessageCount: number;
  historyHash: string;
}

const MAX_TRACKED_SESSIONS = 200;
const sessions = new Map<string, StoredCodexSession>();

export function codexSessionKey(conversationId: string, nodeId: string): string {
  return `${conversationId}::${nodeId}`;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`)
    .join(',')}}`;
}

/**
 * Hash every part of the persisted Codex prefix that must remain stable before
 * a thread can safely receive only the newly appended FLUJO messages.
 */
export function computeCodexPrefixHash(
  model: string,
  systemPrompt: string | undefined,
  tools: readonly ToolFingerprint[],
): string {
  const hash = createHash('sha256');
  hash.update(stableStringify({
    model,
    systemPrompt: systemPrompt ?? '',
    tools: [...tools]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(({ name, description, inputSchema, annotations }) => ({
        name,
        description,
        inputSchema: inputSchema ?? null,
        annotations: annotations ?? null,
      })),
  }));
  return hash.digest('hex');
}

export function findReusableCodexSession(
  key: string,
  prefixHash: string,
  currentMessages: readonly unknown[],
): StoredCodexSession | undefined {
  const existing = sessions.get(key);
  if (!existing) return undefined;
  if (existing.prefixHash !== prefixHash) return undefined;
  if (currentMessages.length < existing.seenMessageCount) return undefined;
  if (
    computeCodexHistoryHash(currentMessages.slice(0, existing.seenMessageCount)) !==
    existing.historyHash
  ) {
    return undefined;
  }
  return existing;
}

function normalizeMessage(message: unknown): Record<string, unknown> {
  if (!message || typeof message !== 'object') return { value: message };
  const source = message as Record<string, unknown>;
  const normalized: Record<string, unknown> = {};
  for (const key of [
    'role',
    'content',
    'name',
    'tool_call_id',
    'tool_calls',
    'function_call',
    'refusal',
  ]) {
    if (source[key] !== undefined) normalized[key] = source[key];
  }
  return normalized;
}

/** Hash the provider-visible conversation prefix, excluding FLUJO persistence metadata. */
export function computeCodexHistoryHash(messages: readonly unknown[]): string {
  return createHash('sha256')
    .update(stableStringify(messages.map(normalizeMessage)))
    .digest('hex');
}

export function recordCodexSession(key: string, observation: CodexSessionObservation): void {
  sessions.delete(key);
  if (sessions.size >= MAX_TRACKED_SESSIONS) {
    const oldest = sessions.keys().next();
    if (!oldest.done) sessions.delete(oldest.value);
  }
  sessions.set(key, { ...observation, updatedAt: Date.now() });
}

export function invalidateCodexSession(key: string): void {
  sessions.delete(key);
}

/** Test seam. */
export function _clearCodexSessionsForTests(): void {
  sessions.clear();
}
