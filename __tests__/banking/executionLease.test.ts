import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { jwtVerify } from 'jose';
import { bankingFixture } from '../executionExtensions/bankingFixture';
import { authenticateBankingRequest, bankingAdmission, assertBankingPrincipalCurrent,
  createBankingRunContext, bindBankingRun, signBankingCall, revokeBankingSession,
  type BankingPrincipal } from '@/integrations/hackathon-banking/authority';
import { acceptBankingJob, activateBankingJob, reserveBankingJob, assertBankingJobLease, bankingJob, finishBankingJob,
  type BankingAcceptedJob } from '@/integrations/hackathon-banking/executionLease';
import { requireBankingPolicy } from '@/integrations/hackathon-banking/policy';

jest.mock('@/integrations/hackathon-banking/localControl', () => ({ propagateBankingRevocation: jest.fn(async () => undefined) }));

describe('accepted banking work has separate bounded authority', () => {
  let fixture: Awaited<ReturnType<typeof bankingFixture>>;
  let clock: number;
  const jobs: BankingAcceptedJob[] = [];
  beforeEach(async () => {
    fixture = await bankingFixture(); clock = Date.now(); jobs.length = 0;
    jest.spyOn(Date, 'now').mockImplementation(() => clock);
  });
  afterEach(async () => {
    for (const job of jobs) finishBankingJob(job);
    jest.restoreAllMocks(); await fixture.close();
  });
  async function principal(overrides: Record<string, unknown> = {}) {
    return authenticateBankingRequest(await fixture.request('A', undefined, undefined, undefined, overrides));
  }
  async function accept(owner?: BankingPrincipal, existingOwner = false, controller = new AbortController()) {
    owner ??= await principal();
    const id = randomUUID();
    const admission = bankingAdmission(owner);
    if (existingOwner) await admission.store.createConversation(id, admission.identity);
    const { job } = await acceptBankingJob(owner, id, existingOwner, controller.signal, mint => ({ job: mint() }));
    jobs.push(job);
    return { job, id, principal: owner, controller, ...admission };
  }
  async function activate(job: BankingAcceptedJob) {
    reserveBankingJob(job);
    await activateBankingJob(job);
  }
  async function active() {
    const accepted = await accept(); await activate(accepted.job);
    await accepted.store.createExecutionConversation(accepted.id, accepted.job);
    const context = await createBankingRunContext(accepted.job);
    await bindBankingRun(context, accepted.id, randomUUID());
    return { ...accepted, context };
  }

  test('queue policy defaults/caps300 while schema compatibility keeps run300 and effective work110', async () => {
    expect(requireBankingPolicy().maxQueueWaitSeconds).toBe(300);
    Object.assign(fixture.policy, { maxRunSeconds: 300, maxQueueWaitSeconds: 300 });
    await fs.writeFile(fixture.configFile, JSON.stringify(fixture.policy));
    const accepted = await accept();
    expect(bankingJob(accepted.job).totalDeadline - bankingJob(accepted.job).acceptedAt).toBe(410);
    await activate(accepted.job);
    expect(bankingJob(accepted.job).activeDeadline! - clock / 1000).toBe(110);
    Object.assign(fixture.policy, { maxQueueWaitSeconds: 301 });
    await fs.writeFile(fixture.configFile, JSON.stringify(fixture.policy));
    expect(() => requireBankingPolicy()).toThrow('banking_configuration_unavailable');
  });

  test('accepted queue work survives ingress expiry without making its original request valid', async () => {
    const accepted = await accept(); const originalExpiry = accepted.identity.expires;
    clock += 121000;
    await expect(assertBankingPrincipalCurrent(accepted.principal)).rejects.toThrow('authorization_expired');
    await expect(accepted.store.assertOwner(accepted.id, accepted.identity)).rejects.toThrow('authorization_expired');
    expect(Object.isFrozen(accepted.identity)).toBe(true);
    expect(accepted.identity.expires).toBe(originalExpiry);
    await activate(accepted.job);
    await accepted.store.createExecutionConversation(accepted.id, accepted.job);
    await expect(accepted.store.assertExecutionOwner(accepted.id, accepted.job)).resolves.toBeUndefined();
  });

  test('an expired request cannot grant authority after awaited session validation', async () => {
    const owner = await principal(); const { store } = bankingAdmission(owner);
    const original = store.assertSession.bind(store);
    jest.spyOn(store, 'assertSession').mockImplementationOnce(async identity => {
      await original(identity); clock += 121000;
    });
    const grant = jest.fn((mint: () => BankingAcceptedJob) => ({ job: mint() }));
    await expect(acceptBankingJob(owner, randomUUID(), false, new AbortController().signal, grant))
      .rejects.toThrow('authorization_expired');
    expect(grant).not.toHaveBeenCalled();
  });

  test('policy or signal changes in awaited owner validation prevent the final grant', async () => {
    const owner = await principal(); const { store, identity } = bankingAdmission(owner);
    const id = randomUUID(); await store.createConversation(id, identity);
    const controller = new AbortController();
    const original = store.assertOwner.bind(store);
    jest.spyOn(store, 'assertOwner').mockImplementationOnce(async (...args) => {
      await original(...args); controller.abort();
    });
    const grant = jest.fn();
    await expect(acceptBankingJob(owner, id, true, controller.signal, grant)).rejects.toThrow('banking_run_cancelled');
    expect(grant).not.toHaveBeenCalled();
    jest.spyOn(store, 'assertOwner').mockImplementationOnce(async (...args) => {
      await original(...args); fixture.policy.graphHash = 'f'.repeat(64);
      await fs.writeFile(fixture.configFile, JSON.stringify(fixture.policy));
    });
    await expect(acceptBankingJob(owner, id, true, new AbortController().signal, grant)).rejects.toThrow('banking_policy_changed');
    expect(grant).not.toHaveBeenCalled();
  });

  test('mint checks freshness after the synchronous capacity decision and rejects escaped/async grants', async () => {
    const owner = await principal();
    await expect(acceptBankingJob(owner, randomUUID(), false, new AbortController().signal, mint => {
      clock += 121000; return { job: mint() };
    })).rejects.toThrow('authorization_expired');
    clock -= 121000;
    let escaped!: () => BankingAcceptedJob;
    await acceptBankingJob(owner, randomUUID(), false, new AbortController().signal, mint => { escaped = mint; return {}; });
    expect(escaped).toThrow('banking_job_phase_invalid');
    let invalidated!: BankingAcceptedJob;
    await expect(acceptBankingJob(owner, randomUUID(), false, new AbortController().signal, mint => {
      invalidated = mint(); jobs.push(invalidated); return Promise.resolve(undefined);
    })).rejects.toThrow('banking_job_async_grant_forbidden');
    expect(() => bankingJob(invalidated)).toThrow('trusted_banking_job_required');
  });

  test('request principal, plain object and numeric deadline cannot be substituted for an execution job', async () => {
    const owner = await principal(); const { store } = bankingAdmission(owner);
    for (const forged of [owner, Object.freeze({}), { expires: clock / 1000 + 9999 }, clock / 1000 + 9999]) {
      await expect(store.assertExecutionSession(forged as BankingAcceptedJob)).rejects.toThrow('trusted_banking_job_required');
      await expect(createBankingRunContext(forged as BankingAcceptedJob)).rejects.toThrow('trusted_banking_job_required');
    }
  });

  test('new queued jobs have no owner and cannot execute or create one before activation', async () => {
    const accepted = await accept();
    expect(Object.keys(accepted.job)).toEqual([]); expect(Object.isFrozen(accepted.job)).toBe(true);
    expect(await accepted.store.isOwned(accepted.id)).toBe(false);
    await expect(createBankingRunContext(accepted.job)).rejects.toThrow('banking_job_phase_invalid');
    await expect(accepted.store.createExecutionConversation(accepted.id, accepted.job)).rejects.toThrow('banking_job_phase_invalid');
    expect(await accepted.store.isOwned(accepted.id)).toBe(false);
  });

  test('queue/session deadlines cannot be renewed and activation happens once', async () => {
    const accepted = await accept(); clock += 300000;
    await expect(activate(accepted.job)).rejects.toThrow('authorization_expired');
    clock -= 300000;
    await activate(accepted.job);
    const deadline = bankingJob(accepted.job).activeDeadline;
    await expect(activate(accepted.job)).rejects.toThrow('banking_job_phase_invalid');
    expect(bankingJob(accepted.job).activeDeadline).toBe(deadline);
    clock = deadline! * 1000;
    expect(() => assertBankingJobLease(accepted.job)).toThrow('authorization_expired');
  });

  test('shorter session bounds queued and active phases, and activation consumes the original total budget', async () => {
    const expiry = Math.floor(clock / 1000) + 150;
    const accepted = await accept(await principal({ exp: Math.floor(clock / 1000) + 120, session_exp: expiry }));
    expect(bankingJob(accepted.job).queueDeadline).toBe(expiry);
    expect(bankingJob(accepted.job).totalDeadline).toBe(expiry);
    clock += 130000; await activate(accepted.job);
    expect(bankingJob(accepted.job).activeDeadline).toBe(expiry);
    clock = expiry * 1000;
    await expect(accepted.store.assertExecutionSession(accepted.job)).rejects.toThrow('authorization_expired');
  });

  test('wake validation consumes the captured active budget and cannot execute in the waking phase', async () => {
    const accepted = await accept();
    reserveBankingJob(accepted.job);
    const deadline = bankingJob(accepted.job).activeDeadline;
    await expect(createBankingRunContext(accepted.job)).rejects.toThrow('banking_job_phase_invalid');
    await expect(accepted.store.createExecutionConversation(accepted.id, accepted.job)).rejects.toThrow('banking_job_phase_invalid');
    const original = accepted.store.assertExecutionSession.bind(accepted.store);
    jest.spyOn(accepted.store, 'assertExecutionSession').mockImplementationOnce(async job => {
      await original(job); clock += 90000;
    });
    await activateBankingJob(accepted.job);
    expect(bankingJob(accepted.job).activeDeadline).toBe(deadline);
    expect(deadline! - clock / 1000).toBe(20);
    clock = deadline! * 1000;
    await expect(accepted.store.createExecutionConversation(accepted.id, accepted.job)).rejects.toThrow('authorization_expired');
    expect(await accepted.store.isOwned(accepted.id)).toBe(false);
  });

  test('a configured shorter active budget also bounds the original total deadline', async () => {
    Object.assign(fixture.policy, { maxRunSeconds: 7, maxQueueWaitSeconds: 13 });
    await fs.writeFile(fixture.configFile, JSON.stringify(fixture.policy));
    const accepted = await accept(); const record = bankingJob(accepted.job);
    expect(record.totalDeadline - record.acceptedAt).toBe(20);
    clock += 12000; reserveBankingJob(accepted.job);
    expect(bankingJob(accepted.job).activeDeadline! - clock / 1000).toBe(7);
    await activateBankingJob(accepted.job);
  });

  test.each(['finish', 'abort', 'expiry'] as const)('late awaited activation cannot resurrect %s work', async reason => {
    const accepted = await accept();
    const original = accepted.store.assertExecutionSession.bind(accepted.store);
    jest.spyOn(accepted.store, 'assertExecutionSession').mockImplementationOnce(async job => {
      await original(job);
      if (reason === 'finish') finishBankingJob(job);
      if (reason === 'abort') accepted.controller.abort();
      if (reason === 'expiry') clock += 300000;
    });
    await expect(activate(accepted.job)).rejects.toThrow();
    expect(await accepted.store.isOwned(accepted.id)).toBe(false);
  });

  test('durable revocation wins acceptance and callback follows its tombstone before propagation', async () => {
    const owner = await principal(); const { store, identity } = bankingAdmission(owner);
    const order: string[] = [];
    const revoke = store.revoke.bind(store);
    jest.spyOn(store, 'revoke').mockImplementation(async value => { await revoke(value); order.push('durable'); });
    await revokeBankingSession(owner, () => order.push('abort-all'));
    expect(order).toEqual(['durable', 'abort-all']);
    const grant = jest.fn();
    await expect(acceptBankingJob(owner, randomUUID(), false, new AbortController().signal, grant)).rejects.toThrow('authorization_expired');
    expect(grant).not.toHaveBeenCalled();
    await expect(store.assertSession(identity)).rejects.toThrow('authorization_expired');
  });

  test('an accepted continuation cannot wake after owner deletion or private policy replacement', async () => {
    const accepted = await accept(await principal(), true);
    await accepted.store.tombstone(accepted.id, accepted.identity);
    await expect(activate(accepted.job)).rejects.toThrow('conversation_unavailable');
    const other = await accept(); fixture.policy.graphHash = 'f'.repeat(64);
    await fs.writeFile(fixture.configFile, JSON.stringify(fixture.policy));
    await expect(activate(other.job)).rejects.toThrow('banking_policy_changed');
  });

  test('cross-module jobs share authority, while finishing invalidates retained contexts and signing', async () => {
    const accepted = await active();
    let isolated!: typeof import('@/integrations/hackathon-banking/executionLease');
    jest.isolateModules(() => { isolated = require('@/integrations/hackathon-banking/executionLease'); });
    expect(isolated.bankingJob(accepted.job).conversation).toBe(accepted.id);
    isolated.finishBankingJob(accepted.job);
    await expect(signBankingCall(accepted.context, fixture.policy.bankServerName, 'list_my_transactions', {}))
      .rejects.toThrow('trusted_banking_job_required');
    await expect(createBankingRunContext(accepted.job)).rejects.toThrow('trusted_banking_job_required');
  });

  test('bank call JWT retains its profile after request expiry and clamps to active/job/session time', async () => {
    const accepted = await accept(); clock += 121000; await activate(accepted.job);
    await accepted.store.createExecutionConversation(accepted.id, accepted.job);
    const context = await createBankingRunContext(accepted.job); await bindBankingRun(context, accepted.id, randomUUID());
    clock += 90000;
    const token = await signBankingCall(context, fixture.policy.bankServerName, 'list_my_transactions', {});
    const verified = await jwtVerify(token, fixture.bank.publicKey, { currentDate: new Date(clock) });
    expect(verified.protectedHeader.typ).toBe('bank-mcp+jwt');
    expect(verified.payload.exp).toBe(Math.floor(bankingJob(accepted.job).activeDeadline!));
    expect(verified.payload.exp! - verified.payload.iat!).toBeLessThanOrEqual(60);
    expect(Object.keys(verified.payload).sort()).toEqual(['args_sha256', 'aud', 'conversation_id', 'exp', 'graph_revision',
      'iat', 'iss', 'jti', 'nbf', 'run_id', 'scope', 'session_id', 'sub', 'tool'].sort());
    expect(JSON.stringify(accepted.job)).toBe('{}');
    expect(JSON.stringify({ context })).not.toContain(token);
  });

  test('finishing work during an awaited signing key read prevents returning a bank assertion', async () => {
    const accepted = await active();
    const original = fs.readFile.bind(fs);
    jest.spyOn(fs, 'readFile').mockImplementation(async (...args: Parameters<typeof fs.readFile>) => {
      const value = await original(...args);
      if (args[0] === fixture.policy.bankSigningKeyFile) finishBankingJob(accepted.job);
      return value;
    });
    await expect(signBankingCall(accepted.context, fixture.policy.bankServerName, 'list_my_transactions', {}))
      .rejects.toThrow('trusted_banking_job_required');
  });

  test('cancelled turn-lock wait rejects promptly without allowing a following turn past its predecessor', async () => {
    const owner = await principal(); const { store } = bankingAdmission(owner);
    let release!: () => void; let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const first = store.withLock('turn:test', async () => { started(); await new Promise<void>(resolve => { release = resolve; }); });
    await ready;
    const controller = new AbortController(); const cancelledWork = jest.fn(async () => undefined);
    const cancelled = store.withLock('turn:test', cancelledWork, controller.signal);
    const rejected = expect(cancelled).rejects.toThrow('banking_run_cancelled'); controller.abort(); await rejected;
    const following = jest.fn(async () => undefined);
    const third = store.withLock('turn:test', following);
    await Promise.resolve(); await Promise.resolve(); expect(following).not.toHaveBeenCalled();
    release(); await first; await third;
    expect(cancelledWork).not.toHaveBeenCalled(); expect(following).toHaveBeenCalledTimes(1);
    await expect(store.withLock('session:test', async () => undefined, new AbortController().signal))
      .rejects.toThrow('banking_lock_signal_forbidden');
  });
});
