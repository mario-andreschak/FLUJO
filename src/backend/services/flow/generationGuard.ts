/**
 * Generation-side scratchpad-variable guard (issue #217).
 *
 * When FLUJO auto-generates a flow, the generating model likes to reach for the
 * `${var:NAME}` scratchpad (FlowSpec Rule 9): step A does `captureVariable: "NAME"`,
 * step B injects `${var:NAME}` into its prompt. That is a *valid* hand-authoring
 * pattern, but for GENERATED flows it is a footgun:
 *   - step A may never actually capture the variable (dangling reference),
 *   - even when it does, the flattened value bloats the prompt, and
 *   - the run-time resolver deliberately substitutes an EMPTY STRING for an
 *     unknown/late variable (see resolveRunVars.ts), silently baking `""` into
 *     step B's prompt and breaking the run.
 *
 * The fix is NOT to remove the DSL feature (it is a public authoring contract) but
 * to STEER generated flows away from it. This deterministic guard runs on the raw
 * FlowSpec BEFORE it is compiled/returned and rewrites every `${var:NAME}` so an
 * unsafe reference can never reach execution:
 *
 *   1. HISTORY — a provably-earlier (topologically ancestor) node captures NAME and
 *      the consumer can carry the value through conversation history: STRIP the
 *      `${var:NAME}` token and force the consumer to `inputMode: "full-history"` so
 *      it actually sees the producer's turn. The producer's `captureVariable` is
 *      dropped (nobody references it anymore).
 *   2. DANGLING — no provably-earlier node captures NAME at all: REMOVE the dangling
 *      `${var:NAME}` token (it would only ever resolve to `""`).
 *
 * Earlier versions converted isolated consumers to a passive process
 * `captureResource`. ProcessNode deliberately does not implement that contract:
 * process-owned artifacts must be written through an explicit Resource node and
 * `write_resource`. Generated flows therefore use the same history policy for
 * every valid consumer, including a consumer authored as isolated.
 *
 * The guard is PURE, deterministic and IDEMPOTENT (running it twice is a no-op):
 * after a pass, no `${var:NAME}` reference survives, so a second pass finds nothing
 * to do. It recurses into inline `subflowSpec` / `parallelSubflowSpecs` children,
 * each of which is its own run-variable scope.
 *
 * Kept alongside the generator (backend service): it consumes generation-shaped
 * FlowSpecs. It reuses `referencedRunVars` from resolveRunVars.ts for detection so
 * the scan can never drift from the run-time resolver.
 */
import { FlowSpec, FlowSpecNode } from '@/utils/shared/flowSpecCompiler';
import { referencedRunVars } from '@/utils/shared/resolveRunVars';

/** One rewrite the guard performed, surfaced to logs + the generator repair feedback. */
export interface GuardChange {
  code:
    | 'var-history' // stripped ${var:NAME}, consumer forced to full-history
    | 'var-dangling'; // removed a ${var:NAME} with no earlier producer
  message: string;
}

export interface GuardResult {
  /** The same spec object, mutated in place. */
  spec: FlowSpec;
  changes: GuardChange[];
}

/** Text fields on a node that may embed a `${var:NAME}` reference. */
const TEXT_FIELDS = ['prompt', 'isolatedPrompt', 'payloadTemplate'] as const;

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A tolerant `${var:NAME}` matcher for one exact NAME (allows `${var: NAME }`). */
function varRefRegExp(name: string): RegExp {
  return new RegExp('\\$\\{var:\\s*' + escapeRegExp(name) + '\\s*\\}', 'g');
}

/** Every distinct `${var:NAME}` name referenced by a node's text fields + spawn briefs. */
function nodeReferencedVars(node: FlowSpecNode): string[] {
  const names = new Set<string>();
  for (const field of TEXT_FIELDS) {
    const value = (node as unknown as Record<string, unknown>)[field];
    if (typeof value === 'string') for (const n of referencedRunVars(value)) names.add(n);
  }
  if (Array.isArray(node.spawnBriefs)) {
    for (const brief of node.spawnBriefs) {
      if (typeof brief === 'string') for (const n of referencedRunVars(brief)) names.add(n);
    }
  }
  return [...names];
}

/** Apply a string transform to every text field + spawn brief of a node. */
function transformNodeTexts(node: FlowSpecNode, fn: (text: string) => string): void {
  for (const field of TEXT_FIELDS) {
    const value = (node as unknown as Record<string, unknown>)[field];
    if (typeof value === 'string') (node as unknown as Record<string, unknown>)[field] = fn(value);
  }
  if (Array.isArray(node.spawnBriefs)) {
    node.spawnBriefs = node.spawnBriefs.map((b) => (typeof b === 'string' ? fn(b) : b));
  }
}

/** Collapse whitespace left behind when a `${var:...}` token is removed mid-sentence. */
function tidy(text: string): string {
  return text
    .replace(/[ \t]{2,}/g, ' ') // runs of spaces from a removed token
    .replace(/[ \t]+([.,;:!?])/g, '$1') // space before punctuation
    .replace(/[ \t]+\n/g, '\n'); // trailing spaces before a newline
}

/**
 * Guard ONE FlowSpec level (does not recurse). Returns the changes made at this level.
 * A "producer" of NAME is a node with `captureVariable === NAME`; it is a VALID producer
 * for a consumer only when it is a topological ANCESTOR of that consumer (it provably runs
 * earlier on the consumer's path).
 */
function guardLevel(spec: FlowSpec, changes: GuardChange[]): void {
  const nodes: FlowSpecNode[] = Array.isArray(spec?.nodes) ? spec.nodes.filter((n) => n && typeof n.key === 'string') : [];
  if (nodes.length === 0) return;
  const edges = Array.isArray(spec?.edges) ? spec.edges : [];

  // Ancestor sets via reverse BFS over directed edges (bidirectional edges add both ways).
  const preds = new Map<string, Set<string>>();
  for (const node of nodes) preds.set(node.key, new Set());
  for (const edge of edges) {
    if (!edge || typeof edge.from !== 'string' || typeof edge.to !== 'string') continue;
    if (preds.has(edge.to)) preds.get(edge.to)!.add(edge.from);
    if (edge.bidirectional && preds.has(edge.from)) preds.get(edge.from)!.add(edge.to);
  }
  const ancestorsOf = (key: string): Set<string> => {
    const seen = new Set<string>();
    const stack = [...(preds.get(key) ?? [])];
    while (stack.length) {
      const cur = stack.pop()!;
      if (seen.has(cur) || cur === key) continue;
      seen.add(cur);
      for (const p of preds.get(cur) ?? []) stack.push(p);
    }
    return seen;
  };

  // Names consumed as a node PROPERTY rather than a ${var:} text token — dynamic fan-out
  // (parallelFlowsVariable) reads a captured variable by name. Those are intentional wiring,
  // not prompt footguns, so leave them (and their capture) completely untouched.
  const protectedNames = new Set<string>();
  for (const node of nodes) {
    if (typeof node.parallelFlowsVariable === 'string' && node.parallelFlowsVariable.trim()) {
      protectedNames.add(node.parallelFlowsVariable.trim());
    }
  }

  // Producers of each variable name.
  const producers = new Map<string, FlowSpecNode[]>();
  for (const node of nodes) {
    const name = typeof node.captureVariable === 'string' ? node.captureVariable.trim() : '';
    if (name) {
      if (!producers.has(name)) producers.set(name, []);
      producers.get(name)!.push(node);
    }
  }

  // Which names are referenced anywhere, and by which consumer nodes.
  const consumersByName = new Map<string, FlowSpecNode[]>();
  for (const node of nodes) {
    for (const name of nodeReferencedVars(node)) {
      if (!consumersByName.has(name)) consumersByName.set(name, []);
      consumersByName.get(name)!.push(node);
    }
  }

  for (const [name, consumers] of consumersByName) {
    if (protectedNames.has(name)) continue; // dynamic fan-out reads this by name — leave it
    const nameProducers = producers.get(name) ?? [];
    // A consumer has a VALID producer if some producer (not itself) is its ancestor.
    const validConsumers = consumers.filter((c) => {
      const anc = ancestorsOf(c.key);
      return nameProducers.some((p) => p.key !== c.key && anc.has(p.key));
    });

    if (validConsumers.length === 0) {
      // DANGLING: nobody provably captures NAME before it is read — strip every reference.
      const re = varRefRegExp(name);
      for (const node of nodes) {
        transformNodeTexts(node, (t) => tidy(t.replace(re, '')));
      }
      changes.push({
        code: 'var-dangling',
        message: `Removed \${var:${name}} — no earlier step captures it (it would resolve to an empty string at run time).`,
      });
      continue;
    }

    // HISTORY: carry the value through the conversation. Strip the token everywhere and
    // force each valid consumer to full-history so it actually sees the producer's turn.
    // This intentionally overrides isolated mode: auto-generation cannot safely synthesize
    // the explicit Resource-node/write_resource protocol required for process artifacts.
    const re = varRefRegExp(name);
    for (const node of nodes) {
      transformNodeTexts(node, (t) => tidy(t.replace(re, '')));
    }
    for (const c of validConsumers) c.inputMode = 'full-history';
    // Nobody references NAME anymore; drop the now-unused capture on every producer.
    for (const p of nameProducers) {
      if (p.captureVariable === name) delete p.captureVariable;
    }
    changes.push({
      code: 'var-history',
      message: `Removed scratchpad \${var:${name}} and set the reading step(s) to full-history so the value flows through the conversation instead.`,
    });
  }
}

/** Recurse into every inline child spec (each is its own run-variable scope). */
function guardRecursive(spec: FlowSpec, changes: GuardChange[]): void {
  if (!spec || !Array.isArray(spec.nodes)) return;
  guardLevel(spec, changes);
  for (const node of spec.nodes) {
    if (!node) continue;
    if (node.subflowSpec) guardRecursive(node.subflowSpec, changes);
    if (Array.isArray(node.parallelSubflowSpecs)) {
      for (const child of node.parallelSubflowSpecs) guardRecursive(child, changes);
    }
  }
}

/**
 * Rewrite unsafe `${var:NAME}` scratchpad usage out of a GENERATED FlowSpec (issue #217),
 * mutating it in place. See the module header for the HISTORY / DANGLING policy.
 * Pure, deterministic, idempotent; never throws on malformed input.
 */
export function guardGeneratedFlowSpec(spec: FlowSpec): GuardResult {
  const changes: GuardChange[] = [];
  try {
    guardRecursive(spec, changes);
  } catch {
    /* best-effort: a malformed spec is left as-is for the compiler/validator to flag */
  }
  return { spec, changes };
}
