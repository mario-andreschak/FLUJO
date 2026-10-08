import type { Edge, Node, Position } from '@xyflow/react';
import type { FlowNode } from '@/frontend/types/flow/flow';
import type {
  AutomationMapEndpoint,
  AutomationMapExecution,
  AutomationMapFlow,
  AutomationMapRelation,
  AutomationMapResponse,
} from '@/shared/types/waves/automationMap';
import { computeAutoLayout } from '@/frontend/components/Flow/FlowManager/FlowBuilder/Canvas/utils/autoLayout';
import { nodeSize } from '@/frontend/components/Flow/FlowManager/FlowBuilder/Canvas/utils/layoutGeometry';

export const SIMPLE_CARD_WIDTH = 344;
export const SIMPLE_CARD_HEIGHT = 224;

const PACKAGE_GAP = 72;
const PACKAGE_PADDING = 36;
const PACKAGE_HEADER = 58;
const SIMPLE_ROW_GAP = 68;
const EXPERT_FLOW_GAP = 84;
const EXPERT_FLOW_PADDING = 58;
const EXPERT_FLOW_HEADER = 48;

export type PlaygroundMode = 'simple' | 'expert';

export interface PlaygroundPackageData extends Record<string, unknown> {
  label: string;
  subtitle: string;
  width: number;
  height: number;
  tone: number;
  dimmed: boolean;
}

export interface PlaygroundFlowFrameData extends Record<string, unknown> {
  flowId: string;
  label: string;
  subtitle?: string;
  width: number;
  height: number;
  dimmed: boolean;
}

export interface PlaygroundSimpleFlowData extends Record<string, unknown> {
  flowId: string;
  name: string;
  description?: string;
  packageNames: string[];
  executions: AutomationMapExecution[];
  stepLabels: string[];
  signalTopics: string[];
  subflowCount: number;
  dimmed: boolean;
  highlighted: boolean;
}

export interface PlaygroundTriggerData extends Record<string, unknown> {
  execution: AutomationMapExecution;
  dimmed: boolean;
}

export interface PlaygroundRelationAnchorData extends Record<string, unknown> {
  sourcePosition: Position;
  targetPosition: Position;
}

export interface PlaygroundGraph {
  nodes: Node[];
  edges: Edge[];
  flowNodeIds: Map<string, string>;
}

export interface PlaygroundGraphCopy {
  workspaceLabel?: string;
  workspaceDescription?: string;
  sharedContentLabel?: string;
  flowCount?: (count: number) => string;
  relationThen?: string;
  relationOnError?: string;
  relationCompletedOrError?: string;
  relationSubflow?: string;
  relationParallelSubflow?: string;
}

interface Group {
  id: string;
  label: string;
  subtitle: string;
  flowEntries: AutomationMapFlow[];
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface ExpertFlowPlacement extends Rect {
  entry: AutomationMapFlow;
  localNodes: FlowNode[];
  syntheticExecutions: AutomationMapExecution[];
  minX: number;
  minY: number;
}

function groupKey(entry: AutomationMapFlow): string {
  if (entry.packageNames.length === 0) return '__workspace__';
  if (entry.packageNames.length === 1) return `package:${entry.packageNames[0]}`;
  return '__shared__';
}

function groupLabel(key: string, entry: AutomationMapFlow, copy: PlaygroundGraphCopy): string {
  if (key === '__workspace__') return copy.workspaceLabel ?? 'My workspace';
  if (key === '__shared__') return copy.sharedContentLabel ?? 'Shared package content';
  return entry.packageNames[0] ?? 'Package';
}

function buildGroups(
  data: AutomationMapResponse,
  visiblePackageNames?: ReadonlySet<string>,
  copy: PlaygroundGraphCopy = {},
): Group[] {
  const buckets = new Map<string, AutomationMapFlow[]>();
  for (const entry of data.flows) {
    if (
      visiblePackageNames &&
      visiblePackageNames.size > 0 &&
      entry.packageNames.length > 0 &&
      !entry.packageNames.some((name) => visiblePackageNames.has(name))
    ) {
      continue;
    }
    const key = groupKey(entry);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(entry);
    else buckets.set(key, [entry]);
  }

  return [...buckets.entries()]
    .map(([id, entries]) => {
      entries.sort((a, b) => a.flow.name.localeCompare(b.flow.name));
      const first = entries[0];
      const subtitle = id === '__shared__'
        ? [...new Set(entries.flatMap((entry) => entry.packageNames))].join(' · ')
        : id === '__workspace__'
          ? copy.workspaceDescription ?? 'Flows created in this workspace'
          : copy.flowCount?.(entries.length) ?? `${entries.length} ${entries.length === 1 ? 'flow' : 'flows'}`;
      return {
        id,
        label: groupLabel(id, first, copy),
        subtitle,
        flowEntries: entries,
      };
    })
    .sort((a, b) => {
      if (a.id === '__workspace__') return -1;
      if (b.id === '__workspace__') return 1;
      if (a.id === '__shared__') return 1;
      if (b.id === '__shared__') return -1;
      return a.label.localeCompare(b.label);
    });
}

function flowIsDimmed(entry: AutomationMapFlow, activeWaveId: string | null): boolean {
  return Boolean(activeWaveId && !entry.waveIds.includes(activeWaveId));
}

function relationIsDimmed(relation: AutomationMapRelation, activeWaveId: string | null): boolean {
  return Boolean(activeWaveId && !relation.waveIds.includes(activeWaveId));
}

function relationColor(relation: AutomationMapRelation): string {
  if (relation.kind === 'signal') return '#8b5cf6';
  if (relation.kind === 'subflow') return '#0891b2';
  return '#16a34a';
}

export function relationLabel(relation: AutomationMapRelation, copy: PlaygroundGraphCopy = {}): string {
  if (relation.kind === 'signal') return relation.topic;
  if (relation.kind === 'subflow') {
    return relation.mode === 'parallel'
      ? copy.relationParallelSubflow ?? 'parallel subflow'
      : copy.relationSubflow ?? 'subflow';
  }
  if (relation.on.length === 1 && relation.on[0] === 'error') return copy.relationOnError ?? 'on error';
  if (relation.on.length === 1 && relation.on[0] === 'completed') return copy.relationThen ?? 'then';
  return copy.relationCompletedOrError ?? 'completed / error';
}

function processLabels(entry: AutomationMapFlow): string[] {
  return entry.flow.nodes
    .filter((node) => node.type === 'process' || node.type === 'static' || node.type === 'mcp' || node.type === 'resource')
    .map((node) => String(node.data?.label || node.data?.description || node.type || 'Step'))
    .filter(Boolean);
}

function signalTopicsForFlow(data: AutomationMapResponse, flowId: string): string[] {
  return [...new Set(
    data.relations.flatMap((relation) => (
      relation.kind === 'signal'
        && relation.source.kind === 'flow-node'
        && relation.source.flowId === flowId
        ? [relation.topic]
        : []
    )),
  )].sort();
}

function outgoingSubflows(data: AutomationMapResponse, flowId: string): number {
  return data.relations.filter((relation) => relation.kind === 'subflow' && relation.parentFlowId === flowId).length;
}

function flowExecutions(data: AutomationMapResponse, entry: AutomationMapFlow): AutomationMapExecution[] {
  const wanted = new Set(entry.executionIds);
  return data.executions
    .filter((execution) => wanted.has(execution.executionId))
    .sort((a, b) => Number(b.isRoot) - Number(a.isRoot) || a.name.localeCompare(b.name));
}

function simpleRelationEndpoints(relation: AutomationMapRelation): [string, string] | null {
  if (relation.kind === 'subflow') return [relation.parentFlowId, relation.childFlowId];
  const sourceFlowId = relation.source.kind === 'execution'
    ? relation.producerFlowId
    : relation.source.flowId;
  const targetFlowId = relation.target.kind === 'execution'
    ? relation.consumerFlowId
    : relation.target.flowId;
  return [sourceFlowId, targetFlowId];
}

export function buildSimplePlaygroundGraph(
  data: AutomationMapResponse,
  activeWaveId: string | null,
  visiblePackageNames?: ReadonlySet<string>,
  copy: PlaygroundGraphCopy = {},
): PlaygroundGraph {
  const groups = buildGroups(data, visiblePackageNames, copy);
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const flowNodeIds = new Map<string, string>();
  let x = 0;

  groups.forEach((group, groupIndex) => {
    const columns = Math.max(1, Math.ceil(Math.sqrt(group.flowEntries.length)));
    const rows = Math.max(1, Math.ceil(group.flowEntries.length / columns));
    const width = PACKAGE_PADDING * 2 + columns * SIMPLE_CARD_WIDTH
      + Math.max(0, columns - 1) * SIMPLE_ROW_GAP;
    const height = PACKAGE_HEADER + PACKAGE_PADDING * 2 + rows * SIMPLE_CARD_HEIGHT
      + Math.max(0, rows - 1) * SIMPLE_ROW_GAP;
    const anyActive = group.flowEntries.some((entry) => !flowIsDimmed(entry, activeWaveId));
    nodes.push({
      id: `package:${group.id}`,
      type: 'playgroundPackage',
      position: { x, y: 0 },
      data: {
        label: group.label,
        subtitle: group.subtitle,
        width,
        height,
        tone: groupIndex,
        dimmed: Boolean(activeWaveId && !anyActive),
      } satisfies PlaygroundPackageData,
      style: { width, height, zIndex: -10 },
      selectable: false,
      draggable: false,
    });

    group.flowEntries.forEach((entry, index) => {
      const column = index % columns;
      const row = Math.floor(index / columns);
      const id = `simple-flow:${entry.flow.id}`;
      flowNodeIds.set(entry.flow.id, id);
      const dimmed = flowIsDimmed(entry, activeWaveId);
      nodes.push({
        id,
        type: 'playgroundSimpleFlow',
        position: {
          x: x + PACKAGE_PADDING + column * (SIMPLE_CARD_WIDTH + SIMPLE_ROW_GAP),
          y: PACKAGE_HEADER + PACKAGE_PADDING + row * (SIMPLE_CARD_HEIGHT + SIMPLE_ROW_GAP),
        },
        data: {
          flowId: entry.flow.id,
          name: entry.flow.name,
          description: entry.flow.description,
          packageNames: entry.packageNames,
          executions: flowExecutions(data, entry),
          stepLabels: processLabels(entry),
          signalTopics: signalTopicsForFlow(data, entry.flow.id),
          subflowCount: outgoingSubflows(data, entry.flow.id),
          dimmed,
          highlighted: Boolean(activeWaveId && !dimmed),
        } satisfies PlaygroundSimpleFlowData,
        style: { width: SIMPLE_CARD_WIDTH, height: SIMPLE_CARD_HEIGHT, zIndex: 5 },
        draggable: false,
      });
    });
    x += width + PACKAGE_GAP;
  });

  const deduped = new Map<string, AutomationMapRelation[]>();
  for (const relation of data.relations) {
    const endpoints = simpleRelationEndpoints(relation);
    if (!endpoints || endpoints[0] === endpoints[1]) continue;
    if (!flowNodeIds.has(endpoints[0]) || !flowNodeIds.has(endpoints[1])) continue;
    const key = `${relation.kind}:${endpoints[0]}:${endpoints[1]}:${relation.kind === 'signal' ? relation.topic : ''}`;
    const bucket = deduped.get(key);
    if (bucket) bucket.push(relation);
    else deduped.set(key, [relation]);
  }

  for (const [relationKey, groupedRelations] of deduped) {
    const relation = groupedRelations[0];
    const endpoints = simpleRelationEndpoints(relation)!;
    const sourceNode = nodes.find((node) => node.id === flowNodeIds.get(endpoints[0]));
    const targetNode = nodes.find((node) => node.id === flowNodeIds.get(endpoints[1]));
    if (!sourceNode || !targetNode) continue;
    const dx = targetNode.position.x - sourceNode.position.x;
    const dy = targetNode.position.y - sourceNode.position.y;
    let sourceHandle = 'relation-out-right';
    let targetHandle = 'relation-in-left';
    if (Math.abs(dy) > Math.abs(dx)) {
      sourceHandle = dy >= 0 ? 'relation-out-bottom' : 'relation-out-top';
      targetHandle = dy >= 0 ? 'relation-in-top' : 'relation-in-bottom';
    } else if (dx < 0) {
      sourceHandle = 'relation-out-left';
      targetHandle = 'relation-in-right';
    }
    const mergedWaveIds = [...new Set(groupedRelations.flatMap((item) => item.waveIds))].sort();
    const dimmed = Boolean(activeWaveId && !mergedWaveIds.includes(activeWaveId));
    const color = relationColor(relation);
    let label = relationLabel(relation, copy);
    if (relation.kind === 'completion') {
      const on = [...new Set(groupedRelations.flatMap((item) => (
        item.kind === 'completion' ? item.on : []
      )))];
      label = on.length === 1 && on[0] === 'error'
        ? copy.relationOnError ?? 'on error'
        : on.length === 1 && on[0] === 'completed'
          ? copy.relationThen ?? 'then'
          : copy.relationCompletedOrError ?? 'completed / error';
    } else if (relation.kind === 'subflow' && groupedRelations.some((item) => (
      item.kind === 'subflow' && item.mode === 'parallel'
    ))) {
      label = copy.relationParallelSubflow ?? 'parallel subflow';
    }
    edges.push({
      id: `simple-relation:${encodeURIComponent(relationKey)}`,
      source: flowNodeIds.get(endpoints[0])!,
      target: flowNodeIds.get(endpoints[1])!,
      sourceHandle,
      targetHandle,
      type: 'smoothstep',
      animated: !dimmed,
      label,
      labelStyle: { fill: color, fontSize: 11, fontWeight: 700 },
      labelBgStyle: { fill: '#ffffff', fillOpacity: 0.88 },
      labelBgPadding: [5, 3],
      style: {
        stroke: color,
        strokeWidth: dimmed ? 1 : activeWaveId ? 3 : 2,
        opacity: dimmed ? 0.12 : 0.82,
      },
      markerEnd: { type: 'arrowclosed' as never, color },
      data: { relationIds: groupedRelations.map((item) => item.id), waveIds: mergedWaveIds },
      selectable: true,
    });
  }

  return { nodes, edges, flowNodeIds };
}

function namespaceNode(flowId: string, nodeId: string): string {
  return `expert-flow:${flowId}:node:${nodeId}`;
}

function syntheticTriggerId(flowId: string, executionId: string): string {
  return `expert-flow:${flowId}:trigger:${executionId}`;
}

function layoutExpertFlow(entry: AutomationMapFlow, executions: AutomationMapExecution[]): ExpertFlowPlacement {
  const renderableEdges = (entry.flow.edges || []).filter(
    (edge) => edge.source && edge.target && edge.sourceHandle && edge.targetHandle,
  );
  const laidOut = computeAutoLayout(
    (entry.flow.nodes || []) as FlowNode[],
    renderableEdges,
    { direction: 'TB', rankSep: 110, nodeSep: 72 },
  );
  const syntheticExecutions = executions.filter((execution) => !execution.triggerNodeId);

  let minX = 0;
  let minY = 0;
  let maxX = 210;
  let maxY = 104;
  if (laidOut.length > 0) {
    minX = Math.min(...laidOut.map((node) => node.position.x));
    minY = Math.min(...laidOut.map((node) => node.position.y));
    maxX = Math.max(...laidOut.map((node) => node.position.x + nodeSize(node).width));
    maxY = Math.max(...laidOut.map((node) => node.position.y + nodeSize(node).height));
  }
  if (syntheticExecutions.length > 0) {
    minY -= 138;
    maxX = Math.max(maxX, minX + syntheticExecutions.length * 226);
  }

  return {
    entry,
    localNodes: laidOut,
    syntheticExecutions,
    minX,
    minY,
    x: 0,
    y: 0,
    width: Math.max(326, maxX - minX + EXPERT_FLOW_PADDING * 2),
    height: Math.max(250, maxY - minY + EXPERT_FLOW_HEADER + EXPERT_FLOW_PADDING * 2),
  };
}

function endpointFlowId(endpoint: AutomationMapEndpoint, executionById: ReadonlyMap<string, AutomationMapExecution>): string | null {
  if (endpoint.kind === 'flow-node' || endpoint.kind === 'flow-boundary') return endpoint.flowId;
  return executionById.get(endpoint.executionId)?.flowId ?? null;
}

function nodeForBoundary(entry: AutomationMapFlow, boundary: 'start' | 'completion'): FlowNode | undefined {
  const preferred = boundary === 'start' ? 'start' : 'finish';
  return entry.flow.nodes.find((node) => node.type === preferred) as FlowNode | undefined;
}

function endpointNodeId(
  endpoint: AutomationMapEndpoint,
  flowById: ReadonlyMap<string, AutomationMapFlow>,
  executionById: ReadonlyMap<string, AutomationMapExecution>,
): string | null {
  if (endpoint.kind === 'flow-node') return namespaceNode(endpoint.flowId, endpoint.nodeId);
  if (endpoint.kind === 'flow-boundary') {
    const entry = flowById.get(endpoint.flowId);
    const node = entry ? nodeForBoundary(entry, endpoint.boundary) : undefined;
    return node ? namespaceNode(endpoint.flowId, node.id) : null;
  }
  const execution = executionById.get(endpoint.executionId);
  if (!execution) return null;
  return execution.triggerNodeId
    ? namespaceNode(execution.flowId, execution.triggerNodeId)
    : syntheticTriggerId(execution.flowId, execution.executionId);
}

function positionOfNode(nodes: readonly Node[], id: string): { x: number; y: number; width: number; height: number } | null {
  const node = nodes.find((candidate) => candidate.id === id);
  if (!node) return null;
  const width = Number(node.style?.width ?? node.width ?? 210);
  const height = Number(node.style?.height ?? node.style?.minHeight ?? node.height ?? 104);
  return { x: node.position.x, y: node.position.y, width, height };
}

function relationAnchorPositions(
  source: { x: number; y: number; width: number; height: number },
  target: { x: number; y: number; width: number; height: number },
): {
  source: { x: number; y: number; sourcePosition: Position; targetPosition: Position };
  target: { x: number; y: number; sourcePosition: Position; targetPosition: Position };
} {
  const sourceCenter = { x: source.x + source.width / 2, y: source.y + source.height / 2 };
  const targetCenter = { x: target.x + target.width / 2, y: target.y + target.height / 2 };
  const dx = targetCenter.x - sourceCenter.x;
  const dy = targetCenter.y - sourceCenter.y;
  if (Math.abs(dx) >= Math.abs(dy)) {
    if (dx >= 0) {
      return {
        source: { x: source.x + source.width, y: sourceCenter.y, sourcePosition: 'right' as Position, targetPosition: 'left' as Position },
        target: { x: target.x, y: targetCenter.y, sourcePosition: 'right' as Position, targetPosition: 'left' as Position },
      };
    }
    return {
      source: { x: source.x, y: sourceCenter.y, sourcePosition: 'left' as Position, targetPosition: 'right' as Position },
      target: { x: target.x + target.width, y: targetCenter.y, sourcePosition: 'left' as Position, targetPosition: 'right' as Position },
    };
  }
  if (dy >= 0) {
    return {
      source: { x: sourceCenter.x, y: source.y + source.height, sourcePosition: 'bottom' as Position, targetPosition: 'top' as Position },
      target: { x: targetCenter.x, y: target.y, sourcePosition: 'bottom' as Position, targetPosition: 'top' as Position },
    };
  }
  return {
    source: { x: sourceCenter.x, y: source.y, sourcePosition: 'top' as Position, targetPosition: 'bottom' as Position },
    target: { x: targetCenter.x, y: target.y + target.height, sourcePosition: 'top' as Position, targetPosition: 'bottom' as Position },
  };
}

export function buildExpertPlaygroundGraph(
  data: AutomationMapResponse,
  activeWaveId: string | null,
  visiblePackageNames?: ReadonlySet<string>,
  copy: PlaygroundGraphCopy = {},
): PlaygroundGraph {
  const groups = buildGroups(data, visiblePackageNames, copy);
  const flowById = new Map(data.flows.map((entry) => [entry.flow.id, entry]));
  const executionById = new Map(data.executions.map((execution) => [execution.executionId, execution]));
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const flowNodeIds = new Map<string, string>();
  const placements = new Map<string, ExpertFlowPlacement>();
  let packageX = 0;

  groups.forEach((group, groupIndex) => {
    const groupPlacements = group.flowEntries.map((entry) => layoutExpertFlow(entry, flowExecutions(data, entry)));
    const columns = Math.max(1, Math.ceil(Math.sqrt(groupPlacements.length)));
    const rows = Math.max(1, Math.ceil(groupPlacements.length / columns));
    const columnWidths = Array.from({ length: columns }, () => 0);
    const rowHeights = Array.from({ length: rows }, () => 0);
    groupPlacements.forEach((placement, index) => {
      const column = index % columns;
      const row = Math.floor(index / columns);
      columnWidths[column] = Math.max(columnWidths[column], placement.width);
      rowHeights[row] = Math.max(rowHeights[row], placement.height);
    });
    const columnOffsets = columnWidths.map((_, index) => (
      columnWidths.slice(0, index).reduce((sum, width) => sum + width, 0) + index * EXPERT_FLOW_GAP
    ));
    const rowOffsets = rowHeights.map((_, index) => (
      rowHeights.slice(0, index).reduce((sum, rowHeight) => sum + rowHeight, 0) + index * EXPERT_FLOW_GAP
    ));
    const contentWidth = columnWidths.reduce((sum, width) => sum + width, 0)
      + Math.max(0, columns - 1) * EXPERT_FLOW_GAP;
    const contentHeight = rowHeights.reduce((sum, rowHeight) => sum + rowHeight, 0)
      + Math.max(0, rows - 1) * EXPERT_FLOW_GAP;
    const packageWidth = Math.max(420, contentWidth + PACKAGE_PADDING * 2);
    const packageHeight = Math.max(340, PACKAGE_HEADER + PACKAGE_PADDING * 2 + contentHeight);
    groupPlacements.forEach((placement, index) => {
      const column = index % columns;
      const row = Math.floor(index / columns);
      placement.x = packageX + PACKAGE_PADDING + columnOffsets[column]
        + (columnWidths[column] - placement.width) / 2;
      placement.y = PACKAGE_HEADER + PACKAGE_PADDING + rowOffsets[row]
        + (rowHeights[row] - placement.height) / 2;
      placements.set(placement.entry.flow.id, placement);
    });
    const anyActive = group.flowEntries.some((entry) => !flowIsDimmed(entry, activeWaveId));
    nodes.push({
      id: `package:${group.id}`,
      type: 'playgroundPackage',
      position: { x: packageX, y: 0 },
      data: {
        label: group.label,
        subtitle: group.subtitle,
        width: packageWidth,
        height: packageHeight,
        tone: groupIndex,
        dimmed: Boolean(activeWaveId && !anyActive),
      } satisfies PlaygroundPackageData,
      style: { width: packageWidth, height: packageHeight, zIndex: -10 },
      draggable: false,
      selectable: false,
    });
    packageX += packageWidth + PACKAGE_GAP;
  });

  for (const placement of placements.values()) {
    const { entry } = placement;
    const dimmed = flowIsDimmed(entry, activeWaveId);
    const frameId = `expert-flow:${entry.flow.id}:frame`;
    flowNodeIds.set(entry.flow.id, frameId);
    nodes.push({
      id: frameId,
      type: 'playgroundFlowFrame',
      position: { x: placement.x, y: placement.y },
      data: {
        flowId: entry.flow.id,
        label: entry.flow.name,
        subtitle: entry.flow.description,
        width: placement.width,
        height: placement.height,
        dimmed,
      } satisfies PlaygroundFlowFrameData,
      style: { width: placement.width, height: placement.height, zIndex: -5 },
      draggable: false,
      selectable: true,
    });

    const innerOrigin = {
      x: placement.x + EXPERT_FLOW_PADDING - placement.minX,
      y: placement.y + EXPERT_FLOW_HEADER + EXPERT_FLOW_PADDING - placement.minY,
    };
    for (const node of placement.localNodes) {
      const size = nodeSize(node);
      nodes.push({
        ...node,
        id: namespaceNode(entry.flow.id, node.id),
        position: { x: innerOrigin.x + node.position.x, y: innerOrigin.y + node.position.y },
        data: { ...node.data, playgroundFlowId: entry.flow.id },
        style: { ...(node.style ?? {}), width: size.width, minHeight: size.height, opacity: dimmed ? 0.22 : 1, zIndex: 5 },
        draggable: false,
        selectable: false,
      });
    }

    const startNode = placement.localNodes.find((node) => node.type === 'start');
    placement.syntheticExecutions.forEach((execution, index) => {
      const id = syntheticTriggerId(entry.flow.id, execution.executionId);
      const x = placement.x + EXPERT_FLOW_PADDING + index * 226;
      const y = placement.y + EXPERT_FLOW_HEADER + 18;
      nodes.push({
        id,
        type: 'playgroundTrigger',
        position: { x, y },
        data: { execution, dimmed } satisfies PlaygroundTriggerData,
        style: { width: 198, height: 82, zIndex: 6 },
        draggable: false,
        selectable: true,
      });
      if (startNode) {
        edges.push({
          id: `trigger-start:${execution.executionId}`,
          source: id,
          target: namespaceNode(entry.flow.id, startNode.id),
          sourceHandle: 'trigger-out',
          targetHandle: 'start-top',
          type: 'smoothstep',
          animated: false,
          style: { stroke: '#64748b', strokeWidth: 1.5, opacity: dimmed ? 0.15 : 0.65 },
        });
      }
    });

    for (const edge of entry.flow.edges || []) {
      if (!edge.source || !edge.target || !edge.sourceHandle || !edge.targetHandle) continue;
      edges.push({
        ...edge,
        id: `expert-flow:${entry.flow.id}:edge:${edge.id}`,
        source: namespaceNode(entry.flow.id, edge.source),
        target: namespaceNode(entry.flow.id, edge.target),
        style: { ...(edge.style ?? {}), opacity: dimmed ? 0.12 : edge.style?.opacity },
        animated: dimmed ? false : edge.animated,
        selectable: false,
      });
    }
  }

  data.relations.forEach((relation, index) => {
    const sourceFlowId = endpointFlowId(relation.source, executionById);
    const targetFlowId = endpointFlowId(relation.target, executionById);
    if (!sourceFlowId || !targetFlowId || !placements.has(sourceFlowId) || !placements.has(targetFlowId)) return;
    if (sourceFlowId === targetFlowId && relation.kind !== 'subflow') return;
    const sourceId = endpointNodeId(relation.source, flowById, executionById);
    const targetId = endpointNodeId(relation.target, flowById, executionById);
    if (!sourceId || !targetId) return;
    const sourceRect = positionOfNode(nodes, sourceId);
    const targetRect = positionOfNode(nodes, targetId);
    if (!sourceRect || !targetRect) return;
    const positions = relationAnchorPositions(sourceRect, targetRect);
    const offset = (index % 5) * 3;
    const sourceAnchorId = `relation-anchor:${relation.id}:source`;
    const targetAnchorId = `relation-anchor:${relation.id}:target`;
    nodes.push({
      id: sourceAnchorId,
      type: 'playgroundRelationAnchor',
      position: { x: positions.source.x + offset, y: positions.source.y + offset },
      data: {
        sourcePosition: positions.source.sourcePosition,
        targetPosition: positions.source.targetPosition,
      } satisfies PlaygroundRelationAnchorData,
      style: { width: 1, height: 1, zIndex: 20 },
      draggable: false,
      selectable: false,
    });
    nodes.push({
      id: targetAnchorId,
      type: 'playgroundRelationAnchor',
      position: { x: positions.target.x + offset, y: positions.target.y + offset },
      data: {
        sourcePosition: positions.target.sourcePosition,
        targetPosition: positions.target.targetPosition,
      } satisfies PlaygroundRelationAnchorData,
      style: { width: 1, height: 1, zIndex: 20 },
      draggable: false,
      selectable: false,
    });
    const dimmed = relationIsDimmed(relation, activeWaveId);
    const color = relationColor(relation);
    edges.push({
      id: `expert-relation:${relation.id}`,
      source: sourceAnchorId,
      target: targetAnchorId,
      sourceHandle: 'out',
      targetHandle: 'in',
      type: 'smoothstep',
      animated: !dimmed,
      label: relationLabel(relation, copy),
      labelStyle: { fill: color, fontSize: 11, fontWeight: 700 },
      labelBgStyle: { fill: '#ffffff', fillOpacity: 0.9 },
      labelBgPadding: [5, 3],
      style: { stroke: color, strokeWidth: activeWaveId && !dimmed ? 3.2 : 2.2, opacity: dimmed ? 0.1 : 0.9 },
      markerEnd: { type: 'arrowclosed' as never, color },
      data: { relationId: relation.id, waveIds: relation.waveIds },
    });
  });

  return { nodes, edges, flowNodeIds };
}
