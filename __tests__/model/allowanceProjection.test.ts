import { projectModelAllowance } from '@/backend/services/model/allowance/projection';
import { currentAllowanceWindows, modelAllowancePercent, ALLOWANCE_MAX_AGE_MS, type AllowanceSnapshot } from '@/shared/types/model/allowance';
import { allowanceAccountKey, recordAllowanceSnapshot, readAllowanceSnapshot } from '@/backend/services/model/allowance/store';
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
