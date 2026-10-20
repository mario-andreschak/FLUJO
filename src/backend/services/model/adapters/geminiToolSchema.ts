type Schema = Record<string, unknown>;

function isSchema(value: unknown): value is Schema {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Gemini validates required names locally inside composition branches, whereas
 * JSON Schema permits their properties to be declared alongside anyOf/oneOf.
 * Repeat only inherited definitions for the same instance; never lift a nested
 * object's properties or change required/alternative constraints.
 */
export function geminiToolSchema(schema: Schema): Schema {
  function visit(value: unknown, inherited: Schema = {}): unknown {
    if (!isSchema(value)) return value;
    const result: Schema = { ...value };
    let properties: Schema = isSchema(value.properties) ? { ...value.properties } : {};
    for (const name of Array.isArray(value.required) ? value.required : []) {
      if (typeof name === 'string' && !Object.hasOwn(properties, name) && Object.hasOwn(inherited, name)) {
        properties = { ...properties, [name]: inherited[name] };
      }
    }
    if (isSchema(value.properties) || Object.keys(properties).length) {
      result.properties = Object.fromEntries(Object.entries(properties).map(([key, child]) => [key, visit(child)]));
    }
    const sameInstance = { ...inherited, ...properties };
    for (const key of ['anyOf', 'oneOf', 'allOf']) {
      if (Array.isArray(value[key])) result[key] = value[key].map(child => visit(child, sameInstance));
    }
    for (const key of ['not', 'if', 'then', 'else']) {
      if (isSchema(value[key])) result[key] = visit(value[key], sameInstance);
    }
    for (const key of ['items', 'additionalProperties', 'contains', 'propertyNames', 'unevaluatedProperties']) {
      if (isSchema(value[key])) result[key] = visit(value[key]);
    }
    for (const key of ['$defs', 'definitions', 'patternProperties', 'dependentSchemas']) {
      if (isSchema(value[key])) {
        result[key] = Object.fromEntries(Object.entries(value[key]).map(([name, child]) => [
          name, visit(child, key === 'dependentSchemas' ? sameInstance : {}),
        ]));
      }
    }
    if (Array.isArray(value.prefixItems)) result.prefixItems = value.prefixItems.map(child => visit(child));
    return result;
  }
  return visit(schema) as Schema;
}
