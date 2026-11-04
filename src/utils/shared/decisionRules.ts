/**
 * Decision rules: a flow, not a model, decides what is allowed next.
 *
 * A Static node can carry an ordered list of rules. The first rule whose condition
 * holds is the decision. It names an outcome the flow can branch on, can set run
 * variables, and can limit which connected tools later model steps may use. There is
 * no model in this, so nothing a model writes can change the result, unless a rule
 * chooses to read a value a model wrote.
 *
 * A condition can also say where a value must come from. A value a person gave in a
 * human gate is recorded as coming from a person, and text a model produces is recorded
 * as coming from a model, so a model cannot stand in for a person's approval.
 *
 * This module is pure so the Flow builder and the engine share one meaning.
 */

import {
  EDGE_CONDITION_TARGETS,
  VALUELESS_CONDITION_KINDS,
  VARIABLE_SOURCES,
  conditionMatches,
  isValidConditionKind,
  type ConditionState,
  type EdgeCondition,
  type EdgeConditionTarget,
} from './edgeConditions';
import { isValidRunVarName } from './resolveRunVars';

export type DecisionCondition =
  | EdgeCondition
  | { all: DecisionCondition[] }
  | { any: DecisionCondition[] }
  | { not: DecisionCondition };

export interface DecisionRule {
  /** Names the rule in the decision log. Unique within the node. */
  id: string;
  /** When this rule applies. A rule with no condition always applies. */
  when?: DecisionCondition;
  /** The result. Later edges test it through the decision variable. */
  outcome: string;
  /** A short code that says why, for the log. */
  reason?: string;
  /** Run variables to set. The values are literal text, never templates, so a rule
   *  cannot be used to pass a model's text off as a value the flow chose. */
  set?: Record<string, string>;
  /** The connected tools model steps may use from here on. Each decision replaces the
   *  list from the one before, and a rule with no list sets no limit. */
  allowTools?: string[];
}

/** One entry in the record of what was decided and why. */
export interface FlowDecision {
  nodeId: string;
  ruleId: string;
  outcome: string;
  reason?: string;
  allowTools?: string[];
  at: string;
  runId?: string;
}

export const DEFAULT_DECISION_VARIABLE = 'decision';
export const MAX_DECISION_RULES = 100;
/** Decisions kept per conversation. Older ones drop off. */
export const MAX_DECISION_LOG = 200;
const MAX_CONDITION_DEPTH = 16;
const RESERVED_KEYS = ['__proto__', 'constructor', 'prototype'];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Whether a condition holds. A shape this code does not know never holds, and neither
 * does an empty `all` or `any`, because a rule that opens by accident is the failure
 * that matters here.
 */
export function decisionConditionMatches(
  when: unknown,
  messages: Parameters<typeof conditionMatches>[1],
  state: ConditionState | null | undefined,
  depth = 0,
): boolean {
  if (depth > MAX_CONDITION_DEPTH || !isPlainObject(when)) return false;
  const inner = (next: unknown) => decisionConditionMatches(next, messages, state, depth + 1);
  if ('all' in when) return Array.isArray(when.all) && when.all.length > 0 && when.all.every(inner);
  if ('any' in when) return Array.isArray(when.any) && when.any.some(inner);
  if ('not' in when) return isPlainObject(when.not) && !inner(when.not);
  if (!isValidConditionKind(when.kind)) return false;
  const leaf = when as unknown as EdgeCondition;
  return conditionMatches(
    typeof leaf.variable === 'string' && !leaf.target ? { ...leaf, target: 'variable' } : leaf,
    messages,
    'last-message',
    state,
  );
}

/** The first rule that applies, or null when none does. */
export function selectDecisionRule(
  rules: readonly DecisionRule[] | null | undefined,
  messages: Parameters<typeof conditionMatches>[1],
  state: ConditionState | null | undefined,
): DecisionRule | null {
  for (const rule of rules ?? []) {
    if (!isPlainObject(rule)) continue;
    if (rule.when === undefined || decisionConditionMatches(rule.when, messages, state)) return rule;
  }
  return null;
}

/** What a run should know about a decision, as the value of the decision variable. */
export function decisionVariableValue(rule: DecisionRule): string {
  return JSON.stringify({
    ruleId: rule.id,
    outcome: rule.outcome,
    ...(rule.reason ? { reason: rule.reason } : {}),
  });
}

/** The tools a step may use: what this run decided, within what its parent decided. */
export function effectiveAllowedToolNames(state: {
  allowedToolNames?: string[];
  inheritedAllowedToolNames?: string[];
}): string[] | undefined {
  const own = state.allowedToolNames;
  const inherited = state.inheritedAllowedToolNames;
  if (!own) return inherited;
  if (!inherited) return own;
  return own.filter((name) => inherited.includes(name));
}

export interface DecisionRuleIssue {
  severity: 'error' | 'warning';
  code: string;
  message: string;
}

function conditionProblem(when: unknown, depth = 0): string | null {
  if (depth > MAX_CONDITION_DEPTH) return 'is nested too deeply';
  if (!isPlainObject(when)) return 'must be an object';
  const operators = ['all', 'any', 'not'].filter((name) => name in when);
  if (operators.length > 1) return 'can use only one of all, any and not';
  if (operators[0] === 'all' || operators[0] === 'any') {
    const list = when[operators[0]];
    if (!Array.isArray(list) || list.length === 0) return `needs at least one condition in "${operators[0]}"`;
    for (const item of list) {
      const problem = conditionProblem(item, depth + 1);
      if (problem) return problem;
    }
    return null;
  }
  if (operators[0] === 'not') return conditionProblem(when.not, depth + 1);
  if (!isValidConditionKind(when.kind)) return `has an unknown kind "${String(when.kind)}"`;
  if (!VALUELESS_CONDITION_KINDS.includes(when.kind) && (typeof when.value !== 'string' || !when.value)) {
    return `needs a value for "${when.kind}"`;
  }
  if (when.target !== undefined && !(EDGE_CONDITION_TARGETS as readonly unknown[]).includes(when.target)) {
    return `has an unknown target "${String(when.target as EdgeConditionTarget)}"`;
  }
  if (when.target === 'variable' && (typeof when.variable !== 'string' || !when.variable.trim())) {
    return 'tests a variable but does not name one';
  }
  if (when.variable !== undefined && typeof when.variable !== 'string') return 'must name its variable as text';
  if (when.from !== undefined) {
    if (typeof when.variable !== 'string' || !when.variable.trim()) return 'can only say where a value comes from when it tests a variable';
    const sources = Array.isArray(when.from) ? when.from : [when.from];
    if (sources.length === 0 || sources.some((source) => !(VARIABLE_SOURCES as readonly unknown[]).includes(source))) {
      return `has an unknown source, use ${VARIABLE_SOURCES.join(', ')}`;
    }
  }
  return null;
}

/**
 * Everything wrong with a list of rules. A rule that is dropped or misread could allow
 * something it was written to stop, so problems here stop the compile.
 */
export function decisionRuleIssues(rules: unknown, nodeLabel: string): DecisionRuleIssue[] {
  const issues: DecisionRuleIssue[] = [];
  const error = (message: string) => issues.push({ severity: 'error', code: 'decision-rule-invalid', message: `${nodeLabel}: ${message}` });
  if (!Array.isArray(rules)) {
    error('rules must be a list.');
    return issues;
  }
  if (rules.length > MAX_DECISION_RULES) error(`has more than ${MAX_DECISION_RULES} rules.`);
  const seen = new Set<string>();
  let hasFallback = false;
  rules.forEach((rule: unknown, index) => {
    const label = `rule #${index + 1}`;
    if (!isPlainObject(rule)) {
      error(`${label} must be an object.`);
      return;
    }
    if (typeof rule.id !== 'string' || !rule.id.trim()) error(`${label} needs an id.`);
    else if (seen.has(rule.id)) error(`${label} repeats the id "${rule.id}".`);
    else seen.add(rule.id);
    if (typeof rule.outcome !== 'string' || !rule.outcome.trim()) error(`${label} needs an outcome.`);
    if (rule.reason !== undefined && typeof rule.reason !== 'string') error(`${label} must give its reason as text.`);
    if (rule.when === undefined) hasFallback = true;
    else {
      const problem = conditionProblem(rule.when);
      if (problem) error(`the condition of ${label} ${problem}.`);
    }
    if (rule.set !== undefined) {
      if (!isPlainObject(rule.set)) error(`${label} must give "set" as an object.`);
      else {
        for (const [name, value] of Object.entries(rule.set)) {
          if (!isValidRunVarName(name) || RESERVED_KEYS.includes(name)) error(`${label} sets an invalid variable name "${name}".`);
          if (typeof value !== 'string') error(`${label} must set "${name}" to text.`);
        }
      }
    }
    if (rule.allowTools !== undefined && (!Array.isArray(rule.allowTools) || rule.allowTools.some((name) => typeof name !== 'string'))) {
      error(`${label} must give "allowTools" as a list of tool names.`);
    }
  });
  if (!hasFallback && rules.length > 0) {
    issues.push({
      severity: 'warning',
      code: 'decision-no-fallback',
      message: `${nodeLabel}: every rule has a condition. If none applies the run stops with an error, so add a last rule without one.`,
    });
  }
  return issues;
}
