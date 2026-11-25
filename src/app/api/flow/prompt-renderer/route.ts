import { withWorkspaceRoute } from '@/app/api/_workspace';
import { NextRequest, NextResponse } from 'next/server';
import { assertUnlocked } from '@/utils/encryption/lockGate';
import { promptRenderer, type PromptRenderOptions } from '@/backend/utils/PromptRenderer';
import { normalizeExcludedSystemPromptSections } from '@/shared/utils/flujoSystemPrompt';
import { createLogger } from '@/utils/logger';

const log = createLogger('api/flow/prompt-renderer');

function previewOptions(options: unknown): PromptRenderOptions {
  const input = options && typeof options === 'object' ? options as Record<string, unknown> : {};
  const flag = (name: string) => typeof input[name] === 'boolean' ? input[name] as boolean : undefined;
  return {
    renderMode: input.renderMode === 'raw' ? 'raw' : 'rendered',
    includeConversationHistory: flag('includeConversationHistory'),
    excludeModelPrompt: flag('excludeModelPrompt'),
    excludeStartNodePrompt: flag('excludeStartNodePrompt'),
    excludeSystemPrompt: flag('excludeSystemPrompt'),
    ...(Array.isArray(input.excludeSystemPromptSections)
      ? { excludeSystemPromptSections: normalizeExcludedSystemPromptSections(input.excludeSystemPromptSections) }
      : {}),
  };
}

/**
 * API endpoint to render a prompt for a node in a flow
 * 
 * @param request - The request object
 * @returns The rendered prompt
 */
async function POST_handler(request: NextRequest): Promise<NextResponse> {
  const _lock = await assertUnlocked();
  if (_lock) return _lock;

  try {
    // Parse the request body
    const body = await request.json();
    const { flowId, nodeId, options } = body;
    
    log.debug('Received prompt render request', { flowId, nodeId, options });

    // Validate required parameters
    if (!flowId || !nodeId) {
      return NextResponse.json(
        { error: 'Missing required parameters: flowId and nodeId are required' },
        { status: 400 }
      );
    }
    
    log.info(`Rendering prompt for node ${nodeId} in flow ${flowId}`, { options });
    
    // Only display options: a preview estimates FLUJO's system sections from
    // the flow graph and never receives the runtime's slot.
    const prompt = await promptRenderer.renderPrompt(flowId, nodeId, previewOptions(options));
    
    // Return the rendered prompt
    return NextResponse.json({ prompt });
  } catch (error) {
    log.error('Error rendering prompt:', error);
    return NextResponse.json(
      { error: `Failed to render prompt: ${error instanceof Error ? error.message : 'Unknown error'}` },
      { status: 500 }
    );
  }
}

export const POST = withWorkspaceRoute(POST_handler);
