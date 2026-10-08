import type { Flow, FlowNode } from '@/shared/types/flow/flow';
import type {
  PlannedExecution,
  PlannedExecutionStatus,
  RunRecord,
  TriggerConfig,
} from '@/shared/types/plannedExecution';
import type {
  AutomationMapComponent,
  AutomationMapEndpoint,
  AutomationMapExecution,
  AutomationMapFlow,
  AutomationMapLastRunSummary,
  AutomationMapPackage,
  AutomationMapRelation,
  AutomationMapResponse,
  AutomationMapSignalRelation,
  AutomationMapSubflowHop,
  AutomationMapSubflowRelation,
  AutomationMapTrigger,
  AutomationMapWaveMembership,
} from '@/shared/types/waves/automationMap';
import type { Wave, WaveChainEdge } from '@/shared/types/waves/waves';
import { intervalMsToCron } from '@/utils/shared/cron';
import { resolveWaves } from './waveResolver';

export interface AutomationMapExecutionEntry {
  execution: PlannedExecution;
  status: PlannedExecutionStatus;
  lastRun?: RunRecord | null;
}

export interface ResolveAutomationMapInput {
  executions: AutomationMapExecutionEntry[];
  flows: Flow[];
  packages?: AutomationMapPackage[];
  paused?: boolean;
  /** Injectable clock for deterministic tests and matching Wave snapshots. */
  now?: number;
  maxSubflowDepth?: number;
  maxChainDepth?: number;
}

interface StaticSubflowTarget {
  parentFlowId: string;
  childFlowId: string;
  nodeId: string;
  mode: 'single' | 'parallel';
}

interface ExactSignalEmitter {
  flowId: string;
  nodeId: string;
  topic: string;
  path: AutomationMapSubflowHop[];
}

const DEFAULT_MAX_SUBFLOW_DEPTH = 10;

function nodeType(node: FlowNode): string | undefined {
  return typeof node.type === 'string'
    ? node.type
    : typeof node.data?.type === 'string'
      ? node.data.type
      : undefined;
}

function stringProperty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function staticSubflowTargets(flow: Flow): StaticSubflowTarget[] {
  const targets: StaticSubflowTarget[] = [];
  for (const node of flow.nodes ?? []) {
    if (nodeType(node) !== 'subflow') continue;
    const properties = node.data?.properties ?? {};
    const single = stringProperty(properties.subflowId);
    if (single) {
      targets.push({ parentFlowId: flow.id, childFlowId: single, nodeId: node.id, mode: 'single' });
    }
    if (Array.isArray(properties.parallelSubflowIds)) {
      for (const value of properties.parallelSubflowIds) {
        const childFlowId = stringProperty(value);
        if (childFlowId) {
          targets.push({ parentFlowId: flow.id, childFlowId, nodeId: node.id, mode: 'parallel' });
        }
      }
    }
  }
  return targets.sort((a, b) => {
    const ak = `${a.parentFlowId}\0${a.nodeId}\0${a.mode}\0${a.childFlowId}`;
    const bk = `${b.parentFlowId}\0${b.nodeId}\0${b.mode}\0${b.childFlowId}`;
    return ak.localeCompare(bk);
  });
}

function startEndpoint(flow: Flow | undefined): AutomationMapEndpoint {
  const start = flow?.nodes?.find((node) => nodeType(node) === 'start');
  return start
    ? { kind: 'flow-node', flowId: flow!.id, nodeId: start.id }
    : { kind: 'flow-boundary', flowId: flow?.id ?? '', boundary: 'start' };
}

function triggerEndpoint(
  executionId: string,
  flowId: string,
  triggerNodeId: string | undefined,
): AutomationMapEndpoint {
  return triggerNodeId
    ? { kind: 'flow-node', flowId, nodeId: triggerNodeId }
    : { kind: 'execution', executionId };
}

function findTriggerNodeId(flow: Flow | undefined, executionId: string): string | undefined {
  const match = flow?.nodes?.find((node) => {
    if (nodeType(node) !== 'trigger') return false;
    return stringProperty(node.data?.properties?.executionId) === executionId;
  });
  return match?.id;
}

function exactSignalEmitters(
  rootFlowId: string,
  flowsById: Map<string, Flow>,
  maxDepth: number,
): ExactSignalEmitter[] {
  const emitters: ExactSignalEmitter[] = [];

  const walk = (
    flowId: string,
    path: AutomationMapSubflowHop[],
    ancestors: Set<string>,
    depth: number,
  ): void => {
    const flow = flowsById.get(flowId);
    if (!flow) return;

    for (const node of flow.nodes ?? []) {
      if (nodeType(node) !== 'signal') continue;
      const topic = stringProperty(node.data?.properties?.topic);
      if (topic) emitters.push({ flowId, nodeId: node.id, topic, path });
    }

    if (depth >= maxDepth) return;
    for (const target of staticSubflowTargets(flow)) {
      if (!flowsById.has(target.childFlowId) || ancestors.has(target.childFlowId)) continue;
      const nextAncestors = new Set(ancestors);
      nextAncestors.add(target.childFlowId);
      walk(
        target.childFlowId,
        [
          ...path,
          {
            flowId,
            nodeId: target.nodeId,
            targetFlowId: target.childFlowId,
            mode: target.mode,
          },
        ],
        nextAncestors,
        depth + 1,
      );
    }
  };

  walk(rootFlowId, [], new Set([rootFlowId]), 0);
  return emitters.sort((a, b) => {
    const pathOf = (entry: ExactSignalEmitter) => entry.path
      .map((hop) => `${hop.flowId}:${hop.nodeId}:${hop.targetFlowId}:${hop.mode}`)
      .join('>');
    return `${a.topic}\0${a.flowId}\0${a.nodeId}\0${pathOf(a)}`
      .localeCompare(`${b.topic}\0${b.flowId}\0${b.nodeId}\0${pathOf(b)}`);
  });
}

function idPart(value: string): string {
  return encodeURIComponent(value);
}

function edgeKey(edge: WaveChainEdge): string {
  return `${edge.fromExecutionId}\0${edge.toExecutionId}\0${edge.via}\0${edge.topic ?? ''}`;
}

function relationMatchesEdge(relation: AutomationMapRelation, edge: WaveChainEdge): boolean {
  if (relation.kind === 'subflow' || relation.kind !== edge.via) return false;
  return relation.producerExecutionId === edge.fromExecutionId
    && relation.consumerExecutionId === edge.toExecutionId
    && (relation.kind !== 'signal' || relation.topic === edge.topic);
}

function membershipsForRelation(
  relation: AutomationMapRelation,
  waves: Wave[],
): string[] {
  if (relation.kind === 'subflow') return [];
  return waves
    .filter((wave) => wave.edges.some((edge) => relationMatchesEdge(relation, edge)))
    .map((wave) => wave.id)
    .sort();
}

function summarizeLastRun(lastRun: RunRecord | null | undefined): AutomationMapLastRunSummary | null {
  if (!lastRun) return null;
  return {
    runId: lastRun.runId,
    firedAt: lastRun.firedAt,
    ...(lastRun.finishedAt ? { finishedAt: lastRun.finishedAt } : {}),
    status: lastRun.status,
    triggerSummary: lastRun.triggerSummary,
  };
}

function timezoneOf(trigger: TriggerConfig): string | undefined {
  return 'timezone' in trigger ? stringProperty(trigger.timezone) : undefined;
}

function publicTriggerOf(trigger: TriggerConfig): AutomationMapTrigger {
  switch (trigger.type) {
    case 'schedule':
      return {
        type: 'schedule',
        cron: trigger.cron,
        ...(trigger.timezone ? { timezone: trigger.timezone } : {}),
      };
    case 'webhook':
      return { type: 'webhook' };
    case 'file-watch':
      return { type: 'file-watch' };
    case 'mcp-poll':
      return {
        type: 'mcp-poll',
        serverName: trigger.serverName,
        toolName: trigger.toolName,
        ...(trigger.cron ? { cron: trigger.cron } : {}),
        ...(trigger.timezone ? { timezone: trigger.timezone } : {}),
      };
    case 'url-watch':
      return {
        type: 'url-watch',
        cron: trigger.cron,
        ...(trigger.timezone ? { timezone: trigger.timezone } : {}),
      };
    case 'flow-event':
      return {
        type: 'flow-event',
        source: {
          ...(trigger.source.flowId ? { flowId: trigger.source.flowId } : {}),
          ...(trigger.source.flowName ? { flowName: trigger.source.flowName } : {}),
          ...(trigger.source.executionId ? { executionId: trigger.source.executionId } : {}),
          ...(trigger.source.topic ? { topic: trigger.source.topic } : {}),
        },
        ...(trigger.on?.length ? { on: [...trigger.on] } : {}),
      };
  }
}

function scheduleOf(trigger: TriggerConfig, nextRun: string | null | undefined) {
  if (trigger.type === 'schedule' || trigger.type === 'url-watch') {
    return {
      cron: trigger.cron,
      ...(trigger.timezone ? { timezone: trigger.timezone } : {}),
      nextRun: nextRun ?? null,
    };
  }
  if (trigger.type === 'mcp-poll') {
    const cron = trigger.cron ?? intervalMsToCron(trigger.intervalMs);
    return {
      ...(cron ? { cron } : {}),
      ...(trigger.timezone ? { timezone: trigger.timezone } : {}),
      nextRun: nextRun ?? null,
    };
  }
  return undefined;
}

function packageNamesByEntity(
  packages: AutomationMapPackage[],
): { flows: Map<string, string[]>; executions: Map<string, string[]> } {
  const flows = new Map<string, string[]>();
  const executions = new Map<string, string[]>();
  const add = (map: Map<string, string[]>, id: string, name: string) => {
    const names = map.get(id) ?? [];
    if (!names.includes(name)) names.push(name);
    names.sort();
    map.set(id, names);
  };
  for (const pkg of packages) {
    for (const id of pkg.flowIds) add(flows, id, pkg.name);
    for (const id of pkg.executionIds) add(executions, id, pkg.name);
  }
  return { flows, executions };
}

function addAll(target: Set<string>, values: Iterable<string>): boolean {
  let changed = false;
  for (const value of values) {
    if (!target.has(value)) {
      target.add(value);
      changed = true;
    }
  }
  return changed;
}

/**
 * Resolve a complete, deterministic Automation Playground graph. This function
 * performs no I/O and does not mutate its inputs.
 */
export function resolveAutomationMap(input: ResolveAutomationMapInput): AutomationMapResponse {
  const now = input.now ?? Date.now();
  const generatedAt = new Date(now).toISOString();
  const maxSubflowDepth = input.maxSubflowDepth ?? DEFAULT_MAX_SUBFLOW_DEPTH;
  const entries = [...input.executions].sort((a, b) => a.execution.id.localeCompare(b.execution.id));
  const definitions = [...input.flows].sort((a, b) => a.id.localeCompare(b.id));
  const flowsById = new Map(definitions.map((flow) => [flow.id, flow]));
  const entriesById = new Map(entries.map((entry) => [entry.execution.id, entry]));

  const waveInput = {
    executions: entries.map((entry) => ({ execution: entry.execution, status: entry.status })),
    flows: definitions,
    paused: input.paused,
    now,
    maxSubflowDepth,
    maxChainDepth: input.maxChainDepth,
  };
  const perRoot = resolveWaves({ ...waveInput, grouping: 'per-root' });
  const connected = resolveWaves({ ...waveInput, grouping: 'connected-component' });

  const waveIdsByExecution = new Map<string, Set<string>>();
  for (const wave of perRoot.waves) {
    for (const node of wave.nodes) {
      const ids = waveIdsByExecution.get(node.executionId) ?? new Set<string>();
      ids.add(wave.id);
      waveIdsByExecution.set(node.executionId, ids);
    }
  }
  const componentIdsByExecution = new Map<string, Set<string>>();
  for (const component of connected.waves) {
    for (const node of component.nodes) {
      const ids = componentIdsByExecution.get(node.executionId) ?? new Set<string>();
      ids.add(component.id);
      componentIdsByExecution.set(node.executionId, ids);
    }
  }

  const packages = [...(input.packages ?? [])]
    .map((pkg) => ({
      ...pkg,
      flowIds: [...new Set(pkg.flowIds)].filter((id) => flowsById.has(id)).sort(),
      executionIds: [...new Set(pkg.executionIds)].filter((id) => entriesById.has(id)).sort(),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const packageNames = packageNamesByEntity(packages);

  const executions: AutomationMapExecution[] = entries.map((entry) => {
    const execution = entry.execution;
    const flow = flowsById.get(execution.flowId);
    const triggerNodeId = findTriggerNodeId(flow, execution.id);
    const schedule = scheduleOf(execution.trigger, entry.status.nextRun);
    const componentIds = [...(componentIdsByExecution.get(execution.id) ?? [])].sort();
    return {
      executionId: execution.id,
      name: execution.name,
      flowId: execution.flowId,
      enabled: execution.enabled,
      ...(execution.folder ? { folder: execution.folder } : {}),
      packageNames: packageNames.executions.get(execution.id) ?? [],
      trigger: publicTriggerOf(execution.trigger),
      triggerKind: execution.trigger.type,
      ...(timezoneOf(execution.trigger) ? { timezone: timezoneOf(execution.trigger) } : {}),
      ...(schedule ? { schedule } : {}),
      status: entry.status,
      lastRun: summarizeLastRun(entry.lastRun),
      isRoot: execution.trigger.type !== 'flow-event',
      ...(triggerNodeId ? { triggerNodeId } : {}),
      waveIds: [...(waveIdsByExecution.get(execution.id) ?? [])].sort(),
      ...(componentIds[0] ? { componentId: componentIds[0] } : {}),
    };
  });
  const executionById = new Map(executions.map((execution) => [execution.executionId, execution]));

  const uniqueChainEdges = new Map<string, WaveChainEdge>();
  for (const component of connected.waves) {
    for (const edge of component.edges) uniqueChainEdges.set(edgeKey(edge), edge);
  }

  const relations: AutomationMapRelation[] = [];
  const emittersByExecution = new Map<string, ExactSignalEmitter[]>();
  for (const execution of executions) {
    emittersByExecution.set(
      execution.executionId,
      exactSignalEmitters(execution.flowId, flowsById, maxSubflowDepth),
    );
  }

  for (const edge of [...uniqueChainEdges.values()].sort((a, b) => edgeKey(a).localeCompare(edgeKey(b)))) {
    const producer = executionById.get(edge.fromExecutionId);
    const consumer = executionById.get(edge.toExecutionId);
    if (!producer || !consumer) continue;
    const target = triggerEndpoint(consumer.executionId, consumer.flowId, consumer.triggerNodeId);

    if (edge.via === 'signal' && edge.topic) {
      const matchingEmitters = (emittersByExecution.get(producer.executionId) ?? [])
        .filter((emitter) => emitter.topic === edge.topic);
      for (const emitter of matchingEmitters) {
        const pathKey = emitter.path
          .map((hop) => `${hop.flowId}:${hop.nodeId}:${hop.targetFlowId}:${hop.mode}`)
          .join('>');
        const relation: AutomationMapSignalRelation = {
          id: `signal:${idPart(producer.executionId)}:${idPart(consumer.executionId)}:${idPart(emitter.flowId)}:${idPart(emitter.nodeId)}:${idPart(pathKey)}`,
          kind: 'signal',
          source: { kind: 'flow-node', flowId: emitter.flowId, nodeId: emitter.nodeId },
          target,
          topic: edge.topic,
          producerExecutionId: producer.executionId,
          consumerExecutionId: consumer.executionId,
          producerFlowId: producer.flowId,
          consumerFlowId: consumer.flowId,
          direct: emitter.path.length === 0,
          subflowPath: emitter.path,
          waveIds: [],
          componentIds: [],
        };
        relation.waveIds = membershipsForRelation(relation, perRoot.waves);
        relation.componentIds = membershipsForRelation(relation, connected.waves);
        relations.push(relation);
      }
      continue;
    }

    if (edge.via === 'completion') {
      const relation: AutomationMapRelation = {
        id: `completion:${idPart(producer.executionId)}:${idPart(consumer.executionId)}`,
        kind: 'completion',
        source: { kind: 'flow-boundary', flowId: producer.flowId, boundary: 'completion' },
        target,
        producerExecutionId: producer.executionId,
        consumerExecutionId: consumer.executionId,
        producerFlowId: producer.flowId,
        consumerFlowId: consumer.flowId,
        on: edge.on?.length ? [...edge.on] : ['completed'],
        waveIds: [],
        componentIds: [],
      };
      relation.waveIds = membershipsForRelation(relation, perRoot.waves);
      relation.componentIds = membershipsForRelation(relation, connected.waves);
      relations.push(relation);
    }
  }

  // Flow-event listeners also react to chat/API/manual runs. Those sources do
  // not necessarily have a producer Planned Execution, so supplement the
  // root-driven Wave edges with structural Flow -> listener relations. This is
  // what lets the Playground show a signal/completion link even when the
  // producer only exists as a Flow definition.
  for (const consumer of executions) {
    if (consumer.trigger.type !== 'flow-event') continue;
    const target = triggerEndpoint(consumer.executionId, consumer.flowId, consumer.triggerNodeId);
    const { source } = consumer.trigger;

    if (source.topic) {
      for (const flow of definitions) {
        for (const emitter of exactSignalEmitters(flow.id, flowsById, 0)) {
          if (emitter.topic !== source.topic) continue;
          const alreadyPresent = relations.some((relation) => (
            relation.kind === 'signal'
            && relation.consumerExecutionId === consumer.executionId
            && relation.topic === source.topic
            && relation.source.kind === 'flow-node'
            && relation.source.flowId === emitter.flowId
            && relation.source.nodeId === emitter.nodeId
          ));
          if (alreadyPresent) continue;
          relations.push({
            id: `signal:flow:${idPart(flow.id)}:${idPart(consumer.executionId)}:${idPart(emitter.nodeId)}`,
            kind: 'signal',
            source: { kind: 'flow-node', flowId: emitter.flowId, nodeId: emitter.nodeId },
            target,
            topic: source.topic,
            consumerExecutionId: consumer.executionId,
            producerFlowId: flow.id,
            consumerFlowId: consumer.flowId,
            direct: true,
            subflowPath: [],
            waveIds: [],
            componentIds: [],
          });
        }
      }
      continue;
    }

    const producerFlows = source.executionId
      ? [executionById.get(source.executionId)?.flowId].filter((id): id is string => Boolean(id))
      : source.flowId
        ? (flowsById.has(source.flowId) ? [source.flowId] : [])
        : source.flowName
          ? definitions.filter((flow) => flow.name === source.flowName).map((flow) => flow.id)
          : [];

    for (const producerFlowId of producerFlows) {
      const alreadyPresent = relations.some((relation) => (
        relation.kind === 'completion'
        && relation.consumerExecutionId === consumer.executionId
        && relation.producerFlowId === producerFlowId
      ));
      if (alreadyPresent) continue;
      relations.push({
        id: `completion:flow:${idPart(producerFlowId)}:${idPart(consumer.executionId)}:${idPart(source.executionId ?? 'any')}`,
        kind: 'completion',
        source: { kind: 'flow-boundary', flowId: producerFlowId, boundary: 'completion' },
        target,
        ...(source.executionId ? { producerExecutionId: source.executionId } : {}),
        consumerExecutionId: consumer.executionId,
        producerFlowId,
        consumerFlowId: consumer.flowId,
        on: consumer.trigger.on?.length ? [...consumer.trigger.on] : ['completed'],
        waveIds: [],
        componentIds: [],
      });
    }
  }

  const subflowRelations: AutomationMapSubflowRelation[] = [];
  for (const flow of definitions) {
    for (const target of staticSubflowTargets(flow)) {
      const child = flowsById.get(target.childFlowId);
      const relation: AutomationMapSubflowRelation = {
        id: `subflow:${idPart(flow.id)}:${idPart(target.nodeId)}:${target.mode}:${idPart(target.childFlowId)}`,
        kind: 'subflow',
        source: { kind: 'flow-node', flowId: flow.id, nodeId: target.nodeId },
        target: startEndpoint(child ?? { id: target.childFlowId, name: target.childFlowId, nodes: [], edges: [] }),
        parentFlowId: flow.id,
        childFlowId: target.childFlowId,
        subflowNodeId: target.nodeId,
        mode: target.mode,
        waveIds: [],
        componentIds: [],
      };
      subflowRelations.push(relation);
    }
  }
  relations.push(...subflowRelations);

  const waveIdsByFlow = new Map<string, Set<string>>();
  const componentIdsByFlow = new Map<string, Set<string>>();
  for (const execution of executions) {
    const waveIds = waveIdsByFlow.get(execution.flowId) ?? new Set<string>();
    addAll(waveIds, execution.waveIds);
    waveIdsByFlow.set(execution.flowId, waveIds);
    const componentIds = componentIdsByFlow.get(execution.flowId) ?? new Set<string>();
    if (execution.componentId) componentIds.add(execution.componentId);
    componentIdsByFlow.set(execution.flowId, componentIds);
  }
  for (const flow of definitions) {
    if (!waveIdsByFlow.has(flow.id)) waveIdsByFlow.set(flow.id, new Set());
    if (!componentIdsByFlow.has(flow.id)) componentIdsByFlow.set(flow.id, new Set());
  }

  // A scheduled parent makes its statically reachable subflows part of the same
  // visible Wave/component even when the child has no Planned Execution itself.
  let changed = true;
  while (changed) {
    changed = false;
    for (const relation of subflowRelations) {
      const parentWaves = waveIdsByFlow.get(relation.parentFlowId) ?? new Set<string>();
      const childWaves = waveIdsByFlow.get(relation.childFlowId) ?? new Set<string>();
      if (addAll(childWaves, parentWaves)) changed = true;
      waveIdsByFlow.set(relation.childFlowId, childWaves);

      const parentComponents = componentIdsByFlow.get(relation.parentFlowId) ?? new Set<string>();
      const childComponents = componentIdsByFlow.get(relation.childFlowId) ?? new Set<string>();
      if (addAll(childComponents, parentComponents)) changed = true;
      componentIdsByFlow.set(relation.childFlowId, childComponents);
    }
  }
  for (const relation of subflowRelations) {
    relation.waveIds = [...(waveIdsByFlow.get(relation.parentFlowId) ?? [])].sort();
    relation.componentIds = [...(componentIdsByFlow.get(relation.parentFlowId) ?? [])].sort();
  }

  relations.sort((a, b) => a.id.localeCompare(b.id));

  const executionsByFlow = new Map<string, string[]>();
  for (const execution of executions) {
    const ids = executionsByFlow.get(execution.flowId) ?? [];
    ids.push(execution.executionId);
    executionsByFlow.set(execution.flowId, ids);
  }
  const flows: AutomationMapFlow[] = definitions.map((flow) => ({
    flow,
    ...(flow.folder ? { folder: flow.folder } : {}),
    packageNames: packageNames.flows.get(flow.id) ?? [],
    executionIds: (executionsByFlow.get(flow.id) ?? []).sort(),
    waveIds: [...(waveIdsByFlow.get(flow.id) ?? [])].sort(),
    componentIds: [...(componentIdsByFlow.get(flow.id) ?? [])].sort(),
  }));

  const membership = (wave: Wave): AutomationMapWaveMembership => ({
    id: wave.id,
    rootExecutionIds: [...wave.rootExecutionIds].sort(),
    executionIds: wave.nodes.map((node) => node.executionId).sort(),
    flowIds: flows.filter((flow) => flow.waveIds.includes(wave.id)).map((flow) => flow.flow.id).sort(),
    relationIds: relations.filter((relation) => relation.waveIds.includes(wave.id)).map((relation) => relation.id),
    hasCycle: wave.hasCycle,
  });
  const waves = perRoot.waves.map(membership);

  const components: AutomationMapComponent[] = connected.waves.map((component) => ({
    id: component.id,
    rootExecutionIds: [...component.rootExecutionIds].sort(),
    executionIds: component.nodes.map((node) => node.executionId).sort(),
    flowIds: flows
      .filter((flow) => flow.componentIds.includes(component.id))
      .map((flow) => flow.flow.id)
      .sort(),
    relationIds: relations
      .filter((relation) => relation.componentIds.includes(component.id))
      .map((relation) => relation.id),
    hasCycle: component.hasCycle,
  }));

  return {
    paused: input.paused ?? false,
    generatedAt,
    packages,
    flows,
    executions,
    relations,
    waves,
    components,
    orphanExecutionIds: perRoot.orphans
      .map((orphan) => orphan.executionId)
      .filter((executionId) => !relations.some((relation) => (
        relation.kind !== 'subflow' && relation.consumerExecutionId === executionId
      )))
      .sort(),
  };
}
