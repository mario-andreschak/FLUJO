const mockCompletion = jest.fn();
jest.mock('@/backend/services/model/adapters', () => ({
  getCompletionAdapter: jest.fn(() => ({ createCompletion: mockCompletion })),
  describeCompletionAdapter: jest.fn(() => ({ adapter: 'antigravity-cli' })),
  resolveOpenRouterMediaRoute: jest.fn(() => ({ useMediaRoute: false })),
}));
jest.mock('@/backend/services/model/adapters/antigravityCliDiscovery', () => ({ inspectAntigravityRuntime: jest.fn() }));
jest.mock('@/backend/services/model/testToolConnection', () => ({ testModelToolConnection: jest.fn(async () => ({ ok: true, durationMs: 1 })) }));
import { inspectAntigravityRuntime } from '@/backend/services/model/adapters/antigravityCliDiscovery';
import { testModelConnection } from '@/backend/services/model/testConnection';

const status = { configuredVersion: '1.3.3', installed: true, verified: true, actualVersion: '1.3.3' };
beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(inspectAntigravityRuntime).mockResolvedValue(status);
  mockCompletion.mockResolvedValue({ completion: { choices: [{ message: { content: 'pong' } }] } });
});
const run = () => testModelConnection({ modelName: 'default', provider: 'antigravity-cli', adapter: 'antigravity-cli', apiKey: '' });

test('exposes all runtime identity fields alongside a working native connection', async () => {
  const result = await run();
  expect(result.ok).toBe(true);
  expect(result.antigravityRuntime).toEqual(status);
  expect(result.diagnosis).toContain('actual version 1.3.3');
  expect(result.axios.skipped).toBe(true);
});

test('a present but unverified binary cannot start a model or tool attempt', async () => {
  jest.mocked(inspectAntigravityRuntime).mockResolvedValue({ ...status, verified: false, actualVersion: null });
  const result = await run();
  expect(result.ok).toBe(false);
  expect(result.antigravityRuntime).toMatchObject({ installed: true, verified: false, actualVersion: null });
  expect(mockCompletion).not.toHaveBeenCalled();
  expect(result.tool?.skipped).toBe(true);
});
