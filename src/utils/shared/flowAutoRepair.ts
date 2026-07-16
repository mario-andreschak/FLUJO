/**
 * Auto-repair for flows — make a flow "runnable-shaped" by deterministically filling in the
 * wiring an author (a human in the builder, or the generation model) commonly forgets:
 *
 *   - no Start node        → add one, connect it to the entry step(s)
 *   - no Finish node       → add one, connect it from the final step(s)
 *   - disconnected steps   → infer the missing control edges between them
 *
 * There are two entry points sharing ONE planner ({@link planRepair}) so the heuristic can't
 * drift between them; they differ only in the geometry signal they feed it:
 *
 *   - {@link repairFlowSpec} (generation): operates on the compact FlowSpec BEFORE compilation.
 *     A FlowSpec has no canvas coordinates, so it uses spec `nodes[]` ORDER as the vertical
 *     signal (author top-to-bottom) → a clean sequential chain. The compiler then lays out and
 *     builds the real edges, so this path needs no edge factory of its own.
 *   - {@link autoRepairFlow} (builder / AI-static): operates on a full Flow with real
 *     user-placed (x,y). Geometry drives the full heuristic — vertical stack = sequential,
 *     same row = branching, sibling subflows under one process = parallel (bidirectional), and
 *     an orchestrator+parallel-subflows block hands the row below to the ORCHESTRATOR, not
 *     through a middle subflow (skip-through). Injected edges go through the SAME
 *     {@link controlEdge} factory the compiler/builder use, so ids/handles stay pinned.
 *
 * Pure data-in/data-out (no services), safe for backend + browser, mirroring flowValidation /
 * flowSpecCompiler. Repair only ADDS — it never deletes or re-points an edge a node already
 * has — so it can never make a working flow worse; every change is reported for review.
 */
import { v4 as uuidv4 } from 'uuid';
import type { Edge } from '@xyflow/react';
import { Flow, FlowNode } from '@/shared/types/flow';
import { controlEdge } from './flowSpecCompiler';
import type { FlowSpec, FlowSpecNode, FlowSpecEdge } from './flowSpecCompiler';
import { getConnectionError } from './connectionRules';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type RepairChangeCode =
  | 'auto-added-start'
  | 'auto-added-finish'
  | 'auto-connected'
  | 'auto-bidirectional-subflow';

export interface RepairChange {
  code: RepairChangeCode;
  /** Human-readable, ready to surface (toast / builder review). */
  message: string;
  /** The node the change is about, when applicable. */
  nodeId?: string;
}

export interface RepairResult {
  /** A repaired COPY — the input flow is never mutated. */
  flow: Flow;
  changes: RepairChange[];
}

// ---------------------------------------------------------------------------
// Planner (pure) — shared by both entry points
// ---------------------------------------------------------------------------

interface PlanNode {
  id: string;
  /** 'start' | 'process' | 'finish' | 'subflow' (mcp nodes are filtered out before planning). */
  type: string;
  x: number;
  y: number;
}
interface PlanEdge {
  from: string;
  to: string;
  bidirectional?: boolean;
}
interface PlannedEdge {
  from: string;
  to: string;
  bidirectional: boolean;
  reason: Extract<RepairChangeCode, 'auto-connected' | 'auto-bidirectional-subflow'>;
}
interface RepairPlan {
  /** Control edges to add between EXISTING nodes. */
  addEdges: PlannedEdge[];
  /** When set, create a Start node and connect it to these node ids. */
  addStart: { targets: string[] } | null;
  /** When set, create a Finish node and connect it from these node ids. */
  addFinish: { sources: string[] } | null;
}

/** Nodes within this many vertical px are treated as the same "row" (branch siblings). */
const ROW_TOLERANCE = 70;

const controlHandles = (type: string) => ({ source: `${type}-bottom`, target: `${type}-top` });

/**
 * The heart of auto-repair: given positioned flow-control nodes + the existing directed
 * control edges, decide which edges to add and whether a Start/Finish must be injected.
 * Purely geometric + degree-based; callers translate the plan into their own vocabulary.
 */
function planRepair(nodes: PlanNode[], existing: PlanEdge[]): RepairPlan {
  // MCP and resource nodes are attachments, never part of control flow.
  const controlNodes = nodes.filter((n) => n.type !== 'mcp' && n.type !== 'resource' && typeof n.id === 'string');
  const byId = new Map(controlNodes.map((n) => [n.id, n]));

  // --- degrees over control edges (bidirectional counts both directions) ---
  const inDeg = new Map<string, number>();
  const outDeg = new Map<string, number>();
  const pair = new Set<string>(); // "from->to" pairs that already exist / are planned
  for (const n of controlNodes) {
    inDeg.set(n.id, 0);
    outDeg.set(n.id, 0);
  }
  const link = (from: string, to: string) => {
    pair.add(`${from}->${to}`);
    outDeg.set(from, (outDeg.get(from) ?? 0) + 1);
    inDeg.set(to, (inDeg.get(to) ?? 0) + 1);
  };
  for (const e of existing) {
    if (!byId.has(e.from) || !byId.has(e.to) || e.from === e.to) continue;
    link(e.from, e.to);
    if (e.bidirectional) link(e.to, e.from);
  }

  // --- rows, top → bottom (within a row, left → right) ---
  const rows: PlanNode[][] = [];
  for (const n of [...controlNodes].sort((a, b) => a.y - b.y || a.x - b.x)) {
    const last = rows[rows.length - 1];
    if (last && Math.abs(n.y - last[0].y) <= ROW_TOLERANCE) last.push(n);
    else rows.push([n]);
  }
  const rowIndexOf = new Map<string, number>();
  rows.forEach((row, ri) => row.forEach((n) => rowIndexOf.set(n.id, ri)));

  // --- pre-detect parallel-subflow groups (orchestrator + parallel sub-agents) ---
  // A row of >=2 subflow nodes (and nothing else) directly below a single process node: those
  // subflows are parallel sub-agents (bidirectional handoff) and LEAVES for downward flow, so
  // the row below them attaches to the process orchestrator, not through a subflow.
  const parallelLeafParent = new Map<string, string>(); // subflow id -> orchestrator process id
  for (let ri = 1; ri < rows.length; ri++) {
    const row = rows[ri];
    const subflows = row.filter((n) => n.type === 'subflow');
    if (subflows.length >= 2 && subflows.length === row.length) {
      const above = rows[ri - 1];
      if (above.length === 1 && above[0].type === 'process') {
        for (const s of subflows) parallelLeafParent.set(s.id, above[0].id);
      }
    }
  }

  const addEdges: PlannedEdge[] = [];
  const isLegal = (from: PlanNode, to: PlanNode) =>
    getConnectionError(from.type, controlHandles(from.type).source, to.type, controlHandles(to.type).target) === null;
  const canAdd = (fromId: string, toId: string) => {
    if (fromId === toId || pair.has(`${fromId}->${toId}`)) return false;
    const from = byId.get(fromId);
    const to = byId.get(toId);
    if (!from || !to || !isLegal(from, to)) return false;
    // A subflow may own only ONE outgoing path (validateFlow 'subflow-multiple-outgoing').
    if (from.type === 'subflow' && (outDeg.get(fromId) ?? 0) >= 1) return false;
    return true;
  };
  const commit = (fromId: string, toId: string, bidi: boolean, reason: PlannedEdge['reason']) => {
    addEdges.push({ from: fromId, to: toId, bidirectional: bidi, reason });
    link(fromId, toId);
    if (bidi) link(toId, fromId);
  };

  // Nearest parent above `n` (skipping finish nodes and parallel-subflow leaves — skip-through).
  const findParent = (n: PlanNode): PlanNode | null => {
    const ri = rowIndexOf.get(n.id) ?? 0;
    for (let r = ri - 1; r >= 0; r--) {
      const candidates = rows[r].filter(
        (c) => c.id !== n.id && c.type !== 'finish' && !parallelLeafParent.has(c.id)
      );
      if (candidates.length === 0) continue;
      if (candidates.length === 1) return candidates[0];
      return candidates.reduce((best, c) => (Math.abs(c.x - n.x) < Math.abs(best.x - n.x) ? c : best));
    }
    return null;
  };

  // --- infer incoming edges for nodes that have none (top → bottom) ---
  for (const row of rows) {
    for (const n of row) {
      if (n.type === 'start') continue; // start never receives
      if ((inDeg.get(n.id) ?? 0) > 0) continue; // already reachable
      // parallel sub-agent: two-way handoff with its orchestrator
      const orchestrator = parallelLeafParent.get(n.id);
      if (orchestrator) {
        if (canAdd(orchestrator, n.id)) commit(orchestrator, n.id, true, 'auto-bidirectional-subflow');
        continue;
      }
      const parent = findParent(n);
      if (parent && canAdd(parent.id, n.id)) commit(parent.id, n.id, false, 'auto-connected');
    }
  }

  // --- Start: inject if missing, else connect an existing Start to any unreached roots ---
  const startNodes = controlNodes.filter((n) => n.type === 'start');
  const roots = () =>
    controlNodes.filter(
      (n) =>
        n.type !== 'start' &&
        n.type !== 'finish' &&
        !parallelLeafParent.has(n.id) &&
        (inDeg.get(n.id) ?? 0) === 0
    );
  let addStart: RepairPlan['addStart'] = null;
  if (startNodes.length === 0) {
    const r = roots();
    if (r.length > 0) {
      addStart = { targets: r.map((n) => n.id) };
    } else {
      // No clear root (e.g. every node already has an incoming edge): attach to the top-most
      // non-finish node so the flow still gets an entry point.
      const top = controlNodes.filter((n) => n.type !== 'finish').sort((a, b) => a.y - b.y)[0];
      if (top) addStart = { targets: [top.id] };
    }
  } else {
    const start = startNodes[0];
    for (const root of roots()) if (canAdd(start.id, root.id)) commit(start.id, root.id, false, 'auto-connected');
  }

  // --- Finish: inject if missing, else connect existing Finish from any dangling terminals ---
  // A terminal is a non-start/non-finish node with no outgoing control edge; parallel-subflow
  // leaves are excluded (their bidirectional back-path means their orchestrator continues).
  const finishNodes = controlNodes.filter((n) => n.type === 'finish');
  const terminals = () =>
    controlNodes.filter(
      (n) =>
        n.type !== 'start' &&
        n.type !== 'finish' &&
        !parallelLeafParent.has(n.id) &&
        (outDeg.get(n.id) ?? 0) === 0
    );
  let addFinish: RepairPlan['addFinish'] = null;
  if (finishNodes.length === 0) {
    const t = terminals();
    if (t.length > 0) addFinish = { sources: t.map((n) => n.id) };
  } else {
    const finish = finishNodes[0];
    for (const t of terminals()) if (canAdd(t.id, finish.id)) commit(t.id, finish.id, false, 'auto-connected');
  }

  return { addEdges, addStart, addFinish };
}

// ---------------------------------------------------------------------------
// Spec-level repair (generation) — ORDER geometry, pure FlowSpec in/out
// ---------------------------------------------------------------------------

/** Big vertical step so each spec node lands on its OWN row (order = the only signal). */
const ORDER_Y_STEP = 1000;

function uniqueKey(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const k = `${base}_${i}`;
    if (!taken.has(k)) return k;
  }
}

/**
 * Make a FlowSpec more forgiving BEFORE compilation: add a missing start/finish and chain
 * disconnected steps in author order. Recurses into inline `subflowSpec` children so every
 * level of a generated bundle is repaired. Returns a repaired COPY + the changes made.
 */
export function repairFlowSpec(spec: FlowSpec): { spec: FlowSpec; changes: RepairChange[] } {
  const changes: RepairChange[] = [];
  const repaired = repairSpecLevel(spec, changes);
  return { spec: repaired, changes };
}

function repairSpecLevel(spec: FlowSpec, changes: RepairChange[]): FlowSpec {
  const nodes: FlowSpecNode[] = Array.isArray(spec?.nodes) ? spec.nodes.map((n) => ({ ...n })) : [];
  const edges: FlowSpecEdge[] = Array.isArray(spec?.edges) ? spec.edges.map((e) => ({ ...e })) : [];

  // Repair inline children first (deepest-first keeps parent planning independent of them).
  for (const n of nodes) {
    if (n?.type === 'subflow' && n.subflowSpec) {
      n.subflowSpec = repairSpecLevel(n.subflowSpec, changes);
    }
  }

  const keyed = nodes.filter((n) => n && typeof n.key === 'string' && !!n.key && n.type !== ('mcp' as string));
  if (keyed.length === 0) return { ...spec, nodes, edges };

  const planNodes: PlanNode[] = keyed.map((n, i) => ({ id: n.key, type: n.type as string, x: 0, y: i * ORDER_Y_STEP }));
  const planEdges: PlanEdge[] = edges
    .filter((e) => e && typeof e.from === 'string' && typeof e.to === 'string')
    .map((e) => ({ from: e.from, to: e.to, bidirectional: e.bidirectional === true }));
  const plan = planRepair(planNodes, planEdges);

  for (const pe of plan.addEdges) {
    edges.push({ from: pe.from, to: pe.to, ...(pe.bidirectional ? { bidirectional: true } : {}) });
    changes.push({ code: pe.reason, message: changeMessage(pe.reason), nodeId: pe.to });
  }

  const takenKeys = new Set(nodes.map((n) => n.key).filter(Boolean) as string[]);
  if (plan.addStart) {
    const key = uniqueKey('start', takenKeys);
    takenKeys.add(key);
    nodes.unshift({ key, type: 'start' });
    for (const t of plan.addStart.targets) edges.push({ from: key, to: t });
    changes.push({
      code: 'auto-added-start',
      message: `Added a Start node connected to ${plan.addStart.targets.length} entry step(s).`,
    });
  }
  if (plan.addFinish) {
    const key = uniqueKey('finish', takenKeys);
    takenKeys.add(key);
    nodes.push({ key, type: 'finish' });
    for (const s of plan.addFinish.sources) edges.push({ from: s, to: key });
    changes.push({
      code: 'auto-added-finish',
      message: `Added a Finish node connected from ${plan.addFinish.sources.length} final step(s).`,
    });
  }

  return { ...spec, nodes, edges };
}

// ---------------------------------------------------------------------------
// Flow-level repair (builder / AI-static) — POSITION geometry, full Flow in/out
// ---------------------------------------------------------------------------

const NEW_NODE_GAP = 150;

function nodeType(n: FlowNode): string {
  return (n.data?.type as string | undefined) ?? (n.type as string | undefined) ?? 'unknown';
}
function isAttachmentEdgeLocal(e: Edge): boolean {
  const t = (e.data as { edgeType?: string } | undefined)?.edgeType;
  return t === 'mcp' || t === 'resource';
}

function makeStartNode(position: { x: number; y: number }): FlowNode {
  return {
    id: uuidv4(),
    type: 'start',
    position,
    data: { label: 'Start Node', type: 'start', properties: { promptTemplate: '' } },
  } as FlowNode;
}
function makeFinishNode(position: { x: number; y: number }): FlowNode {
  return {
    id: uuidv4(),
    type: 'finish',
    position,
    data: { label: 'Finish Node', type: 'finish', properties: {} },
  } as FlowNode;
}

/**
 * Repair a full Flow (real canvas coordinates → full geometric heuristic). Adds a missing
 * start/finish and connects disconnected nodes; returns a repaired COPY + the changes made.
 * The input flow is never mutated.
 */
export function autoRepairFlow(flow: Flow): RepairResult {
  const nodes: FlowNode[] = (flow?.nodes ?? []).map((n) => ({
    ...n,
    position: { ...(n.position ?? { x: 0, y: 0 }) },
    data: { ...n.data },
  }));
  const edges: Edge[] = [...(flow?.edges ?? [])];
  const clone: Flow = { ...flow, nodes, edges };
  const changes: RepairChange[] = [];

  const planNodes: PlanNode[] = nodes
    .filter((n) => nodeType(n) !== 'mcp' && nodeType(n) !== 'resource')
    .map((n) => ({ id: n.id, type: nodeType(n), x: n.position?.x ?? 0, y: n.position?.y ?? 0 }));
  const planEdges: PlanEdge[] = edges
    .filter((e) => !isAttachmentEdgeLocal(e))
    .map((e) => ({ from: e.source, to: e.target, bidirectional: (e.data as { bidirectional?: boolean } | undefined)?.bidirectional === true }));
  const plan = planRepair(planNodes, planEdges);

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const connect = (fromId: string, toId: string, bidi: boolean) => {
    const s = byId.get(fromId);
    const t = byId.get(toId);
    if (s && t) edges.push(controlEdge(s, t, bidi));
  };

  for (const pe of plan.addEdges) {
    connect(pe.from, pe.to, pe.bidirectional);
    changes.push({ code: pe.reason, message: changeMessage(pe.reason), nodeId: pe.to });
  }

  if (plan.addStart) {
    const targets = plan.addStart.targets.map((id) => byId.get(id)).filter(Boolean) as FlowNode[];
    const anchor = targets.reduce<FlowNode | null>((top, n) => (!top || n.position.y < top.position.y ? n : top), null);
    const start = makeStartNode({
      x: anchor?.position.x ?? 250,
      y: (anchor?.position.y ?? NEW_NODE_GAP) - NEW_NODE_GAP,
    });
    nodes.unshift(start);
    byId.set(start.id, start);
    for (const t of plan.addStart.targets) connect(start.id, t, false);
    changes.push({
      code: 'auto-added-start',
      message: `Added a Start node connected to ${plan.addStart.targets.length} entry step(s).`,
      nodeId: start.id,
    });
  }

  if (plan.addFinish) {
    const sources = plan.addFinish.sources.map((id) => byId.get(id)).filter(Boolean) as FlowNode[];
    const anchor = sources.reduce<FlowNode | null>((bot, n) => (!bot || n.position.y > bot.position.y ? n : bot), null);
    const finish = makeFinishNode({
      x: anchor?.position.x ?? 250,
      y: (anchor?.position.y ?? 0) + NEW_NODE_GAP,
    });
    nodes.push(finish);
    byId.set(finish.id, finish);
    for (const s of plan.addFinish.sources) connect(s, finish.id, false);
    changes.push({
      code: 'auto-added-finish',
      message: `Added a Finish node connected from ${plan.addFinish.sources.length} final step(s).`,
      nodeId: finish.id,
    });
  }

  return { flow: clone, changes };
}

function changeMessage(code: RepairChangeCode): string {
  switch (code) {
    case 'auto-connected':
      return 'Connected a disconnected step into the flow.';
    case 'auto-bidirectional-subflow':
      return 'Wired a parallel subflow with a two-way handoff to its orchestrator.';
    case 'auto-added-start':
      return 'Added a Start node.';
    case 'auto-added-finish':
      return 'Added a Finish node.';
  }
}
