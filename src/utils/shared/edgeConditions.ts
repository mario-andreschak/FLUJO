/**
 * Deterministic edge conditions (Tier 2b — data-driven routing).
 *
 * A control edge may carry a predicate over the conversation's last message.
 * The flow engine evaluates it deterministically (no model tool call) and takes
 * the first outgoing edge whose predicate matches; a bare (predicate-less) edge
 * is the default/fallback. This lets a flow branch on "did the step say PASS or
 * FAIL" without depending on a small model reliably emitting a handoff tool call.
 *
 * The `always` kind is an explicit always-true predicate: a discoverable,
 * deterministic default route that fires on ANY reply (including plain text), so
 * a process node carrying an `always` edge advances instead of silently
 * terminating when a small model does not emit a handoff tool call (issue #111).
 * It replaces the non-obvious always-matching `[\s\S]*` regex workaround and
 * needs no `value`.
 *
 * Conditions may also leave a Start or Static node, which lets a flow check a
 * message BEFORE any model sees it. Such a flow re-enters at its Start node on
 * every user turn (see `entryConditionStartNodeId`), so a follow-up question is
 * checked the same way as the first one.
 *
 * This module is intentionally pure and dependency-light so it can run in the
 * browser (Flow builder / spec validation) and on the backend (ProcessNode.post)
 * alike. `evaluateCondition` NEVER throws — an invalid regex degrades to "no
 * match" so a typo in a predicate can never crash a run.
 */

export type EdgeConditionKind = 'contains' | 'regex' | 'equals' | 'always' | 'exists' | 'gt' | 'gte' | 'lt' | 'lte';
export type EdgeConditionTarget = 'last-assistant' | 'last-message' | 'last-user' | 'variable';

/** Who put a value into a run variable. */
export type VariableSource = 'model' | 'tool' | 'person' | 'rule' | 'input';
export const VARIABLE_SOURCES: readonly VariableSource[] = ['model', 'tool', 'person', 'rule', 'input'];

/** Where a run variable's value came from. The value is kept so that anything
 *  changing the variable afterwards no longer counts as that source. */
export interface RecordedVariableSource {
  from: VariableSource;
  value: string;
}

/** The part of a run a condition can read. */
export interface ConditionState {
  variables?: Readonly<Record<string, unknown>> | null;
  variableSources?: Readonly<Record<string, RecordedVariableSource>> | null;
}

export interface EdgeCondition {
  /** How `value` is matched against the selected message. */
  kind: EdgeConditionKind;
  /** The literal (contains/equals) or regex source (regex) to match. Optional —
   *  `kind: 'always'` is a value-less always-true predicate; the other kinds
   *  require it (an empty/absent value is treated as "never match" by the
   *  compiler/validator for those kinds). */
  value?: string;
  /** Which message to test. The default depends on the node the edge leaves:
   *  'last-assistant' after a Process node (the step's own output), 'last-user'
   *  after a Start node, 'last-message' after a Static node. 'variable' tests a
   *  run variable instead of a message, see `variable`. */
  target?: EdgeConditionTarget;
  /** With target 'variable': the run variable, optionally with a dotted path into
   *  its JSON value, such as `status` or `status.items.0.code`. */
  variable?: string;
  /** With target 'variable': where the value must come from. A value from anywhere
   *  else counts as missing, so a model's text cannot stand in for a person's answer. */
  from?: VariableSource | VariableSource[];
  /** Case-insensitive matching. For contains/equals it lowercases both sides;
   *  for regex it adds the `i` flag (JS regex has no `(?i)` inline flags). Default false. */
  ignoreCase?: boolean;
  /** Negate the match. Default false. Not applied when a regex fails to compile
   *  (a broken predicate must never route). */
  negate?: boolean;
}

export const EDGE_CONDITION_KINDS: readonly EdgeConditionKind[] = ['contains', 'regex', 'equals', 'always', 'exists', 'gt', 'gte', 'lt', 'lte'];

/** Kinds that test only whether something is there, so they need no `value`. */
export const VALUELESS_CONDITION_KINDS: readonly EdgeConditionKind[] = ['always', 'exists'];
export const EDGE_CONDITION_TARGETS: readonly EdgeConditionTarget[] = ['last-assistant', 'last-message', 'last-user', 'variable'];

/** Node types whose outgoing edges may carry a routing condition. */
export const CONDITION_SOURCE_NODE_TYPES: readonly string[] = ['process', 'start', 'static'];

/** The message a condition tests when it names no target, by the node it leaves. */
export function defaultConditionTarget(sourceNodeType: string | undefined): EdgeConditionTarget {
  if (sourceNodeType === 'start') return 'last-user';
  if (sourceNodeType === 'static') return 'last-message';
  return 'last-assistant';
}

/** True when `kind` is a known condition kind. */
export function isValidConditionKind(kind: unknown): kind is EdgeConditionKind {
  return typeof kind === 'string' && (EDGE_CONDITION_KINDS as readonly string[]).includes(kind);
}

/** Runtime guard for condition data loaded from persisted or imported flows. */
export function isEdgeCondition(value: unknown): value is EdgeCondition {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return isValidConditionKind(candidate.kind)
    && (candidate.value === undefined || typeof candidate.value === 'string')
    && (candidate.target === undefined
      || (typeof candidate.target === 'string'
        && (EDGE_CONDITION_TARGETS as readonly string[]).includes(candidate.target)))
    && (candidate.variable === undefined || typeof candidate.variable === 'string')
    && (candidate.from === undefined || typeof candidate.from === 'string' || Array.isArray(candidate.from))
    && (candidate.ignoreCase === undefined || typeof candidate.ignoreCase === 'boolean')
    && (candidate.negate === undefined || typeof candidate.negate === 'boolean');
}

/** True when `pattern` compiles as a JS RegExp (used by validation to warn early). */
export function isRegexCompilable(pattern: string): boolean {
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}

/**
 * A short, human-legible label for a condition — used by the FlowBuilder canvas
 * badge so a conditional (branching) edge is visually distinguishable from a
 * plain one. Kept compact (value truncated) so it doesn't crowd the wire:
 *   contains "FAIL"      → `contains:"FAIL"`
 *   regex   /^PASS\b/    → `regex:/^PASS…/`
 *   negate               → `!` prefix (e.g. `!contains:"x"`)
 *   ignoreCase           → trailing ` i` marker (e.g. `contains:"x" i`)
 *   always               → `always` (value-less)
 * Returns '' for a missing/invalid condition so callers can treat it as
 * "render no badge".
 */
export function formatConditionLabel(
  cond: EdgeCondition | undefined | null,
  labels?: Partial<Record<EdgeConditionKind, string>>,
): string {
  if (!cond || !isValidConditionKind(cond.kind)) return '';
  const prefix = cond.negate ? '!' : '';
  const kindLabel = labels?.[cond.kind] ?? cond.kind;
  if (cond.kind === 'always') return `${prefix}${kindLabel}`;
  if (cond.kind === 'exists') return `${prefix}${kindLabel}${cond.variable ? `:${cond.variable}` : ''}`;
  const ci = cond.ignoreCase ? ' i' : '';
  const raw = typeof cond.value === 'string' ? cond.value : '';
  const MAX = 8;
  const shown = raw.length > MAX ? `${raw.slice(0, MAX)}…` : raw;
  const body = cond.kind === 'regex' ? `/${shown}/` : `"${shown}"`;
  const subject = cond.target === 'variable' && cond.variable ? `${cond.variable} ` : '';
  return `${prefix}${subject}${kindLabel}:${body}${ci}`;
}

/**
 * Coerce a chat message's `content` into a plain string. OpenAI content can be a
 * string or an array of parts; we join the text parts and drop non-text parts.
 * Anything else (null/undefined/object) becomes ''.
 */
export function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && 'text' in part && typeof (part as { text?: unknown }).text === 'string') {
          return (part as { text: string }).text;
        }
        return '';
      })
      .join('');
  }
  return '';
}

/** A minimal message shape the selector needs — role + content. */
interface SelectableMessage {
  role?: string;
  content?: unknown;
}

/**
 * Read a run variable for a condition. A dotted path reads into the variable's JSON
 * value, which is how a captured tool result is reached without a model. Returns null
 * for anything missing, so a condition cannot match on a value that is not there.
 * Numbers and booleans come back as text, because conditions compare text.
 */
export function readConditionVariable(
  variable: string | undefined,
  variables: Readonly<Record<string, unknown>> | undefined | null,
): string | null {
  if (!variable || !variables) return null;
  const [name, ...path] = variable.split('.');
  if (!Object.hasOwn(variables, name)) return null;
  let value: unknown = variables[name];
  if (path.length > 0) {
    if (typeof value === 'string') {
      try { value = JSON.parse(value); } catch { return null; }
    }
    for (const key of path) {
      if (!value || typeof value !== 'object' || !Object.hasOwn(value as object, key)) return null;
      value = (value as Record<string, unknown>)[key];
    }
  }
  if (value === null || value === undefined) return null;
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

/** Note who wrote a run variable, right after it was written. */
export function recordVariableSource(
  state: { variables?: Record<string, string>; variableSources?: Record<string, RecordedVariableSource> },
  name: string,
  from: VariableSource,
): void {
  state.variableSources ??= {};
  Object.defineProperty(state.variableSources, name, {
    value: { from, value: String(state.variables?.[name] ?? '') },
    configurable: true, enumerable: true, writable: true,
  });
}

/** True only if a variable still holds the value the given source put there. */
export function variableCameFrom(
  variable: string | undefined,
  from: VariableSource | VariableSource[],
  state: ConditionState | null | undefined,
): boolean {
  const name = variable?.split('.')[0];
  if (!name || !state?.variables || !state.variableSources) return false;
  if (!Object.hasOwn(state.variables, name) || !Object.hasOwn(state.variableSources, name)) return false;
  const recorded = state.variableSources[name];
  if (recorded?.value !== state.variables[name]) return false;
  return (Array.isArray(from) ? from : [from]).includes(recorded.from);
}

/**
 * Pick the text a condition tests, per its `target`:
 *   - 'last-assistant' (default): the most recent assistant message's text —
 *     the natural "what did this step say". Returns null if there is none.
 *   - 'last-message': the most recent message of any role (may be a tool result).
 *   - 'last-user': the most recent user message, which stays correct when a
 *     system prompt or injected entry follows it.
 * Returns null when no suitable message exists.
 */
export function selectConditionText(
  messages: SelectableMessage[] | undefined | null,
  target: EdgeConditionTarget = 'last-assistant'
): string | null {
  if (!Array.isArray(messages) || messages.length === 0) return null;
  if (target === 'last-message') {
    return messageText(messages[messages.length - 1]?.content);
  }
  const role = target === 'last-user' ? 'user' : 'assistant';
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === role) return messageText(messages[i]?.content);
  }
  return null;
}

/**
 * Evaluate a predicate against a message string. Pure and total — never throws.
 * An invalid regex logs a warning and evaluates to `false` (edge not taken),
 * with `negate` NOT applied, so a broken predicate can never hijack routing.
 */
export function evaluateCondition(
  cond: EdgeCondition | undefined | null,
  message: string | null | undefined
): boolean {
  if (!cond) return false;
  const text = typeof message === 'string' ? message : '';
  const value = typeof cond.value === 'string' ? cond.value : String(cond.value ?? '');

  let matched: boolean;
  switch (cond.kind) {
    case 'exists':
      matched = typeof message === 'string';
      break;
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      // Like a broken regex, a value that is not a number never routes, whatever
      // `negate` says, so "not above 5" cannot match a missing or unreadable value.
      const left = text.trim() === '' ? Number.NaN : Number(text);
      const right = value.trim() === '' ? Number.NaN : Number(value);
      if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
      matched = cond.kind === 'gt' ? left > right
        : cond.kind === 'gte' ? left >= right
          : cond.kind === 'lt' ? left < right
            : left <= right;
      break;
    }
    case 'contains':
      matched = cond.ignoreCase
        ? text.toLowerCase().includes(value.toLowerCase())
        : text.includes(value);
      break;
    case 'equals':
      matched = cond.ignoreCase ? text.toLowerCase() === value.toLowerCase() : text === value;
      break;
    case 'regex': {
      let re: RegExp;
      try {
        re = new RegExp(value, cond.ignoreCase ? 'i' : undefined);
      } catch (err) {
        // Defensive: validation catches bad regex earlier, but never throw into
        // the engine. A predicate that cannot compile simply never matches.
        console.warn('[edgeConditions] invalid regex predicate; treating as no-match', value, err);
        return false;
      }
      matched = re.test(text);
      break;
    }
    case 'always':
      // Explicit always-true predicate (issue #111): the discoverable, always-
      // matching deterministic fallback route. Needs no value; `negate` still
      // applies (negate:true yields a harmless never-match, for consistency).
      matched = true;
      break;
    default:
      // Unknown kind: never match (validation drops these with a warning).
      console.warn('[edgeConditions] unknown condition kind; treating as no-match', (cond as { kind?: unknown }).kind);
      return false;
  }

  return cond.negate ? !matched : matched;
}

/**
 * Whether a condition holds for a run. A variable that is missing, or that did not come
 * from where the condition demands, proves nothing, even negated. Only 'exists' asks
 * about absence, and 'always' does not read the value at all.
 */
export function conditionMatches(
  cond: EdgeCondition,
  messages: SelectableMessage[] | undefined | null,
  defaultTarget: EdgeConditionTarget,
  state: ConditionState | null | undefined,
): boolean {
  if (cond.target !== 'variable') {
    return evaluateCondition(cond, selectConditionText(messages, cond.target ?? defaultTarget));
  }
  const text = cond.from !== undefined && !variableCameFrom(cond.variable, cond.from, state)
    ? null
    : readConditionVariable(cond.variable, state?.variables);
  if (text === null && cond.kind !== 'exists' && cond.kind !== 'always') return false;
  return evaluateCondition(cond, text);
}

/**
 * Pick the outgoing edge for a node that has conditions: the first edge in author
 * order whose predicate matches, otherwise the first edge without one. Returns
 * null when nothing matches and no such edge exists; the caller ends the run.
 */
export function selectConditionedEdge(
  orderedEdges: readonly string[],
  conditions: Readonly<Record<string, EdgeCondition>>,
  messages: SelectableMessage[] | undefined | null,
  defaultTarget: EdgeConditionTarget = 'last-assistant',
  state?: ConditionState | null,
): string | null {
  for (const edgeId of orderedEdges) {
    const cond = conditions[edgeId];
    if (cond && conditionMatches(cond, messages, defaultTarget, state)) return edgeId;
  }
  return orderedEdges.find((edgeId) => !conditions[edgeId]) ?? null;
}

interface EntryConditionFlow {
  nodes?: ReadonlyArray<{ id: string; type?: string; data?: { type?: string; properties?: unknown } | null }> | null;
  edges?: ReadonlyArray<{
    source: string;
    target: string;
    data?: { edgeType?: string; condition?: unknown } | null;
  }> | null;
}

/**
 * The Start node's id when a routing condition sits between it and the first model
 * step, otherwise null. Such a condition only protects the model if it sees every
 * user turn, so the engine re-enters at this node instead of resuming at the last
 * Process step. The walk stops at any node that can talk to a model, because a
 * condition after that point is ordinary routing and must not restart the flow.
 */
export function entryConditionStartNodeId(flow: EntryConditionFlow | null | undefined): string | null {
  const nodes = flow?.nodes ?? [];
  const edges = flow?.edges ?? [];
  const typeOf = (id: string) => {
    const node = nodes.find((candidate) => candidate.id === id);
    return node?.data?.type ?? node?.type;
  };
  const start = nodes.find((node) => (node.data?.type ?? node.type) === 'start');
  if (!start) return null;

  const seen = new Set<string>([start.id]);
  const queue = [start.id];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const edge of edges) {
      if (edge.source !== current || edge.data?.edgeType === 'mcp' || edge.data?.edgeType === 'resource') continue;
      if (edge.data?.condition) return start.id;
      const targetType = typeOf(edge.target);
      if ((targetType === 'static' || targetType === 'signal') && !seen.has(edge.target)) {
        // Decision rules before the first model step decide per turn, like a condition.
        const target = nodes.find((candidate) => candidate.id === edge.target);
        const rules = (target?.data?.properties as { rules?: unknown } | null | undefined)?.rules;
        if (Array.isArray(rules) && rules.length > 0) return start.id;
        seen.add(edge.target);
        queue.push(edge.target);
      }
    }
  }
  return null;
}
