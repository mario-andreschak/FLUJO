import { NextResponse } from 'next/server';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { getSandboxPort } from '@/backend/mcpApps/sandboxServer';

/**
 * GET /api/mcp/app-sandbox
 *
 * Returns the port the MCP Apps (#97) sandbox proxy origin listens on, so the
 * chat can build the foreign-origin sandbox URL as
 * `http://<same-hostname>:<port>/sandbox.html`. The hostname is taken from the
 * browser's own location (host and sandbox share a hostname, differ only by
 * port → distinct origins), so only the port needs to cross from the server.
 *
 * Gated like the rest of the API (deny-by-default): MCP Apps only render inside
 * an active chat, which already requires the encryption unlock, so there is no
 * need to expose this while locked.
 */
export async function GET() {
  const _lock = await assertUnlocked();
  if (_lock) return _lock;

  return NextResponse.json({ port: getSandboxPort() });
}
