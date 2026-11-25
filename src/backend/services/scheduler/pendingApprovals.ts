import { randomUUID } from 'crypto';
import { saveItem, loadItem } from '@/utils/storage/backend';
import { StorageKey } from '@/shared/types/storage';
import { createLogger } from '@/utils/logger';
import { bindToCurrentWorkspace, getCurrentWorkspace } from '@/utils/workspace';
import type { TriggerFirePayload } from '@/shared/types/plannedExecution';
import { withPersonaRuntimeLock } from '@/backend/services/enduringAgents/runtimeLock';
import { EnduringAgentIdSchema } from '@/shared/types/enduringAgent';
import { retryTransientFileOperation } from '@/utils/transientFileRetry';

const log = createLogger('backend/services/scheduler/pendingApprovals');

/**
 * Durable approval inbox (issue #115).
 *
 * When a HEADLESS (scheduled) run pauses on a tool that needs approval
 * (approvalPolicy 'pause'), the scheduler records a metadata-only entry here so
 * GET /api/approvals can list the paused run WITHOUT scanning every
 * conversation, and POST /api/approvals/:id can find + reconcile it after a
 * process restart. Cleared once the approval is resolved.
 *
 * The store is a single JSON object keyed by the run's conversationId at
 * db/pending_approvals.json. It carries ONLY metadata (ids, flow, tool NAMES,
 * timestamps) — never prompt text, messages, tool arguments or any decrypted
 * binding. The actual paused SharedState (with the real tool calls) lives in
 * the conversations/* store and is the source of truth for the resume; this
 * index just makes the paused run discoverable.
 */
export interface PendingApprovalEntry {
  /** Storage key of the entry — equal to the run's conversationId. */
  approvalId: string;
  /**
   * Opaque receipt for exactly one batch of waiting tool calls (#1284). Callers
   * decide with it; it stops working once that batch is decided or cancelled,
   * and a later batch gets a new one. Entries saved before receipts existed
   * have none: their conversation id works as the receipt for the batch they
   * hold, and never for a later one.
   */
  receipt?: string;
  conversationId: string;
  plannedExecutionId: string;
  flowId: string;
  flowName?: string;
  /** The run history record id this approval belongs to (for reconciliation). */
  runId: string;
  triggerSummary: string;
  /** Tool call id + name only — never arguments. */
  pendingToolCalls: Array<{ id: string; name: string }>;
  createdAt: string;
  /** Durable marker that an approval decision already resumed this Activity. */
  resumeDispatchId?: string;
  resumeRequestedAt?: string;
  /**
   * Stable scheduler terminal-publication identity retained across an approval
   * yield. Present only for Persona deliveries admitted through the mailbox.
   */
  terminalPublication?: {
    triggerKind: TriggerFirePayload['kind'];
    chainDepth: number;
    deliveryId: string;
    execution: {
      id: string;
      generationId?: string;
      name: string;
      flowId: string;
      personaId: string;
    };
  };
}

type PendingApprovalsFile = Record<string, PendingApprovalEntry>;

const KEY = StorageKey.PENDING_APPROVALS;
const LOCK_ID = 'scheduler_pending_approvals';

/** Serializes read-modify-write mutations so concurrent pauses/resolves can't
 *  clobber each other's entries. */
const writeChains = new Map<string, Promise<unknown>>();

/**
 * Read the inbox for a change. A read that fails (after short retries for
 * errors that clear up on their own) throws, so a writer never mistakes an
 * unreadable inbox for an empty one and saves over every other entry.
 */
async function loadForChange(): Promise<PendingApprovalsFile> {
  const file = await retryTransientFileOperation(() => loadItem<PendingApprovalsFile>(KEY, {}));
  return file && typeof file === 'object' ? file : {};
}

/** Read the inbox for a listing. An unreadable inbox lists as empty but is never written. */
async function loadForReading(): Promise<PendingApprovalsFile> {
  try {
    return await loadForChange();
  } catch (error) {
    log.error('Failed to load pending approvals:', error);
    return {};
  }
}

/** Change the inbox under the workspace's write chain and file lock. */
async function mutate(change: (file: PendingApprovalsFile) => boolean): Promise<void> {
  const workspace = getCurrentWorkspace();
  const write = bindToCurrentWorkspace(async () => {
    await withPersonaRuntimeLock(LOCK_ID, async (lock) => {
      const file = await loadForChange();
      if (!change(file)) return;
      await lock.assertOwned();
      await retryTransientFileOperation(() => saveItem(KEY, file));
    });
  });
  const run = (writeChains.get(workspace) ?? Promise.resolve())
    .catch(() => { /* prior write's error surfaced to its own caller */ })
    .then(write);
  writeChains.set(workspace, run);
  try {
    await run;
  } finally {
    if (writeChains.get(workspace) === run) writeChains.delete(workspace);
  }
}

function newReceipt(): string {
  return `apr_${randomUUID()}`;
}

/** The same batch when every call still waiting was already part of it. */
function sameBatch(
  previous: Pick<PendingApprovalEntry, 'pendingToolCalls'>,
  next: Pick<PendingApprovalEntry, 'pendingToolCalls'>,
): boolean {
  const known = new Set(previous.pendingToolCalls.map((call) => call.id));
  return next.pendingToolCalls.length > 0 && next.pendingToolCalls.every((call) => known.has(call.id));
}

/** The id a caller uses to decide this entry's batch. */
export function approvalReceiptOf(entry: PendingApprovalEntry): string {
  return entry.receipt ?? entry.approvalId;
}

export async function listPendingApprovals(): Promise<PendingApprovalEntry[]> {
  const file = await loadForReading();
  return Object.values(file).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function getPendingApproval(
  approvalId: string
): Promise<PendingApprovalEntry | null> {
  const file = await loadForReading();
  return Object.hasOwn(file, approvalId) ? file[approvalId] : null;
}

/**
 * Find the entry a caller's receipt belongs to. An entry saved before receipts
 * existed also answers to its conversation id; an entry with a receipt only to
 * that receipt, so replaying an old one can never decide a later batch.
 */
export async function findPendingApprovalByReceipt(
  receipt: string,
): Promise<PendingApprovalEntry | null> {
  const file = await loadForReading();
  for (const entry of Object.values(file)) {
    if (entry.receipt === receipt) return entry;
  }
  const legacy = Object.hasOwn(file, receipt) ? file[receipt] : undefined;
  return legacy && !legacy.receipt ? legacy : null;
}

/**
 * Save an entry. A batch that goes on (some calls decided, the rest still
 * waiting) keeps its receipt; a new batch always gets a new one. Returns the
 * entry as saved, with its receipt.
 */
export async function putPendingApproval(entry: PendingApprovalEntry): Promise<PendingApprovalEntry> {
  let saved = entry;
  await mutate((file) => {
    const existing = Object.hasOwn(file, entry.approvalId) ? file[entry.approvalId] : undefined;
    if (
      existing
      && (
        existing.conversationId !== entry.conversationId
        || existing.plannedExecutionId !== entry.plannedExecutionId
        || existing.runId !== entry.runId
      )
    ) {
      throw new Error(`Pending approval ${entry.approvalId} conflicts with another run.`);
    }
    const { receipt: _ignored, ...fields } = entry;
    const receipt = existing && sameBatch(existing, entry) ? existing.receipt : newReceipt();
    saved = receipt ? { ...fields, receipt } : fields;
    file[entry.approvalId] = saved;
    return true;
  });
  return saved;
}

export async function removePendingApproval(approvalId: string): Promise<void> {
  await mutate((file) => {
    if (!Object.hasOwn(file, approvalId)) return false;
    delete file[approvalId];
    return true;
  });
}

/** Remove resumable approval intents that explicitly target a deleted Persona. */
export async function removePendingApprovalsForPersonaId(personaId: string): Promise<number> {
  EnduringAgentIdSchema.parse(personaId);
  let removed = 0;
  await mutate((file) => {
    removed = 0;
    for (const [approvalId, entry] of Object.entries(file)) {
      if (entry.terminalPublication?.execution.personaId !== personaId) continue;
      delete file[approvalId];
      removed += 1;
    }
    return removed > 0;
  });
  return removed;
}
