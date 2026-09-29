import { withWorkspaceRoute } from '@/app/api/_workspace';
import { executionExtensionRouteResponse } from '@/backend/execution/extensions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function POST_handler(request: Request) {
  return executionExtensionRouteResponse(request);
}

export const POST = withWorkspaceRoute(POST_handler);
