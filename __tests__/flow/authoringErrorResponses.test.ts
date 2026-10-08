const mockLocked = jest.fn();
const mockSnapshot = jest.fn();
const mockRestore = jest.fn();
const mockContext = jest.fn();
const mockSuggestTools = jest.fn();
jest.mock('@/app/api/_workspace', () => ({ withWorkspaceRoute: (handler: unknown) => handler }));
jest.mock('@/utils/encryption/lockGate', () => ({ assertUnlocked: (...args: unknown[]) => mockLocked(...args) }));
jest.mock('@/backend/services/flow/systemFlows', () => ({
  buildFlowGeneratorSnapshot: (...args: unknown[]) => mockSnapshot(...args),
  restoreVendoredFlowGenerator: (...args: unknown[]) => mockRestore(...args),
}));
jest.mock('@/backend/services/flow/generationContext', () => ({ gatherGenerationContext: (...args: unknown[]) => mockContext(...args) }));
jest.mock('@/backend/services/flow/assistedAuthoring', () => ({ suggestToolsForFlowStep: (...args: unknown[]) => mockSuggestTools(...args) }));
import { POST as generator, PUT as restore } from '@/app/api/flow/generator/route';
import { POST as assist } from '@/app/api/flow/assist/route';
import { FlowAuthoringValidationError } from '@/backend/services/flow/authoringErrors';
const request = (body: unknown) => ({ json: async () => body }) as any;
const generatorBody = { conversationId: 'conversation-1', modelId: 'model-1' };
const assistBody = { flow: { nodes: [], edges: [] }, action: 'suggest-tools', modelId: 'model-1', nodeId: 'node-1' };
const privateFailure = 'C:/private/workspace/config.json Authorization: Bearer synthetic-opaque-credential';
beforeEach(() => {
  jest.clearAllMocks();
  mockLocked.mockResolvedValue(null);
  mockContext.mockResolvedValue({ compile: { models: [{ id: 'model-1' }] } });
});

const unexpectedCases: Array<[string, () => Promise<Response>, jest.Mock, string]> = [
  ['generator POST', () => generator(request(generatorBody)), mockSnapshot, 'Failed to prepare flow generator.'],
  ['generator PUT', () => restore(), mockRestore, 'Failed to restore flow generator.'],
  ['assistance POST', () => assist(request(assistBody)), mockSuggestTools, 'Flow assistance failed. Please try again.'],
];
it.each(unexpectedCases)('bounds an unexpected Error in %s', async (_name, invoke, service, message) => {
  service.mockRejectedValueOnce(new Error(privateFailure));
  const response = await invoke();
  expect(response.status).toBe(500);
  expect(await response.json()).toEqual({ error: message });
});

it.each([
  [() => generator(request(generatorBody)), mockSnapshot],
  [() => assist(request(assistBody)), mockSuggestTools],
])('preserves an explicitly typed validation diagnostic', async (invoke, service) => {
  const message = 'Process node not found: node-1';
  service.mockRejectedValueOnce(new FlowAuthoringValidationError(message));
  const response = await invoke();
  expect(response.status).toBe(422);
  expect(await response.json()).toEqual({ error: message });
});

it('does not trust an error name or a thrown string as a validation discriminator', async () => {
  mockSnapshot.mockRejectedValueOnce(Object.assign(new Error(privateFailure), { name: 'FlowAuthoringValidationError' }));
  expect(await (await generator(request(generatorBody))).json()).toEqual({ error: 'Failed to prepare flow generator.' });
  mockSuggestTools.mockRejectedValueOnce(privateFailure);
  expect(await (await assist(request(assistBody))).json()).toEqual({ error: 'Flow assistance failed. Please try again.' });
});

it('retains the existing input validation and lock short circuit', async () => {
  const missing = await generator(request({}));
  expect(missing.status).toBe(400);
  expect(await missing.json()).toEqual({ error: 'conversationId and modelId are required' });
  const locked = new Response('locked', { status: 423 });
  mockLocked.mockResolvedValueOnce(locked);
  expect(await assist(request(assistBody))).toBe(locked);
  expect(mockSuggestTools).not.toHaveBeenCalled();
});
