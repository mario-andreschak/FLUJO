import { assertUnlocked } from '@/utils/encryption/lockGate';
import { json } from '@/app/api/mcp/_helpers';

/** Return the current MCP tool schemas. Tool execution is split across domain routes. */
export async function GET() {
  const lock = await assertUnlocked();
  if (lock) return lock;

  const { internalToolDefinitions } = await import('@/backend/services/mcp/internalTools');
  return json({ tools: internalToolDefinitions() }, 200);
}
