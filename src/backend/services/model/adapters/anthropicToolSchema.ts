import { types } from 'node:util';

type Schema = Record<string, unknown>;
const COMPOSITIONS = ['allOf', 'anyOf', 'oneOf'] as const;

/** Tool schemas come from JSON. Bound this compatibility projection before
 * recursing or serializing guidance, and never invoke schema getters/hooks. */
function validateProjection(schema: Schema): void {
  const active = new WeakSet<object>();
  const stack: { value: unknown; depth: number; exit?: boolean }[] = [{ value: schema, depth: 0 }];
  let values = 0;
  let characters = 0;
  const refuse = () => { throw new Error('Tool schema is too large, cyclic, or is not plain JSON.'); };
  while (stack.length) {
    const { value, depth, exit } = stack.pop()!;
    if (exit) { active.delete(value as object); continue; }
    if (++values > 20_000 || depth > 64) refuse();
    if (typeof value === 'string') characters += value.length;
    if (characters > 1_000_000) refuse();
    if (value === null || ['string', 'boolean', 'undefined'].includes(typeof value)) continue;
    if (typeof value === 'number') { if (!Number.isFinite(value)) refuse(); continue; }
    if (typeof value !== 'object' || types.isProxy(value)) refuse();
    const record = value as object;
    const prototype = Object.getPrototypeOf(record);
    if (!Array.isArray(record) && prototype !== Object.prototype && prototype !== null) refuse();
    if (active.has(record)) refuse();
    active.add(record);
    stack.push({ value: record, depth, exit: true });
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(record))) {
      if (!('value' in descriptor)) refuse();
      if (!descriptor.enumerable) continue;
      characters += key.length;
      stack.push({ value: descriptor.value, depth: depth + 1 });
    }
  }
}

function object(value: unknown): Schema {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Schema : {};
}

function required(schema: Schema): string[] {
  return Array.isArray(schema.required)
    ? schema.required.filter((name): name is string => typeof name === 'string') : [];
}

/** Project root compositions onto an object for native tool validators.
 * Advertise the object fields and retain cross-field constraints as guidance;
 * this permissive projection does not replace the original MCP validator.
 * MCP still owns validation of the original schema; argument names stay intact.
 * Nested compositions (property schemas) are supported and must be preserved.
 */
export function toAnthropicToolSchema(schema: Schema): Schema {
  if (types.isProxy(schema)) throw new Error('Tool schema is not plain JSON.');
  if (!COMPOSITIONS.some(key => Object.hasOwn(schema, key))) return schema;
  validateProjection(schema);
  return projectSchema(schema);
}

function projectSchema(schema: Schema): Schema {
  if (!COMPOSITIONS.some(key => Object.hasOwn(schema, key))) return schema;

  const result: Schema = { ...schema, type: 'object' };
  const properties = { ...object(schema.properties) };
  const requiredNames = new Set(required(schema));
  const constraints: Schema = {};
  for (const key of COMPOSITIONS) {
    if (!Object.hasOwn(schema, key)) continue;
    constraints[key] = schema[key];
    delete result[key];
    if (!Array.isArray(schema[key])) continue;
    const branches = schema[key].map(branch => projectSchema(object(branch)));
    const names = new Set(branches.flatMap(branch => Object.keys(object(branch.properties))));
    for (const name of names) {
      const definitions = branches.map(branch => {
        const branchProperties = object(branch.properties);
        return Object.hasOwn(branchProperties, name) ? branchProperties[name] : undefined;
      })
        .filter(definition => definition !== undefined);
      // A union branch that leaves a field unconstrained must remain permissive.
      const definition = key !== 'allOf' && definitions.length < branches.length
        ? {} : definitions.length === 1 ? definitions[0]
          : { [key === 'allOf' ? 'allOf' : 'anyOf']: definitions };
      Object.defineProperty(properties, name, {
        value: Object.hasOwn(properties, name) ? { allOf: [properties[name], definition] } : definition,
        enumerable: true, configurable: true, writable: true,
      });
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
