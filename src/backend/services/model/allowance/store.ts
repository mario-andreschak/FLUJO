import { createHmac, randomBytes } from 'node:crypto';
import { getWorkspaceDataDir } from '@/utils/workspace';
import { ALLOWANCE_MAX_AGE_MS } from '@/shared/types/model/allowance';
import type { AllowanceProvider, AllowanceSnapshot, AllowanceFailureReason } from '@/shared/types/model/allowance';

interface AllowanceFailure { at: number; reason: AllowanceFailureReason; retryAt?: string }

// Next route and execution bundles must share one in-memory identity/cache.
const stateSymbol = Symbol.for('flujo.subscriptionAllowance');
interface AllowanceState {
  identitySecret: Buffer; observations: Map<string, AllowanceSnapshot>;
  failures?: Map<string, AllowanceFailure>; signals?: Map<string, AllowanceSnapshot>;
}
const shared = globalThis as typeof globalThis & { [stateSymbol]?: AllowanceState };
const state: AllowanceState = shared[stateSymbol] ??= { identitySecret: randomBytes(32), observations: new Map() };
const { identitySecret, observations } = state;
const failures = state.failures ??= new Map<string, AllowanceFailure>();
const signals = state.signals ??= new Map<string, AllowanceSnapshot>();
const MAX_OBSERVATIONS = 512;

function trim(map: Map<string, unknown>): void {
  while (map.size > MAX_OBSERVATIONS) map.delete(map.keys().next().value!);
}

/** Process-keyed grouping pseudonym, projected as accountGroup in local allowance
 * responses. The random HMAC secret stays in memory; this is not a persisted
 * password hash or an authentication verifier. No credential is projected. */
export function allowanceAccountKey(provider: AllowanceProvider, identity: string): string {
  return createHmac('sha256', identitySecret)
    .update(JSON.stringify([getWorkspaceDataDir(), provider, identity])).digest('hex');
}

export function recordAllowanceSnapshot(accountKey: string, snapshot: AllowanceSnapshot): void {
  // Missing SDK capabilities are not a new observation of the account balance.
  // In particular, an ordinary setup-token run must not erase a fresh usage read.
  if (snapshot.windows.length === 0) return;
  const previous = observations.get(accountKey);
  if (previous && Date.parse(previous.observedAt) > Date.parse(snapshot.observedAt)) return;
  observations.delete(accountKey);
  observations.set(accountKey, structuredClone(snapshot));
  failures.delete(accountKey);
  // A complete read made after a rate-limit signal already includes it.
  const signal = signals.get(accountKey);
  if (signal && Date.parse(signal.observedAt) <= Date.parse(snapshot.observedAt)) signals.delete(accountKey);
  trim(observations);
}

/**
 * A rate-limit signal names one window, so it updates that window instead of
 * replacing the account reading. 'clear' drops earlier signals: the provider
 * says no limit is near any more, so an old warning or 0% must not linger.
 * Signals age out after ALLOWANCE_MAX_AGE_MS like every other reading.
 */
export function recordAllowanceSignal(accountKey: string, signal: AllowanceSnapshot | 'clear' | undefined, now = Date.now()): void {
  if (!signal) return;
  if (signal === 'clear') { signals.delete(accountKey); return; }
  const previous = signals.get(accountKey);
  const fresh = previous && now - Date.parse(previous.observedAt) < ALLOWANCE_MAX_AGE_MS
    && Date.parse(previous.observedAt) <= Date.parse(signal.observedAt);
  const replaced = new Set(signal.windows.map(window => window.id));
  signals.delete(accountKey);
  signals.set(accountKey, structuredClone(fresh
    // The oldest contributing time is kept so no window looks newer than it is.
    ? { ...signal, observedAt: previous.observedAt, windows: [...previous.windows.filter(window => !replaced.has(window.id)), ...signal.windows] }
    : signal));
  trim(signals);
}

/** A credential refused usage access is checked again after this long, not never:
 * a refreshed login or plan change can grant it (the weekly limit stayed hidden). */
export const USAGE_PERMISSION_RECHECK_MS = 6 * 60 * 60 * 1000;

export function recordAllowanceFailure(accountKey: string, reason: AllowanceFailureReason = 'collection-failed', retryAt?: string): void {
  failures.delete(accountKey);
  const recheckAt = retryAt ?? (reason === 'usage-permission' ? new Date(Date.now() + USAGE_PERMISSION_RECHECK_MS).toISOString() : undefined);
  failures.set(accountKey, { at: Date.now(), reason, retryAt: recheckAt });
  trim(failures);
}

export function allowanceRefreshFailure(accountKey: string): AllowanceFailure | undefined {
  const attempted = failures.get(accountKey);
  return attempted && ((attempted.retryAt && Date.parse(attempted.retryAt) > Date.now()) || Date.now() - attempted.at < 5 * 60 * 1000) ? attempted : undefined;
}

/** The latest account reading, with newer rate-limit signals laid over the
 * matching windows. The merged reading keeps the older time, so it expires
 * as soon as any part of it would; an expired reading never hides a fresh signal. */
export function readAllowanceSnapshot(accountKey: string, now = Date.now()): AllowanceSnapshot | undefined {
  const snapshot = observations.get(accountKey);
  const signal = signals.get(accountKey);
  if (!signal) return snapshot && structuredClone(snapshot);
  if (!snapshot) return structuredClone(signal);
  if (Date.parse(snapshot.observedAt) >= Date.parse(signal.observedAt)) return structuredClone(snapshot);
  if (now - Date.parse(snapshot.observedAt) >= ALLOWANCE_MAX_AGE_MS) return structuredClone(signal);
  const replaced = new Set(signal.windows.map(window => window.id));
  return structuredClone({ ...snapshot, windows: [...snapshot.windows.filter(window => !replaced.has(window.id)), ...signal.windows] });
}
