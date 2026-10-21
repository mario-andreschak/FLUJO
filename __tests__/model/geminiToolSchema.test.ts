import { geminiToolSchema } from '@/backend/services/model/adapters/geminiToolSchema';

it('keeps browser selector/coordinate alternatives while declaring required properties locally', () => {
  const schema = {
    type: 'object',
    properties: { selector: { type: 'string', minLength: 1 }, x: { type: 'number' }, y: { type: 'number' } },
    anyOf: [{ required: ['selector'] }, { required: ['x', 'y'] }],
    additionalProperties: false,
  };
  const original = structuredClone(schema);
  expect(geminiToolSchema(schema)).toEqual({
    ...schema,
    anyOf: [
      { required: ['selector'], properties: { selector: schema.properties.selector } },
      { required: ['x', 'y'], properties: { x: schema.properties.x, y: schema.properties.y } },
    ],
  });
  expect(schema).toEqual(original);
});

it('retains branch constraints and does not inherit properties into another object or literal data', () => {
  const literal = { anyOf: [{ required: ['root'] }] };
  const schema = {
    properties: {
      root: { type: 'string' },
      nested: { type: 'object', anyOf: [{ required: ['root'] }] },
      list: { type: 'array', items: { properties: { n: { type: 'number' } }, oneOf: [{ required: ['n'] }] } },
    },
    allOf: [{ anyOf: [{ required: ['root'], properties: { root: { const: 'only' } } }] }],
    default: literal,
    enum: [literal],
  };
  expect(geminiToolSchema(schema)).toMatchObject({
    properties: {
      nested: schema.properties.nested,
      list: { items: { oneOf: [{ required: ['n'], properties: { n: { type: 'number' } } }] } },
    },
    allOf: schema.allOf,
    default: literal,
    enum: [literal],
  });
});
