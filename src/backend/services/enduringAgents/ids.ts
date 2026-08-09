import { createHash, randomUUID } from 'crypto';

import { ENDURING_AGENT_SAFE_ID_PATTERN } from '@/shared/types/enduringAgent/schemas';

import { canonicalJson } from './behaviorRevisions';

const ENDURING_AGENT_ID_PREFIX_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,15}$/;

function validateEnduringAgentIdPrefix(prefix: string): void {
  if (!ENDURING_AGENT_ID_PREFIX_PATTERN.test(prefix)) {
    throw new Error(`Invalid enduring-agent id prefix: ${JSON.stringify(prefix)}`);
  }
}

function assertSafeGeneratedId(id: string): string {
  if (!ENDURING_AGENT_SAFE_ID_PATTERN.test(id)) {
    throw new Error(`Generated invalid enduring-agent id: ${JSON.stringify(id)}`);
  }
  return id;
}

/**
 * Build an id accepted by the collection storage boundary (ASCII, <=64 chars).
 * The readable prefix is diagnostic only; identity comes from the full SHA-256
 * digest encoded as base64url.
 */
export function stableEnduringAgentId(prefix: string, value: unknown): string {
  validateEnduringAgentIdPrefix(prefix);
  const digest = createHash('sha256')
    .update(canonicalJson(value))
    .digest('base64url');
  return assertSafeGeneratedId(`${prefix}_${digest}`);
}

/** Random safe id for an explicitly non-idempotent creation request. */
export function randomEnduringAgentId(prefix: string): string {
  validateEnduringAgentIdPrefix(prefix);
  return assertSafeGeneratedId(`${prefix}_${randomUUID().replaceAll('-', '')}`);
}
