import { createHash } from 'crypto';

import { FlowSnapshotSchema, type BehaviorRevision } from '@/shared/types/enduringAgent';
import { normalizeBehaviorRulesInput, type Flow, type FlowNode } from '@/shared/types/flow';
import { MAX_SUBFLOW_DEPTH } from '@/backend/execution/flow/constants';
import { validateFlow } from '@/utils/shared/flowValidation';

/**
 * Properties produced by the Flow converter at runtime. They are caches of the
 * attachment edges, not authored authority, and therefore must not become part
 * of a permanent Behavior snapshot.
 */
const DERIVED_PROCESS_PROPERTIES = new Set(['mcpNodes', 'resourceNodes']);

/** ReactFlow/editor fields that have no execution semantics. */
const EDITOR_ONLY_NODE_FIELDS = new Set([
  'selected',
  'dragging',
  'resizing',
  'width',
  'height',
  'measured',
  'positionAbsolute',
  'zIndex',
]);

/** Flow dashboard metadata that does not change execution. */
const EDITOR_ONLY_FLOW_FIELDS = new Set([
  'createdAt',
  'updatedAt',
  'folder',
  'favorite',
]);

/**
 * Publishing a Behavior that resolves a child Flow from the mutable Flow store
 * would make the supposedly immutable revision change underneath its Persona.
 * Keep the legacy error code for callers attempting to snapshot an unpinned
 * graph directly. Publication/admission must first capture its durable closure.
 */
export class BehaviorSubflowDependencyError extends Error {
  readonly code = 'BEHAVIOR_SUBFLOW_DEPENDENCY_UNSUPPORTED' as const;
  readonly nodeIds: readonly string[];

  constructor(nodeIds: readonly string[]) {
    const uniqueNodeIds = Array.from(new Set(nodeIds));
    super(
      `Behavior Flow contains Subflow node${uniqueNodeIds.length === 1 ? '' : 's'} ` +
      `(${uniqueNodeIds.join(', ')}). Immutable Behavior revisions cannot resolve mutable child ` +
      'Flows. Publish or resolve this Flow to pin its executable dependency snapshots and manifest first.',
    );
    this.name = 'BehaviorSubflowDependencyError';
    this.nodeIds = Object.freeze(uniqueNodeIds);
  }
}

function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Materialize the factory's only authorized Role-template transformation:
 * assign one resolved default model to every process node that has no authored
 * binding. Authored bindings are immutable and always win.
 */
export function bindDefaultModelToFlow(flow: Flow, defaultModelId?: string): Flow {
  const copy = jsonClone(flow);
  if (!defaultModelId) return copy;

  copy.nodes = copy.nodes.map((node) => {
    if (node.data.type !== 'process' || node.data.properties?.boundModel) return node;
    return {
      ...node,
      data: {
        ...node.data,
        properties: { ...node.data.properties, boundModel: defaultModelId },
      },
    };
  });
  return copy;
}

function stripDerivedProcessProperties(node: FlowNode): FlowNode {
  if (node.type !== 'process' || !node.data?.properties) return node;
  const properties = { ...node.data.properties };
  for (const property of DERIVED_PROCESS_PROPERTIES) delete properties[property];
  return {
    ...node,
    data: {
      ...node.data,
      properties,
    },
  };
}

function assertNoMutableSubflowDependencies(flow: Flow): void {
  const subflowNodeIds = flow.nodes
    .filter((node) => node?.type === 'subflow' || node?.data?.type === 'subflow')
    .map((node) => (
      typeof node.id === 'string' && node.id.length > 0 ? node.id : '<unknown>'
    ));

  if (subflowNodeIds.length > 0) {
    throw new BehaviorSubflowDependencyError(subflowNodeIds);
  }
}

/**
 * Produce the complete, standalone Flow definition persisted by a Behavior
 * revision. The snapshot deliberately keeps authored MCP nodes, attachment
 * edges, boundServer/enabledTools, prompts, roots and Behavior rules. Persona
 * state is never merged into it.
 */
export function snapshotBehaviorFlow(flow: Flow): Flow {
  if (!flow || typeof flow !== 'object') throw new Error('Behavior Flow is required');
  if (typeof flow.id !== 'string' || flow.id.length === 0) {
    throw new Error('Behavior Flow id is required');
  }
  if (typeof flow.name !== 'string' || flow.name.trim().length === 0) {
    throw new Error('Behavior Flow name is required');
  }
  if (!Array.isArray(flow.nodes) || !Array.isArray(flow.edges)) {
    throw new Error('Behavior Flow must contain node and edge arrays');
  }

  if (flow.executionDependencies) verifyBehaviorDependencies(flow);
  else assertNoMutableSubflowDependencies(flow);

  const snapshot = jsonClone(normalizeBehaviorRulesInput(flow)) as Flow;
  delete snapshot.createdAt;
  delete snapshot.updatedAt;
  snapshot.nodes = snapshot.nodes.map(stripDerivedProcessProperties);
  return snapshot;
}

function executionSignificantFlow(snapshot: Flow): unknown {
  const flow = snapshot as Flow & Record<string, unknown>;
  const significant: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(flow)) {
    if (!EDITOR_ONLY_FLOW_FIELDS.has(key)) significant[key] = value;
  }

  significant.nodes = snapshot.nodes.map((node) => {
    const authored: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node as FlowNode & Record<string, unknown>)) {
      if (key === 'position' || EDITOR_ONLY_NODE_FIELDS.has(key)) continue;
      authored[key] = value;
    }
    return authored;
  });
  if (snapshot.executionDependencies) {
    significant.executionDependencies = {
      ...snapshot.executionDependencies,
      flows: snapshot.executionDependencies.flows.map((entry) => ({
        ...entry,
        flowSnapshot: executionSignificantFlow(entry.flowSnapshot),
      })),
    };
  }
  return significant;
}

export const MAX_BEHAVIOR_DEPENDENCIES = 128;
export const MAX_BEHAVIOR_DEPENDENCY_DEPTH = MAX_SUBFLOW_DEPTH;

export class BehaviorDependencyValidationError extends Error {
  readonly code = 'BEHAVIOR_DEPENDENCY_INVALID';
  constructor(message: string) {
    super(`${message} Repair the Subflow targets in the Flow editor and resolve or publish a new revision.`);
    this.name = 'BehaviorDependencyValidationError';
  }
}

/** Dynamic selection is confined to the authored static target set (at most 32). */
export function behaviorSubflowTargets(node: FlowNode): string[] {
  const properties = node.data?.properties ?? {};
  const single = properties.subflowId;
  const parallel = properties.parallelSubflowIds;
  if (single !== undefined && (typeof single !== 'string' || !single.trim())) {
    throw new BehaviorDependencyValidationError(`Subflow ${node.id} has an invalid target.`);
  }
  if (parallel !== undefined && (!Array.isArray(parallel)
    || parallel.some((id) => typeof id !== 'string' || !id.trim()))) {
    throw new BehaviorDependencyValidationError(`Subflow ${node.id} has invalid fan-out targets.`);
  }
  const staticTargets = (parallel ?? []) as string[];
  const targets = [...new Set([...(typeof single === 'string' ? [single] : []), ...staticTargets])];
  if (properties.parallelSubflowIdsVar || properties.allowCallerFanout === true) {
    if (targets.length === 0 || targets.length > 32) {
      throw new BehaviorDependencyValidationError(
        `Dynamic Subflow ${node.id} requires 1–32 authored subflowId/parallelSubflowIds targets as its immutable allow-list.`,
      );
    }
  }
  if (!targets.length) throw new BehaviorDependencyValidationError(`Subflow ${node.id} has no configured child Flow.`);
  return targets;
}

function subflowNodes(flow: Flow): FlowNode[] {
  return flow.nodes.filter((node) => node.type === 'subflow' || node.data?.type === 'subflow');
}

/** Canonicalize one graph without trusting an author-supplied executable manifest. */
function dependencyGraphSnapshot(flow: Flow): Flow {
  const { executionDependencies: _untrustedManifest, ...graph } = flow;
  // Use the ordinary validator for structural normalization, suppressing only
  // the mutable-dependency guard while building the complete closure below.
  let snapshot: Flow;
  try { snapshot = jsonClone(FlowSnapshotSchema.parse(graph)); }
  catch { throw new BehaviorDependencyValidationError('A dependency Flow is malformed.'); }
  delete snapshot.createdAt;
  delete snapshot.updatedAt;
  snapshot.nodes = snapshot.nodes.map(stripDerivedProcessProperties);
  return snapshot;
}

function dependencyContentHash(flow: Flow): string {
  return createHash('sha256').update(canonicalJson(executionSignificantFlow(flow))).digest('hex');
}

function assertRunnableDependency(flow: Flow): void {
  const validation = validateFlow(flow);
  if (!validation.isRunnable) {
    const detail = validation.issues.filter((issue) => issue.severity === 'error').slice(0, 3).map((issue) => issue.message).join(' ');
    throw new BehaviorDependencyValidationError(`Subflow dependency ${flow.id} is not runnable. ${detail}`);
  }
}

/** Verify every durable child, target, depth and cycle before any execution. */
export function verifyBehaviorDependencies(flow: Flow): void {
  const manifest = flow.executionDependencies;
  if (!manifest || manifest.schemaVersion !== 1 || typeof manifest.workspaceId !== 'string' || !manifest.workspaceId
    || !Array.isArray(manifest.flows) || manifest.flows.length > MAX_BEHAVIOR_DEPENDENCIES) {
    throw new BehaviorDependencyValidationError('The immutable Subflow dependency manifest is missing or unsupported.');
  }
  const entries = new Map<string, Flow>();
  for (const entry of manifest.flows) {
    if (!entry || typeof entry.flowId !== 'string' || !entry.flowId || !entry.flowSnapshot
      || entries.has(entry.flowId) || entry.flowId !== entry.flowSnapshot.id
      || entry.flowSnapshot.executionDependencies) {
      throw new BehaviorDependencyValidationError('The immutable Subflow manifest has duplicate or malformed dependencies.');
    }
    const canonical = dependencyGraphSnapshot(entry.flowSnapshot);
    assertRunnableDependency(canonical);
    if (canonicalJson(canonical) !== canonicalJson(entry.flowSnapshot)
      || dependencyContentHash(canonical) !== entry.contentHash) {
      throw new BehaviorDependencyValidationError(`Subflow dependency ${entry.flowId} is corrupt.`);
    }
    entries.set(entry.flowId, canonical);
  }
  const heights = new Map<string, number>();
  const visit = (graph: Flow, path: string[]): number => {
    if (path.includes(graph.id)) throw new BehaviorDependencyValidationError(`Subflow dependency cycle: ${[...path, graph.id].join(' → ')}.`);
    if (path.length > MAX_BEHAVIOR_DEPENDENCY_DEPTH) throw new BehaviorDependencyValidationError(`Subflow dependency depth exceeds ${MAX_BEHAVIOR_DEPENDENCY_DEPTH}.`);
    const cachedHeight = heights.get(graph.id);
    if (cachedHeight !== undefined) {
      if (path.length + cachedHeight > MAX_BEHAVIOR_DEPENDENCY_DEPTH) throw new BehaviorDependencyValidationError(`Subflow dependency depth exceeds ${MAX_BEHAVIOR_DEPENDENCY_DEPTH}.`);
      return cachedHeight;
    }
    let height = 0;
    for (const node of subflowNodes(graph)) {
      for (const target of behaviorSubflowTargets(node)) {
        const child = entries.get(target);
        if (!child) throw new BehaviorDependencyValidationError(`Subflow ${node.id} dependency ${target} is missing from the immutable manifest.`);
        height = Math.max(height, 1 + visit(child, [...path, graph.id]));
      }
    }
    if (path.length + height > MAX_BEHAVIOR_DEPENDENCY_DEPTH) throw new BehaviorDependencyValidationError(`Subflow dependency depth exceeds ${MAX_BEHAVIOR_DEPENDENCY_DEPTH}.`);
    heights.set(graph.id, height);
    return height;
  };
  visit(flow, []);
  // Unreachable extra graphs cannot be smuggled into an executable capability.
  if (manifest.flows.some((entry) => !heights.has(entry.flowId))) {
    throw new BehaviorDependencyValidationError('The immutable Subflow manifest contains an unreachable dependency.');
  }
}

/** Publication captures authoritative workspace reads, independent of edit history. */
export async function snapshotBehaviorFlowDependencies(flow: Flow): Promise<Flow> {
  const snapshot = dependencyGraphSnapshot(flow);
  if (!subflowNodes(snapshot).length) return snapshotBehaviorFlow(snapshot);
  const [{ flowService }, { getCurrentWorkspace }] = await Promise.all([
    import('@/backend/services/flow'), import('@/utils/workspace'),
  ]);
  const workspaceId = getCurrentWorkspace();
  const entries = new Map<string, { flowId: string; contentHash: string; flowSnapshot: Flow }>();
  const visit = async (graph: Flow, path: string[]): Promise<void> => {
    if (path.includes(graph.id)) throw new BehaviorDependencyValidationError(`Subflow dependency cycle: ${[...path, graph.id].join(' → ')}.`);
    if (path.length > MAX_BEHAVIOR_DEPENDENCY_DEPTH) throw new BehaviorDependencyValidationError(`Subflow dependency depth exceeds ${MAX_BEHAVIOR_DEPENDENCY_DEPTH}.`);
    for (const node of subflowNodes(graph)) {
      for (const target of behaviorSubflowTargets(node)) {
        if ([...path, graph.id].includes(target)) throw new BehaviorDependencyValidationError(`Subflow dependency cycle includes ${target}.`);
        if (entries.has(target)) continue;
        if (entries.size >= MAX_BEHAVIOR_DEPENDENCIES) throw new BehaviorDependencyValidationError('Subflow dependency closure exceeds 128 Flows.');
        const captured = await flowService.readFlowExecutionSnapshot(target);
        if (!captured || captured.flow.id !== target) throw new BehaviorDependencyValidationError(`Subflow dependency ${target} is missing or deleted in this workspace.`);
        if (captured.workspaceId !== workspaceId) throw new BehaviorDependencyValidationError(`Subflow dependency ${target} belongs to another workspace.`);
        const child = dependencyGraphSnapshot(captured.flow);
        assertRunnableDependency(child);
        entries.set(target, { flowId: target, contentHash: dependencyContentHash(child), flowSnapshot: child });
        await visit(child, [...path, graph.id]);
      }
    }
  };
  await visit(snapshot, []);
  snapshot.executionDependencies = { schemaVersion: 1, workspaceId, flows: [...entries.values()].sort((a, b) => a.flowId < b.flowId ? -1 : a.flowId > b.flowId ? 1 : 0) };
  return snapshotBehaviorFlow(snapshot);
}

/** Resolve one authored child only from the already verified durable closure. */
export function resolveBehaviorSubflowSnapshot(parent: Flow, nodeId: string, childId: string, workspaceId: string): Flow {
  verifyBehaviorDependencies(parent);
  const manifest = parent.executionDependencies!;
  if (manifest.workspaceId !== workspaceId) throw new BehaviorDependencyValidationError('The immutable Subflow closure belongs to another workspace.');
  const node = subflowNodes(parent).find((candidate) => candidate.id === nodeId);
  if (!node || !behaviorSubflowTargets(node).includes(childId)) {
    throw new BehaviorDependencyValidationError(`Subflow ${nodeId} cannot select unpinned target ${childId}; select an authored allow-list target.`);
  }
  const child = manifest.flows.find((entry) => entry.flowId === childId)!.flowSnapshot;
  // Each child carries only its own reachable closure; it receives its authored
  // graph and no extra parent tool nodes, private context, Apps, or abilities.
  const reachable = new Set<string>();
  const collect = (graph: Flow): void => {
    for (const childNode of subflowNodes(graph)) for (const target of behaviorSubflowTargets(childNode)) {
      if (reachable.has(target)) continue;
      reachable.add(target);
      collect(manifest.flows.find((entry) => entry.flowId === target)!.flowSnapshot);
    }
  };
  collect(child);
  return jsonClone({ ...child, ...(reachable.size ? { executionDependencies: { ...manifest, flows: manifest.flows.filter((entry) => reachable.has(entry.flowId)) } } : {}) });
}

/** Deterministic JSON: object keys sorted recursively; array order preserved. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    // Match JSON.stringify's treatment inside arrays while keeping this helper's
    // return type total for callers that accidentally pass undefined/function.
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .sort()
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
  return `{${entries.join(',')}}`;
}

/** SHA-256 of execution-significant authored Flow content. */
export function hashBehaviorFlow(flow: Flow): string {
  const snapshot = snapshotBehaviorFlow(flow);
  return createHash('sha256')
    .update(canonicalJson(executionSignificantFlow(snapshot)))
    .digest('hex');
}

/**
 * Historical hash projection retained only to verify pre-#470 immutable
 * records. This deliberately snapshots the raw persisted representation: the
 * physical legacy key is part of the historical content address.
 */
export function hashLegacyBehaviorFlow(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Legacy Behavior Flow is required');
  }
  const flow = value as Flow;
  if (typeof flow.id !== 'string' || flow.id.length === 0) {
    throw new Error('Legacy Behavior Flow id is required');
  }
  if (typeof flow.name !== 'string' || flow.name.trim().length === 0) {
    throw new Error('Legacy Behavior Flow name is required');
  }
  if (!Array.isArray(flow.nodes) || !Array.isArray(flow.edges)) {
    throw new Error('Legacy Behavior Flow must contain node and edge arrays');
  }

  if (flow.executionDependencies) verifyBehaviorDependencies(flow);
  else assertNoMutableSubflowDependencies(flow);
  const snapshot = jsonClone(flow);
  delete snapshot.createdAt;
  delete snapshot.updatedAt;
  snapshot.nodes = snapshot.nodes.map(stripDerivedProcessProperties);
  return createHash('sha256')
    .update(canonicalJson(executionSignificantFlow(snapshot)))
    .digest('hex');
}

/**
 * Match an execution snapshot against either the canonical Behavior hash or
 * the semantically equivalent pre-#470 `permissionRules` representation.
 *
 * The store validates a legacy revision against its exact persisted key before
 * returning a canonical Flow whose policy key is `behaviorRules`. Runtime no
 * longer has the raw record, so attribution must reconstruct that one historic
 * representation instead of treating a validated migration as tampering.
 */
export function behaviorFlowMatchesContentHash(
  flow: Flow,
  expectedContentHash: string,
): boolean {
  if (hashBehaviorFlow(flow) === expectedContentHash) return true;

  const canonical = snapshotBehaviorFlow(flow);
  if (!Object.prototype.hasOwnProperty.call(canonical, 'behaviorRules')) return false;
  const { behaviorRules, ...legacyBase } = canonical;
  const legacy = {
    ...legacyBase,
    permissionRules: behaviorRules,
  } as Flow & { permissionRules: Flow['behaviorRules'] };
  return hashLegacyBehaviorFlow(legacy) === expectedContentHash;
}

/**
 * Verify that a Persona-owned snapshot derives from an immutable Role template.
 * Generated id/name fields may differ, and the factory may add one consistent
 * default model to every otherwise-unbound process node. Every other
 * execution-significant field must still match the authored template exactly.
 */
export function roleTemplateMatchesBehaviorFlow(
  template: Flow,
  candidate: Flow,
): boolean {
  const normalizedCandidate = snapshotBehaviorFlow({
    ...candidate,
    id: template.id,
    name: template.name,
  });
  const injectedModelIds = new Set<string>();

  for (const [index, templateNode] of template.nodes.entries()) {
    if (
      templateNode.data.type !== 'process'
      || templateNode.data.properties?.boundModel
    ) {
      continue;
    }
    const candidateModel = normalizedCandidate.nodes[index]?.data.properties?.boundModel;
    if (typeof candidateModel === 'string' && candidateModel.length > 0) {
      injectedModelIds.add(candidateModel);
    }
  }

  if (injectedModelIds.size > 1) return false;
  const [injectedModelId] = injectedModelIds;
  const expected = bindDefaultModelToFlow(template, injectedModelId);
  if (!template.executionDependencies && candidate.executionDependencies) {
    // The Role authors the graph and child references. Materialization adds
    // their verified workspace closure, without changing any authored field.
    return dependencyContentHash(dependencyGraphSnapshot(normalizedCandidate))
      === dependencyContentHash(dependencyGraphSnapshot(expected));
  }
  return hashBehaviorFlow(normalizedCandidate) === hashBehaviorFlow(expected);
}

/**
 * Project only explicit mutable Flow provenance for the authoring contract.
 * Legacy snapshots without a workspace reference remain deliberately unset.
 */
export function behaviorCompositionFlowRefs(
  revision: BehaviorRevision,
): { sourceFlowRef?: string; overrideFlowRef?: string } {
  if (revision.source.kind === 'role_template') {
    return { sourceFlowRef: revision.source.templateFlowId };
  }
  if (revision.source.kind === 'persona_override') {
    return {
      ...(revision.source.sourceFlowRef
        ? { sourceFlowRef: revision.source.sourceFlowRef }
        : {}),
      ...(revision.source.overrideFlowRef
        ? { overrideFlowRef: revision.source.overrideFlowRef }
        : {}),
    };
  }
  return {};
}

/**
 * Safe, content-addressed collection id for a Persona-owned Behavior revision.
 * Ownership and ordinal are included so two Personas never transparently share
 * one revision record even when their initial Flow snapshots are byte-identical.
 */
export function behaviorRevisionId(input: {
  personaId: string;
  behaviorId: string;
  revision: number;
  contentHash: string;
}): string {
  const digest = createHash('sha256')
    .update(canonicalJson(input))
    .digest('base64url');
  return `br_${digest}`;
}
