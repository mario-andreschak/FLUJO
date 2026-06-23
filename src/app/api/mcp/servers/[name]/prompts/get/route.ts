import { NextRequest } from 'next/server';
import { createLogger } from '@/utils/logger';
import { mcpService } from '@/backend/services/mcp';
import { formatErrorResponse } from '@/utils/mcp/utils';
import { json } from '../../../../_helpers';

const log = createLogger('app/api/mcp/servers/[name]/prompts/get/route');

type RouteContext = { params: Promise<{ name: string }> };

/**
 * POST /api/mcp/servers/{name}/prompts/get
 * Body: { name: string, arguments?: Record<string, string> }
 *
 * Fetch a prompt template expanded with the given arguments. POST (not a path param)
 * because the prompt name can contain awkward characters and the arguments are structured.
 * Responds 200 with `{ success, data, error? }` (data = the MCP GetPromptResult).
 */
export async function POST(request: NextRequest, { params }: RouteContext) {
  try {
    const { name: serverName } = await params;
    const body = await request.json().catch(() => ({}));
    const promptName = body?.name;
    if (!promptName || typeof promptName !== 'string') {
      return json({ success: false, error: 'A prompt "name" is required in the request body' }, 400);
    }
    const args =
      body?.arguments && typeof body.arguments === 'object'
        ? (body.arguments as Record<string, string>)
        : undefined;
    const result = await mcpService.getPrompt(serverName, promptName, args);
    return json(result, result.success ? 200 : result.statusCode || 500);
  } catch (error) {
    log.error('Error handling POST request', error);
    return json({ success: false, ...formatErrorResponse(error) }, 500);
  }
}
