import { withWorkspaceRoute } from '@/app/api/_workspace';
/**
 * GET /api/packages/search?q=&tag=&page=&pageSize= (issue #198 follow-up).
 *
 * Proxies the hosted FLUJO package registry's anonymous search/browse endpoint
 * (`GET /v1/packages` on registry.flujo.com.co, issue #196) for the Packages
 * page's Browse tab. No account/auth required — browsing is anonymous, only
 * publishing needs a confirmed registry account (#197).
 *
 * Local-only, fail-closed (same posture as the other package routes).
 */
import { NextRequest, NextResponse } from 'next/server';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { assertLocalRequest } from '@/utils/http/localRequest';
import { searchPackageRegistry } from '@/backend/services/packages/packageRegistry';

async function GET_handler(request: NextRequest) {
  const lock = await assertUnlocked();
  if (lock) return lock;
  const notLocal = assertLocalRequest(request);
  if (notLocal) return notLocal;

  const params = new URL(request.url).searchParams;
  const page = Number(params.get('page') ?? '1');
  const pageSize = Number(params.get('pageSize') ?? '20');

  const result = await searchPackageRegistry({
    q: params.get('q') ?? undefined,
    tag: params.get('tag') ?? undefined,
    page: Number.isFinite(page) && page > 0 ? page : 1,
    pageSize: Number.isFinite(pageSize) && pageSize > 0 ? pageSize : 20,
  });

  return NextResponse.json(result, { status: result.error ? 502 : 200 });
}

export const GET = withWorkspaceRoute(GET_handler);
