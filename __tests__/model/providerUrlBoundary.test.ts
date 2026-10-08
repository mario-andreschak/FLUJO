import { fetchOpenAIModels, getProviderFromBaseUrl } from '@/backend/services/model/provider';

const log = { debug: jest.fn(), verbose: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
jest.mock('@/utils/logger', () => ({ createLogger: () => ({ debug: (...a: unknown[]) => log.debug(...a),
  verbose: (...a: unknown[]) => log.verbose(...a), info: (...a: unknown[]) => log.info(...a),
  warn: (...a: unknown[]) => log.warn(...a), error: (...a: unknown[]) => log.error(...a) }) }));
const originalFetch = global.fetch;
const network = jest.fn();
beforeEach(() => {
  Object.values(log).forEach(fn => fn.mockClear());
  network.mockReset().mockResolvedValue({ ok: true, json: async () => ({ data: [{ id: 'gpt-fixture' }, { id: 'other-fixture' }] }) });
  global.fetch = network;
});
afterAll(() => { global.fetch = originalFetch; });

test.each(['api.openai.com', 'api.anthropic.com', 'api.mistral.ai', 'api.x.ai', 'openrouter.ai', 'requesty.ai',
  'generativelanguage.googleapis.com', 'resource.openai.azure.com'])
('provider name %s in another host, user info, path or query cannot select that provider', domain => {
  for (const url of [`https://${domain}.attacker.example/v1`, `https://${domain}@attacker.example/v1`,
    `https://attacker.example/${domain}/v1`, `https://attacker.example/v1?provider=${domain}`]) {
    expect(getProviderFromBaseUrl(url)).toBe('ollama');
  }
});

test.each([
  ['https://API.OPENAI.COM./v1', 'openai'],
  ['https://router.requesty.ai/v1', 'requesty'],
  ['https://team.openai.azure.us/openai/v1', 'azure'],
  ['https://team.cognitiveservices.azure.com/openai/v1', 'azure'],
  ['https://team.cognitiveservices.azure.us/openai/v1', 'azure'],
  ['http://localhost:4000/v1', 'litellm'],
  ['http://127.0.0.1:11434/v1', 'ollama'],
])('parsed provider identity preserves %s as %s', (url, provider) => {
  expect(getProviderFromBaseUrl(url)).toBe(provider);
});

test('a provider name in the path changes neither authentication headers nor OpenAI catalogue filtering', async () => {
  const models = await fetchOpenAIModels('synthetic-key', 'https://gateway.example/api.anthropic.com/api.openai.com/v1');
  expect(models.map(model => model.id)).toEqual(['gpt-fixture', 'other-fixture']);
  expect(network.mock.calls[0][1]).toEqual({ headers: { 'Content-Type': 'application/json', Authorization: 'Bearer synthetic-key' }, redirect: 'error' });
});

test('the real Anthropic hostname selects its header format and refuses redirect following', async () => {
  await fetchOpenAIModels('synthetic-key', 'https://api.anthropic.com/v1');
  expect(network.mock.calls[0][1]).toEqual({ headers: { 'Content-Type': 'application/json', 'x-api-key': 'synthetic-key', 'anthropic-version': '2023-06-01' }, redirect: 'error' });
});

test('the real OpenAI hostname preserves the existing chat catalogue filter', async () => {
  expect((await fetchOpenAIModels(null, 'https://api.openai.com/v1')).map(model => model.id)).toEqual(['gpt-fixture']);
});

test('upstream failures and credential-bearing URLs do not reach diagnostics or thrown error text', async () => {
  network.mockRejectedValue(new Error('synthetic-key synthetic-url-secret upstream-echo'));
  await expect(fetchOpenAIModels('synthetic-key', 'https://gateway.example/v1?token=synthetic-url-secret'))
    .rejects.toThrow(/^Provider model catalogue request failed$/);
  const diagnostics = JSON.stringify(Object.values(log).flatMap(fn => fn.mock.calls));
  for (const value of ['synthetic-key', 'synthetic-url-secret', 'upstream-echo', 'gateway.example']) expect(diagnostics).not.toContain(value);
});

test('unrecognized provider response bodies are omitted from diagnostics', async () => {
  network.mockResolvedValue({ ok: true, json: async () => ({ private_echo: 'synthetic-response-secret' }) });
  expect(await fetchOpenAIModels(null, 'http://localhost:11434/v1')).toEqual([]);
  expect(JSON.stringify(Object.values(log).flatMap(fn => fn.mock.calls))).not.toContain('synthetic-response-secret');
});
