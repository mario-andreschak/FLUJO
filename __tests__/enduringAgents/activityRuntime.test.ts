import { spawn } from 'child_process';
import { once } from 'events';
import { promises as fs } from 'fs';
import path from 'path';

import {
  PersonaBusyError,
  PersonaLeaseLostError,
  PersonaMailboxConflictError,
  PersonaRuntimeUnavailableError,
  assertPersonaActivityLease,
  claimNextPersonaActivity,
  completePersonaActivity,
  createPersonaFromRole,
  enqueuePersonaMailboxItem,
  listPersonaRuntimeBundle,
  releasePersonaActivityLease,
  renewPersonaActivityLease,
  type PersonaActivityClaim,
  type PersonaLeaseFence,
} from '@/backend/services/enduringAgents';
import { ENDURING_AGENT_COLLECTIONS } from '@/backend/services/enduringAgents/collections';
import {
  withIssuedPersonaRuntimeLockOperation,
  withPersonaRuntimeLock,
} from '@/backend/services/enduringAgents/runtimeLock';
import {
  behaviorRevisionId,
  hashBehaviorFlow,
  snapshotBehaviorFlow,
} from '@/backend/services/enduringAgents/behaviorRevisions';
import {
  createBehaviorRevision,
  getBehaviorRevision,
  getPersona,
  getPersonaActivity,
  getPersonaLease,
  getPersonaLeaseRecord,
  getPersonaMailboxItem,
  listBehaviorBindings,
  listPersonaMailboxItems,
  saveBehaviorBinding,
  updatePersona,
  updatePersonaWithinRuntimeLock,
} from '@/backend/services/enduringAgents/store';
import {
  BehaviorBindingSchema,
  PersonaActivitySchema,
  BehaviorRevisionSchema,
  PersonaMailboxItemSchema,
  type CreatePersonaMailboxItemInput,
  type PersonaActivity,
} from '@/shared/types/enduringAgent';
import { deleteCollectionItem, saveCollectionItem } from '@/utils/storage/backend';
import { getCurrentWorkspace, getWorkspaceDbDir, runWithWorkspace } from '@/utils/workspace';

let workspaceSequence = 0;

function inFreshWorkspace<T>(task: () => T): T {
  workspaceSequence += 1;
  return runWithWorkspace(
    `enduring-runtime-${process.pid}-${workspaceSequence}`,
    task,
  );
}

async function createJim(idempotencyKey = 'runtime-jim') {
  return createPersonaFromRole({ name: 'Jim', idempotencyKey });
}

function assignment(
  personaId: string,
  idempotencyKey: string,
  overrides: Partial<CreatePersonaMailboxItemInput> = {},
): CreatePersonaMailboxItemInput {
  return {
    personaId,
    idempotencyKey,
    kind: 'assignment',
    source: { kind: 'assignment', sourceId: `source-${idempotencyKey}` },
    summary: `Assignment ${idempotencyKey}`,
    ...overrides,
  };
}

async function claim(
  personaId: string,
  ttlMs = 10_000,
): Promise<PersonaActivityClaim> {
  const result = await claimNextPersonaActivity({ personaId, ttlMs });
  expect(result).not.toBeNull();
  return result!;
}

function fence(claimed: PersonaActivityClaim): PersonaLeaseFence {
  return {
    workspaceId: claimed.lease.workspaceId,
    personaId: claimed.lease.personaId,
    activityId: claimed.lease.activityId,
    leaseId: claimed.lease.id,
    holderId: claimed.lease.holderId,
    fencingToken: claimed.lease.fencingToken,
  };
}

const runtimeLockWaiterScript = String.raw`
  const fs = require('fs');
  const path = require('path');
  const ts = require('typescript');
  const Module = require('module');
  const root = process.cwd();
  const originalResolve = Module._resolveFilename;
  Module._resolveFilename = function(request, parent, isMain, options) {
    if (request.startsWith('@/')) request = path.join(root, 'src', request.slice(2));
    return originalResolve.call(this, request, parent, isMain, options);
  };
  require.extensions['.ts'] = function(module, filename) {
    const outputText = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true,
      },
      fileName: filename,
    }).outputText;
    module._compile(outputText, filename);
  };
  const workspace = process.argv[1];
  const personaId = process.argv[2];
  const eventPath = process.argv[3];
  const holdMs = Number(process.argv[4]);
  const expectedLockPath = process.argv[5];
  const recoveryBarrierPath = process.argv[6];
  if (recoveryBarrierPath) {
    fs.mkdirSync(recoveryBarrierPath, { recursive: true });
    const originalLink = fs.promises.link.bind(fs.promises);
    let reachedRecoveryBarrier = false;
    fs.promises.link = async function(existingPath, targetPath) {
      const target = String(targetPath);
      const recoveryPrefix = expectedLockPath + '.recovery.';
      if (
        !reachedRecoveryBarrier
        && target.startsWith(recoveryPrefix)
        && /^[0-9a-f-]{36}$/i.test(target.slice(recoveryPrefix.length))
      ) {
        reachedRecoveryBarrier = true;
        fs.writeFileSync(path.join(recoveryBarrierPath, process.pid + '.ready'), '');
        const deadline = Date.now() + 5000;
        while (fs.readdirSync(recoveryBarrierPath).filter((name) => name.endsWith('.ready')).length < 2) {
          if (Date.now() >= deadline) throw new Error('Timed out at recovery barrier.');
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      return originalLink(existingPath, targetPath);
    };
  }
  const { getWorkspaceDbDir, runWithWorkspace } = require('./src/utils/workspace.ts');
  const { withPersonaRuntimeLock } = require(
    './src/backend/services/enduringAgents/runtimeLock.ts'
  );
  runWithWorkspace(workspace, () => {
    const actualLockPath = path.join(
      getWorkspaceDbDir(),
      '.runtime-locks',
      'enduring-agents',
      personaId + '.lock',
    );
    if (path.resolve(actualLockPath) !== path.resolve(expectedLockPath)) {
      throw new Error('Child lock path mismatch: ' + actualLockPath + ' != ' + expectedLockPath);
    }
    return withPersonaRuntimeLock(personaId, async (lock) => {
    fs.appendFileSync(eventPath, 'ENTER ' + process.pid + '\n');
    await new Promise((resolve) => setTimeout(resolve, holdMs));
    await lock.assertOwned();
    fs.appendFileSync(eventPath, 'EXIT ' + process.pid + '\n');
    });
  }).then(() => process.exit(0)).catch((error) => {
    process.stderr.write(String(error && error.stack || error));
    process.exit(1);
  });
`;

function spawnRuntimeLockWaiter(
  workspace: string,
  personaId: string,
  eventPath: string,
  holdMs: number,
  lockPath: string,
  dataRoot: string,
  recoveryBarrierPath = '',
): Promise<void> {
  const child = spawn(process.execPath, [
    '-e',
    runtimeLockWaiterScript,
    workspace,
    personaId,
    eventPath,
    String(holdMs),
    lockPath,
    recoveryBarrierPath,
  ], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, FLUJO_DATA_DIR: dataRoot },
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });
  return new Promise((resolve, reject) => {
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Runtime-lock waiter exited ${code}: ${stderr}`));
    });
    child.once('error', reject);
  });
}

async function expectFileToDisappear(filePath: string): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      await fs.access(filePath);
    } catch (error) {
      expect(error).toMatchObject({ code: 'ENOENT' });
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`File did not disappear after lock release: ${filePath}`);
}

async function spawnLiveUnrelatedProcess(): Promise<ReturnType<typeof spawn>> {
  const child = spawn(process.execPath, [
    '-e',
    "process.stdout.write('READY\\n'); setInterval(() => {}, 1000);",
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise<void>((resolve, reject) => {
    child.stdout.on('data', (chunk) => {
      if (String(chunk).includes('READY')) resolve();
    });
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`Unrelated child exited early: ${code}`)));
  });
  return child;
}

async function stopChild(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill();
  await once(child, 'exit');
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('enduring-agent Activity runtime', () => {
  it('admits retries by a hashed deterministic key and rejects changed duplicate work', async () => {
    await inFreshWorkspace(async () => {
      const { persona } = await createJim();
      const input = assignment(persona.id, 'raw-retry-token', {
        source: {
          kind: 'assignment',
          sourceId: 'ticket-415',
          idempotencyKey: 'raw-source-retry-token',
        },
      });

      const first = await enqueuePersonaMailboxItem(input);
      const retry = await enqueuePersonaMailboxItem(input);

      expect(first.duplicate).toBe(false);
      expect(retry).toEqual({ item: first.item, duplicate: true });
      expect(first.item.idempotencyKey).toMatch(/^[a-f0-9]{64}$/);
      expect(first.item.idempotencyKey).not.toContain('raw-retry-token');
      expect(first.item.source.idempotencyKey).toMatch(/^[a-f0-9]{64}$/);
      expect(first.item.behaviorSlotKey).toBe('primary');
      expect(first.item.sequence).toBe(1);
      await expect(enqueuePersonaMailboxItem({
        ...input,
        summary: 'Different work under the same retry key',
      })).rejects.toBeInstanceOf(PersonaMailboxConflictError);
    });
  });

  it('orders eligible work by priority, then readiness/FIFO, and honors notBefore inclusively', async () => {
    await inFreshWorkspace(async () => {
      const now = 100_000;
      const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(now);
      const { persona } = await createJim('runtime-ordering-jim');
      await enqueuePersonaMailboxItem(assignment(persona.id, 'normal'));
      await enqueuePersonaMailboxItem(assignment(persona.id, 'normal-second'));
      await enqueuePersonaMailboxItem(assignment(persona.id, 'urgent', { priority: 'urgent' }));
      await enqueuePersonaMailboxItem(assignment(persona.id, 'future', {
        priority: 'high',
        notBefore: now + 1_000,
      }));

      const urgent = await claim(persona.id);
      expect(urgent.mailboxItem.summary).toBe('Assignment urgent');
      await completePersonaActivity(fence(urgent));

      const normal = await claim(persona.id);
      expect(normal.mailboxItem.summary).toBe('Assignment normal');
      await completePersonaActivity(fence(normal));

      const normalSecond = await claim(persona.id);
      expect(normalSecond.mailboxItem.summary).toBe('Assignment normal-second');
      expect(normalSecond.mailboxItem.sequence).toBeGreaterThan(normal.mailboxItem.sequence);
      await completePersonaActivity(fence(normalSecond));
      await expect(claimNextPersonaActivity({
        personaId: persona.id,
        ttlMs: 10_000,
      })).resolves.toBeNull();

      nowSpy.mockReturnValue(now + 1_000);
      const future = await claim(persona.id);
      expect(future.mailboxItem.summary).toBe('Assignment future');
    });
  });

  it('keeps independent work queued while busy and drains it after completion', async () => {
    await inFreshWorkspace(async () => {
      const { persona } = await createJim('runtime-queue-jim');
      const firstItem = await enqueuePersonaMailboxItem(assignment(persona.id, 'first'));
      const secondItem = await enqueuePersonaMailboxItem(assignment(persona.id, 'second'));
      const first = await claim(persona.id);

      await expect(updatePersona({
        ...(await getPersona(persona.id))!,
        lifecycleState: 'sleeping',
        updatedAt: Date.now(),
      })).rejects.toThrow(/holds its lease/i);

      await expect(claimNextPersonaActivity({
        personaId: persona.id,
        ttlMs: 10_000,
      })).rejects.toBeInstanceOf(PersonaBusyError);
      expect((await listPersonaMailboxItems(persona.id)).find(
        (item) => item.id === secondItem.item.id,
      )?.status).toBe('queued');

      const completed = await completePersonaActivity(fence(first));
      expect(completed.activity.status).toBe('completed');
      expect(completed.mailboxItem.status).toBe('completed');
      expect(completed.lease.status).toBe('released');

      const second = await claim(persona.id);
      expect(second.mailboxItem.id).toBe(secondItem.item.id);
      expect(second.mailboxItem.id).not.toBe(firstItem.item.id);
      expect(second.lease.fencingToken).toBe(first.lease.fencingToken + 1);
      expect(await getPersonaLeaseRecord(first.lease.id)).toMatchObject({
        id: first.lease.id,
        status: 'released',
      });
      await expect(assertPersonaActivityLease(fence(first)))
        .rejects.toBeInstanceOf(PersonaLeaseLostError);
    });
  });

  it('rejects a structurally forged runtime lock at the lifecycle write boundary', async () => {
    await inFreshWorkspace(async () => {
      const { persona } = await createJim('runtime-forged-lock-jim');
      const { persona: otherPersona } = await createJim('runtime-other-lock-jim');
      await expect(updatePersonaWithinRuntimeLock({
        ...persona,
        lifecycleState: 'disabled',
        updatedAt: persona.updatedAt + 1,
      }, {
        assertOwned: async () => undefined,
      })).rejects.toThrow(/runtime lock/i);
      await withPersonaRuntimeLock(persona.id, async (lock) => {
        await expect(updatePersonaWithinRuntimeLock({
          ...otherPersona,
          lifecycleState: 'disabled',
          updatedAt: otherPersona.updatedAt + 1,
        }, lock)).rejects.toThrow(/runtime lock/i);
        await runWithWorkspace(`${getCurrentWorkspace()}-other`, async () => {
          await expect(updatePersonaWithinRuntimeLock({
            ...persona,
            lifecycleState: 'disabled',
            updatedAt: persona.updatedAt + 1,
          }, lock)).rejects.toThrow(/runtime lock/i);
        });
      });
      expect((await getPersona(persona.id))?.lifecycleState).toBe('idle');
      expect((await getPersona(otherPersona.id))?.lifecycleState).toBe('idle');
    });
  });

  it('retries a transient recovery-intent filesystem conflict during release', async () => {
    await inFreshWorkspace(async () => {
      const { persona } = await createJim('runtime-transient-release-jim');
      await enqueuePersonaMailboxItem(assignment(persona.id, 'transient-release'));
      const originalLink = fs.link.bind(fs);
      let injected = false;
      jest.spyOn(fs, 'link').mockImplementation(async (existingPath, targetPath) => {
        if (!injected && String(targetPath).includes('.lock.recovery.')) {
          injected = true;
          throw Object.assign(new Error('transient sharing conflict'), { code: 'EBUSY' });
        }
        return originalLink(existingPath, targetPath);
      });

      const claimed = await claim(persona.id);
      expect(injected).toBe(true);
      expect(claimed.activity.status).toBe('running');
    });
  });

  it('keeps the physical lock until a detached issued operation drains', async () => {
    await inFreshWorkspace(async () => {
      const { persona } = await createJim('runtime-detached-operation-jim');
      let enterOperation!: () => void;
      let finishOperation!: () => void;
      const operationEntered = new Promise<void>((resolve) => { enterOperation = resolve; });
      const operationGate = new Promise<void>((resolve) => { finishOperation = resolve; });
      let detachedOperation!: Promise<void>;
      let lockRunSettled = false;

      const lockRun = withPersonaRuntimeLock(persona.id, async (lock) => {
        detachedOperation = withIssuedPersonaRuntimeLockOperation(
          lock,
          persona.id,
          async () => {
            enterOperation();
            await operationGate;
          },
        );
        await operationEntered;
      }).finally(() => { lockRunSettled = true; });

      await operationEntered;
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(lockRunSettled).toBe(false);
      finishOperation();
      await expect(detachedOperation).resolves.toBeUndefined();
      await expect(lockRun).resolves.toBeUndefined();
    });
  });

  it('pins the parsed Persona identity before the first locked-update await', async () => {
    await inFreshWorkspace(async () => {
      const { persona } = await createJim('runtime-stable-update-id-jim');
      const { persona: otherPersona } = await createJim('runtime-stable-update-other-jim');
      const mutableUpdate = {
        ...persona,
        lifecycleState: 'sleeping' as const,
        updatedAt: persona.updatedAt + 1,
      };
      await withPersonaRuntimeLock(persona.id, async (lock) => {
        const update = updatePersonaWithinRuntimeLock(mutableUpdate, lock);
        mutableUpdate.id = otherPersona.id;
        await update;
      });

      expect((await getPersona(persona.id))?.lifecycleState).toBe('sleeping');
      expect((await getPersona(otherPersona.id))?.lifecycleState).toBe('idle');
    });
  });

  it('allows one concurrent claimant and never reissues a live fence', async () => {
    await inFreshWorkspace(async () => {
      const { persona } = await createJim('runtime-concurrency-jim');
      await enqueuePersonaMailboxItem(assignment(persona.id, 'only-item'));

      const outcomes = await Promise.allSettled([
        claimNextPersonaActivity({ personaId: persona.id, ttlMs: 10_000 }),
        claimNextPersonaActivity({ personaId: persona.id, ttlMs: 10_000 }),
      ]);
      const fulfilled = outcomes.filter(
        (outcome): outcome is PromiseFulfilledResult<PersonaActivityClaim | null> => (
          outcome.status === 'fulfilled'
        ),
      );
      const rejected = outcomes.filter(
        (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected',
      );

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason).toBeInstanceOf(PersonaBusyError);
      expect(rejected[0].reason).not.toHaveProperty('lease');
      expect(rejected[0].reason).not.toHaveProperty('holderId');
      const winner = fulfilled[0].value!;
      await saveCollectionItem(ENDURING_AGENT_COLLECTIONS.personas, persona.id, {
        ...(await getPersona(persona.id))!,
        lifecycleState: 'idle',
      });
      await expect(claimNextPersonaActivity({
        personaId: persona.id,
        ttlMs: 10_000,
      })).rejects.toBeInstanceOf(PersonaBusyError);
      expect((await getPersona(persona.id))?.lifecycleState).toBe('busy');
      expect(await assertPersonaActivityLease(fence(winner))).toMatchObject({
        id: winner.lease.id,
      });
    });
  });

  it('waits for a live cross-process owner and recovers only after that process exits', async () => {
    await inFreshWorkspace(async () => {
      const { persona } = await createJim('runtime-process-lock-jim');
      await enqueuePersonaMailboxItem(assignment(persona.id, 'cross-process-lock'));
      const lockPath = path.join(
        getWorkspaceDbDir(),
        '.runtime-locks',
        'enduring-agents',
        `${persona.id}.lock`,
      );
      const childScript = `
        const fs = require('fs');
        const lockPath = process.argv[1];
        const workspace = process.argv[2];
        const candidate = lockPath + '.child-' + process.pid;
        const owner = {
          ownerId: '00000000-0000-4000-8000-000000000020',
          processInstanceId: 'child-instance-' + process.pid,
          pid: process.pid,
          ...(process.platform === 'linux'
            ? { processBirthMarker: 'linux:0' }
            : process.platform === 'darwin'
              ? { processBirthMarker: 'darwin:legacy-format' }
              : {}),
          workspace,
          acquiredAt: Date.now(),
        };
        fs.writeFileSync(candidate, JSON.stringify(owner), { flag: 'wx' });
        fs.linkSync(candidate, lockPath);
        fs.unlinkSync(candidate);
        process.stdout.write('READY\\n');
        setTimeout(() => process.exit(0), 600);
      `;
      const child = spawn(process.execPath, [
        '-e',
        childScript,
        lockPath,
        getCurrentWorkspace(),
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (chunk) => { stderr += String(chunk); });
      await new Promise<void>((resolve, reject) => {
        child.stdout.on('data', (chunk) => {
          if (String(chunk).includes('READY')) resolve();
        });
        child.once('exit', (code) => {
          if (code !== 0) reject(new Error(`Child lock owner exited early: ${stderr}`));
        });
        child.once('error', reject);
      });

      let claimSettled = false;
      const claimPromise = claim(persona.id).finally(() => { claimSettled = true; });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(child.exitCode).toBeNull();
      expect(claimSettled).toBe(false);
      const claimed = await claimPromise;
      if (child.exitCode === null) await once(child, 'exit');
      expect(claimed.lease.fencingToken).toBe(1);
      await expectFileToDisappear(lockPath);
    });
  });

  it('writes a versioned owner identity without the legacy mixed-reader field', async () => {
    if (!['linux', 'darwin', 'win32'].includes(process.platform)) return;
    await inFreshWorkspace(async () => {
      const { persona } = await createJim('runtime-owner-format-jim');
      const lockPath = path.join(
        getWorkspaceDbDir(), '.runtime-locks', 'enduring-agents', `${persona.id}.lock`,
      );
      await withPersonaRuntimeLock(persona.id, async (lock) => {
        const owner = JSON.parse(await fs.readFile(lockPath, 'utf8')) as Record<string, unknown>;
        expect(owner).not.toHaveProperty('processBirthMarker');
        expect(owner.processBirthMarkerV2).toEqual(expect.any(String));
        expect(String(owner.processBirthMarkerV2)).toMatch(
          new RegExp(`^${process.platform === 'win32' ? 'win32' : process.platform}-v2:`),
        );
        await lock.assertOwned();
      });
    });
  });

  it('does not confuse a reused live PID with the recorded process birth', async () => {
    if (!['linux', 'darwin', 'win32'].includes(process.platform)) return;
    await inFreshWorkspace(async () => {
      const { persona } = await createJim('runtime-pid-reuse-jim');
      await enqueuePersonaMailboxItem(assignment(persona.id, 'pid-reuse'));
      const lockRoot = path.join(
        getWorkspaceDbDir(), '.runtime-locks', 'enduring-agents',
      );
      const lockPath = path.join(lockRoot, `${persona.id}.lock`);
      const unrelated = await spawnLiveUnrelatedProcess();
      try {
        const mismatchedBirthMarker = process.platform === 'linux'
          ? 'linux-v2:00000000-0000-4000-8000-000000000000:0'
          : process.platform === 'darwin'
            ? 'darwin-v2:Mon Jan  1 00:00:00 1970'
            : 'win32-v2:0';
        await fs.writeFile(lockPath, JSON.stringify({
          ownerId: '00000000-0000-4000-8000-000000000010',
          processInstanceId: 'dead-process-instance',
          pid: unrelated.pid,
          processBirthMarkerV2: mismatchedBirthMarker,
          workspace: getCurrentWorkspace(),
          acquiredAt: Date.now(),
        }), { encoding: 'utf8', flag: 'wx' });

        const claimed = await claim(persona.id);
        expect(claimed.lease.fencingToken).toBe(1);
        expect(unrelated.exitCode).toBeNull();
      } finally {
        await stopChild(unrelated);
      }
    });
  });

  it('fails closed on a path-shaped persisted owner id', async () => {
    await inFreshWorkspace(async () => {
      const { persona } = await createJim('runtime-malformed-owner-jim');
      const lockRoot = path.join(
        getWorkspaceDbDir(), '.runtime-locks', 'enduring-agents',
      );
      const lockPath = path.join(lockRoot, `${persona.id}.lock`);
      const victimPath = path.join(lockRoot, 'must-not-delete.txt');
      await fs.writeFile(victimPath, 'preserve me', 'utf8');
      await fs.writeFile(lockPath, JSON.stringify({
        ownerId: `x${path.sep}..${path.sep}..${path.sep}must-not-delete.txt`,
        processInstanceId: 'malformed-owner-instance',
        pid: 2_147_483_647,
        workspace: getCurrentWorkspace(),
        acquiredAt: Date.now(),
      }), { encoding: 'utf8', flag: 'wx' });

      await expect(withPersonaRuntimeLock(persona.id, async () => undefined))
        .rejects.toThrow(/malformed/i);
      await expect(fs.readFile(victimPath, 'utf8')).resolves.toBe('preserve me');
    });
  });

  it('recovers an explicitly abandoned owner even while its process remains live', async () => {
    await inFreshWorkspace(async () => {
      const { persona } = await createJim('runtime-abandoned-owner-jim');
      await enqueuePersonaMailboxItem(assignment(persona.id, 'abandoned-owner'));
      const lockRoot = path.join(
        getWorkspaceDbDir(), '.runtime-locks', 'enduring-agents',
      );
      const lockPath = path.join(lockRoot, `${persona.id}.lock`);
      const ownerId = '00000000-0000-4000-8000-000000000011';
      const unrelated = await spawnLiveUnrelatedProcess();
      try {
        const owner = {
          ownerId,
          processInstanceId: 'completed-operation-instance',
          pid: unrelated.pid,
          workspace: getCurrentWorkspace(),
          acquiredAt: Date.now(),
        };
        await fs.writeFile(lockPath, JSON.stringify(owner), { encoding: 'utf8', flag: 'wx' });
        await fs.writeFile(
          `${lockPath}.abandoned.${ownerId}`,
          JSON.stringify(owner),
          { encoding: 'utf8', flag: 'wx' },
        );

        const claimed = await claim(persona.id);
        expect(claimed.lease.fencingToken).toBe(1);
        expect(unrelated.exitCode).toBeNull();
      } finally {
        await stopChild(unrelated);
      }
    });
  });

  it('serializes two cross-process waiters recovering the same dead owner', async () => {
    await inFreshWorkspace(async () => {
      const { persona } = await createJim('runtime-two-recoverers-jim');
      const lockRoot = path.join(
        getWorkspaceDbDir(),
        '.runtime-locks',
        'enduring-agents',
      );
      const lockPath = path.join(lockRoot, `${persona.id}.lock`);
      const eventPath = path.join(lockRoot, `${persona.id}.events`);
      const dataRoot = path.resolve(getWorkspaceDbDir(), '..', '..', '..');
      const deadOwnerId = '00000000-0000-4000-8000-000000000002';
      const staleRecoveryId = '00000000-0000-4000-8000-000000000001';
      const staleRecoveryPath = `${lockPath}.recovery.${staleRecoveryId}`;
      const recoveryBarrierPath = path.join(lockRoot, `${persona.id}.recovery-barrier`);
      await fs.mkdir(lockRoot, { recursive: true });
      await fs.writeFile(lockPath, JSON.stringify({
        ownerId: deadOwnerId,
        processInstanceId: 'dead-process-instance',
        pid: 2_147_483_647,
        workspace: getCurrentWorkspace(),
        acquiredAt: Date.now(),
      }), { encoding: 'utf8', flag: 'wx' });
      await fs.writeFile(staleRecoveryPath, JSON.stringify({
        ownerId: staleRecoveryId,
        processInstanceId: 'dead-recovery-instance',
        pid: 2_147_483_647,
        workspace: getCurrentWorkspace(),
        acquiredAt: Date.now(),
        targetOwnerId: deadOwnerId,
        targetProcessInstanceId: 'dead-process-instance',
        targetPid: 2_147_483_647,
      }), { encoding: 'utf8', flag: 'wx' });
      // A process may die while writing its non-authoritative candidate. Exact
      // intent-name matching must ignore this partial file forever safely.
      await fs.writeFile(
        `${staleRecoveryPath}.candidate.${staleRecoveryId}`,
        '{partial',
        { encoding: 'utf8', flag: 'wx' },
      );

      await Promise.all([
        spawnRuntimeLockWaiter(
          getCurrentWorkspace(), persona.id, eventPath, 200, lockPath, dataRoot,
          recoveryBarrierPath,
        ),
        spawnRuntimeLockWaiter(
          getCurrentWorkspace(), persona.id, eventPath, 200, lockPath, dataRoot,
          recoveryBarrierPath,
        ),
      ]);

      const events = (await fs.readFile(eventPath, 'utf8')).trim().split(/\r?\n/);
      expect(events).toHaveLength(4);
      expect(events.map((event) => event.split(' ')[0])).toEqual([
        'ENTER',
        'EXIT',
        'ENTER',
        'EXIT',
      ]);
      expect(events[0].split(' ')[1]).toBe(events[1].split(' ')[1]);
      expect(events[2].split(' ')[1]).toBe(events[3].split(' ')[1]);
      expect(events[0].split(' ')[1]).not.toBe(events[2].split(' ')[1]);
      await expectFileToDisappear(lockPath);
      await expectFileToDisappear(staleRecoveryPath);
    });
  });

  it('reacquires an explicitly yielded Activity with a higher token', async () => {
    await inFreshWorkspace(async () => {
      const { persona } = await createJim('runtime-release-jim');
      await enqueuePersonaMailboxItem(assignment(persona.id, 'yielded'));
      const first = await claim(persona.id);

      const released = await releasePersonaActivityLease(fence(first));
      expect(released.status).toBe('released');
      expect((await getPersonaActivity(first.activity.id))?.status).toBe('waiting');

      const recovered = await claim(persona.id);
      expect(recovered.recovered).toBe(true);
      expect(recovered.activity.id).toBe(first.activity.id);
      expect(recovered.lease.id).not.toBe(first.lease.id);
      expect(recovered.lease.fencingToken).toBe(first.lease.fencingToken + 1);
      await expect(releasePersonaActivityLease(fence(first)))
        .rejects.toBeInstanceOf(PersonaLeaseLostError);
      await completePersonaActivity(fence(recovered));
    });
  });

  it('finishes a yield that crashed after persisting the waiting Activity', async () => {
    await inFreshWorkspace(async () => {
      const { persona } = await createJim('runtime-waiting-release-prefix-jim');
      await enqueuePersonaMailboxItem(assignment(persona.id, 'waiting-release-prefix'));
      const active = await claim(persona.id);
      await saveCollectionItem(
        ENDURING_AGENT_COLLECTIONS.activities,
        active.activity.id,
        PersonaActivitySchema.parse({
          ...active.activity,
          status: 'waiting',
          updatedAt: Date.now(),
        }),
      );

      const resumed = await claim(persona.id);
      expect(resumed.activity.id).toBe(active.activity.id);
      expect(resumed.activity.status).toBe('running');
      expect(resumed.lease.fencingToken).toBe(active.lease.fencingToken + 1);
      expect(await getPersonaLeaseRecord(active.lease.id)).toMatchObject({ status: 'released' });
    });
  });

  it('retires an undispatched resume acquisition while preserving waiting work', async () => {
    await inFreshWorkspace(async () => {
      const { persona } = await createJim('runtime-waiting-resume-prefix-jim');
      await enqueuePersonaMailboxItem(assignment(persona.id, 'waiting-resume-prefix'));
      const first = await claim(persona.id);
      await releasePersonaActivityLease(fence(first));
      const waiting = (await getPersonaActivity(first.activity.id))!;
      const abandonedResume = await claim(persona.id);

      // New head persisted, but the waiting Activity was never repointed to it.
      await saveCollectionItem(
        ENDURING_AGENT_COLLECTIONS.activities,
        waiting.id,
        waiting,
      );
      const inspected = (await listPersonaRuntimeBundle(persona.id))!;
      expect(inspected.activities).toEqual([
        expect.objectContaining({ id: waiting.id, status: 'waiting', leaseId: first.lease.id }),
      ]);
      expect(inspected.mailboxItems).toEqual([
        expect.objectContaining({ id: first.mailboxItem.id, status: 'claimed' }),
      ]);
      expect(inspected.lease).toMatchObject({
        status: 'expired',
        fencingToken: abandonedResume.lease.fencingToken,
      });

      const resumed = await claim(persona.id);
      expect(resumed.activity.id).toBe(first.activity.id);
      expect(resumed.lease.fencingToken).toBe(abandonedResume.lease.fencingToken + 1);
    });
  });

  it('fails closed when a waiting Activity loses its released lease provenance', async () => {
    await inFreshWorkspace(async () => {
      const { persona } = await createJim('runtime-waiting-missing-provenance-jim');
      await enqueuePersonaMailboxItem(assignment(persona.id, 'waiting-missing-provenance'));
      const active = await claim(persona.id);
      await releasePersonaActivityLease(fence(active));
      await deleteCollectionItem(ENDURING_AGENT_COLLECTIONS.leases, persona.id);
      await deleteCollectionItem(ENDURING_AGENT_COLLECTIONS.leaseHistory, active.lease.id);

      await expect(claimNextPersonaActivity({ personaId: persona.id, ttlMs: 10_000 }))
        .rejects.toThrow(/released lease provenance/i);
    });
  });

  it('renews before expiry, rejects at the exact expiry boundary, and suppresses replay', async () => {
    await inFreshWorkspace(async () => {
      const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(10_000);
      const { persona } = await createJim('runtime-expiry-jim');
      await enqueuePersonaMailboxItem(assignment(persona.id, 'uncertain-active'));
      await enqueuePersonaMailboxItem(assignment(persona.id, 'safe-next'));
      const active = await claim(persona.id, 1_000);

      nowSpy.mockReturnValue(10_500);
      const renewed = await renewPersonaActivityLease({
        ...fence(active),
        ttlMs: 2_000,
      });
      expect(renewed.expiresAt).toBe(12_500);

      nowSpy.mockReturnValue(12_500);
      await expect(assertPersonaActivityLease(fence(active)))
        .rejects.toBeInstanceOf(PersonaLeaseLostError);
      expect(await getPersonaActivity(active.activity.id)).toMatchObject({
        status: 'error',
        error: expect.stringMatching(/automatic replay was suppressed/i),
      });
      expect(await getPersonaLease(persona.id)).toMatchObject({
        id: active.lease.id,
        status: 'expired',
      });

      const next = await claim(persona.id, 1_000);
      expect(next.mailboxItem.summary).toBe('Assignment safe-next');
      expect(next.lease.fencingToken).toBe(active.lease.fencingToken + 1);
      await expect(completePersonaActivity(fence(active)))
        .rejects.toBeInstanceOf(PersonaLeaseLostError);
    });
  });

  it('reconciles a shorter renewal that reached history before the lease head', async () => {
    await inFreshWorkspace(async () => {
      const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(15_000);
      const { persona } = await createJim('runtime-short-renewal-jim');
      await enqueuePersonaMailboxItem(assignment(persona.id, 'short-renewal'));
      const active = await claim(persona.id, 10_000);

      nowSpy.mockReturnValue(16_000);
      const shortened = await renewPersonaActivityLease({
        ...fence(active),
        ttlMs: 1_000,
      });
      expect(shortened.expiresAt).toBe(17_000);

      // Simulate history=new renewal being durable while head=old renewal.
      await saveCollectionItem(
        ENDURING_AGENT_COLLECTIONS.leases,
        persona.id,
        active.lease,
      );
      await expect(assertPersonaActivityLease(fence(active))).resolves.toMatchObject({
        renewedAt: 16_000,
        expiresAt: 17_000,
      });
    });
  });

  it('requeues a claim crash that occurred before the mailbox commit marker', async () => {
    await inFreshWorkspace(async () => {
      jest.spyOn(Date, 'now').mockReturnValue(20_000);
      const { persona } = await createJim('runtime-early-claim-crash-jim');
      await enqueuePersonaMailboxItem(assignment(persona.id, 'safe-to-requeue'));
      const abandoned = await claim(persona.id, 1_000);

      await saveCollectionItem(
        ENDURING_AGENT_COLLECTIONS.activities,
        abandoned.activity.id,
        PersonaActivitySchema.parse({
          ...abandoned.activity,
          status: 'queued',
          leaseId: undefined,
          startedAt: undefined,
        }),
      );
      await saveCollectionItem(
        ENDURING_AGENT_COLLECTIONS.mailboxItems,
        abandoned.mailboxItem.id,
        PersonaMailboxItemSchema.parse({
          ...abandoned.mailboxItem,
          status: 'queued',
          claimedActivityId: undefined,
        }),
      );

      const recovered = await claim(persona.id, 1_000);
      expect(recovered.mailboxItem.id).toBe(abandoned.mailboxItem.id);
      expect(recovered.activity.status).toBe('running');
      expect(recovered.activity.error).toBeUndefined();
      expect(recovered.lease.fencingToken).toBe(abandoned.lease.fencingToken + 1);
    });
  });

  it('repairs a released-history/head crash and resumes the pinned Activity', async () => {
    await inFreshWorkspace(async () => {
      const { persona } = await createJim('runtime-yield-repair-jim');
      await enqueuePersonaMailboxItem(assignment(persona.id, 'yield-repair'));
      const active = await claim(persona.id);
      await releasePersonaActivityLease(fence(active));

      // Simulate history=released being durable while the authority head still
      // contains the earlier active acquisition.
      await saveCollectionItem(
        ENDURING_AGENT_COLLECTIONS.leases,
        persona.id,
        active.lease,
      );
      const recovered = await claim(persona.id);
      expect(recovered.activity.id).toBe(active.activity.id);
      expect(recovered.activity.behaviorRevisionId).toBe(active.activity.behaviorRevisionId);
      expect(recovered.lease.fencingToken).toBe(active.lease.fencingToken + 1);
      expect(await getPersonaLeaseRecord(active.lease.id)).toMatchObject({ status: 'released' });
    });
  });

  it('resumes with the Activity-pinned Behavior after the slot binding changes', async () => {
    await inFreshWorkspace(async () => {
      const { persona } = await createJim('runtime-pinned-behavior-jim');
      await enqueuePersonaMailboxItem(assignment(persona.id, 'pinned-before-change'));
      const active = await claim(persona.id);
      await releasePersonaActivityLease(fence(active));

      const binding = (await listBehaviorBindings(persona.id)).find(
        (candidate) => candidate.slotKey === 'primary',
      )!;
      const original = (await getBehaviorRevision(binding.activeRevisionId))!;
      const flowSnapshot = snapshotBehaviorFlow({
        ...original.flowSnapshot,
        name: `${original.flowSnapshot.name} v2`,
      });
      const contentHash = hashBehaviorFlow(flowSnapshot);
      const replacement = BehaviorRevisionSchema.parse({
        ...original,
        id: behaviorRevisionId({
          personaId: persona.id,
          behaviorId: binding.id,
          revision: original.revision + 1,
          contentHash,
        }),
        revision: original.revision + 1,
        contentHash,
        flowSnapshot,
        source: { kind: 'persona_override', parentRevisionId: original.id },
        createdAt: Date.now(),
      });
      await createBehaviorRevision(replacement);
      await saveCollectionItem(ENDURING_AGENT_COLLECTIONS.behaviorBindings, binding.id, {
        ...binding,
        activeRevisionId: replacement.id,
        updatedAt: Date.now(),
      });

      const resumed = await claim(persona.id);
      expect(resumed.activity.id).toBe(active.activity.id);
      expect(resumed.activity.behaviorRevisionId).toBe(original.id);
      await completePersonaActivity(fence(resumed));

      await enqueuePersonaMailboxItem(assignment(persona.id, 'new-after-change'));
      const next = await claim(persona.id);
      expect(next.activity.behaviorRevisionId).toBe(replacement.id);
    });
  });

  it('enforces one Behavior binding per Persona slot', async () => {
    await inFreshWorkspace(async () => {
      const { persona } = await createJim('runtime-unique-slot-jim');
      const primary = (await listBehaviorBindings(persona.id)).find(
        (candidate) => candidate.slotKey === 'primary',
      )!;
      const original = (await getBehaviorRevision(primary.activeRevisionId))!;
      const behaviorId = 'behavior_duplicate_primary';
      const contentHash = hashBehaviorFlow(original.flowSnapshot);
      const revision = BehaviorRevisionSchema.parse({
        ...original,
        id: behaviorRevisionId({
          personaId: persona.id,
          behaviorId,
          revision: 1,
          contentHash,
        }),
        behaviorId,
        revision: 1,
        source: { kind: 'import', sourceRef: 'duplicate-slot-test' },
      });
      await createBehaviorRevision(revision);
      const duplicate = BehaviorBindingSchema.parse({
        ...primary,
        id: behaviorId,
        activeRevisionId: revision.id,
      });

      await expect(saveBehaviorBinding(duplicate)).rejects.toThrow(/already binds slot/i);
    });
  });

  it('recovers a history-only acquisition without reusing its fencing token', async () => {
    await inFreshWorkspace(async () => {
      jest.spyOn(Date, 'now').mockReturnValue(30_000);
      const { persona } = await createJim('runtime-history-only-jim');
      await enqueuePersonaMailboxItem(assignment(persona.id, 'history-only'));
      const abandoned = await claim(persona.id, 1_000);
      await saveCollectionItem(
        ENDURING_AGENT_COLLECTIONS.activities,
        abandoned.activity.id,
        PersonaActivitySchema.parse({
          ...abandoned.activity,
          status: 'queued',
          leaseId: undefined,
          startedAt: undefined,
        }),
      );
      await saveCollectionItem(
        ENDURING_AGENT_COLLECTIONS.mailboxItems,
        abandoned.mailboxItem.id,
        PersonaMailboxItemSchema.parse({
          ...abandoned.mailboxItem,
          status: 'queued',
          claimedActivityId: undefined,
        }),
      );
      await deleteCollectionItem(ENDURING_AGENT_COLLECTIONS.leases, persona.id);

      const recovered = await claim(persona.id, 1_000);
      expect(recovered.lease.fencingToken).toBe(2);
      expect(await getPersonaLeaseRecord(abandoned.lease.id)).toMatchObject({
        status: 'expired',
      });
    });
  });

  it('returns a fully reconciled runtime snapshot after claim and completion crash prefixes', async () => {
    await inFreshWorkspace(async () => {
      const { persona } = await createJim('runtime-coherent-bundle-jim');
      await enqueuePersonaMailboxItem(assignment(persona.id, 'bundle-claim-prefix'));
      const abandoned = await claim(persona.id);

      // Head + running Activity reached disk, but the mailbox claim marker and
      // lifecycle projection did not. The read path may not expose that prefix.
      await saveCollectionItem(
        ENDURING_AGENT_COLLECTIONS.mailboxItems,
        abandoned.mailboxItem.id,
        PersonaMailboxItemSchema.parse({
          ...abandoned.mailboxItem,
          status: 'queued',
          claimedActivityId: undefined,
        }),
      );
      await saveCollectionItem(ENDURING_AGENT_COLLECTIONS.personas, persona.id, {
        ...(await getPersona(persona.id))!,
        lifecycleState: 'idle',
      });

      const rolledBack = (await listPersonaRuntimeBundle(persona.id))!;
      expect(rolledBack.persona.lifecycleState).toBe('idle');
      expect(rolledBack.activities).toEqual([
        expect.objectContaining({ id: abandoned.activity.id, status: 'queued' }),
      ]);
      expect(rolledBack.mailboxItems).toEqual([
        expect.objectContaining({ id: abandoned.mailboxItem.id, status: 'queued' }),
      ]);
      expect(rolledBack.lease).toMatchObject({ status: 'expired' });

      const resumed = await claim(persona.id);
      const terminalAt = Date.now();
      await saveCollectionItem(
        ENDURING_AGENT_COLLECTIONS.activities,
        resumed.activity.id,
        PersonaActivitySchema.parse({
          ...resumed.activity,
          status: 'completed',
          updatedAt: terminalAt,
          completedAt: terminalAt,
        }),
      );
      const completed = (await listPersonaRuntimeBundle(persona.id))!;
      expect(completed.persona.lifecycleState).toBe('idle');
      expect(completed.activities).toEqual([
        expect.objectContaining({ id: resumed.activity.id, status: 'completed' }),
      ]);
      expect(completed.mailboxItems).toEqual([
        expect.objectContaining({ id: resumed.mailboxItem.id, status: 'completed' }),
      ]);
      expect(completed.lease).toMatchObject({ status: 'released' });
      expect(completed.lease).not.toHaveProperty('id');
      expect(completed.lease).not.toHaveProperty('holderId');
    });
  });

  it('fails closed when an authoritative mailbox or lease-history record is invalid JSON', async () => {
    await inFreshWorkspace(async () => {
      const { persona } = await createJim('runtime-corrupt-authority-jim');
      const admitted = await enqueuePersonaMailboxItem(assignment(persona.id, 'blocked-by-corruption'));
      const historyDir = path.join(
        getWorkspaceDbDir(),
        ENDURING_AGENT_COLLECTIONS.leaseHistory,
      );
      await fs.mkdir(historyDir, { recursive: true });
      await fs.writeFile(path.join(historyDir, 'corrupt_high_token.json'), '{not-json', 'utf8');

      await expect(claimNextPersonaActivity({ personaId: persona.id, ttlMs: 10_000 }))
        .rejects.toThrow(/invalid json/i);
      expect((await getPersonaMailboxItem(admitted.item.id))?.status).toBe('queued');
    });
  });

  it('never authorizes a terminal or wrong-generation Activity under an active head', async () => {
    await inFreshWorkspace(async () => {
      const { persona } = await createJim('runtime-fence-activity-link-jim');
      await enqueuePersonaMailboxItem(assignment(persona.id, 'terminal-fence'));
      const active = await claim(persona.id);
      const now = Date.now();
      await saveCollectionItem(
        ENDURING_AGENT_COLLECTIONS.activities,
        active.activity.id,
        PersonaActivitySchema.parse({
          ...active.activity,
          status: 'completed',
          updatedAt: now,
          completedAt: now,
        }),
      );
      await expect(assertPersonaActivityLease(fence(active)))
        .rejects.toBeInstanceOf(PersonaLeaseLostError);
      expect(await getPersonaLease(persona.id)).toMatchObject({ status: 'released' });

      await enqueuePersonaMailboxItem(assignment(persona.id, 'wrong-generation'));
      const next = await claim(persona.id);
      await saveCollectionItem(
        ENDURING_AGENT_COLLECTIONS.activities,
        next.activity.id,
        PersonaActivitySchema.parse({ ...next.activity, leaseId: 'lease_wrong_generation' }),
      );
      await expect(renewPersonaActivityLease({ ...fence(next), ttlMs: 10_000 }))
        .rejects.toBeInstanceOf(PersonaLeaseLostError);
    });
  });

  it('repairs a completion crash prefix idempotently before releasing the lease', async () => {
    await inFreshWorkspace(async () => {
      const { persona } = await createJim('runtime-completion-repair-jim');
      await enqueuePersonaMailboxItem(assignment(persona.id, 'repair-completion'));
      const active = await claim(persona.id);
      const now = Date.now();
      const terminal = PersonaActivitySchema.parse({
        ...active.activity,
        status: 'completed',
        updatedAt: now,
        completedAt: now,
      }) as PersonaActivity;
      // Simulate a crash after the terminal Activity write but before mailbox,
      // lifecycle projection, and lease release.
      await saveCollectionItem(
        ENDURING_AGENT_COLLECTIONS.activities,
        terminal.id,
        terminal,
      );

      await expect(assertPersonaActivityLease(fence(active)))
        .rejects.toBeInstanceOf(PersonaLeaseLostError);

      const repaired = await completePersonaActivity(fence(active));
      expect(repaired.activity.status).toBe('completed');
      expect(repaired.mailboxItem.status).toBe('completed');
      expect(repaired.lease.status).toBe('released');
      expect((await getPersona(persona.id))?.lifecycleState).toBe('idle');
    });
  });

  it('reconciles a terminal error prefix before admitting the next queued Activity', async () => {
    await inFreshWorkspace(async () => {
      const { persona } = await createJim('runtime-error-prefix-jim');
      await enqueuePersonaMailboxItem(assignment(persona.id, 'fails'));
      await enqueuePersonaMailboxItem(assignment(persona.id, 'continues'));
      const active = await claim(persona.id);
      const now = Date.now();
      await saveCollectionItem(
        ENDURING_AGENT_COLLECTIONS.activities,
        active.activity.id,
        PersonaActivitySchema.parse({
          ...active.activity,
          status: 'error',
          error: 'The assignment failed.',
          updatedAt: now,
          completedAt: now,
        }),
      );

      const next = await claim(persona.id);
      expect(next.mailboxItem.summary).toBe('Assignment continues');
      expect((await getPersonaMailboxItem(active.mailboxItem.id))?.status).toBe('rejected');
      expect((await getPersona(persona.id))?.lifecycleState).toBe('busy');
    });
  });

  it('never re-enables a Persona disabled after its active lease expires', async () => {
    await inFreshWorkspace(async () => {
      const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(50_000);
      const { persona } = await createJim('runtime-disable-after-expiry-jim');
      await enqueuePersonaMailboxItem(assignment(persona.id, 'expires-before-disable'));
      const queued = await enqueuePersonaMailboxItem(assignment(persona.id, 'must-stay-queued'));
      await claim(persona.id, 1_000);

      nowSpy.mockReturnValue(51_000);
      await updatePersona({
        ...(await getPersona(persona.id))!,
        lifecycleState: 'disabled',
        updatedAt: 51_000,
      });

      await expect(claimNextPersonaActivity({ personaId: persona.id, ttlMs: 1_000 }))
        .rejects.toBeInstanceOf(PersonaRuntimeUnavailableError);
      expect((await getPersona(persona.id))?.lifecycleState).toBe('disabled');
      expect((await getPersonaMailboxItem(queued.item.id))?.status).toBe('queued');
    });
  });

  it('does not admit disabled Personas and isolates identical ids across workspaces', async () => {
    await inFreshWorkspace(async () => {
      const { persona } = await createJim('runtime-disabled-jim');
      const admitted = await enqueuePersonaMailboxItem(assignment(persona.id, 'admitted-before-disable'));
      await updatePersona({ ...persona, lifecycleState: 'disabled', updatedAt: Date.now() });
      await expect(enqueuePersonaMailboxItem(assignment(persona.id, 'admitted-before-disable')))
        .resolves.toEqual({ item: admitted.item, duplicate: true });
      await expect(enqueuePersonaMailboxItem(assignment(persona.id, 'blocked')))
        .rejects.toBeInstanceOf(PersonaRuntimeUnavailableError);
    });

    const workspaceA = `enduring-runtime-isolation-a-${process.pid}-${++workspaceSequence}`;
    const workspaceB = `enduring-runtime-isolation-b-${process.pid}-${++workspaceSequence}`;
    const run = (workspace: string) => runWithWorkspace(workspace, async () => {
      const { persona } = await createJim('same-persona-request');
      const admitted = await enqueuePersonaMailboxItem(assignment(persona.id, 'same-work'));
      const claimed = await claim(persona.id);
      return { personaId: persona.id, mailboxId: admitted.item.id, claim: claimed };
    });
    const [left, right] = await Promise.all([run(workspaceA), run(workspaceB)]);
    expect(left.personaId).toBe(right.personaId);
    expect(left.mailboxId).toBe(right.mailboxId);
    expect(left.claim.lease.fencingToken).toBe(1);
    expect(right.claim.lease.fencingToken).toBe(1);
    await expect(runWithWorkspace(
      workspaceB,
      () => assertPersonaActivityLease(fence(left.claim)),
    )).rejects.toBeInstanceOf(PersonaLeaseLostError);
  });
});
