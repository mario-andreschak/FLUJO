import { createLogger } from '@/utils/logger';
import { getOllamaUrl, isLocalModelsEnabled } from '@/utils/paths';
import { probeCapability } from '@/backend/services/ollama/capability';
import { isReachable, listTags } from '@/backend/services/ollama';

const log = createLogger('app/api/local-models/capability/route');

// Node runtime: probes hardware (os) and may spawn nvidia-smi, neither available
// on the edge runtime.
export const runtime = 'nodejs';

/**
 * GET /api/local-models/capability
 *
 * Reports whether local models (Ollama) are available and what model suits this
 * machine, so the onboarding can offer a one-click "download & use" for a local
 * model. Read-only and secret-free, so it is intentionally NOT behind the
 * encryption unlock gate — it can run on first launch before encryption is set up.
 */
export async function GET() {
  try {
    const [capability, reachable] = await Promise.all([probeCapability(), isReachable()]);
    // Only list installed models when the server is actually up.
    const installedModels = reachable ? (await listTags()).map((t) => t.name) : [];

    return new Response(
      JSON.stringify({
        // Offer the local-model flow when Ollama answers, or when this build
        // explicitly advertises it (FLUJO_OLLAMA=1) even if it is still starting.
        enabled: reachable || isLocalModelsEnabled(),
        ollamaReachable: reachable,
        ollamaUrl: getOllamaUrl(),
        ...capability,
        installedModels,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    log.error('Error handling GET request', error);
    return new Response(JSON.stringify({ error: 'Failed to probe local-model capability' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
