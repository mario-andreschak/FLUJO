import { ToolHandler } from '@/backend/execution/flow/handlers/ToolHandler';

describe('ToolHandler.sanitizeSchema — required field filtering', () => {
  it('preserves required when all keys are in properties', () => {
    const schema = {
      type: 'object',
      properties: { name: { type: 'string' }, age: { type: 'number' } },
      required: ['name', 'age'],
    };
    const result = ToolHandler.sanitizeSchema(schema);
    expect(result.required).toEqual(['name', 'age']);
  });

  it('drops unknown key from required', () => {
    const schema = {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name', 'nonexistent'],
    };
    const result = ToolHandler.sanitizeSchema(schema);
    expect(result.required).toEqual(['name']);
  });

  it('removes required entirely when all keys are undefined', () => {
    const schema = {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['ghost'],
    };
    const result = ToolHandler.sanitizeSchema(schema);
    expect(result.required).toBeUndefined();
  });

  it('removes required when properties is absent', () => {
    const schema = {
      type: 'object',
      required: ['field1'],
    };
    const result = ToolHandler.sanitizeSchema(schema);
    expect(result.required).toBeUndefined();
  });

  it('fixes items.required referencing undefined property (issue #228 exact repro)', () => {
    // Mirrors: issue_fields param of issue_write tool
    const schema = {
      type: 'object',
      properties: {
        issue_fields: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              field_name: { type: 'string' },
              value: { type: 'string' },
            },
            // 'delete' is NOT in properties — Google AI Studio rejects this
            required: ['field_name', 'delete'],
          },
        },
      },
    };
    const result = ToolHandler.sanitizeSchema(schema);
    expect(result.properties!.issue_fields.items!.required).toEqual(['field_name']);
  });

  it('removes items.required when it becomes empty', () => {
    const schema = {
      type: 'array',
      items: {
        type: 'object',
        properties: { x: { type: 'number' } },
        required: ['nonexistent'],
      },
    };
    const result = ToolHandler.sanitizeSchema(schema);
    expect(result.items!.required).toBeUndefined();
  });

  it('fixes required inside nested properties recursively', () => {
    const schema = {
      type: 'object',
      properties: {
        outer: {
          type: 'object',
          properties: { inner: { type: 'string' } },
          required: ['inner', 'ghost'],
        },
      },
    };
    const result = ToolHandler.sanitizeSchema(schema);
    expect(result.properties!.outer.required).toEqual(['inner']);
  });

  it('still strips unsupported format alongside required filtering', () => {
    const schema = {
      type: 'object',
      properties: {
        url: { type: 'string', format: 'uri' },
        name: { type: 'string' },
      },
      required: ['url', 'name', 'missing'],
    };
    const result = ToolHandler.sanitizeSchema(schema);
    expect(result.properties!.url.format).toBeUndefined();
    expect(result.properties!.url.description).toContain('format: uri');
    expect(result.required).toEqual(['url', 'name']);
  });

  it('sanitizes schemas inside oneOf/anyOf/allOf', () => {
    const schema = {
      oneOf: [
        {
          type: 'object',
          properties: { a: { type: 'string' } },
          required: ['a', 'missing'],
        },
      ],
    };
    const result = ToolHandler.sanitizeSchema(schema);
    expect(result.oneOf![0].required).toEqual(['a']);
  });
});
