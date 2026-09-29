import { createHash } from 'node:crypto';
import { bankingAdmission, type BankingPrincipal } from './authority';
import { BankingError } from './errors';

interface Pool { active: number; pending: Map<string, number>; queue: Array<() => void> }
const root = globalThis as typeof globalThis & { __flujoBankingPools?: Map<string, Pool> };
const pools = root.__flujoBankingPools ??= new Map();

export async function withBankingAdmission<T>(principal: BankingPrincipal, task: () => Promise<T>): Promise<T> {
  const { policy, identity, store } = bankingAdmission(principal);
  const key = policy.stateDir + '\0' + policy.deploymentId;
  let pool = pools.get(key);
  if (!pool) { pool = { active: 0, pending: new Map(), queue: [] }; pools.set(key, pool); }
  const subject = createHash('sha256').update(identity.issuer + '\0' + identity.subject).digest('hex');
  const count = pool.pending.get(subject) ?? 0;
  if (count >= policy.maxPendingPerSubject
    || (pool.active >= policy.maxActiveRuns && pool.queue.length >= policy.maxQueuedRuns)) {
    throw new BankingError('banking_busy', 429);
  }
  pool.pending.set(subject, count + 1);
  let reserved = false;
  try {
    if (pool.active >= policy.maxActiveRuns) {
      await new Promise<void>((resolve, reject) => {
        const wake = () => { clearTimeout(timer); reserved = true; resolve(); };
        const timer = setTimeout(() => {
          const index = pool!.queue.indexOf(wake);
          if (index >= 0) pool!.queue.splice(index, 1);
          reject(new BankingError('authorization_expired', 401));
        }, Math.max(1, identity.expires * 1000 - Date.now()));
        pool!.queue.push(wake);
      });
    } else {
      pool.active++;
      reserved = true;
    }
    await store.assertSession(identity);
    return await task();
  } finally {
    const nextCount = (pool.pending.get(subject) ?? 1) - 1;
    if (nextCount) pool.pending.set(subject, nextCount); else pool.pending.delete(subject);
    if (reserved) {
      const next = pool.queue.shift();
      if (next) next(); else pool.active--;
    }
  }
}
