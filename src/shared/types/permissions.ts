/**
 * Tool permission ruleset (issue #246).
 *
 * Provides a declarative allow/deny/ask policy for MCP tool calls, inspired by
 * opencode's permission.ts. Rules are evaluated last-match-wins on each tool
 * invocation; deny rules in the configured set always beat saved "always" rules
 * (a user "always allow" cannot bypass a flow-level deny).
 */

/** The resolved outcome for a single tool call evaluation. */
export type PermissionEffect = 'allow' | 'deny' | 'ask';

/**
 * A single rule in the permission ruleset.
 * Both `action` and `resource` support wildcard `*` matching (whole segment
 * only, not substring). Evaluation is last-match-wins across the full list.
 *
 * `action`   — the MCP tool's ORIGINAL name as advertised by the server
 *              (NOT the namespaced `mcp_<slug>_<hash>` form). Use `*` to
 *              match every tool on the server. Examples: "read_file", "bash",
 *              "write_file", "*".
 * `resource` — the primary resource the call targets: a file path, URI, or
 *              the command string for shell tools. Extracted from the first
 *              likely-resource argument in the call's args. Use `*` to match
 *              any resource. Examples: "/tmp/*", "*.ts", "*".
 * `effect`   — what to do when this rule matches:
 *                'allow' → execute without asking.
 *                'deny'  → refuse with a "Permission denied" synthetic result.
 *                'ask'   → pause and prompt the user (same as requireApproval).
 */
export interface PermissionRule {
  action: string;
  resource: string;
  effect: PermissionEffect;
}

/**
 * A saved "always" rule — a PermissionRule the user created by clicking
 * "Always Allow" or "Always Deny" during an approval prompt. Saved rules are
 * scoped to the conversation and stored in SharedState.savedPermissionRules.
 * They can be overridden by a flow-level deny rule (deny beats saved allows).
 */
export interface SavedPermissionRule extends PermissionRule {
  /** Epoch ms when the user clicked "Always". */
  savedAt: number;
  /** The decoded MCP server name this rule was saved for. */
  server: string;
  /** The decoded MCP tool name this rule was saved for. */
  tool: string;
}
