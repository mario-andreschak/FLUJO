/**
 * Removes stored conversations once their retention period has passed.
 *
 * Off unless a workspace turns it on. While off, a run costs one settings read and one
 * directory read. Deleting always goes through deleteConversationCompletely.
 *
 * A run has two steps. First it reads the small summary of every conversation and
 * decides from that, reading a full state file only when no summary is usable. Then it
 * removes what expired, in small batches with a pause between them. All file access is
 * one at a time, so a sweep over 10,000+ conversations leaves room for live traffic.
 *
 * A conversation with its subflow children is one unit: it goes when the whole tree
 * has been idle for the period of the top conversation's flow, and any member that is
 * in use keeps all of them.
 */
import { promises as fs } from 'fs';
import path from 'path';
import { createLogger } from '@/utils/logger';
import { getWorkspaceDataDir, workspaceCacheKey } from '@/utils/workspace';
import {
  assertSafeCollectionId,
  listCollectionItems,
  loadItem,
  saveItem,
} from '@/utils/storage/backend';
import { StorageKey, type Settings } from '@/shared/types/storage/storage';
import {
  effectiveRetentionDays,
  isValidRetentionDays,
  type ConversationRetentionKeepReason,
  type ConversationRetentionReport,
  type ConversationRetentionSettings,
  type ConversationRetentionStatus,
} from '@/shared/types/conversationRetention';
import { CONVERSATION_SUMMARY_VERSION } from '@/shared/types/conversationSummary';
import type { Flow } from '@/shared/types/flow';
import type { PlannedExecutionsFile, RunRecord } from '@/shared/types/plannedExecution';
import type { SubflowTaskRecord } from '@/shared/types/subflowTasks';
import { FlowExecutor } from '@/backend/execution/flow/FlowExecutor';
import type { SharedState } from '@/backend/execution/flow/types';
import { isConversationExecutionLocked } from '@/backend/execution/flow/conversationExecutionLock';
import { isExecutionProtectedState } from '@/backend/execution/extensions';
import { isPersonaOwnedConversationState } from '@/backend/execution/flow/personaConversationOwnership';
import { recoveryOwnerId } from '@/backend/execution/flow/recoveryCheckpoint';
import { withConversationLogReadAdmission } from '@/backend/execution/flow/conversationLogReadAdmission';
import { listPendingQuestions } from '@/backend/services/questionRegistry';
import { listPendingElicitations } from '@/backend/services/mcp/elicitationRegistry';
import { listPendingApprovals } from '@/backend/services/scheduler/pendingApprovals';
import { listRunHistoryExecutions, loadRunRecords, scrubRunRecordText } from '@/backend/services/scheduler/runHistory';
import { listMeetings } from '@/backend/services/meetings/store';
import { getHarnessProfile } from '@/backend/services/harness/profiles';
import { deleteHarnessObservation } from '@/backend/services/harness/observationStore';
import {
  buildConversationDeletionIndex,
  conversationStateDir,
  deleteConversationCompletely,
  finishInterruptedConversationDeletions,
  stateSiblingOwner,
  type ConversationDeletionIndex,
} from './deletion';

const log = createLogger('backend/services/conversations/retention');

const DAY_MS = 24 * 60 * 60 * 1000;
/** How many conversations are read before other work gets a turn. */
const SCAN_SLICE = 200;
const DELETE_BATCH = 25;
const BATCH_PAUSE_MS = 100;
const STATUS_KEY = 'conversation-retention-status' as StorageKey;
const TERMINAL_MEETING = new Set(['completed', 'cancelled', 'error']);
const TERMINAL_TASK = new Set(['completed', 'failed', 'cancelled']);

export interface ConversationRetentionRunOptions {
  dryRun?: boolean;
  /** Try settings out before saving them. Only honoured for a dry run. */
  settings?: ConversationRetentionSettings;
  /** Test seams; the defaults are what production uses. */
  now?: number;
  batchSize?: number;
  pauseMs?: number;
}

interface ScannedConversation {
  id: string;
  activity: number;
  flowId?: string;
  parent?: string;
  root?: string;
  keep?: ConversationRetentionKeepReason;
}

const runtime = globalThis as typeof globalThis & {
  __flujoConversationRetentionRuns?: Map<string, Promise<ConversationRetentionReport | undefined>>;
  __flujoConversationRetentionStatus?: Map<string, Pick<ConversationRetentionStatus, 'lastRun' | 'lastDryRun'>>;
};
const runs = () => (runtime.__flujoConversationRetentionRuns ??= new Map());
const statuses = () => (runtime.__flujoConversationRetentionStatus ??= new Map());

const sleep = (ms: number) => new Promise<void>(resolve => {
  const timer = setTimeout(resolve, ms);
  timer.unref?.();
});
const breathe = () => new Promise<void>(resolve => { setImmediate(resolve); });

async function loadRetentionSettings(): Promise<ConversationRetentionSettings | undefined> {
  const settings = await loadItem<Settings | undefined>(StorageKey.SPEECH_SETTINGS, undefined);
  return settings?.conversationRetention;
}

/** What makes a conversation untouchable, whatever its age. */
function keepReasonFromState(
  state: Partial<SharedState> & { personaOwned?: unknown; personaId?: unknown; executionExtensionOwned?: unknown },
  live: boolean,
): ConversationRetentionKeepReason | undefined {
  if (isPersonaOwnedConversationState(state) || state.personaId) return 'persona';
  if (state.executionExtensionOwned || isExecutionProtectedState(state as SharedState)) return 'protected';
  if (state.status === 'awaiting_tool_approval' || state.status === 'paused_debug') return 'waiting';
  if (state.status === 'running') {
    // A run whose owning process has gone is not running: it stopped in a crash and
    // nothing will ever move it on. Without this it could never expire.
    const owner = state.recovery?.ownerId;
    if (live || !owner || owner === recoveryOwnerId()) return 'running';
  }
  if (state.pendingToolCalls?.length || state.debugPendingToolCalls?.length || state.debugPendingAction) return 'waiting';
  for (const invocation of Object.values(state.subflowInvocations ?? {})) {
    if (invocation.status !== 'folded') return 'waiting';
  }
  return undefined;
}

function lastActivity(state: { updatedAt?: unknown; lastUserMessageAt?: unknown; createdAt?: unknown }, fileTime: number): number {
  const known = [state.updatedAt, state.lastUserMessageAt, state.createdAt]
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0);
  // Stored dates win over the file's own date: restoring a backup gives old
  // conversations a fresh file date, and that must not restart their period.
  return known.length ? Math.max(...known) : fileTime;
}

function describe(id: string, state: Partial<SharedState> & Record<string, unknown>, fileTime: number, live: boolean): ScannedConversation {
  return {
    id,
    activity: lastActivity(state, fileTime),
    ...(typeof state.flowId === 'string' ? { flowId: state.flowId } : {}),
    ...(typeof state.parentConversationId === 'string' ? { parent: state.parentConversationId } : {}),
    ...(typeof state.rootConversationId === 'string' ? { root: state.rootConversationId } : {}),
    ...(() => {
      const keep = keepReasonFromState(state, live);
      return keep ? { keep } : {};
    })(),
  };
}

/** Prefer the small summary; it is only trusted when it matches the state file. */
async function readConversation(id: string, filePath: string): Promise<ScannedConversation> {
  const live = FlowExecutor.conversationStates.get(id);
  if (live) return describe(id, live as unknown as Partial<SharedState> & Record<string, unknown>, Date.now(), true);
  const stats = await fs.stat(filePath);
  try {
    const summary = JSON.parse(await fs.readFile(
      path.join(getWorkspaceDataDir(), 'db', 'conversation-summaries', `${id}.json`), 'utf8',
    )) as Record<string, unknown>;
    if (summary.version === CONVERSATION_SUMMARY_VERSION
      && summary.snapshotMtimeMs === stats.mtimeMs && summary.snapshotSize === stats.size) {
      return describe(id, summary as Partial<SharedState> & Record<string, unknown>, stats.mtimeMs, false);
    }
  } catch { /* No usable summary: read the state file. */ }
  // Not through the storage layer: on a broken file it writes a backup copy, and a
  // sweep every hour would make a new copy of the text every hour.
  return withConversationLogReadAdmission(stats.size, async () => {
    const parsed = JSON.parse(await fs.readFile(filePath, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Not a conversation.');
    return describe(id, parsed as Partial<SharedState> & Record<string, unknown>, stats.mtimeMs, false);
  });
}

/** Conversations something else still needs, by reasons that do not show in their own state. */
async function buildProtection(index: ConversationDeletionIndex): Promise<Map<string, ConversationRetentionKeepReason>> {
  const protect = new Map<string, ConversationRetentionKeepReason>();
  for (const approval of await listPendingApprovals()) protect.set(approval.conversationId, 'schedule');
  for (const executionId of await listRunHistoryExecutions()) {
    for (const record of await loadRunRecords(executionId)) {
      if (record.status === 'needs_approval' && record.conversationId) protect.set(record.conversationId, 'schedule');
    }
  }
  for (const task of await listCollectionItems<SubflowTaskRecord>('subflow-tasks')) {
    if (!task || TERMINAL_TASK.has(task.status)) continue;
    if (task.originConversationId) protect.set(task.originConversationId, 'subflow_task');
    if (task.childConversationId) protect.set(task.childConversationId, 'subflow_task');
  }
  for (const meeting of await listMeetings()) {
    if (TERMINAL_MEETING.has(meeting.status)) continue;
    for (const participant of meeting.participants ?? []) {
      if (participant.conversationId) protect.set(participant.conversationId, 'meeting');
    }
  }
  for (const [conversationId, invocations] of index.nativeInvocations) {
    if (invocations.some(item => !item.resolved)) protect.set(conversationId, 'native_unresolved');
  }
  return protect;
}

function treeRootOf(entry: ScannedConversation, all: Map<string, ScannedConversation>): string {
  if (entry.root && all.has(entry.root)) return entry.root;
  let current = entry;
  const seen = new Set<string>([current.id]);
  while (current.parent && all.has(current.parent) && !seen.has(current.parent)) {
    current = all.get(current.parent)!;
    seen.add(current.id);
  }
  return current.id;
}

const recordTime = (record: RunRecord) => Date.parse(record.finishedAt ?? record.firedAt);

async function sweep(
  settings: ConversationRetentionSettings,
  options: ConversationRetentionRunOptions,
  resumedDeletions: number,
): Promise<ConversationRetentionReport> {
  const dryRun = options.dryRun === true;
  const now = options.now ?? Date.now();
  const batchSize = Math.max(1, options.batchSize ?? DELETE_BATCH);
  const pauseMs = Math.max(0, options.pauseMs ?? BATCH_PAUSE_MS);
  const report: ConversationRetentionReport = {
    dryRun, startedAt: Date.now(), finishedAt: 0, scanned: 0, deleted: 0, incomplete: 0, failed: 0, kept: {},
    runRecordsCleared: 0, harnessExamplesRemoved: 0, resumedDeletions,
  };
  const keep = (reason: ConversationRetentionKeepReason, count = 1) => {
    report.kept[reason] = (report.kept[reason] ?? 0) + count;
  };

  // If any of this cannot be read, nothing is removed: we could not tell what is needed.
  let index: ConversationDeletionIndex;
  let protection: Map<string, ConversationRetentionKeepReason>;
  const flowDays = new Map<string, unknown>();
  try {
    index = await buildConversationDeletionIndex();
    protection = await buildProtection(index);
    for (const flow of await listCollectionItems<Flow>('flows')) {
      if (flow?.id && flow.conversationRetentionDays !== undefined) flowDays.set(flow.id, flow.conversationRetentionDays);
    }
  } catch (error) {
    log.warn('Conversation retention could not read what is still in use; nothing was removed', error);
    report.error = 'protection_unavailable';
    report.finishedAt = Date.now();
    return report;
  }
  const periodFor = (flowId: string | undefined) => effectiveRetentionDays(settings, flowId ? flowDays.get(flowId) : undefined);

  // Step 1: read what is there.
  const all = new Map<string, ScannedConversation>();
  const orphanSiblings: Array<{ owner: string; name: string }> = [];
  const directory = conversationStateDir();
  let handle: Awaited<ReturnType<typeof fs.opendir>> | undefined;
  try {
    handle = await fs.opendir(directory, { bufferSize: 128 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (handle) {
    let read = 0;
    for await (const entry of handle) {
      if (!entry.isFile()) continue;
      const owner = stateSiblingOwner(entry.name);
      if (owner) { orphanSiblings.push({ owner, name: entry.name }); continue; }
      if (!entry.name.endsWith('.json') || entry.name.endsWith('.bak')) continue;
      const id = entry.name.slice(0, -'.json'.length);
      try { assertSafeCollectionId(id); } catch { continue; }
      report.scanned += 1;
      try {
        all.set(id, await readConversation(id, path.join(directory, entry.name)));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') { report.scanned -= 1; continue; }
        // One bad file costs only itself. It stays, and shows in the counts.
        keep('unreadable');
      }
      if (++read % SCAN_SLICE === 0) await breathe();
    }
  }

  // Step 2: decide per tree.
  const trees = new Map<string, ScannedConversation[]>();
  for (const entry of all.values()) {
    const root = treeRootOf(entry, all);
    const members = trees.get(root);
    if (members) members.push(entry);
    else trees.set(root, [entry]);
  }
  const expired: Array<{ id: string; cutoff: number }> = [];
  let decided = 0;
  for (const [rootId, members] of trees) {
    if (++decided % SCAN_SLICE === 0) await breathe();
    const days = periodFor(all.get(rootId)?.flowId);
    if (days === undefined) { keep('no_period', members.length); continue; }
    const cutoff = now - days * DAY_MS;
    const reason = members.map(member => member.keep ?? protection.get(member.id)).find(Boolean);
    if (reason) { keep(reason, members.length); continue; }
    if (members.some(member => member.activity >= cutoff)) { keep('recent', members.length); continue; }
    // The event log is written during a run, the state file mostly after it.
    const logTimes = await Promise.all(members.map(member => fs.stat(
      path.join(getWorkspaceDataDir(), 'db', 'conversation-logs', `${member.id}.jsonl`),
    ).then(stats => stats.mtimeMs, () => 0)));
    if (logTimes.some(time => time >= cutoff)) { keep('recent', members.length); continue; }
    for (const member of members.filter(item => item.id !== rootId)) expired.push({ id: member.id, cutoff });
    expired.push({ id: rootId, cutoff });
  }

  // Step 3: remove, children before their parent.
  if (dryRun) {
    report.deleted = expired.length;
  } else {
    for (let start = 0; start < expired.length; start += batchSize) {
      for (const { id, cutoff } of expired.slice(start, start + batchSize)) {
        // A run holds this lock. Waiting for it could take any amount of time, and the
        // run's own activity will keep the conversation at the next check anyway.
        if (isConversationExecutionLocked(id)) { keep('busy'); continue; }
        try {
          const result = await deleteConversationCompletely<ConversationRetentionKeepReason | 'gone'>(id, {
            index,
            guard: state => recheckUnderLock(id, state, cutoff),
          });
          if (!result.deleted) {
            if (result.refusal !== 'gone') keep(result.refusal);
          } else {
            report.deleted += 1;
            if (!result.complete) report.incomplete += 1;
          }
        } catch (error) {
          report.failed += 1;
          log.warn('Conversation retention could not remove one conversation; carrying on', { conversationId: id, error });
        }
      }
      if (start + batchSize < expired.length && pauseMs > 0) await sleep(pauseMs);
    }
  }

  // Backups whose conversation is already gone, left by older versions.
  const workspaceDays = periodFor(undefined);
  if (workspaceDays !== undefined && !dryRun) {
    const cutoff = now - workspaceDays * DAY_MS;
    for (const { owner, name } of orphanSiblings) {
      if (all.has(owner)) continue;
      const target = path.join(directory, name);
      const old = await fs.stat(target).then(stats => stats.mtimeMs < cutoff, () => false);
      if (old) await fs.rm(target, { force: true }).catch(() => undefined);
    }
  }

  await clearRunHistoryText(report, periodFor, now, dryRun);
  await clearHarnessExamples(index, report, periodFor, now, dryRun);
  report.finishedAt = Date.now();
  return report;
}

/** The same questions again, on the authoritative state, now that no run can start. */
async function recheckUnderLock(
  id: string,
  state: SharedState | undefined,
  cutoff: number,
): Promise<ConversationRetentionKeepReason | 'gone' | undefined> {
  const live = FlowExecutor.conversationStates.get(id);
  const current = live ?? state;
  if (!current) return 'gone';
  const reason = keepReasonFromState(current, Boolean(live));
  if (reason) return reason;
  if (listPendingQuestions(id).length > 0 || listPendingElicitations(id).length > 0) return 'waiting';
  if (lastActivity(current, Date.now()) >= cutoff) return 'recent';
  return undefined;
}

/**
 * Scheduled runs keep their final output and error in run history, even those that run
 * with no saved conversation at all. That text ages out like a conversation. The row
 * stays, so the schedule's history still shows when it ran and how it ended.
 */
async function clearRunHistoryText(
  report: ConversationRetentionReport,
  periodFor: (flowId: string | undefined) => number | undefined,
  now: number,
  dryRun: boolean,
): Promise<void> {
  try {
    const file = await loadItem<PlannedExecutionsFile | undefined>(StorageKey.PLANNED_EXECUTIONS, undefined);
    const flowOf = new Map((file?.executions ?? []).map(execution => [execution.id, execution.flowId]));
    let done = 0;
    for (const executionId of await listRunHistoryExecutions()) {
      if (++done % SCAN_SLICE === 0) await breathe();
      const days = periodFor(flowOf.get(executionId));
      if (days === undefined) continue;
      const cutoff = now - days * DAY_MS;
      const expired = (record: RunRecord) => recordTime(record) < cutoff;
      if (dryRun) {
        report.runRecordsCleared += (await loadRunRecords(executionId)).filter(record =>
          (record.outputText !== undefined || record.error !== undefined) && record.status !== 'needs_approval'
          && !record.personaId && !record.personaArchived && expired(record)).length;
      } else {
        report.runRecordsCleared += await scrubRunRecordText(executionId, expired);
      }
    }
  } catch (error) {
    report.failed += 1;
    log.warn('Conversation retention could not clear scheduler run text', error);
  }
}

/** Recorded examples age out too. Examples for a Persona belong to that Persona. */
async function clearHarnessExamples(
  index: ConversationDeletionIndex,
  report: ConversationRetentionReport,
  periodFor: (flowId: string | undefined) => number | undefined,
  now: number,
  dryRun: boolean,
): Promise<void> {
  const flowOfProfile = new Map<string, string | null | undefined>();
  for (const item of index.harnessObservations) {
    try {
      if (!flowOfProfile.has(item.profileId)) {
        const profile = await getHarnessProfile(item.profileId);
        flowOfProfile.set(item.profileId, profile?.target.kind === 'persona' ? null : profile?.target.flowId);
      }
      const flowId = flowOfProfile.get(item.profileId);
      if (flowId === null) continue;
      const days = periodFor(flowId);
      if (days === undefined || item.createdAt >= now - days * DAY_MS) continue;
      if (dryRun || await deleteHarnessObservation(item.profileId, item.id)) report.harnessExamplesRemoved += 1;
    } catch (error) {
      report.failed += 1;
      log.warn('Conversation retention could not remove a recorded example', error);
    }
  }
}

function remember(report: ConversationRetentionReport): void {
  const key = workspaceCacheKey('conversation-retention');
  const current = statuses().get(key) ?? {};
  const next = report.dryRun ? { ...current, lastDryRun: report } : { ...current, lastRun: report };
  statuses().set(key, next);
  // Worth keeping across a restart, not worth failing a sweep over.
  void saveItem(STATUS_KEY, next).catch(error => log.debug('Could not save the retention status', error));
}

/**
 * One run for the current workspace. Never rejects. Overlapping calls share the run
 * that is already going; a dry run is read-only and always runs on its own.
 */
export function runConversationRetention(
  options: ConversationRetentionRunOptions = {},
): Promise<ConversationRetentionReport | undefined> {
  const key = workspaceCacheKey('conversation-retention');
  if (!options.dryRun) {
    const existing = runs().get(key);
    if (existing) return existing;
  }
  const run = (async () => {
    try {
      const resumed = options.dryRun ? { finished: 0 } : await finishInterruptedConversationDeletions();
      const settings = options.dryRun && options.settings ? options.settings : await loadRetentionSettings();
      // Turned off: not one conversation is looked at.
      if (settings?.enabled !== true) return undefined;
      const report = await sweep(settings, options, resumed.finished);
      remember(report);
      log.info('Conversation retention finished', { ...report });
      return report;
    } catch (error) {
      log.warn('Conversation retention run failed', error);
      const now = Date.now();
      const report: ConversationRetentionReport = {
        dryRun: options.dryRun === true, startedAt: now, finishedAt: now, scanned: 0, deleted: 0, incomplete: 0, failed: 0,
        kept: {}, runRecordsCleared: 0, harnessExamplesRemoved: 0, resumedDeletions: 0, error: 'run_failed',
      };
      remember(report);
      return report;
    }
  })();
  if (options.dryRun) return run;
  runs().set(key, run);
  void run.finally(() => { if (runs().get(key) === run) runs().delete(key); });
  return run;
}

/** Settings and last results for this workspace: counts only, nothing from a conversation. */
export async function getConversationRetentionStatus(): Promise<ConversationRetentionStatus> {
  const key = workspaceCacheKey('conversation-retention');
  let remembered = statuses().get(key);
  if (!remembered) {
    remembered = await loadItem<Pick<ConversationRetentionStatus, 'lastRun' | 'lastDryRun'>>(STATUS_KEY, {}).catch(() => ({}));
    statuses().set(key, remembered ?? {});
  }
  const settings = await loadRetentionSettings().catch(() => undefined);
  return {
    enabled: settings?.enabled === true,
    ...(isValidRetentionDays(settings?.days) && settings.days > 0 ? { days: settings.days } : {}),
    precedence: settings?.precedence === 'flow' ? 'flow' : 'shorter',
    running: runs().has(key),
    ...(remembered?.lastRun ? { lastRun: remembered.lastRun } : {}),
    ...(remembered?.lastDryRun ? { lastDryRun: remembered.lastDryRun } : {}),
  };
}
