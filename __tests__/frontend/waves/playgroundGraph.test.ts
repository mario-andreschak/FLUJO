import type { Edge, Node } from '@xyflow/react';
import {
  buildExpertPlaygroundGraph,
  buildSimplePlaygroundGraph,
  type PlaygroundPackageData,
  type PlaygroundSimpleFlowData,
} from '@/frontend/components/Waves/playgroundGraph';
import type { Flow, FlowNode } from '@/shared/types/flow/flow';
import type {
  AutomationMapCompletionRelation,
  AutomationMapExecution,
  AutomationMapFlow,
  AutomationMapRelation,
  AutomationMapResponse,
  AutomationMapSignalRelation,
  AutomationMapSubflowRelation,
} from '@/shared/types/waves/automationMap';

function flowNode(id: string, type: FlowNode['type'], label = id): FlowNode {
  return {
    id,
    type,
    position: { x: 0, y: 0 },
    data: { label, type: String(type) },
  } as FlowNode;
}

function flowEdge(id: string, source: string, target: string): Edge {
  return {
    id,
    source,
    target,
    sourceHandle: 'source',
    targetHandle: 'target',
  };
}

function entry(
  id: string,
  packageNames: string[] = [],
  waveIds: string[] = [],
  nodes: FlowNode[] = [flowNode('start', 'start'), flowNode('finish', 'finish')],
  edges: Edge[] = [flowEdge('route', 'start', 'finish')],
  executionIds: string[] = [],
): AutomationMapFlow {
  const flow: Flow = {
    id,
    name: `Flow ${id}`,
    nodes,
    edges,
  };
  return {
    flow,
    packageNames,
    executionIds,
    waveIds,
    componentIds: ['component-1'],
  };
}

function execution(
  executionId: string,
  flowId: string,
  waveIds: string[],
  triggerNodeId?: string,
): AutomationMapExecution {
  return {
    executionId,
    name: `Execution ${executionId}`,
    flowId,
    enabled: true,
    packageNames: [],
    trigger: { type: 'schedule', cron: '0 9 * * *' },
    triggerKind: 'schedule',
    status: { armed: true, running: false },
    lastRun: null,
    isRoot: true,
    triggerNodeId,
    waveIds,
    componentId: 'component-1',
  };
}

function automationMap(
  flows: AutomationMapFlow[],
  relations: AutomationMapRelation[] = [],
  executions: AutomationMapExecution[] = [],
): AutomationMapResponse {
  return {
    paused: false,
    generatedAt: '2026-08-14T12:00:00.000Z',
    packages: [],
    flows,
    executions,
    relations,
    waves: [],
    components: [],
    orphanExecutionIds: [],
  };
}

function signalRelation(
  id: string,
  producerFlowId: string,
  consumerFlowId: string,
  topic: string,
  waveIds: string[],
  sourceNodeId = 'signal',
  targetNodeId = 'trigger',
): AutomationMapSignalRelation {
  return {
    id,
    kind: 'signal',
    topic,
    producerExecutionId: `producer-${id}`,
    consumerExecutionId: `consumer-${id}`,
    producerFlowId,
    consumerFlowId,
    direct: true,
    subflowPath: [],
    source: { kind: 'flow-node', flowId: producerFlowId, nodeId: sourceNodeId },
    target: { kind: 'flow-node', flowId: consumerFlowId, nodeId: targetNodeId },
    waveIds,
    componentIds: ['component-1'],
  };
}

function subflowRelation(
  id: string,
  parentFlowId: string,
  childFlowId: string,
  waveIds: string[],
  mode: 'single' | 'parallel' = 'single',
): AutomationMapSubflowRelation {
  return {
    id,
    kind: 'subflow',
    parentFlowId,
    childFlowId,
    subflowNodeId: 'subflow',
    mode,
    source: { kind: 'flow-node', flowId: parentFlowId, nodeId: 'subflow' },
    target: { kind: 'flow-boundary', flowId: childFlowId, boundary: 'start' },
    waveIds,
    componentIds: ['component-1'],
  };
}

function completionRelation(
  id: string,
  producerFlowId: string,
  consumerFlowId: string,
  waveIds: string[],
  on: Array<'completed' | 'error'> = ['completed'],
): AutomationMapCompletionRelation {
  return {
    id,
    kind: 'completion',
    producerExecutionId: `producer-${id}`,
    consumerExecutionId: `consumer-${id}`,
    producerFlowId,
    consumerFlowId,
    on,
    source: { kind: 'flow-boundary', flowId: producerFlowId, boundary: 'completion' },
    target: { kind: 'execution', executionId: `consumer-${id}` },
    waveIds,
    componentIds: ['component-1'],
  };
}

function nodesOfType(graph: { nodes: Node[] }, type: string): Node[] {
  return graph.nodes.filter((node) => node.type === type);
}

describe('simple Automation Playground graph', () => {
  test('renders a shared Flow once even when it belongs to multiple per-root Waves', () => {
    const data = automationMap([
      entry('shared', ['Editorial'], ['wave-a', 'wave-b']),
    ]);

    const simple = buildSimplePlaygroundGraph(data, null);
    const expert = buildExpertPlaygroundGraph(data, null);

    expect(simple.flowNodeIds).toEqual(new Map([['shared', 'simple-flow:shared']]));
    expect(simple.nodes.filter((node) => node.id === 'simple-flow:shared')).toHaveLength(1);
    expect(expert.nodes.filter((node) => node.id === 'expert-flow:shared:frame')).toHaveLength(1);
  });

  test('groups workspace, single-package, and multi-package Flows into stable non-overlapping grids', () => {
    const data = automationMap([
      entry('workspace'),
      entry('alpha-2', ['Alpha']),
      entry('alpha-1', ['Alpha']),
      entry('shared', ['Alpha', 'Beta']),
    ]);

    const graph = buildSimplePlaygroundGraph(data, null);
    const packages = nodesOfType(graph, 'playgroundPackage');
    const packageById = new Map(packages.map((node) => [node.id, node]));

    expect([...packageById.keys()]).toEqual([
      'package:__workspace__',
      'package:package:Alpha',
      'package:__shared__',
    ]);
    expect((packageById.get('package:__workspace__')!.data as PlaygroundPackageData).label)
      .toBe('My workspace');
    expect((packageById.get('package:package:Alpha')!.data as PlaygroundPackageData).subtitle)
      .toBe('2 flows');
    expect((packageById.get('package:__shared__')!.data as PlaygroundPackageData).subtitle)
      .toBe('Alpha · Beta');

    const alphaPackage = packageById.get('package:package:Alpha')!;
    const alphaFlows = ['simple-flow:alpha-1', 'simple-flow:alpha-2'].map((id) => (
      graph.nodes.find((node) => node.id === id)!
    ));
    const rectOf = (node: Node) => ({
      left: node.position.x,
      top: node.position.y,
      right: node.position.x + Number(node.style?.width ?? node.width ?? 0),
      bottom: node.position.y + Number(node.style?.height ?? node.height ?? 0),
    });
    const [firstRect, secondRect] = alphaFlows.map(rectOf);
    const overlaps = firstRect.left < secondRect.right
      && firstRect.right > secondRect.left
      && firstRect.top < secondRect.bottom
      && firstRect.bottom > secondRect.top;
    expect(overlaps).toBe(false);

    const packageRect = rectOf(alphaPackage);
    for (const flowNode of alphaFlows) {
      const rect = rectOf(flowNode);
      expect(rect.left).toBeGreaterThan(packageRect.left);
      expect(rect.top).toBeGreaterThan(packageRect.top);
      expect(rect.right).toBeLessThan(packageRect.right);
      expect(rect.bottom).toBeLessThan(packageRect.bottom);
    }

    const repeated = buildSimplePlaygroundGraph(data, null);
    for (const flowNode of alphaFlows) {
      expect(repeated.nodes.find((node) => node.id === flowNode.id)?.position).toEqual(flowNode.position);
    }
    expect(graph.nodes.find((node) => node.id === 'simple-flow:shared')!.position.x)
      .toBeGreaterThan(alphaPackage.position.x);
  });

  test('dedupes relation summaries and dims everything outside the active Wave', () => {
    const flows = [
      entry('a', ['Alpha'], ['wave-1']),
      entry('b', ['Alpha'], ['wave-1']),
      entry('c', ['Gamma'], ['wave-2']),
    ];
    const relations: AutomationMapRelation[] = [
      signalRelation('signal-first', 'a', 'b', 'ready', ['wave-1']),
      signalRelation('signal-duplicate', 'a', 'b', 'ready', ['wave-1']),
      signalRelation('signal-other-topic', 'a', 'b', 'retry', ['wave-1']),
      subflowRelation('subflow-first', 'a', 'c', ['wave-2']),
      subflowRelation('subflow-duplicate', 'a', 'c', ['wave-2'], 'parallel'),
      completionRelation('completion-first', 'b', 'c', ['wave-2']),
      completionRelation('completion-duplicate', 'b', 'c', ['wave-2'], ['error']),
    ];

    const graph = buildSimplePlaygroundGraph(automationMap(flows, relations), 'wave-1');

    expect(graph.edges.map((edge) => edge.id)).toEqual([
      'simple-relation:signal%3Aa%3Ab%3Aready',
      'simple-relation:signal%3Aa%3Ab%3Aretry',
      'simple-relation:subflow%3Aa%3Ac%3A',
      'simple-relation:completion%3Ab%3Ac%3A',
    ]);
    expect(graph.edges.map((edge) => edge.label)).toEqual([
      'ready',
      'retry',
      'parallel subflow',
      'completed / error',
    ]);
    expect(graph.edges[2].data).toEqual({
      relationIds: ['subflow-first', 'subflow-duplicate'],
      waveIds: ['wave-2'],
    });
    expect(graph.edges[3].data).toEqual({
      relationIds: ['completion-first', 'completion-duplicate'],
      waveIds: ['wave-2'],
    });

    const activeSignal = graph.edges[0];
    expect(activeSignal.animated).toBe(true);
    expect(activeSignal.style).toMatchObject({ opacity: 0.82, strokeWidth: 3 });
    for (const inactive of graph.edges.slice(2)) {
      expect(inactive.animated).toBe(false);
      expect(inactive.style).toMatchObject({ opacity: 0.12, strokeWidth: 1 });
    }

    const activeFlow = graph.nodes.find((node) => node.id === 'simple-flow:a')!;
    const inactiveFlow = graph.nodes.find((node) => node.id === 'simple-flow:c')!;
    expect(activeFlow.data as PlaygroundSimpleFlowData).toMatchObject({
      dimmed: false,
      highlighted: true,
    });
    expect(inactiveFlow.data as PlaygroundSimpleFlowData).toMatchObject({
      dimmed: true,
      highlighted: false,
    });
    expect(
      (graph.nodes.find((node) => node.id === 'package:package:Gamma')!.data as PlaygroundPackageData).dimmed,
    ).toBe(true);
  });
});

describe('expert Automation Playground graph', () => {
  test('namespaces identical FlowBuilder ids and anchors an exact signal-to-trigger relation', () => {
    const producer = entry(
      'producer',
      ['Alpha'],
      ['wave-1'],
      [
        flowNode('start', 'start'),
        flowNode('signal', 'signal'),
        flowNode('finish', 'finish'),
      ],
      [
        flowEdge('to-signal', 'start', 'signal'),
        flowEdge('to-finish', 'signal', 'finish'),
      ],
    );
    const consumer = entry(
      'consumer',
      ['Beta'],
      ['wave-1'],
      [
        flowNode('trigger', 'trigger'),
        flowNode('start', 'start'),
        flowNode('finish', 'finish'),
      ],
      [
        flowEdge('trigger-start', 'trigger', 'start'),
        flowEdge('to-finish', 'start', 'finish'),
      ],
      ['consumer-execution'],
    );
    const relation = signalRelation(
      'ready-link',
      'producer',
      'consumer',
      'ready',
      ['wave-1'],
    );
    const data = automationMap(
      [producer, consumer],
      [relation],
      [execution('consumer-execution', 'consumer', ['wave-1'], 'trigger')],
    );

    const graph = buildExpertPlaygroundGraph(data, 'wave-1');

    expect(graph.nodes.some((node) => node.id === 'start')).toBe(false);
    expect(graph.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'expert-flow:producer:node:start' }),
      expect.objectContaining({ id: 'expert-flow:producer:node:signal' }),
      expect.objectContaining({ id: 'expert-flow:consumer:node:start' }),
      expect.objectContaining({ id: 'expert-flow:consumer:node:trigger' }),
    ]));
    expect(graph.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'expert-flow:producer:edge:to-signal',
        source: 'expert-flow:producer:node:start',
        target: 'expert-flow:producer:node:signal',
      }),
      expect.objectContaining({
        id: 'expert-flow:consumer:edge:trigger-start',
        source: 'expert-flow:consumer:node:trigger',
        target: 'expert-flow:consumer:node:start',
      }),
    ]));

    const sourceNode = graph.nodes.find((node) => node.id === 'expert-flow:producer:node:signal')!;
    const targetNode = graph.nodes.find((node) => node.id === 'expert-flow:consumer:node:trigger')!;
    const sourceAnchor = graph.nodes.find((node) => node.id === 'relation-anchor:ready-link:source')!;
    const targetAnchor = graph.nodes.find((node) => node.id === 'relation-anchor:ready-link:target')!;
    const relationEdge = graph.edges.find((edge) => edge.id === 'expert-relation:ready-link')!;

    expect(relationEdge).toMatchObject({
      source: sourceAnchor.id,
      target: targetAnchor.id,
      sourceHandle: 'out',
      targetHandle: 'in',
      label: 'ready',
    });
    expect(sourceAnchor.type).toBe('playgroundRelationAnchor');
    expect(targetAnchor.type).toBe('playgroundRelationAnchor');

    const isOnPerimeter = (anchor: Node, node: Node): boolean => {
      const width = Number(node.style?.width ?? node.width ?? 210);
      const height = Number(node.style?.height ?? node.height ?? 104);
      const left = node.position.x;
      const right = left + width;
      const top = node.position.y;
      const bottom = top + height;
      const onVerticalSide = (anchor.position.x === left || anchor.position.x === right)
        && anchor.position.y >= top && anchor.position.y <= bottom;
      const onHorizontalSide = (anchor.position.y === top || anchor.position.y === bottom)
        && anchor.position.x >= left && anchor.position.x <= right;
      return onVerticalSide || onHorizontalSide;
    };

    expect(isOnPerimeter(sourceAnchor, sourceNode)).toBe(true);
    expect(isOnPerimeter(targetAnchor, targetNode)).toBe(true);
    expect(isOnPerimeter(
      sourceAnchor,
      graph.nodes.find((node) => node.id === 'expert-flow:producer:node:start')!,
    )).toBe(false);
    expect(isOnPerimeter(
      targetAnchor,
      graph.nodes.find((node) => node.id === 'expert-flow:consumer:node:start')!,
    )).toBe(false);
    expect(nodesOfType(graph, 'playgroundRelationAnchor')).toHaveLength(2);
  });
});
