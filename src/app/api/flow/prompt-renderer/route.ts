import { NextRequest, NextResponse } from 'next/server';
import { promptRenderer } from '@/backend/utils/PromptRenderer';
import { createLogger } from '@/utils/logger';

const log = createLogger('api/flow/prompt-renderer');

/**
 * API endpoint to render a prompt for a node in a flow
 * 
 * @param request - The request object
 * @returns The rendered prompt
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
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
    
    // Render the prompt
    const prompt = await promptRenderer.renderPrompt(flowId, nodeId, options);
    
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
