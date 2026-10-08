import {
  jsonSchemaToZodShape,
  jsonSchemaNodeToZod,
  buildToolInputShape,
  embedSchemaInDescription,
} from '@/backend/services/model/adapters/jsonSchemaToZod';

describe('jsonSchemaToZod', () => {
  it('builds a shape with required vs optional properties', () => {
    const shape = jsonSchemaToZodShape({
      type: 'object',
      properties: {
        city: { type: 'string' },
        days: { type: 'integer' },
      },
      required: ['city'],
    });

    expect(Object.keys(shape).sort()).toEqual(['city', 'days']);

    // Required string accepts a string and rejects a number.
    expect(shape.city.safeParse('Berlin').success).toBe(true);
    expect(shape.city.safeParse(5).success).toBe(false);

    // Optional integer accepts undefined.
    expect(shape.days.safeParse(undefined).success).toBe(true);
    expect(shape.days.safeParse(3).success).toBe(true);
    expect(shape.days.safeParse(3.5).success).toBe(false);
  });

  it('returns an empty shape for non-object schemas', () => {
    expect(jsonSchemaToZodShape(undefined)).toEqual({});
    expect(jsonSchemaToZodShape('nope')).toEqual({});
  });

  it('handles enums, booleans, and arrays', () => {
    expect(jsonSchemaNodeToZod({ type: 'boolean' }).safeParse(true).success).toBe(true);

    const enumZod = jsonSchemaNodeToZod({ enum: ['a', 'b'] });
    expect(enumZod.safeParse('a').success).toBe(true);
    expect(enumZod.safeParse('c').success).toBe(false);

    const arrZod = jsonSchemaNodeToZod({ type: 'array', items: { type: 'string' } });
    expect(arrZod.safeParse(['x', 'y']).success).toBe(true);
    expect(arrZod.safeParse([1]).success).toBe(false);
  });

  it('degrades unknown constructs to a permissive type', () => {
    // No recognizable type -> z.any(), which accepts anything.
    const anyZod = jsonSchemaNodeToZod({ description: 'mystery' });
    expect(anyZod.safeParse({ whatever: true }).success).toBe(true);
  });

  // Regression: an open-ended object param (e.g. SAP's `importing`) used to
  // become z.object({}), whose strip mode silently emptied every key the model
  // sent — so the tool received {} and SAP rejected the call.
  it('preserves arbitrary keys for a free-form object (no declared properties)', () => {
    const zt = jsonSchemaNodeToZod({ type: 'object' });
    const parsed = zt.safeParse({ REQUTEXT: 'Hello from MCP' });
    expect(parsed.success).toBe(true);
    expect((parsed as any).data).toEqual({ REQUTEXT: 'Hello from MCP' });
  });

  it('keeps declared keys AND passes through extra keys for a shaped object', () => {
    const zt = jsonSchemaNodeToZod({
      type: 'object',
      properties: { action: { type: 'string' } },
      required: ['action'],
    });
    const parsed = zt.safeParse({ action: 'call', commit_mode: 'none' });
    expect(parsed.success).toBe(true);
    // The undeclared `commit_mode` survives instead of being stripped.
    expect((parsed as any).data).toEqual({ action: 'call', commit_mode: 'none' });
  });

  it('round-trips inner keys of a nested free-form object property', () => {
    const shape = jsonSchemaToZodShape({
      type: 'object',
      properties: {
        function: { type: 'string' },
        importing: { type: 'object' }, // free-form object property
      },
      required: ['function'],
    });
    // The nested object preserves the model-supplied key.
    const parsed = shape.importing.safeParse({ REQUTEXT: 'x' });
    expect(parsed.success).toBe(true);
    expect((parsed as any).data).toEqual({ REQUTEXT: 'x' });
  });

  // --- Composed schemas (issue #232) --------------------------------------

  it('converts anyOf of primitives to a union that accepts each member', () => {
    const zt = jsonSchemaNodeToZod({ anyOf: [{ type: 'string' }, { type: 'number' }] });
    expect(zt.safeParse('hello').success).toBe(true);
    expect(zt.safeParse(42).success).toBe(true);
    expect(zt.safeParse(true).success).toBe(false);
  });

  it('converts oneOf of primitives to a union', () => {
    const zt = jsonSchemaNodeToZod({ oneOf: [{ type: 'string' }, { type: 'boolean' }] });
    expect(zt.safeParse('x').success).toBe(true);
    expect(zt.safeParse(false).success).toBe(true);
    expect(zt.safeParse(3).success).toBe(false);
  });

  it('collapses a single-member composition to that member', () => {
    const zt = jsonSchemaNodeToZod({ anyOf: [{ type: 'string' }] });
    expect(zt.safeParse('x').success).toBe(true);
    expect(zt.safeParse(1).success).toBe(false);
  });

  it('converts allOf of two object schemas to an intersection requiring both', () => {
    const zt = jsonSchemaNodeToZod({
      allOf: [
        { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
        { type: 'object', properties: { b: { type: 'number' } }, required: ['b'] },
      ],
    });
    expect(zt.safeParse({ a: 'x', b: 1 }).success).toBe(true);
    // Missing one of the required members fails the intersection.
    expect(zt.safeParse({ a: 'x' }).success).toBe(false);
    expect(zt.safeParse({ b: 1 }).success).toBe(false);
  });

  it('resolves a local $ref against $defs', () => {
    const zt = jsonSchemaNodeToZod({
      $ref: '#/$defs/Name',
      $defs: { Name: { type: 'string' } },
    });
    expect(zt.safeParse('Ada').success).toBe(true);
    expect(zt.safeParse(5).success).toBe(false);
  });

  it('resolves a local $ref against legacy definitions', () => {
    const zt = jsonSchemaNodeToZod({
      $ref: '#/definitions/Age',
      definitions: { Age: { type: 'integer' } },
    });
    expect(zt.safeParse(30).success).toBe(true);
    expect(zt.safeParse('nope').success).toBe(false);
  });

  it('degrades a dangling $ref to a permissive type without throwing', () => {
    const zt = jsonSchemaNodeToZod({ $ref: '#/$defs/Missing' });
    expect(zt.safeParse({ anything: true }).success).toBe(true);
  });

  it('bounds cyclic $refs instead of hanging', () => {
    const zt = jsonSchemaNodeToZod({
      $ref: '#/$defs/Node',
      $defs: {
        Node: {
          type: 'object',
          properties: { next: { $ref: '#/$defs/Node' } },
        },
      },
    });
    // The point is that construction terminates; parsing an object still works.
    expect(zt.safeParse({}).success).toBe(true);
  });

  // --- Root-level shape extraction (the core #232 bug) --------------------

  it('advertises a non-empty shape for a root-level oneOf (regression for #232)', () => {
    const built = buildToolInputShape({
      oneOf: [{ type: 'string' }, { type: 'number' }],
    });
    // Previously the shape was {} -> tool advertised as taking no parameters.
    expect(Object.keys(built.shape).length).toBeGreaterThan(0);
    // A composed root is wrapped under a single key and flagged for embedding.
    expect(built.fallbackSchema).toBeDefined();
  });

  it('keeps the empty-shape fast path for simple / free-form roots', () => {
    expect(buildToolInputShape(undefined).shape).toEqual({});
    expect(buildToolInputShape({ type: 'object' }).shape).toEqual({});
    expect(buildToolInputShape({ type: 'object' }).fallbackSchema).toBeUndefined();
  });

  it('extracts the object shape from a root-level $ref to an object def', () => {
    const built = buildToolInputShape({
      $ref: '#/$defs/Params',
      $defs: {
        Params: {
          type: 'object',
          properties: { city: { type: 'string' } },
          required: ['city'],
        },
      },
    });
    expect(Object.keys(built.shape)).toEqual(['city']);
    expect(built.shape.city.safeParse('Berlin').success).toBe(true);
  });

  // --- Description embedding safety net -----------------------------------

  it('leaves the description untouched when no fallback occurred', () => {
    expect(embedSchemaInDescription('do a thing', undefined)).toBe('do a thing');
  });

  it('embeds the original JSON Schema when a fallback occurred', () => {
    const original = { oneOf: [{ type: 'string' }, { type: 'number' }] };
    const out = embedSchemaInDescription('do a thing', original);
    expect(out).toContain('do a thing');
    expect(out).toContain(JSON.stringify(original));
  });
});
