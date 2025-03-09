import { promptRenderer } from './PromptRenderer';

/**
 * Example usage of the PromptRenderer utility
 */
async function testPromptRenderer() {
  try {
    // Example 1: Render a complete prompt
    const completePrompt = await promptRenderer.renderPrompt('flow-123', 'node-456');
    console.log('Complete Prompt:');
    console.log(completePrompt);
    console.log('\n---\n');

    // Example 2: Render with raw tool pills (no resolution)
    const rawPrompt = await promptRenderer.renderPrompt('flow-123', 'node-456', { 
      renderMode: 'raw' 
    });
    console.log('Raw Prompt (with tool pills):');
    console.log(rawPrompt);
    console.log('\n---\n');

    // Example 3: Include conversation history placeholder
    const promptWithHistory = await promptRenderer.renderPrompt('flow-123', 'node-456', { 
      includeConversationHistory: true 
    });
    console.log('Prompt with Conversation History:');
    console.log(promptWithHistory);
  } catch (error) {
    console.error('Error testing PromptRenderer:', error);
  }
}

// Uncomment to run the test
// testPromptRenderer();

/**
 * Example of how to use the PromptRenderer in a real application
 */
export async function renderNodePrompt(flowId: string, nodeId: string): Promise<string> {
  try {
    return await promptRenderer.renderPrompt(flowId, nodeId, {
      renderMode: 'rendered',
      includeConversationHistory: false
    });
  } catch (error) {
    console.error(`Error rendering prompt for node ${nodeId} in flow ${flowId}:`, error);
    return `Error rendering prompt: ${error instanceof Error ? error.message : 'Unknown error'}`;
  }
}
