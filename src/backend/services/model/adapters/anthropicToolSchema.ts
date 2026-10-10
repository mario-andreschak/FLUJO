type Schema = Record<string, unknown>;
const COMPOSITIONS = ['allOf', 'anyOf', 'oneOf'] as const;

function object(value: unknown): Schema {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Schema : {};
}

function required(schema: Schema): string[] {
  return Array.isArray(schema.required)
    ? schema.required.filter((name): name is string => typeof name === 'string') : [];
}

/** Anthropic rejects root composition keywords, including through OpenRouter.
 * Advertise the object fields and retain cross-field constraints as guidance.
 * MCP still owns validation of the original schema; argument names stay intact.
 * Nested compositions (property schemas) are supported and must be preserved.
 */
export function toAnthropicToolSchema(schema: Schema): Schema {
  if (!COMPOSITIONS.some(key => key in schema)) return schema;

  const result: Schema = { ...schema, type: 'object' };
  const properties = { ...object(schema.properties) };
  const requiredNames = new Set(required(schema));
  const constraints: Schema = {};
  for (const key of COMPOSITIONS) {
    if (!(key in schema)) continue;
    constraints[key] = schema[key];
    delete result[key];
    if (!Array.isArray(schema[key])) continue;
    const branches = schema[key].map(branch => toAnthropicToolSchema(object(branch)));
    const names = new Set(branches.flatMap(branch => Object.keys(object(branch.properties))));
    for (const name of names) {
      const definitions = branches.map(branch => object(branch.properties)[name])
        .filter(definition => definition !== undefined);
      // A union branch that leaves a field unconstrained must remain permissive.
      const definition = key !== 'allOf' && definitions.length < branches.length
        ? {} : definitions.length === 1 ? definitions[0]
          : { [key === 'allOf' ? 'allOf' : 'anyOf']: definitions };
      properties[name] = name in properties
        ? { allOf: [properties[name], definition] } : definition;
    }
    const branchRequired = branches.map(required);
    for (const name of branchRequired.flat()) {
      if (key === 'allOf' || branchRequired.every(names => names.includes(name))) {
        requiredNames.add(name);
      }
    }
  }
  return {
    ...result,
    properties,
    ...(requiredNames.size ? { required: [...requiredNames] } : {}),
    description: [schema.description,
      `Arguments must also satisfy these JSON Schema constraints: ${JSON.stringify(constraints)}`]
      .filter(Boolean).join('\n'),
  };
}
