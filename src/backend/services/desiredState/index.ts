/**
 * Desired state: one file says what a workspace of an instance should contain, and
 * applying it is safe to repeat, safe to interrupt and reversible.
 *
 * Order of an apply: read and check the file, compile everything, compare, write a
 * journal holding the changes in both directions, make the changes, record the result,
 * remove the journal. Anything invalid stops before the first write. A write that fails
 * is undone from the journal. A process that dies leaves the journal behind, and the
 * next start finishes the work.
 */
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { canonicalJson } from '@/backend/services/enduringAgents/behaviorRevisions';
import { withWorkspaceRuntimeLock } from '@/backend/services/enduringAgents/runtimeLock';
import { mcpService } from '@/backend/services/mcp';
import { getSchedulerService } from '@/backend/services/scheduler';
import { isWorkerMode } from '@/backend/services/workspace/workerMode';
import { isEncryptionLocked } from '@/utils/encryption/secure';
import { createLogger } from '@/utils/logger';
import { createWorkspace, getCurrentWorkspace, normalizeWorkspaceName, workspaceExists } from '@/utils/workspace';
import { DesiredStateWriteError, SimulatedCrash, executeChangeSet, reachedPoint } from './execute';
import { buildOperationPlan, compileTargets, fingerprint, ledgerKey, readStored, targetsForRollback, type OperationPlan } from './plan';
import { parseDesiredState, type DesiredStatePolicy, type DesiredStateProblem, type ParsedDesiredState } from './schema';
import { emptyDesiredStateStatus, projectDesiredStateStatus, type DesiredStateFailureCode } from './status';
import {
  clearJournal,
  loadBundleRecord,
  loadDurableState,
  loadJournal,
  loadLastReport,
  loadStatus,
  pruneBundleRecords,
  saveBundleRecord,
  saveDurableState,
  saveJournal,
  saveLastReport,
  updateStatus,
  type BundleRecord,
  type ChangeSet,
  type DesiredStateChange,
  type DesiredStateOutcome,
  type DesiredStateReport,
  type DurableState,
  type JournalRecord,
  type LedgerEntry,
} from './store';

export type { DesiredStateReport } from './store';
export { DESIRED_STATE_STATUS_PATH, projectDesiredStateStatus } from './status';

const log = createLogger('backend/services/desiredState');

export const DESIRED_STATE_FILE_ENV = 'FLUJO_DESIRED_STATE_FILE';
/** Far above any real file. Keeps a wrong path from filling memory. */
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const APPLY_LOCK = 'desired-state-v1';

interface ReportOptions {
  dryRun?: boolean;
  version?: string | null;
  previousVersion?: string | null;
  changes?: DesiredStateChange[];
  unchanged?: number;
  problems?: DesiredStateProblem[];
  warnings?: string[];
  restartRequired?: string[];
}

function makeReport(outcome: DesiredStateOutcome, message: string, options: ReportOptions = {}): DesiredStateReport {
  return {
    outcome,
    dryRun: options.dryRun === true,
    workspace: getCurrentWorkspace(),
    version: options.version ?? null,
    previousVersion: options.previousVersion ?? null,
    changes: options.changes ?? [],
    unchanged: options.unchanged ?? 0,
    problems: options.problems ?? [],
    warnings: options.warnings ?? [],
    restartRequired: options.restartRequired ?? [],
    message,
  };
}

/** Last line of defence: a value read from the environment never leaves in any text. */
function scrub(report: DesiredStateReport, secretValues: readonly string[]): DesiredStateReport {
  const values = secretValues.filter((value) => value.length >= 4);
  if (!values.length) return report;
  let text = JSON.stringify(report);
  for (const value of values) {
    const encoded = JSON.stringify(value).slice(1, -1);
    text = text.split(encoded).join('[hidden]');
  }
  return JSON.parse(text) as DesiredStateReport;
}

/** Failures keep plain words only. An unexpected error's text could hold anything. */
function plainFailure(error: unknown): string {
  return error instanceof DesiredStateWriteError ? error.message : 'A write failed unexpectedly. See the FLUJO log.';
}

async function recordFailure(code: DesiredStateFailureCode, report: DesiredStateReport): Promise<void> {
  try {
    const at = new Date().toISOString();
    await updateStatus({ lastAttemptAt: at, lastApplyFailed: true, lastFailureAt: at, lastFailureCode: code });
    await saveLastReport(report);
  } catch (error) {
    log.warn('Could not record a failed desired-state attempt', error);
  }
}

const hashOf = (value: unknown): string => createHash('sha256').update(canonicalJson(value)).digest('hex');

async function currentHash(kind: LedgerEntry['kind'], id: string): Promise<string | null> {
  if (kind === 'secret') return null;
  const stored = await readStored(kind, id);
  return stored === null ? null : fingerprint(kind, stored);
}

/** Record the result and remove the journal. Safe to run again after a crash. */
async function commit(journal: JournalRecord): Promise<void> {
  const plan = journal.commit;
  if (plan.newRecord) await saveBundleRecord(plan.newRecord);
  const ledger: Record<string, LedgerEntry> = {};
  for (const target of plan.ledgerTargets) {
    ledger[ledgerKey(target.kind, target.id)] = {
      ...target,
      appliedHash: await currentHash(target.kind, target.id),
    };
  }
  for (const entry of plan.keptEntries) ledger[ledgerKey(entry.kind, entry.id)] = entry;
  reachedPoint('before-state');
  const state: DurableState = {
    schemaVersion: 1,
    operationSeq: journal.operationSeq,
    current: plan.current,
    ledger,
    history: plan.history,
    ...(plan.heldBack ? { heldBack: plan.heldBack } : {}),
  };
  await saveDurableState(state);
  reachedPoint('after-state');
  await finishCommit(journal);
}

/** The part after the state is saved. A journal older than the state resumes from here. */
async function finishCommit(journal: JournalRecord, interrupted = false): Promise<void> {
  const plan = journal.commit;
  await pruneBundleRecords(plan.history.map((entry) => entry.seq));
  await updateStatus({
    appliedVersion: plan.current.version,
    appliedAt: plan.current.appliedAt,
    lastAttemptAt: new Date().toISOString(),
    lastApplyFailed: false,
    lastFailureAt: null,
    lastFailureCode: null,
    interruptedApply: interrupted ? 'finished-at-restart' : 'none',
    heldBackVersion: plan.heldBack?.version ?? null,
    localEditsKept: plan.keptEntries.length,
    restartRequired: plan.report.restartRequired.length > 0,
  });
  await saveLastReport(interrupted
    ? { ...plan.report, message: `An update to version ${plan.current.version} was interrupted and has now been finished.` }
    : plan.report);
  reachedPoint('before-journal-clear');
  await clearJournal();
}

/** Undo from the journal. Returns false when even that failed, which keeps the journal. */
async function restore(journal: JournalRecord, label: 'none' | 'restored-at-restart'): Promise<boolean> {
  try {
    await executeChangeSet(journal.reverse);
    await clearJournal();
    await updateStatus({ interruptedApply: label });
    return true;
  } catch (error) {
    if (error instanceof SimulatedCrash) throw error;
    log.error('Could not put the instance back after a failed desired-state write', error);
    await updateStatus({ interruptedApply: 'needs-attention' }).catch(() => undefined);
    return false;
  }
}

/** Journal, change, commit. On a failed write, undo from the journal. */
async function runJournaled(journal: JournalRecord): Promise<{ ok: true } | { ok: false; report: DesiredStateReport }> {
  await saveJournal(journal);
  reachedPoint('journal');
  try {
    await executeChangeSet(journal.forward);
    await commit(journal);
    return { ok: true };
  } catch (error) {
    if (error instanceof SimulatedCrash) throw error;
    log.error('A desired-state write failed', error);
    const reason = plainFailure(error);
    const restored = await restore(journal, 'none');
    const report = makeReport('failed', restored
      ? `${reason} Everything was put back as it was.`
      : `${reason} Putting everything back failed as well. The next start tries again, and until then this instance may be between versions.`,
    {
      version: journal.version,
      previousVersion: journal.previousVersion,
      problems: [{ where: 'write', message: reason }],
    });
    await recordFailure(restored ? 'write-failed' : 'restore-failed', report);
    return { ok: false, report };
  }
}

/**
 * Finish what a previous process started. Runs at every start, with or without a
 * configured file, and before any new apply. Returns a report when it did not end in a
 * clean state, which means no new apply should go ahead.
 */
async function resumeWithinLock(): Promise<DesiredStateReport | null> {
  const journal = await loadJournal();
  if (!journal) return null;
  const state = await loadDurableState();
  log.warn(`Found an interrupted desired-state ${journal.operation} to version ${journal.version}`);
  try {
    if (state.operationSeq >= journal.operationSeq) {
      await finishCommit(journal, true);
      return null;
    }
    await executeChangeSet(journal.forward);
    await commit(journal);
    await updateStatus({ interruptedApply: 'finished-at-restart' });
    await saveLastReport({ ...journal.commit.report, message: `An update to version ${journal.version} was interrupted and has now been finished.` });
    return null;
  } catch (error) {
    if (error instanceof SimulatedCrash) throw error;
    log.error('Could not finish an interrupted desired-state update', error);
    const restored = await restore(journal, 'restored-at-restart');
    const report = makeReport('failed', restored
      ? `An update to version ${journal.version} was interrupted and could not be finished. Everything was put back as it was.`
      : `An update to version ${journal.version} was interrupted, and neither finishing it nor putting everything back worked. The next start tries again.`,
    { version: journal.version, previousVersion: journal.previousVersion });
    await recordFailure(restored ? 'write-failed' : 'restore-failed', report);
    return restored ? null : report;
  }
}

function unavailable(dryRun: boolean): DesiredStateReport | null {
  return isWorkerMode()
    ? makeReport('not-available', 'A worker runs from a restored copy of a workspace, so a desired state does not apply to it. Nothing was changed.', { dryRun })
    : null;
}

async function lockedReport(dryRun: boolean): Promise<DesiredStateReport | null> {
  return await isEncryptionLocked()
    ? makeReport('locked', 'This workspace is locked and has to be unlocked first. Nothing was changed. A file named by FLUJO_DESIRED_STATE_FILE is applied right after the unlock.', { dryRun })
    : null;
}

function changeSummary(plan: OperationPlan): number {
  return plan.changes.filter((change) => change.action !== 'keep-local-edit' && change.action !== 'unmanage').length;
}

function keptSentence(plan: OperationPlan): string {
  const kept = plan.changes.filter((change) => change.action === 'keep-local-edit').length;
  return kept ? ` ${kept} object(s) changed on this instance were left as they are.` : '';
}

/** Check a decoded file, then report what it would change or make those changes. */
export async function applyDesiredState(
  input: unknown,
  options: { dryRun?: boolean; reconcileRuntime?: boolean } = {},
): Promise<DesiredStateReport> {
  const dryRun = options.dryRun === true;
  const blocked = unavailable(dryRun) ?? await lockedReport(dryRun);
  if (blocked) return blocked;
  const parsed = parseDesiredState(input);
  if (!parsed.ok) {
    const report = makeReport('invalid', 'The file cannot be used, so nothing was changed.', { dryRun, problems: parsed.problems });
    if (!dryRun) await recordFailure('invalid-file', report);
    return report;
  }
  const workspace = getCurrentWorkspace();
  if (!parsed.state.workspaces.includes(workspace)) {
    const report = makeReport('invalid', 'The file cannot be used, so nothing was changed.', {
      dryRun,
      version: parsed.state.version,
      problems: [{ where: 'workspaces', message: `this file is for ${parsed.state.workspaces.join(', ')}, not for "${workspace}".` }],
    });
    if (!dryRun) await recordFailure('invalid-file', report);
    return report;
  }
  try {
    return await withWorkspaceRuntimeLock(APPLY_LOCK, () => applyWithinLock(parsed.state, parsed.warnings, hashOf(input), dryRun, options.reconcileRuntime !== false));
  } catch (error) {
    if (error instanceof SimulatedCrash) throw error;
    log.error('A desired-state apply could not run', error);
    return makeReport('failed', 'The apply could not run, for example because another one is still going. Nothing was changed by this attempt.', {
      dryRun, version: parsed.state.version,
    });
  }
}

async function applyWithinLock(
  state: ParsedDesiredState,
  parseWarnings: string[],
  fileHash: string,
  dryRun: boolean,
  reconcileRuntime: boolean,
): Promise<DesiredStateReport> {
  const stuck = await resumeWithinLock();
  if (stuck) return stuck;
  const durable = await loadDurableState();
  const previousVersion = durable.current?.version ?? null;
  const base = { dryRun, version: state.version, previousVersion };

  const invalid = async (problems: DesiredStateProblem[], warnings: string[], code: DesiredStateFailureCode = 'invalid-file') => {
    const report = makeReport('invalid', 'The file cannot be used, so nothing was changed.', { ...base, problems, warnings });
    if (!dryRun) await recordFailure(code, report);
    return report;
  };

  // One version string means one content, so a fleet's reported versions can be trusted.
  const reused = durable.history.find((entry) => entry.version === state.version && entry.fileHash !== fileHash);
  if (reused || (durable.current?.version === state.version && durable.current.fileHash !== fileHash)) {
    return invalid([{ where: 'version', message: `version "${state.version}" was already applied with different content. Give this file a new version.` }], parseWarnings, 'version-reused');
  }
  const compiled = await compileTargets(state, durable);
  const warnings = [...parseWarnings, ...compiled.warnings];
  if (compiled.problems.length) return scrub(await invalid(compiled.problems, warnings), compiled.secretValues);
  const plan = await buildOperationPlan({ targets: compiled.targets, policy: state.policy, durable });
  if (plan.problems.length) return scrub(await invalid(plan.problems, warnings), compiled.secretValues);

  const reportOptions = {
    ...base,
    changes: plan.changes,
    unchanged: plan.unchanged,
    warnings,
    restartRequired: plan.restartRequired,
  };
  const count = changeSummary(plan);
  if (dryRun) {
    return scrub(makeReport(plan.writes ? 'would-change' : 'would-not-change', plan.writes
      ? `Version ${state.version} would change ${count} object(s). Nothing was changed.${keptSentence(plan)}`
      : `Version ${state.version} would change nothing.${keptSentence(plan)}`, reportOptions), compiled.secretValues);
  }

  // Same version, nothing to write: record that it was checked and stop. A file that is
  // held back after a rollback and applied on purpose lifts the hold through the journal.
  if (!plan.writes && durable.current?.version === state.version && !durable.heldBack) {
    const report = makeReport('unchanged', `Version ${state.version} is already applied. Nothing was changed.${keptSentence(plan)}`, reportOptions);
    await updateStatus({
      lastAttemptAt: new Date().toISOString(),
      lastApplyFailed: false,
      lastFailureAt: null,
      lastFailureCode: null,
      interruptedApply: 'none',
      localEditsKept: plan.keptEntries.length,
    });
    await saveLastReport(scrub(report, compiled.secretValues));
    return scrub(report, compiled.secretValues);
  }

  const operationSeq = durable.operationSeq + 1;
  const appliedAt = new Date().toISOString();
  const record: BundleRecord = {
    seq: operationSeq,
    version: state.version,
    fileHash,
    appliedAt,
    policy: state.policy,
    targets: compiled.targets,
    undo: plan.undo,
  };
  const entry = { seq: operationSeq, version: state.version, fileHash, appliedAt };
  const report = scrub(makeReport('applied', `Version ${state.version} is applied. ${count} object(s) changed, ${plan.unchanged} already matched.${keptSentence(plan)}`, reportOptions), compiled.secretValues);
  const journal: JournalRecord = {
    schemaVersion: 1,
    operationSeq,
    operation: 'apply',
    startedAt: appliedAt,
    version: state.version,
    previousVersion,
    forward: plan.forward,
    reverse: plan.reverse,
    commit: {
      ledgerTargets: plan.ledgerTargets,
      keptEntries: plan.keptEntries,
      current: { recordSeq: operationSeq, version: state.version, fileHash, appliedAt, policy: state.policy },
      newRecord: record,
      history: [...durable.history, entry].slice(-state.policy.keepVersions),
      report,
    },
  };
  const outcome = await runJournaled(journal);
  if (!outcome.ok) return scrub(outcome.report, compiled.secretValues);
  if (reconcileRuntime) reconcileServersInBackground(plan.forward);
  log.info(`Desired state version ${state.version} applied (${count} changed, ${plan.unchanged} unchanged)`);
  return report;
}

/** Return the whole instance to the version before the current one. */
export async function rollbackDesiredState(options: { dryRun?: boolean; reconcileRuntime?: boolean } = {}): Promise<DesiredStateReport> {
  const dryRun = options.dryRun === true;
  const blocked = unavailable(dryRun) ?? await lockedReport(dryRun);
  if (blocked) return blocked;
  try {
    return await withWorkspaceRuntimeLock(APPLY_LOCK, () => rollbackWithinLock(dryRun, options.reconcileRuntime !== false));
  } catch (error) {
    if (error instanceof SimulatedCrash) throw error;
    log.error('A desired-state rollback could not run', error);
    return makeReport('failed', 'The rollback could not run, for example because an apply is still going. Nothing was changed by this attempt.', { dryRun });
  }
}

async function rollbackWithinLock(dryRun: boolean, reconcileRuntime: boolean): Promise<DesiredStateReport> {
  const stuck = await resumeWithinLock();
  if (stuck) return stuck;
  const durable = await loadDurableState();
  const current = durable.current;
  const previousEntry = durable.history.at(-2);
  const leaving = current ? await loadBundleRecord(current.recordSeq) : null;
  const target = previousEntry ? await loadBundleRecord(previousEntry.seq) : null;
  if (!current || !previousEntry || !target || !leaving) {
    const report = makeReport('invalid', current
      ? `There is no earlier version to return to. Version ${current.version} stays applied. Nothing was changed.`
      : 'No version has been applied yet, so there is nothing to return from. Nothing was changed.', {
      dryRun, version: current?.version ?? null,
      problems: [{ where: 'rollback', message: 'no earlier version is kept' }],
    });
    if (!dryRun) await recordFailure('nothing-to-roll-back-to', report);
    return report;
  }
  const { targets, problems } = await targetsForRollback(target);
  const base = { dryRun, version: target.version, previousVersion: current.version };
  if (problems.length) {
    const report = makeReport('invalid', `Cannot return to version ${target.version}. Nothing was changed.`, { ...base, problems });
    if (!dryRun) await recordFailure('invalid-file', report);
    return report;
  }
  const policy: DesiredStatePolicy = current.policy;
  const plan = await buildOperationPlan({ targets, policy, durable, rollbackFrom: leaving });
  if (plan.problems.length) {
    const report = makeReport('invalid', `Cannot return to version ${target.version}. Nothing was changed.`, { ...base, problems: plan.problems });
    if (!dryRun) await recordFailure('invalid-file', report);
    return report;
  }
  const reportOptions = { ...base, changes: plan.changes, unchanged: plan.unchanged, restartRequired: plan.restartRequired };
  const count = changeSummary(plan);
  if (dryRun) {
    return makeReport('would-roll-back', `Returning to version ${target.version} would change ${count} object(s). Nothing was changed.${keptSentence(plan)}`, reportOptions);
  }
  const appliedAt = new Date().toISOString();
  const heldBack = { fileHash: current.fileHash, version: current.version, at: appliedAt };
  const report = makeReport('rolled-back', `Version ${target.version} is back in place, instead of ${current.version}. ${count} object(s) changed. Conversations already under way finish on the version they started with. The file for ${current.version} is not applied again by itself.${keptSentence(plan)}`, reportOptions);
  const journal: JournalRecord = {
    schemaVersion: 1,
    operationSeq: durable.operationSeq + 1,
    operation: 'rollback',
    startedAt: appliedAt,
    version: target.version,
    previousVersion: current.version,
    forward: plan.forward,
    reverse: plan.reverse,
    commit: {
      ledgerTargets: plan.ledgerTargets,
      keptEntries: plan.keptEntries,
      current: { recordSeq: target.seq, version: target.version, fileHash: target.fileHash, appliedAt, policy: target.policy },
      history: durable.history.slice(0, -1),
      heldBack,
      report,
    },
  };
  const outcome = await runJournaled(journal);
  if (!outcome.ok) return outcome.report;
  if (reconcileRuntime) reconcileServersInBackground(plan.forward);
  log.info(`Desired state rolled back to version ${target.version}`);
  return report;
}

/** Connecting can take long and can fail. Neither may hold up or undo an applied version. */
function reconcileServersInBackground(changes: ChangeSet): void {
  if (!changes.mcpServers.length) return;
  void (async () => {
    for (const change of changes.mcpServers) {
      try {
        if (change.value) await mcpService.updateServerConfig(change.name, {});
        else await mcpService.disconnectServer(change.name);
      } catch (error) {
        log.warn(`Server ${change.name} did not settle after the update`, error);
      }
    }
  })();
}

/** The decoded file named by the environment, or the reason it cannot be read. */
export async function readConfiguredFile(): Promise<{ configured: false } | { configured: true; input?: unknown; problem?: DesiredStateProblem }> {
  const file = process.env[DESIRED_STATE_FILE_ENV]?.trim();
  if (!file) return { configured: false };
  try {
    const stats = await fs.stat(file);
    if (!stats.isFile() || stats.size > MAX_FILE_BYTES) {
      return { configured: true, problem: { where: DESIRED_STATE_FILE_ENV, message: 'this does not name a file of a usable size.' } };
    }
    const text = await fs.readFile(file, 'utf8');
    try {
      return { configured: true, input: JSON.parse(text.replace(/^﻿/, '')) };
    } catch {
      return { configured: true, problem: { where: DESIRED_STATE_FILE_ENV, message: 'this file is not valid JSON.' } };
    }
  } catch {
    return { configured: true, problem: { where: DESIRED_STATE_FILE_ENV, message: 'this file cannot be read.' } };
  }
}

/** Apply or check what the environment names, on request. */
export async function applyConfiguredDesiredState(options: { dryRun?: boolean; reconcileRuntime?: boolean } = {}): Promise<DesiredStateReport> {
  const read = await readConfiguredFile();
  if (!read.configured) {
    return makeReport('invalid', `No file is named by ${DESIRED_STATE_FILE_ENV}, and the request did not include one. Nothing was changed.`, {
      dryRun: options.dryRun, problems: [{ where: DESIRED_STATE_FILE_ENV, message: 'not set' }],
    });
  }
  if (read.problem) {
    const report = makeReport('invalid', 'The file cannot be used, so nothing was changed.', { dryRun: options.dryRun, problems: [read.problem] });
    if (!options.dryRun) await recordFailure('unreadable-file', report);
    return report;
  }
  return applyDesiredState(read.input, options);
}

/**
 * Startup, after the workspace is unlocked and before servers and schedules start. Never
 * throws: a bad file must not stop an instance from coming up, and it is reported.
 */
export async function applyDesiredStateAtStartup(): Promise<void> {
  if (isWorkerMode()) return;
  try {
    const stuck = await withWorkspaceRuntimeLock(APPLY_LOCK, () => resumeWithinLock());
    if (stuck) log.error(stuck.message);
    // A restart is what a pending restart was waiting for.
    const status = await loadStatus();
    if (status.restartRequired) await updateStatus({ restartRequired: false });
    if (status.interruptedApply === 'none' && stuck) return;

    const read = await readConfiguredFile();
    if (!read.configured) return;
    if (read.problem) {
      await recordFailure('unreadable-file', makeReport('invalid', 'The file cannot be used, so nothing was changed.', { problems: [read.problem] }));
      log.error('The desired-state file cannot be used. Nothing was changed.');
      return;
    }
    const parsed = parseDesiredState(read.input);
    if (parsed.ok && !parsed.state.workspaces.includes(getCurrentWorkspace())) return;
    // An operator went back from this exact file. Starting up must not undo that.
    const durable = await loadDurableState();
    if (durable.heldBack?.fileHash === hashOf(read.input)) {
      log.warn(`Not applying version ${durable.heldBack.version} again, because it was rolled back. Change the file or apply it on request.`);
      return;
    }
    const report = await getSchedulerService().withArmingDeferred(() => applyDesiredState(read.input, { reconcileRuntime: false }));
    if (report.outcome === 'invalid' || report.outcome === 'failed') log.error(`Desired state not applied: ${report.message}`);
    else log.info(report.message);
  } catch (error) {
    if (error instanceof SimulatedCrash) throw error;
    log.error('Applying the desired state at startup failed', error);
    await recordFailure('write-failed', makeReport('failed', 'Applying the desired state at startup failed. See the FLUJO log.')).catch(() => undefined);
  }
}

/**
 * A file can name workspaces that do not exist yet, so one instance can be set up for
 * several separate groups with no hands. Called before workspaces are listed at startup.
 */
export async function ensureDesiredStateWorkspaces(): Promise<void> {
  if (isWorkerMode()) return;
  const read = await readConfiguredFile();
  if (!read.configured || read.problem) return;
  const source = read.input as { workspace?: unknown; workspaces?: unknown };
  const names = Array.isArray(source?.workspaces) ? source.workspaces : source?.workspace !== undefined ? [source.workspace] : [];
  for (const name of names) {
    try {
      const normalized = normalizeWorkspaceName(name);
      if (!await workspaceExists(normalized)) await createWorkspace(normalized);
    } catch (error) {
      log.warn('A workspace named by the desired-state file could not be created', error);
    }
  }
}

/** Everything an operator may want to see. No content and no values. */
export async function getDesiredStateOverview() {
  const [durable, status, lastReport, journal] = await Promise.all([
    loadDurableState(), loadStatus(), loadLastReport(), loadJournal(),
  ]);
  return {
    status: projectDesiredStateStatus({ ...emptyDesiredStateStatus(), ...status }),
    interruptedApplyWaiting: journal !== null,
    versions: durable.history.map(({ seq, version, appliedAt }) => ({ seq, version, appliedAt })),
    managed: Object.values(durable.ledger).map(({ kind, id, localEditKept }) => ({ kind, id, ...(localEditKept ? { localEditKept } : {}) })),
    lastReport,
  };
}
