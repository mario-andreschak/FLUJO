import {
  BehaviorSubflowDependencyError,
  behaviorRevisionId,
  bindDefaultModelToFlow,
  hashBehaviorFlow,
  roleTemplateMatchesBehaviorFlow,
  snapshotBehaviorFlow,
} from '@/backend/services/enduringAgents/behaviorRevisions';
import type { Flow } from '@/shared/types/flow';

function behaviorFlow(): Flow {
  return {
    id: 'behavior-research',
    name: 'Research behavior',
    description: 'Research a topic and summarize the result.',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_100_000,
    folder: 'Enduring agents',
    favorite: true,
    permissionRules: [
      { action: 'search', resource: '*', effect: 'allow' },
    ],
    nodes: [
      {
        id: 'start',
        type: 'start',
        position: { x: 0, y: 0 },
        selected: false,
        data: {
          label: 'Start',
          type: 'start',
          properties: { promptTemplate: 'Research the requested topic.' },
        },
      },
      {
        id: 'researcher',
        type: 'process',
        position: { x: 240, y: 0 },
        selected: true,
        data: {
          label: 'Researcher',
          type: 'process',
          properties: {
            promptTemplate: 'Find trustworthy primary sources.',
            boundModel: 'model-researcher',
            mcpNodes: [
              {
                id: 'search-tools',
                properties: {
                  boundServer: 'search-server',
                  enabledTools: ['search'],
                },
              },
            ],
            resourceNodes: [
              {
                id: 'research-notes',
                role: 'consume',
                properties: { scope: 'run', runName: 'notes' },
              },
            ],
          },
        },
      },
      {
        id: 'search-tools',
        type: 'mcp',
        position: { x: 240, y: 180 },
        selected: false,
        data: {
          label: 'Search tools',
          type: 'mcp',
          properties: {
            boundServer: 'search-server',
            enabledTools: ['search'],
            roots: ['workspace'],
          },
        },
      },
      {
        id: 'finish',
        type: 'finish',
        position: { x: 480, y: 0 },
        selected: false,
        data: {
          label: 'Finish',
          type: 'finish',
          properties: { promptTemplate: 'Return a concise cited summary.' },
        },
      },
    ],
    edges: [
      { id: 'start-researcher', source: 'start', target: 'researcher' },
      { id: 'researcher-finish', source: 'researcher', target: 'finish' },
      {
        id: 'search-researcher',
        source: 'search-tools',
        target: 'researcher',
        sourceHandle: 'mcp-out',
        targetHandle: 'process-left-mcp',
      },
    ],
  };
}

function cloneFlow(flow: Flow): Flow {
  return JSON.parse(JSON.stringify(flow)) as Flow;
}

function node(flow: Flow, id: string) {
  return flow.nodes.find((candidate) => candidate.id === id)!;
}

describe('snapshotBehaviorFlow', () => {
  it('strips runtime process attachments, preserves authored MCP config, and does not mutate the caller', () => {
    const flow = behaviorFlow();
    const original = cloneFlow(flow);

    const snapshot = snapshotBehaviorFlow(flow);

    expect(snapshot).not.toBe(flow);
    expect(snapshot).not.toHaveProperty('createdAt');
    expect(snapshot).not.toHaveProperty('updatedAt');
    expect(node(snapshot, 'researcher').data.properties).not.toHaveProperty('mcpNodes');
    expect(node(snapshot, 'researcher').data.properties).not.toHaveProperty('resourceNodes');
    expect(node(snapshot, 'search-tools').data.properties).toEqual({
      boundServer: 'search-server',
      enabledTools: ['search'],
      roots: ['workspace'],
    });
    expect(snapshot.edges).toEqual(flow.edges);
    expect(flow).toEqual(original);
  });

  it.each([
    ['a single static child', { subflowId: 'child-flow' }],
    ['static fan-out children', { parallelSubflowIds: ['child-a', 'child-b'] }],
    ['dynamic fan-out children', { parallelSubflowIdsVar: 'selectedFlows' }],
    ['an empty target awaiting configuration', {}],
  ])('rejects a Subflow node with %s until dependency snapshots exist', (_label, properties) => {
    const flow = behaviorFlow();
    flow.nodes.splice(2, 0, {
      id: 'worker-subflow',
      type: 'subflow',
      position: { x: 240, y: 320 },
      data: {
        label: 'Worker',
        type: 'subflow',
        properties,
      },
    });

    expect(() => snapshotBehaviorFlow(flow)).toThrow(BehaviorSubflowDependencyError);
    expect(() => snapshotBehaviorFlow(flow)).toThrow(
      /Immutable Behavior revisions cannot resolve mutable child Flows/,
    );

    try {
      snapshotBehaviorFlow(flow);
      throw new Error('Expected the Behavior snapshot to reject a Subflow node');
    } catch (error) {
      expect(error).toMatchObject({
        code: 'BEHAVIOR_SUBFLOW_DEPENDENCY_UNSUPPORTED',
        nodeIds: ['worker-subflow'],
      });
    }
  });

  it('fails closed when only the shared data discriminator identifies a Subflow', () => {
    const flow = behaviorFlow();
    flow.nodes.push({
      id: 'legacy-subflow',
      type: 'process',
      position: { x: 720, y: 0 },
      data: {
        label: 'Legacy worker',
        type: 'subflow',
        properties: { subflowId: 'mutable-child' },
      },
    });

    expect(() => snapshotBehaviorFlow(flow)).toThrow(BehaviorSubflowDependencyError);
  });
});

describe('hashBehaviorFlow', () => {
  it('returns the same content hash deterministically', () => {
    const flow = behaviorFlow();

    const first = hashBehaviorFlow(flow);
    const second = hashBehaviorFlow(cloneFlow(flow));

    expect(second).toBe(first);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
  });

  it('ignores timestamps and editor-only organization and node state', () => {
    const flow = behaviorFlow();
    const edited = cloneFlow(flow);
    edited.createdAt = 1;
    edited.updatedAt = 2;
    edited.folder = 'A different dashboard folder';
    edited.favorite = false;
    edited.nodes = edited.nodes.map((current, index) => ({
      ...current,
      position: { x: 10_000 + index, y: -10_000 - index },
      selected: !current.selected,
    }));

    expect(hashBehaviorFlow(edited)).toBe(hashBehaviorFlow(flow));
  });

  it('cannot hash a Behavior that would resolve a mutable child Flow', () => {
    const flow = behaviorFlow();
    flow.nodes.push({
      id: 'child-call',
      type: 'subflow',
      position: { x: 720, y: 0 },
      data: {
        label: 'Call child',
        type: 'subflow',
        properties: { subflowId: 'child-flow' },
      },
    });

    expect(() => hashBehaviorFlow(flow)).toThrow(BehaviorSubflowDependencyError);
  });

  it.each([
    [
      'a prompt',
      (flow: Flow) => {
        node(flow, 'researcher').data.properties!.promptTemplate = 'Use only secondary sources.';
      },
    ],
    [
      'permission rules',
      (flow: Flow) => {
        flow.permissionRules = [
          { action: 'search', resource: '*', effect: 'deny' },
        ];
      },
    ],
    [
      'an MCP server binding',
      (flow: Flow) => {
        node(flow, 'search-tools').data.properties!.boundServer = 'different-server';
      },
    ],
    [
      'the enabled MCP tools',
      (flow: Flow) => {
        node(flow, 'search-tools').data.properties!.enabledTools = ['search', 'fetch'];
      },
    ],
    [
      'the authored edges',
      (flow: Flow) => {
        flow.edges = flow.edges.filter((edge) => edge.id !== 'search-researcher');
      },
    ],
  ])('changes when %s change', (_label, mutate) => {
    const flow = behaviorFlow();
    const changed = cloneFlow(flow);
    mutate(changed);

    expect(hashBehaviorFlow(changed)).not.toBe(hashBehaviorFlow(flow));
  });
});

describe('roleTemplateMatchesBehaviorFlow', () => {
  it('accepts only the deterministic default-model overlay on an unbound template', () => {
    const template = behaviorFlow();
    delete node(template, 'researcher').data.properties!.boundModel;
    const materialized = bindDefaultModelToFlow(template, 'model-default');
    materialized.id = 'persona-owned-flow';
    materialized.name = 'Jim Primary';

    expect(roleTemplateMatchesBehaviorFlow(template, materialized)).toBe(true);
    expect(node(template, 'researcher').data.properties).not.toHaveProperty('boundModel');
  });

  it('rejects changes outside generated identity and missing model bindings', () => {
    const template = behaviorFlow();
    delete node(template, 'researcher').data.properties!.boundModel;
    const materialized = bindDefaultModelToFlow(template, 'model-default');
    materialized.permissionRules = [
      { action: 'delete', resource: '*', effect: 'allow' },
    ];

    expect(roleTemplateMatchesBehaviorFlow(template, materialized)).toBe(false);
  });

  it('preserves authored model bindings as immutable template content', () => {
    const template = behaviorFlow();
    const changed = cloneFlow(template);
    node(changed, 'researcher').data.properties!.boundModel = 'model-other';

    expect(roleTemplateMatchesBehaviorFlow(template, changed)).toBe(false);
  });
});

describe('behaviorRevisionId', () => {
  const input = {
    personaId: 'persona-one',
    behaviorId: 'behavior-research',
    revision: 3,
    contentHash: 'a'.repeat(64),
  };

  it('is deterministic for the same revision identity', () => {
    const first = behaviorRevisionId(input);
    const reordered = behaviorRevisionId({
      contentHash: input.contentHash,
      revision: input.revision,
      behaviorId: input.behaviorId,
      personaId: input.personaId,
    });

    expect(reordered).toBe(first);
    expect(first).toMatch(/^br_[A-Za-z0-9_-]{43}$/);
  });

  it('does not share revision IDs across Personas', () => {
    const firstPersona = behaviorRevisionId(input);
    const secondPersona = behaviorRevisionId({
      ...input,
      personaId: 'persona-two',
    });

    expect(secondPersona).not.toBe(firstPersona);
  });
});
