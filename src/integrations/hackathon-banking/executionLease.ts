import canonicalize from 'canonicalize';
import { BankingError } from './errors';
import { requireBankingPolicy, type BankingPolicy } from './policy';
import { conversationPattern, type BankingStore, type Identity } from './store';
import { bankingAdmission, assertBankingPrincipalCurrent, assertBankingPrincipalFresh,
  type BankingPrincipal } from './authority';

declare const acceptedJobBrand: unique symbol;
/** In-memory authority for accepted work; never request, transcript or persisted state. */
export interface BankingAcceptedJob { readonly [acceptedJobBrand]: true }
export interface BankingJobRecord {
  readonly identity: Readonly<Identity>;
  readonly policy: BankingPolicy;
  readonly store: BankingStore;
  readonly conversation: string;
  readonly existingOwner: boolean;
  readonly signal: AbortSignal;
  readonly acceptedAt: number;
  readonly queueDeadline: number;
  readonly totalDeadline: number;
  readonly activeDeadline?: number;
  readonly phase: 'queued' | 'waking' | 'active';
}
const shared = globalThis as typeof globalThis & { __flujoBankingJobs?: {
  records: WeakMap<object, BankingJobRecord>; minted: WeakSet<object>;
} };
const registry = shared.__flujoBankingJobs ??= { records: new WeakMap(), minted: new WeakSet() };

export function bankingJob(job: BankingAcceptedJob): BankingJobRecord {
  const record = job && registry.records.get(job);
  if (!record) throw new BankingError('trusted_banking_job_required');
  return record;
}

/** Recheck synchronous fences after every awaited read, regardless of delayed timers. */
export function assertBankingJobLease(job: BankingAcceptedJob, phase?: BankingJobRecord['phase']): BankingJobRecord {
  const record = bankingJob(job);
  if (phase && record.phase !== phase) throw new BankingError('banking_job_phase_invalid', 409);
  if (canonicalize(requireBankingPolicy()) !== canonicalize(record.policy)) {
    throw new BankingError('banking_policy_changed', 409);
  }
  if (record.signal.aborted) throw new BankingError('banking_run_cancelled', 409);
  const now = Date.now() / 1000;
  if (now >= record.identity.sessionExpires || now >= record.totalDeadline
    || (record.phase === 'queued' && now >= record.queueDeadline)
    || (record.phase !== 'queued' && now >= record.activeDeadline!)) {
    throw new BankingError('authorization_expired', 401);
  }
  return record;
}

/** The grant callback must synchronously decide capacity, mint, register and enqueue. */
export async function acceptBankingJob<T>(principal: BankingPrincipal, conversation: string,
  existingOwner: boolean, signal: AbortSignal, grant: (mint: () => BankingAcceptedJob) => T): Promise<T> {
  if (!conversationPattern.test(conversation)) throw new BankingError('conversation_unavailable', 404);
  const admission = bankingAdmission(principal);
  return admission.store.withLock('session:' + admission.identity.session, async () => {
    await assertBankingPrincipalCurrent(principal);
    if (existingOwner) await admission.store.assertOwner(conversation, admission.identity);
    assertBankingPrincipalFresh(principal, signal);
    let accepting = true;
    let job: BankingAcceptedJob | undefined;
    const mint = () => {
      if (!accepting || job) throw new BankingError('banking_job_phase_invalid', 409);
      // Capacity checks may run synchronously in grant; freshness is checked
      // again at the actual mint, with no await between mint and registration.
      assertBankingPrincipalFresh(principal, signal);
      const acceptedAt = Date.now() / 1000;
      job = Object.freeze({}) as BankingAcceptedJob;
      const record: BankingJobRecord = Object.freeze({ ...admission, conversation, existingOwner, signal,
        acceptedAt, queueDeadline: Math.min(acceptedAt + admission.policy.maxQueueWaitSeconds, admission.identity.sessionExpires),
        totalDeadline: Math.min(acceptedAt + admission.policy.maxQueueWaitSeconds + Math.min(admission.policy.maxRunSeconds, 110),
          acceptedAt + 410, admission.identity.sessionExpires), phase: 'queued' });
      registry.records.set(job, record); registry.minted.add(job);
      return job;
    };
    try {
      const result = grant(mint);
      // Returning { waiter } releases this lock before waiting on admission.
      if (result && typeof (result as { then?: unknown }).then === 'function') {
        throw new BankingError('banking_job_async_grant_forbidden', 409);
      }
      return result;
    } catch (error) {
      if (job) finishBankingJob(job);
      throw error;
    } finally { accepting = false; }
  });
}

/** Capture the active budget at slot assignment, before any awaited wake checks. */
export function reserveBankingJob(job: BankingAcceptedJob): void {
  const current = assertBankingJobLease(job, 'queued');
  const activeDeadline = Math.min(Date.now() / 1000 + Math.min(current.policy.maxRunSeconds, 110),
    current.totalDeadline, current.identity.sessionExpires);
  registry.records.set(job, Object.freeze({ ...current, phase: 'waking', activeDeadline }));
}

/** A reservation belongs to admission before this function performs any awaited checks. */
export async function activateBankingJob(job: BankingAcceptedJob): Promise<void> {
  const record = assertBankingJobLease(job, 'waking');
  await record.store.assertExecutionSession(job);
  if (record.existingOwner) await record.store.assertExecutionOwner(record.conversation, job);
  const current = assertBankingJobLease(job, 'waking');
  registry.records.set(job, Object.freeze({ ...current, phase: 'active' }));
}

/** Idempotent cleanup invalidates every retained run context backed by this job. */
export function finishBankingJob(job: BankingAcceptedJob): void {
  if (!job || !registry.minted.has(job)) throw new BankingError('trusted_banking_job_required');
  registry.records.delete(job);
}
