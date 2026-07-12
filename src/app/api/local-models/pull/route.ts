import { NextRequest } from 'next/server';
import { createLogger } from '@/utils/logger';
import { createNdjsonStreamResponse } from '@/backend/utils/ndjsonStream';
import { pull, formatPullProgress } from '@/backend/services/ollama';

const log = createLogger('app/api/local-models/pull/route');

// Node runtime: streams from a localhost Ollama server via fetch + web streams.
export const runtime = 'nodejs';

// Ollama model refs look like `family:tag` / `namespace/family:tag`. Allow only
// the characters those use, so a model name can never smuggle anything odd into
// the pull request. Length-bounded to keep it a model name, not a payload.
const MODEL_RE = /^[a-zA-Z0-9._:\/-]{1,200}$/;

/**
 * POST /api/local-models/pull
 *
 * Body: `{ "model": "llama3.2:3b" }`. Streams the download progress as NDJSON
 * {@link import('@/shared/types/streaming').CommandStreamEvent}s — the same
 * envelope (and therefore the same frontend console) as the MCP install/build
 * streams — so the onboarding can show a live progress bar.
 *
 * Not unlock-gated: pulling a model touches no secrets and may run during first
 * launch before encryption is configured. Registering the pulled model as a FLUJO
 * model (POST /api/model) is what carries the unlock requirement.
 */
export async function POST(request: NextRequest) {
  let model: string;
  try {
    const body = (await request.json()) as { model?: unknown };
    model = typeof body.model === 'string' ? body.model.trim() : '';
  } catch (error) {
    log.error('Failed to parse request body', error);
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!MODEL_RE.test(model)) {
    return new Response(JSON.stringify({ error: 'Missing or invalid model name' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return createNdjsonStreamResponse(
    async (emit, signal) => {
      emit({ type: 'status', phase: 'running', message: `Pulling ${model}…` });

      let streamError: string | undefined;
      await pull(
        model,
        (progress) => {
          if (progress.error) {
            streamError = progress.error;
            emit({ type: 'stderr', data: progress.error });
            return;
          }
          emit({ type: 'stdout', data: formatPullProgress(progress) });
        },
        signal
      );

      emit(
        streamError
          ? { type: 'result', success: false, error: streamError }
          : { type: 'result', success: true, commandOutput: `Pulled ${model}` }
      );
    },
    { signal: request.signal }
  );
}
