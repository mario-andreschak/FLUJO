import { NextRequest, NextResponse } from 'next/server';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { isValidMcpAppDomain } from '@/shared/utils/mcpAppOrigin';
import {
  getSandboxAuthToken,
  deriveSandboxPublicUrl,
  getSandboxPort,
  getSandboxPublicUrl,
  hasSandboxPublicUrlConfiguration,
  isSandboxServerReady,
  ensureSandboxForOriginKey,
} from '@/backend/mcpApps/sandboxServer';

/**
 * GET /api/mcp/app-sandbox?originKey=…
 *
 * Returns the sandbox proxy's port and access token, either shared (legacy)
 * or scoped to a specific originKey (per-app origin isolation).
 *
 * Query parameters:
 *   - originKey (optional): Validated app origin key (DNS-safe domain or hash).
 *     If provided, returns a token scoped to that app; if omitted or invalid,
 *     returns the legacy shared token.
 *
 * Local installs build `http://<same-hostname>:<port>/sandbox.html?token=…`;
 * hosted installs return an HTTPS URL. Legacy explicit URL configuration remains
 * a compatibility fallback.
 *
 * Response shape:
 *   - port: Port number for the sandbox listener
 *   - token: Access token (per-app scoped or shared)
 *   - url?: Browser-visible URL (hosted HTTPS deployments)
 *   - originKey?: Echo of the requested originKey (when provided)
 *   - shared: Whether this is a fallback to the shared origin (Mode C)
 *
 * Gated like the rest of the API (deny-by-default): MCP Apps only render inside
 * an active chat, which already requires the encryption unlock.
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

  // Ensure the shared sandbox listener is allocated and ready.
  // This is fire-and-forget on startup, but on first request we wait for it.
  const sharedSandbox = await ensureSandboxForOriginKey('');
  if (!sharedSandbox) {
    return NextResponse.json(
      { error: 'MCP Apps sandbox failed to start; retry in a moment' },
      {
        status: 503,
        headers: {
          'Cache-Control': 'no-store, no-cache',
          Pragma: 'no-cache',
          'Retry-After': '2',
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

  // Extract and validate the originKey parameter (if provided).
  const rawOriginKey = request.nextUrl.searchParams.get('originKey');
  let originKey: string | undefined;
  let shared = false;

  if (rawOriginKey) {
    // Validate the originKey. If it's not a valid domain, reject it.
    if (!isValidMcpAppDomain(rawOriginKey)) {
      return NextResponse.json(
        { error: 'Invalid originKey' },
        { status: 400, headers: { 'Cache-Control': 'no-store' } },
      );
    }
    originKey = rawOriginKey;
  }

  // Try to allocate or reuse a sandbox for this originKey.
  let sandboxResult;
  if (originKey) {
    // Attempt per-app origin allocation (Mode A/B).
    try {
      sandboxResult = await ensureSandboxForOriginKey(originKey);
    } catch (err) {
      // Log and fall back to shared.
      console.error('Failed to allocate sandbox for originKey:', originKey, err);
    }
  }

  // If allocation failed or no originKey was provided, fall back to shared (Mode C).
  if (!sandboxResult) {
    sandboxResult = {
      port: getSandboxPort(),
      token: getSandboxAuthToken(),
    };
    shared = true;
  }

  const publicUrl = configuredPublicUrl
    ?? deriveSandboxPublicUrl(externalOrigin(request), sandboxResult.port, originKey);

  // Validate that the sandbox URL origin differs from the request origin
  // (enforces foreign-origin isolation).
  if (publicUrl) {
    try {
      const sandboxUrlOrigin = new URL(publicUrl).origin;
      const requestOrigin = new URL(externalOrigin(request)).origin;
      if (sandboxUrlOrigin === requestOrigin) {
        return NextResponse.json(
          { error: 'Sandbox origin must differ from host origin' },
          { status: 500, headers: { 'Cache-Control': 'no-store' } },
        );
      }
    } catch {
      // URL parsing failed; return anyway and let the client detect the issue.
    }
  }

  return NextResponse.json(
    {
      port: sandboxResult.port,
      token: sandboxResult.token,
      ...(publicUrl ? { url: publicUrl } : {}),
      ...(originKey ? { originKey } : {}),
      shared,
    },
    {
      headers: {
        'Cache-Control': 'no-store',
        Pragma: 'no-cache',
      },
    },
  );
}
