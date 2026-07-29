import { NextResponse } from 'next/server';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import {
  getSandboxAuthToken,
  getSandboxPort,
  getSandboxPublicUrl,
  isSandboxServerReady,
  SANDBOX_PUBLIC_URL_ENV,
} from '@/backend/mcpApps/sandboxServer';

/**
 * GET /api/mcp/app-sandbox
 *
 * Returns the ready sandbox proxy's port and process-scoped access token. Local
 * installs build `http://<same-hostname>:<port>/sandbox.html?token=…`; hosted
 * installs may additionally return the separately-originated HTTPS `url`
 * configured by FLUJO_MCP_APP_SANDBOX_PUBLIC_URL.
 *
 * Gated like the rest of the API (deny-by-default): MCP Apps only render inside
 * an active chat, which already requires the encryption unlock, so there is no
 * need to expose this while locked.
 */
export async function GET() {
  const _lock = await assertUnlocked();
  if (_lock) return _lock;

  if (!isSandboxServerReady()) {
    return NextResponse.json(
      { error: 'MCP Apps sandbox is not ready' },
      {
        status: 503,
        headers: {
          'Cache-Control': 'no-store',
          Pragma: 'no-cache',
        },
      },
    );
  }

  const publicUrl = getSandboxPublicUrl();
  if (process.env[SANDBOX_PUBLIC_URL_ENV]?.trim() && !publicUrl) {
    return NextResponse.json(
      { error: `${SANDBOX_PUBLIC_URL_ENV} is not a valid HTTP(S) URL` },
      {
        status: 503,
        headers: {
          'Cache-Control': 'no-store',
          Pragma: 'no-cache',
        },
      },
    );
  }

  return NextResponse.json(
    {
      port: getSandboxPort(),
      token: getSandboxAuthToken(),
      ...(publicUrl ? { url: publicUrl } : {}),
    },
    {
      headers: {
        'Cache-Control': 'no-store',
        Pragma: 'no-cache',
      },
    },
  );
}
