import { resolveAutomationMap, type AutomationMapExecutionEntry } from '@/backend/services/waves/automationMapResolver';
import type { Flow, FlowNode } from '@/shared/types/flow/flow';
import type { PlannedExecution, TriggerConfig } from '@/shared/types/plannedExecution';
import type { AutomationMapPackage } from '@/shared/types/waves/automationMap';

const NOW = Date.parse('2026-08-14T12:00:00.000Z');

function flowNode(id: string, type: string, properties: Record<string, unknown> = {}): FlowNode {
  return {
    id,
    type,
    position: { x: 0, y: 0 },
    data: { label: type, type, properties },
  } as FlowNode;
}

function flow(id: string, nodes: FlowNode[], folder?: string): Flow {
  return { id, name: `Flow ${id}`, ...(folder ? { folder } : {}), nodes, edges: [] };
}

function execution(
  id: string,
  flowId: string,
  trigger: TriggerConfig,
  overrides: Partial<PlannedExecution> = {},
): AutomationMapExecutionEntry {
  return {
    execution: {
      id,
      name: `Execution ${id}`,
      enabled: true,
      flowId,
      prompt: '',
      trigger,
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
      ...overrides,
    },
    status: {
      armed: true,
      running: false,
      nextRun: trigger.type === 'schedule' ? '2026-08-14T13:00:00.000Z' : null,
    },
    lastRun: null,
  };
}

describe('resolveAutomationMap', () => {
  test('keeps full flows and resolves an exact signal node to an exact Trigger node', () => {
    const producer = flow('producer', [
      flowNode('producer-start', 'start'),
      flowNode('signal-ready', 'signal', { topic: 'ready' }),
    ], 'Package A');
    const consumer = flow('consumer', [
      flowNode('consumer-trigger', 'trigger', { executionId: 'consume' }),
      flowNode('consumer-start', 'start'),
    ], 'Package A');
    const entries = [
      execution('produce', 'producer', {
        type: 'schedule',
        cron: '0 8 * * *',
        timezone: 'America/Bogota',
      }),
      execution('consume', 'consumer', { type: 'flow-event', source: { topic: 'ready' } }),
    ];
    entries[0].lastRun = {
      runId: 'run-1',
      conversationId: 'conversation-secret-not-in-summary',
      firedAt: '2026-08-13T13:00:00.000Z',
      finishedAt: '2026-08-13T13:01:00.000Z',
      status: 'completed',
      triggerSummary: 'Schedule',
      outputText: 'not copied into the map',
    };

    const result = resolveAutomationMap({ executions: entries, flows: [consumer, producer], now: NOW });

    expect(result.generatedAt).toBe('2026-08-14T12:00:00.000Z');
    expect(result.flows.find((entry) => entry.flow.id === 'producer')?.flow.nodes).toHaveLength(2);
    expect(result.executions.find((entry) => entry.executionId === 'produce')).toMatchObject({
      timezone: 'America/Bogota',
      schedule: {
        cron: '0 8 * * *',
        timezone: 'America/Bogota',
        nextRun: '2026-08-14T13:00:00.000Z',
      },
      lastRun: {
        runId: 'run-1',
        firedAt: '2026-08-13T13:00:00.000Z',
        finishedAt: '2026-08-13T13:01:00.000Z',
        status: 'completed',
      },
      isRoot: true,
      waveIds: ['produce'],
    });
    expect(result.executions.find((entry) => entry.executionId === 'consume')?.triggerNodeId)
      .toBe('consumer-trigger');

    const signal = result.relations.find((relation) => relation.kind === 'signal');
    expect(signal).toMatchObject({
      kind: 'signal',
      topic: 'ready',
      producerExecutionId: 'produce',
      consumerExecutionId: 'consume',
      direct: true,
      source: { kind: 'flow-node', flowId: 'producer', nodeId: 'signal-ready' },
      target: { kind: 'flow-node', flowId: 'consumer', nodeId: 'consumer-trigger' },
      subflowPath: [],
      waveIds: ['produce'],
    });
    expect(result.waves).toEqual([
      expect.objectContaining({
        id: 'produce',
        executionIds: ['consume', 'produce'],
        flowIds: ['consumer', 'producer'],
        relationIds: [signal?.id],
      }),
    ]);
    expect(result.components).toHaveLength(1);
  });

  test('resolves exact subflow endpoints and the exact nested signal call path', () => {
    const parent = flow('parent', [
      flowNode('parent-start', 'start'),
      flowNode('call-child', 'subflow', { subflowId: 'child' }),
    ], 'Installed Bundle');
    const child = flow('child', [
      flowNode('child-start', 'start'),
      flowNode('child-signal', 'signal', { topic: 'child-done' }),
    ], 'Installed Bundle');
    const consumer = flow('consumer', [
      flowNode('consumer-trigger', 'trigger', { executionId: 'consume' }),
      flowNode('consumer-start', 'start'),
    ]);
    const packages: AutomationMapPackage[] = [{
      name: 'Installed Bundle',
      version: '1.2.3',
      installedAt: '2026-08-10T00:00:00.000Z',
      flowIds: ['parent', 'child'],
      executionIds: ['produce'],
    }];

    const result = resolveAutomationMap({
      executions: [
        execution('produce', 'parent', { type: 'webhook', token: 'secret' }, { folder: 'Installed Bundle' }),
        execution('consume', 'consumer', { type: 'flow-event', source: { topic: 'child-done' } }),
      ],
      flows: [parent, child, consumer],
      packages,
      now: NOW,
    });

    expect(result.packages).toEqual([{ ...packages[0], flowIds: ['child', 'parent'] }]);
    expect(result.flows.find((entry) => entry.flow.id === 'child')).toMatchObject({
      folder: 'Installed Bundle',
      packageNames: ['Installed Bundle'],
      waveIds: ['produce'],
    });
    expect(result.executions.find((entry) => entry.executionId === 'produce')).toMatchObject({
      folder: 'Installed Bundle',
      packageNames: ['Installed Bundle'],
    });

    expect(result.relations.find((relation) => relation.kind === 'subflow')).toMatchObject({
      source: { kind: 'flow-node', flowId: 'parent', nodeId: 'call-child' },
      target: { kind: 'flow-node', flowId: 'child', nodeId: 'child-start' },
      parentFlowId: 'parent',
      childFlowId: 'child',
      subflowNodeId: 'call-child',
      mode: 'single',
      waveIds: ['produce'],
    });
    expect(result.relations.find((relation) => relation.kind === 'signal')).toMatchObject({
      source: { kind: 'flow-node', flowId: 'child', nodeId: 'child-signal' },
      target: { kind: 'flow-node', flowId: 'consumer', nodeId: 'consumer-trigger' },
      direct: false,
      subflowPath: [{
        flowId: 'parent',
        nodeId: 'call-child',
        targetFlowId: 'child',
        mode: 'single',
      }],
    });
  });

  test('uses a completion boundary, preserves overlap components, and reports orphans', () => {
    const source = flow('source', [flowNode('source-start', 'start'), flowNode('source-finish', 'finish')]);
    const consumer = flow('consumer', [flowNode('consumer-start', 'start')]);
    const orphan = flow('orphan-flow', [flowNode('orphan-start', 'start')]);
    const result = resolveAutomationMap({
      executions: [
        execution('root-a', 'source', { type: 'schedule', cron: '0 * * * *' }),
        execution('root-b', 'source', { type: 'webhook', token: 'token' }),
        execution('consume', 'consumer', {
          type: 'flow-event',
          source: { flowId: 'source' },
          on: ['completed', 'error'],
        }),
        execution('orphan', 'orphan-flow', {
          type: 'flow-event',
          source: { executionId: 'missing' },
          on: ['completed'],
        }),
      ],
      flows: [source, consumer, orphan],
      paused: true,
      now: NOW,
    });

    const completions = result.relations.filter((relation) => relation.kind === 'completion');
    expect(completions).toHaveLength(2);
    expect(completions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        producerExecutionId: 'root-a',
        consumerExecutionId: 'consume',
        source: { kind: 'flow-boundary', flowId: 'source', boundary: 'completion' },
        target: { kind: 'execution', executionId: 'consume' },
        on: ['completed', 'error'],
      }),
      expect.objectContaining({ producerExecutionId: 'root-b', consumerExecutionId: 'consume' }),
    ]));
    expect(result.waves.map((wave) => wave.id)).toEqual(['root-a', 'root-b']);
    expect(result.components).toHaveLength(1);
    expect(result.components[0].rootExecutionIds).toEqual(['root-a', 'root-b']);
    expect(result.orphanExecutionIds).toEqual(['orphan']);
    expect(result.paused).toBe(true);
  });

  test('connects a direct signal Flow with no producer execution and clears only the matched orphan', () => {
    const producer = flow('manual-producer', [
      flowNode('manual-start', 'start'),
      flowNode('manual-ready', 'signal', { topic: 'ready' }),
    ]);
    const consumer = flow('signal-consumer', [
      flowNode('signal-trigger', 'trigger', { executionId: 'signal-listener' }),
      flowNode('signal-start', 'start'),
    ]);
    const unmatched = flow('unmatched-consumer', [
      flowNode('unmatched-trigger', 'trigger', { executionId: 'unmatched-listener' }),
      flowNode('unmatched-start', 'start'),
    ]);

    const result = resolveAutomationMap({
      executions: [
        execution('signal-listener', 'signal-consumer', {
          type: 'flow-event',
          source: { topic: 'ready' },
        }),
        execution('unmatched-listener', 'unmatched-consumer', {
          type: 'flow-event',
          source: { topic: 'never-emitted' },
        }),
      ],
      flows: [unmatched, consumer, producer],
      now: NOW,
    });

    const relation = result.relations.find((candidate) => (
      candidate.kind === 'signal' && candidate.consumerExecutionId === 'signal-listener'
    ));
    expect(relation).toMatchObject({
      kind: 'signal',
      topic: 'ready',
      consumerExecutionId: 'signal-listener',
      producerFlowId: 'manual-producer',
      consumerFlowId: 'signal-consumer',
      direct: true,
      source: { kind: 'flow-node', flowId: 'manual-producer', nodeId: 'manual-ready' },
      target: { kind: 'flow-node', flowId: 'signal-consumer', nodeId: 'signal-trigger' },
      subflowPath: [],
      waveIds: [],
      componentIds: [],
    });
    expect(relation).not.toHaveProperty('producerExecutionId');
    expect(result.orphanExecutionIds).toEqual(['unmatched-listener']);
  });

  test('connects completion from a Flow with no producer execution and does not report the listener as orphaned', () => {
    const producer = flow('manual-source', [
      flowNode('manual-source-start', 'start'),
      flowNode('manual-source-finish', 'finish'),
    ]);
    const consumer = flow('completion-consumer', [
      flowNode('completion-trigger', 'trigger', { executionId: 'completion-listener' }),
      flowNode('completion-start', 'start'),
    ]);

    const result = resolveAutomationMap({
      executions: [
        execution('completion-listener', 'completion-consumer', {
          type: 'flow-event',
          source: { flowId: 'manual-source' },
          on: ['completed', 'error'],
        }),
      ],
      flows: [consumer, producer],
      now: NOW,
    });

    const relation = result.relations.find((candidate) => candidate.kind === 'completion');
    expect(relation).toMatchObject({
      kind: 'completion',
      consumerExecutionId: 'completion-listener',
      producerFlowId: 'manual-source',
      consumerFlowId: 'completion-consumer',
      source: { kind: 'flow-boundary', flowId: 'manual-source', boundary: 'completion' },
      target: { kind: 'flow-node', flowId: 'completion-consumer', nodeId: 'completion-trigger' },
      on: ['completed', 'error'],
      waveIds: [],
      componentIds: [],
    });
    expect(relation).not.toHaveProperty('producerExecutionId');
    expect(result.orphanExecutionIds).toEqual([]);
  });

  test('sanitizes secret-bearing trigger fields before returning executions', () => {
    const flows = ['webhook', 'poll', 'files', 'url'].map((id) => (
      flow(id, [flowNode(`${id}-start`, 'start')])
    ));
    const result = resolveAutomationMap({
      executions: [
        execution('webhook-run', 'webhook', {
          type: 'webhook',
          token: 'webhook-secret-value',
          allowExternal: true,
        }),
        execution('poll-run', 'poll', {
          type: 'mcp-poll',
          serverName: 'mail-server',
          toolName: 'list-private-mail',
          args: { apiKey: 'mcp-argument-secret' },
          cron: '*/5 * * * *',
          timezone: 'UTC',
          evaluate: { mode: 'llm-gate', condition: 'private condition', modelId: 'model-1' },
        }),
        execution('file-run', 'files', {
          type: 'file-watch',
          path: 'C:\\private\\watched-secret',
          events: ['change'],
          glob: '**/*.secret',
        }),
        execution('url-run', 'url', {
          type: 'url-watch',
          url: 'https://private-user:private-pass@example.com/secret',
          cron: '0 * * * *',
          timezone: 'UTC',
        }),
      ],
      flows,
      now: NOW,
    });

    const triggers = new Map(result.executions.map((item) => [item.executionId, item.trigger]));
    expect(triggers.get('webhook-run')).toEqual({ type: 'webhook' });
    expect(triggers.get('poll-run')).toEqual({
      type: 'mcp-poll',
      serverName: 'mail-server',
      toolName: 'list-private-mail',
      cron: '*/5 * * * *',
      timezone: 'UTC',
    });
    expect(triggers.get('file-run')).toEqual({ type: 'file-watch' });
    expect(triggers.get('url-run')).toEqual({
      type: 'url-watch',
      cron: '0 * * * *',
      timezone: 'UTC',
    });

    const serializedExecutions = JSON.stringify(result.executions);
    for (const secret of [
      'webhook-secret-value',
      'mcp-argument-secret',
      'private condition',
      'C:\\private\\watched-secret',
      '**/*.secret',
      'https://private-user:private-pass@example.com/secret',
    ]) {
      expect(serializedExecutions).not.toContain(secret);
    }
  });

  test('is deterministic for shuffled inputs and filters stale package membership', () => {
    const flows = [
      flow('a', [flowNode('a-start', 'start'), flowNode('a-signal', 'signal', { topic: 'go' })]),
      flow('b', [flowNode('b-start', 'start')]),
    ];
    const entries = [
      execution('a-run', 'a', { type: 'schedule', cron: '0 * * * *' }),
      execution('b-run', 'b', { type: 'flow-event', source: { topic: 'go' } }),
    ];
    const packages: AutomationMapPackage[] = [{
      name: 'Pkg',
      flowIds: ['missing', 'a'],
      executionIds: ['missing', 'a-run'],
    }];
    const first = resolveAutomationMap({ executions: entries, flows, packages, now: NOW });
    const second = resolveAutomationMap({
      executions: [entries[1], entries[0]],
      flows: [flows[1], flows[0]],
      packages,
      now: NOW,
    });

    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(first.packages[0]).toMatchObject({ flowIds: ['a'], executionIds: ['a-run'] });
  });
});
