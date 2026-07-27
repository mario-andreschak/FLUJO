import { z } from 'zod';

/**
 * Minimal JSON-Schema -> Zod conversion, just enough for MCP tool input schemas.
 *
 * The Claude Agent SDK's `tool()` helper advertises its input schema to the
 * model from a Zod *raw shape* (a map of property name -> ZodType). FLUJO carries
 * tool parameters as JSON Schema, so we convert the common subset
 * (object/string/number/integer/boolean/array/enum + required) plus composed
 * schemas (`oneOf`/`anyOf`/`allOf`/local `$ref`) and degrade the genuinely
 * un-representable constructs to `z.any()` rather than failing (issue #232).
 *
 * Composed schemas became first-class with the MCP 2026-07-28 spec (full JSON
 * Schema 2020-12), so this path must not silently flatten them to "no params".
 */
type JsonSchema = Record<string, unknown>;

/** Max depth we follow `$ref` chains before degrading to a permissive type. */
const MAX_REF_DEPTH = 8;

function isObject(v: unknown): v is JsonSchema {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Conversion context threaded through recursion: the local `$defs`/`definitions`
 * map for `$ref` resolution, a visited set + depth for cycle/overflow bounds, and
 * a shared `fallback` flag set whenever we had to degrade (so the caller can embed
 * the original JSON Schema in the tool description as a safety net).
 */
interface ConvertCtx {
  defs: Record<string, JsonSchema>;
  seen: Set<string>;
  depth: number;
  fallback: { hit: boolean };
}

function makeCtx(root: JsonSchema): ConvertCtx {
  const defs: Record<string, JsonSchema> = {};
  if (isObject(root.definitions)) {
    for (const [k, v] of Object.entries(root.definitions)) if (isObject(v)) defs[k] = v;
  }
  if (isObject(root.$defs)) {
    for (const [k, v] of Object.entries(root.$defs)) if (isObject(v)) defs[k] = v;
  }
  return { defs, seen: new Set(), depth: 0, fallback: { hit: false } };
}

function withDescription(zt: z.ZodTypeAny, description: unknown): z.ZodTypeAny {
  return typeof description === 'string' && description ? zt.describe(description) : zt;
}

/** Resolve a local `#/$defs/...` or `#/definitions/...` ref within bounds. */
function resolveRef(ref: string, ctx: ConvertCtx): z.ZodTypeAny {
  const m = /^#\/(?:\$defs|definitions)\/(.+)$/.exec(ref);
  if (!m) {
    ctx.fallback.hit = true;
    return z.any(); // external / unsupported ref form
  }
  const name = decodeURIComponent(m[1]);
  const target = ctx.defs[name];
  if (!target) {
    ctx.fallback.hit = true;
    return z.any(); // dangling ref
  }
  if (ctx.seen.has(name) || ctx.depth >= MAX_REF_DEPTH) {
    ctx.fallback.hit = true;
    return z.any(); // cyclic or too deep -> bounded, no hang
  }
  const childCtx: ConvertCtx = {
    ...ctx,
    seen: new Set(ctx.seen).add(name),
    depth: ctx.depth + 1,
  };
  return jsonSchemaNodeToZod(target, childCtx);
}

/**
 * Convert a single JSON Schema node to a Zod type.
 *
 * `ctx` is threaded internally during recursion; public callers can omit it and
 * a context is derived from the node's own `$defs`/`definitions`.
 */
export function jsonSchemaNodeToZod(node: unknown, ctxArg?: ConvertCtx): z.ZodTypeAny {
  if (!node || typeof node !== 'object') return z.any();
  const schema = node as JsonSchema;
  const ctx = ctxArg ?? makeCtx(schema);

  // enum -> string enum when all values are strings; otherwise punt to any.
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    if (schema.enum.every(v => typeof v === 'string')) {
      return withDescription(z.enum(schema.enum as [string, ...string[]]), schema.description);
    }
    return withDescription(z.any(), schema.description);
  }

  // --- Composed schemas (run before the `type` switch) ---------------------
  // Prefer explicit composition/refs where present; falls through to the type
  // switch when none apply so simple schemas convert exactly as before.
  if (typeof schema.$ref === 'string') {
    return withDescription(resolveRef(schema.$ref, ctx), schema.description);
  }
  if (Array.isArray(schema.allOf) && schema.allOf.length > 0) {
    const members = schema.allOf.map(m => jsonSchemaNodeToZod(m, ctx));
    const zt = members.length === 1
      ? members[0]
      : members.reduce((acc, m) => z.intersection(acc, m));
    return withDescription(zt, schema.description);
  }
  const composed = Array.isArray(schema.anyOf)
    ? schema.anyOf
    : Array.isArray(schema.oneOf)
      ? schema.oneOf
      : undefined;
  if (composed) {
    if (composed.length === 0) {
      ctx.fallback.hit = true;
      return withDescription(z.any(), schema.description);
    }
    const members = composed.map(m => jsonSchemaNodeToZod(m, ctx));
    // oneOf is modelled as a plain union (baseline). This is a superset of the
    // exclusive-oneOf contract but keeps the parameter visible and valid.
    const zt = members.length === 1
      ? members[0]
      : z.union(members as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);
    return withDescription(zt, schema.description);
  }
  // if/then/else is not faithfully representable in Zod -> degrade permissively.
  if ('if' in schema && !('type' in schema)) {
    ctx.fallback.hit = true;
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
      zt = z.array(jsonSchemaNodeToZod(schema.items, ctx));
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
        zt = z.object(shapeFromProperties(schema, ctx)).passthrough();
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

function shapeFromProperties(schema: JsonSchema, ctx: ConvertCtx): Record<string, z.ZodTypeAny> {
  const props =
    schema.properties && typeof schema.properties === 'object'
      ? (schema.properties as Record<string, unknown>)
      : {};
  const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);

  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, sub] of Object.entries(props)) {
    let zt = jsonSchemaNodeToZod(sub, ctx);
    if (!required.has(key)) zt = zt.optional();
    shape[key] = zt;
  }
  return shape;
}

/** Result of building a tool's input contract: the raw shape the SDK needs,
 * plus (only when a faithful conversion wasn't possible) the original JSON
 * Schema so the caller can surface it in the tool description. */
export interface ToolInputShape {
  shape: Record<string, z.ZodTypeAny>;
  /** Set when conversion degraded/wrapped — embed this in the tool description. */
  fallbackSchema?: JsonSchema;
}

/**
 * Build a Zod raw shape (the property map the SDK's `tool()` expects) from a
 * JSON Schema object, handling root-level composed schemas.
 */
export function buildToolInputShape(schema: unknown): ToolInputShape {
  if (!isObject(schema)) return { shape: {} };
  const root = schema;
  const ctx = makeCtx(root);

  // Fast path: a declared object shape. Backward compatible, byte-for-byte.
  const hasProps =
    isObject(root.properties) && Object.keys(root.properties as object).length > 0;
  if (hasProps) {
    return { shape: shapeFromProperties(root, ctx) };
  }

  // Root-level composition / ref. Without this the tool used to advertise NO
  // parameters (empty shape) — the core bug in #232.
  const hasComposition =
    typeof root.$ref === 'string' ||
    Array.isArray(root.allOf) ||
    Array.isArray(root.anyOf) ||
    Array.isArray(root.oneOf) ||
    'if' in root;
  if (!hasComposition) {
    // No properties and no composition -> preserve prior behaviour (empty shape,
    // e.g. a free-form `{type:'object'}` root or a non-object schema).
    return { shape: {} };
  }

  const zt = jsonSchemaNodeToZod(root, ctx);
  if (zt instanceof z.ZodObject) {
    // e.g. a `$ref` / `allOf` that resolved to a single object schema.
    return {
      shape: (zt as z.ZodObject<z.ZodRawShape>).shape as Record<string, z.ZodTypeAny>,
      fallbackSchema: ctx.fallback.hit ? root : undefined,
    };
  }
  // A genuinely composed root (union/intersection/any). The SDK can only accept
  // an object raw shape, so expose the value under a single well-known key and
  // embed the real schema in the description so the model sees the contract.
  return {
    shape: { value: zt },
    fallbackSchema: root,
  };
}

/**
 * Build a Zod raw shape from a JSON Schema object. Non-object schemas yield an
 * empty shape. Thin wrapper over {@link buildToolInputShape} kept for callers
 * that only need the shape.
 */
export function jsonSchemaToZodShape(schema: unknown): Record<string, z.ZodTypeAny> {
  return buildToolInputShape(schema).shape;
}

/**
 * Append a compact rendering of the original JSON Schema to a tool description,
 * but only when conversion degraded (`fallbackSchema` present). Simple schemas
 * get no change, so the common-case description stays byte-for-byte identical.
 */
export function embedSchemaInDescription(
  description: string,
  fallbackSchema: JsonSchema | undefined,
): string {
  if (!fallbackSchema) return description;
  const json = JSON.stringify(fallbackSchema);
  const note =
    `The parameters follow this JSON Schema (a composed/conditional schema that ` +
    `cannot be fully expressed as simple parameters) — follow it exactly:\n${json}`;
  return description ? `${description}\n\n${note}` : note;
}
