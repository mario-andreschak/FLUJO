const mockLocked = jest.fn();
const mockContext = jest.fn();
const mockSuggestTools = jest.fn();
jest.mock('@/app/api/_workspace', () => ({ withWorkspaceRoute: (handler: unknown) => handler }));
jest.mock('@/utils/encryption/lockGate', () => ({ assertUnlocked: (...args: unknown[]) => mockLocked(...args) }));
jest.mock('@/backend/services/flow/generationContext', () => ({ gatherGenerationContext: (...args: unknown[]) => mockContext(...args) }));
jest.mock('@/backend/services/flow/assistedAuthoring', () => ({ suggestToolsForFlowStep: (...args: unknown[]) => mockSuggestTools(...args) }));
import { POST as assist } from '@/app/api/flow/assist/route';
import { FlowAuthoringValidationError } from '@/backend/services/flow/authoringErrors';
const request = (body: unknown) => ({ json: async () => body }) as any;
const assistBody = { flow: { nodes: [], edges: [] }, action: 'suggest-tools', modelId: 'model-1', nodeId: 'node-1' };
const privateFailure = 'C:/private/workspace/config.json Authorization: Bearer synthetic-opaque-credential';
beforeEach(() => {
  jest.clearAllMocks();
  mockLocked.mockResolvedValue(null);
  mockContext.mockResolvedValue({ compile: { models: [{ id: 'model-1' }] } });
});

const unexpectedCases: Array<[string, () => Promise<Response>, jest.Mock, string]> = [
  ['assistance POST', () => assist(request(assistBody)), mockSuggestTools, 'Flow assistance failed. Please try again.'],
];
it.each(unexpectedCases)('bounds an unexpected Error in %s', async (_name, invoke, service, message) => {
  service.mockRejectedValueOnce(new Error(privateFailure));
  const response = await invoke();
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({ error: message });
});

it.each([
  [() => assist(request(assistBody)), mockSuggestTools],
])('preserves an explicitly typed validation diagnostic', async (invoke, service) => {
  const message = 'Process node not found: node-1';
  service.mockRejectedValueOnce(new FlowAuthoringValidationError(message));
  const response = await invoke();
  expect(response.status).toBe(422);
  expect(await response.json()).toEqual({ error: message });
});

it('does not trust an error name or a thrown string as a validation discriminator', async () => {
  mockSuggestTools.mockRejectedValueOnce(privateFailure);
  expect(await (await assist(request(assistBody))).json()).toEqual({ error: 'Flow assistance failed. Please try again.' });
});

it('retains the lock short circuit', async () => {
  const locked = new Response('locked', { status: 423 });
  mockLocked.mockResolvedValueOnce(locked);
  expect(await assist(request(assistBody))).toBe(locked);
  expect(mockSuggestTools).not.toHaveBeenCalled();
});
