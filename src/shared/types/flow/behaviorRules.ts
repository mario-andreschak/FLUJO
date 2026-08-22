import type { BehaviorRule } from './flow';

export type FlowBehaviorRulesInput = {
  behaviorRules?: BehaviorRule[];
  /** Read-only compatibility alias. Canonical Flow values never emit this key. */
  permissionRules?: BehaviorRule[];
};

function structurallyEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== typeof right || left === null || right === null) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => structurallyEqual(value, right[index]));
  }
  if (typeof left !== 'object') return false;

  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => (
      key === rightKeys[index]
      && structurallyEqual(leftRecord[key], rightRecord[key])
    ));
}

/**
 * Collapse the legacy Flow policy alias into the canonical Behavior vocabulary.
 * Validation remains the caller's responsibility; this helper only resolves the
 * alias, preserves extension fields, and fails closed on ambiguous policy input.
 */
export function normalizeBehaviorRulesInput<T extends object>(
  input: T,
): Omit<T, 'permissionRules'> & { behaviorRules?: BehaviorRule[] } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Flow policy input must be an object.');
  }

  const source = input as T & FlowBehaviorRulesInput;
  const hasBehaviorRules = source.behaviorRules !== undefined;
  const hasPermissionRules = source.permissionRules !== undefined;

  if (
    hasBehaviorRules
    && hasPermissionRules
    && !structurallyEqual(source.behaviorRules, source.permissionRules)
  ) {
    throw new Error(
      'Flow behaviorRules conflicts with legacy permissionRules; provide one policy or identical values.',
    );
  }

  const { permissionRules: _legacy, ...canonical } = source;
  const behaviorRules = hasBehaviorRules ? source.behaviorRules : source.permissionRules;
  if (behaviorRules === undefined) {
    delete (canonical as Record<string, unknown>).behaviorRules;
  } else {
    (canonical as Record<string, unknown>).behaviorRules = behaviorRules;
  }
  return canonical as Omit<T, 'permissionRules'> & { behaviorRules?: BehaviorRule[] };
}
