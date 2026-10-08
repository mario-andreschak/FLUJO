import { withWorkspaceRoute } from '@/app/api/_workspace';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { createLogger } from '@/utils/logger';
import { json } from '@/app/api/mcp/_helpers';
import type { NextRequest } from 'next/server';
import { assertBundledFlujoWorkloadAction, BundledFlujoWorkloadError } from '@/backend/services/security/bundledFlujoWorkload';

const log = createLogger('app/api/mcp/flujo/resources/route');

/** List internal run resources through their authoritative lineage-aware service. */
async function GET_handler(request: NextRequest) {
  const lock = await assertUnlocked();
  if (lock) return lock;

  try {
    const { internalListResources, internalListResourceTemplates } = await import(
      '@/backend/services/mcp/internalResources'
    );
    await assertBundledFlujoWorkloadAction('listResources', 'GET', '/api/mcp/flujo/resources');
    await assertBundledFlujoWorkloadAction('listResourceTemplates', 'GET', '/api/mcp/flujo/resources');
    const [resources, templates] = await Promise.all([
      internalListResources(request.nextUrl.searchParams.get('cursor') ?? undefined),
      internalListResourceTemplates(),
    ]);
    await assertBundledFlujoWorkloadAction('listResources', 'GET', '/api/mcp/flujo/resources');
    await assertBundledFlujoWorkloadAction('listResourceTemplates', 'GET', '/api/mcp/flujo/resources');
    return json(
      {
        resources: resources.resources,
        nextCursor: resources.nextCursor,
        resourceTemplates: templates.resourceTemplates,
        error: resources.error ?? templates.error,
      },
      200,
    );
  } catch (error) {
    if (error instanceof BundledFlujoWorkloadError) return error.response;
    log.error('Failed to list internal run resources', error);
    return json({ resources: [], resourceTemplates: [], error: 'Failed to list run resources.' }, 500);
  }
}

export const GET = withWorkspaceRoute(GET_handler);
