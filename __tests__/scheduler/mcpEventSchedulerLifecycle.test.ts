/**
 * The scheduler side of the event trigger (#1401): it ends a webhook
 * subscription only when the automation goes away for good (the current draft
 * no longer treats 410 as "stop"), resumes from the saved cursor, arms the
 * Claude channel source, and validates the new fields.
 *
 * Storage is mocked in memory below the service; the MCP service is mocked at
 * the boundary the scheduler lazy-imports.
 */
import { SchedulerService } from '@/backend/services/scheduler';
import { mcpService } from '@/backend/services/mcp';

const store = new Map<string, unknown>();

jest.mock('@/utils/storage/backend', () => ({
  loadItem: jest.fn(async (key: string, defaultValue: unknown) =>
    store.has(key) ? JSON.parse(JSON.stringify(store.get(key))) : defaultValue
  ),
  saveItem: jest.fn(async (key: string, value: unknown) => {
    store.set(key, JSON.parse(JSON.stringify(value)));
  }),
  clearItem: jest.fn(async (key: string) => {
    store.delete(key);
  }),
}));

jest.mock('@/backend/execution/flow/runFlow', () => ({
  runFlow: jest.fn(async () => ({ status: 'completed', messages: [], conversationId: 'x', sharedState: {} })),
}));

jest.mock('@/backend/services/mcp', () => ({
  mcpService: {
    pinServer: jest.fn(),
    unpinServer: jest.fn(),
    isServerDisabled: jest.fn(async () => false),
    subscribeServerEvent: jest.fn(async () => ({ id: 'sub', refreshBefore: null })),
    unsubscribeServerEvent: jest.fn(async () => undefined),
    connectClaudeChannel: jest.fn(async () => true),
  },
}));

jest.mock('@/utils/encryption/secure', () => ({
  isEncryptionLocked: jest.fn(async () => false),
}));

jest.mock('@/backend/services/statistics', () => ({
  classifySchedulerSkip: jest.fn(() => 'unknown'),
  createStatisticsEvent: jest.fn((event: Record<string, unknown>) => event),
  recordStatisticsEvent: jest.fn(),
}));

jest.mock('@/backend/services/enduringAgents/runtimeLock', () => ({
  withPersonaRuntimeLock: async (
    _id: string,
    task: (lock: { assertOwned(): Promise<void> }) => Promise<unknown>,
  ) => task({ assertOwned: async () => undefined }),
}));

const mocked = mcpService as unknown as Record<
  'subscribeServerEvent' | 'unsubscribeServerEvent' | 'connectClaudeChannel' | 'pinServer' | 'unpinServer',
  jest.Mock
>;

const eventTrigger = {
  type: 'mcp-event' as const, serverName: 'chat', eventName: 'message.received', arguments: { chat_ids: ['a'] }, secret: '',
};

const input = (overrides: Record<string, unknown> = {}) => ({
  name: 'Event test',
  enabled: true,
  flowId: 'flow-1',
  prompt: 'react',
  trigger: eventTrigger,
  ...overrides,
});

const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 10));
};

describe('event trigger lifecycle in the scheduler', () => {
  let scheduler: SchedulerService;

  beforeEach(() => {
    store.clear();
    jest.clearAllMocks();
    scheduler = new SchedulerService();
  });

  afterEach(async () => {
    // Disarms every trigger (a pause never ends subscriptions).
    await scheduler.setPaused(true);
  });

  it('subscribes when armed and resumes from the saved cursor', async () => {
    const { execution } = await scheduler.create(input());
    await settle();
    expect(mocked.subscribeServerEvent).toHaveBeenCalledWith('chat', expect.objectContaining({ cursor: null }));
    store.set(`planned-execution-state/${execution!.id}`, { eventCursor: 'c-42' });
    await scheduler.update(execution!.id, { prompt: 'react again' });
    await settle();
    expect(mocked.subscribeServerEvent).toHaveBeenLastCalledWith('chat', expect.objectContaining({ cursor: 'c-42' }));
  });

  it('keeps the subscription when only the prompt or the steered conversation changes', async () => {
    const { execution } = await scheduler.create(input());
    await settle();
    await scheduler.update(execution!.id, { prompt: 'other prompt' });
    await scheduler.update(execution!.id, { trigger: { ...eventTrigger, secret: execution!.trigger.type === 'mcp-event' ? execution!.trigger.secret : '', steerConversationId: 'conv-1' } });
    await settle();
    expect(mocked.unsubscribeServerEvent).not.toHaveBeenCalled();
  });

  it.each([
    ['switched off', (id: string, s: SchedulerService) => s.update(id, { enabled: false })],
    ['deleted', (id: string, s: SchedulerService) => s.delete(id)],
    ['pointed at other chats', (id: string, s: SchedulerService) => s.update(id, { trigger: { ...eventTrigger, arguments: { chat_ids: ['b'] } } })],
  ])('ends the old subscription when the automation is %s', async (_name, change) => {
    const { execution } = await scheduler.create(input());
    await settle();
    await change(execution!.id, scheduler);
    await settle();
    expect(mocked.unsubscribeServerEvent).toHaveBeenCalledTimes(1);
    expect(mocked.unsubscribeServerEvent).toHaveBeenCalledWith('chat', expect.objectContaining({
      name: 'message.received',
      arguments: { chat_ids: ['a'] },
      url: expect.stringContaining(`/api/webhooks/mcp/${execution!.id}`),
    }));
  });

  it('keeps the subscription while all automations are paused', async () => {
    await scheduler.create(input());
    await settle();
    await scheduler.setPaused(true);
    await settle();
    expect(mocked.unsubscribeServerEvent).not.toHaveBeenCalled();
  });

  it('arms the Claude channel source by connecting and pinning, without subscribing', async () => {
    const { execution, error } = await scheduler.create(input({
      trigger: { type: 'mcp-event', source: 'claude-channel', serverName: 'chat', eventName: '', secret: '' },
    }));
    expect(error).toBeUndefined();
    await settle();
    expect(mocked.connectClaudeChannel).toHaveBeenCalledWith('chat');
    expect(mocked.pinServer).toHaveBeenCalledWith('chat', `trigger:${execution!.id}`);
    expect(mocked.subscribeServerEvent).not.toHaveBeenCalled();
  });

  it('validates the source and the conversation to steer', async () => {
    const off = { enabled: false };
    expect((await scheduler.create(input({ ...off, trigger: { ...eventTrigger, source: 'pigeon' } }))).error).toMatch(/Unknown event source/);
    expect((await scheduler.create(input({ ...off, trigger: { ...eventTrigger, steerConversationId: '../etc' } }))).error)
      .toMatch(/conversation id/);
    const cleared = await scheduler.create(input({ ...off, trigger: { ...eventTrigger, steerConversationId: '  ' } }));
    expect(cleared.error).toBeUndefined();
    expect(cleared.execution!.trigger).not.toHaveProperty('steerConversationId');
  });
});
