/**
 * Permission rule engine (issue #246).
 *
 * Implements the last-match-wins wildcard rule evaluation for tool permission
 * policies. Deny rules in the configured set always beat saved "always" rules.
 */

import { PermissionEffect, PermissionRule, SavedPermissionRule } from '@/shared/types/permissions';
import { createLogger } from '@/utils/logger';

const log = createLogger('backend/flow/execution/permissionEngine');

/**
 * Simple wildcard matcher: `*` matches any string (including empty).
 * Only whole-string wildcards are supported (no substring glob).
 */
export function wildcardMatch(pattern: string, value: string): boolean {
  if (pattern === '*') return true;
  // Escape regex special chars, then replace \* with .*
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  try {
    return new RegExp(`^${escaped}$`).test(value);
  } catch {
    return pattern === value;
  }
}

/**
 * Extract the primary "resource" from a tool call's arguments.
 * Looks for common path/URI/command parameter names and returns the first
 * string value found. Falls back to `*` so rules with `resource: "*"` still
 * fire when the args have no obvious resource parameter.
 */
export function extractResource(args: Record<string, unknown>): string {
  const resourceKeys = [
    'path', 'file', 'filepath', 'file_path',
    'uri', 'url',
    'resource', 'location',
    'command', 'cmd',
    'directory', 'dir',
    'src', 'source', 'destination', 'dest',
  ];
  for (const key of resourceKeys) {
    const val = args[key];
    if (typeof val === 'string' && val.length > 0) {
      return val;
    }
  }
  // Try the first string value in the args
  for (const val of Object.values(args)) {
    if (typeof val === 'string' && val.length > 0) {
      return val;
    }
  }
  return '*';
}

/**
 * Evaluate a list of permission rules against a tool call using last-match-wins.
 * Returns `undefined` if no rule matches.
 */
function evaluateRuleList(
  rules: PermissionRule[],
  tool: string,
  resource: string
): PermissionEffect | undefined {
  let result: PermissionEffect | undefined;
  for (const rule of rules) {
    if (wildcardMatch(rule.action, tool) && wildcardMatch(rule.resource, resource)) {
      result = rule.effect;
    }
  }
  return result;
}

/**
 * Evaluate the full permission policy for a single tool call.
 *
 * Evaluation order:
 * 1. `permissionRules` (configured rules from flow definition + autoApprove
 *    desugaring) — last-match-wins.
 * 2. If the configured result is `'deny'`, return `'deny'` immediately. A
 *    flow-level deny cannot be overridden by a saved "always" rule.
 * 3. `savedPermissionRules` (user "always" choices for this conversation) —
 *    last-match-wins. If any saved rule matches, its effect wins.
 * 4. Fall back to the configured result, or `'ask'` if nothing matched.
 *
 * @param permissionRules   Flow-level + autoApprove rules.
 * @param savedRules        Session "always" saves.
 * @param server            Decoded MCP server name (for future use — currently
 *                          rules match on tool name alone, not server name).
 * @param tool              Decoded MCP tool original name.
 * @param resource          Extracted resource string from the call's args.
 */
export function evaluatePermission(
  permissionRules: PermissionRule[],
  savedRules: SavedPermissionRule[],
  server: string,
  tool: string,
  resource: string
): PermissionEffect {
  const configuredEffect = evaluateRuleList(permissionRules, tool, resource);

  // A flow-level deny cannot be overridden by saved "always allow".
  if (configuredEffect === 'deny') {
    log.debug('Permission denied by configured rule', { server, tool, resource });
    return 'deny';
  }

  // Saved rules (user "always" choices) can upgrade ask→allow or add deny.
  // Filter saved rules to those matching this specific server+tool pair for
  // exactness, then fall back to action/resource wildcard matching if none hit.
  const savedEffect = evaluateRuleList(savedRules, tool, resource);
  if (savedEffect !== undefined) {
    log.debug('Permission resolved by saved rule', { server, tool, resource, savedEffect });
    return savedEffect;
  }

  // No saved rule matched — use configured result or default to 'ask'.
  const result = configuredEffect ?? 'ask';
  log.debug('Permission resolved by configured rule or default', { server, tool, resource, result });
  return result;
}

/**
 * Determine if a tool is wholly denied (i.e., every possible resource call
 * would be denied) based on the configured rules alone. This is used to drop
 * the tool from the advertised tool list before sending it to the model —
 * saving tokens and keeping the model context clean.
 *
 * A tool is considered wholly denied when the LAST matching rule for
 * `action=<toolName>, resource="*"` is `deny`. This is intentionally
 * conservative: a tool that is denied for some resources but not others is
 * NOT dropped (it might still be callable for the allowed resources).
 */
export function isWhollyDenied(permissionRules: PermissionRule[], tool: string): boolean {
  const effect = evaluateRuleList(permissionRules, tool, '*');
  return effect === 'deny';
}
