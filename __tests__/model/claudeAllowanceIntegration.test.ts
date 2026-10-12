import type { CompletionInput } from '@/backend/services/model/adapters/types';
import type { Model } from '@/shared/types/model/model';

const queryMock = jest.fn();
jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (...args: unknown[]) => queryMock(...args),
  createSdkMcpServer: (config: unknown) => config,
  tool: jest.fn(),
}));
jest.mock('@/backend/services/mcp', () => ({ mcpService: { callTool: jest.fn() } }));
jest.mock('@/backend/services/model/adapters/claudeRuntimeHome', () => ({
  prepareClaudeRuntimeEnvironment: async () => ({ home: 'offline-runtime', workingDirectory: 'offline-runtime', env: {} }),
}));
jest.mock('@/utils/workspace', () => ({ getWorkspaceDataDir: () => 'offline-allowance-workspace' }));

import { ClaudeSubscriptionAdapter } from '@/backend/services/model/adapters/claudeSubscriptionAdapter';
import { allowanceAccountKey, readAllowanceSnapshot } from '@/backend/services/model/allowance/store';
import { projectModelAllowance } from '@/backend/services/model/allowance/projection';

const model = { id: 'allowance-sonnet', name: 'claude-sonnet', provider: 'claude-subscription', adapter: 'claude-cli', ApiKey: 'offline-allowance-token' } as Model;
function input(overrides: Partial<CompletionInput> = {}): CompletionInput {
  return { model, apiKey: model.ApiKey, messages: [{ role: 'user', content: 'hello' }], ...overrides } as CompletionInput;
}

describe('Claude adapter allowance boundary', () => {
  beforeEach(() => queryMock.mockReset());

  it('projects the live-query account observation to models sharing the credential', async () => {
    let iteratorClosed = false;
    const usage = jest.fn().mockResolvedValue({ rate_limits_available: true, rate_limits: {
      five_hour: { utilization: 27, resets_at: new Date(Date.now() + 60_000).toISOString() },
      seven_day_sonnet: { utilization: 42, resets_at: null },
    } });
    const stream = (async function* () {
      try {
        yield { type: 'system', subtype: 'init', session_id: 'offline-session' };
        yield { type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }] }, session_id: 'offline-session' };
        yield { type: 'result', subtype: 'success', result: 'hello', session_id: 'offline-session', usage: { input_tokens: 1, output_tokens: 1 } };
      } finally { iteratorClosed = true; }
    })();
    Object.assign(stream, { usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: usage });
    queryMock.mockReturnValue(stream);
    await new ClaudeSubscriptionAdapter().createCompletion(input());
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(usage).toHaveBeenCalledTimes(1);
    expect(usage).toHaveBeenCalledWith({ skipBehaviors: true });
    expect(iteratorClosed).toBe(true);
    const key = allowanceAccountKey('claude', model.ApiKey);
    const snapshot = readAllowanceSnapshot(key);
    expect(snapshot).toBeDefined();
    const primary = projectModelAllowance(model, key, snapshot);
    const sibling = projectModelAllowance({ ...model, id: 'another-sonnet' }, key, snapshot);
    expect(primary.status).toBe('available');
    expect(primary.windows.map(window => window.remainingPercent)).toEqual([73, 58]);
    expect(sibling.accountGroup).toBe(primary.accountGroup);
    expect(sibling.windows).toEqual(primary.windows);
    expect(JSON.stringify(snapshot)).not.toContain(model.ApiKey);
  });

  it('does not record the observation for a cancelled model turn', async () => {
    const controller = new AbortController();
    const token = 'offline-cancelled-allowance-token';
    const stream = (async function* () {
      yield { type: 'system', subtype: 'init' };
      controller.abort();
      yield { type: 'result', subtype: 'success', result: 'partial', usage: {} };
    })();
    Object.assign(stream, { usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => ({
      rate_limits_available: true, rate_limits: { five_hour: { utilization: 1, resets_at: null } },
    }) });
    queryMock.mockReturnValue(stream);
    await expect(new ClaudeSubscriptionAdapter().createCompletion(input({ apiKey: token, signal: controller.signal }))).rejects.toThrow(/cancelled/i);
    expect(readAllowanceSnapshot(allowanceAccountKey('claude', token))).toBeUndefined();
    expect(queryMock).toHaveBeenCalledTimes(1);
  });
});
