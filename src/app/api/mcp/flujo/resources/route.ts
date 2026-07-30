import { assertUnlocked } from '@/utils/encryption/lockGate';
import { createLogger } from '@/utils/logger';
import { json } from '@/app/api/mcp/_helpers';

const log = createLogger('app/api/mcp/flujo/resources/route');

/** List internal run resources through their authoritative lineage-aware service. */
export async function GET() {
  const lock = await assertUnlocked();
  if (lock) return lock;

  try {
    const { internalListResources, internalListResourceTemplates } = await import(
      '@/backend/services/mcp/internalResources'
    );
    const [resources, templates] = await Promise.all([
      internalListResources(),
      internalListResourceTemplates(),
    ]);
    return json(
      {
        resources: resources.resources,
        resourceTemplates: templates.resourceTemplates,
        error: resources.error ?? templates.error,
      },
      200,
    );
  } catch (error) {
    log.error('Failed to list internal run resources', error);
    return json({ resources: [], resourceTemplates: [], error: 'Failed to list run resources.' }, 500);
  }
}
