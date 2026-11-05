/**
 * Durable records of the desired state, all under db/desired-state in the workspace.
 *
 * - `state`    what is applied now and which objects are managed (the ledger)
 * - `journal`  written before the first change, removed after the last. If it is still
 *              there at startup, an apply was interrupted
 * - `status`   content-free facts for the operations status route
 * - `history`  one complete record per applied version. A rollback uses only these, so it
 *              never depends on the best-effort per-flow history, which is capped and is
 *              wiped when a flow is deleted
 *
 * Stored credentials appear here only as the store holds them: as references or in
 * their encrypted form. Values read from the environment never do.
 */
import {
  deleteCollectionItem,
  listCollectionItems,
  loadCollectionItem,
  saveCollectionItem,
} from '@/utils/storage/backend';
import type { Flow } from '@/shared/types/flow';
import type { Model } from '@/shared/types/model';
import type { DesiredStatePolicy, DesiredStateProblem } from './schema';
import { emptyDesiredStateStatus, type DesiredStateStatus } from './status';

const COLLECTION = 'desired-state';
const HISTORY_COLLECTION = 'desired-state-history';

export type ManagedKind = 'setting' | 'secret' | 'model' | 'mcpServer' | 'flow' | 'plannedExecution';

export interface LedgerEntry {
  kind: ManagedKind;
  id: string;
  /** Fingerprint of what the file asked for. */
  desiredHash: string;
  /** Fingerprint of what was stored afterwards. A different stored object means a local edit. */
  appliedHash: string | null;
  /** The file's version is not applied to this object, because a local edit was kept. */
  localEditKept?: boolean;
}

export type StoredServer = Record<string, unknown>;
export type PlannedExecutionDefinition = Record<string, unknown> & { id: string };

export interface SettingTarget { path: string[]; value: unknown }
export interface SecretTarget { name: string; fromEnv?: string }

/** A complete description of one version, already compiled. */
export interface BundleTargets {
  secrets: SecretTarget[];
  settings: SettingTarget[];
  models: Model[];
  mcpServers: Array<{ name: string; config: StoredServer }>;
  /** Children before the flows that call them. */
  flows: Flow[];
  plannedExecutions: PlannedExecutionDefinition[];
}

/** One write in either direction. A null value means the object should not exist. */
export interface ChangeSet {
  secrets: Array<{ name: string; fromEnv?: string; stored?: unknown }>;
  settings: Array<{ path: string[]; exists: boolean; value?: unknown }>;
  models: Array<{ id: string; value: Model | null }>;
  mcpServers: Array<{ name: string; value: StoredServer | null }>;
  flows: Array<{ id: string; value: Flow | null }>;
  plannedExecutions: Array<{ id: string; value: PlannedExecutionDefinition | null }>;
}

export function emptyChangeSet(): ChangeSet {
  return { secrets: [], settings: [], models: [], mcpServers: [], flows: [], plannedExecutions: [] };
}

/** What taking over or first managing an object replaced, for a later rollback. */
export interface BundleUndo {
  settings: Array<{ path: string[]; exists: boolean; value?: unknown }>;
  adopted: ChangeSet;
}

export interface BundleRecord {
  seq: number;
  version: string;
  fileHash: string;
  appliedAt: string;
  policy: DesiredStatePolicy;
  targets: BundleTargets;
  undo: BundleUndo;
}

export interface CurrentVersion {
  recordSeq: number;
  version: string;
  fileHash: string;
  appliedAt: string;
  policy: DesiredStatePolicy;
}

export interface HistoryEntry {
  seq: number;
  version: string;
  fileHash: string;
  appliedAt: string;
}

export interface DurableState {
  schemaVersion: 1;
  /** Counts finished operations. A journal with a lower or equal number already finished. */
  operationSeq: number;
  current: CurrentVersion | null;
  ledger: Record<string, LedgerEntry>;
  /** The kept versions, oldest first. The last one is the current version. */
  history: HistoryEntry[];
  heldBack?: { fileHash: string; version: string; at: string };
}

export function emptyDurableState(): DurableState {
  return { schemaVersion: 1, operationSeq: 0, current: null, ledger: {}, history: [] };
}

export interface DesiredStateChange {
  kind: ManagedKind;
  id: string;
  action:
    | 'create' | 'update' | 'delete' | 'adopt' | 'recreate'
    | 'overwrite-local-edit' | 'keep-local-edit' | 'unmanage' | 'restore';
  /** Which fields differ. Never their contents. */
  fields?: string[];
  from?: unknown;
  to?: unknown;
  reason?: string;
}

export type DesiredStateOutcome =
  | 'applied' | 'unchanged' | 'would-change' | 'would-not-change' | 'rolled-back' | 'would-roll-back'
  | 'invalid' | 'failed' | 'locked' | 'not-available' | 'held-back';

export interface DesiredStateReport {
  outcome: DesiredStateOutcome;
  dryRun: boolean;
  workspace: string;
  version: string | null;
  previousVersion: string | null;
  changes: DesiredStateChange[];
  /** Managed objects that match the file and need nothing. */
  unchanged: number;
  problems: DesiredStateProblem[];
  warnings: string[];
  /** Settings that only take effect after a restart. */
  restartRequired: string[];
  /** Plain words about what happened and what state the instance is in. */
  message: string;
}

export interface JournalRecord {
  schemaVersion: 1;
  operationSeq: number;
  operation: 'apply' | 'rollback';
  startedAt: string;
  version: string;
  previousVersion: string | null;
  forward: ChangeSet;
  reverse: ChangeSet;
  /** What to record once the writes are done. */
  commit: {
    ledgerTargets: Array<{ kind: ManagedKind; id: string; desiredHash: string }>;
    keptEntries: LedgerEntry[];
    current: CurrentVersion;
    newRecord?: BundleRecord;
    history: HistoryEntry[];
    heldBack?: DurableState['heldBack'];
    report: DesiredStateReport;
  };
}

export const loadDurableState = (): Promise<DurableState> =>
  loadCollectionItem<DurableState>(COLLECTION, 'state', emptyDurableState());
export const saveDurableState = (state: DurableState): Promise<void> =>
  saveCollectionItem(COLLECTION, 'state', state);

export const loadJournal = (): Promise<JournalRecord | null> =>
  loadCollectionItem<JournalRecord | null>(COLLECTION, 'journal', null);
export const saveJournal = (journal: JournalRecord): Promise<void> =>
  saveCollectionItem(COLLECTION, 'journal', journal);
export const clearJournal = (): Promise<void> => deleteCollectionItem(COLLECTION, 'journal');

export const loadStatus = (): Promise<DesiredStateStatus> =>
  loadCollectionItem<DesiredStateStatus>(COLLECTION, 'status', emptyDesiredStateStatus());
export const saveStatus = (status: DesiredStateStatus): Promise<void> =>
  saveCollectionItem(COLLECTION, 'status', status);
export async function updateStatus(patch: Partial<DesiredStateStatus>): Promise<DesiredStateStatus> {
  const next = { ...emptyDesiredStateStatus(), ...await loadStatus(), ...patch };
  await saveStatus(next);
  return next;
}

export const loadLastReport = (): Promise<DesiredStateReport | null> =>
  loadCollectionItem<DesiredStateReport | null>(COLLECTION, 'last-report', null);
export const saveLastReport = (report: DesiredStateReport): Promise<void> =>
  saveCollectionItem(COLLECTION, 'last-report', report);

/** Fixed width, so the file names sort in the order they were applied. */
const recordId = (seq: number): string => String(seq).padStart(12, '0');

export const saveBundleRecord = (record: BundleRecord): Promise<void> =>
  saveCollectionItem(HISTORY_COLLECTION, recordId(record.seq), record);
export const loadBundleRecord = (seq: number): Promise<BundleRecord | null> =>
  loadCollectionItem<BundleRecord | null>(HISTORY_COLLECTION, recordId(seq), null);

/** Remove records no longer kept, including any left behind by an interrupted run. */
export async function pruneBundleRecords(keep: readonly number[]): Promise<void> {
  const records = await listCollectionItems<BundleRecord>(HISTORY_COLLECTION);
  for (const record of records) {
    if (!keep.includes(record.seq)) await deleteCollectionItem(HISTORY_COLLECTION, recordId(record.seq));
  }
}
