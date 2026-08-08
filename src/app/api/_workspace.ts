import {
  DEFAULT_WORKSPACE,
  InvalidWorkspaceNameError,
  normalizeWorkspaceName,
  runWithWorkspace,
  workspaceExists,
} from '@/utils/workspace';
import { createLogger } from '@/utils/logger';

const log = createLogger('app/api/_workspace');

/**
 * The single place the HTTP layer turns a request into a workspace (#406).
 *
 * Every workspace-sensitive route funnels through `withWorkspaceRoute`, so the
 * parse/default/validate rules exist exactly once instead of being re-derived
 * (and inconsistently mis-derived) per route. The contract is:
 *
 *   - no `workspace` at all  -> `default-workspace`, i.e. every pre-#406 client
 *                               keeps working unchanged against migrated data
 *   - syntactically invalid  -> 400, because the caller sent garbage
 *   - valid but nonexistent  -> 404, because workspaces are discovered from
 *                               disk and are never created implicitly by a
 *                               stateful request
 *
 * The selection is carried by AsyncLocalStorage for the duration of the handler,
 * so services called deeper in the stack resolve their own paths from it rather
 * than each route hand-concatenating workspace paths.
 */

/** Query parameter name. */
export const WORKSPACE_QUERY_PARAM = 'workspace';
/**
 * Header alternative. Useful for requests whose URL is awkward to rewrite (form
 * posts, EventSource-style clients, proxied calls); the query parameter always
 * wins when both are present.
 */
export const WORKSPACE_HEADER = 'x-flujo-workspace';

export class WorkspaceRequestError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'WorkspaceRequestError';
    this.status = status;
  }
}

/**
 * Read and validate the requested workspace. Throws {@link WorkspaceRequestError}
 * with status 400 for a syntactically invalid name. Does NOT check existence —
 * see {@link resolveWorkspace}.
 */
export function parseWorkspaceParam(request: Request): string {
  let raw: string | null = null;
  try {
    raw = new URL(request.url).searchParams.get(WORKSPACE_QUERY_PARAM);
  } catch {
    // A relative/opaque URL (only really possible in tests) simply means "no
    // query parameter"; fall through to the header.
  }
  if (raw === null) raw = request.headers?.get?.(WORKSPACE_HEADER) ?? null;

  try {
    return normalizeWorkspaceName(raw);
  } catch (error) {
    if (error instanceof InvalidWorkspaceNameError) {
      throw new WorkspaceRequestError(
        `Invalid workspace name. Workspace names must match /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.`,
        400,
      );
    }
    throw error;
  }
}

/**
 * Parse, validate and confirm the workspace exists. 400 for a malformed name,
 * 404 for a well-formed name that has no directory on disk — a request must
 * never bring a workspace into existence as a side effect.
 */
export async function resolveWorkspace(request: Request): Promise<string> {
  const workspace = parseWorkspaceParam(request);
  if (!(await workspaceExists(workspace))) {
    throw new WorkspaceRequestError(`Unknown workspace: ${workspace}`, 404);
  }
  return workspace;
}

function errorResponse(error: WorkspaceRequestError): Response {
  return new Response(JSON.stringify({ error: error.message }), {
    status: error.status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Run `handler` with the request's workspace selected.
 *
 * A non-default workspace is initialized on first use (MCP servers connected,
 * triggers armed) so selecting a workspace behaves like a freshly started FLUJO
 * for that namespace, without a restart. Initialization failures are logged and
 * do not fail the request: the same failure mode as process startup, where a
 * broken MCP server never blocks the UI.
 */
export async function withWorkspace<T>(
  request: Request,
  handler: (workspace: string) => Promise<T>,
): Promise<T | Response> {
  let workspace: string;
  try {
    workspace = await resolveWorkspace(request);
  } catch (error) {
    if (error instanceof WorkspaceRequestError) return errorResponse(error);
    throw error;
  }

  return runWithWorkspace(workspace, async () => {
    if (workspace !== DEFAULT_WORKSPACE) {
      try {
        // Imported lazily: backend/init pulls in the MCP service and scheduler,
        // which must not be dragged into every route's module graph eagerly.
        const { ensureWorkspaceInitialized } = await import('@/backend/init');
        await ensureWorkspaceInitialized(workspace);
      } catch (error) {
        log.warn(`Deferred initialization of workspace ${workspace} failed`, error);
      }
    }
    return handler(workspace);
  });
}

/**
 * Wrap a Next.js route handler so it runs inside the requested workspace.
 *
 *   const GET_handler = async (request: NextRequest) => { ... };
 *   export const GET = withWorkspaceRoute(GET_handler);
 *
 * The handler itself is unchanged and keeps resolving paths through the ordinary
 * workspace-aware services.
 */
export function withWorkspaceRoute<
  H extends (request: never, ...rest: never[]) => Promise<Response> | Response,
>(handler: H): H {
  return (async (request: Request, ...rest: unknown[]) =>
    withWorkspace(request, () =>
      Promise.resolve((handler as unknown as (...a: unknown[]) => Promise<Response>)(request, ...rest)),
    )) as unknown as H;
}
