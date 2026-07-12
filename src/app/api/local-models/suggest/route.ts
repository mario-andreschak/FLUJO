import { NextRequest } from 'next/server';
import { createLogger } from '@/utils/logger';
import { suggestModel } from '@/backend/services/ollama/capability';

const log = createLogger('app/api/local-models/suggest/route');

// Node runtime for parity with the other local-model routes; the work itself is
// a pure computation with no Node-only dependency.
export const runtime = 'nodejs';

const GB = 1024 * 1024 * 1024;

/**
 * Parse a memory query param that may be given in bytes (`ramBytes`) or, for
 * convenience when called by hand, in gigabytes (`ramGB`). Returns the value in
 * bytes, or null when neither param is present. Throws on a present-but-invalid
 * value so the caller can return a 400.
 */
function memoryParam(params: URLSearchParams, bytesKey: string, gbKey: string): number | null {
  const rawBytes = params.get(bytesKey);
  const rawGb = params.get(gbKey);
  if (rawBytes !== null) {
    const n = Number(rawBytes);
    if (!Number.isFinite(n) || n < 0) throw new Error(`Invalid ${bytesKey}`);
    return n;
  }
  if (rawGb !== null) {
    const n = Number(rawGb);
    if (!Number.isFinite(n) || n < 0) throw new Error(`Invalid ${gbKey}`);
    return n * GB;
  }
  return null;
}

/**
 * GET /api/local-models/suggest?ramBytes=… (or ?ramGB=…), optionally &vramBytes / &vramGB
 *
 * Stateless wrapper over {@link suggestModel}: given a machine's memory figures,
 * returns the Ollama model sized for it. Unlike /capability (which probes THIS
 * host), this takes the hardware as input, so another app can get a suggestion
 * for its own machine. Read-only and secret-free, so not behind the unlock gate.
 */
export async function GET(request: NextRequest) {
  const params = new URL(request.url).searchParams;

  let totalRamBytes: number | null;
  let vramBytes: number | null;
  try {
    totalRamBytes = memoryParam(params, 'ramBytes', 'ramGB');
    vramBytes = memoryParam(params, 'vramBytes', 'vramGB');
  } catch (error) {
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Invalid parameters' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  if (totalRamBytes === null) {
    return new Response(
      JSON.stringify({ error: 'ramBytes (or ramGB) is required' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  try {
    const suggestedModel = suggestModel({ totalRamBytes, vramBytes });
    return new Response(
      JSON.stringify({ suggestedModel, totalRamBytes, vramBytes: vramBytes ?? null }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    log.error('Error handling GET request', error);
    return new Response(JSON.stringify({ error: 'Failed to compute a model suggestion' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
