import { query, type Options } from '@anthropic-ai/claude-agent-sdk';
import { collectClaudeAccountAllowance, readClaudeOAuthAllowance, ClaudeAllowanceError } from '@/backend/services/model/allowance/claudeAccount';
import { prepareClaudeRuntimeEnvironment } from '@/backend/services/model/adapters/claudeRuntimeHome';
import { createClaudeOwnedProcessSpawner } from '@/backend/services/model/adapters/claudeOwnedProcess';

jest.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: jest.fn() }));
jest.mock('@/backend/services/model/adapters/claudeRuntimeHome', () => ({ prepareClaudeRuntimeEnvironment: jest.fn() }));
jest.mock('@/backend/services/model/adapters/claudeOwnedProcess', () => ({ createClaudeOwnedProcessSpawner: jest.fn(), assertClaudeOwnedProcessRegistration: jest.fn() }));

const usage = jest.fn();
const close = jest.fn();
let sdkOptions: Options;
let prompt: AsyncIterable<unknown>;
let releaseChild: () => void;
const originalFetch = global.fetch;
const fetchMock = jest.fn();
afterEach(() => { global.fetch = originalFetch; });
beforeEach(() => {
  jest.clearAllMocks();
  global.fetch = fetchMock;
  fetchMock.mockResolvedValue(new Response('{}', { status: 403 }));
  jest.mocked(prepareClaudeRuntimeEnvironment).mockResolvedValue({ home: '/private', workingDirectory: '/private/workspace', env: {
    ANTHROPIC_API_KEY: 'unrelated-key', ANTHROPIC_BASE_URL: 'https://unrelated.example', CLAUDE_CODE_OAUTH_TOKEN: 'unrelated-login',
  } });
  const childClosed = new Promise<void>(resolve => { releaseChild = resolve; });
  jest.mocked(createClaudeOwnedProcessSpawner).mockImplementation(input => {
    const registration = { identity: {}, requestStop: () => {}, exit: Promise.resolve({ code: 0, signal: null }), close: childClosed };
    return { ready: Promise.resolve(registration as never), spawnClaudeCodeProcess: jest.fn(() => {
      void input.register(registration as never);
      return {} as never;
    }) };
  });
  jest.mocked(query).mockImplementation(input => {
    sdkOptions = input.options!;
    prompt = input.prompt as AsyncIterable<unknown>;
    sdkOptions.spawnClaudeCodeProcess!({} as never);
    return { initializationResult: async () => ({}), usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: usage, close } as never;
  });
  usage.mockResolvedValue({ rate_limits_available: true, rate_limits: { five_hour: { utilization: 20, resets_at: null } } });
});

test('reads usage on an idle process with no prompt, tools, settings sources or alternate identity', async () => {
  const collection = collectClaudeAccountAllowance('selected-setup-token');
  await new Promise(resolve => setImmediate(resolve));
  expect(usage).toHaveBeenCalledWith({ skipBehaviors: true });
  expect(sdkOptions.env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'selected-setup-token' });
  expect(sdkOptions.tools).toEqual([]);
  expect(sdkOptions.settingSources).toEqual([]);
  expect(sdkOptions.strictMcpConfig).toBe(true);
  expect(sdkOptions.persistSession).toBe(false);
  expect(sdkOptions.settings).toEqual({ disableAllHooks: true });
  expect(await prompt[Symbol.asyncIterator]().next()).toEqual({ done: true, value: undefined });
  let finished = false;
  void collection.then(() => { finished = true; });
  await Promise.resolve();
  expect(finished).toBe(false);
  releaseChild();
  expect((await collection).windows[0].remainingPercent).toBe(80);
  expect(close).toHaveBeenCalled();
});

test.each(['setup-token-without-usage', 'negative-local-login-token'])('no plan data for %s is an explicit negative result, never a fabricated balance', async credential => {
  usage.mockResolvedValue({ rate_limits_available: false, rate_limits: null });
  const collection = collectClaudeAccountAllowance(credential);
  const rejected = expect(collection).rejects.toMatchObject({ reason: 'usage-permission' });
  await new Promise(resolve => setImmediate(resolve));
  releaseChild();
  await rejected;
  expect(sdkOptions.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe(credential);
  expect(usage).toHaveBeenCalledTimes(1);
});

test('an expired access token (401) is a retryable failure, not a permanent usage refusal', async () => {
  usage.mockResolvedValue({ rate_limits_available: false, rate_limits: null });
  fetchMock.mockResolvedValue(new Response('{}', { status: 401 }));
  const collection = collectClaudeAccountAllowance('rotating-login-token');
  const rejected = expect(collection).rejects.toMatchObject({ reason: 'collection-failed' });
  await new Promise(resolve => setImmediate(resolve));
  releaseChild();
  await rejected;
});

test('an already cancelled check cannot create a native process', async () => {
  const controller = new AbortController(); controller.abort();
  await expect(collectClaudeAccountAllowance('selected', { signal: controller.signal })).rejects.toBeInstanceOf(ClaudeAllowanceError);
  expect(query).not.toHaveBeenCalled();
});

test('provider diagnostics stay behind a fixed public error', async () => {
  usage.mockRejectedValue(new Error('private-account-details'));
  const collection = collectClaudeAccountAllowance('selected');
  const rejected = expect(collection).rejects.toThrow('CLAUDE_ALLOWANCE_UNAVAILABLE');
  await new Promise(resolve => setImmediate(resolve)); releaseChild();
  await rejected;
});

test('the usage-only fallback can read a setup-token without a model request or redirect', async () => {
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ five_hour: { utilization: 40, resets_at: null } }), { status: 200 }));
  const result = await readClaudeOAuthAllowance('selected-setup-token', new AbortController().signal);
  expect(result.windows[0].remainingPercent).toBe(60);
  expect(result.source).toBe('claude-oauth-usage');
  expect(fetchMock).toHaveBeenCalledWith('https://api.anthropic.com/api/oauth/usage', expect.objectContaining({
    method: 'GET', redirect: 'error', headers: expect.objectContaining({ Authorization: 'Bearer selected-setup-token' }),
  }));
  expect(query).not.toHaveBeenCalled();
});

test('provider throttling preserves Retry-After and never becomes zero allowance', async () => {
  fetchMock.mockResolvedValue(new Response('{}', { status: 429, headers: { 'Retry-After': '2245' } }));
  const before = Date.now();
  await expect(readClaudeOAuthAllowance('selected', new AbortController().signal)).rejects.toMatchObject({
    reason: 'rate-limited', retryAt: expect.any(String),
  });
  try { await readClaudeOAuthAllowance('selected', new AbortController().signal); }
  catch (error) { expect(Date.parse((error as ClaudeAllowanceError).retryAt!)).toBeGreaterThanOrEqual(before + 2245_000); }
});
