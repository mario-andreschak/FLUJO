import {
  InvalidWorkspaceNameError,
  ensureWorkspaceDirs,
  normalizeWorkspaceName,
  runWithWorkspace,
  workspaceExists,
} from '@/utils/workspace';
import { createLogger } from '@/utils/logger';
import { waitForWorkspaceLayoutReady } from '@/backend/services/workspace/layoutReadiness';

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
  try {
    // Do not let a request observe the legacy root while startup is still
    // migrating it. Concurrent callers share the migration's in-flight promise.
    await waitForWorkspaceLayoutReady();
  } catch (error) {
    log.error('Workspace layout is not ready; refusing workspace request', error);
    throw new WorkspaceRequestError(
      'Workspace storage is temporarily unavailable while its layout is being prepared.',
      503,
    );
  }
  if (!(await workspaceExists(workspace))) {
    throw new WorkspaceRequestError(`Unknown workspace: ${workspace}`, 404);
  }
  return workspace;
}

function errorResponse(error: WorkspaceRequestError): Response {
  return new Response(JSON.stringify({ error: error.message }), {
    status: error.status,
    headers: {
      'Content-Type': 'application/json',
      ...(error.status === 503 ? { 'Retry-After': '5' } : {}),
    },
  });
}

/**
 * Run `handler` with the request's workspace selected.
 *
 * Storage is revalidated on every selection so a replaced symlink/junction can
 * never turn into a cross-workspace read. Background services are initialized
 * for every discovered workspace by the process startup sweep; keeping that
 * heavyweight graph out of this wrapper is important because every route
 * imports it.
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
    // Filesystem validation is an isolation boundary, not optional service
    // startup. Re-check every selected workspace, including the default: the
    // process-lifetime migration memo cannot detect a subtree replaced with a
    // symlink/junction after startup.
    try {
      await ensureWorkspaceDirs(workspace);
    } catch (error) {
      log.error(`Workspace ${workspace} has an unsafe or unavailable storage layout`, error);
      return errorResponse(new WorkspaceRequestError(
        `Workspace storage is unavailable: ${workspace}`,
        503,
      ));
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
  return (async (request: Request | undefined, ...rest: unknown[]) => {
    // A number of route unit tests (and a few internal callers) invoke handlers
    // such as GET()/PUT() with no argument. Normalize before workspace parsing
    // so compatibility calls cannot crash at request.headers.
    const normalizedRequest = request instanceof Request
      ? request
      : new Request('http://localhost/');
    // Preserve lightweight request stubs used by route unit tests (for example
    // `{ json: async () => body }`) for the handler itself. Only workspace
    // parsing needs the normalized Fetch Request.
    const handlerRequest = request ?? normalizedRequest;
    return withWorkspace(normalizedRequest, () =>
      Promise.resolve(
        (handler as unknown as (...a: unknown[]) => Promise<Response>)(handlerRequest, ...rest),
      ));
  }) as unknown as H;
}
