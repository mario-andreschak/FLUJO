import { jsonSchemaToZodShape, jsonSchemaNodeToZod } from '@/backend/services/model/adapters/jsonSchemaToZod';

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
});
