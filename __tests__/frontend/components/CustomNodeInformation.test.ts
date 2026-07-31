import { buildNodeInformation } from '@/frontend/components/Flow/FlowManager/FlowBuilder/CustomNodes/nodeInformation';

describe('buildNodeInformation', () => {
  it('builds a normalized process summary with explicit I/O defaults and a three-line prompt preview', () => {
    const information = buildNodeInformation({
      label: 'Writer',
      type: 'process',
      description: '  Writes   the final answer  ',
      properties: {
        inputMode: 'last-message',
        outputMode: '',
        promptTemplate: ' First   line \n Second line \n Third line \n Fourth line ',
      },
    }, 'process');

    expect(information.label).toBe('Writer');
    expect(information.summary).toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: 'description',
        value: 'Writes the final answer',
      }),
      expect.objectContaining({
        key: 'modes',
        value: 'last-message → empty',
      }),
      expect.objectContaining({
        key: 'prompt',
        value: 'First line\nSecond line\nThird line',
        multiline: true,
      }),
    ]));
    expect(information.summary.find((entry) => entry.key === 'prompt')?.value).not.toContain('Fourth');
  });

  it('shows process mode defaults without adding them to the input data', () => {
    const properties = { promptTemplate: 'Do work' };
    const information = buildNodeInformation({ properties }, 'process');

    expect(information.summary.find((entry) => entry.key === 'modes')?.value)
      .toBe('full-history (default) → full-conversation (default)');
    expect(properties).toEqual({ promptTemplate: 'Do work' });
    expect(information.technicalDetails.find((entry) => entry.key === 'inputMode'))
      .toMatchObject({ state: 'default', value: '[default: full-history]' });
  });

  it('uses subflow target precedence and describes fan-out, map, and spawn settings', () => {
    const single = buildNodeInformation({
      properties: {
        subflowId: 'primary-flow',
        parallelSubflowIds: ['parallel-a', 'parallel-b'],
        parallelSubflowIdsVar: 'var:targets',
      },
    }, 'subflow');
    expect(single.summary.find((entry) => entry.key === 'target')?.value).toBe('primary-flow');

    const fanout = buildNodeInformation({
      properties: {
        parallelSubflowIds: ['parallel-a', 'parallel-b'],
        parallelSubflowIdsVar: 'var:targets',
        sequential: true,
        mapOverList: true,
        spawnBriefs: ['first', 'second'],
      },
    }, 'subflow');
    expect(fanout.summary.find((entry) => entry.key === 'target')?.value).toBe('2 parallel flows');
    expect(fanout.summary.find((entry) => entry.key === 'execution')?.value)
      .toBe('sequential fan-out · map list (json-array (default)) · 2 spawn briefs');
  });

  it('caps MCP tools in the compact summary while retaining a bounded technical count', () => {
    const tools = ['search', 'fetch', 'store', 'delete', 'list'];
    const information = buildNodeInformation({
      properties: { boundServer: 'docs', enabledTools: tools },
    }, 'mcp');

    expect(information.summary).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'server', value: 'docs' }),
      expect.objectContaining({ key: 'tools', value: 'search, fetch, store +2 more (5)' }),
    ]));
    expect(information.technicalDetails.find((entry) => entry.key === 'enabledTools')?.value)
      .toContain('delete');
  });

  it('distinguishes absent and explicitly empty values and tolerates legacy data', () => {
    const information = buildNodeInformation({
      label: '',
      properties: { promptTemplate: '', enabledTools: [] },
    }, 'mcp');

    expect(information.label).toBe('No Label');
    expect(information.technicalDetails.find((entry) => entry.key === 'boundServer'))
      .toMatchObject({ state: 'absent', value: '[absent]' });
    expect(information.technicalDetails.find((entry) => entry.key === 'enabledTools'))
      .toMatchObject({ state: 'empty', value: '[empty array]' });
    expect(() => buildNodeInformation({ properties: null }, 'start')).not.toThrow();
  });

  it('keeps technical fields in schema order and excludes unsupported properties', () => {
    const information = buildNodeInformation({
      type: 'process',
      label: 'Ordered',
      properties: {
        outputMode: 'text',
        unsupportedField: 'must not appear',
        password: 'must not appear',
        promptTemplate: 'Hello',
      },
    }, 'process');

    expect(information.technicalDetails.slice(0, 7).map((entry) => entry.key)).toEqual([
      'metadata.type',
      'metadata.label',
      'metadata.description',
      'promptTemplate',
      'boundModel',
      'modelName',
      'inputMode',
    ]);
    expect(information.technicalText).not.toContain('unsupportedField');
    expect(information.technicalText).not.toContain('must not appear');
    expect(information.technicalText).not.toContain('password');
  });

  it('redacts sensitive nested fields and bounds arrays, objects, depth, and long strings', () => {
    const enabledTools = Array.from({ length: 20 }, (_, index) => `tool-${index}`);
    const information = buildNodeInformation({
      properties: {
        enabledTools,
        roots: [{
          name: 'safe',
          authorization: 'Bearer private',
          nested: { child: { grandchild: { tooDeep: true } } },
          note: 'x'.repeat(700),
        }],
      },
    }, 'mcp');

    expect(information.technicalText).toContain('[redacted]');
    expect(information.technicalText).not.toContain('Bearer private');
    expect(information.technicalText).toContain('[8 more items]');
    expect(information.technicalText).toContain('[depth limit]');
    expect(information.technicalText).not.toContain('x'.repeat(501));
  });

  it('preserves the signal topic-as-label behavior without repeating it in the compact summary', () => {
    const information = buildNodeInformation({
      label: 'Signal',
      description: 'Notify listeners',
      properties: { topic: '  deployed  ' },
    }, 'signal');

    expect(information.label).toBe('deployed');
    expect(information.summary.map((entry) => entry.key)).toEqual(['description']);
    expect(information.technicalText).toContain('Topic: deployed');
  });
});
