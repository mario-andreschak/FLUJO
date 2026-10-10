import { z } from 'zod';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createArchiveOwnedFixture, removeArchiveOwnedFixture } from '../flow/fixtures/archiveOwnedFixture';

let forbidProjection = false;
const projectionProbe = jest.fn();
jest.mock('zod', () => {
  const actual = jest.requireActual<typeof import('zod')>('zod');
  return { ...actual, z: { ...actual.z,
    toJSONSchema: (...args: Parameters<typeof actual.z.toJSONSchema>) => {
      projectionProbe();
      if (forbidProjection) throw new Error('Archive invoked a forbidden Zod projector');
      return actual.z.toJSONSchema(...args);
    },
  } };
});
import { buildOwnedArchiveSchema, buildOwnedToolInputShape, createOwnedToolSchemaBuilder,
  getOwnedArchiveSchema, OWNED_SCHEMA_LIMITS, projectArchiveSchema, requireOwnedArchiveSchema } from '@/backend/services/model/adapters/ownedArchiveSchema';
import { buildToolInputShape, jsonSchemaNodeToZod } from './fixtures/legacyJsonSchemaToZod';
import { estimateArchivePayload, getArchiveWritePressure, ModelTurnArchiveMemoryError,
  withArchiveWriteMemory, isArchiveSchema } from '@/backend/execution/flow/modelTurnArchiveWriteBudget';
import { _setModelTurnArchiveDirForTests, archiveModelDispatch, readModelTurnSnapshot } from '@/backend/execution/flow/modelTurnArchive';

const cases: Array<{ name: string; schema: unknown; values: unknown[] }> = [
  { name: 'string description', schema: { type: 'string', description: 'retained' }, values: ['x', 1] },
  { name: 'number', schema: { type: 'number' }, values: [1.5, 'no'] },
  { name: 'integer bounds', schema: { type: 'integer' }, values: [1, 1.5, Number.MAX_SAFE_INTEGER + 1] },
  { name: 'boolean', schema: { type: 'boolean' }, values: [true, 'no'] },
  { name: 'enum order and duplicates', schema: { enum: ['2', '1', 'a', 'a'] }, values: ['a', 'x'] },
  { name: 'array', schema: { type: 'array', items: { type: 'string' } }, values: [['x'], [1]] },
  { name: 'free object', schema: { type: 'object' }, values: [{ extra: 1 }, []] },
  { name: 'required optional passthrough', schema: { type: 'object', properties: { a: { type: 'string' }, b: { type: 'number' } }, required: ['a'] }, values: [{ a: 'x', extra: 1 }, { b: 1 }] },
  { name: 'nullable', schema: { type: ['string', 'null'] }, values: ['x', null, 1] },
  { name: 'oneOf represented as union', schema: { oneOf: [{ type: 'string' }, { type: 'number' }] }, values: ['x', 1, true] },
  { name: 'allOf', schema: { allOf: [{ type: 'object', properties: { a: { type: 'string' } }, required: ['a'] }, { type: 'object', properties: { b: { type: 'number' } }, required: ['b'] }] }, values: [{ a: 'x', b: 1 }, { a: 'x' }] },
  { name: 'local ref', schema: { $ref: '#/$defs/A', $defs: { A: { type: 'integer' } } }, values: [1, 'x'] },
  { name: 'cyclic ref degradation', schema: { $ref: '#/$defs/A', $defs: { A: { type: 'object', properties: { next: { $ref: '#/$defs/A' } } } } }, values: [{}, { next: { any: 1 } }] },
  { name: 'conditional fallback', schema: { if: { type: 'string' } }, values: ['x', 1] },
  { name: 'nested compact union', schema: { anyOf: [{ anyOf: [{ type: 'string' }, { type: 'number' }] }, { type: 'null' }, { type: 'boolean' }] }, values: ['x', 1, null, true] },
  { name: 'duplicate compact union', schema: { anyOf: [{ type: 'string' }, { type: 'string' }] }, values: ['x', 1] },
  { name: 'constrained union', schema: { anyOf: [{ type: 'integer' }, { type: 'number' }] }, values: [1.5, 'x'] },
  { name: 'described nullable', schema: { type: ['string', 'null'], description: 'nullable text' }, values: ['x', null, 1] },
  { name: 'annotated union branch', schema: { anyOf: [{ type: 'string', description: 'retained' }, { type: 'number' }] }, values: ['x', 1, false] },
  { name: 'intersection duplicate fields', schema: { allOf: [{ type: 'object', properties: { a: { type: 'string' } } }, { type: 'object', properties: { a: { type: 'string' }, b: { type: 'number' } }, required: ['b'] }] }, values: [{ a: 'x', b: 1 }, { b: 'x' }] },
  { name: 'intersection conflicting fields', schema: { allOf: [{ type: 'object', properties: { a: { type: 'string' } } }, { type: 'object', properties: { a: { type: 'number' } } }] }, values: [{}, { a: 'x' }, { a: 1 }] },
  { name: 'intersection nested objects', schema: { allOf: [{ type: 'object', properties: { a: { type: 'object', properties: { x: { type: 'string' } } } } }, { type: 'object', properties: { a: { type: 'object', properties: { y: { type: 'number' } } } } }] }, values: [{ a: { x: 'x', y: 1 } }, { a: { y: 'x' } }] },
  { name: 'annotated intersection member', schema: { allOf: [{ type: 'object', properties: { a: { type: 'string' } }, description: 'retained' }, { type: 'object', properties: { b: { type: 'number' } } }] }, values: [{ a: 'x', b: 1 }, { b: 'x' }] },
  { name: 'intersection distributes over union', schema: { allOf: [{ type: 'object', properties: { a: { type: 'string' } }, required: ['a'] }, { anyOf: [{ type: 'object', properties: { b: { type: 'number' } }, required: ['b'] }, { type: 'object', properties: { c: { type: 'boolean' } }, required: ['c'] }] }] }, values: [{ a: 'x', b: 1 }, { a: 'x', c: true }, { b: 1 }] },
  { name: 'three overlapping intersection members', schema: { allOf: [{ type: 'object', properties: { a: { type: 'string' } } }, { type: 'object', properties: { a: { type: 'number' } } }, { type: 'object', properties: { a: { type: 'boolean' } } }] }, values: [{}, { a: 'x' }, { a: 1 }] },
  { name: 'nested intersection duplicates', schema: { allOf: [{ allOf: [{ type: 'object', properties: { a: { type: 'string' } } }, { type: 'object', properties: { a: { type: 'number' } } }] }, { type: 'object', properties: { a: { type: 'number' } } }] }, values: [{}, { a: 'x' }, { a: 1 }] },
  { name: 'three members with distributed required fields', schema: { allOf: [{ type: 'object', properties: { a: { type: 'string' } }, required: ['a'] }, { anyOf: [{ type: 'object', properties: { b: { type: 'number' } }, required: ['b'] }, { type: 'object', properties: { c: { type: 'boolean' } }, required: ['c'] }] }, { type: 'object', properties: { d: { type: 'string' } }, required: ['d'] }] }, values: [{ a: 'x', b: 1, d: 'x' }, { a: 'x', c: true, d: 'x' }, { b: 1 }] },
  { name: 'intersection preserves referenced raw members', schema: { allOf: [{ $ref: '#/$defs/A' }, { type: 'object', properties: { a: { type: 'boolean' } } }], $defs: { A: { allOf: [{ type: 'object', properties: { a: { type: 'string' } } }, { type: 'object', properties: { a: { type: 'number' } } }] } } }, values: [{}, { a: false }] },
  { name: 'intersection preserves single union branch raw members', schema: { allOf: [{ oneOf: [{ allOf: [{ type: 'object', properties: { a: { type: 'string' } } }, { type: 'object', properties: { a: { type: 'number' } } }] }] }, { type: 'object', properties: { a: { type: 'boolean' } } }] }, values: [{}, { a: false }] },
  { name: 'annotated nested intersection stays unflattened', schema: { allOf: [{ allOf: [{ type: 'object', properties: { a: { type: 'string' } } }, { type: 'object', properties: { a: { type: 'number' } } }], description: 'retained annotation' }, { type: 'object', properties: { a: { type: 'boolean' } } }] }, values: [{}, { a: false }] },
  { name: 'annotated duplicate field declaration order', schema: { allOf: [{ type: 'object', properties: { a: { type: 'object', properties: { x: { type: 'string' }, y: { type: 'number' } }, description: 'retained' } } }, { type: 'object', properties: { a: { type: 'object', properties: { y: { type: 'number' }, x: { type: 'string' } }, description: 'retained' } } }] }, values: [{}, { a: { x: 'x', y: 1 } }, { a: { y: 'x' } }] },
];

it.each(cases)('retains actual provider parsing and exact represented metadata: $name', ({ schema, values }) => {
  const original = jsonSchemaNodeToZod(schema);
  const candidate = buildOwnedArchiveSchema(schema);
  expect(getOwnedArchiveSchema(candidate)).toEqual(z.toJSONSchema(candidate));
  expect(z.toJSONSchema(candidate)).toEqual(z.toJSONSchema(original));
  for (const value of values) {
    const before = original.safeParse(value), after = candidate.safeParse(value);
    expect(after.success).toBe(before.success);
    if (before.success && after.success) expect(after.data).toEqual(before.data);
  }
});

it.each(cases)('retains actual SDK raw shape and fallback contract: $name', ({ schema }) => {
  const original = buildToolInputShape(schema), candidate = buildOwnedToolInputShape(schema);
  expect(Object.keys(candidate.shape)).toEqual(Object.keys(original.shape));
  expect(candidate.fallbackSchema).toEqual(original.fallbackSchema);
  for (const key of Object.keys(original.shape)) {
    expect(requireOwnedArchiveSchema(candidate.shape[key])).toEqual(z.toJSONSchema(original.shape[key]));
  }
});

it('rejects descriptor getters and callback/private input before any evaluation', () => {
  const getter = jest.fn(() => ({ type: 'string' }));
  const input = Object.defineProperty({}, 'properties', { enumerable: true, get: getter });
  expect(() => buildOwnedArchiveSchema(input)).toThrow(ModelTurnArchiveMemoryError);
  expect(getter).not.toHaveBeenCalled();
  const trap = jest.fn();
  expect(() => buildOwnedArchiveSchema(new Proxy({}, { ownKeys: trap }))).toThrow(ModelTurnArchiveMemoryError);
  expect(trap).not.toHaveBeenCalled();
});

it('shares constructor/output capacity across tools instead of renewing per-tool capacity', () => {
  const build = createOwnedToolSchemaBuilder();
  const schema = { properties: { text: { type: 'string', description: 'x'.repeat(32 * 1024) } } };
  let admitted = 0;
  expect(() => { for (; admitted < 100; admitted++) build(schema); }).toThrow(ModelTurnArchiveMemoryError);
  expect(admitted).toBeGreaterThan(0);
  expect(admitted).toBeLessThan(100);
  expect(OWNED_SCHEMA_LIMITS.representedBytes).toBe(8 * 1024 * 1024);
});

it('charges distributed intersection expansion before exceeding owned construction capacity', () => {
  const properties = Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`a${index}`, { type: 'string' }]));
  const schema = { allOf: [{ type: 'object', properties }, { anyOf: Array.from({ length: 30 }, (_, index) => ({
    type: 'object', properties: { [`b${index}`]: { type: 'number' } },
  })) }] };
  projectionProbe.mockClear();
  expect(() => buildOwnedArchiveSchema(schema)).toThrow(ModelTurnArchiveMemoryError);
  expect(projectionProbe).not.toHaveBeenCalled();
});

it('charges retained and repeatedly flattened nested members against the same construction capacity', () => {
  let schema: unknown = { type: 'object', properties: { a0: { type: 'string' } } };
  for (let index = 1; index < 30; index++) schema = { allOf: [schema, {
    type: 'object', properties: { [`a${index}`]: { type: 'string' } },
  }] };
  projectionProbe.mockClear();
  expect(() => buildOwnedArchiveSchema(schema)).toThrow(ModelTurnArchiveMemoryError);
  expect(projectionProbe).not.toHaveBeenCalled();
});

it('writes and reads exact owned archive bytes without invoking the actual Zod projector', async () => {
  const schema = buildOwnedArchiveSchema({ type: 'string' });
  const represented = requireOwnedArchiveSchema(schema);
  const fixture = await createArchiveOwnedFixture();
  const priorArchive = _setModelTurnArchiveDirForTests(path.join(fixture.root, 'archives'));
  const priorData = process.env.FLUJO_DATA_DIR, priorParent = process.env.FLUJO_PARENT_DATA_DIR;
  process.env.FLUJO_DATA_DIR = fixture.root;
  delete process.env.FLUJO_PARENT_DATA_DIR;
  forbidProjection = true;
  projectionProbe.mockClear();
  let failed = false;
  let primary: unknown;
  try {
    expect(estimateArchivePayload({ schema }, true)).toBeGreaterThan(0);
    const entry = await archiveModelDispatch({ conversationId: 'owned-schema', nodeId: 'node', modelId: 'model',
      modelName: 'offline', adapter: 'control', operation: 'archive', attempt: 1,
      canonicalMessages: [{ id: 'original', role: 'user', timestamp: 1, content: 'retained history' }],
      genericWire: [{ role: 'user', content: 'retained history' }], sdkRequest: { schema },
    });
    const snapshot = await readModelTurnSnapshot('owned-schema', entry.id);
    expect(snapshot!.sdkRequest).toEqual({ schema: represented });
    expect(snapshot!.canonicalMessages[0].content).toBe('retained history');
    expect(projectionProbe).not.toHaveBeenCalled();
  } catch (error) { failed = true; primary = error; throw error; }
  finally {
    forbidProjection = false;
    const errors: unknown[] = [];
    const pressure = getArchiveWritePressure();
    const steps: Array<() => void | Promise<void>> = [
      () => { _setModelTurnArchiveDirForTests(priorArchive); },
      () => { if (priorData === undefined) delete process.env.FLUJO_DATA_DIR; else process.env.FLUJO_DATA_DIR = priorData; },
      () => { if (priorParent === undefined) delete process.env.FLUJO_PARENT_DATA_DIR; else process.env.FLUJO_PARENT_DATA_DIR = priorParent; },
      async () => {
        if (failed || errors.length || pressure.bytes || pressure.writers || pressure.quarantined) {
          await fs.writeFile(path.join(fixture.root, 'failed-owned-schema-control.json'), JSON.stringify({ failed, pressure }));
          throw new Error(`Preserving failed/uncertain fixture ${fixture.root}`);
        }
        await removeArchiveOwnedFixture(fixture);
      },
    ];
    for (const step of steps) { try { await step(); } catch (error) { errors.push(error); } }
    if (errors.length) throw new AggregateError(primary === undefined ? errors : [primary, ...errors], 'Owned schema control cleanup failed');
  }
});

it('rejects an unowned default closure under explicit owned-only policy', async () => {
  const closure = jest.fn(() => 'generated');
  const schema = z.string().default(closure);
  const callback = jest.fn(async () => undefined);
  await expect(withArchiveWriteMemory({ schema }, callback, 'owned-only')).rejects.toMatchObject({ code: 'MODEL_TURN_ARCHIVE_MEMORY_LIMIT' });
  expect(closure).not.toHaveBeenCalled();
  expect(callback).not.toHaveBeenCalled();
});

it('retains default admission compatibility for an ordinary unowned Zod schema', async () => {
  const schema = z.string().describe('Legacy SDK input');
  const callback = jest.fn(async () => 'admitted');
  await expect(withArchiveWriteMemory({ schema }, callback)).resolves.toBe('admitted');
  expect(callback).toHaveBeenCalledTimes(1);
});

it('does not execute inherited getters on absent declarative fields', () => {
  const getter = jest.fn(() => { throw new Error('Inherited schema getter was evaluated'); });
  const prior = Object.getOwnPropertyDescriptor(Object.prototype, 'definitions');
  Object.defineProperty(Object.prototype, 'definitions', { configurable: true, get: getter });
  try {
    const schema = buildOwnedArchiveSchema({ type: 'string' });
    expect(requireOwnedArchiveSchema(schema)).toMatchObject({ type: 'string' });
    expect(getter).not.toHaveBeenCalled();
  } finally {
    if (prior) Object.defineProperty(Object.prototype, 'definitions', prior);
    else Reflect.deleteProperty(Object.prototype, 'definitions');
  }
});

it('does not invoke Zod Symbol.hasInstance through an opaque marker getter', () => {
  const getter = jest.fn(() => { throw new Error('Opaque marker getter executed'); });
  const value = Object.defineProperty({}, '_zod', { get: getter });
  expect(isArchiveSchema(value)).toBe(false);
  expect(getter).not.toHaveBeenCalled();
});

it('recognizes actual installed SDK schema prototypes without reading projector accessors', () => {
  const schemas = [z.string(), z.object({ text: z.string() }), z.string().nullable(), z.number().optional()];
  for (const schema of schemas) {
    const getter = jest.fn(() => { throw new Error('Projector accessor evaluated'); });
    Object.defineProperty(schema, 'toJSONSchema', { get: getter });
    expect(isArchiveSchema(schema)).toBe(true);
    expect(estimateArchivePayload({ schema }, true)).toBeGreaterThan(0);
    expect(projectArchiveSchema(schema, 'legacy-unbounded')).toEqual(z.toJSONSchema(schema));
    expect(getter).not.toHaveBeenCalled();
  }
});

it('rejects lookalike schemas, arbitrary inherited accessors and proxy prototypes without hooks', () => {
  const getter = jest.fn(() => { throw new Error('Untrusted inherited projector evaluated'); });
  const prototype = Object.defineProperty({}, 'toJSONSchema', { get: getter });
  const value = Object.create(prototype);
  const marker = Object.defineProperty({}, 'traits', { get: getter });
  Object.defineProperty(value, '_zod', { value: marker });
  Object.defineProperty(value, 'type', { value: 'string' });
  expect(isArchiveSchema(value)).toBe(false);
  const trap = jest.fn(() => { throw new Error('Proxy prototype evaluated'); });
  Object.setPrototypeOf(value, new Proxy(prototype, { get: trap, getOwnPropertyDescriptor: trap, getPrototypeOf: trap }));
  expect(isArchiveSchema(value)).toBe(false);
  expect(getter).not.toHaveBeenCalled();
  expect(trap).not.toHaveBeenCalled();
});

it('treats a second actual Zod module as opaque without traversing its schema graph', () => {
  let foreign!: z.ZodType;
  jest.isolateModules(() => {
    const separate = jest.requireActual<typeof import('zod')>('zod');
    foreign = separate.z.object({ text: separate.z.string() });
  });
  expect(Object.getPrototypeOf(foreign)).not.toBe(z.ZodObject.prototype);
  const getter = jest.fn(() => { throw new Error('Foreign schema graph evaluated'); });
  Object.defineProperty(foreign, 'privateArchiveHook', { enumerable: true, get: getter });
  Object.defineProperty(foreign, 'toJSONSchema', { get: getter });
  expect(isArchiveSchema(foreign)).toBe(false);
  expect(estimateArchivePayload({ foreign }, true)).toBeGreaterThan(0);
  expect(() => estimateArchivePayload(foreign)).toThrow(ModelTurnArchiveMemoryError);
  expect(getter).not.toHaveBeenCalled();
});
