import type { OwnerScope } from '../../../shared/types/access';

/**
 * The only routes a narrow credential can reach. Everything else, including any
 * route added later, keeps the conservative administration requirement. So a new
 * route is closed to every role until someone adds it here on purpose.
 *
 * `row` says who decides about the row itself:
 *   none          the route has no per-person data
 *   conversation  the path names a conversation; the workspace wrapper checks it
 *   approval      the path names an approval; the workspace wrapper checks it
 *   filtered      the handler narrows its own result to what the caller may see
 *
 * `__tests__/security/namedAccessRoutes.test.ts` walks every route file, so an
 * entry cannot point at nothing and a checked row cannot sit outside the wrapper.
 */
export type AccessRowRule = 'none' | 'conversation' | 'approval' | 'filtered';

export interface AccessRouteRule {
  readonly method: string;
  readonly template: string;
  readonly anyOf: readonly OwnerScope[];
  readonly row: AccessRowRule;
}

/** Everyone with a named credential may ask who they are and which workspaces exist. */
const ANY_NAMED: readonly OwnerScope[] = [
  'session:login', 'health:read', 'update:manage', 'flows:read', 'flows:write', 'models:read', 'runs:read', 'runs:all',
  'runs:manage', 'approvals:respond', 'access:manage', 'audit:read', 'openai:read', 'openai:execute',
];
const CONVERSATION = '/v1/chat/conversations/[conversationId]';

export const ACCESS_ROUTE_TABLE: readonly AccessRouteRule[] = [
  // Who am I, and signing in as a named person.
  { method: 'GET', template: '/api/owner/me', anyOf: ANY_NAMED, row: 'none' },
  { method: 'GET', template: '/api/owner/session', anyOf: ANY_NAMED, row: 'none' },
  { method: 'POST', template: '/api/owner/session', anyOf: ['session:login'], row: 'none' },
  { method: 'GET', template: '/api/workspaces', anyOf: ANY_NAMED, row: 'filtered' },

  // Managing people and reading the record of who did what.
  { method: 'GET', template: '/api/owner/access', anyOf: ['access:manage', 'audit:read'], row: 'none' },
  { method: 'GET', template: '/api/owner/people', anyOf: ['access:manage'], row: 'none' },
  { method: 'POST', template: '/api/owner/people', anyOf: ['access:manage'], row: 'none' },
  { method: 'PATCH', template: '/api/owner/people/[id]', anyOf: ['access:manage'], row: 'none' },
  { method: 'DELETE', template: '/api/owner/people/[id]', anyOf: ['access:manage'], row: 'none' },
  { method: 'GET', template: '/api/owner/audit', anyOf: ['audit:read'], row: 'none' },

  // Health and updates for a central operator.
  { method: 'GET', template: '/api/operations/status', anyOf: ['health:read'], row: 'none' },
  { method: 'GET', template: '/api/update', anyOf: ['health:read', 'update:manage'], row: 'none' },
  { method: 'POST', template: '/api/update', anyOf: ['update:manage'], row: 'none' },

  // Reading and editing flow definitions. Models are masked; MCP servers are reduced to names.
  { method: 'GET', template: '/api/flow', anyOf: ['flows:read'], row: 'none' },
  { method: 'GET', template: '/api/flow/[id]', anyOf: ['flows:read'], row: 'none' },
  { method: 'GET', template: '/api/flow/[id]/models', anyOf: ['flows:read'], row: 'none' },
  { method: 'GET', template: '/api/flow/[id]/versions', anyOf: ['flows:read'], row: 'none' },
  { method: 'GET', template: '/api/flow/[id]/versions/[versionId]', anyOf: ['flows:read'], row: 'none' },
  { method: 'GET', template: '/v1/flows/[flowRef]/readiness', anyOf: ['flows:read'], row: 'none' },
  { method: 'POST', template: '/api/flow', anyOf: ['flows:write'], row: 'none' },
  { method: 'PUT', template: '/api/flow/[id]', anyOf: ['flows:write'], row: 'none' },
  { method: 'DELETE', template: '/api/flow/[id]', anyOf: ['flows:write'], row: 'none' },
  { method: 'GET', template: '/api/model', anyOf: ['models:read'], row: 'none' },
  { method: 'GET', template: '/api/mcp/servers', anyOf: ['flows:read'], row: 'filtered' },

  // Conversations and runs. Each row belongs to the person who started it.
  { method: 'GET', template: '/v1/chat/conversations', anyOf: ['runs:read'], row: 'filtered' },
  { method: 'POST', template: '/v1/chat/conversations', anyOf: ['openai:execute'], row: 'filtered' },
  { method: 'GET', template: CONVERSATION, anyOf: ['runs:read'], row: 'conversation' },
  { method: 'PATCH', template: CONVERSATION, anyOf: ['runs:manage'], row: 'conversation' },
  { method: 'DELETE', template: CONVERSATION, anyOf: ['runs:manage'], row: 'conversation' },
  { method: 'GET', template: `${CONVERSATION}/events`, anyOf: ['runs:read'], row: 'conversation' },
  { method: 'GET', template: `${CONVERSATION}/resources`, anyOf: ['runs:read'], row: 'conversation' },
  { method: 'GET', template: `${CONVERSATION}/resources/[resourceId]/content`, anyOf: ['runs:read'], row: 'conversation' },
  { method: 'POST', template: `${CONVERSATION}/cancel`, anyOf: ['runs:manage'], row: 'conversation' },
  { method: 'POST', template: `${CONVERSATION}/respond`, anyOf: ['approvals:respond'], row: 'conversation' },
  { method: 'GET', template: '/api/runs/active', anyOf: ['runs:read'], row: 'filtered' },
  { method: 'GET', template: '/api/approvals', anyOf: ['approvals:respond', 'runs:read'], row: 'filtered' },
  { method: 'POST', template: '/api/approvals/[id]', anyOf: ['approvals:respond'], row: 'approval' },
];

const COMPILED = ACCESS_ROUTE_TABLE.map(rule => ({
  rule,
  pattern: new RegExp(`^${rule.template.replace(/\[[^\]]+\]/g, '([^/]+)')}$`),
}));

function normalizePath(pathname: string): string {
  return pathname.length > 1 ? pathname.replace(/\/$/, '') : pathname;
}

/** Exact method and exact path, or nothing. A near miss falls back to administration. */
export function classifyAccessRoute(method: string, pathname: string): AccessRouteRule | null {
  const normalized = normalizePath(pathname);
  return COMPILED.find(({ rule, pattern }) => rule.method === method && pattern.test(normalized))?.rule ?? null;
}

/** The first path parameter of a matched rule, decoded. Malformed encoding means no match. */
export function accessRouteParameter(rule: AccessRouteRule, pathname: string): string | null {
  const compiled = COMPILED.find(entry => entry.rule === rule);
  const raw = compiled?.pattern.exec(normalizePath(pathname))?.[1];
  if (raw === undefined) return null;
  try { return decodeURIComponent(raw); } catch { return null; }
}
