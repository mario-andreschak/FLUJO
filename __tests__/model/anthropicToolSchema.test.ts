import { toAnthropicTools } from '@/backend/services/model/adapters/anthropicAdapter';
import { toAnthropicToolSchema } from '@/backend/services/model/adapters/anthropicToolSchema';

jest.mock('@/utils/logger', () => ({ createLogger: () => ({ warn: jest.fn() }) }));

it.each([
  ['click', { selector: { type: 'string', minLength: 1 }, x: { type: 'number' }, y: { type: 'number' } },
    [{ required: ['selector'] }, { required: ['x', 'y'] }]],
  ['scroll', { deltaX: { type: 'number' }, deltaY: { type: 'number' } },
    [{ required: ['deltaX'] }, { required: ['deltaY'] }]],
])('advertises browser %s without the root anyOf rejected by Claude', (name, properties, anyOf) => {
  const schema = { type: 'object', properties, anyOf, additionalProperties: false };
  const original = JSON.stringify(schema);
  const tool = toAnthropicTools([{ type: 'function', function: { name, parameters: schema } }])![0];
  expect(tool.input_schema).toMatchObject({ type: 'object', properties, additionalProperties: false });
  expect(tool.input_schema).not.toHaveProperty('anyOf');
  expect(tool.input_schema).not.toHaveProperty('required');
  expect(tool.input_schema.description).toContain(JSON.stringify({ anyOf }));
  expect(JSON.stringify(schema)).toBe(original);
});

it('preserves nested compositions and leaves compatible schemas untouched', () => {
  const schema = { type: 'object', properties: { value: { anyOf: [{ type: 'string' }, { type: 'number' }] } } };
  expect(toAnthropicToolSchema(schema)).toBe(schema);
});

it('promotes allOf fields and required names without dropping field constraints', () => {
  const schema = { type: 'object', properties: { count: { type: 'number' } }, required: ['count'], allOf: [
    { properties: { count: { minimum: 1 }, path: { type: 'string' } }, required: ['path'] },
    { properties: { count: { maximum: 10 } } },
  ] };
  expect(toAnthropicToolSchema(schema)).toMatchObject({
    properties: { count: { allOf: [{ type: 'number' }, { allOf: [{ minimum: 1 }, { maximum: 10 }] }] },
      path: { type: 'string' } }, required: ['count', 'path'],
  });
  expect(toAnthropicToolSchema(schema)).not.toHaveProperty('allOf');
});

it('promotes oneOf fields and only requires names shared by all branches', () => {
  const schema = { oneOf: [
    { properties: { kind: { const: 'text' }, text: { type: 'string' } }, required: ['kind', 'text'] },
    { properties: { kind: { const: 'file' }, path: { type: 'string' } }, required: ['kind', 'path'] },
  ] };
  const result = toAnthropicToolSchema(schema);
  expect(result).toMatchObject({ type: 'object', properties: {
    kind: { anyOf: [{ const: 'text' }, { const: 'file' }] }, text: {}, path: {},
  }, required: ['kind'] });
  expect(result).not.toHaveProperty('oneOf');
});
