import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import {
  assertWorkerOccurrenceCurrent, claimWorkerOccurrence, enrollWorkerRecovery,
  inspectWorkerRecovery, observeWorkerOccurrence, recordWorkerLocalCreation,
  recordWorkerTerminalObservation,
  workerRecoveryDefinitionSha256,
} from '@/backend/services/scheduler/workerLocalRecovery';
import { setWorkerBootstrapStatus } from '@/backend/services/workspace/workerMode';
import { getDataDir } from '@/utils/paths';
import { getCurrentWorkspace } from '@/utils/workspace';
import type { PlannedExecution, RunRecord } from '@/shared/types/plannedExecution';

const envKeys = ['FLUJO_WORKER_MODE', 'FLUJO_WORKER_RECOVERY_ID', 'FLUJO_WORKER_RECOVERY_EPOCH',
  'FLUJO_SNAPSHOT_CONTROL_TOKEN', 'FLUJO_WORKER_SNAPSHOT_SHA256'] as const;
const saved = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
let execution: PlannedExecution;
const occurrence = '2026-10-03T12:00:00.000Z';
const pathFor = (plan: PlannedExecution) => path.join(getDataDir(), '.worker-local-recovery', getCurrentWorkspace(),
  `${createHash('sha256').update(`${getCurrentWorkspace()}\0${plan.id}`).digest('hex')}.json`);
const enroll = (enabled = true) => enrollWorkerRecovery(execution, enabled, execution.generationId!, workerRecoveryDefinitionSha256(execution));
const terminal = (runId: string, status: RunRecord['status'] = 'completed'): RunRecord => ({
  runId, executionGenerationId: execution.generationId, conversationId: 'fixture-conversation',
  firedAt: occurrence, finishedAt: occurrence, status, triggerSummary: 'fixture',
});

beforeEach(() => {
  Object.assign(process.env, { FLUJO_WORKER_MODE: '1', FLUJO_WORKER_RECOVERY_ID: 'disposable-worker-a',
    FLUJO_WORKER_RECOVERY_EPOCH: '1', FLUJO_SNAPSHOT_CONTROL_TOKEN: 'test-only-control-token',
    FLUJO_WORKER_SNAPSHOT_SHA256: 'a'.repeat(64) });
  setWorkerBootstrapStatus({ state: 'ready', workspace: getCurrentWorkspace() });
  execution = { id: randomUUID(), generationId: randomUUID(), createdAt: '2026-10-03T00:00:00.000Z',
    updatedAt: '2026-10-03T00:00:00.000Z', name: 'Local recurring probe', enabled: true,
    flowId: 'fixture-flow', prompt: 'Read-only fixture', overlapStrategy: 'skip',
    trigger: { type: 'schedule', cron: '* * * * *', catchUp: true } };
});
afterEach(() => {
  jest.restoreAllMocks();
  for (const key of envKeys) {
    if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
  }
  global.__flujo_worker_bootstrap_status = undefined;
});

it('keeps copied enabled rows suppressed and refuses forged caller provenance', async () => {
  expect(await inspectWorkerRecovery(execution, false)).toMatchObject({ eligible: false, reason: 'no-local-provenance' });
  await expect(enroll()).rejects.toThrow('no valid local creation');
  expect(await fs.stat(pathFor(execution)).catch(() => undefined)).toBeUndefined();
});

it('requires explicit opt-in for the locally created generation and stores no raw credentials/config', async () => {
  await recordWorkerLocalCreation(execution);
  expect(await inspectWorkerRecovery(execution, false)).toMatchObject({ eligible: false, reason: 'not-opted-in' });
  await enroll();
  expect(await inspectWorkerRecovery(execution, false)).toMatchObject({ eligible: true, state: 'pending-local-recovery' });
  const stored = await fs.readFile(pathFor(execution), 'utf8');
  expect(stored).not.toMatch(/test-only-control-token|Read-only fixture|fixture-flow/);
  expect(pathFor(execution)).not.toContain(`${path.sep}workspaces${path.sep}`);
});

it.each(['worker', 'epoch', 'snapshot', 'token', 'generation', 'definition'] as const)(
  'fences changed %s before any occurrence admission', async change => {
    await recordWorkerLocalCreation(execution); await enroll();
    if (change === 'worker') process.env.FLUJO_WORKER_RECOVERY_ID = 'another-worker';
    if (change === 'epoch') process.env.FLUJO_WORKER_RECOVERY_EPOCH = '2';
    if (change === 'snapshot') process.env.FLUJO_WORKER_SNAPSHOT_SHA256 = 'b'.repeat(64);
    if (change === 'token') process.env.FLUJO_SNAPSHOT_CONTROL_TOKEN = 'rotated-test-token';
    if (change === 'generation') execution.generationId = randomUUID();
    if (change === 'definition') execution.prompt = 'Changed definition';
    expect((await inspectWorkerRecovery(execution, false))?.eligible).toBe(false);
    expect(await claimWorkerOccurrence(execution, occurrence, 'run-a')).not.toBe('eligible');
  },
);

it.each(['paused', 'disabled', 'retired', 'persona', 'parallel', 'not-ready', 'emergency', 'exclusive', 'barrier'] as const)(
  'keeps %s plans suppressed', async mode => {
    await recordWorkerLocalCreation(execution); await enroll();
    if (mode === 'disabled') execution.enabled = false;
    if (mode === 'retired') execution.personaRetired = true;
    if (mode === 'persona') execution.personaId = 'persona-untrusted';
    if (mode === 'parallel') execution.overlapStrategy = 'parallel';
    if (mode === 'not-ready') setWorkerBootstrapStatus({ state: 'installing' });
    if (mode === 'emergency') execution.emergency = true;
    if (mode === 'exclusive') execution.startRestriction = 'exclusive';
    if (mode === 'barrier') execution.superExclusive = true;
    expect((await inspectWorkerRecovery(execution, mode === 'paused'))?.eligible).toBe(false);
  },
);

it('admits one occurrence under concurrent requests and retains uncertainty across reloads', async () => {
  await recordWorkerLocalCreation(execution); await enroll();
  const results = await Promise.all([
    claimWorkerOccurrence(execution, occurrence, 'run-a'), claimWorkerOccurrence(execution, occurrence, 'run-b'),
  ]);
  expect(results.filter(result => result === 'eligible')).toHaveLength(1);
  const status = await inspectWorkerRecovery(execution, false);
  expect(status).toMatchObject({ reason: 'unresolved-admission', eligible: false });
  expect(await inspectWorkerRecovery(execution, false, new Set([status!.pending!.runId]))).toMatchObject({ eligible: true });
  await expect(enroll()).rejects.toThrow('terminal observation');
  expect(await claimWorkerOccurrence(execution, '2026-10-03T12:01:00.000Z', 'replacement')).toBe('unresolved-admission');
});

it('observes only exact terminal generation facts and never relaunches the accounted occurrence', async () => {
  await recordWorkerLocalCreation(execution); await enroll();
  await claimWorkerOccurrence(execution, occurrence, 'run-a');
  expect(await observeWorkerOccurrence(execution, terminal('run-b'))).toBe(false);
  expect(await observeWorkerOccurrence(execution, terminal('run-a', 'needs_approval'))).toBe(false);
  expect(await observeWorkerOccurrence(execution, { ...terminal('run-a'), executionGenerationId: 'old-generation' })).toBe(false);
  expect(await observeWorkerOccurrence(execution, terminal('run-a'))).toBe(false);
  expect(await recordWorkerTerminalObservation(execution, terminal('run-b'))).toBe(false);
  expect(await recordWorkerTerminalObservation(execution, terminal('run-a', 'needs_approval'))).toBe(false);
  await recordWorkerTerminalObservation(execution, terminal('run-a'));
  expect(await observeWorkerOccurrence(execution, terminal('run-a'))).toBe(true);
  expect(await claimWorkerOccurrence(execution, occurrence, 'run-c')).toBe('already-accounted');
  expect(await claimWorkerOccurrence(execution, '2026-10-03T12:01:00.000Z', 'run-d')).toBe('eligible');
});

it('does not replace the signed terminal receipt for an exact repeated observation', async () => {
  await recordWorkerLocalCreation(execution); await enroll();
  expect(await claimWorkerOccurrence(execution, occurrence, 'run-a')).toBe('eligible');
  const completed = terminal('run-a');
  expect(await recordWorkerTerminalObservation(execution, completed)).toBe(true);
  const before = await fs.readFile(pathFor(execution));
  const identity = await fs.stat(pathFor(execution), { bigint: true });

  expect(await recordWorkerTerminalObservation(execution, { ...completed })).toBe(true);
  const after = await fs.stat(pathFor(execution), { bigint: true });
  expect({ ino: after.ino.toString(), mtimeNs: after.mtimeNs.toString(), ctimeNs: after.ctimeNs.toString() })
    .toEqual({ ino: identity.ino.toString(), mtimeNs: identity.mtimeNs.toString(), ctimeNs: identity.ctimeNs.toString() });
  expect(await fs.readFile(pathFor(execution))).toEqual(before);
  expect(await inspectWorkerRecovery(execution, false)).toMatchObject({
    reason: 'unresolved-admission', pending: { runId: 'run-a', occurrenceAt: occurrence },
  });
  expect(await observeWorkerOccurrence(execution, completed)).toBe(true);
});

it.each([
  { label: 'error status', change: { status: 'error' as const } },
  { label: 'skipped status', change: { status: 'skipped' as const } },
  { label: 'completion time', change: { finishedAt: '2026-10-03T12:00:01.000Z' } },
])('retains the first terminal observation when a later result changes $label', async ({ change }) => {
  await recordWorkerLocalCreation(execution); await enroll();
  expect(await claimWorkerOccurrence(execution, occurrence, 'run-a')).toBe('eligible');
  const completed = terminal('run-a');
  expect(await recordWorkerTerminalObservation(execution, completed)).toBe(true);
  const before = await fs.readFile(pathFor(execution));
  const conflicting = { ...completed, ...change };

  expect(await recordWorkerTerminalObservation(execution, conflicting)).toBe(false);
  expect(await fs.readFile(pathFor(execution))).toEqual(before);
  expect(await observeWorkerOccurrence(execution, conflicting)).toBe(false);
  expect(await inspectWorkerRecovery(execution, false)).toMatchObject({
    reason: 'unresolved-admission', pending: { runId: 'run-a', occurrenceAt: occurrence },
  });
  expect(await observeWorkerOccurrence(execution, completed)).toBe(true);
  expect(await claimWorkerOccurrence(execution, occurrence, 'run-b')).toBe('already-accounted');
  expect(await claimWorkerOccurrence(execution, '2026-10-03T12:01:00.000Z', 'run-c')).toBe('eligible');
});

it('retains one durable winner when conflicting terminal observations race', async () => {
  await recordWorkerLocalCreation(execution); await enroll();
  expect(await claimWorkerOccurrence(execution, occurrence, 'run-a')).toBe('eligible');
  const candidates = [terminal('run-a'), terminal('run-a', 'error')];
  const results = await Promise.all(candidates.map(result => recordWorkerTerminalObservation(execution, result)));
  expect(results.filter(Boolean)).toHaveLength(1);
  const winner = candidates[results.indexOf(true)];
  const rejected = candidates[results.indexOf(false)];
  const before = await fs.readFile(pathFor(execution));
  expect(JSON.parse(before.toString()).terminal).toEqual({ runId: winner.runId,
    generationId: execution.generationId, status: winner.status, finishedAt: winner.finishedAt });

  expect(await recordWorkerTerminalObservation(execution, rejected)).toBe(false);
  expect(await recordWorkerTerminalObservation(execution, winner)).toBe(true);
  expect(await fs.readFile(pathFor(execution))).toEqual(before);
  expect(await observeWorkerOccurrence(execution, rejected)).toBe(false);
  expect(await inspectWorkerRecovery(execution, false)).toMatchObject({ reason: 'unresolved-admission' });
  expect(await observeWorkerOccurrence(execution, winner)).toBe(true);
  expect(await claimWorkerOccurrence(execution, occurrence, 'run-b')).toBe('already-accounted');
  expect(await claimWorkerOccurrence(execution, '2026-10-03T12:01:00.000Z', 'run-c')).toBe('eligible');
});

it('revokes subsequent entry without treating stop intent as exit or erasing a pending run', async () => {
  await recordWorkerLocalCreation(execution); await enroll();
  await claimWorkerOccurrence(execution, occurrence, 'run-a');
  await enroll(false);
  await expect(assertWorkerOccurrenceCurrent(execution, 'run-a')).rejects.toThrow('fenced');
  expect(await inspectWorkerRecovery(execution, false)).toMatchObject({ reason: 'not-opted-in', pending: { runId: 'run-a' } });
});

it('rejects corrupt/signature-tampered/oversized private records without activation', async () => {
  await recordWorkerLocalCreation(execution); await enroll();
  const original = await fs.readFile(pathFor(execution), 'utf8');
  const changed = JSON.parse(original); changed.optedIn = false;
  await fs.writeFile(pathFor(execution), JSON.stringify(changed));
  expect(await inspectWorkerRecovery(execution, false)).toMatchObject({ reason: 'invalid-provenance', eligible: false });
  await fs.writeFile(pathFor(execution), '{broken-json');
  expect(await inspectWorkerRecovery(execution, false)).toMatchObject({ reason: 'invalid-provenance', eligible: false });
  await fs.writeFile(pathFor(execution), 'x'.repeat(8193));
  expect(await inspectWorkerRecovery(execution, false)).toMatchObject({ reason: 'invalid-provenance', eligible: false });
});

it('does not erase an old generation pending admission during same-ID recreation', async () => {
  await recordWorkerLocalCreation(execution); await enroll();
  await claimWorkerOccurrence(execution, occurrence, 'run-a');
  execution = { ...execution, generationId: randomUUID(), createdAt: '2026-10-03T12:30:00.000Z' };
  await expect(recordWorkerLocalCreation(execution)).rejects.toThrow('unresolved admission');
});

it('refuses even a valid signed record swapped after private-path inspection', async () => {
  await recordWorkerLocalCreation(execution); await enroll();
  const file = pathFor(execution);
  const original = await fs.readFile(file);
  const open = fs.open.bind(fs);
  let swapped = false;
  jest.spyOn(fs, 'open').mockImplementation(async (...args) => {
    if (String(args[0]) === file && !swapped) {
      swapped = true;
      await fs.rename(file, `${file}.original`);
      await fs.writeFile(file, original, { mode: 0o600 });
    }
    return open(...args);
  });
  expect(await inspectWorkerRecovery(execution, false)).toMatchObject({ eligible: false, reason: 'invalid-provenance' });
  expect(await fs.readFile(`${file}.original`)).toEqual(original);
});

it('refuses a recovery parent replaced by a link after inspection with the same file inode', async () => {
  await recordWorkerLocalCreation(execution); await enroll();
  const file = pathFor(execution);
  const directory = path.dirname(file);
  const moved = `${directory}.original-${randomUUID()}`;
  const open = fs.open.bind(fs);
  let swapped = false;
  jest.spyOn(fs, 'open').mockImplementation(async (...args) => {
    if (String(args[0]) === file && !swapped) {
      swapped = true;
      await fs.rename(directory, moved);
      await fs.symlink(moved, directory, process.platform === 'win32' ? 'junction' : 'dir');
    }
    return open(...args);
  });
  try {
    expect(await inspectWorkerRecovery(execution, false)).toMatchObject({ eligible: false, reason: 'invalid-provenance' });
  } finally {
    jest.restoreAllMocks();
    await fs.unlink(directory);
    await fs.rename(moved, directory);
  }
});
