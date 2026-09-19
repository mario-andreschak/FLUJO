import { withWorkspaceRoute } from '@/app/api/_workspace';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { NextRequest } from 'next/server';
import { createLogger } from '@/utils/logger';
import { mcpService } from '@/backend/services/mcp';
import type { ToolCallProgress } from '@/backend/services/mcp/tools';
import { formatErrorResponse } from '@/utils/mcp/utils';
import { json } from '@/app/api/mcp/_helpers';
import { streamJsonChunks } from './streamJson';

const log = createLogger('app/api/mcp/servers/[name]/tools/[toolName]/stream');

type RouteContext = { params: Promise<{ name: string; toolName: string }> };

interface StreamWriter {
  send: (event: string, data: unknown) => Promise<boolean>;
  close: () => void;
  isClosed: () => boolean;
  releaseDemand: () => void;
}

function createWriter(
  controller: ReadableStreamDefaultController<Uint8Array>,
  signal: AbortSignal,
): StreamWriter {
  const encoder = new TextEncoder();
  let closed = false;
  let resumeDemand: (() => void) | undefined;

  const releaseDemand = () => {
    const resume = resumeDemand;
    resumeDemand = undefined;
    resume?.();
  };
  const waitForDemand = async () => {
    while (!closed && !signal.aborted && (controller.desiredSize ?? 1) <= 0) {
      await new Promise<void>((resolve) => { resumeDemand = resolve; });
    }
  };
  const send = async (event: string, data: unknown): Promise<boolean> => {
    await waitForDemand();
    if (closed || signal.aborted) return false;
    try {
      const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
      controller.enqueue(encoder.encode(payload));
      return true;
    } catch {
      closed = true;
      releaseDemand();
      return false;
    }
  };
  const close = () => {
    if (closed) return;
    closed = true;
    releaseDemand();
    try {
      controller.close();
    } catch {
      // The browser may already have cancelled the response body.
    }
  };
  return { send, close, isClosed: () => closed, releaseDemand };
}

/**
 * POST /api/mcp/servers/{name}/tools/{toolName}/stream
 *
 * Progress is forwarded as SSE. The complete result is serialized in
 * backpressure-aware chunks and parsed in a browser worker; no result is
 * truncated and no additional timeout policy is introduced here.
 */
async function POST_handler(request: NextRequest, { params }: RouteContext) {
  const lock = await assertUnlocked();
  if (lock) return lock;

  try {
    const { name, toolName } = await params;
    const body = await request.json();
    const args = body?.args;
    const timeout = body?.timeout;
    const source = body?.source === 'app' ? 'app' : 'host';
    const rawOwnerScope = body?.ownerScope;
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      return json({ success: false, error: 'Missing tool arguments ("args")' }, 400);
    }
    if (
      source === 'app'
      && rawOwnerScope !== undefined
      && (
        typeof rawOwnerScope !== 'string'
        || rawOwnerScope.trim().length === 0
        || rawOwnerScope.length > 512
      )
    ) {
      return json({ success: false, error: 'Invalid MCP App owner scope' }, 400);
    }
    const ownerScope = typeof rawOwnerScope === 'string' ? rawOwnerScope.trim() : undefined;

    const toolAbort = new AbortController();
    const abortFromRequest = () => toolAbort.abort();
    request.signal.addEventListener('abort', abortFromRequest, { once: true });
    let writer: StreamWriter | undefined;

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        writer = createWriter(controller, toolAbort.signal);
        void (async () => {
          let latestProgress: ToolCallProgress | undefined;
          let progressDrain: Promise<void> | undefined;
          const startProgressDrain = () => {
            if (progressDrain || !writer) return;
            progressDrain = (async () => {
              while (latestProgress && writer && !writer.isClosed()) {
                const progress = latestProgress;
                latestProgress = undefined;
                await writer.send('progress', progress);
              }
            })().finally(() => {
              progressDrain = undefined;
              if (latestProgress) startProgressDrain();
            });
          };
          const onProgress = (progress: ToolCallProgress) => {
            // Progress is a live projection, so a slow browser only needs the
            // newest snapshot. Complete tool-result chunks are never coalesced.
            latestProgress = progress;
            startProgressDrain();
          };

          try {
            const result = source === 'app'
              ? await mcpService.callToolFromApp(
                  name,
                  toolName,
                  args,
                  timeout,
                  toolAbort.signal,
                  ownerScope,
                  onProgress,
                )
              : await mcpService.callTool(
                  name,
                  toolName,
                  args,
                  timeout,
                  onProgress,
                  undefined,
                  toolAbort.signal,
                );

            await progressDrain;
            if (!writer || writer.isClosed()) return;
            await writer.send('result-start', {});
            for await (const chunk of streamJsonChunks(result)) {
              if (!await writer.send('result-chunk', { chunk })) return;
            }
            await writer.send('result-end', {});
            await writer.send('done', {});
          } catch (error) {
            if (!writer || writer.isClosed() || toolAbort.signal.aborted) return;
            log.error('Streaming MCP tool call failed', error);
            await writer.send('error', {
              success: false,
              ...formatErrorResponse(error),
            });
            await writer.send('done', {});
          } finally {
            request.signal.removeEventListener('abort', abortFromRequest);
            writer?.close();
          }
        })();
      },
      pull() {
        writer?.releaseDemand();
      },
      cancel() {
        toolAbort.abort();
        writer?.close();
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    });
  } catch (error) {
    log.error('Error opening streaming MCP tool route', error);
    return json({ success: false, ...formatErrorResponse(error) }, 500);
  }
}

export const POST = withWorkspaceRoute(POST_handler);
