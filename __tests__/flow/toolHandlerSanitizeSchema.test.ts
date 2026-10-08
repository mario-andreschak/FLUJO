import { ToolHandler } from '@/backend/execution/flow/handlers/ToolHandler';
import { browserToolDefinitions } from '../../mcp-servers/browser/src/tools';

describe('ToolHandler.sanitizeSchema — required field preservation', () => {
  it('preserves required when all keys are in properties', () => {
    const schema = {
      type: 'object',
      properties: { name: { type: 'string' }, age: { type: 'number' } },
      required: ['name', 'age'],
    };
    const result = ToolHandler.sanitizeSchema(schema);
    expect(result.required).toEqual(['name', 'age']);
  });

  it('preserves required names that are not declared locally', () => {
    const schema = {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name', 'nonexistent'],
    };
    const result = ToolHandler.sanitizeSchema(schema);
    expect(result.required).toEqual(['name', 'nonexistent']);
  });

  it('preserves required when no names are declared locally', () => {
    const schema = {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['ghost'],
    };
    const result = ToolHandler.sanitizeSchema(schema);
    expect(result.required).toEqual(['ghost']);
  });

  it('preserves required when properties is absent', () => {
    const schema = {
      type: 'object',
      required: ['field1'],
    };
    const result = ToolHandler.sanitizeSchema(schema);
    expect(result.required).toEqual(['field1']);
  });

  it('removes only invalid required entries', () => {
    const result = ToolHandler.sanitizeSchema({
      required: ['field1', '', 42, null],
    });

    expect(result.required).toEqual(['field1']);
    expect(ToolHandler.sanitizeSchema({ required: ['', 42, null] })).not.toHaveProperty(
      'required'
    );
  });

  it('preserves items.required names declared outside the local schema node', () => {
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
            // 'delete' may be defined by composition or permitted as an additional property.
            required: ['field_name', 'delete'],
          },
        },
      },
    };
    const result = ToolHandler.sanitizeSchema(schema);
    expect(result.properties!.issue_fields.items!.required).toEqual(['field_name', 'delete']);
  });

  it('preserves items.required without a matching local property', () => {
    const schema = {
      type: 'array',
      items: {
        type: 'object',
        properties: { x: { type: 'number' } },
        required: ['nonexistent'],
      },
    };
    const result = ToolHandler.sanitizeSchema(schema);
    expect(result.items!.required).toEqual(['nonexistent']);
  });

  it('preserves required inside nested properties recursively', () => {
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
    expect(result.properties!.outer.required).toEqual(['inner', 'ghost']);
  });

  it('still strips unsupported format while preserving required names', () => {
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
    expect(result.required).toEqual(['url', 'name', 'missing']);
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
    expect(result.oneOf![0].required).toEqual(['a', 'missing']);
  });

  it('preserves browser click and scroll alternatives across both sanitizer passes', () => {
    const definitions = browserToolDefinitions();
    const originalDefinitions = JSON.parse(JSON.stringify(definitions));
    const click = definitions.find((tool) => tool.name === 'browser_click');
    const scroll = definitions.find((tool) => tool.name === 'browser_scroll');

    expect(click).toBeDefined();
    expect(scroll).toBeDefined();

    const clickOnce = ToolHandler.sanitizeSchema(click!.inputSchema);
    const clickTwice = ToolHandler.sanitizeSchema(clickOnce);
    const scrollOnce = ToolHandler.sanitizeSchema(scroll!.inputSchema);
    const scrollTwice = ToolHandler.sanitizeSchema(scrollOnce);

    expect(clickOnce.anyOf).toEqual([
      { required: ['selector'] },
      { required: ['x', 'y'] },
    ]);
    expect(scrollOnce.anyOf).toEqual([
      { required: ['deltaX'] },
      { required: ['deltaY'] },
    ]);
    expect(clickTwice).toEqual(clickOnce);
    expect(scrollTwice).toEqual(scrollOnce);
    expect(definitions).toEqual(originalDefinitions);
  });
});
