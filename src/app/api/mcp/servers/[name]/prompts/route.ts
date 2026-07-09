import { assertUnlocked } from '@/utils/encryption/lockGate';
import { NextRequest } from 'next/server';
import { createLogger } from '@/utils/logger';
import { mcpService } from '@/backend/services/mcp';
import { formatErrorResponse } from '@/utils/mcp/utils';
import { json } from '../../../_helpers';

const log = createLogger('app/api/mcp/servers/[name]/prompts/route');

type RouteContext = { params: Promise<{ name: string }> };

/**
 * GET /api/mcp/servers/{name}/prompts
 * List the prompt templates a connected MCP server publishes.
 *
 * Responds 200 with `{ prompts, error? }`, matching the tools/resources route conventions.
 */
export async function GET(_request: NextRequest, { params }: RouteContext) {
  const _lock = await assertUnlocked();
  if (_lock) return _lock;

  try {
    const { name } = await params;
    const result = await mcpService.listServerPrompts(name);
    return json(result, 200);
  } catch (error) {
    log.error('Error handling GET request', error);
    return json({ prompts: [], ...formatErrorResponse(error) }, 500);
  }
}
