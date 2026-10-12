import { createHmac, randomBytes } from 'node:crypto';
import { getWorkspaceDataDir } from '@/utils/workspace';
import type { AllowanceProvider, AllowanceSnapshot, AllowanceFailureReason } from '@/shared/types/model/allowance';

interface AllowanceFailure { at: number; reason: AllowanceFailureReason; retryAt?: string }

// Next route and execution bundles must share one in-memory identity/cache.
const stateSymbol = Symbol.for('flujo.subscriptionAllowance');
const shared = globalThis as typeof globalThis & {
  [stateSymbol]?: { identitySecret: Buffer; observations: Map<string, AllowanceSnapshot>; failures?: Map<string, AllowanceFailure> };
};
const state = shared[stateSymbol] ??= { identitySecret: randomBytes(32), observations: new Map(), failures: new Map() };
const { identitySecret, observations } = state;
const failures = state.failures ??= new Map();
const MAX_OBSERVATIONS = 512;

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
  while (observations.size > MAX_OBSERVATIONS) observations.delete(observations.keys().next().value!);
}

export function recordAllowanceFailure(accountKey: string, reason: AllowanceFailureReason = 'collection-failed', retryAt?: string): void {
  failures.delete(accountKey);
  failures.set(accountKey, { at: Date.now(), reason, retryAt });
  while (failures.size > MAX_OBSERVATIONS) failures.delete(failures.keys().next().value!);
}

export function allowanceRefreshFailure(accountKey: string): AllowanceFailure | undefined {
  const attempted = failures.get(accountKey);
  // A credential without usage access will not acquire that access after five
  // minutes. Keep the negative result until an explicit check or identity change.
  return attempted && (attempted.reason === 'usage-permission' || (attempted.retryAt && Date.parse(attempted.retryAt) > Date.now()) || Date.now() - attempted.at < 5 * 60 * 1000) ? attempted : undefined;
}

export function readAllowanceSnapshot(accountKey: string): AllowanceSnapshot | undefined {
  const snapshot = observations.get(accountKey);
  return snapshot && structuredClone(snapshot);
}
