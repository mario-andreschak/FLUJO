import {
  extractAskFlujoToolActions,
  parseAskFlujoResponse,
  setAskFlujoValueAtPath,
} from '@/frontend/utils/askFlujoActions';

describe('Ask FLUJO UI action protocol', () => {
  it('separates assistant prose from validated tagged actions', () => {
    const parsed = parseAskFlujoResponse(`The watermark requirement is in Generate image.
<flujo-ui-actions>
{"actions":[{"id":"watermark","type":"highlight","target":{"kind":"flow-node","id":"node-7"},"evidence":"The prompt says to add a watermark."}]}
</flujo-ui-actions>`);

    expect(parsed.text).toBe('The watermark requirement is in Generate image.');
    expect(parsed.actions).toEqual([{
      id: 'watermark',
      type: 'highlight',
      target: { kind: 'flow-node', id: 'node-7' },
      evidence: 'The prompt says to add a watermark.',
    }]);
  });

  it('ignores malformed and unsupported actions without hiding the answer', () => {
    const parsed = parseAskFlujoResponse(`Useful answer.
<flujo-ui-actions>{"actions":[{"type":"delete","target":{"kind":"flow-node","id":"x"}}]}</flujo-ui-actions>`);

    expect(parsed.text).toBe('Useful answer.');
    expect(parsed.actions).toEqual([]);
  });

  it('rejects a set_value proposal without a value', () => {
    const parsed = parseAskFlujoResponse(`No value supplied.
<flujo-ui-actions>{"actions":[{"type":"set_value","target":{"kind":"model-field","field":"displayName"}}]}</flujo-ui-actions>`);

    expect(parsed.text).toBe('No value supplied.');
    expect(parsed.actions).toEqual([]);
  });

  it('immutably changes an existing advertised field', () => {
    const original = { data: { properties: { promptTemplate: 'old' } } };
    const updated = setAskFlujoValueAtPath(original, 'data.properties.promptTemplate', 'new');

    expect(updated).toEqual({ data: { properties: { promptTemplate: 'new' } } });
    expect(original.data.properties.promptTemplate).toBe('old');
  });

  it('extracts namespaced FLUJO MCP UI-action tool calls', () => {
    expect(extractAskFlujoToolActions([{
      role: 'assistant',
      tool_calls: [{
        id: 'call-1',
        function: {
          name: 'flujo__propose_ui_action',
          arguments: JSON.stringify({
            type: 'set_value',
            target: { kind: 'model-field', field: 'displayName' },
            value: 'Terra UI Test',
          }),
        },
      }],
    }])).toEqual([{
      id: 'call-1',
      type: 'set_value',
      target: { kind: 'model-field', field: 'displayName' },
      value: 'Terra UI Test',
    }]);
  });

  it('rejects missing and prototype-polluting paths', () => {
    expect(() => setAskFlujoValueAtPath({ data: {} }, 'data.missing.value', true)).toThrow();
    expect(() => setAskFlujoValueAtPath({ data: {} }, '__proto__.polluted', true)).toThrow();
  });
});
