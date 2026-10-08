import { z } from 'zod';
import { types } from 'node:util';
import { isArchivePlainObject, ModelTurnArchiveMemoryError } from '@/backend/execution/flow/modelTurnArchiveWriteBudget';

type Json = Record<string, unknown>;
interface Built { schema: z.ZodType; json: Readonly<Json>; objectShape?: Record<string, z.ZodType> }
const owned = new WeakMap<object, Readonly<Json>>();
const descriptors = new WeakSet<object>();
const DIALECT = 'https://json-schema.org/draft/2020-12/schema';
export type ArchiveSchemaProjectionPolicy = 'owned-only' | 'legacy-unbounded';

/** Baseline compatibility policy; this path retains its explicit allocation gap. */
export function projectArchiveSchema(schema: z.ZodType, policy: ArchiveSchemaProjectionPolicy): Readonly<Json> {
  const descriptor = owned.get(schema);
  if (descriptor) return descriptor;
  if (policy === 'owned-only') refuse();
  return z.toJSONSchema(schema);
}

/** Proposed constructor work units, not a V8/RSS allocation measurement. */
export const OWNED_SCHEMA_LIMITS = Object.freeze({ inputBytes: 1024 * 1024, inputValues: 16_384,
  constructionUnits: 4096, representedBytes: 8 * 1024 * 1024, depth: 48, refs: 8 });

export function getOwnedArchiveSchema(schema: object): Readonly<Json> | undefined { return owned.get(schema); }
export function isOwnedArchiveDescriptor(value: object): boolean { return descriptors.has(value); }
function refuse(): never { throw new ModelTurnArchiveMemoryError('MODEL_TURN_ARCHIVE_MEMORY_LIMIT'); }

class Meter {
  units = 0;
  bytes = 0;
  take(units = 1, bytes = 256): void {
    if (!Number.isSafeInteger(units) || !Number.isSafeInteger(bytes) || units < 0 || bytes < 0
        || this.units + units > OWNED_SCHEMA_LIMITS.constructionUnits
        || this.bytes + bytes > OWNED_SCHEMA_LIMITS.representedBytes) refuse();
    this.units += units; this.bytes += bytes;
  }
  text(value: string): void { this.take(0, value.length * 6 + 64); }
  slots(length: number): void { this.take(length, length * 64); }
}

// Validate the complete declarative input before its constructors, map/sets or
// represented metadata allocate. No hook/getter/private schema traversal.
function normalizeInput(value: unknown): { value: unknown; bytes: number } {
  let bytes = 0, count = 0;
  const active = new WeakSet<object>();
  const visit = (item: unknown, depth: number): unknown => {
    if (++count > OWNED_SCHEMA_LIMITS.inputValues || depth > OWNED_SCHEMA_LIMITS.depth) refuse();
    bytes += typeof item === 'string' ? item.length * 6 + 64 : 128;
    if (bytes > OWNED_SCHEMA_LIMITS.inputBytes) refuse();
    if (item === null || item === undefined || typeof item === 'string' || typeof item === 'boolean') return item;
    if (typeof item === 'number') { if (!Number.isFinite(item)) refuse(); return item; }
    if (typeof item !== 'object' || types.isProxy(item) || active.has(item)) refuse();
    if (!Array.isArray(item) && !isArchivePlainObject(item)) refuse();
    if (Array.isArray(item)) {
      if (item.length > OWNED_SCHEMA_LIMITS.inputValues) refuse();
      const prototype = Object.getPrototypeOf(item);
      if (!prototype || types.isProxy(prototype)) refuse();
      const constructor = Object.getOwnPropertyDescriptor(prototype, 'constructor')?.value;
      if (typeof constructor !== 'function' || types.isProxy(constructor)
          || Object.getOwnPropertyDescriptor(constructor, 'prototype')?.value !== prototype
          || Function.prototype.toString.call(constructor) !== Function.prototype.toString.call(Array)) refuse();
      if (Object.getOwnPropertyDescriptor(item, Symbol.iterator)) refuse();
      for (let index = 0; index < item.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(item, String(index));
        if (!descriptor || !('value' in descriptor)) refuse();
      }
    } else {
      for (const key of ['enum', 'description', '$ref', 'allOf', 'anyOf', 'oneOf', 'type', 'items', 'properties',
        'required', 'definitions', '$defs']) {
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        if (descriptor && (!descriptor.enumerable || !('value' in descriptor))) refuse();
      }
    }
    active.add(item);
    if (Array.isArray(item)) {
      const output: unknown[] = [];
      for (let index = 0; index < item.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(item, String(index));
        output.push(visit(descriptor!.value, depth + 1));
      }
      active.delete(item);
      return output;
    }
    const output: Json = Object.create(null);
    for (const key in item) {
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (!descriptor) continue;
      if (!('value' in descriptor) || key === '__proto__') refuse();
      bytes += key.length * 6 + 64;
      if (bytes > OWNED_SCHEMA_LIMITS.inputBytes) refuse();
      output[key] = visit(descriptor.value, depth + 1);
    }
    active.delete(item);
    return output;
  };
  const normalized = visit(value, 0);
  return { value: normalized, bytes };
}

interface Context { root: unknown; meter: Meter; defs: Json; seen: Set<string>; refDepth: number; depth: number; fallback: { hit: boolean } }
function object(value: unknown): value is Json { return !!value && typeof value === 'object' && !Array.isArray(value); }
function context(root: unknown, meter = new Meter()): Context {
  const normalized = normalizeInput(root);
  root = normalized.value;
  const defs: Json = Object.create(null);
  meter.take(1, normalized.bytes);
  if (object(root)) for (const collection of [root.definitions, root.$defs]) {
    if (object(collection)) for (const key in collection) {
      if (object(collection[key])) { meter.take(); meter.text(key); defs[key] = collection[key]; }
    }
  }
  return { root, meter, defs, seen: new Set(), refDepth: 0, depth: 0, fallback: { hit: false } };
}
function finish(schema: z.ZodType, json: Json, ctx: Context, description?: unknown,
  objectShape?: Record<string, z.ZodType>): Built {
  if (typeof description === 'string' && description) {
    ctx.meter.take(); ctx.meter.text(description);
    schema = schema.describe(description);
    json = { ...json, description };
  }
  Object.freeze(json);
  const descriptor = Object.freeze({ $schema: DIALECT, ...json });
  descriptors.add(descriptor);
  owned.set(schema, descriptor);
  return { schema, json, objectShape };
}
function any(ctx: Context, description?: unknown): Built {
  ctx.meter.take(); return finish(z.any(), {}, ctx, description);
}
function child(ctx: Context): Context {
  if (ctx.depth >= OWNED_SCHEMA_LIMITS.depth) refuse();
  return { ...ctx, depth: ctx.depth + 1 };
}
function reference(ref: string, ctx: Context): Built {
  const match = /^#\/(?:\$defs|definitions)\/(.+)$/.exec(ref);
  if (!match) { ctx.fallback.hit = true; return any(ctx); }
  const name = decodeURIComponent(match[1]);
  const target = ctx.defs[name];
  if (!object(target) || ctx.seen.has(name) || ctx.refDepth >= OWNED_SCHEMA_LIMITS.refs) {
    ctx.fallback.hit = true; return any(ctx);
  }
  ctx.meter.take(ctx.seen.size + 1);
  return node(target, { ...child(ctx), seen: new Set(ctx.seen).add(name), refDepth: ctx.refDepth + 1 });
}

function shape(root: Json, ctx: Context): { shape: Record<string, z.ZodType>; properties: Json; required: string[] } {
  const properties: Json = Object.create(null);
  const output: Record<string, z.ZodType> = Object.create(null);
  const required: string[] = [];
  const declared = Array.isArray(root.required) ? root.required : [];
  ctx.meter.slots(declared.length);
  const requiredNames = new Set(declared);
  const source = object(root.properties) ? root.properties : {};
  for (const key in source) {
    ctx.meter.take(); ctx.meter.text(key);
    const built = node(source[key], child(ctx));
    let schema = built.schema;
    if (!requiredNames.has(key)) {
      ctx.meter.take(); schema = schema.optional();
      owned.set(schema, owned.get(built.schema)!);
    } else required.push(key);
    output[key] = schema;
    properties[key] = built.json;
  }
  Object.freeze(properties); Object.freeze(required);
  return { shape: output, properties, required };
}

function node(value: unknown, ctx: Context): Built {
  ctx.meter.take(); // Before each constructor/represented node allocation.
  if (!object(value)) return any(ctx);
  const description = value.description;
  if (Array.isArray(value.enum) && value.enum.length > 0) {
    if (Array.prototype.every.call(value.enum, (item: unknown) => typeof item === 'string')) {
      ctx.meter.slots(value.enum.length);
      for (const item of value.enum) { if (typeof item !== 'string') refuse(); ctx.meter.text(item); }
      const values: string[] = Array.prototype.slice.call(value.enum);
      ctx.meter.slots(values.length * 2);
      const represented = Object.values(Object.fromEntries(values.map(item => [item, item])));
      return finish(z.enum(values), { type: 'string', enum: Object.freeze(represented) }, ctx, description);
    }
    return any(ctx, description);
  }
  if (typeof value.$ref === 'string') {
    const resolved = reference(value.$ref, ctx);
    return finish(resolved.schema, { ...resolved.json }, ctx, description, resolved.objectShape);
  }
  if (Array.isArray(value.allOf) && value.allOf.length > 0) {
    ctx.meter.slots(value.allOf.length);
    const members: Built[] = Array.prototype.map.call(value.allOf, (member: unknown) => node(member, child(ctx)));
    let built = members[0];
    for (const next of members.slice(1)) {
      ctx.meter.take();
      const parts = (entry: Built): unknown[] => Object.keys(entry.json).length === 1 && Array.isArray(entry.json.allOf)
        ? entry.json.allOf : [entry.json];
      const left = parts(built), right = parts(next);
      ctx.meter.slots(left.length + right.length);
      built = finish(z.intersection(built.schema, next.schema), { allOf: Object.freeze([...left, ...right]) }, ctx);
    }
    return finish(built.schema, { ...built.json }, ctx, description, built.objectShape);
  }
  const composition = Array.isArray(value.anyOf) ? value.anyOf : Array.isArray(value.oneOf) ? value.oneOf : undefined;
  if (composition) {
    if (!composition.length) { ctx.fallback.hit = true; return any(ctx, description); }
    ctx.meter.slots(composition.length);
    const members: Built[] = Array.prototype.map.call(composition, (member: unknown) => node(member, child(ctx)));
    if (members.length === 1) return finish(members[0].schema, { ...members[0].json }, ctx, description, members[0].objectShape);
    return finish(z.union(members.map(member => member.schema)),
      { anyOf: Object.freeze(members.map(member => member.json)) }, ctx, description);
  }
  if ('if' in value && !('type' in value)) { ctx.fallback.hit = true; return any(ctx, description); }
  const raw = value.type;
  const type = Array.isArray(raw) ? Array.prototype.find.call(raw, (item: unknown) => item !== 'null') : raw;
  let built: Built;
  switch (type) {
    case 'string': built = finish(z.string(), { type: 'string' }, ctx); break;
    case 'number': built = finish(z.number(), { type: 'number' }, ctx); break;
    case 'integer': built = finish(z.number().int(), { type: 'integer', minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER }, ctx); break;
    case 'boolean': built = finish(z.boolean(), { type: 'boolean' }, ctx); break;
    case 'array': {
      const element = node(value.items, child(ctx));
      built = finish(z.array(element.schema), { type: 'array', items: element.json }, ctx); break;
    }
    case 'object': {
      if (!object(value.properties) || Object.keys(value.properties).length === 0) {
        ctx.meter.take(2);
        built = finish(z.record(z.string(), z.any()), { type: 'object', propertyNames: Object.freeze({ type: 'string' }),
          additionalProperties: Object.freeze({}) }, ctx);
      } else {
        const fields = shape(value, ctx);
        const json: Json = { type: 'object', properties: fields.properties, additionalProperties: Object.freeze({}) };
        if (fields.required.length) json.required = fields.required;
        ctx.meter.take();
        built = finish(z.object(fields.shape).passthrough(), json, ctx, undefined, fields.shape);
      }
      break;
    }
    default: built = any(ctx);
  }
  if (Array.isArray(raw) && Array.prototype.includes.call(raw, 'null')) {
    ctx.meter.take(2);
    built = finish(built.schema.nullable(), { anyOf: Object.freeze([built.json, Object.freeze({ type: 'null' })]) }, ctx);
  }
  return finish(built.schema, { ...built.json }, ctx, description, built.objectShape);
}

export function buildOwnedArchiveSchema(value: unknown): z.ZodType {
  const ctx = context(value);
  return node(ctx.root, ctx).schema;
}

/** Same represented conversion branches as FLUJO's JSON-schema tool builder. */
function representedShape(shape: Record<string, z.ZodType>, meter: Meter): Readonly<Json> {
  const result: Json = Object.create(null);
  for (const key of Object.keys(shape)) {
    meter.take(); meter.text(key);
    result[key] = requireOwnedArchiveSchema(shape[key]);
  }
  return Object.freeze(result);
}

function buildShape(value: unknown, meter: Meter): {
  shape: Record<string, z.ZodType>; archiveShape: Readonly<Json>; fallbackSchema?: Json;
} {
  const ctx = context(value, meter);
  value = ctx.root;
  if (!object(value)) return { shape: {}, archiveShape: Object.freeze({}) };
  if (object(value.properties) && Object.keys(value.properties).length) {
    const built = shape(value, ctx).shape;
    return { shape: built, archiveShape: representedShape(built, meter) };
  }
  const composed = typeof value.$ref === 'string' || Array.isArray(value.allOf) || Array.isArray(value.anyOf)
    || Array.isArray(value.oneOf) || 'if' in value;
  if (!composed) return { shape: {}, archiveShape: Object.freeze({}) };
  const built = node(value, ctx);
  if (built.objectShape) return { shape: built.objectShape, archiveShape: representedShape(built.objectShape, meter),
    fallbackSchema: ctx.fallback.hit ? value : undefined };
  const wrapped = { value: built.schema };
  return { shape: wrapped, archiveShape: representedShape(wrapped, meter), fallbackSchema: value };
}

/** Shared meter across ALL tools in one adapter invocation, not one per tool. */
export function createOwnedToolSchemaBuilder(): (value: unknown) => ReturnType<typeof buildShape> {
  const meter = new Meter();
  return value => buildShape(value, meter);
}

export function buildOwnedToolInputShape(value: unknown): ReturnType<typeof buildShape> {
  return buildShape(value, new Meter());
}

/** Explicit policy: unowned closures cannot be projected by this bounded route. */
export function requireOwnedArchiveSchema(schema: object): Readonly<Json> {
  const descriptor = owned.get(schema);
  if (!descriptor) refuse();
  return descriptor;
}
