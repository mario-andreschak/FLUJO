/**
 * Regression test: a model error thrown during node execution must keep its
 * `.details` payload (HTTP status, provider code/type, retry hints) as it
 * flows out of FlowExecutor.executeStep.
 *
 * Previously executeStep's catch serialized only { name, message, stack },
 * collapsing a real 429 rate-limit into a generic 500/internal_error by the
 * time the chat completions route formatted the response. ProcessNode attaches
 * the rich details to the thrown Error; executeStep now merges them into
 * sharedState.lastResponse.errorDetails so the route reports the true status.
 */
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import { SharedState, ERROR_ACTION } from '@/backend/execution/flow/types';

// Build the model error exactly as ProcessNode does: a plain Error with an
// `isModelError` flag and a `.details` object.
function makeModelError(): Error {
  const err = new Error('Model execution failed: 429 Provider returned error');
  (err as any).isModelError = true;
  (err as any).details = {
    message: '429 Provider returned error',
    type: undefined,
    code: 429,
    status: 429,
    retryAfter: '26',
    providerError: { message: 'Provider returned error', code: 429 },
  };
  return err;
}

describe('FlowExecutor.executeStep error detail propagation', () => {
  const originalEngine = (FlowExecutor as any).engine;

  afterEach(() => {
    (FlowExecutor as any).engine = originalEngine;
  });

  it('preserves the model error .details (status 429) in lastResponse', async () => {
    // Stub the engine: resolve a fake process node, then throw a model error.
    (FlowExecutor as any).engine = {
      resolveNode: async () => ({ id: 'node-1', type: 'process', name: 'retard' }),
      runNode: async () => { throw makeModelError(); },
    };

    const sharedState = {
      conversationId: 'conv-test',
      flowId: 'flow-1',
      currentNodeId: 'node-1',
      messages: [],
      status: 'running',
    } as unknown as SharedState;

    const { action } = await FlowExecutor.executeStep(sharedState);

    expect(action).toBe(ERROR_ACTION);
    const details = (sharedState.lastResponse as any)?.errorDetails;
    expect(details).toBeDefined();
    // The crucial assertion: the real HTTP status survives (not collapsed to 500).
    expect(details.status).toBe(429);
    expect(details.code).toBe(429);
    expect(details.retryAfter).toBe('26');
    // And the base Error fields are still present.
    expect(details.message).toMatch(/Provider returned error/);
    expect(details.name).toBe('Error');
  });
});
