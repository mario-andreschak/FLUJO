import { buildQuickChatFlow } from '@/backend/services/flow/quickChat';
import { QUICK_CHAT_DISCOVERY_TOOLS } from '@/utils/shared/quickChat';

const mockModels = jest.fn();
const mockConfigs = jest.fn();
const mockTools = jest.fn();
jest.mock('@/backend/services/model', () => ({ modelService: { loadModels: (...args: unknown[]) => mockModels(...args) } }));
jest.mock('@/backend/services/mcp', () => ({ mcpService: {
  loadServerConfigs: (...args: unknown[]) => mockConfigs(...args),
  listServerTools: (...args: unknown[]) => mockTools(...args),
} }));
jest.mock('@/utils/logger', () => ({ createLogger: () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }) }));

const discovery = {
  name: 'Renamed FLUJO', transport: 'stdio', command: 'node', args: ['./dist/index.js'],
  source: { type: 'marketplace', id: '@mario.andreschak/mcp-flujo' },
};
const selection = { conversationId: 'quick', modelId: 'model-1' };

beforeEach(() => {
  jest.clearAllMocks();
  mockModels.mockResolvedValue([{ id: 'model-1', name: 'My AI' }]);
  mockConfigs.mockResolvedValue([discovery, { name: 'Calendar', transport: 'streamable' }]);
  mockTools.mockResolvedValue({ tools: [{ name: 'read_events' }, { name: 'delete_events' }] });
});

it('starts with discovery on the renamed bundled connection and leaves app catalogs cold', async () => {
  const result = await buildQuickChatFlow(selection);
  expect(result.success).toBe(true);
  if (!result.success) throw new Error(result.error);
  const nodes = result.flow.nodes.filter(node => node.type === 'mcp');
  expect(nodes).toHaveLength(1);
  expect(nodes[0].data.properties).toMatchObject({ boundServer: 'Renamed FLUJO', enabledTools: [...QUICK_CHAT_DISCOVERY_TOOLS] });
  expect(mockTools).not.toHaveBeenCalled();
});

it('refuses a same-name third-party server instead of granting it the bootstrap identity', async () => {
  mockConfigs.mockResolvedValue([{ name: 'flujo', transport: 'stdio', source: { type: 'marketplace', id: 'third-party' } }]);
  expect(await buildQuickChatFlow(selection)).toMatchObject({ success: false, statusCode: 400, error: expect.stringContaining('FLUJO connection') });
  expect(mockTools).not.toHaveBeenCalled();
});

it('explains recovery when the bundled connection is disabled', async () => {
  mockConfigs.mockResolvedValue([{ ...discovery, disabled: true }]);
  expect(await buildQuickChatFlow(selection)).toMatchObject({ success: false, error: expect.stringContaining('Enable or restore') });
});

it('does not turn an unavailable configuration store into a successful model-only chat', async () => {
  mockConfigs.mockResolvedValue({ error: 'Storage unavailable' });
  expect(await buildQuickChatFlow(selection)).toMatchObject({ success: false, statusCode: 503, error: 'Storage unavailable' });
});

it('preserves an explicit app subset and only inventories that selected app', async () => {
  const result = await buildQuickChatFlow({ ...selection, servers: [{ name: 'Calendar', enabledTools: ['read_events', 'invented_tool'] }] });
  expect(result.success).toBe(true);
  if (!result.success) throw new Error(result.error);
  expect(mockTools).toHaveBeenCalledTimes(1);
  expect(mockTools).toHaveBeenCalledWith('Calendar');
  expect(result.flow.nodes.find(node => node.type === 'mcp' && node.data.properties?.boundServer === 'Calendar')?.data.properties?.enabledTools).toEqual(['read_events']);
});

it('surfaces a selected app failure rather than dropping its tools', async () => {
  mockTools.mockResolvedValue({ tools: [], error: 'App authentication required' });
  expect(await buildQuickChatFlow({ ...selection, servers: [{ name: 'Calendar' }] })).toMatchObject({ success: false, statusCode: 503, error: 'App authentication required' });
});
