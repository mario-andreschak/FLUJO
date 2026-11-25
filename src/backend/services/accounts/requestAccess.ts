import {
  WORKSPACE_NAME_PATTERN, type AccountPrincipal, type AccountUser, type AccountsFile,
} from '@/shared/types/accounts';
import { createLogger } from '@/utils/logger';
import { requiredOwnerScopes } from '@/backend/services/security/ownerAccess';
import { isWorkerMode } from '@/backend/services/workspace/workerMode';
import { activeUser, decideRouteAccess, type AccessDenial } from './access';
import { routeCapabilityFor } from './routeCapabilities';
import { AccountsDamagedError, loadAccountsState } from './store';
import { resolveSessionPrincipal } from './sessions';
import { hasBearerToken, resolveTokenPrincipal } from './tokens';

const log = createLogger('backend/services/accounts/requestAccess');

/**
 * The multi-user check for one HTTP request (#574). Both `src/proxy.ts` (every
 * `/api`, `/v1` and MCP request) and `withWorkspaceRoute` (before a handler
 * selects storage) ask it, so a route that skips one still meets the other.
 *
 * With multi-user mode off it answers `off` after one `stat` and the caller
 * keeps today's behaviour exactly. With the mode on, the person comes only
 * from the session cookie or an `Authorization: Bearer` API token; the
 * workspace named by the browser (query or `x-flujo-workspace` header) only
 * selects, and the access rules in `access.ts` decide. Another person's
 * workspace answers exactly like a workspace that does not exist.
 */

export type AccountGate =
  | { readonly kind: 'off' }
  | {
    readonly kind: 'allowed';
    readonly accounts: AccountsFile;
    /** `null` only for sign-in routes called while signed out, and for protocol routes. */
    readonly principal: AccountPrincipal | null;
    readonly user: AccountUser | null;
  }
  | { readonly kind: 'denied'; readonly response: Response };

const DEFAULT_WORKSPACE = 'default-workspace';

/** The workspace a request selects, read the same way as `parseWorkspaceParam` in `src/app/api/_workspace.ts`. */
export function selectedWorkspace(request: Request): string {
  let raw: string | null = null;
  try { raw = new URL(request.url).searchParams.get('workspace'); } catch { /* relative test URL */ }
  if (raw === null) raw = request.headers.get('x-flujo-workspace');
  return raw === null || raw === '' ? DEFAULT_WORKSPACE : raw;
}

function json(body: Record<string, unknown>, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });
}

const DENIAL_MESSAGES: Readonly<Record<Exclude<AccessDenial, 'not-found'>, { error: string; code: string }>> = {
  'sign-in-required': { error: 'Sign in to continue.', code: 'ACCOUNT_SIGN_IN_REQUIRED' },
  'workspace-admin-required': { error: 'Only the owner of this workspace or an admin can do this.', code: 'WORKSPACE_ADMIN_REQUIRED' },
  'view-only': {
    error: 'You can look at this team workspace but not change or run anything in it. Ask a team owner to make you a member.',
    code: 'TEAM_VIEW_ONLY',
  },
  'host-access-required': {
    error: 'This runs programs or reads folders on the server computer. Only admins, or people an admin trusted with host access, can do it.',
    code: 'HOST_ACCESS_REQUIRED',
  },
  'admin-required': { error: 'Only an admin can change this.', code: 'ADMIN_REQUIRED' },
  'token-scope-missing': { error: 'This API token is not allowed to do this.', code: 'TOKEN_SCOPE_MISSING' },
  'owner-inactive': { error: 'The owner of this workspace is not active.', code: 'OWNER_INACTIVE' },
  'starter-lost-access': { error: 'The person who set this up no longer has access.', code: 'STARTER_LOST_ACCESS' },
};

/** Exactly what `withWorkspace` answers for a workspace that does not exist, so guessing reveals nothing. */
export function unknownWorkspaceResponse(workspace: string): Response {
  return new Response(JSON.stringify({ error: `Unknown workspace: ${workspace}` }), {
    status: 404, headers: { 'Content-Type': 'application/json' },
  });
}

export function denialResponse(denial: AccessDenial, workspace: string): Response {
  if (denial === 'not-found') return unknownWorkspaceResponse(workspace);
  const message = DENIAL_MESSAGES[denial];
  const status = denial === 'sign-in-required' ? 401 : 403;
  return json(message, status, status === 401 ? { 'WWW-Authenticate': 'Bearer' } : {});
}

export function accountsDamagedResponse(): Response {
  return json({
    error: 'Sign-in is unavailable because the accounts file is damaged. An admin can restore accounts.json or run "node bin/flujo.mjs users off" on the server.',
    code: 'ACCOUNTS_DAMAGED',
  }, 503, { 'Retry-After': '30' });
}

/** The person behind the request (API token first, then the session cookie), or `null`. Never a claim from the request body or query. */
export async function resolveRequestPrincipal(request: Request, accounts: AccountsFile, now: number): Promise<AccountPrincipal | null> {
  if (hasBearerToken(request)) return resolveTokenPrincipal(request, accounts, now);
  return resolveSessionPrincipal(request, now);
}

export interface AccountRequestUser {
  readonly accounts: AccountsFile;
  readonly principal: AccountPrincipal | null;
  /** The active person behind the request, or `null` when signed out or no longer valid. */
  readonly user: AccountUser | null;
}

/**
 * For the account routes themselves: the accounts file and the person behind
 * the request, or `null` while multi-user mode is off. Throws for a damaged file.
 */
export async function accountRequestUser(request: Request, now = Date.now()): Promise<AccountRequestUser | null> {
  const state = await loadAccountsState();
  if (state.mode === 'damaged') throw new AccountsDamagedError();
  if (state.mode === 'off') return null;
  const principal = await resolveRequestPrincipal(request, state.accounts, now);
  const user = activeUser(state.accounts, principal, now);
  return { accounts: state.accounts, principal: user ? principal : null, user };
}

let ownerPolicyNoticeShown = false;

function noticeOwnerPolicyIgnored(): void {
  if (ownerPolicyNoticeShown || process.env.FLUJO_OWNER_AUTH_FILE === undefined) return;
  ownerPolicyNoticeShown = true;
  log.info('Multi-user mode is on: people sign in with their own accounts and the owner policy (FLUJO_OWNER_AUTH_FILE) is not used.');
}

/** Decide one request. See {@link AccountGate}. */
export async function gateAccountRequest(request: Request, now = Date.now()): Promise<AccountGate> {
  if (isWorkerMode()) return { kind: 'off' };
  const state = await loadAccountsState();
  if (state.mode === 'off') return { kind: 'off' };
  if (state.mode === 'damaged') return { kind: 'denied', response: accountsDamagedResponse() };
  noticeOwnerPolicyIgnored();
  const accounts = state.accounts;
  let pathname = '/';
  try { pathname = new URL(request.url).pathname; } catch { /* relative test URL */ }
  const route = routeCapabilityFor(pathname, request.method);
  const workspace = selectedWorkspace(request);
  const principal = await resolveRequestPrincipal(request, accounts, now);
  const decision = decideRouteAccess(accounts, principal, {
    kind: route?.kind,
    workspace: route?.kind === 'workspace' || route?.kind === 'host'
      ? (WORKSPACE_NAME_PATTERN.test(workspace) ? workspace : `invalid:${workspace}`)
      : null,
    workspaceAction: route?.workspaceAction ?? 'admin',
    signedOutAllowed: route?.signedOutAllowed ?? false,
    requiredScopes: principal?.kind === 'api-token' ? requiredOwnerScopes(request) : [],
  }, now);
  if (!decision.allowed) return { kind: 'denied', response: denialResponse(decision.denial, workspace) };
  const user = activeUser(accounts, principal, now);
  return { kind: 'allowed', accounts, principal: user ? principal : null, user };
}
