import { constants, promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { getDataDir } from '@/utils/paths';
import { getCurrentWorkspace } from '@/utils/workspace';
import { withPersonaRuntimeLock } from '@/backend/services/enduringAgents/runtimeLock';
import { atomicWriteWithoutLinks } from '@/backend/services/workspace/backupRestoreFs';
import { isWorkerMode, getWorkerBootstrapStatus } from '@/backend/services/workspace/workerMode';
import { isPersonaControlledPlannedExecution, normalizeStartRestrictions, type PlannedExecution, type RunRecord } from '@/shared/types/plannedExecution';
import type { WorkerRecoveryReason, WorkerRecoveryStatus } from '@/shared/types/plannedExecution/workerRecovery';

interface Authority {
  workerId: string;
  epoch: number;
  snapshotSha256: string;
  token: string;
}
interface LocalRecord {
  schemaVersion: 1;
  workerId: string;
  epoch: number;
  snapshotSha256: string;
  workspace: string;
  executionId: string;
  generationId: string;
  createdAt: string;
  definitionSha256?: string;
  optedIn: boolean;
  lastOccurrenceAt?: string;
  pending?: { runId: string; occurrenceAt: string };
  terminal?: TerminalObservation;
  signature: string;
}
interface TerminalObservation {
  runId: string;
  generationId: string;
  status: 'completed' | 'error' | 'skipped';
  finishedAt: string;
}

const SHA256 = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_RECORD_BYTES = 8192;
const canonical = (value: unknown): string => JSON.stringify(value, (_key, entry) =>
  entry && typeof entry === 'object' && !Array.isArray(entry)
    ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b))) : entry);

/** Same functional config identity as scheduler timers; folder/time edits are not authority. */
export function workerRecoveryDefinitionSha256(execution: PlannedExecution): string {
  const config: Partial<PlannedExecution> = { ...execution };
  delete config.folder;
  delete config.updatedAt;
  return createHash('sha256').update(canonical(config)).digest('hex');
}

function authority(): Authority | undefined {
  if (!isWorkerMode()) return undefined;
  const workerId = process.env.FLUJO_WORKER_RECOVERY_ID?.trim();
  const rawEpoch = process.env.FLUJO_WORKER_RECOVERY_EPOCH?.trim();
  const epoch = Number(rawEpoch);
  const token = process.env.FLUJO_SNAPSHOT_CONTROL_TOKEN?.trim();
  const snapshotSha256 = process.env.FLUJO_WORKER_SNAPSHOT_SHA256?.trim().toLowerCase();
  if (!workerId || !ID.test(workerId) || !rawEpoch || !/^[1-9][0-9]*$/.test(rawEpoch)
      || !Number.isSafeInteger(epoch) || !token || !snapshotSha256 || !SHA256.test(snapshotSha256)) return undefined;
  return { workerId, epoch, snapshotSha256, token };
}

export function isWorkerLocalRecoveryConfigured(): boolean {
  return authority() !== undefined;
}

function workerReady(): boolean {
  const status = getWorkerBootstrapStatus();
  return status.state === 'ready' && status.workspace === getCurrentWorkspace();
}

function location(execution: PlannedExecution) {
  const root = getDataDir();
  const workspace = getCurrentWorkspace();
  const key = createHash('sha256').update(`${workspace}\0${execution.id}`).digest('hex');
  // Installation-local control state is deliberately outside exported/restored workspaces.
  return { root, file: path.join(root, '.worker-local-recovery', workspace, `${key}.json`), key, workspace };
}

function signed(record: Omit<LocalRecord, 'signature'>, current: Authority): LocalRecord {
  return { ...record, signature: createHmac('sha256', current.token).update(canonical(record)).digest('hex') };
}
function unsigned(record: LocalRecord): Omit<LocalRecord, 'signature'> {
  const { signature: _signature, ...content } = record;
  return content;
}

function validRecord(value: unknown): value is LocalRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const r = value as LocalRecord;
  const fields = new Set(['schemaVersion', 'workerId', 'epoch', 'snapshotSha256', 'workspace',
    'executionId', 'generationId', 'createdAt', 'definitionSha256', 'optedIn', 'lastOccurrenceAt', 'pending', 'terminal', 'signature']);
  return Object.keys(r).every(key => fields.has(key)) && r.schemaVersion === 1
    && typeof r.workerId === 'string' && ID.test(r.workerId) && Number.isSafeInteger(r.epoch) && r.epoch > 0
    && typeof r.snapshotSha256 === 'string' && SHA256.test(r.snapshotSha256)
    && typeof r.workspace === 'string' && typeof r.executionId === 'string'
    && typeof r.generationId === 'string' && ID.test(r.generationId)
    && typeof r.createdAt === 'string' && Number.isFinite(Date.parse(r.createdAt))
    && typeof r.optedIn === 'boolean' && typeof r.signature === 'string' && SHA256.test(r.signature)
    && (r.definitionSha256 === undefined || (typeof r.definitionSha256 === 'string' && SHA256.test(r.definitionSha256)))
    && (r.lastOccurrenceAt === undefined || (typeof r.lastOccurrenceAt === 'string' && Number.isFinite(Date.parse(r.lastOccurrenceAt))))
    && (r.pending === undefined || (r.pending && typeof r.pending === 'object'
      && Object.keys(r.pending).length === 2 && typeof r.pending.runId === 'string' && ID.test(r.pending.runId)
      && typeof r.pending.occurrenceAt === 'string' && Number.isFinite(Date.parse(r.pending.occurrenceAt))))
    && (r.terminal === undefined || (r.terminal && typeof r.terminal === 'object'
      && Object.keys(r.terminal).length === 4 && typeof r.terminal.runId === 'string' && ID.test(r.terminal.runId)
      && typeof r.terminal.generationId === 'string' && ID.test(r.terminal.generationId)
      && ['completed', 'error', 'skipped'].includes(r.terminal.status)
      && typeof r.terminal.finishedAt === 'string' && Number.isFinite(Date.parse(r.terminal.finishedAt))));
}

/** Refuse links/hardlinks and oversized/corrupt control files; never interpret absence as enrollment. */
async function read(execution: PlannedExecution): Promise<LocalRecord | undefined> {
  const { root, file } = location(execution);
  let component = root;
  for (const part of ['', ...path.relative(root, path.dirname(file)).split(path.sep)]) {
    component = path.join(component, part);
    try {
      const stat = await fs.lstat(component);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe recovery control path');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }
  let before;
  try { before = await fs.lstat(file); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > MAX_RECORD_BYTES) {
    throw new Error('Unsafe recovery control file');
  }
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.ino !== before.ino || opened.dev !== before.dev || opened.nlink !== 1 || opened.size > MAX_RECORD_BYTES) {
      throw new Error('Recovery control file changed');
    }
    // A writer can grow the opened file after stat. Bound allocation and IO,
    // including this read-only diagnostic path, rather than checking after readFile.
    const bytes = Buffer.alloc(MAX_RECORD_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > MAX_RECORD_BYTES) throw new Error('Recovery control file exceeds budget');
    const result: unknown = JSON.parse(bytes.subarray(0, length).toString('utf8'));
    if (!validRecord(result)) throw new Error('Invalid recovery provenance');
    return result;
  } finally { await handle.close(); }
}

function check(record: LocalRecord | undefined, execution: PlannedExecution, current: Authority): WorkerRecoveryReason {
  if (!record) return 'no-local-provenance';
  if (record.workerId !== current.workerId || record.epoch !== current.epoch
      || record.snapshotSha256 !== current.snapshotSha256) return 'worker-authority-changed';
  const expected = signed(unsigned(record), current).signature;
  if (!timingSafeEqual(Buffer.from(record.signature, 'hex'), Buffer.from(expected, 'hex'))) return 'invalid-provenance';
  if (record.workspace !== getCurrentWorkspace() || record.executionId !== execution.id
      || record.generationId !== execution.generationId || record.createdAt !== execution.createdAt) return 'generation-changed';
  return 'eligible';
}

function supported(execution: PlannedExecution): boolean {
  const restrictions = normalizeStartRestrictions(execution);
  return execution.trigger.type === 'schedule' && !isPersonaControlledPlannedExecution(execution)
    && !restrictions.emergency && !restrictions.superExclusive && restrictions.startRestriction !== 'exclusive'
    && (!execution.overlapStrategy || execution.overlapStrategy === 'skip');
}

async function mutate<T>(execution: PlannedExecution,
  task: (record: LocalRecord | undefined, current: Authority, save: (value: Omit<LocalRecord, 'signature'>) => Promise<void>) => Promise<T>): Promise<T> {
  const current = authority();
  if (!current || !workerReady()) throw new Error('Worker local recovery is not configured or ready');
  const { root, file, key } = location(execution);
  return withPersonaRuntimeLock(`worker_recovery_${key.slice(0, 40)}`, async lock => {
    const record = await read(execution);
    return task(record, current, async value => {
      // Recheck actual owner/epoch/token after asynchronous storage work, before publishing authority.
      if (!workerReady() || canonical(authority()) !== canonical(current)) throw new Error('Worker recovery authority changed');
      await lock.assertOwned();
      await atomicWriteWithoutLinks(root, file, Buffer.from(JSON.stringify(signed(value, current))), { mode: 0o600 });
    });
  });
}

/** Only the trusted local CREATE chokepoint calls this. Imported configuration is not provenance. */
export async function recordWorkerLocalCreation(execution: PlannedExecution): Promise<void> {
  if (!authority() || !supported(execution)) return;
  if (!execution.generationId) throw new Error('Locally created plan needs a generation');
  await mutate(execution, async (record, current, save) => {
    if (record?.generationId === execution.generationId) {
      if (check(record, execution, current) !== 'eligible') throw new Error('Worker recovery provenance conflict');
      return;
    }
    // Recreating a plan cannot erase unresolved admission/effect history.
    if (record?.pending) throw new Error('Previous plan generation has an unresolved admission');
    await save({ schemaVersion: 1, workerId: current.workerId, epoch: current.epoch,
      snapshotSha256: current.snapshotSha256, workspace: getCurrentWorkspace(),
      executionId: execution.id, generationId: execution.generationId!, createdAt: execution.createdAt, optedIn: false });
  });
}

export async function inspectWorkerRecovery(execution: PlannedExecution, paused: boolean,
  ownedRunIds: ReadonlySet<string> = new Set()): Promise<WorkerRecoveryStatus | undefined> {
  if (!isWorkerMode()) return undefined;
  const digest = workerRecoveryDefinitionSha256(execution);
  let reason: WorkerRecoveryReason = 'eligible';
  let record: LocalRecord | undefined;
  const current = authority();
  if (!workerReady()) reason = 'worker-not-ready';
  else if (execution.personaRetired || execution.personaArchived) reason = 'retired';
  else if (!supported(execution)) reason = 'unsupported-plan';
  else if (!execution.enabled) reason = 'disabled';
  else if (paused) reason = 'paused';
  else if (!current) reason = 'recovery-not-configured';
  else {
    try {
      record = await read(execution);
      reason = canonical(authority()) === canonical(current) ? check(record, execution, current) : 'worker-authority-changed';
    }
    catch { reason = 'invalid-provenance'; }
    if (reason === 'eligible' && record) {
      reason = !record.optedIn ? 'not-opted-in' : record.definitionSha256 !== digest ? 'definition-changed'
        : record.pending && !ownedRunIds.has(record.pending.runId) ? 'unresolved-admission' : 'eligible';
    }
  }
  const eligible = reason === 'eligible';
  return { eligible, definitionSha256: digest, reason,
    state: eligible ? 'pending-local-recovery'
      : ['invalid-provenance', 'worker-authority-changed', 'generation-changed', 'definition-changed', 'unresolved-admission'].includes(reason)
        ? 'rejected' : 'suppressed',
    ...(record?.pending ? { pending: record.pending } : {}),
  };
}

export async function enrollWorkerRecovery(execution: PlannedExecution, enabled: boolean,
  expectedGenerationId: string, expectedDefinitionSha256: string): Promise<void> {
  if (!supported(execution) || execution.personaRetired || execution.personaArchived) throw new Error('Unsupported worker recovery plan');
  if (expectedGenerationId !== execution.generationId || expectedDefinitionSha256 !== workerRecoveryDefinitionSha256(execution)) {
    throw new Error('Worker recovery plan changed');
  }
  await mutate(execution, async (record, current, save) => {
    if (!record || check(record, execution, current) !== 'eligible') throw new Error('Plan has no valid local creation provenance');
    if (enabled && record.pending) throw new Error('An unresolved admission requires terminal observation');
    await save({ ...unsigned(record), optedIn: enabled, definitionSha256: expectedDefinitionSha256 });
  });
}

/** Serialized write-ahead intent: uncertainty blocks replacement writers rather than replaying effects. */
export async function claimWorkerOccurrence(execution: PlannedExecution, occurrenceAt: string, runId: string): Promise<WorkerRecoveryReason> {
  if (!Number.isFinite(Date.parse(occurrenceAt)) || !ID.test(runId)) throw new Error('Invalid occurrence identity');
  if (!supported(execution)) return 'unsupported-plan';
  if (!execution.enabled) return 'disabled';
  if (Date.parse(occurrenceAt) < Date.parse(execution.createdAt)) return 'already-accounted';
  return mutate(execution, async (record, current, save) => {
    const reason = check(record, execution, current);
    if (reason !== 'eligible' || !record) return reason;
    if (!record.optedIn) return 'not-opted-in';
    if (record.definitionSha256 !== workerRecoveryDefinitionSha256(execution)) return 'definition-changed';
    if (record.pending) return 'unresolved-admission';
    if (record.lastOccurrenceAt && Date.parse(record.lastOccurrenceAt) >= Date.parse(occurrenceAt)) return 'already-accounted';
    const next = unsigned(record);
    delete next.terminal;
    await save({ ...next, pending: { runId, occurrenceAt }, lastOccurrenceAt: occurrenceAt });
    return 'eligible';
  });
}

/** Revalidate after awaits before entering runFlow; revocation does not certify stopping an entered process. */
export async function assertWorkerOccurrenceCurrent(execution: PlannedExecution, runId: string): Promise<void> {
  const record = await read(execution);
  const current = authority();
  if (!workerReady() || !current || check(record, execution, current) !== 'eligible' || !record?.optedIn
      || record.definitionSha256 !== workerRecoveryDefinitionSha256(execution) || record.pending?.runId !== runId) {
    throw new Error('Worker schedule admission was fenced before execution');
  }
}

function terminalObservation(execution: PlannedExecution, result: RunRecord): TerminalObservation | undefined {
  if (!['completed', 'error', 'skipped'].includes(result.status)
      || result.executionGenerationId !== execution.generationId
      || !result.finishedAt || !Number.isFinite(Date.parse(result.finishedAt))) return undefined;
  return { runId: result.runId, generationId: execution.generationId!,
    status: result.status as TerminalObservation['status'], finishedAt: result.finishedAt };
}

/** Trusted live scheduler chokepoint only, before terminal history publication. Never call on imported history. */
export async function recordWorkerTerminalObservation(execution: PlannedExecution, result: RunRecord): Promise<boolean> {
  const terminal = terminalObservation(execution, result);
  if (!terminal) return false;
  return mutate(execution, async (record, current, save) => {
    if (!record || check(record, execution, current) !== 'eligible' || record.pending?.runId !== result.runId) return false;
    await save({ ...unsigned(record), terminal });
    return true;
  });
}

/** Signed local observation survives a crash before history/clear; copied terminal rows confer no authority. */
export async function reconcileWorkerTerminalObservation(execution: PlannedExecution): Promise<boolean> {
  return mutate(execution, async (record, current, save) => {
    if (!record || check(record, execution, current) !== 'eligible' || !record.pending
        || record.terminal?.runId !== record.pending.runId || record.terminal.generationId !== execution.generationId) return false;
    const next = unsigned(record);
    delete next.pending;
    await save(next);
    return true;
  });
}

/** Exact terminal result must already have a private receipt; ACK/cancellation/absence are insufficient. */
export async function observeWorkerOccurrence(execution: PlannedExecution, result: RunRecord): Promise<boolean> {
  const terminal = terminalObservation(execution, result);
  if (!terminal) return false;
  const record = await read(execution);
  if (!record?.terminal || canonical(record.terminal) !== canonical(terminal)) return false;
  return reconcileWorkerTerminalObservation(execution);
}
