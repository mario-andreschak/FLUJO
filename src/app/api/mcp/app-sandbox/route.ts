import { NextRequest, NextResponse } from 'next/server';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import {
  getSandboxAuthToken,
  deriveSandboxPublicUrl,
  getSandboxPort,
  getSandboxPublicUrl,
  hasSandboxPublicUrlConfiguration,
  isSandboxServerReady,
} from '@/backend/mcpApps/sandboxServer';

/**
 * GET /api/mcp/app-sandbox
 *
 * Returns the ready sandbox proxy's port and process-scoped access token. Local
 * installs build `http://<same-hostname>:<port>/sandbox.html?token=…`; hosted
 * installs return the separately-originated HTTPS `url` derived from the active
 * request hostname and sandbox port. Legacy explicit URL configuration remains
 * a compatibility fallback.
 *
 * Gated like the rest of the API (deny-by-default): MCP Apps only render inside
 * an active chat, which already requires the encryption unlock, so there is no
 * need to expose this while locked.
 */
function externalOrigin(request: NextRequest): string {
  const forwardedProto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim();
  const forwardedHost = request.headers.get('x-forwarded-host')?.split(',')[0]?.trim();
  const protocol = forwardedProto || request.nextUrl.protocol.replace(/:$/, '') || 'http';
  const host = forwardedHost || request.headers.get('host') || request.nextUrl.host;
  return `${protocol}://${host}`;
}

export async function GET(request: NextRequest) {
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

  const configuredPublicUrl = getSandboxPublicUrl();
  if (hasSandboxPublicUrlConfiguration() && !configuredPublicUrl) {
    return NextResponse.json(
      { error: 'The legacy MCP Apps sandbox URL is not a valid HTTP(S) URL' },
      {
        status: 503,
        headers: {
          'Cache-Control': 'no-store',
          Pragma: 'no-cache',
        },
      },
    );
  }

  const publicUrl = configuredPublicUrl
    ?? deriveSandboxPublicUrl(externalOrigin(request), getSandboxPort());

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
