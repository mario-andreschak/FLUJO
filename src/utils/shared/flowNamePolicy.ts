const MAX_FLOW_NAME_LENGTH = 160;
const RESERVED_FLOW_NAMES = new Set([
  '.', '..', 'con', 'prn', 'aux', 'nul',
  ...Array.from({ length: 9 }, (_, index) => `com${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `lpt${index + 1}`),
]);

export type FlowNameValidationError = 'empty' | 'characters' | 'reserved' | 'length';

/** Shared human-facing Flow name policy. Flow IDs remain the only storage keys. */
export function validateFlowDisplayName(value: string): FlowNameValidationError | null {
  const normalized = value.normalize('NFC').trim();
  if (!normalized) return 'empty';
  if (normalized.length > MAX_FLOW_NAME_LENGTH) return 'length';
  if (RESERVED_FLOW_NAMES.has(normalized.toLocaleLowerCase('en-US'))) return 'reserved';
  if (!/^[\p{L}\p{N}_ -]+$/u.test(normalized)) return 'characters';
  return null;
}

/**
 * Convert generated labels into safe display names without using the result as
 * an identifier or path. A stable suffix is added only when a collision exists.
 */
export function generatedFlowName(
  value: string,
  existingNames: Iterable<string> = [],
  collisionKey = '',
): string {
  let normalized = value
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[\\/.:*?"<>|]+/g, ' ')
    .replace(/[^\p{L}\p{N}_ -]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalized || RESERVED_FLOW_NAMES.has(normalized.toLocaleLowerCase('en-US'))) {
    normalized = 'Persona Flow';
  }
  normalized = normalized.slice(0, MAX_FLOW_NAME_LENGTH).trim();

  const names = new Set(
    Array.from(existingNames, (name) => name.normalize('NFC').trim().toLocaleLowerCase('en-US')),
  );
  if (!names.has(normalized.toLocaleLowerCase('en-US'))) return normalized;

  const suffix = collisionKey.replace(/[^A-Za-z0-9_-]/g, '').slice(-8) || 'copy';
  const budget = MAX_FLOW_NAME_LENGTH - suffix.length - 1;
  return `${normalized.slice(0, budget).trim()}-${suffix}`;
}

export { MAX_FLOW_NAME_LENGTH };
