import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

/** JSON data crosses the boundary verbatim. Undefined object members are omitted. */
export function normalizeToolArguments(args: Record<string, unknown>): Record<string, unknown> {
  const seen = new Set<object>();
  let entries = 0;
  const invalid = (): never => { throw new McpError(ErrorCode.InvalidParams, 'Tool arguments must be bounded JSON data'); };
  const visit = (value: unknown, depth: number): unknown => {
    if (++entries > 10_000 || depth > 32) return invalid();
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? value : invalid();
    if (typeof value !== 'object' || seen.has(value)) return invalid();
    seen.add(value);
    try {
      if (Array.isArray(value)) return Array.from({ length: value.length }, (_, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        return !descriptor || !('value' in descriptor) || descriptor.value === undefined ? invalid() : visit(descriptor.value, depth + 1);
      });
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) return invalid();
      return Object.fromEntries(Object.keys(value).flatMap(key => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !('value' in descriptor)) return invalid();
        return descriptor.value === undefined ? [] : [[key, visit(descriptor.value, depth + 1)]];
      }));
    } finally { seen.delete(value); }
  };
  if (!args || Array.isArray(args)) return invalid();
  return visit(args, 0) as Record<string, unknown>;
}
