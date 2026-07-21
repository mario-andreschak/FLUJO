/**
 * Content EXTRACTOR for package secret derivation (issue #195).
 *
 * The single place that walks the entities a package will carry (flows + their
 * nodes' `data.properties`, model config strings, planned-execution prompts)
 * and yields flat `{ location, text }` slices for the heuristic and model
 * detectors to scan.
 *
 * SECURITY: this is the choke-point for the issue's "values are never
 * packaged" rule. Model `ApiKey` is NEVER emitted (it is stripped by the
 * serializer regardless, but we also refuse to hand it to a detector — least
 * of all the optional model-driven pass, which leaves the machine). MCP env /
 * header VALUES are never emitted either; only their names participate, and
 * those are already covered by the entity-level secret derivation in
 * `buildPackage.ts`. Pure (no I/O) so it is directly unit-testable.
 */
import type { Flow, FlowNode } from '@/shared/types/flow';
import type { Model } from '@/shared/types/model';
import type { PlannedExecution } from '@/shared/types/plannedExecution';

/** A flat, scannable slice of packaged content. */
export interface ScanTarget {
  /**
   * Dotted, human-readable path back to the value, e.g.
   * `flow:<id>.node:<nodeId>.properties.prompt` or `model:<id>.baseUrl`.
   */
  location: string;
  /** The string value to scan. Trimmed of surrounding whitespace. */
  text: string;
}

/** Skip empty / whitespace-only strings and anything implausibly short. */
function pushTarget(out: ScanTarget[], location: string, value: unknown): void {
  if (typeof value !== 'string') return;
  const text = value.trim();
  if (text.length === 0) return;
  out.push({ location, text });
}

/**
 * Deep-walk an arbitrary JSON-ish value emitting every string leaf with a
 * dotted location suffix. Used for a flow node's free-form `data.properties`
 * (prompt templates, bindings, nested config). Guards against cycles and caps
 * recursion depth defensively.
 */
function walkStrings(
  out: ScanTarget[],
  baseLocation: string,
  value: unknown,
  seen: WeakSet<object>,
  depth = 0,
): void {
  if (depth > 12 || value == null) return;
  if (typeof value === 'string') {
    pushTarget(out, baseLocation, value);
    return;
  }
  if (typeof value !== 'object') return;
  if (seen.has(value as object)) return;
  seen.add(value as object);
  if (Array.isArray(value)) {
    value.forEach((item, i) => walkStrings(out, `${baseLocation}[${i}]`, item, seen, depth + 1));
    return;
  }
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    walkStrings(out, `${baseLocation}.${key}`, v, seen, depth + 1);
  }
}

/** Extract scannable slices from a single flow node's label/description/properties. */
function extractNode(out: ScanTarget[], flowId: string, node: FlowNode): void {
  const nodeId = node.id;
  const base = `flow:${flowId}.node:${nodeId}`;
  // Node `label` is pure UI metadata (often a single glyph) and is never
  // scanned. Free-form content lives in `description` + `properties`.
  pushTarget(out, `${base}.description`, node.data?.description);
  if (node.data?.properties && typeof node.data.properties === 'object') {
    walkStrings(out, `${base}.properties`, node.data.properties, new WeakSet<object>());
  }
}

/** Extract scannable slices from a flow (name/description + every node). */
export function extractFlowTargets(flow: Flow): ScanTarget[] {
  const out: ScanTarget[] = [];
  pushTarget(out, `flow:${flow.id}.description`, flow.description);
  for (const node of flow.nodes ?? []) extractNode(out, flow.id, node);
  return out;
}

/**
 * Extract scannable slices from a model config. `ApiKey` is NEVER read here —
 * only display + connection + prompt strings, per the issue.
 */
export function extractModelTargets(model: Model): ScanTarget[] {
  const out: ScanTarget[] = [];
  const base = `model:${model.id}`;
  pushTarget(out, `${base}.baseUrl`, (model as { baseUrl?: string }).baseUrl);
  pushTarget(out, `${base}.promptTemplate`, model.promptTemplate);
  pushTarget(out, `${base}.displayName`, model.displayName);
  pushTarget(out, `${base}.description`, model.description);
  pushTarget(out, `${base}.name`, model.name);
  return out;
}

/** Extract scannable slices from a planned execution (its prompt + name). */
export function extractPlannedExecutionTargets(pe: PlannedExecution): ScanTarget[] {
  const out: ScanTarget[] = [];
  const base = `plannedExecution:${pe.id}`;
  pushTarget(out, `${base}.name`, pe.name);
  pushTarget(out, `${base}.prompt`, pe.prompt);
  return out;
}

/** Inputs to the extractor — an already-resolved set of packaged entities. */
export interface ScanEntities {
  flows: Flow[];
  models: Model[];
  plannedExecutions: PlannedExecution[];
}

/**
 * Collect every scannable content slice across the packaged entities. The
 * MCP servers are intentionally absent: their secret ENV/HEADER names are
 * declared by the entity-level derivation, and their values are never
 * packaged, so there is nothing to content-scan.
 */
export function extractScanTargets(entities: ScanEntities): ScanTarget[] {
  const out: ScanTarget[] = [];
  for (const flow of entities.flows ?? []) out.push(...extractFlowTargets(flow));
  for (const model of entities.models ?? []) out.push(...extractModelTargets(model));
  for (const pe of entities.plannedExecutions ?? []) out.push(...extractPlannedExecutionTargets(pe));
  return out;
}
