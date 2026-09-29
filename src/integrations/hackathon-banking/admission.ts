import { createHash } from 'node:crypto';
import { bankingAdmission, type BankingPrincipal } from './authority';
import { acceptBankingJob, activateBankingJob, reserveBankingJob, assertBankingJobLease, bankingJob,
  finishBankingJob, type BankingAcceptedJob } from './executionLease';
import { registerBankingActiveRun } from './controllers';
import { BankingError } from './errors';

interface Slot {
  job: BankingAcceptedJob;
  phase: 'queued' | 'waking' | 'active' | 'terminal';
  taskStarted: boolean;
  settled: boolean;
  reserved: boolean;
  ready: Promise<void>;
  wake: () => void;
  terminated: Promise<never>;
  timer?: ReturnType<typeof setTimeout>;
  release: () => void;
}
interface Pool { active: number; pending: Map<string, number>; queue: Slot[] }
const root = globalThis as typeof globalThis & { __flujoBankingPools?: Map<string, Pool> };
const pools = root.__flujoBankingPools ??= new Map();

export async function withBankingAdmission<T>(principal: BankingPrincipal,
  options: { conversationId: string; existingOwner: boolean; signal: AbortSignal },
  task: (job: BankingAcceptedJob) => Promise<T>): Promise<T> {
  const { policy, identity } = bankingAdmission(principal);
  const key = policy.stateDir + '\0' + policy.deploymentId;
  let pool = pools.get(key);
  if (!pool) { pool = { active: 0, pending: new Map(), queue: [] }; pools.set(key, pool); }
  const currentPool = pool;
  const subject = createHash('sha256').update(identity.issuer + '\0' + identity.subject).digest('hex');
  const controller = new AbortController();
  const abortRequest = () => controller.abort(new BankingError('banking_run_cancelled', 409));
  options.signal.addEventListener('abort', abortRequest, { once: true });
  if (options.signal.aborted) abortRequest();
  let slot: Slot | undefined;

  function invalidate(current: Slot): void {
    if (current.phase === 'terminal') return;
    current.phase = 'terminal';
    clearTimeout(current.timer);
    current.release();
    finishBankingJob(current.job);
  }

  function settle(current: Slot): void {
    if (current.settled) return;
    current.settled = true;
    invalidate(current);
    const index = currentPool.queue.indexOf(current);
    if (index >= 0) currentPool.queue.splice(index, 1);
    const remaining = (currentPool.pending.get(subject) ?? 1) - 1;
    if (remaining) currentPool.pending.set(subject, remaining); else currentPool.pending.delete(subject);
    if (current.reserved) {
      current.reserved = false;
      const next = currentPool.queue.shift();
      if (next) {
        next.reserved = true; // Ownership transfers before asynchronous wake guards.
        next.phase = 'waking';
        next.wake();
      } else currentPool.active--;
    }
  }

  try {
    // Release the session lock before waiting. The grant has no awaits between
    // the final authority check and capacity reservation, minting and enqueueing.
    const accepted = await acceptBankingJob(principal, options.conversationId, options.existingOwner,
      controller.signal, mint => {
        const count = currentPool.pending.get(subject) ?? 0;
        if (count >= policy.maxPendingPerSubject
          || (currentPool.active >= policy.maxActiveRuns && currentPool.queue.length >= policy.maxQueuedRuns)) {
          throw new BankingError('banking_busy', 429);
        }
        const job = mint();
        let readySlot!: () => void;
        let reject!: (error: BankingError) => void;
        const ready = new Promise<void>(resolve => { readySlot = resolve; });
        const terminated = new Promise<never>((_resolve, fail) => { reject = fail; });
        // Cancellation can arrive before acceptance releases its session lock.
        void terminated.catch(() => undefined);
        const current: Slot = { job, phase: 'queued', reserved: false, taskStarted: false, settled: false,
          ready, wake: () => {
            try {
              reserveBankingJob(job);
              clearTimeout(current.timer);
              current.timer = setTimeout(() => controller.abort(new BankingError('banking_run_cancelled', 409)),
                Math.max(1, bankingJob(job).activeDeadline! * 1000 - Date.now()));
              readySlot();
            } catch (error) {
              controller.abort(error instanceof BankingError ? error : new BankingError('banking_unavailable', 503));
            }
          }, terminated, release: () => undefined };
        slot = current;
        currentPool.pending.set(subject, count + 1);
        const unregister = registerBankingActiveRun(principal, options.conversationId, controller);
        const abort = () => {
          const error = controller.signal.reason instanceof BankingError
            ? controller.signal.reason : new BankingError('banking_run_cancelled', 409);
          reject(error);
          invalidate(current);
          // Waking guards have not launched work. Active work retains capacity
          // until its task and provider cleanup have actually unwound.
          if (!current.taskStarted) settle(current);
        };
        controller.signal.addEventListener('abort', abort, { once: true });
        current.release = () => { unregister(); controller.signal.removeEventListener('abort', abort); };
        current.timer = setTimeout(() => controller.abort(new BankingError('authorization_expired', 401)),
          Math.max(1, bankingJob(job).queueDeadline * 1000 - Date.now()));
        if (currentPool.active < policy.maxActiveRuns) {
          currentPool.active++;
          current.reserved = true;
          current.phase = 'waking';
          current.wake();
        } else currentPool.queue.push(current);
        return { slot: current };
      });
    const current = accepted.slot;
    const execution = (async () => {
      try {
        await current.ready;
        if (current.phase === 'terminal') throw new BankingError('banking_run_cancelled', 409);
        await activateBankingJob(current.job);
        assertBankingJobLease(current.job, 'active');
        if (controller.signal.aborted) throw new BankingError('banking_run_cancelled', 409);
        current.phase = 'active';
        current.taskStarted = true;
        const result = await task(current.job);
        assertBankingJobLease(current.job, 'active');
        return result;
      } finally { settle(current); }
    })();
    return await Promise.race([execution, current.terminated]);
  } finally {
    if (slot && !slot.taskStarted) settle(slot);
    options.signal.removeEventListener('abort', abortRequest);
  }
}
