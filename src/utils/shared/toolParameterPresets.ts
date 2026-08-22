import type { MCPToolParameterPresets } from '@/shared/types/mcp';

export function getToolParameterPresets(
  presets: MCPToolParameterPresets | undefined,
  toolName: string,
): Record<string, unknown> {
  const value = presets?.[toolName];
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

/** Node values win one parameter at a time over server-wide defaults. */
export function mergeToolParameterPresets(
  serverPresets: MCPToolParameterPresets | undefined,
  nodePresets: MCPToolParameterPresets | undefined,
  toolName: string,
): Record<string, unknown> {
  return {
    ...getToolParameterPresets(serverPresets, toolName),
    ...getToolParameterPresets(nodePresets, toolName),
  };
}

/**
 * Remove fixed top-level arguments from the model-facing schema. The original
 * server schema is left untouched and remains the identity/staleness baseline.
 */
export function hidePresetParameters(
  schema: Record<string, unknown> | undefined,
  presetArgs: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const cloned = JSON.parse(JSON.stringify(schema ?? { type: 'object', properties: {} })) as Record<string, unknown>;
  const keys = new Set(Object.keys(presetArgs ?? {}));
  if (keys.size === 0) return cloned;

  if (cloned.properties && typeof cloned.properties === 'object' && !Array.isArray(cloned.properties)) {
    const properties = cloned.properties as Record<string, unknown>;
    for (const key of keys) delete properties[key];
  }
  if (Array.isArray(cloned.required)) {
    const required = cloned.required.filter((key: unknown) => typeof key !== 'string' || !keys.has(key));
    if (required.length === 0) delete cloned.required;
    else cloned.required = required;
  }
  if (cloned.dependentRequired && typeof cloned.dependentRequired === 'object') {
    const dependentRequired = cloned.dependentRequired as Record<string, unknown>;
    for (const key of keys) delete dependentRequired[key];
    for (const [key, dependencies] of Object.entries(dependentRequired)) {
      if (Array.isArray(dependencies)) {
        dependentRequired[key] = dependencies.filter((dependency: unknown) => (
          typeof dependency !== 'string' || !keys.has(dependency)
        ));
      }
    }
  }
  if (cloned.dependencies && typeof cloned.dependencies === 'object') {
    const dependencies = cloned.dependencies as Record<string, unknown>;
    for (const key of keys) delete dependencies[key];
  }
  return cloned;
}

/** Convert a form string to the primitive/object type declared by JSON Schema. */
export function coercePresetEditorValue(value: string, schema: Record<string, unknown> | undefined): unknown {
  const trimmed = value.trim();
  // Parse structured JSON before the reference check so nested placeholders
  // remain strings inside a real object/array instead of turning the entire
  // parameter into a JSON-looking string.
  if (schema?.type === 'object' || schema?.type === 'array') {
    try { return JSON.parse(value); } catch { return value; }
  }
  // References must stay strings until execution-time resolution.
  if (/\$\{global:[^}]+\}/.test(value) || /@(conversation|flows?|node|model|app|time|date|folder|file)(?:\[|\.|\b)/.test(value)) {
    return value;
  }
  if (schema?.type === 'boolean') return trimmed === 'true';
  if (schema?.type === 'integer') {
    const parsed = Number.parseInt(trimmed, 10);
    return Number.isNaN(parsed) ? value : parsed;
  }
  if (schema?.type === 'number') {
    const parsed = Number(trimmed);
    return Number.isNaN(parsed) ? value : parsed;
  }
  if (schema?.type === 'null') return null;
  return value;
}

export function presetEditorValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return '';
  return JSON.stringify(value);
}
