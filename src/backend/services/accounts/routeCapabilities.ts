import type { RouteKind, WorkspaceAction } from '@/shared/types/accounts';
import { workspaceActionForMethod } from './access';

/**
 * The kind of every HTTP route (#573), so multi-user mode (#574) knows what to
 * check before a handler runs. The kinds are explained at `ROUTE_KINDS` in
 * `src/shared/types/accounts.ts`:
 *
 * - `workspace`: needs access to the selected workspace.
 * - `host`: needs host access (it runs programs or touches server folders).
 * - `admin`: admins only.
 * - `account`: the signed-in person themself.
 * - `protocol`: another program with its own proof; the route checks it.
 *
 * Keys are the folder paths of `src/app/**\/route.ts`, with `[param]` segments.
 * `__tests__/accounts/routeCapabilities.test.ts` fails when a route is missing
 * here or listed here but gone. Adding a route means adding one line.
 *
 * Starting a program on the server is also checked where it starts, not only by
 * route: a local (stdio) MCP server outside a container and the command-line
 * model adapters (Claude Code, Codex, Antigravity) need host access wherever
 * they are started from (#574, step 574-4).
 */
export const ROUTE_CAPABILITIES = Object.freeze({
  '/api/accounts/mode': 'admin', // turns multi-user mode on (allowed to anyone while it is off) or off
  '/api/accounts/session': 'account', // sign in and sign out with a name and password
  '/api/accounts/tokens': 'account', // the signed-in person's own API tokens
  '/api/accounts/users': 'admin', // people and workspace owners
  '/api/approvals': 'workspace',
  '/api/approvals/[id]': 'workspace',
  '/api/automation-map': 'workspace',
  '/api/avatar/[voiceAction]': 'workspace',
  '/api/avatar/connections': 'workspace',
  '/api/avatar/local-speech': 'workspace',
  '/api/avatar/remote/[voiceAction]': 'workspace',
  '/api/avatar/remote/availability': 'workspace',
  '/api/avatar/voice': 'workspace',
  '/api/avatar/work-model': 'workspace',
  '/api/avatar/world': 'workspace',
  '/api/backup': 'workspace',
  '/api/browse': 'host', // lists folders on the server machine
  '/api/bugs/enhance': 'workspace',
  '/api/chat/attachments': 'workspace',
  '/api/cloud/instance': 'protocol', // local instance challenge
  '/api/credential-migration': 'workspace',
  '/api/credential-transfer': 'workspace',
  '/api/credential-transfer/restore': 'workspace',
  '/api/cwd': 'host', // shows server folders
  '/api/diagnostics/report': 'workspace',
  '/api/encryption/secure': 'workspace',
  '/api/env': 'workspace',
  '/api/factory-observatory': 'admin', // installation-wide FACTORY connection
  '/api/flow': 'workspace',
  '/api/flow/[id]': 'workspace',
  '/api/flow/[id]/convert-process-to-subflow': 'workspace',
  '/api/flow/[id]/models': 'workspace',
  '/api/flow/[id]/versions': 'workspace',
  '/api/flow/[id]/versions/[versionId]': 'workspace',
  '/api/flow/assist': 'workspace',
  '/api/flow/compile': 'workspace',
  '/api/flow/generate': 'workspace',
  '/api/flow/generate/visual': 'workspace',
  '/api/flow/generator': 'workspace',
  '/api/flow/improve': 'workspace',
  '/api/flow/model-agent': 'workspace',
  '/api/flow/prompt-renderer': 'workspace',
  '/api/flow/quick-chat': 'workspace',
  '/api/flow/repair': 'workspace',
  '/api/git': 'host', // runs git and build commands on the server
  '/api/harness': 'workspace',
  '/api/harness/[id]': 'workspace',
  '/api/harness/comparisons': 'workspace',
  '/api/harness/comparisons/[id]': 'workspace',
  '/api/harness/profiles': 'workspace',
  '/api/human-tasks': 'workspace',
  '/api/human-tasks/[requestId]': 'workspace',
  '/api/init': 'workspace',
  '/api/local-models/capability': 'workspace',
  '/api/local-models/pull': 'host', // downloads a model onto the server
  '/api/local-models/suggest': 'workspace',
  '/api/mcp-registry': 'workspace',
  '/api/mcp-registry/spotlight': 'workspace',
  '/api/mcp/app-consent': 'workspace',
  '/api/mcp/app-sandbox': 'workspace',
  '/api/mcp/assistant': 'workspace',
  '/api/mcp/cancel': 'workspace',
  '/api/mcp/flujo/authoring': 'workspace',
  '/api/mcp/flujo/automation': 'workspace',
  '/api/mcp/flujo/flows': 'workspace',
  '/api/mcp/flujo/resources': 'workspace',
  '/api/mcp/flujo/resources/read': 'workspace',
  '/api/mcp/flujo/servers': 'workspace',
  '/api/mcp/flujo/skills': 'workspace',
  '/api/mcp/flujo/state': 'workspace',
  '/api/mcp/flujo/tools': 'workspace',
  '/api/mcp/model-risk-assessment': 'workspace',
  '/api/mcp/oauth-capability': 'workspace',
  '/api/mcp/security-review': 'workspace',
  '/api/mcp/servers': 'workspace',
  '/api/mcp/servers/[name]': 'workspace',
  '/api/mcp/servers/[name]/events': 'workspace',
  '/api/mcp/servers/[name]/host-consent': 'host', // lets an MCP server run on the server outside a container
  '/api/mcp/servers/[name]/prompts': 'workspace',
  '/api/mcp/servers/[name]/prompts/get': 'workspace',
  '/api/mcp/servers/[name]/resources': 'workspace',
  '/api/mcp/servers/[name]/resources/read': 'workspace',
  '/api/mcp/servers/[name]/skills': 'workspace',
  '/api/mcp/servers/[name]/skills/approve': 'workspace',
  '/api/mcp/servers/[name]/skills/get': 'workspace',
  '/api/mcp/servers/[name]/skills/load': 'workspace',
  '/api/mcp/servers/[name]/status': 'workspace',
  '/api/mcp/servers/[name]/stdio-oauth/confirm': 'workspace',
  '/api/mcp/servers/[name]/stdio-oauth/start': 'workspace',
  '/api/mcp/servers/[name]/tools': 'workspace',
  '/api/mcp/servers/[name]/tools/[toolName]': 'workspace',
  '/api/mcp/servers/[name]/tools/[toolName]/stream': 'workspace',
  '/api/mcp/test-connection': 'workspace',
  '/api/mcp/test-connection/stream': 'workspace',
  '/api/model': 'workspace',
  '/api/model/[id]': 'workspace',
  '/api/model/allowance': 'workspace',
  '/api/model/provider': 'workspace',
  '/api/model/test': 'workspace',
  '/api/network-exposure': 'admin', // who may reach this installation
  '/api/oauth/callback': 'protocol', // OAuth state
  '/api/oauth/initiate': 'workspace',
  '/api/oauth/reset': 'workspace',
  '/api/operations/status': 'workspace',
  '/api/original-owner': 'host', // grants command and folder tools on the server
  '/api/owner/bootstrap': 'account', // first sign-in pairing
  '/api/owner/session': 'account', // sign in and sign out
  '/api/packages/build': 'workspace',
  '/api/packages/derive-secrets': 'workspace',
  '/api/packages/install': 'host', // clones and builds MCP servers on the server
  '/api/packages/install/status': 'workspace',
  '/api/packages/installed': 'workspace',
  '/api/packages/resolve': 'workspace',
  '/api/packages/scan-targets': 'workspace',
  '/api/packages/search': 'workspace',
  '/api/packages/uninstall': 'workspace',
  '/api/persona-recovery': 'workspace',
  '/api/planned-executions': 'workspace',
  '/api/planned-executions/[id]': 'workspace',
  '/api/planned-executions/[id]/run': 'workspace',
  '/api/planned-executions/[id]/runs': 'workspace',
  '/api/planned-executions/[id]/worker-recovery': 'protocol', // worker bearer
  '/api/planned-executions/preview-schedule': 'workspace',
  '/api/planned-executions/reconcile': 'workspace',
  '/api/projects': 'host', // git checkouts and worktrees in server folders
  '/api/reference-search/files': 'host', // searches server folders
  '/api/registry/auth': 'workspace',
  '/api/registry/auth/resend': 'workspace',
  '/api/registry/auth/reset': 'workspace',
  '/api/registry/feedback': 'workspace',
  '/api/registry/oauth/callback': 'protocol', // OAuth state
  '/api/registry/oauth/initiate': 'workspace',
  '/api/registry/packages': 'workspace',
  '/api/registry/publish': 'workspace',
  '/api/registry/settings': 'workspace',
  '/api/restore': 'workspace',
  '/api/runs/active': 'workspace',
  '/api/runtime-environment': 'admin', // launcher settings for the whole process
  '/api/setup/ai-cli': 'host', // installs AI command-line tools on the server
  '/api/snapshot/abort': 'protocol', // worker bearer
  '/api/snapshot/begin': 'protocol', // worker bearer
  '/api/snapshot/download': 'protocol', // worker bearer
  '/api/snapshot/finalize': 'protocol', // worker bearer
  '/api/snapshot/info': 'protocol', // worker bearer
  '/api/snapshot/status': 'protocol', // worker bearer
  '/api/snapshots': 'workspace',
  '/api/snapshots/cleanup': 'workspace',
  '/api/snapshots/open-folder': 'host', // opens a folder window on the server
  '/api/statistics': 'workspace',
  '/api/storage': 'workspace',
  '/api/telemetry/daily-active': 'admin', // installation-wide usage heartbeat
  '/api/tickets': 'workspace',
  '/api/tickets/[id]': 'workspace',
  '/api/transcription': 'workspace',
  '/api/update': 'admin', // updates the installation
  '/api/waves': 'workspace',
  '/api/webhooks/[id]': 'protocol', // webhook secret
  '/api/webhooks/mcp/[id]': 'protocol', // signed MCP event
  '/api/worker/status': 'protocol', // worker bearer
  '/api/workspaces': 'account', // the own workspace list; rename and delete check the named workspace
  '/mcp-flows': 'workspace',
  '/mcp-proxy/[server]': 'workspace',
  '/v1/chat/completions': 'workspace',
  '/v1/chat/conversation-chains': 'workspace',
  '/v1/chat/conversations': 'workspace',
  '/v1/chat/conversations/[conversationId]': 'workspace',
  '/v1/chat/conversations/[conversationId]/breakpoints': 'workspace',
  '/v1/chat/conversations/[conversationId]/cancel': 'workspace',
  '/v1/chat/conversations/[conversationId]/compact': 'workspace',
  '/v1/chat/conversations/[conversationId]/debug/attach': 'workspace',
  '/v1/chat/conversations/[conversationId]/debug/continue': 'workspace',
  '/v1/chat/conversations/[conversationId]/debug/state': 'workspace',
  '/v1/chat/conversations/[conversationId]/debug/step': 'workspace',
  '/v1/chat/conversations/[conversationId]/edit-state': 'workspace',
  '/v1/chat/conversations/[conversationId]/events': 'workspace',
  '/v1/chat/conversations/[conversationId]/inject': 'workspace',
  '/v1/chat/conversations/[conversationId]/model-turns': 'workspace',
  '/v1/chat/conversations/[conversationId]/model-turns/[dispatchId]': 'workspace',
  '/v1/chat/conversations/[conversationId]/model-turns/[dispatchId]/media/[mediaId]': 'workspace',
  '/v1/chat/conversations/[conversationId]/recovery': 'workspace',
  '/v1/chat/conversations/[conversationId]/resources': 'workspace',
  '/v1/chat/conversations/[conversationId]/resources/[resourceId]/content': 'workspace',
  '/v1/chat/conversations/[conversationId]/respond': 'workspace',
  '/v1/chat/conversations/[conversationId]/revert': 'workspace',
  '/v1/chat/conversations/[conversationId]/wire-preview': 'workspace',
  '/v1/chat/events': 'workspace',
  '/v1/flows/[flowRef]/readiness': 'workspace',
  '/v1/meetings': 'workspace',
  '/v1/meetings/[meetingId]': 'workspace',
  '/v1/meetings/[meetingId]/cancel': 'workspace',
  '/v1/meetings/[meetingId]/events': 'workspace',
  '/v1/meetings/[meetingId]/interventions': 'workspace',
  '/v1/meetings/[meetingId]/private-notes': 'workspace',
  '/v1/meetings/[meetingId]/resume': 'workspace',
  '/v1/meetings/[meetingId]/start': 'workspace',
  '/v1/models': 'workspace',
  '/v1/persona-drafts': 'workspace',
  '/v1/persona-drafts/[draftId]': 'workspace',
  '/v1/personas': 'workspace',
  '/v1/personas/[personaId]': 'workspace',
  '/v1/personas/[personaId]/app-grants': 'workspace',
  '/v1/personas/[personaId]/app-grants/[grantId]': 'workspace',
  '/v1/personas/[personaId]/app-grants/[grantId]/launch': 'workspace',
  '/v1/personas/[personaId]/behaviors/[behaviorId]/activate': 'workspace',
  '/v1/personas/[personaId]/composition': 'workspace',
  '/v1/personas/[personaId]/composition/behaviors': 'workspace',
  '/v1/personas/[personaId]/composition/copy': 'workspace',
  '/v1/personas/[personaId]/core/reconcile': 'workspace',
  '/v1/personas/[personaId]/deletion-preview': 'workspace',
  '/v1/personas/[personaId]/execution-preview': 'workspace',
  '/v1/personas/[personaId]/export': 'workspace',
  '/v1/personas/[personaId]/export-preview': 'workspace',
  '/v1/personas/[personaId]/goal-admissions/[admissionKey]': 'workspace',
  '/v1/personas/[personaId]/improvements': 'workspace',
  '/v1/personas/[personaId]/improvements/[proposalId]/apply': 'workspace',
  '/v1/personas/[personaId]/improvements/[proposalId]/promote': 'workspace',
  '/v1/personas/[personaId]/improvements/[proposalId]/reject': 'workspace',
  '/v1/personas/[personaId]/improvements/[proposalId]/undo': 'workspace',
  '/v1/personas/[personaId]/memories': 'workspace',
  '/v1/personas/[personaId]/memories/[memoryId]': 'workspace',
  '/v1/personas/[personaId]/memories/[memoryId]/activate': 'workspace',
  '/v1/personas/[personaId]/memories/[memoryId]/correct': 'workspace',
  '/v1/personas/[personaId]/memories/[memoryId]/pin': 'workspace',
  '/v1/personas/[personaId]/memories/[memoryId]/resolve-conflict': 'workspace',
  '/v1/personas/[personaId]/runtime-recovery': 'workspace',
  '/v1/personas/[personaId]/storage-stats': 'workspace',
  '/v1/personas/[personaId]/work-items': 'workspace',
  '/v1/personas/[personaId]/work-items/[workItemId]': 'workspace',
  '/v1/personas/[personaId]/work-items/[workItemId]/assign': 'workspace',
  '/v1/personas/[personaId]/work-items/[workItemId]/control': 'workspace',
  '/v1/personas/[personaId]/work-items/[workItemId]/runtime': 'workspace',
  '/v1/personas/[personaId]/work-items/[workItemId]/source': 'workspace',
  '/v1/personas/[personaId]/work-items/promote-todo': 'workspace',
  '/v1/personas/readiness': 'workspace',
  '/v1/personas/settings-options': 'workspace',
  '/v1/personas/summary': 'workspace',
  '/v1/roles': 'workspace',
  '/v1/roles/[roleId]': 'workspace',
  '/v1/roles/[roleId]/duplicate': 'workspace',
  '/v1/roles/[roleId]/impact': 'workspace',
  '/v1/roles/[roleId]/restore': 'workspace',
  '/v1/roles/[roleId]/rollback': 'workspace',
  '/v1/roles/[roleId]/versions': 'workspace',
  '/v1/tasks/[taskId]': 'workspace',
} as const satisfies Record<string, RouteKind>);

export type RoutePattern = keyof typeof ROUTE_CAPABILITIES;

/** Account routes that must work while signed out, because they are how one signs in. */
export const SIGNED_OUT_ROUTES: ReadonlySet<RoutePattern> = new Set<RoutePattern>([
  '/api/accounts/session',
  '/api/owner/bootstrap',
  '/api/owner/session',
]);

/**
 * Workspace routes that manage the workspace as a whole: whole-workspace backup
 * and restore, and moving its keys. Every method except GET/HEAD/OPTIONS needs
 * the workspace `admin` action (personal owner, team owner or admin), not just
 * `edit`.
 */
export const WORKSPACE_ADMIN_ROUTES: ReadonlySet<RoutePattern> = new Set<RoutePattern>([
  '/api/backup',
  '/api/credential-migration',
  '/api/credential-transfer',
  '/api/credential-transfer/restore',
  '/api/restore',
]);

/**
 * Workspace `admin` steps that a route can only tell apart from its body or
 * query. The route handler asks `decideWorkspaceAccess(..., 'admin', ...)`
 * before doing them (#574). Everything else in these routes keeps its normal
 * action, so team members can still unlock, check status and save secrets.
 */
export const WORKSPACE_ADMIN_STEPS: ReadonlyArray<{ readonly route: RoutePattern; readonly step: string }> = Object.freeze([
  { route: '/api/encryption/secure', step: 'POST with action initialize, initialize_default or change_password (sets the workspace password)' },
  { route: '/api/env', step: 'GET with includeSecrets=true (shows stored secrets in plain text)' },
  { route: '/api/workspaces', step: 'PATCH and DELETE (rename or delete the named workspace)' },
]);

export interface RouteCapability {
  readonly pattern: RoutePattern;
  readonly kind: RouteKind;
  /** What the request does to the selected workspace (only meaningful for `workspace` and `host`). */
  readonly workspaceAction: WorkspaceAction;
  readonly signedOutAllowed: boolean;
}

interface CompiledPattern {
  readonly pattern: RoutePattern;
  readonly segments: readonly string[];
}

const DYNAMIC_SEGMENT = /^\[[A-Za-z][A-Za-z0-9]*\]$/;

const COMPILED: readonly CompiledPattern[] = (Object.keys(ROUTE_CAPABILITIES) as RoutePattern[])
  .map(pattern => ({ pattern, segments: pattern.split('/').slice(1) }));

function matches(candidate: CompiledPattern, segments: readonly string[]): boolean {
  return candidate.segments.length === segments.length
    && candidate.segments.every((segment, index) => DYNAMIC_SEGMENT.test(segment) || segment === segments[index]);
}

/** Like Next.js: at the first segment where two patterns differ, a fixed name beats a `[param]`. */
function moreSpecific(first: CompiledPattern, second: CompiledPattern): CompiledPattern {
  for (let index = 0; index < first.segments.length; index++) {
    const a = DYNAMIC_SEGMENT.test(first.segments[index]);
    const b = DYNAMIC_SEGMENT.test(second.segments[index]);
    if (a !== b) return a ? second : first;
  }
  return first;
}

/** The route pattern a request path belongs to, or `undefined` when no route matches. */
export function routePatternFor(pathname: string): RoutePattern | undefined {
  const trimmed = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  const segments = trimmed.split('/').slice(1);
  if (segments.some(segment => segment === '')) return undefined;
  let best: CompiledPattern | undefined;
  for (const candidate of COMPILED) {
    if (matches(candidate, segments)) best = best ? moreSpecific(best, candidate) : candidate;
  }
  return best?.pattern;
}

/**
 * What a request needs. `undefined` for a path with no route: callers treat it
 * as `admin` (see `decideRouteAccess`), so a route added without a line here is
 * closed to non-admins rather than open to everyone.
 */
export function routeCapabilityFor(pathname: string, method: string): RouteCapability | undefined {
  const pattern = routePatternFor(pathname);
  if (!pattern) return undefined;
  const reads = workspaceActionForMethod(method) === 'read';
  return Object.freeze({
    pattern,
    kind: ROUTE_CAPABILITIES[pattern],
    workspaceAction: !reads && WORKSPACE_ADMIN_ROUTES.has(pattern) ? 'admin' : workspaceActionForMethod(method),
    signedOutAllowed: SIGNED_OUT_ROUTES.has(pattern),
  });
}
