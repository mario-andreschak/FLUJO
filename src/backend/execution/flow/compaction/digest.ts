import { createHash } from 'crypto';
import type { FlujoChatMessage } from '@/shared/types/chat';
import type { CompactionProjectionIdentity } from './types';

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

function sha256(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(value)))
    .digest('hex');
}

/**
 * Digest the complete projected message shape. Identity and metadata are
 * deliberately included so edits that leave visible text unchanged still
 * invalidate an artifact.
 */
export function digestProjectedMessages(messages: readonly FlujoChatMessage[]): string {
  return sha256(messages);
}

export function digestProjectionIdentity(identity: CompactionProjectionIdentity): string {
  return sha256(identity);
}
