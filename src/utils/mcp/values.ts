import type { EnvVarValue } from '@/shared/types/mcp';

/** Accept the persisted MCP value shape without dropping explicit secret metadata. */
export function mcpValueRecord(value: unknown, secretNames: readonly string[] = []): Record<string, EnvVarValue> {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('MCP environment variables and headers must be objects.');
  }
  return Object.fromEntries(Object.entries(value).map(([name, raw]) => {
    if (typeof raw === 'string') {
      return [name, secretNames.includes(name) ? { value: raw, metadata: { isSecret: true } } : raw];
    }
    if (raw && typeof raw === 'object' && typeof raw.value === 'string'
      && raw.metadata && typeof raw.metadata.isSecret === 'boolean') {
      return [name, { value: raw.value, metadata: { isSecret: raw.metadata.isSecret || secretNames.includes(name) } }];
    }
    throw new Error('Each MCP environment variable or header must be a string or a value with boolean secret metadata.');
  }));
}

export function plainMcpValues(values?: Record<string, EnvVarValue>): Record<string, string> {
  return Object.fromEntries(Object.entries(values ?? {}).map(([name, raw]) => [name, typeof raw === 'string' ? raw : raw.value]));
}

/** Replacing a value never silently removes the registry/config's secret flag. */
export function mergeMcpValues(base: Record<string, EnvVarValue> = {}, overrides: Record<string, EnvVarValue> = {}): Record<string, EnvVarValue> {
  const merged = { ...base };
  for (const [name, value] of Object.entries(overrides)) {
    const existing = merged[name];
    merged[name] = existing && typeof existing === 'object' && existing.metadata?.isSecret
      ? { value: typeof value === 'string' ? value : value.value, metadata: { isSecret: true } }
      : value;
  }
  return merged;
}
