import { NextResponse } from 'next/server';
import { getSandboxPort } from '@/backend/mcpApps/sandboxServer';

/**
 * GET /api/mcp/app-sandbox
 *
 * Returns the port the MCP Apps (#97) sandbox proxy origin listens on, so the
 * chat can build the foreign-origin sandbox URL as
 * `http://<same-hostname>:<port>/sandbox.html`. The hostname is taken from the
 * browser's own location (host and sandbox share a hostname, differ only by
 * port → distinct origins), so only the port needs to cross from the server.
 */
export async function GET() {
  return NextResponse.json({ port: getSandboxPort() });
}
