import { withWorkspaceRoute } from '@/app/api/_workspace';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { json } from '@/app/api/mcp/_helpers';

/** Return the current MCP tool schemas. Tool execution is split across domain routes. */
async function GET_handler(_request: Request) {
  const lock = await assertUnlocked();
  if (lock) return lock;

  const { internalToolDefinitions } = await import('@/backend/services/mcp/internalTools');
  return json({ tools: internalToolDefinitions() }, 200);
}

const GET_workspaceRoute = withWorkspaceRoute(GET_handler);
export function GET(): ReturnType<typeof GET_workspaceRoute>;
export function GET(request: Request): ReturnType<typeof GET_workspaceRoute>;
export function GET(request: Request = new Request('http://localhost/')) {
  return GET_workspaceRoute(request);
}
