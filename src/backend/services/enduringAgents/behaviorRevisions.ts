import { createHash } from 'crypto';

import type { BehaviorRevision } from '@/shared/types/enduringAgent';
import type { Flow, FlowNode } from '@/shared/types/flow';

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
 * Keep this error typed so callers can distinguish the temporary publication
 * limitation from malformed Flow input.
 */
export class BehaviorSubflowDependencyError extends Error {
  readonly code = 'BEHAVIOR_SUBFLOW_DEPENDENCY_UNSUPPORTED' as const;
  readonly nodeIds: readonly string[];

  constructor(nodeIds: readonly string[]) {
    const uniqueNodeIds = Array.from(new Set(nodeIds));
    super(
      `Behavior Flow contains Subflow node${uniqueNodeIds.length === 1 ? '' : 's'} ` +
      `(${uniqueNodeIds.join(', ')}). Immutable Behavior revisions cannot resolve mutable child ` +
      'Flows until dependency snapshots and manifests are supported.',
    );
    this.name = 'BehaviorSubflowDependencyError';
    this.nodeIds = Object.freeze(uniqueNodeIds);
  }
}

function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
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
 * edges, boundServer/enabledTools, prompts, roots and permission rules. Persona
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

  // FlowConverter executes `node.type === "subflow"`; shared Flow discovery
  // also recognises `node.data.type`. Reject both representations fail-closed.
  // A future dependency-manifest publisher can replace this guard once it
  // embeds the complete, immutable child-Flow closure in the revision.
  assertNoMutableSubflowDependencies(flow);

  const snapshot = jsonClone(flow);
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
  return significant;
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
