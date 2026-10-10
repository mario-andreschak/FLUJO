import { createHmac, randomBytes } from 'node:crypto';
import { getWorkspaceDataDir } from '@/utils/workspace';
import type { AllowanceProvider, AllowanceSnapshot } from '@/shared/types/model/allowance';

// Next route and execution bundles must share one in-memory identity/cache.
const stateSymbol = Symbol.for('flujo.subscriptionAllowance');
const shared = globalThis as typeof globalThis & {
  [stateSymbol]?: { identitySecret: Buffer; observations: Map<string, AllowanceSnapshot> };
};
const state = shared[stateSymbol] ??= { identitySecret: randomBytes(32), observations: new Map() };
const { identitySecret, observations } = state;
const MAX_OBSERVATIONS = 512;

/** Process-keyed grouping pseudonym, projected as accountGroup in local allowance
 * responses. The random HMAC secret stays in memory; this is not a persisted
 * password hash or an authentication verifier. No credential is projected. */
export function allowanceAccountKey(provider: AllowanceProvider, identity: string): string {
  return createHmac('sha256', identitySecret)
    .update(JSON.stringify([getWorkspaceDataDir(), provider, identity])).digest('hex');
}

export function recordAllowanceSnapshot(accountKey: string, snapshot: AllowanceSnapshot): void {
  const previous = observations.get(accountKey);
  if (previous && Date.parse(previous.observedAt) > Date.parse(snapshot.observedAt)) return;
  observations.delete(accountKey);
  observations.set(accountKey, structuredClone(snapshot));
  while (observations.size > MAX_OBSERVATIONS) observations.delete(observations.keys().next().value!);
}

export function readAllowanceSnapshot(accountKey: string): AllowanceSnapshot | undefined {
  const snapshot = observations.get(accountKey);
  return snapshot && structuredClone(snapshot);
}
