import { projectModelAllowance, applyAllowanceFailure } from '@/backend/services/model/allowance/projection';
import { currentAllowanceWindows, modelAllowancePercent, allowanceLevel, ALLOWANCE_MAX_AGE_MS, type AllowanceSnapshot } from '@/shared/types/model/allowance';
import { allowanceAccountKey, recordAllowanceSnapshot, recordAllowanceSignal, readAllowanceSnapshot } from '@/backend/services/model/allowance/store';
import { runWithWorkspace } from '@/utils/workspace';
import type { Model } from '@/shared/types/model/model';

const now = Date.parse('2026-10-09T10:00:00Z');
const model: Model = { id: 'sonnet', name: 'claude-sonnet-4-6', ApiKey: 'private-token', adapter: 'claude-cli', provider: 'claude-subscription' };
const snapshot: AllowanceSnapshot = {
  provider: 'claude', source: 'claude-sdk-usage', observedAt: new Date(now).toISOString(), windows: [
    { id: 'five_hour', label: 'Five hours', remainingPercent: 60, resetAt: new Date(now + 60_000).toISOString() },
    { id: 'sonnet', label: 'Weekly Sonnet', modelFamily: 'sonnet', remainingPercent: 40, resetAt: null },
    { id: 'opus', label: 'Weekly Opus', modelFamily: 'opus', remainingPercent: 2, resetAt: null },
  ],
};

test('projects applicable account and model windows, without credentials', () => {
  const result = projectModelAllowance(model, 'opaque', snapshot, now);
  expect(result.windows.map(window => window.id)).toEqual(['five_hour', 'sonnet']);
  expect(modelAllowancePercent(result)).toBe(40);
  expect(JSON.stringify(result)).not.toContain('private-token');
});

test('an expired reset becomes unknown instead of resetting allowance to 100%', () => {
  const windows = currentAllowanceWindows(snapshot, now + 60_000);
  expect(windows[0].remainingPercent).toBeNull();
  expect(windows[1].remainingPercent).toBe(40);
  expect(currentAllowanceWindows(snapshot, now + ALLOWANCE_MAX_AGE_MS).every(window => window.remainingPercent === null)).toBe(true);
});

test.each([NaN, Infinity, -1, 101])('invalid percentage %s stays unknown', remainingPercent => {
  expect(currentAllowanceWindows({ ...snapshot, windows: [{ ...snapshot.windows[0], remainingPercent }] }, now)[0].remainingPercent).toBeNull();
});

test('unknown subscriptions and unsupported API adapters stay distinct', () => {
  expect(projectModelAllowance(model, undefined, undefined, now).status).toBe('unknown');
  expect(projectModelAllowance({ ...model, provider: 'openai', adapter: 'openai' }, undefined, undefined, now).status).toBe('unavailable');
  expect(projectModelAllowance({ ...model, provider: 'codex', adapter: 'codex-cli', ApiKey: '' }, undefined, undefined, now).status).toBe('unknown');
  expect(projectModelAllowance({ ...model, provider: 'codex', adapter: 'codex-cli' }, undefined, undefined, now).status).toBe('unavailable');
});

test('subscription accounts, API billing and local inference remain different even under a shared provider name', () => {
  expect(projectModelAllowance(model, undefined, undefined, now).billing).toBe('subscription');
  expect(projectModelAllowance({ ...model, provider: 'ollama', adapter: 'openai', baseUrl: 'http://localhost:11434/v1' }, undefined, undefined, now).billing).toBe('local');
  expect(projectModelAllowance({ ...model, provider: 'ollama', adapter: 'openai', baseUrl: 'https://hosted.example/v1' }, undefined, undefined, now).billing).toBe('api');
  expect(projectModelAllowance({ ...model, provider: 'openrouter', adapter: 'openai-responses' }, undefined, undefined, now).billing).toBe('api');
});

test('fresh unknown provider data differs from an expired observation', () => {
  const unknown = { ...snapshot, windows: [{ ...snapshot.windows[0], remainingPercent: null }] };
  expect(projectModelAllowance(model, 'opaque', unknown, now).status).toBe('unknown');
  expect(projectModelAllowance(model, 'opaque', snapshot, now + ALLOWANCE_MAX_AGE_MS).status).toBe('stale');
});

test('policy membership preserves fallback order without a synthetic balance', () => {
  const result = projectModelAllowance({ ...model, fallbackPolicy: { modelIds: ['sonnet', 'codex'] } }, undefined, undefined, now);
  expect(result.policyModelIds).toEqual(['sonnet', 'codex']);
  expect(modelAllowancePercent(result)).toBeNull();
});

test('credential identity deduplicates within a workspace and separates workspaces/providers', () => {
  const first = runWithWorkspace('allowance-a', () => allowanceAccountKey('claude', 'private-token'));
  expect(runWithWorkspace('allowance-a', () => allowanceAccountKey('claude', 'private-token'))).toBe(first);
  expect(runWithWorkspace('allowance-b', () => allowanceAccountKey('claude', 'private-token'))).not.toBe(first);
  expect(runWithWorkspace('allowance-a', () => allowanceAccountKey('codex', 'private-token'))).not.toBe(first);
  expect(first).not.toContain('private-token');
});

test('snapshot reads are detached and late observations cannot overwrite newer ones', () => {
  const key = allowanceAccountKey('claude', 'cache-test');
  recordAllowanceSnapshot(key, snapshot);
  const copy = readAllowanceSnapshot(key)!;
  copy.windows[0].remainingPercent = 0;
  expect(readAllowanceSnapshot(key)?.windows[0].remainingPercent).toBe(60);
  recordAllowanceSnapshot(key, { ...snapshot, observedAt: new Date(now - 1).toISOString(), windows: [] });
  expect(readAllowanceSnapshot(key)?.windows).toHaveLength(3);
});

test('an empty SDK result cannot erase a fresh direct account-usage observation', () => {
  const key = allowanceAccountKey('claude', 'empty-observation-regression');
  const fresh = { ...snapshot, source: 'claude-oauth-usage' as const };
  recordAllowanceSnapshot(key, fresh);
  recordAllowanceSnapshot(key, { ...snapshot, observedAt: new Date(now + 1000).toISOString(), windows: [] });
  expect(readAllowanceSnapshot(key)).toEqual(fresh);
});

describe('rate-limit signals beside full usage reads', () => {
  const signal = (id: string, remainingPercent: number, at: number): AllowanceSnapshot => ({
    provider: 'claude', source: 'claude-rate-limit-event', observedAt: new Date(at).toISOString(),
    windows: [{ id, label: id, remainingPercent, resetAt: null }],
  });

  test('a newer signal replaces only its own window and keeps the older reading time', () => {
    const key = allowanceAccountKey('claude', 'signal-overlay');
    recordAllowanceSnapshot(key, snapshot);
    recordAllowanceSignal(key, signal('five_hour', 0, now + 1000), now + 1000);
    const merged = readAllowanceSnapshot(key, now + 1000)!;
    expect(merged.observedAt).toBe(snapshot.observedAt);
    expect(merged.windows.map(window => [window.id, window.remainingPercent])).toEqual([['sonnet', 40], ['opus', 2], ['five_hour', 0]]);
  });

  test('a full read made after the signal wins, and "clear" drops a signal', () => {
    const key = allowanceAccountKey('claude', 'signal-superseded');
    recordAllowanceSignal(key, signal('five_hour', 0, now), now);
    recordAllowanceSnapshot(key, { ...snapshot, observedAt: new Date(now + 1000).toISOString() });
    expect(readAllowanceSnapshot(key, now + 1000)?.windows.find(window => window.id === 'five_hour')?.remainingPercent).toBe(60);
    const other = allowanceAccountKey('claude', 'signal-cleared');
    recordAllowanceSignal(other, signal('seven_day', 10, now), now);
    recordAllowanceSignal(other, 'clear', now);
    expect(readAllowanceSnapshot(other, now)).toBeUndefined();
  });

  test('an expired full read never hides a fresh signal', () => {
    const key = allowanceAccountKey('claude', 'signal-after-expiry');
    recordAllowanceSnapshot(key, snapshot);
    const later = now + ALLOWANCE_MAX_AGE_MS + 1000;
    recordAllowanceSignal(key, signal('seven_day', 15, later), later);
    const projected = projectModelAllowance(model, key, readAllowanceSnapshot(key, later), later);
    expect(projected.status).toBe('available');
    expect(modelAllowancePercent(projected)).toBe(15);
  });

  test('signals for the same account add up into one reading until they age out', () => {
    const key = allowanceAccountKey('claude', 'signal-accumulate');
    recordAllowanceSignal(key, signal('five_hour', 30, now), now);
    recordAllowanceSignal(key, signal('seven_day', 12, now + 1000), now + 1000);
    expect(readAllowanceSnapshot(key, now + 1000)?.windows.map(window => window.id)).toEqual(['five_hour', 'seven_day']);
    const later = now + ALLOWANCE_MAX_AGE_MS + 5000;
    recordAllowanceSignal(key, signal('seven_day', 11, later), later);
    expect(readAllowanceSnapshot(key, later)?.windows.map(window => window.id)).toEqual(['seven_day']);
  });
});

test('a reading with no window for this model is not observed yet, not unreadable', () => {
  const opusOnly = { ...snapshot, windows: [snapshot.windows[2]] };
  expect(projectModelAllowance(model, 'opaque', opusOnly, now)).toMatchObject({ status: 'unknown', reason: 'not-observed', billing: 'subscription' });
});

test('an Antigravity login is a subscription FLUJO cannot read, never API billing', () => {
  const antigravity: Model = { id: 'agy', name: 'gemini-3-pro', provider: 'antigravity-cli', ApiKey: '' };
  expect(projectModelAllowance(antigravity, 'login', undefined, now)).toMatchObject({ provider: 'antigravity', billing: 'subscription', status: 'unavailable', reason: 'unsupported' });
  expect(projectModelAllowance({ ...antigravity, ApiKey: 'encrypted-key' }, undefined, undefined, now).billing).toBe('api');
});

test('a refused usage page is no failure while another current reading exists', () => {
  const available = projectModelAllowance(model, 'opaque', snapshot, now);
  const retryAt = new Date(now + 60_000).toISOString();
  const refused = applyAllowanceFailure({ ...available }, { reason: 'usage-permission', retryAt });
  expect(refused).toMatchObject({ status: 'available', retryAt });
  expect(refused.refreshFailed).toBeUndefined();
  expect(applyAllowanceFailure({ ...available }, { reason: 'collection-failed' }).refreshFailed).toBe(true);
  expect(applyAllowanceFailure(projectModelAllowance(model, 'opaque', undefined, now), { reason: 'usage-permission', retryAt }))
    .toMatchObject({ status: 'unknown', reason: 'usage-permission', refreshFailed: true });
});

test.each([[100, 'ok'], [26, 'ok'], [25, 'low'], [11, 'low'], [10, 'critical'], [0, 'critical']] as const)('%s%% left is %s', (percent, level) => {
  expect(allowanceLevel(percent)).toBe(level);
});
