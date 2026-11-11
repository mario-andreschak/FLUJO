import { withWorkspaceRoute } from '@/app/api/_workspace';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { NextRequest } from 'next/server';
import { createLogger } from '@/utils/logger';
import { mcpService } from '@/backend/services/mcp';
import { formatErrorResponse } from '@/utils/mcp/utils';
import { json } from '../../../_helpers';

const log = createLogger('app/api/mcp/servers/[name]/events/route');

/**
 * GET /api/mcp/servers/{name}/events
 * The events a server can report. `{ supported: false, events: [] }` for a server
 * without the capability.
 */
async function GET_handler(_request: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  const locked = await assertUnlocked();
  if (locked) return locked;
  try {
    const { name } = await params;
    return json(await mcpService.listServerEvents(name), 200);
  } catch (error) {
    log.error('Error handling GET request', error);
    return json({ supported: false, events: [], ...formatErrorResponse(error) }, 500);
  }
}

export const GET = withWorkspaceRoute(GET_handler);
