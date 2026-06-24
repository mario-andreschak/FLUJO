import { z } from 'zod';

/**
 * Minimal JSON-Schema -> Zod conversion, just enough for MCP tool input schemas.
 *
 * The Claude Agent SDK's `tool()` helper advertises its input schema to the
 * model from a Zod *raw shape* (a map of property name -> ZodType). FLUJO carries
 * tool parameters as JSON Schema, so we convert the common subset
 * (object/string/number/integer/boolean/array/enum + required) and degrade
 * unknown constructs to `z.any()` rather than failing.
 */
type JsonSchema = Record<string, unknown>;

function withDescription(zt: z.ZodTypeAny, description: unknown): z.ZodTypeAny {
  return typeof description === 'string' && description ? zt.describe(description) : zt;
}

/** Convert a single JSON Schema node to a Zod type. */
export function jsonSchemaNodeToZod(node: unknown): z.ZodTypeAny {
  if (!node || typeof node !== 'object') return z.any();
  const schema = node as JsonSchema;

  // enum -> string enum when all values are strings; otherwise punt to any.
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    if (schema.enum.every(v => typeof v === 'string')) {
      return withDescription(z.enum(schema.enum as [string, ...string[]]), schema.description);
    }
    return withDescription(z.any(), schema.description);
  }

  const rawType = schema.type;
  const type = Array.isArray(rawType) ? rawType.find(t => t !== 'null') : rawType;

  let zt: z.ZodTypeAny;
  switch (type) {
    case 'string':
      zt = z.string();
      break;
    case 'number':
      zt = z.number();
      break;
    case 'integer':
      zt = z.number().int();
      break;
    case 'boolean':
      zt = z.boolean();
      break;
    case 'array':
      zt = z.array(jsonSchemaNodeToZod(schema.items));
      break;
    case 'object': {
      const hasProps =
        schema.properties &&
        typeof schema.properties === 'object' &&
        Object.keys(schema.properties as object).length > 0;
      if (!hasProps) {
        // Free-form object (`{type:'object'}` with no declared properties, e.g.
        // SAP's `importing`/`exporting`/`tables` params). `z.object({})` runs in
        // strip mode and would silently drop every key the model supplied, so
        // the tool receives `{}`. A record preserves the arbitrary keys.
        zt = z.record(z.string(), z.any());
      } else {
        // A declared shape, but passthrough so nested/extra keys the model
        // legitimately sends aren't stripped either.
        zt = z.object(shapeFromProperties(schema)).passthrough();
      }
      break;
    }
    default:
      zt = z.any();
  }

  if (Array.isArray(rawType) && rawType.includes('null')) {
    zt = zt.nullable();
  }
  return withDescription(zt, schema.description);
}

function shapeFromProperties(schema: JsonSchema): Record<string, z.ZodTypeAny> {
  const props =
    schema.properties && typeof schema.properties === 'object'
      ? (schema.properties as Record<string, unknown>)
      : {};
  const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);

  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, sub] of Object.entries(props)) {
    let zt = jsonSchemaNodeToZod(sub);
    if (!required.has(key)) zt = zt.optional();
    shape[key] = zt;
  }
  return shape;
}

/**
 * Build a Zod raw shape (the property map the SDK's `tool()` expects) from a
 * JSON Schema object. Non-object schemas yield an empty shape.
 */
export function jsonSchemaToZodShape(schema: unknown): Record<string, z.ZodTypeAny> {
  if (!schema || typeof schema !== 'object') return {};
  return shapeFromProperties(schema as JsonSchema);
}
