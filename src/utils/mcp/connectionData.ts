/** HTTP field-name tokens (RFC 9110, section 5.6.2). Names retain their spelling. */
export function isMcpHeaderName(name: string): boolean {
  return name.length > 0 && !/[^!#$%&'*+.^_`|~0-9A-Za-z-]/.test(name);
}

/** Environment names cannot contain the separator or a string terminator. */
export function isMcpEnvironmentName(name: string): boolean {
  return name.length > 0 && !/[\0=]/.test(name);
}

/** A persisted value is a string or an own string-valued record field. */
export function ownMcpStringValue(raw: unknown): string | undefined {
  if (typeof raw === 'string') return raw;
  if (!raw || typeof raw !== 'object' || !Object.prototype.hasOwnProperty.call(raw, 'value')) return;
  const value = (raw as { value?: unknown }).value;
  return typeof value === 'string' ? value : undefined;
}

/** Define own data properties without applying a user-selected object setter. */
export function mcpStringDataRecord(values: ReadonlyMap<string, string>): Record<string, string> {
  return Object.setPrototypeOf(Object.fromEntries(values), null);
}
