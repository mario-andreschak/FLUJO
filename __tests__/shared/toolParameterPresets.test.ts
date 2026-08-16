import {
  coercePresetEditorValue,
  hidePresetParameters,
  mergeToolParameterPresets,
  presetEditorValue,
} from '@/utils/shared/toolParameterPresets';

describe('tool parameter presets', () => {
  it('merges server defaults with per-node overrides one parameter at a time', () => {
    expect(mergeToolParameterPresets(
      { search: { tenant: 'global-tenant', limit: 10 } },
      { search: { limit: 25, folder: '@folder' } },
      'search',
    )).toEqual({ tenant: 'global-tenant', limit: 25, folder: '@folder' });
  });

  it('removes fixed parameters and their requirements from only the model-facing clone', () => {
    const schema = {
      type: 'object',
      properties: {
        tenant: { type: 'string' },
        query: { type: 'string' },
      },
      required: ['tenant', 'query'],
      dependentRequired: { query: ['tenant'], tenant: ['query'] },
      dependencies: { tenant: ['query'] },
    };

    expect(hidePresetParameters(schema, { tenant: '${global:TENANT}' })).toEqual({
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
      dependentRequired: { query: [], },
      dependencies: {},
    });
    expect(schema.properties.tenant).toEqual({ type: 'string' });
    expect(schema.required).toEqual(['tenant', 'query']);
  });

  it('preserves references but coerces literal values to their schema types', () => {
    expect(coercePresetEditorValue('42', { type: 'integer' })).toBe(42);
    expect(coercePresetEditorValue('false', { type: 'boolean' })).toBe(false);
    expect(coercePresetEditorValue('{"deep":true}', { type: 'object' })).toEqual({ deep: true });
    expect(coercePresetEditorValue('{"owner":"@model.name"}', { type: 'object' }))
      .toEqual({ owner: '@model.name' });
    expect(coercePresetEditorValue('@conversation.name', { type: 'string' })).toBe('@conversation.name');
    expect(coercePresetEditorValue('${global:LIMIT}', { type: 'integer' })).toBe('${global:LIMIT}');
    expect(presetEditorValue({ deep: true })).toBe('{"deep":true}');
  });
});
