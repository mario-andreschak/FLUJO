import { workspaceAllowance, refreshWorkspaceAllowance } from '@/backend/services/model/allowance';
import { modelService } from '@/backend/services/model';
import { resolveAndDecryptApiKey } from '@/backend/services/model/encryption';
import { collectCodexAllowance, readCodexAllowanceAccountKey } from '@/backend/services/model/allowance/codex';
import { allowanceEntityModels } from '@/backend/services/model/allowance/entities';
import { allowanceAccountKey, recordAllowanceSnapshot, recordAllowanceFailure } from '@/backend/services/model/allowance/store';
import { collectClaudeAccountAllowance, ClaudeAllowanceError } from '@/backend/services/model/allowance/claudeAccount';

jest.mock('@/backend/services/model', () => ({ modelService: { listModels: jest.fn() } }));
jest.mock('@/backend/services/model/encryption', () => ({ resolveAndDecryptApiKey: jest.fn() }));
jest.mock('@/backend/services/model/allowance/codex', () => ({ collectCodexAllowance: jest.fn(), readCodexAllowanceAccountKey: jest.fn() }));
jest.mock('@/backend/services/model/allowance/entities', () => ({ allowanceEntityModels: jest.fn() }));
jest.mock('@/backend/services/model/allowance/claudeAccount', () => ({
  ...jest.requireActual('@/backend/services/model/allowance/claudeAccount'), collectClaudeAccountAllowance: jest.fn(),
}));

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(modelService.listModels).mockResolvedValue({ success: true, models: [] });
  jest.mocked(allowanceEntityModels).mockResolvedValue({ flows: {}, personas: {} });
  jest.mocked(readCodexAllowanceAccountKey).mockResolvedValue('opaque-codex');
});

test('read endpoint has no collection side effect and only resolves configured subscription identities', async () => {
  jest.mocked(modelService.listModels).mockResolvedValue({ success: true, models: [
    { id: 'api', name: 'gpt', ApiKey: 'encrypted-api', adapter: 'openai' },
    { id: 'claude-a', name: 'claude-sonnet', ApiKey: 'encrypted-claude', adapter: 'claude-cli' },
    { id: 'claude-b', name: 'claude-opus', ApiKey: 'encrypted-claude', adapter: 'claude-cli' },
  ] });
  jest.mocked(resolveAndDecryptApiKey).mockResolvedValue('private-resolved-token');
  const key = allowanceAccountKey('claude', 'private-resolved-token');
  recordAllowanceSnapshot(key, { provider: 'claude', source: 'claude-sdk-usage', observedAt: new Date().toISOString(), windows: [{ id: 'weekly', label: 'Weekly', remainingPercent: 25, resetAt: null }] });
  const result = await workspaceAllowance();
  expect(result.models[1].accountGroup).toBe(result.models[2].accountGroup);
  expect(result.models[1].status).toBe('available');
  expect(result.models[0].status).toBe('unavailable');
  expect(collectCodexAllowance).not.toHaveBeenCalled();
  expect(readCodexAllowanceAccountKey).not.toHaveBeenCalled();
  expect(resolveAndDecryptApiKey).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(result)).not.toMatch(/encrypted-|private-resolved-token/);
});

test('refresh without a configured Codex subscription never starts account collection', async () => {
  await refreshWorkspaceAllowance();
  expect(collectCodexAllowance).not.toHaveBeenCalled();
});

test('overlapping refreshes share one collection for the current workspace', async () => {
  jest.mocked(modelService.listModels).mockResolvedValue({ success: true, models: [{ id: 'codex', name: 'gpt', ApiKey: '', adapter: 'codex-cli' }] });
  let resolve!: (value: Awaited<ReturnType<typeof collectCodexAllowance>>) => void;
  jest.mocked(collectCodexAllowance).mockReturnValue(new Promise(done => { resolve = done; }));
  const first = refreshWorkspaceAllowance();
  const second = refreshWorkspaceAllowance();
  await new Promise(done => setImmediate(done));
  expect(collectCodexAllowance).toHaveBeenCalledTimes(1);
  resolve({ accountKey: 'opaque-codex', snapshot: { provider: 'codex', source: 'codex-app-server', observedAt: new Date().toISOString(), windows: [{ id: 'codex:primary', label: 'Five hours', remainingPercent: 70, resetAt: null }] } });
  const results = await Promise.all([first, second]);
  expect(results.every(result => result.models[0].status === 'available')).toBe(true);
});

test('shared Claude credentials are checked once, and their negative result does not discard Codex usage', async () => {
  jest.mocked(modelService.listModels).mockResolvedValue({ success: true, models: [
    { id: 'claude-a', name: 'sonnet', ApiKey: 'encrypted-negative-token', adapter: 'claude-cli' },
    { id: 'claude-b', name: 'opus', ApiKey: 'encrypted-negative-token', adapter: 'claude-cli' },
    { id: 'codex', name: 'gpt', ApiKey: '', adapter: 'codex-cli' },
  ] });
  jest.mocked(resolveAndDecryptApiKey).mockResolvedValue('negative-usage-credential');
  jest.mocked(collectClaudeAccountAllowance).mockRejectedValue(new ClaudeAllowanceError('usage-permission'));
  jest.mocked(collectCodexAllowance).mockResolvedValue({ accountKey: 'opaque-codex', snapshot: {
    provider: 'codex', source: 'codex-app-server', observedAt: new Date().toISOString(), windows: [{ id: 'short', label: 'Five hours', remainingPercent: 70, resetAt: null }],
  } });
  const result = await refreshWorkspaceAllowance();
  expect(collectClaudeAccountAllowance).toHaveBeenCalledTimes(1);
  expect(result.models.slice(0, 2).every(row => row.reason === 'usage-permission' && row.billing === 'subscription')).toBe(true);
  expect(result.models[2].windows[0].remainingPercent).toBe(70);
});

test('checking a Claude connection does not collect an unrelated Codex account', async () => {
  jest.mocked(modelService.listModels).mockResolvedValue({ success: true, models: [
    { id: 'claude', name: 'sonnet', ApiKey: 'encrypted', adapter: 'claude-cli' },
    { id: 'codex', name: 'gpt', ApiKey: '', adapter: 'codex-cli' },
  ] });
  jest.mocked(resolveAndDecryptApiKey).mockResolvedValue('selected-only');
  jest.mocked(collectClaudeAccountAllowance).mockRejectedValue(new ClaudeAllowanceError('usage-permission'));
  await refreshWorkspaceAllowance(undefined, ['claude']);
  expect(collectCodexAllowance).not.toHaveBeenCalled();
});

test('even an explicit refresh honors a live provider retry deadline', async () => {
  jest.mocked(modelService.listModels).mockResolvedValue({ success: true, models: [{ id: 'paused', name: 'sonnet', ApiKey: 'encrypted-paused', adapter: 'claude-cli' }] });
  jest.mocked(resolveAndDecryptApiKey).mockResolvedValue('paused-token');
  const retryAt = new Date(Date.now() + 2245_000).toISOString();
  recordAllowanceFailure(allowanceAccountKey('claude', 'paused-token'), 'rate-limited', retryAt);
  const result = await refreshWorkspaceAllowance();
  expect(collectClaudeAccountAllowance).not.toHaveBeenCalled();
  expect(result.models[0]).toMatchObject({ reason: 'rate-limited', retryAt, status: 'unknown' });
});
